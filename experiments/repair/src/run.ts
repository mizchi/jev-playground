/**
 * docs/32 -- a repair loop where the patches are code and Jev only orders them.
 *
 *   npx tsx src/run.ts --replay                 # every table, no API key, no node --test
 *   npx tsx src/run.ts --arm score,choice,noul  # 36 requests, about $0.002
 *   npx tsx src/run.ts --verify                 # re-run the winner's edit for real
 *
 * Jev returns a probability, a class or a level -- never a string -- so it
 * cannot write a patch. The workflow is therefore deterministic except for
 * one step: mutate (code) -> ORDER (Jev) -> apply (code) -> test (code).
 * What gets measured is test runs to green, against the same loop with the
 * ordering removed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Jev, choice, noul, score } from "../../shared/jev.js";
import { drawNoise, mean, sd, separation, type Sample } from "../../shared/thresholds.js";
import { ARMS, ARM_BLURB, FREE, PICK, keyFor, questionsFor, stateFor, type ArmName, type FreeName } from "./arms.js";
import { candidates, type Candidate } from "./mutate.js";
import { hashOf, type TaskTruth } from "./record.js";
import { loadTasks, runWith, type Task } from "./world.js";

const HERE = import.meta.dirname;
const RECORD = resolve(HERE, "../records/repair.json");
const TRUTH = resolve(HERE, "../records/truth.json");

const ARGS = process.argv.slice(2);
const flag = (n: string) => ARGS.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = ARGS.indexOf(`--${n}`);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d;
};

interface Row {
  task: string;
  arm: ArmName;
  repeat: number;
  candidate: string;
  /** A score 0-3, a noul probability, or a choice probability. */
  value: number;
  /** The choice's own pick, on the one row that was picked. */
  picked: boolean;
  requestId: string;
  requestMs: number;
  requestInputTokens: number;
  batchSize: number;
}

const pad = (s: string, n: number) => s.padEnd(n);
const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "  - ");
const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : "  - ");
const rule = (n = 104) => console.log("-".repeat(n));

const TASKS = loadTasks();
const CANDS = new Map<string, Candidate[]>(TASKS.map((t) => [t.id, candidates(t.source)]));
const TRUTHS: TaskTruth[] = JSON.parse(readFileSync(TRUTH, "utf8")) as TaskTruth[];
const TRUTH_OF = new Map(TRUTHS.map((t) => [t.task, t]));

for (const t of TASKS) {
  const truth = TRUTH_OF.get(t.id);
  if (!truth) throw new Error(`no recorded truth for ${t.id}; run \`npm run truth\``);
  if (truth.sourceHash !== hashOf(t.source)) throw new Error(`${t.id} changed since the truth was recorded`);
  if (truth.candidates !== CANDS.get(t.id)!.length) throw new Error(`${t.id}: the catalog changed since the truth was recorded`);
}

const readRecord = (): Row[] => (existsSync(RECORD) ? (JSON.parse(readFileSync(RECORD, "utf8")) as Row[]) : []);

// ------------------------------------------------------------------- orderings

/** A seeded shuffle, so the control is the same every replay. */
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs];
  let state = seed || 1;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const WORDS = (text: string): Set<string> =>
  new Set((text.toLowerCase().match(/[a-z_$][\w$]*/g) ?? []).filter((w) => w.length > 2));

/**
 * The free ordering: the failing assertion names things.
 *
 * `node --test`'s output holds the failing test's name and the assertion's
 * expected and actual values, and a test called "clamps above" shares words
 * with the function it exercises. So: candidates whose changed line shares
 * more words with that output come first. It is the cheapest signal that is
 * not nothing, and §2 says what it is worth.
 */
function overlapOrder(task: Task, cands: readonly Candidate[], baseline: string): Candidate[] {
  const failing = WORDS(baseline);
  const scored = cands.map((c) => {
    const words = WORDS(c.before + " " + c.after);
    let hits = 0;
    for (const w of words) if (failing.has(w)) hits += 1;
    return { c, hits };
  });
  // Ties keep generation order, which is what a real implementation would do.
  return scored.sort((a, b) => b.hits - a.hits).map((x) => x.c);
}

function freeOrder(name: FreeName, task: Task, cands: readonly Candidate[], baseline: string): Candidate[] {
  if (name === "generation") return [...cands];
  if (name === "random") return shuffled(cands, hashOf(task.id));
  return overlapOrder(task, cands, baseline);
}

