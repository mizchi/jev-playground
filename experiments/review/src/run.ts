/**
 * docs/33 -- does a review get better when the metrics are handed to it?
 *
 *   npx tsx src/run.ts --replay                    # every table, no API key
 *   npx tsx src/run.ts --arm blind,diff,metrics,onlymetrics --repeat 2
 *   npx tsx src/run.ts --dup                       # similarity-ts on this repo
 *
 * 261 one-line diffs against green modules, labelled by `node --test`'s exit
 * code: 46 keep the suite green and 215 break it. The mechanical metrics
 * (coverage of the changed line, what the edit did, nesting, test-name
 * overlap, `similarity-ts`) are computed in `metrics.ts` and recorded, so an
 * arm either sees them or does not.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Jev, noul, score } from "../../shared/jev.js";
import {
  addConfusion,
  confusion,
  groupFolds,
  logisticFit,
  logisticP,
  mean,
  sd,
  separation,
  type Confusion,
  type Sample,
} from "../../shared/thresholds.js";
import { ARMS, ARM_BLURB, REACHED, RISK, SAFE, keyFor, questionsFor, stateFor, type ArmName, type Asked } from "./arms.js";
import type { ReviewTruth, SubjectTruth } from "./truth.js";
import { loadGreenTasks } from "./subjects.js";

const HERE = import.meta.dirname;
const RECORD = resolve(HERE, "../records/review.json");
const TRUTH = resolve(HERE, "../records/truth.json");
const DUPES = resolve(HERE, "../records/duplicates.json");

const ARGS = process.argv.slice(2);
const flag = (n: string) => ARGS.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = ARGS.indexOf(`--${n}`);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d;
};
const CONCURRENCY = Number(opt("concurrency", "4"));
/** Where a noul becomes a yes. A level boundary, not a fitted number. */
const AT = 0.5;

interface Row {
  subject: string;
  task: string;
  arm: ArmName;
  repeat: number;
  safe: number;
  risk: number;
  reached: number;
  requestId: string;
  requestMs: number;
  requestInputTokens: number;
  batchSize: number;
}

const pad = (s: string, n: number) => s.padEnd(n);
const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "  - ");
const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : "  - ");
const rule = (n = 104) => console.log("-".repeat(n));

const TRUTHS = JSON.parse(readFileSync(TRUTH, "utf8")) as ReviewTruth;
const SUBJECTS = TRUTHS.subjects;
const TASKS = loadGreenTasks();
const TASK_IDS = [...new Set(SUBJECTS.map((s) => s.task))];

const readRecord = (): Row[] => (existsSync(RECORD) ? (JSON.parse(readFileSync(RECORD, "utf8")) as Row[]) : []);

const askedOf = (task: string): Asked[] =>
  SUBJECTS.filter((s) => s.task === task).map((s) => ({
    id: s.id,
    line: s.line,
    before: s.before,
    after: s.after,
    metrics: s.metrics,
  }));

/** Mean over repeats, per (arm, subject). */
function averaged(rows: Row[], arm: ArmName): Map<string, { safe: number; risk: number; reached: number }> {
  const out = new Map<string, { safe: number; risk: number; reached: number }>();
  for (const s of SUBJECTS) {
    const mine = rows.filter((r) => r.arm === arm && r.subject === s.id);
    if (mine.length === 0) continue;
    out.set(s.id, {
      safe: mean(mine.map((r) => r.safe)),
      risk: mean(mine.map((r) => r.risk)),
      reached: mean(mine.map((r) => r.reached)),
    });
  }
  return out;
}

// -------------------------------------------------------------------- sections

