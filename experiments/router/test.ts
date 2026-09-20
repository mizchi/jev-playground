/**
 * What has to hold before a labelling run or a judgment run is trusted.
 *
 *   npm test      # no API key, no `claude -p`
 *
 * The load-bearing ones: the staged task never contains the answer, the
 * composed hard tasks really are harder in the only sense that counts
 * (they parse and they fail), `cheapest_sufficient` distinguishes "no tier
 * worked" from "not every tier was tried", and the arms differ only in what
 * they are shown.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { ARMS, choiceQuestions, failingTestsOf, inputFor, taskInputs } from "./src/ask.js";
import { PROMPT, TIERS, type Attempt } from "./src/label.js";
import { cheapestOf } from "./src/report.js";
import { TIER, questionsFor, stateFor } from "../../packages/jev-model-router/src/route.js";
import { DEFAULT_CONFIG } from "../../packages/jev-model-router/src/tiers.js";

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
  if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

const HARD = resolve(import.meta.dirname, "tasks-hard");
const REPAIR = resolve(import.meta.dirname, "../repair/tasks");

// ------------------------------------------------------------- the corpus

check("the prompt names no file, no line, and no bug", () => {
  // Any hint moves every tier at once, which is exactly what would make a
  // real ladder look flat. The prompt has to stay the least the task can be
  // stated in.
  // Naming the DIRECTORY is part of stating the task; naming the file, the
  // line, or the kind of mistake would be a hint, and a hint moves every tier
  // at once -- which is what would make a real ladder look flat.
  for (const word of ["clamp", "andor", "return", "comparison", "off by", "operator", "boundary"]) {
    ok(!PROMPT.toLowerCase().includes(word.toLowerCase()), `the prompt mentions "${word}"`);
  }
  ok(PROMPT.includes("Do not modify any test file"), "the prompt lets the agent edit the tests");
});

check("no task directory ships the blurb that says what the bug is", () => {
  // `blurb.txt` exists in the repair corpus and is the answer in one line.
  // The staging step must not copy it; here the generated corpus is checked
  // directly, because a file on disk is easier to get wrong than a copy.
  if (!existsSync(HARD)) return;
  const ids = readFileSync(resolve(HARD, "index.json"), "utf8");
  ok(!ids.includes("blurb"), "the hard index references a blurb");
  const listed = (JSON.parse(ids) as { tasks: { id: string }[] }).tasks;
  for (const t of listed) {
    ok(!existsSync(resolve(HARD, t.id, "blurb.txt")), `${t.id} ships blurb.txt`);
  }
});

check("every composed hard task parses and fails", () => {
  if (!existsSync(HARD)) return;
  const listed = (JSON.parse(readFileSync(resolve(HARD, "index.json"), "utf8")) as {
    tasks: { id: string; bugs: number; lines: number[] }[];
  }).tasks;
  ok(listed.length > 10, `only ${listed.length} hard tasks`);
  // Check a sample rather than all 32: `node --test` per task is a second each
  // and this file runs on every commit.
  for (const t of [listed[0], listed[Math.floor(listed.length / 2)], listed[listed.length - 1]]) {
    const dir = resolve(HARD, t.id);
    let parsed = true;
    try {
      const src = resolve(dir, "src");
      const name = readFileSync(resolve(src, readFileSyncDir(src)[0]), "utf8");
      void name;
      execFileSync("node", ["--check", resolve(src, readFileSyncDir(src)[0])], { stdio: "ignore" });
    } catch {
      parsed = false;
    }
    ok(parsed, `${t.id} does not parse; a syntax error is not a hard bug`);
    let failed = false;
    try {
      execFileSync("node", ["--test"], { cwd: dir, stdio: "ignore", timeout: 60_000 });
    } catch {
      failed = true;
    }
    ok(failed, `${t.id} already passes; it is not a task`);
    eq(t.lines.length, t.bugs, `${t.id} claims ${t.bugs} bugs on ${t.lines.length} lines`);
    eq(new Set(t.lines).size, t.lines.length, `${t.id} plants two bugs on one line`);
  }
});

function readFileSyncDir(dir: string): string[] {
  // A tiny helper so the check above reads one source file without importing
  // readdirSync at the top and shadowing the fs import in the other checks.
  return execFileSync("ls", [dir], { encoding: "utf8" }).trim().split("\n");
}

check("the hard tasks are built from the easy ones and keep their tests", () => {
  if (!existsSync(HARD)) return;
  const listed = (JSON.parse(readFileSync(resolve(HARD, "index.json"), "utf8")) as {
    tasks: { id: string; from: string }[];
  }).tasks;
  for (const t of listed) {
    ok(existsSync(resolve(REPAIR, t.from)), `${t.id} claims to come from ${t.from}, which does not exist`);
    const theirs = readFileSyncDir(resolve(REPAIR, t.from, "test")).sort().join();
    const mine = readFileSyncDir(resolve(HARD, t.id, "test")).sort().join();
    // The tests are the label. A composed task with different tests would be
    // measuring a different thing than the task it came from.
    eq(mine, theirs, `${t.id}'s tests differ from ${t.from}'s`);
  }
});

// ------------------------------------------------------------- the label

check("cheapest_sufficient separates 'none worked' from 'not all tried'", () => {
  const row = (task: string, tier: string, passed: boolean): Attempt =>
    ({ task, corpus: "hard", tier, repeat: 0, passed, untouched: false, ms: 1 }) as Attempt;
  // Haiku passed: the label is 0 whatever the dearer tiers would do, which is
  // what makes the adaptive skip sound rather than merely thrifty.
  eq(cheapestOf([row("a", "haiku", true)], "a"), 0);
  eq(cheapestOf([row("b", "haiku", false), row("b", "sonnet", true)], "b"), 1);
  // Every tier tried and none worked: a real null, and one that must not
  // punish a cutoff (jev-core's ladder drops it from the penalty).
  const allTried = [row("c", "haiku", false), row("c", "sonnet", false), row("c", "opus", false)];
  eq(cheapestOf(allTried, "c"), null);
  // Only haiku tried and it failed: NOT null. Reporting that as "no tier
  // worked" would invent a label from an unfinished run.
  ok(cheapestOf([row("d", "haiku", false)], "d") === undefined, "an incomplete task was reported as unservable");
});

check("the tier ladder is cheapest-first and its prices ascend", () => {
  for (let i = 1; i < TIERS.length; i += 1) {
    ok(TIERS[i].price > TIERS[i - 1].price, `${TIERS[i].label} is not dearer than ${TIERS[i - 1].label}`);
  }
  // The ladder the labeller measures must be the ladder the router routes over,
  // or §3 and §4 are joining two different things.
  eq(TIERS.map((t) => t.model).join(), DEFAULT_CONFIG.tiers.map((t) => t.model).join());
});

// ------------------------------------------------------------- the arms

check("each arm is shown exactly what its name says", () => {
  const rows = taskInputs();
  ok(rows.length > 10, `only ${rows.length} tasks`);
  const row = rows.find((r) => r.task === "clamp") ?? rows[0];
  const plain = inputFor("plain", row).task;
  const failure = inputFor("failure", row).task;
  const source = inputFor("source", row).task;
  eq(plain, PROMPT, "plain sees more than the prompt");
  ok(failure.includes(row.baseline), "failure cannot see the test output");
  ok(!failure.includes(row.source), "failure sees the source");
  ok(source.includes(row.baseline) && source.includes(row.source), "source is missing one of its two parts");
  // `choice` differs from `failure` in the ANSWER SHAPE only, which is the
  // whole point of docs/36 §2.1 being a measurable disagreement.
  eq(inputFor("choice", row).task, failure, "the choice arm was given different input");
  eq(choiceQuestions()[TIER].type, "choice");
  eq(questionsFor(DEFAULT_CONFIG)[TIER].type, "score");
});

check("plain is identical across every task, on purpose", () => {
  const all = new Set(taskInputs().map((r) => inputFor("plain", r).task));
  eq(all.size, 1, "the control arm varies by task, so it is not a control");
});

check("failure and source do vary across tasks", () => {
  for (const arm of ["failure", "source"] as const) {
    const all = new Set(taskInputs().map((r) => inputFor(arm, r).task));
    ok(all.size > 10, `${arm} produced only ${all.size} distinct inputs`);
  }
});

check("no arm's payload carries the recorded fix or the bug's name", () => {
  const rows = taskInputs();
  for (const row of rows) {
    for (const arm of ARMS) {
      const body = JSON.stringify(stateFor(inputFor(arm, row), DEFAULT_CONFIG));
      // The repair corpus' blurb is the one-line answer. It is not in the
      // truth record this file reads, but assert it is absent anyway: this is
      // the check that would catch someone helpfully adding it later.
      const blurbPath = resolve(REPAIR, row.task, "blurb.txt");
      if (!existsSync(blurbPath)) continue;
      const blurb = readFileSync(blurbPath, "utf8").trim();
      ok(!body.includes(blurb), `${arm}/${row.task} leaks the blurb`);
    }
  }
});

check("the free features are recorded, so the no-judgment baselines cost nothing", () => {
  const row = taskInputs()[0];
  ok(failingTestsOf(row.baseline) >= 1, "the failing-test count came out zero on a failing task");
  eq(failingTestsOf(""), 0);
  eq(failingTestsOf("failing test: a\nfailing test: b"), 2);
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