function jevOrder(rows: Row[], arm: ArmName, task: Task, cands: readonly Candidate[]): Candidate[] | null {
  const mine = rows.filter((r) => r.arm === arm && r.task === task.id);
  if (mine.length === 0) return null;
  const byCandidate = new Map<string, number[]>();
  for (const r of mine) byCandidate.set(r.candidate, [...(byCandidate.get(r.candidate) ?? []), r.value]);
  return [...cands].sort((a, b) => {
    const va = mean(byCandidate.get(a.id) ?? [0]);
    const vb = mean(byCandidate.get(b.id) ?? [0]);
    // Ties keep generation order: an arm that scores everything the same
    // must not get credit for the generator's ordering.
    return vb - va;
  });
}

/** How many test runs an ordering needs. Infinity when nothing works. */
function runsToGreen(task: Task, order: readonly Candidate[]): number {
  const fixes = new Set(TRUTH_OF.get(task.id)!.fixes);
  for (let i = 0; i < order.length; i += 1) if (fixes.has(order[i].id)) return i + 1;
  return Number.POSITIVE_INFINITY;
}

// -------------------------------------------------------------------- sections

function sectionCorpus(): void {
  console.log("\n  0. THE TASKS\n");
  console.log(`  ${pad("task", 16)} ${pad("lines", 6)} ${pad("cands", 6)} ${pad("fixes", 6)} ${pad("random", 7)} the planted bug`);
  for (const t of TASKS) {
    const truth = TRUTH_OF.get(t.id)!;
    const expected = (truth.candidates + 1) / (truth.fixes.length + 1);
    console.log(
      `  ${pad(t.id, 16)} ${pad(String(t.source.split("\n").length), 6)} ${pad(String(truth.candidates), 6)} ` +
        `${pad(String(truth.fixes.length), 6)} ${pad(num(expected, 1), 7)} ${t.blurb}`,
    );
  }
  const cands = TRUTHS.reduce((a, t) => a + t.candidates, 0);
  const fixes = TRUTHS.reduce((a, t) => a + t.fixes.length, 0);
  console.log("");
  console.log(`  ${TASKS.length} tasks, ${cands} candidates, ${fixes} of them turn the suite green (${pct(fixes / cands)})`);
  console.log(`  every task starts red, and the label is \`node --test\`'s exit code -- nothing here is written by hand`);
  console.log(`  \`random\` is the expected number of test runs a shuffle needs: (n+1)/(fixes+1)`);
}

interface ArmResult {
  name: string;
  runs: number[];
  top1: number;
  solved: number;
  requests: number;
  tokens: number;
  ms: number;
}

function resultOf(name: string, order: (t: Task) => Candidate[] | null, rows: Row[], arm?: ArmName): ArmResult {
  const runs: number[] = [];
  let top1 = 0;
  let solved = 0;
  for (const t of SOLVABLE) {
    const o = order(t);
    if (o === null) continue;
    const n = runsToGreen(t, o);
    runs.push(n);
    if (Number.isFinite(n)) solved += 1;
    if (n === 1) top1 += 1;
  }
  const mine = arm ? rows.filter((r) => r.arm === arm) : [];
  const requests = new Map<string, Row>();
  for (const r of mine) if (!requests.has(r.requestId)) requests.set(r.requestId, r);
  const reqs = [...requests.values()];
  const repeats = arm ? Math.max(1, new Set(mine.map((r) => r.repeat)).size) : 1;
  return {
    name,
    runs,
    top1,
    solved,
    requests: reqs.length / repeats,
    tokens: reqs.reduce((a, r) => a + r.requestInputTokens, 0) / repeats,
    ms: reqs.length > 0 ? mean(reqs.map((r) => r.requestMs)) : 0,
  };
}

const SOLVABLE = TASKS.filter((t) => TRUTH_OF.get(t.id)!.fixes.length > 0);
const UNSOLVABLE = TASKS.filter((t) => TRUTH_OF.get(t.id)!.fixes.length === 0);