function sectionCorpus(): void {
  console.log("\n  0. THE DIFFS\n");
  const safe = SUBJECTS.filter((s) => s.safe).length;
  console.log(`  ${pad("task", 16)} ${pad("diffs", 6)} ${pad("safe", 5)} ${pad("branches", 9)} ${pad("dup pairs", 10)} lines the tests never run`);
  for (const id of TASK_IDS) {
    const mine = SUBJECTS.filter((s) => s.task === id);
    const dead = new Set(mine.filter((s) => s.metrics.lineHits === 0).map((s) => s.line)).size;
    console.log(
      `  ${pad(id, 16)} ${pad(String(mine.length), 6)} ${pad(String(mine.filter((s) => s.safe).length), 5)} ` +
        `${pad(pct(mine[0].metrics.fileBranchCoverage), 9)} ` +
        `${pad(String(mine[0].metrics.duplicatePairs ?? "n/a"), 10)} ${dead}`,
    );
  }
  console.log("");
  console.log(`  ${SUBJECTS.length} diffs over ${TASK_IDS.length} green modules, ${safe} of them keep the suite green (${pct(safe / SUBJECTS.length)})`);
  console.log("  Every label is `node --test`'s exit code. The green bases are docs/32's tasks with a");
  console.log("  recorded fix applied, so the whole corpus is derived and none of it is hand-written.");
  console.log("");
  const byRule = new Map<string, { n: number; safe: number }>();
  for (const s of SUBJECTS) {
    const e = byRule.get(s.metrics.rule) ?? { n: 0, safe: 0 };
    e.n += 1;
    if (s.safe) e.safe += 1;
    byRule.set(s.metrics.rule, e);
  }
  console.log(`  by what the edit did (the mechanical classification of the diff):`);
  for (const [r, e] of [...byRule].sort((a, b) => b[1].n - a[1].n).slice(0, 10)) {
    console.log(`     ${pad(r, 22)} ${pad(String(e.n), 4)} diffs, ${pct(e.safe / e.n)} safe`);
  }
}

