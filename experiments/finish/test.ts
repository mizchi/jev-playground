/**
 * What has to hold before any of these runs is believed.
 *
 *   npm test      # no API key, no CLI
 *
 * The checks here are the ones that would let a BROKEN HARNESS look like a
 * result, and the first two are here because both went wrong on the way:
 *
 *   the agent has to be able to edit at all -- `bypassPermissions` looks valid,
 *   is accepted, and does not grant edits, so the first version of this harness
 *   measured a 0% baseline and would have published it;
 *   the agent has to be able to run commands -- without Bash in `allowedTools`
 *   the gate under test has nothing to gate, which is how docs/36's labels were
 *   made and is not what this measures.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ARMS } from "./src/run.js";
import { tasks, type Run } from "./src/world.js";

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void): void => {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}: ${(err as Error).message}`);
  }
};
const ok = (cond: boolean, what: string): void => {
  if (!cond) throw new Error(what);
};
const eq = <T,>(a: T, b: T, what = ""): void => {
  if (a !== b) throw new Error(`${what}expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

const source = readFileSync(resolve(import.meta.dirname, "src/world.ts"), "utf8");
const gateSource = readFileSync(resolve(import.meta.dirname, "src/gate.mjs"), "utf8");

check("the agent is launched in a mode that actually grants edits", () => {
  // `bypassPermissions` is accepted by the CLI and does NOT grant edits here:
  // with no hook at all the agent replied "The system is asking for permission
  // to write the file." A harness in that mode reports every run as a failure
  // and the failure looks like the model's.
  // Check the ARGV, not the file: the docblock names `bypassPermissions` in
  // order to explain why it is not used, and a naive substring test on the
  // whole source flags that explanation as the bug it warns about.
  const argv = source.slice(source.indexOf('spawn(\n      "claude"'), source.indexOf("{ cwd, env,"));
  ok(argv.length > 40, "could not find the spawn argv to check");
  ok(argv.includes('"acceptEdits"'), "the run must use --permission-mode acceptEdits");
  ok(!argv.includes("bypassPermissions"), "bypassPermissions does not grant edits in this container");
});

check("the agent is allowed to run commands, or the gate has nothing to gate", () => {
  // docs/36's labelling allowed Read/Edit/Write only, so its agent could never
  // run the tests. Fine for that purpose; fatal for this one.
  const at = source.indexOf('"--allowedTools"');
  ok(at > 0, "the run must pass --allowedTools");
  const after = source.slice(at, at + 200);
  for (const t of ["Read", "Edit", "Write", "Bash"]) {
    ok(after.includes(`"${t}"`), `--allowedTools must include ${t}`);
  }
});

check("the prompt is positioned where the CLI will read it", () => {
  // With --allowedTools trailing, a prompt placed after it is swallowed as one
  // more tool name and the CLI exits "Input must be provided...".
  const p = source.indexOf('"-p",');
  ok(p > 0, "the run must pass -p");
  ok(source.slice(p, p + 40).includes("prompt"), "the prompt must come immediately after -p");
});

check("the verdict is an exit code and nothing else", () => {
  // The moment this experiment scores the agent's work itself, what it measures
  // is my reading of that work. docs/36's labels are exit codes for the same
  // reason.
  ok(source.includes('spawnSync("node", ["--test"]'), "the verdict must be `node --test`");
  ok(source.includes("out.status === 0"), "the verdict must be the exit status");
});

check("the two arms differ in the gate and in nothing else", () => {
  eq(ARMS.bare.model, ARMS.guard.model, "the arms must share a model: ");
  eq(ARMS.bare.guard, false, "bare must not wire the gate: ");
  eq(ARMS.guard.guard, true, "guard must wire the gate: ");
});

check("the gate under test is the SHIPPED one, not a copy", () => {
  ok(source.includes("hooks/jev-permission-gate.mjs"), "the arm must consult the shipped hook");
  ok(existsSync(resolve(import.meta.dirname, "../../hooks/jev-permission-gate.mjs")), "the shipped hook must exist");
});

check("the harness fence runs in every arm, and its denials are never jev's", () => {
  // docs/38: a control arm without the safety device does dangerous things. A
  // fence in one arm and not the other is a confound, so it is in both -- and
  // then its denials must be separable or they get attributed to the gate.
  ok(gateSource.includes('by: "fence"'), "fence denials must be labelled");
  const jevGate = gateSource.indexOf('process.env.JEV_GATE !== "1"');
  const fence = gateSource.indexOf("strayPath");
  ok(fence > 0 && fence < jevGate, "the fence must run BEFORE the JEV_GATE check, i.e. in every arm");
});

check("the fence keeps the agent out of the repository", () => {
  // The repository holding the records that measure the run is reachable from
  // the sandbox. This is the check that stops a run editing its own evidence.
  ok(gateSource.includes('path.startsWith("/home/")'), "the fence must cover /home");
  ok(gateSource.includes("FINISH_SANDBOX"), "the fence must know the sandbox");
  // Matched on the behaviour, not on the regex's exact escaping -- the first
  // version of this check tested my own backslashes and failed on correct code.
  ok(gateSource.includes('return ".."'), "the fence must report .. traversal");
  ok(/\\\.\\\./.test(gateSource), "the fence must have a .. pattern");
});

check("the gate fails open, never into allow and never into deny", () => {
  // The shipped hook's own rule, kept in the wrapper: a hook that throws in
  // front of an agent stops work that judgment was only advising on.
  ok(gateSource.includes("carryOn()"), "there must be a carry-on path");
  ok(gateSource.includes("verdict = null"), "a malformed gate reply must carry on");
});

check("the task corpus is the one that already carries a mechanical verdict", () => {
  const all = tasks("both");
  ok(all.length >= 50, `expected the 53 graded tasks, found ${all.length}`);
  ok(
    all.every((t) => existsSync(resolve(t.dir, "src")) && existsSync(resolve(t.dir, "test"))),
    "every task needs src/ and test/",
  );
  // And they must be the SAME tasks docs/36 labelled, or a pass here and a
  // pass there mean different things.
  ok(all.some((t) => t.corpus === "easy"), "the easy corpus must be present");
  ok(all.some((t) => t.corpus === "hard"), "the hard corpus must be present");
});

check("the record, if present, keeps the whole ledger per run", () => {
  const path = resolve(import.meta.dirname, "records/runs.json");
  if (!existsSync(path)) return;
  const rows = (JSON.parse(readFileSync(path, "utf8")) as { rows: Run[] }).rows;
  if (rows.length === 0) return;
  for (const r of rows) {
    ok(Array.isArray(r.calls), `${r.task}/${r.arm}: calls must be an array`);
    eq(typeof r.passed, "boolean", `${r.task}/${r.arm}: `);
    // The ledger IS the corpus, so an empty one means the hook never fired and
    // the run measured nothing -- worth failing over rather than averaging in.
    ok(r.calls.length > 0 || Boolean(r.error), `${r.task}/${r.arm}/r${r.repeat}: no tool calls and no error`);
    // A gate latency without a gated call, or the reverse, means the two are
    // being summed from different places.
    const gated = r.calls.filter((c) => c.gateMs !== undefined);
    eq(
      r.gateMs,
      gated.reduce((n, c) => n + (c.gateMs ?? 0), 0),
      `${r.task}/${r.arm}: gateMs must be the sum of the gated calls: `,
    );
    if (r.arm === "bare") eq(gated.length, 0, `${r.task}: the bare arm must have no gated calls: `);
  }
});

check("a bare run is never credited with the gate's work", () => {
  const path = resolve(import.meta.dirname, "records/runs.json");
  if (!existsSync(path)) return;
  const rows = (JSON.parse(readFileSync(path, "utf8")) as { rows: Run[] }).rows;
  for (const r of rows.filter((x) => x.arm === "bare")) {
    eq(r.deniedByJev, 0, `${r.task}: the bare arm cannot have jev denials: `);
    eq(r.askedByJev, 0, `${r.task}: the bare arm cannot have jev asks: `);
    eq(r.gateMs, 0, `${r.task}: the bare arm cannot have gate latency: `);
  }
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