function sectionOrderings(rows: Row[]): void {
  console.log("\n  1. TEST RUNS TO GREEN (the " + SOLVABLE.length + " tasks a single edit can fix)\n");
  const results: ArmResult[] = [];
  const baselineOf = (t: Task) => TRUTH_OF.get(t.id)!.baseline;
  for (const name of FREE) {
    results.push(resultOf(name, (t) => freeOrder(name, t, CANDS.get(t.id)!, baselineOf(t)), rows));
  }
  for (const arm of ARMS) {
    results.push(resultOf(arm, (t) => jevOrder(rows, arm, t, CANDS.get(t.id)!), rows, arm));
  }
  console.log(
    `  ${pad("ordering", 12)} ${pad("runs: mean", 11)} ${pad("median", 7)} ${pad("worst", 6)} ` +
      `${pad("first try", 10)} ${pad("solved", 7)} ${pad("reqs", 5)} ${pad("tokens", 7)} $`,
  );
  for (const r of results) {
    if (r.runs.length === 0) continue;
    const finite = r.runs.filter((x) => Number.isFinite(x));
    const sorted = [...finite].sort((a, b) => a - b);
    console.log(
      `  ${pad(r.name, 12)} ${pad(num(mean(finite), 2), 11)} ${pad(num(sorted[sorted.length >> 1], 1), 7)} ` +
        `${pad(String(Math.max(...finite)), 6)} ${pad(`${r.top1}/${r.runs.length}`, 10)} ` +
        `${pad(`${r.solved}/${r.runs.length}`, 7)} ${pad(num(r.requests, 0), 5)} ` +
        `${pad(num(r.tokens, 0), 7)} $${((r.tokens / 1e6) * 0.042).toFixed(4)}`,
    );
  }
  console.log("");
  for (const name of [...FREE, ...ARMS]) console.log(`    ${pad(name, 12)} ${ARM_BLURB[name]}`);
  console.log("");
  console.log(`  ${UNSOLVABLE.length} more tasks are in the corpus and NO single candidate fixes them --`);
  console.log("  two of them need two edits, three need an edit the catalog cannot make. §4 asks whether");
  console.log("  the judgment can tell those apart from the solvable ones before spending the test runs.");
}

function sectionPerTask(rows: Row[]): void {
  console.log("\n  2. PER TASK\n");
  const baselineOf = (t: Task) => TRUTH_OF.get(t.id)!.baseline;
  const names = [...FREE, ...ARMS];
  console.log(`  ${pad("task", 16)} ${pad("cands", 6)} ${names.map((n) => pad(n.slice(0, 9), 11)).join("")}`);
  for (const t of SOLVABLE) {
    const cells = names.map((n) => {
      const order = ARMS.includes(n as ArmName)
        ? jevOrder(rows, n as ArmName, t, CANDS.get(t.id)!)
        : freeOrder(n as FreeName, t, CANDS.get(t.id)!, baselineOf(t));
      if (order === null) return pad("-", 11);
      const runs = runsToGreen(t, order);
      return pad(Number.isFinite(runs) ? String(runs) : "never", 11);
    });
    console.log(`  ${pad(t.id, 16)} ${pad(String(CANDS.get(t.id)!.length), 6)} ${cells.join("")}`);
  }
  console.log("");
  console.log("  A 1 means the first candidate tried was a fix: the loop spends one test run and stops.");
}

function sectionRules(rows: Row[]): void {
  console.log("\n  3. WHICH RULE PRODUCED THE FIX, AND WHAT EACH ARM THOUGHT OF IT\n");
  const arm = (opt("read-arm", "score") as ArmName);
  const mine = rows.filter((r) => r.arm === arm);
  if (mine.length === 0) return;
  const byKey = new Map(mine.map((r) => [`${r.task}/${r.candidate}`, r.value]));
  console.log(`  ${pad("task", 16)} ${pad("rule", 22)} ${pad("its value", 10)} ${pad("rank", 6)} best non-fix`);
  for (const t of SOLVABLE) {
    const truth = TRUTH_OF.get(t.id)!;
    const cands = CANDS.get(t.id)!;
    const order = jevOrder(rows, arm, t, cands);
    if (order === null) continue;
    for (const id of truth.fixes) {
      const c = cands.find((x) => x.id === id)!;
      const rank = order.findIndex((x) => x.id === id) + 1;
      const best = order.find((x) => !truth.fixes.includes(x.id));
      console.log(
        `  ${pad(t.id, 16)} ${pad(c.rule, 22)} ${pad(num(byKey.get(`${t.id}/${id}`) ?? Number.NaN), 10)} ` +
          `${pad(String(rank), 6)} ${best ? `${best.rule} ${num(byKey.get(`${t.id}/${best.id}`) ?? Number.NaN)}` : "-"}`,
      );
    }
  }
  console.log("");
  console.log(`  (arm: ${arm}. A task with two fixes has two rows.)`);
}