/** The no-judgment control: a logistic fit over the metrics, held out by task. */
function sectionControl(): void {
  console.log("\n  1. THE NO-JUDGMENT CONTROL: a logistic fit over the metrics\n");
  const features: { name: string; of: (s: SubjectTruth) => number }[] = [
    { name: "lineHits", of: (s) => Math.min(s.metrics.lineHits, 10) },
    { name: "testOverlap", of: (s) => s.metrics.testOverlap },
    { name: "depth", of: (s) => s.metrics.depth },
    { name: "fnLines", of: (s) => s.metrics.fnLines },
    { name: "branchCov", of: (s) => s.metrics.fileBranchCoverage },
  ];
  console.log(`  ${pad("feature", 13)} ${pad("safe mean", 11)} ${pad("unsafe mean", 12)} ${pad("gap", 7)} AUC`);
  for (const f of features) {
    const samples: Sample[] = SUBJECTS.map((s) => ({ value: f.of(s), positive: s.safe, group: s.task }));
    const sep = separation(samples);
    const yes = samples.filter((x) => x.positive).map((x) => x.value);
    const no = samples.filter((x) => !x.positive).map((x) => x.value);
    console.log(
      `  ${pad(f.name, 13)} ${pad(`${num(mean(yes))} ±${num(sd(yes))}`, 11)} ` +
        `${pad(`${num(mean(no))} ±${num(sd(no))}`, 12)} ${pad(num(sep.gap), 7)} ${num(sep.auc, 3)}`,
    );
  }
  console.log("");
  const folds = groupFolds(
    SUBJECTS.map((s) => ({ value: 0, positive: s.safe, group: s.task })),
    5,
  );
  let held: Confusion | null = null;
  const aucs: number[] = [];
  for (const fold of folds) {
    const inFold = new Set(fold);
    const train = SUBJECTS.filter((s) => !inFold.has(s.task));
    const test = SUBJECTS.filter((s) => inFold.has(s.task));
    if (test.length === 0 || train.filter((s) => s.safe).length === 0) continue;
    // One feature at a time is what `logisticFit` takes, so the control is
    // the single strongest metric fitted on the other folds -- an honest
    // one-dimensional baseline rather than a hand-rolled multivariate fit.
    const model = logisticFit(train.map((s) => ({ x: Math.min(s.metrics.lineHits, 10), y: s.safe })));
    if (!model.fitted) continue;
    const scored = test.map((s) => ({
      value: logisticP(model, Math.min(s.metrics.lineHits, 10)),
      positive: s.safe,
    }));
    aucs.push(separation(scored).auc);
    held = held === null ? confusion(scored, 0.5) : addConfusion(held, confusion(scored, 0.5));
  }
  if (held) {
    console.log(
      `  lineHits, fitted on four folds and scored on the fifth: tp ${held.tp} fp ${held.fp} fn ${held.fn} tn ${held.tn}, ` +
        `P ${pct(held.precision)} R ${pct(held.recall)}, AUC ${num(mean(aucs), 3)}`,
    );
  }
  console.log("");
  console.log("  Every numeric metric sits on 0.5. The coverage count was supposed to be the strong one --");
  console.log("  an edit to a line the tests never run cannot break them -- but these modules are small");
  console.log(`  and only ${new Set(SUBJECTS.filter((s) => s.metrics.lineHits === 0).map((s) => `${s.task}:${s.line}`)).size} line(s) in the whole corpus are uncovered, so it has nothing to separate.`);
  console.log("");

  // The metric that does carry something is not a number: it is the
  // classification of the diff. Held out by task, the same way.
  console.log("  The rule class, as a classifier: predict safe when the training folds' rate exceeds 0.5.\n");
  let ruleHeld: Confusion | null = null;
  const rates: number[] = [];
  for (const fold of folds) {
    const inFold = new Set(fold);
    const train = SUBJECTS.filter((s) => !inFold.has(s.task));
    const test = SUBJECTS.filter((s) => inFold.has(s.task));
    if (test.length === 0) continue;
    const rate = new Map<string, { n: number; safe: number }>();
    for (const s of train) {
      const e = rate.get(s.metrics.rule) ?? { n: 0, safe: 0 };
      e.n += 1;
      if (s.safe) e.safe += 1;
      rate.set(s.metrics.rule, e);
    }
    const scored = test.map((s) => {
      const e = rate.get(s.metrics.rule);
      // A rule the training folds never saw falls back to the base rate,
      // which is 18% -- so "unsafe", which is the honest default.
      return { value: e && e.n > 0 ? e.safe / e.n : 0, positive: s.safe };
    });
    rates.push(separation(scored).auc);
    ruleHeld = ruleHeld === null ? confusion(scored, 0.5) : addConfusion(ruleHeld, confusion(scored, 0.5));
  }
  if (ruleHeld) {
    console.log(
      `  rule class, held out by task: tp ${ruleHeld.tp} fp ${ruleHeld.fp} fn ${ruleHeld.fn} tn ${ruleHeld.tn}, ` +
        `right ${pct((ruleHeld.tp + ruleHeld.tn) / ruleHeld.n)}, P ${pct(ruleHeld.precision)} R ${pct(ruleHeld.recall)}, ` +
        `AUC ${num(mean(rates), 3)}`,
    );
  }
  console.log("");
  console.log("  So the metric worth handing over is not a measurement of the code -- it is a NAME for");
  console.log("  what the diff did. §2 asks whether handing it over changes what the judgment says.");
}

interface ArmScore {
  arm: string;
  kind: string;
  right: number;
  n: number;
  falseSafe: number;
  falseUnsafe: number;
  auc: number;
}

