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
 *   JEV_GATE_FLAGS  comma-separated flags for the shipped hook, e.g. quiet-ask
 *   JEV_GATE_LOG    where the shipped hook should append its own audit log
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
// `path` as well as `command`, because without it an Edit is anonymous in the
// ledger: `testsIntact` can say a run touched a test file and nothing could say
// WHICH call did it. The path is relative to the sandbox so the ledger does not
// carry a different temp directory in every row.
const filePath = typeof input.file_path === "string" ? input.file_path : "";
// `cwd` AS WELL, and this closes TODO §3.2. docs/43 §4.4's measurement bug was
// fixed by recovering `/tmp/jev-finish-<task>-<id>/` out of the command text
// with a regex -- which works and depends on the sandbox naming convention, so
// it breaks silently the day that changes. The hook is HANDED the directory in
// the event, so the ledger records it and nothing downstream has to guess.
const eventCwd = typeof event.cwd === "string" ? event.cwd : (process.env.FINISH_SANDBOX ?? "");
const base = {
  at: Date.now(),
  tool,
  command: command.slice(0, 400),
  cwd: eventCwd,
  ...(filePath ? { path: filePath.replace(process.env.FINISH_SANDBOX ?? "", "").replace(/^\//, "") } : {}),
};

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

// ------------------------------------------- the orchestration gate, on Task
//
// A DIFFERENT COMPONENT ON THE SAME SEAM, and it has to be read carefully.
//
// `jev-orchestrator` was designed to be asked at the TOP of a turn, about the
// user's request, before any work starts: "does this warrant more than one
// agent". The only seam Claude Code gives it is `PreToolUse` with a matcher on
// `Task`, which fires LATER and about a DIFFERENT text -- the description the
// parent agent wrote for the subagent it is about to spawn. So what is
// measured here is the gate as a VETO on fan-out, asked about the work being
// delegated, and that is a weaker deployment than the one the component was
// written for. Stated here rather than in the report's fine print, because a
// reader of these numbers has to know which question was asked.
//
// `split: false` means "this does not need its own agent", and the veto denies
// the spawn. Every decision is logged whether or not it denied, because a gate
// that allows every spawn and a gate that is never consulted produce the same
// completion rate and opposite readings.
if (process.env.JEV_ORCHESTRATE === "1" && tool === "Task" && process.env.JEV_ORCHESTRATE_BIN) {
  const request = [input.description, input.prompt].filter((s) => typeof s === "string" && s).join("\n\n");
  const t0 = Date.now();
  const res = spawnSync(process.env.JEV_ORCHESTRATE_TSX ?? "tsx", [process.env.JEV_ORCHESTRATE_BIN, request], {
    encoding: "utf8",
    timeout: 40_000,
    env: process.env,
  });
  const orchMs = Date.now() - t0;
  let plan = null;
  try {
    plan = JSON.parse((res.stdout ?? "").trim());
  } catch {
    plan = null;
  }
  if (!plan) {
    // Fail open: the driver died, so the spawn proceeds unjudged. Logged with
    // the failure so the row cannot be read as "the gate allowed it".
    log({ ...base, by: "orchestrator", decision: "carry-on", gateMs: orchMs, gateSaidNothing: true, request });
    carryOn();
  }
  const planRow = {
    shape: plan.shape ?? "?",
    workers: plan.workers ?? 0,
    split: Boolean(plan.split),
    gate: typeof plan.gate === "number" ? plan.gate : Number.NaN,
  };
  if (!planRow.split) {
    decide(
      "deny",
      `The orchestration gate judged this work not to need its own agent (${plan.reason ?? "no reason given"}). ` +
        "Do it yourself in this session rather than delegating it.",
      { ...base, by: "orchestrator", gateMs: orchMs, plan: planRow, request },
    );
  }
  log({ ...base, by: "orchestrator", decision: "carry-on", gateMs: orchMs, plan: planRow, request });
  carryOn();
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
// Flags the arm wants the shipped hook to run with. `--quiet-ask` restores
// the pre-docs/43 behaviour so the before/after stays replayable.
const extra = (process.env.JEV_GATE_FLAGS ?? "")
  .split(",")
  .filter(Boolean)
  // A flag's VALUE must not get a `--`: `["unattended-ask","defer"]` has to
  // reach the hook as `--unattended-ask defer`, not `--unattended-ask --defer`.
  // The rule is positional: the first token of each flag/value pair is the
  // flag, and a token following a known value-taking flag is its value.
  .map((f, i, all) => {
    const VALUE_TAKING = new Set(["unattended-ask", "policy", "deny-max", "timeout", "log"]);
    const prev = i > 0 ? all[i - 1].replace(/^--/, "") : "";
    if (VALUE_TAKING.has(prev)) return f;
    return f.startsWith("--") ? f : `--${f}`;
  });
/**
 * `--log` as well, always, and this was missing from the first sweep.
 *
 * The shipped hook writes one JSON line per decision BEFORE it decides what to
 * emit, so the log carries the VERDICT even when the hook then defers. Without
 * it, a deferred `ask` and an `allow` are indistinguishable in this ledger --
 * and the `--unattended-ask defer` arm is entirely about how many asks it
 * deferred. It finished 15 of 15 boundary runs, and with no verdicts recorded
 * that number could not be read: 15/15 having deferred nothing means the arm
 * was never tested.
 */
const gateLog = process.env.JEV_GATE_LOG;
const out = spawnSync(process.execPath, [bin, ...extra, ...(gateLog ? ["--log", gateLog] : [])], {
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

// PASS THE GATE'S REASON THROUGH UNCHANGED, INCLUDING ITS ABSENCE.
//
// This used to be `?? "jev-guard"`, which quietly defeated the whole
// `--quiet-ask` arm: that arm exists to reproduce a gate whose rationale does
// NOT reach the model, and a wrapper that substitutes a placeholder reason
// hands the model a reason anyway. The arms would have differed in the text of
// the reason rather than in whether there was one.
const out2 = {
  hookEventName: "PreToolUse",
  permissionDecision: verdict.permissionDecision,
  ...(typeof verdict.permissionDecisionReason === "string" && verdict.permissionDecisionReason.length > 0
    ? { permissionDecisionReason: verdict.permissionDecisionReason }
    : {}),
  ...(typeof verdict.systemMessage === "string" ? { systemMessage: verdict.systemMessage } : {}),
};
log({
  ...base,
  by: "jev",
  gateMs: ms,
  decision: verdict.permissionDecision,
  reason: verdict.permissionDecisionReason ?? "",
  reasonReachedAgent: Boolean(out2.permissionDecisionReason),
});
console.log(JSON.stringify({ hookSpecificOutput: out2 }));
process.exit(0);