function sectionChoice(rows: Row[]): void {
  const mine = rows.filter((r) => r.arm === "choice");
  if (mine.length === 0) return;
  console.log("\n  5. ONE CHOICE INSTEAD OF N QUESTIONS\n");
  let pickedRight = 0;
  let n = 0;
  const confs: number[] = [];
  for (const t of SOLVABLE) {
    const truth = TRUTH_OF.get(t.id)!;
    const picked = mine.filter((r) => r.task === t.id && r.picked);
    if (picked.length === 0) continue;
    n += 1;
    if (truth.fixes.includes(picked[0].candidate)) pickedRight += 1;
    confs.push(picked[0].value);
  }
  const scoreRows = rows.filter((r) => r.arm === "score");
  const perTask = (xs: Row[]) => {
    const requests = new Map<string, Row>();
    for (const r of xs) if (!requests.has(r.requestId)) requests.set(r.requestId, r);
    const repeats = Math.max(1, new Set(xs.map((r) => r.repeat)).size);
    return [...requests.values()].reduce((a, r) => a + r.requestInputTokens, 0) / repeats / TASKS.length;
  };
  console.log(`  the choice's own pick is a fix in ${pickedRight}/${n} tasks (${pct(pickedRight / n)})`);
  console.log(`  its probability on the picked option: ${num(mean(confs))} ±${num(sd(confs))}`);
  console.log("");
  console.log(`  tokens per task: choice ${num(perTask(mine), 0)}, score ${num(perTask(scoreRows), 0)}`);
  console.log("");
  console.log("  A `choice` returns a probability for EVERY option, so one question is a full ordering.");
  console.log("  That makes it the cheapest arm here by a wide margin -- and §1 says whether the");
  console.log("  ordering it gives is as good as asking about each candidate separately.");
}

/**
 * The question a repair loop actually has to answer first.
 *
 * Five of the twenty-one tasks have no single-edit fix in the candidate set:
 * two need two edits and three need an edit the catalog cannot make. From
 * the loop's point of view they are the same case -- the fix is not in here
 * -- and walking the whole set costs one test run per candidate to find out.
 *
 * So: does the TOP value over a task's candidates separate the two? That is
 * one number per task, already in the record, and it is what would let a
 * loop stop before spending anything.
 */
function sectionDetect(rows: Row[]): void {
  if (rows.length === 0) return;
  console.log("\n  4. IS THE FIX EVEN IN THE SET?\n");
  console.log(
    `  ${pad("arm", 8)} ${pad("top value: solvable", 20)} ${pad("unsolvable", 20)} ${pad("gap", 7)} AUC`,
  );
  const topOf = (arm: ArmName, t: Task): number | undefined => {
    const mine = rows.filter((r) => r.arm === arm && r.task === t.id);
    if (mine.length === 0) return undefined;
    const byCandidate = new Map<string, number[]>();
    for (const r of mine) byCandidate.set(r.candidate, [...(byCandidate.get(r.candidate) ?? []), r.value]);
    return Math.max(...[...byCandidate.values()].map((vs) => mean(vs)));
  };
  for (const arm of ARMS) {
    const yes = SOLVABLE.map((t) => topOf(arm, t)).filter((x): x is number => x !== undefined);
    const no = UNSOLVABLE.map((t) => topOf(arm, t)).filter((x): x is number => x !== undefined);
    if (yes.length === 0 || no.length === 0) continue;
    const sep = separation([
      ...yes.map((v) => ({ value: v, positive: true })),
      ...no.map((v) => ({ value: v, positive: false })),
    ]);
    console.log(
      `  ${pad(arm, 8)} ${pad(`${num(mean(yes))} ±${num(sd(yes))} (n=${yes.length})`, 20)} ` +
        `${pad(`${num(mean(no))} ±${num(sd(no))} (n=${no.length})`, 20)} ${pad(num(sep.gap), 7)} ${num(sep.auc, 3)}`,
    );
  }
  console.log("");
  const arm = (opt("read-arm", "score") as ArmName);
  console.log(`  the ${UNSOLVABLE.length} with no fix in the set, by their top ${arm}:`);
  for (const t of UNSOLVABLE) {
    const top = topOf(arm, t);
    if (top === undefined) continue;
    console.log(`     ${pad(t.id, 16)} ${num(top)}  ${t.blurb.slice(0, 62)}`);
  }
  console.log("");
  console.log("  A positive gap would mean a loop could stop before spending a single test run. A");
  console.log("  negative one means it cannot, and the AUC says how close it gets to being able to.");

  // And the number that decides whether the gap is real: how far the same
  // question's answer moves between draws. docs/25's rule -- a margin
  // thinner than the draw noise is not a margin.
  const repeats = new Set(rows.map((r) => r.repeat)).size;
  if (repeats < 2) return;
  console.log("");
  console.log(`  ${repeats} draws of every candidate. The gap above has to beat this to be a cutoff:`);
  console.log(`  ${pad("arm", 8)} ${pad("within-candidate sd", 20)} ${pad("max spread", 11)} top-value spread per task`);
  for (const arm of ARMS) {
    const mine = rows.filter((r) => r.arm === arm);
    if (mine.length === 0) continue;
    const samples: Sample[] = mine.map((r) => ({ value: r.value, positive: true, group: `${r.task}/${r.candidate}` }));
    const noise = drawNoise(samples);
    // The statistic the gap is actually made of: the per-draw top value.
    const tops: number[] = [];
    for (const t of TASKS) {
      const perDraw: number[] = [];
      for (let d = 0; d < repeats; d += 1) {
        const vs = mine.filter((r) => r.task === t.id && r.repeat === d).map((r) => r.value);
        if (vs.length > 0) perDraw.push(Math.max(...vs));
      }
      if (perDraw.length > 1) tops.push(Math.max(...perDraw) - Math.min(...perDraw));
    }
    console.log(
      `  ${pad(arm, 8)} ${pad(num(noise.sd, 3), 20)} ${pad(num(noise.maxSpread, 3), 11)} ` +
        `mean ${num(mean(tops), 3)}, max ${num(Math.max(...tops), 3)}`,
    );
  }
}