function scoreArm(rows: Row[], arm: ArmName, kind: "safe" | "risk"): ArmScore {
  const avg = averaged(rows, arm);
  let right = 0;
  let falseSafe = 0;
  let falseUnsafe = 0;
  const samples: Sample[] = [];
  for (const s of SUBJECTS) {
    const a = avg.get(s.id);
    if (a === undefined) continue;
    // `risk` is ordered the other way: a high risk means "it breaks".
    const value = kind === "safe" ? a.safe : 3 - a.risk;
    const said = kind === "safe" ? a.safe >= AT : a.risk < 1.5;
    samples.push({ value, positive: s.safe, group: s.task });
    if (said === s.safe) right += 1;
    else if (said) falseSafe += 1;
    else falseUnsafe += 1;
  }
  return {
    arm,
    kind,
    right,
    n: samples.length,
    falseSafe,
    falseUnsafe,
    auc: samples.length > 0 ? separation(samples).auc : Number.NaN,
  };
}

function sectionArms(rows: Row[]): void {
  console.log("\n  2. WHAT EACH REVIEW SEES\n");
  console.log(
    `  ${pad("arm", 12)} ${pad("question", 6)} ${pad("right", 9)} ${pad("", 5)} ${pad("said safe", 10)} ` +
      `${pad("said broken", 12)} ${pad("AUC", 6)} ${pad("tok/task", 9)} ms`,
  );
  for (const arm of ARMS) {
    const mine = rows.filter((r) => r.arm === arm);
    if (mine.length === 0) continue;
    const reqs = [...new Map(mine.map((r) => [r.requestId, r])).values()];
    const repeats = Math.max(1, new Set(mine.map((r) => r.repeat)).size);
    const tokens = reqs.reduce((a, r) => a + r.requestInputTokens, 0) / repeats / TASK_IDS.length;
    for (const kind of ["safe", "risk"] as const) {
      const s = scoreArm(rows, arm, kind);
      console.log(
        `  ${pad(kind === "safe" ? arm : "", 12)} ${pad(kind, 6)} ${pad(`${s.right}/${s.n}`, 9)} ` +
          `${pad(pct(s.right / s.n), 5)} ${pad(String(s.falseSafe), 10)} ${pad(String(s.falseUnsafe), 12)} ` +
          `${pad(num(s.auc, 3), 6)} ${pad(kind === "safe" ? num(tokens, 0) : "", 9)} ` +
          `${kind === "safe" ? num(mean(reqs.map((r) => r.requestMs)), 0) : ""}`,
      );
    }
  }
  console.log("");
  for (const arm of ARMS) console.log(`    ${pad(arm, 12)} ${ARM_BLURB[arm]}`);
  console.log("");
  console.log(`  ${SUBJECTS.filter((s) => s.safe).length}/${SUBJECTS.length} diffs are safe, so answering "broken" to everything scores`);
  console.log(`  ${pct(1 - SUBJECTS.filter((s) => s.safe).length / SUBJECTS.length)}. That is the number to beat, not 50%.`);
}

function sectionReached(rows: Row[]): void {
  console.log("\n  3. A QUESTION WITH A MECHANICAL ANSWER\n");
  console.log("  `reached` asks whether the tests execute the changed line. The coverage run already");
  console.log("  knows, and the `metrics` arms are handed the count -- so this says what reading a");
  console.log("  number costs against working it out.\n");
  console.log(`  ${pad("arm", 12)} ${pad("right", 10)} ${pad("", 5)} ${pad("dead lines found", 17)} AUC`);
  const deadSubjects = SUBJECTS.filter((s) => s.metrics.lineHits === 0);
  for (const arm of ARMS) {
    const avg = averaged(rows, arm);
    if (avg.size === 0) continue;
    let right = 0;
    let n = 0;
    let deadFound = 0;
    const samples: Sample[] = [];
    for (const s of SUBJECTS) {
      const a = avg.get(s.id);
      if (a === undefined) continue;
      const truth = s.metrics.lineHits > 0;
      n += 1;
      if (a.reached >= AT === truth) right += 1;
      if (!truth && a.reached < AT) deadFound += 1;
      samples.push({ value: a.reached, positive: truth, group: s.task });
    }
    console.log(
      `  ${pad(arm, 12)} ${pad(`${right}/${n}`, 10)} ${pad(pct(right / n), 5)} ` +
        `${pad(`${deadFound}/${deadSubjects.length}`, 17)} ${num(separation(samples).auc, 3)}`,
    );
  }
  console.log("");
  console.log(`  ${deadSubjects.length} of the ${SUBJECTS.length} diffs touch a line the tests never execute.`);
}

