/**
 * What has to hold before a request is spent.
 *
 *   npm test      # no API key; runs `node --test` a handful of times
 *
 * The load-bearing ones: every task starts red, the recorded truth still
 * matches the tasks and the catalog (a stale truth would score every arm
 * against the wrong answers), and nothing that says which candidate is the
 * fix reaches a request.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ARMS, PICK, keyFor, payloadOf, questionsFor, stateFor } from "./src/arms.js";
import { candidates } from "./src/mutate.js";
import { hashOf, type TaskTruth } from "./src/record.js";
import { failureOf, loadTasks, runWith } from "./src/world.js";

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

const TASKS = loadTasks();
const TRUTHS = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "records/truth.json"), "utf8"),
) as TaskTruth[];
const TRUTH_OF = new Map(TRUTHS.map((t) => [t.task, t]));

// -------------------------------------------------------------- the truth cache

check("the recorded truth covers every task and is not stale", () => {
  eq(TRUTHS.length, TASKS.length, "the truth and the tasks disagree on how many there are");
  for (const t of TASKS) {
    const truth = TRUTH_OF.get(t.id);
    ok(truth !== undefined, `no truth for ${t.id}`);
    eq(truth!.sourceHash, hashOf(t.source), `${t.id}: the source changed since the truth was recorded`);
    eq(truth!.candidates, candidates(t.source).length, `${t.id}: the catalog changed since the truth was recorded`);
  }
});

check("the corpus has both kinds of task", () => {
  const solvable = TRUTHS.filter((t) => t.fixes.length > 0);
  const not = TRUTHS.filter((t) => t.fixes.length === 0);
  ok(solvable.length >= 12, `only ${solvable.length} solvable tasks`);
  ok(not.length >= 4, `only ${not.length} tasks with no single-edit fix`);
  // Fixes have to be rare, or the ordering is not worth measuring.
  const cands = TRUTHS.reduce((a, t) => a + t.candidates, 0);
  const fixes = TRUTHS.reduce((a, t) => a + t.fixes.length, 0);
  ok(fixes / cands < 0.2, `${fixes}/${cands} candidates are fixes, which is too easy`);
});

check("every recorded fix id is a real candidate", () => {
  for (const t of TASKS) {
    const ids = new Set(candidates(t.source).map((c) => c.id));
    for (const id of TRUTH_OF.get(t.id)!.fixes) ok(ids.has(id), `${t.id}: fix ${id} is not a candidate`);
  }
});

// ------------------------------------------------------------------- the world

check("a sample of tasks really starts red", () => {
  // Three, not all twenty-one: `node --test` costs 150 ms a go and the
  // truth cache already proves the rest (it throws when a task passes).
  for (const t of [TASKS[0], TASKS[Math.floor(TASKS.length / 2)], TASKS[TASKS.length - 1]]) {
    const r = runWith(t, null);
    eq(r.pass, false, `${t.id} passes with no edit applied`);
    ok(r.output.length > 0, `${t.id} failed with no output to show`);
  }
});

check("a recorded fix really turns its suite green", () => {
  const solvable = TASKS.filter((t) => TRUTH_OF.get(t.id)!.fixes.length > 0);
  const t = solvable[0];
  const fix = candidates(t.source).find((c) => TRUTH_OF.get(t.id)!.fixes.includes(c.id))!;
  eq(runWith(t, fix.text).pass, true, `${t.id}: the recorded fix does not pass`);
});

check("applying a candidate never writes into the repository", () => {
  const t = TASKS[0];
  const before = readFileSync(resolve(t.dir, t.path), "utf8");
  const c = candidates(t.source)[0];
  runWith(t, c.text);
  eq(readFileSync(resolve(t.dir, t.path), "utf8"), before, "the task's own file was modified");
});

check("the failure summary keeps the assertion and drops the counts", () => {
  const raw = [
    "TAP version 13",
    "not ok 1 - clamps above",
    "  ---",
    "  code: 'ERR_ASSERTION'",
    "  expected: 5",
    "  actual: 9",
    "  operator: 'strictEqual'",
    "  ...",
    "# tests 3",
    "# pass 2",
    "# duration_ms 99.9",
  ].join("\n");
  const out = failureOf(raw);
  ok(out.includes("failing test: clamps above"), "the failing test's name is gone");
  ok(out.includes("expected: 5"), "the assertion is gone");
  ok(!out.includes("duration_ms"), "the counts survived");
  ok(!out.includes("# tests"), "the counts survived");
});

// ---------------------------------------------------------------- the catalog

check("every candidate changes exactly one line, and none is a no-op", () => {
  for (const t of TASKS) {
    const lines = t.source.split("\n");
    for (const c of candidates(t.source)) {
      ok(c.after !== c.before, `${t.id}/${c.id} is a no-op`);
      const got = c.text.split("\n");
      eq(got.length, lines.length, `${t.id}/${c.id} changed the line count`);
      const differing = got.filter((l, i) => l !== lines[i]).length;
      eq(differing, 1, `${t.id}/${c.id} changed ${differing} lines`);
      eq(got[c.line - 1], c.after, `${t.id}/${c.id} reports the wrong line`);
    }
  }
});

check("candidates are deduplicated by their resulting text", () => {
  for (const t of TASKS) {
    const texts = candidates(t.source).map((c) => c.text);
    eq(new Set(texts).size, texts.length, `${t.id} has two candidates with the same result`);
  }
});

check("candidate ids and question keys are unique within a task", () => {
  for (const t of TASKS) {
    const cs = candidates(t.source);
    eq(new Set(cs.map((c) => c.id)).size, cs.length, `${t.id} has duplicate ids`);
    eq(new Set(cs.map((c) => keyFor(c))).size, cs.length, `${t.id} has colliding question keys`);
  }
});

// ------------------------------------------------------------------- the input

check("no request carries the blurb, the truth or the word fix", () => {
  for (const t of TASKS) {
    const truth = TRUTH_OF.get(t.id)!;
    const cs = candidates(t.source);
    for (const arm of ARMS) {
      const body = payloadOf(arm, t, truth.baseline, cs);
      // Phrases, not words, and only phrases the LEGITIMATE input does not
      // already contain. Two false alarms taught the shape of this check:
      // "returns" is in a test's own name, and `dedup`'s test is literally
      // called "keeps the first of each" -- a test name that says what is
      // wanted is the input, not a leak. What must not appear is a phrase
      // only the blurb has.
      const lower = body.toLowerCase();
      const legitimate = [t.source, ...t.tests.map((x) => x.text), truth.baseline].join(" ").toLowerCase();
      const words = t.blurb.toLowerCase().split(/[\s,.:]+/).filter((w) => w.length > 0);
      for (let i = 0; i + 2 < words.length; i += 1) {
        const phrase = words.slice(i, i + 3).join(" ");
        if (legitimate.includes(phrase)) continue;
        ok(!lower.includes(phrase), `${arm}/${t.id} leaks "${phrase}" from the blurb`);
      }
      for (const id of truth.fixes) ok(!body.includes(`"${id}"`), `${arm}/${t.id} leaks a fix id`);
    }
  }
});

check("the state carries the source, the tests and the failure -- and no more", () => {
  const t = TASKS[0];
  const state = JSON.stringify(stateFor(t, TRUTH_OF.get(t.id)!.baseline));
  ok(state.includes(t.path), "the file name is missing");
  ok(state.includes(t.tests[0].path), "the test file is missing");
  ok(!state.includes("fixes"), "the state names the truth");
  ok(!state.includes(t.blurb), "the state carries the blurb");
});

check("the choice arm asks one question and the others ask one per candidate", () => {
  const t = TASKS[0];
  const cs = candidates(t.source);
  eq(Object.keys(questionsFor("choice", cs)).length, 1, "the choice arm should ask once");
  const pick = questionsFor("choice", cs)[PICK] as { criteria: Record<string, unknown> };
  eq(Object.keys(pick.criteria).length, cs.length, "the choice should offer every candidate");
  eq(Object.keys(questionsFor("score", cs)).length, cs.length, "the score arm should ask per candidate");
  eq(Object.keys(questionsFor("noul", cs)).length, cs.length, "the noul arm should ask per candidate");
});

check("no task has more candidates than a choice can hold", () => {
  for (const t of TASKS) {
    const n = candidates(t.source).length;
    ok(n <= 255, `${t.id} has ${n} candidates, over the server's choice limit`);
  }
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