function sectionVerify(rows: Row[]): void {
  if (!flag("verify")) return;
  console.log("\n  6. VERIFYING FOR REAL\n");
  const arm = (opt("read-arm", "score") as ArmName);
  let green = 0;
  for (const t of SOLVABLE) {
    const order = jevOrder(rows, arm, t, CANDS.get(t.id)!);
    if (order === null) continue;
    let used = 0;
    let ok = false;
    for (const c of order) {
      used += 1;
      if (runWith(t, c.text).pass) {
        ok = true;
        break;
      }
    }
    if (ok) green += 1;
    console.log(`  ${pad(t.id, 16)} ${ok ? "green" : "NEVER"} after ${used} real test run(s)`);
  }
  console.log("");
  console.log(`  ${green}/${SOLVABLE.length} reached green by actually applying the edits and running the suite.`);
  console.log("  §1's numbers come from the recorded truth; this re-derives them from processes.");
}

// ------------------------------------------------------------------ collection

async function collect(arms: ArmName[], repeats: number): Promise<Row[]> {
  const jev = new Jev();
  const fresh: Row[] = [];
  for (const arm of arms) {
    for (let r = 0; r < repeats; r += 1) {
      for (const task of TASKS) {
        const cands = CANDS.get(task.id)!;
        const baseline = TRUTH_OF.get(task.id)!.baseline;
        const started = Date.now();
        const res = await jev.ask(stateFor(task, baseline), questionsFor(arm, cands));
        const ms = Date.now() - started;
        const id = `${arm}:${task.id}:${r}`;
        if (arm === "choice") {
          const a = res.answers[PICK];
          const probs = a?.type === "choice" ? a.probabilities : {};
          const pickedKey = a?.type === "choice" ? a.choice : "";
          for (const c of cands) {
            fresh.push({
              task: task.id,
              arm,
              repeat: r,
              candidate: c.id,
              value: probs[keyFor(c)] ?? 0,
              picked: keyFor(c) === pickedKey,
              requestId: id,
              requestMs: ms,
              requestInputTokens: res.usage.input_tokens,
              batchSize: cands.length,
            });
          }
        } else {
          for (const c of cands) {
            const answer = res.answers[keyFor(c)];
            fresh.push({
              task: task.id,
              arm,
              repeat: r,
              candidate: c.id,
              value: arm === "noul" ? noul(answer) : score(answer).score,
              picked: false,
              requestId: id,
              requestMs: ms,
              requestInputTokens: res.usage.input_tokens,
              batchSize: cands.length,
            });
          }
        }
        process.stderr.write(`\r  ${arm} ${fresh.length} rows`);
      }
    }
  }
  process.stderr.write("\n");
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
  console.log("  A REPAIR LOOP WHERE THE PATCHES ARE CODE AND THE JUDGMENT ONLY ORDERS THEM (docs/32)");
  rule();
  let rows = readRecord();
  if (ARGS.includes("--arm")) {
    const arms = opt("arm", "score").split(",") as ArmName[];
    for (const a of arms) if (!ARMS.includes(a)) throw new Error(`unknown arm ${a}`);
    rows = await collect(arms, Number(opt("repeat", "1")));
  }
  sectionCorpus();
  rule();
  sectionOrderings(rows);
  if (rows.length > 0) {
    rule();
    sectionPerTask(rows);
    rule();
    sectionRules(rows);
    rule();
    sectionDetect(rows);
    rule();
    sectionChoice(rows);
    if (flag("verify")) {
      rule();
      sectionVerify(rows);
    }
  }
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