function sectionByRule(rows: Row[]): void {
  const arm = (opt("read-arm", "metrics") as ArmName);
  const avg = averaged(rows, arm);
  if (avg.size === 0) return;
  console.log(`\n  4. WHERE THE REVIEW IS WRONG (arm: ${arm})\n`);
  const byRule = new Map<string, { n: number; wrong: number; falseSafe: number }>();
  for (const s of SUBJECTS) {
    const a = avg.get(s.id);
    if (a === undefined) continue;
    const e = byRule.get(s.metrics.rule) ?? { n: 0, wrong: 0, falseSafe: 0 };
    e.n += 1;
    const said = a.safe >= AT;
    if (said !== s.safe) {
      e.wrong += 1;
      if (said) e.falseSafe += 1;
    }
    byRule.set(s.metrics.rule, e);
  }
  console.log(`  ${pad("what the edit did", 22)} ${pad("diffs", 6)} ${pad("wrong", 6)} ${pad("", 5)} of which called safe`);
  for (const [r, e] of [...byRule].sort((a, b) => b[1].wrong - a[1].wrong)) {
    if (e.wrong === 0) continue;
    console.log(`  ${pad(r, 22)} ${pad(String(e.n), 6)} ${pad(String(e.wrong), 6)} ${pad(pct(e.wrong / e.n), 5)} ${e.falseSafe}`);
  }
  console.log("");
  const dead = SUBJECTS.filter((s) => s.metrics.lineHits === 0 && avg.has(s.id));
  const deadRight = dead.filter((s) => (avg.get(s.id)!.safe >= AT) === s.safe).length;
  const live = SUBJECTS.filter((s) => s.metrics.lineHits > 0 && avg.has(s.id));
  const liveRight = live.filter((s) => (avg.get(s.id)!.safe >= AT) === s.safe).length;
  console.log(`  on the ${dead.length} diffs to a line the tests never run: ${deadRight}/${dead.length} (${pct(deadRight / dead.length)})`);
  console.log(`  on the ${live.length} diffs to a covered line:            ${liveRight}/${live.length} (${pct(liveRight / live.length)})`);
}

function sectionDuplicates(): void {
  if (!existsSync(DUPES)) return;
  const dupes = JSON.parse(readFileSync(DUPES, "utf8")) as {
    bin: string;
    threshold: number;
    pairs: { similarity: number; a: string; b: string; identical: boolean; alphaEquivalent: boolean }[];
  };
  console.log("\n  5. THE NAMED TOOL, ON REAL CODE\n");
  console.log(`  \`similarity-ts --threshold ${dupes.threshold}\` over this repository's experiments:\n`);
  console.log(`  ${pad("similarity", 11)} ${pad("same code?", 11)} where`);
  for (const p of dupes.pairs.slice(0, 12)) {
    const label = p.identical ? "identical" : p.alphaEquivalent ? "renamed" : "different";
    console.log(`  ${pad(pct(p.similarity), 11)} ${pad(label, 11)} ${p.a}  ~  ${p.b}`);
  }
  if (dupes.pairs.length > 12) console.log(`  ... and ${dupes.pairs.length - 12} more`);
  console.log("");
  const identical = dupes.pairs.filter((p) => p.identical).length;
  const renamed = dupes.pairs.filter((p) => p.alphaEquivalent).length;
  const hundred = dupes.pairs.filter((p) => p.similarity >= 0.999).length;
  console.log(
    `  ${dupes.pairs.length} pairs; ${identical} identical, ${renamed} the same up to renaming, ` +
      `and ${hundred} reported at 100%.`,
  );
  console.log("  So \"100% similar\" is a statement about STRUCTURE, not about the code being the same --");
  console.log("  which is the thing a mechanical metric can hand a review and a review must not misread.");
  console.log("  On docs/33's own corpus the same tool reports 0 pairs on every task (§0) -- the functions");
  console.log("  are two to six lines and its default minimum is three, so the metric is null there.");
  console.log("  It is not null here, and what it found is in docs/33 §5.");
}

