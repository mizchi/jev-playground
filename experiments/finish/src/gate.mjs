#!/usr/bin/env node
/**
 * The `PreToolUse` hook this experiment puts in front of a real agent.
 *
 * It does TWO separable jobs, and keeping them separate is the whole
 * measurement:
 *
 *   1. THE LEDGER. Every tool call the agent makes is appended to a log, with
 *      its name, its input, and what this hook decided. That log is the
 *      corpus. Nothing here is a scenario I wrote: the command distribution is
 *      whatever the agent actually did to finish the task, which is the only
 *      version of it that is a function of the data rather than of my
 *      imagination (docs/31's lesson, and docs/39's).
 *
 *   2. THE SAFETY FENCE, which runs in EVERY ARM including the control.
 *      `claude -p --permission-mode bypassPermissions` will run anything, and
 *      this container holds the repository the experiment lives in -- a stray
 *      `cd` and the agent is editing the records that are measuring it. (That
 *      is not hypothetical: I destroyed `experiments/roguelike/records/play.json`
 *      by hand earlier in this programme.) So the fence denies anything naming
 *      a path outside the task sandbox.
 *
 *      IT IS IN EVERY ARM ON PURPOSE. docs/38's lesson is that a control arm
 *      without the safety device does dangerous things, and a fence present in
 *      one arm and absent in another is a confound. Its denials are recorded
 *      under `by: "fence"` so they can never be counted as jev's.
 *
 * And on top of those, optionally, THE THING UNDER TEST: `jev-guard`, via the
 * shipped `hooks/jev-permission-gate.mjs`. Set JEV_GATE=1 to wire it in.
 *
 * Environment:
 *   FINISH_LOG      where to append the ledger (required)
 *   FINISH_SANDBOX  the only directory the agent may touch (required)
 *   JEV_GATE        "1" to consult jev-guard as well
 *   JEV_GATE_BIN    path to the shipped hook (required when JEV_GATE=1)
 *
 * Fails open, always. A hook that throws in front of an agent stops work that
 * judgment was only advising on -- the shipped gate's own rule, kept here.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const log = (row) => {
  try {
    appendFileSync(process.env.FINISH_LOG, `${JSON.stringify(row)}\n`);
  } catch {
    /* the ledger is not worth failing a run over */
  }
};

/** The hook contract: no JSON on stdout means "no decision, carry on". */
const carryOn = () => process.exit(0);

const decide = (decision, reason, extra = {}) => {
  log({ at: Date.now(), ...extra, decision, reason });
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
};

let event = {};
try {
  event = JSON.parse(readFileSync(0, "utf8"));
} catch {
  carryOn();
}

const tool = event.tool_name ?? "?";
const input = event.tool_input ?? {};
const command = typeof input.command === "string" ? input.command : "";
const base = { at: Date.now(), tool, command: command.slice(0, 400) };

// ---------------------------------------------------------------- the fence

const sandbox = process.env.FINISH_SANDBOX ? resolve(process.env.FINISH_SANDBOX) : null;

/**
 * Paths the command names that are outside the sandbox.
 *
 * Deliberately crude and deliberately strict: this is a safety device, not a
 * measurement, so a false positive costs a turn and a false negative costs the
 * experiment. It looks at absolute paths and at `..` traversal, and it does not
 * try to parse the shell -- a fence that needs a shell parser to be correct is
 * a fence that is wrong on the day it matters.
 */
function outsideSandbox(text) {
  if (!sandbox || !text) return null;
  for (const m of text.matchAll(/(?:^|[\s"'=(:])(\/[^\s"';:)|&]*)/g)) {
    const path = m[1];
    // /tmp, /usr, /opt and friends are read-only traffic in practice; what
    // matters is the repository and the home directory.
    if (path.startsWith("/home/") || path.startsWith("/root/")) {
      if (!resolve(path).startsWith(sandbox)) return path;
    }
  }
  if (/(^|[\s"'=(])\.\.\//.test(text)) return "..";
  return null;
}

const strayPath = outsideSandbox(command) ?? outsideSandbox(String(input.file_path ?? "")) ?? null;
if (strayPath) {
  decide(
    "deny",
    `The harness fence blocked this: it names ${strayPath}, which is outside the task sandbox. ` +
      "Work only inside the current directory.",
    { ...base, by: "fence" },
  );
}

// ------------------------------------------------------ the thing under test

if (process.env.JEV_GATE !== "1" || !command) {
  log({ ...base, by: "none", decision: "carry-on" });
  carryOn();
}

const bin = process.env.JEV_GATE_BIN;
if (!bin) {
  log({ ...base, by: "none", decision: "carry-on", reason: "JEV_GATE=1 but no JEV_GATE_BIN" });
  carryOn();
}

/**
 * Consult the SHIPPED gate, as a subprocess, on the real event.
 *
 * A subprocess rather than an import because that is how it is documented to
 * be wired (`node ${CLAUDE_PROJECT_DIR}/hooks/jev-permission-gate.mjs`), and
 * measuring the thing that ships is the point. Its latency therefore includes
 * a node start-up, which is honest: that is what a user wiring it up pays.
 */
const started = Date.now();
const out = spawnSync(process.execPath, [bin], {
  input: JSON.stringify(event),
  encoding: "utf8",
  timeout: 20_000,
  env: process.env,
});
const ms = Date.now() - started;

let verdict = null;
try {
  const text = (out.stdout ?? "").trim();
  if (text) verdict = JSON.parse(text)?.hookSpecificOutput ?? null;
} catch {
  verdict = null;
}

if (!verdict?.permissionDecision) {
  // The gate said nothing: its free prefilter passed the command, or it failed
  // open. Both are "carry on", and the ledger keeps the latency either way --
  // a gate that costs 900 ms to say nothing still costs 900 ms.
  log({ ...base, by: "jev", decision: "carry-on", gateMs: ms, gateSaidNothing: true });
  carryOn();
}

decide(verdict.permissionDecision, verdict.permissionDecisionReason ?? "jev-guard", {
  ...base,
  by: "jev",
  gateMs: ms,
});
