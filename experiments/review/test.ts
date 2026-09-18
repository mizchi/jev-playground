/**
 * What has to hold before a request is spent.
 *
 *   npm test      # no API key; runs `node --test` a couple of times
 *
 * The load-bearing ones: every green base really is green, the recorded
 * truth still matches the bases and the catalog, each arm is shown exactly
 * what its name says and no more, and the label never travels.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { candidates } from "../repair/src/mutate.js";
import { runWith } from "../repair/src/world.js";
import { ARMS, REACHED, RISK, SAFE, keyFor, payloadOf, questionsFor, stateFor, type Asked } from "./src/arms.js";
import { alphaNormalise, normalise, parse, stripTypes } from "./src/dupes.js";
import { enclosingFunctionLines, metricsBlock, parseLcov } from "./src/metrics.js";
import { diffOf, loadGreenTasks, subjectsOf } from "./src/subjects.js";
import type { ReviewTruth } from "./src/truth.js";

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

const TASKS = loadGreenTasks();
const TRUTH = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "records/truth.json"), "utf8"),
) as ReviewTruth;

// ------------------------------------------------------------------ the corpus

check("the recorded truth still matches the green bases", () => {
  eq(TRUTH.tasks.length, TASKS.length, "the truth and the tasks disagree on how many there are");
  for (const task of TASKS) {
    const row = TRUTH.tasks.find((t) => t.id === task.id);
    ok(row !== undefined, `no truth for ${task.id}`);
    eq(row!.green, task.green, `${task.id}: the green base changed since the truth was recorded`);
    const n = TRUTH.subjects.filter((s) => s.task === task.id).length;
    eq(n, subjectsOf(task).length, `${task.id}: the candidate set changed`);
  }
});

check("a sample of green bases really is green", () => {
  for (const task of [TASKS[0], TASKS[TASKS.length - 1]]) {
    eq(runWith(task, task.green).pass, true, `${task.id}'s green base does not pass`);
  }
});

check("the corpus is unbalanced, and by a known amount", () => {
  const safe = TRUTH.subjects.filter((s) => s.safe).length;
  ok(safe > 20, `only ${safe} safe diffs`);
  ok(safe / TRUTH.subjects.length < 0.35, `${safe}/${TRUTH.subjects.length} safe is too balanced to be a review`);
  ok(TRUTH.subjects.length > 200, `only ${TRUTH.subjects.length} diffs`);
});

check("every subject carries a one-line diff", () => {
  for (const task of TASKS) {
    for (const s of subjectsOf(task)) {
      const d = diffOf(s);
      eq(d.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length, 1, `${s.id}`);
      eq(d.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length, 1, `${s.id}`);
    }
  }
});

// ----------------------------------------------------------------- the metrics

check("the LCOV parser reads the right file's line hits", () => {
  const raw = [
    "SF:src/other.js",
    "DA:1,99",
    "SF:src/clamp.js",
    "DA:1,1",
    "DA:2,7",
    "BRF:4",
    "BRH:3",
    "SF:test/clamp.test.js",
    "DA:1,5",
  ].join("\n");
  const cov = parseLcov(raw, "src/clamp.js");
  eq(cov.hits.get(2), 7);
  eq(cov.hits.get(1), 1, "the other file's line 1 leaked in");
  eq(cov.branchesFound, 4);
  eq(cov.branchesHit, 3);
});

check("the enclosing function's length is measured, not guessed", () => {
  const text = ["export function a(v) {", "  return v;", "}", "", "function b() {", "  return 1;", "}"].join("\n");
  eq(enclosingFunctionLines(text, 2), 3, "a() is three lines");
  eq(enclosingFunctionLines(text, 6), 3, "b() is three lines");
});

check("the metric block names every metric and hides none", () => {
  const block = metricsBlock(TRUTH.subjects[0].metrics);
  const keys = Object.keys(block);
  ok(keys.length >= 7, `the block has only ${keys.length} entries`);
  for (const k of keys) ok(!/^m\d|^x\d/.test(k), `${k} is not a readable name`);
  ok(JSON.stringify(block).includes("times_the_tests_execute_this_line"), "the coverage count is missing");
});

// -------------------------------------------------------------------- the arms

check("each arm is shown exactly what its name says", () => {
  const task = TASKS[0];
  const asked: Asked[] = subjectsOf(task).slice(0, 2).map((s) => ({
    id: s.id,
    line: s.candidate.line,
    before: s.candidate.before,
    after: s.candidate.after,
    metrics: TRUTH.subjects.find((x) => x.id === s.id)!.metrics,
  }));
  const has = (arm: (typeof ARMS)[number], what: string) => payloadOf(arm, task, asked).includes(what);
  // The source and the tests live in the state for two arms only.
  eq(JSON.stringify(stateFor("blind", task)).includes("source_before"), false, "blind sees the source");
  eq(JSON.stringify(stateFor("onlymetrics", task)).includes("source_before"), false, "onlymetrics sees the source");
  eq(JSON.stringify(stateFor("diff", task)).includes("source_before"), true, "diff cannot see the source");
  eq(JSON.stringify(stateFor("metrics", task)).includes("source_before"), true, "metrics cannot see the source");
  // The metric block lives in the questions for two arms only.
  eq(has("blind", "times_the_tests_execute_this_line"), false, "blind sees the metrics");
  eq(has("diff", "times_the_tests_execute_this_line"), false, "diff sees the metrics");
  eq(has("metrics", "times_the_tests_execute_this_line"), true, "metrics cannot see the metrics");
  eq(has("onlymetrics", "times_the_tests_execute_this_line"), true, "onlymetrics cannot see the metrics");
});

check("every arm asks the same three questions of every diff", () => {
  const asked: Asked[] = TRUTH.subjects.slice(0, 3).map((s) => ({
    id: s.id,
    line: s.line,
    before: s.before,
    after: s.after,
    metrics: s.metrics,
  }));
  for (const arm of ARMS) {
    const qs = questionsFor(arm, asked);
    eq(Object.keys(qs).length, asked.length * 3, arm);
    for (const a of asked) {
      eq(qs[keyFor(SAFE, a.id)].type, "noul", `${arm}/${a.id}`);
      eq(qs[keyFor(RISK, a.id)].type, "score", `${arm}/${a.id}`);
      eq(qs[keyFor(REACHED, a.id)].type, "noul", `${arm}/${a.id}`);
    }
  }
});

check("no payload carries the label", () => {
  const task = TASKS[0];
  const asked: Asked[] = TRUTH.subjects
    .filter((s) => s.task === task.id)
    .map((s) => ({ id: s.id, line: s.line, before: s.before, after: s.after, metrics: s.metrics }));
  for (const arm of ARMS) {
    const body = payloadOf(arm, task, asked);
    ok(!/"safe"\s*:\s*(true|false)/.test(body), `${arm} leaks the label`);
    ok(!body.includes('"still_passes"'), `${arm} leaks the label`);
    // The question keys begin with the kind, which is unavoidable; what must
    // not appear is a key paired with the answer.
    for (const s of TRUTH.subjects.filter((x) => x.task === task.id)) {
      ok(!body.includes(`${s.id}":${s.safe}`), `${arm} leaks ${s.id}'s label`);
    }
  }
});

// -------------------------------------------------------------- the duplicates

check("the similarity output parser reads a pair", () => {
  const out = [
    "Similarity: 100.00%, Score: 50.5 points (lines 40~61, avg: 50.5)",
    "  experiments/a/x.ts:1-3 f",
    "  experiments/b/y.ts:1-3 g",
    "",
  ].join("\n");
  const pairs = parse(out);
  eq(pairs.length, 1);
  eq(pairs[0].similarity, 1);
  eq(pairs[0].a, "experiments/a/x.ts:1-3");
  eq(pairs[0].lines, 40);
});

check("the equivalence checks separate a rename from a different body", () => {
  const a = "export function auc(pairs: Pair[]): number {\n  return pairs.length;\n}";
  const b = "export function auc(items) {\n  return items.length;\n}";
  const c = "export function auc(items) {\n  return items.size;\n}";
  ok(normalise(a) !== normalise(b), "whitespace normalisation should not equate these");
  eq(alphaNormalise(a), alphaNormalise(b), "a rename plus type annotations should normalise away");
  ok(alphaNormalise(a) !== alphaNormalise(c), "a different property should NOT normalise away");
  ok(!stripTypes(a).includes(": Pair[]"), "the annotation survived");
});

check("the recorded duplicates are internally consistent", () => {
  const path = resolve(import.meta.dirname, "records/duplicates.json");
  const dupes = JSON.parse(readFileSync(path, "utf8")) as {
    pairs: { similarity: number; identical: boolean; alphaEquivalent: boolean }[];
  };
  ok(dupes.pairs.length > 10, `only ${dupes.pairs.length} pairs`);
  for (const p of dupes.pairs) {
    ok(p.similarity >= 0.85, `a pair below the threshold survived: ${p.similarity}`);
    if (p.identical) ok(p.alphaEquivalent, "identical implies the same up to renaming");
  }
});

// ---------------------------------------------------- the catalog, still there

check("the candidate generator is the one docs/32 recorded", () => {
  // The corpus is derived from `repair`'s catalog, so a change there changes
  // this corpus silently. The truth check above catches it; this names it.
  for (const task of TASKS) {
    eq(candidates(task.green).length, TRUTH.subjects.filter((s) => s.task === task.id).length, task.id);
  }
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