// ------------------------------------------------------------------ collection

async function pool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, async () => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= jobs.length) return;
        out[i] = await jobs[i]();
      }
    }),
  );
  return out;
}

async function collect(arms: ArmName[], repeats: number): Promise<Row[]> {
  const jev = new Jev();
  const jobs: (() => Promise<Row[]>)[] = [];
  for (const arm of arms) {
    for (let r = 0; r < repeats; r += 1) {
      for (const task of TASKS) {
        const asked = askedOf(task.id);
        if (asked.length === 0) continue;
        const id = `${arm}:${task.id}:${r}`;
        jobs.push(async () => {
          const started = Date.now();
          const res = await jev.ask(stateFor(arm, task), questionsFor(arm, asked));
          const ms = Date.now() - started;
          return asked.map((a) => ({
            subject: a.id,
            task: task.id,
            arm,
            repeat: r,
            safe: noul(res.answers[keyFor(SAFE, a.id)]),
            risk: score(res.answers[keyFor(RISK, a.id)]).score,
            reached: noul(res.answers[keyFor(REACHED, a.id)]),
            requestId: id,
            requestMs: ms,
            requestInputTokens: res.usage.input_tokens,
            batchSize: asked.length,
          }));
        });
      }
    }
  }
  console.log(`  ${jobs.length} requests, ${CONCURRENCY} at a time`);
  let done = 0;
  const results = await pool(
    jobs.map((job) => async () => {
      const out = await job();
      done += 1;
      process.stderr.write(`\r  ${done}/${jobs.length}`);
      return out;
    }),
    CONCURRENCY,
  );
  process.stderr.write("\n");
  const fresh = results.flat();
  const kept = readRecord().filter((r) => !arms.includes(r.arm) || r.repeat >= repeats);
  const all = [...kept, ...fresh];
  writeFileSync(RECORD, `[\n${all.map((r) => `  ${JSON.stringify(r)}`).join(",\n")}\n]\n`);
  console.log(
    `  ${jev.calls} calls, ${jev.inputTokens} input tokens, $${((jev.inputTokens / 1e6) * 0.042).toFixed(4)}, ` +
      `${Math.round(jev.totalMs / jev.calls)} ms mean` + (jev.retriedCalls > 0 ? `, ${jev.retriedCalls} retried` : ""),
  );
  return all;
}

async function main(): Promise<void> {
  console.log("=".repeat(104));
  console.log("  DOES A REVIEW GET BETTER WHEN THE MECHANICAL METRICS ARE HANDED TO IT? (docs/33)");
  rule();
  let rows = readRecord();
  if (ARGS.includes("--arm")) {
    const arms = opt("arm", "metrics").split(",") as ArmName[];
    for (const a of arms) if (!ARMS.includes(a)) throw new Error(`unknown arm ${a}`);
    rows = await collect(arms, Number(opt("repeat", "1")));
  }
  sectionCorpus();
  rule();
  sectionControl();
  if (rows.length > 0) {
    rule();
    sectionArms(rows);
    rule();
    sectionReached(rows);
    rule();
    sectionByRule(rows);
  }
  rule();
  sectionDuplicates();
  rule();
  const requests = new Map(rows.map((r) => [r.requestId, r]));
  const tokens = [...requests.values()].reduce((a, r) => a + r.requestInputTokens, 0);
  console.log(
    `  ${rows.length} recorded judgments over ${requests.size} requests: ${tokens} input tokens, ` +
      `$${((tokens / 1e6) * 0.042).toFixed(4)}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
