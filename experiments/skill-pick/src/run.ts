/**
 * docs/30 -- selecting from a 461-skill roster.
 *
 * The premise this started from was that the roster would not fit in one
 * request, forcing a two-stage design. Half of that is true (§1: the roster
 * does not fit as the fan-out is normally written) and half is not (§8: it
 * fits in one request once the criteria stop being repeated per question).
 * The prefilter turns out to be worth keeping for a different reason than
 * the one it was built for -- §3.
 *
 *   npx tsx src/run.ts --replay        # re-derive every table, no API key
 *   npx tsx src/run.ts --ceiling       # 6 requests: where the 400 starts
 *   npx tsx src/run.ts --arm full      # 461 questions per project, in chunks
 *   npx tsx src/run.ts --arm narrow    # the k=60 survivors alone, for the check
 *   npx tsx src/run.ts --arm terse     # four-word criteria: does the payload have to be this big?
 *
 * The one thing that makes this affordable is docs/29 §4: the answer to a
 * question does not move when the request gets wider (99.8% within 0.25
 * between 74-wide and 1-wide). So stage 2 is run ONCE over the whole roster,
 * and every (prefilter, k) pair is then evaluated from that record without
 * another request. `--arm narrow` re-checks the assumption in this domain
 * instead of only citing it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Jev, score } from "../../shared/jev.js";
import { averagePrecision, meanOf, precisionAtK, worstPositiveRank, type Scored } from "../../skill-select/src/metrics.js";
import { candidatesFor, loadCorpus, PROJECTS, type Candidate } from "./corpus.js";
import { tokensOf } from "./roster.js";
import {
  PREFILTERS,
  PREFILTER_BLURB,
  chunk,
  keepTop,
  keyFor,
  prescore,
  questionsFor,
  stateFor,
  type Prefilter,
} from "./stages.js";

const HERE = import.meta.dirname;
const RECORD = resolve(HERE, "../records/pick.json");
const CEILING = resolve(HERE, "../records/ceiling.json");
const LEDGER = resolve(HERE, "../records/ledger.json");

const ARGS = process.argv.slice(2);
const flag = (n: string) => ARGS.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = ARGS.indexOf(`--${n}`);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d;
};
const CONCURRENCY = Number(opt("concurrency", "4"));
/** Questions per request. 260 fit and 280 did not (§1), so this is under it. */
const PER_REQUEST = Number(opt("per-request", "200"));

type Arm = "full" | "narrow" | "terse";

interface Row {
  project: string;
  arm: Arm;
  name: string;
  value: number;
  confidence: number;
  requestId: string;
  requestMs: number;
  requestInputTokens: number;
  batchSize: number;
}

interface CeilingRow {
  questions: number;
  /** "full" repeats the criteria per question; "terse" pays for them once. */
  form: "full" | "terse";
  ok: boolean;
  inputTokens: number;
  detail: string;
}

/** One measured configuration of the tool. */
interface LedgerRow {
  iteration: number;
  prefilter: Prefilter;
  k: number;
  /** Whether the criteria were repeated per question or paid for once (§8). */
  form: "full" | "terse";
  /** Whether each skill's cross-project prior was subtracted (§7). */
  specificity: boolean;
  /** What this iteration changed relative to the one before. */
  change: string;
  recall: number;
  ap: number;
  p12: number;
  worst: number;
  requestsPerProject: number;
  tokensPerProject: number;
  dollarsPerProject: number;
}

/**
 * On disk the request metadata lives once per request, not once per row.
 *
 * 13,748 rows each repeating the request id, the arm, the project, the
 * latency, the token count and the batch size came to 2.6 MB -- more than
 * this repository's whole git history. The in-memory shape is unchanged;
 * only the file is folded.
 */
interface RequestMeta {
  id: string;
  arm: Arm;
  project: string;
  ms: number;
  inputTokens: number;
  size: number;
}

function dehydrate(rows: Row[]): string {
  const requests = new Map<string, RequestMeta>();
  for (const r of rows) {
    if (requests.has(r.requestId)) continue;
    requests.set(r.requestId, {
      id: r.requestId,
      arm: r.arm,
      project: r.project,
      ms: r.requestMs,
      inputTokens: r.requestInputTokens,
      size: r.batchSize,
    });
  }
  const head = [...requests.values()].map((m) => `    ${JSON.stringify(m)}`).join(",\n");
  const body = rows
    .map((r) => `    ${JSON.stringify({ requestId: r.requestId, name: r.name, value: r.value, confidence: r.confidence })}`)
    .join(",\n");
  return `{\n  "requests": [\n${head}\n  ],\n  "rows": [\n${body}\n  ]\n}\n`;
}

function hydrate(text: string): Row[] {
  const parsed = JSON.parse(text) as {
    requests: RequestMeta[];
    rows: { requestId: string; name: string; value: number; confidence: number }[];
  };
  const meta = new Map(parsed.requests.map((m) => [m.id, m]));
  return parsed.rows.map((r) => {
    const m = meta.get(r.requestId);
    if (!m) throw new Error(`row for an unknown request: ${r.requestId}`);
    return {
      project: m.project,
      arm: m.arm,
      name: r.name,
      value: r.value,
      confidence: r.confidence,
      requestId: r.requestId,
      requestMs: m.ms,
      requestInputTokens: m.inputTokens,
      batchSize: m.size,
    };
  });
}

const readRecord = (): Row[] => (existsSync(RECORD) ? hydrate(readFileSync(RECORD, "utf8")) : []);

const pad = (s: string, n: number) => s.padEnd(n);
const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "  - ");
const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : "  - ");
const rule = (n = 104) => console.log("-".repeat(n));

const CORPUS = loadCorpus(resolve(HERE, ".."), resolve(HERE, "../../skill-select"));
const CANDS = new Map<string, Candidate[]>();
for (const p of PROJECTS) CANDS.set(p.id, candidatesFor(CORPUS, p));
const ALL = CANDS.get(PROJECTS[0].id)!;

// -------------------------------------------------------------------- sections

function sectionRoster(): void {
  console.log("\n  0. THE ROSTER\n");
  const bySource = new Map<string, number>();
  for (const e of CORPUS.roster.entries) bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1);
  for (const [source, n] of [...bySource].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${pad(source, 42)} @ ${CORPUS.roster.revs[source]?.slice(0, 8) ?? "?"}`);
  }
  const catalogued = ALL.filter((c) => c.catalogued !== null).length;
  console.log("");
  console.log(`  ${ALL.length} entries: ${catalogued} in mizchi's catalog, ${ALL.length - catalogued} distractors`);
  console.log(`  ${tokensOf(CORPUS.roster.entries)} tokens of name + description`);
  if (CORPUS.unmatched.length > 0) console.log(`  UNMATCHED catalog rows: ${CORPUS.unmatched.join(", ")}`);
  console.log("");
  console.log(`  ${pad("project", 16)} ${pad("want", 5)} ${pad("mention", 8)} ${pad("no", 5)}  positives as a share of the roster`);
  for (const p of PROJECTS) {
    const cs = CANDS.get(p.id)!;
    const want = cs.filter((c) => c.label === "want").length;
    const mention = cs.filter((c) => c.label === "mention").length;
    console.log(
      `  ${pad(p.id, 16)} ${pad(String(want), 5)} ${pad(String(mention), 8)} ` +
        `${pad(String(cs.length - want - mention), 5)}  ${pct(want / cs.length)}`,
    );
  }
  const total = PROJECTS.reduce((a, p) => a + CANDS.get(p.id)!.filter((c) => c.label === "want").length, 0);
  console.log("");
  console.log(
    `  ${total} positives over ${PROJECTS.length * ALL.length} pairs (${pct(total / (PROJECTS.length * ALL.length))}); ` +
      `docs/29 had the same ${total} over ${PROJECTS.length * 74} pairs (13%)`,
  );
}

function sectionCeiling(): void {
  if (!existsSync(CEILING)) return;
  const rows = JSON.parse(readFileSync(CEILING, "utf8")) as CeilingRow[];
  console.log("\n  1. DOES IT FIT? NOT AS WRITTEN\n");
  console.log(`  ${pad("form", 7)} ${pad("questions", 10)} ${pad("result", 24)} ${pad("input tokens", 13)} per question`);
  for (const r of [...rows].sort((a, b) => a.form.localeCompare(b.form) || a.questions - b.questions)) {
    console.log(
      `  ${pad(r.form, 7)} ${pad(String(r.questions), 10)} ${pad(r.ok ? "OK" : r.detail.slice(0, 22), 24)} ` +
        `${pad(r.ok ? String(r.inputTokens) : "-", 13)} ${r.ok ? num(r.inputTokens / r.questions, 0) : "-"}`,
    );
  }
  for (const form of ["full", "terse"] as const) {
    const mine = rows.filter((r) => r.form === form);
    if (mine.length === 0) continue;
    const ok = mine.filter((r) => r.ok).map((r) => r.questions);
    const bad = mine.filter((r) => !r.ok).map((r) => r.questions);
    console.log("");
    console.log(
      `  ${form}: largest that fits ${ok.length > 0 ? Math.max(...ok) : "none"}, ` +
        `smallest that does not ${bad.length > 0 ? Math.min(...bad) : "none tried"}. The roster is ${ALL.length}.`,
    );
  }
  console.log("");
  console.log("  In the `full` form each question repeats the task sentence and the four criteria, which is");
  console.log("  about half of its 251 tokens -- the descriptions alone are 131. §7 pays for them once in");
  console.log("  the state instead, and that is the difference between the roster fitting and not.");
}

function scoredFor(rows: Row[], project: string, keep?: Set<string>): Scored[] {
  const byName = new Map(rows.filter((r) => r.project === project).map((r) => [r.name, r.value]));
  const out: Scored[] = [];
  for (const c of CANDS.get(project)!) {
    if (c.label === "mention") continue;
    if (keep && !keep.has(c.name)) continue;
    const v = byName.get(c.name);
    if (v === undefined) continue;
    out.push({ skill: c.name, value: v, positive: c.label === "want" });
  }
  return out;
}

/** Recall of the wanted rows among the top k of a prefilter. */
function recallAt(filter: Prefilter, k: number): number {
  const per = PROJECTS.map((p) => {
    const cs = CANDS.get(p.id)!;
    const kept = new Set(keepTop(prescore(filter, cs, p), cs, k).map((c) => c.name));
    const want = cs.filter((c) => c.label === "want");
    if (want.length === 0) return Number.NaN;
    return want.filter((c) => kept.has(c.name)).length / want.length;
  });
  return meanOf(per);
}

function sectionPrefilters(): void {
  console.log("\n  2. STAGE 1: WHAT A FREE PREFILTER KEEPS\n");
  const ks = [15, 30, 60, 90, 120, 180, 260];
  console.log(`  ${pad("prefilter", 11)} ${ks.map((k) => pad(`k=${k}`, 7)).join(" ")}   (recall of the wanted rows)`);
  for (const filter of PREFILTERS) {
    if (filter === "none") continue;
    console.log(`  ${pad(filter, 11)} ${ks.map((k) => pad(pct(recallAt(filter, k)), 7)).join(" ")}`);
  }
  console.log("");
  for (const filter of PREFILTERS) console.log(`    ${pad(filter, 11)} ${PREFILTER_BLURB[filter]}`);
  console.log("");
  console.log("  `random` is the control: at k it keeps k/461 of anything, so a prefilter that does not");
  console.log("  clear it by a wide margin is buying nothing. Ties break AGAINST the prefilter.");
}

function evaluate(rows: Row[], filter: Prefilter, k: number): {
  recall: number;
  ap: number;
  p12: number;
  worst: number;
} {
  const aps: number[] = [];
  const p12s: number[] = [];
  const worsts: number[] = [];
  for (const p of PROJECTS) {
    const cs = CANDS.get(p.id)!;
    const kept = new Set(keepTop(prescore(filter, cs, p), cs, k).map((c) => c.name));
    const scored = scoredFor(rows, p.id, kept);
    if (scored.filter((s) => s.positive).length === 0) continue;
    aps.push(averagePrecision(scored));
    // P@12 is measured against the FULL positive set, not the survivors:
    // a proposal of twelve is judged by what the catalog wanted, and a row
    // stage 1 threw away is a row this proposal is missing.
    p12s.push(precisionAtK(scored, 12));
    worsts.push(worstPositiveRank(scored));
  }
  return { recall: recallAt(filter, k), ap: meanOf(aps), p12: meanOf(p12s), worst: meanOf(worsts) };
}

function sectionEndToEnd(rows: Row[]): void {
  const full = rows.filter((r) => r.arm === "full");
  if (full.length === 0) return;
  // Measured, not estimated: the mean request cost of the arm these
  // judgments came from.
  const reqs = [...new Map(full.map((r) => [r.requestId, r])).values()];
  const perQuestion = reqs.reduce((a, r) => a + r.requestInputTokens, 0) / full.length;
  console.log("\n  3. END TO END: the proposal a user would read\n");
  console.log(
    `  ${pad("prefilter", 11)} ${pad("k", 5)} ${pad("recall", 7)} ${pad("AP", 6)} ${pad("P@12", 6)} ` +
      `${pad("worst", 6)} ${pad("reqs", 5)} ${pad("tok/proj", 9)} $/proj`,
  );
  for (const filter of ["overlap", "tfidf", "firstline", "random"] as Prefilter[]) {
    for (const k of [60, 120, 260]) {
      const e = evaluate(full, filter, k);
      const tokens = Math.round(perQuestion * k);
      console.log(
        `  ${pad(filter, 11)} ${pad(String(k), 5)} ${pad(pct(e.recall), 7)} ${pad(num(e.ap), 6)} ` +
          `${pad(num(e.p12), 6)} ${pad(num(e.worst, 1), 6)} ${pad(String(Math.ceil(k / 260)), 5)} ${pad(String(tokens), 9)} ` +
          `$${((tokens / 1e6) * 0.042).toFixed(4)}`,
      );
    }
  }
  const whole = evaluate(full, "none", ALL.length);
  const wholeReqs = Math.ceil(ALL.length / 260);
  const wholeTokens = Math.round(perQuestion * ALL.length);
  console.log(
    `  ${pad("none", 11)} ${pad(String(ALL.length), 5)} ${pad("100%", 7)} ${pad(num(whole.ap), 6)} ` +
      `${pad(num(whole.p12), 6)} ${pad(num(whole.worst, 1), 6)} ${pad(String(wholeReqs), 5)} ` +
      `${pad(String(wholeTokens), 9)} $${((wholeTokens / 1e6) * 0.042).toFixed(4)}`,
  );
  console.log("");
  console.log("  `none` is the recall ceiling, and in this form it needs 2 requests (§1). §7 gets it into");
  console.log("  one by not repeating the criteria -- but notice that recall is not what a proposal wants:");
  console.log("  P@12 FALLS as k rises, 0.25 at 60 to 0.19 at 461. §5 says why.");
  console.log("  Every row is measured from the SAME judgments: docs/29 §4 established that a");
  console.log("  question's answer does not move with the request's width, so restricting to the top k of");
  console.log("  a prefilter is the same as having asked only about those k. §4 re-checks that here.");
}

function sectionWidthCheck(rows: Row[]): void {
  const full = rows.filter((r) => r.arm === "full");
  const narrow = rows.filter((r) => r.arm === "narrow");
  if (narrow.length === 0 || full.length === 0) return;
  console.log("\n  4. RE-CHECKING THE ASSUMPTION §3 RESTS ON\n");
  const key = (r: Row) => `${r.project}/${r.name}`;
  const byFull = new Map(full.map((r) => [key(r), r.value]));
  let n = 0;
  let same = 0;
  let near = 0;
  let total = 0;
  for (const r of narrow) {
    const v = byFull.get(key(r));
    if (v === undefined) continue;
    n += 1;
    total += Math.abs(v - r.value);
    if (Math.round(v) === Math.round(r.value)) same += 1;
    if (Math.abs(v - r.value) < 0.25) near += 1;
  }
  const fullWidth = meanOf(full.map((r) => r.batchSize));
  const narrowWidth = meanOf(narrow.map((r) => r.batchSize));
  console.log(`  ${num(narrowWidth, 0)} questions per request against ${num(fullWidth, 0)}, same state, same question:`);
  console.log(`  ${n} pairs, same level ${pct(same / n)}, within 0.25 ${pct(near / n)}, mean |diff| ${num(total / n, 3)}`);
  console.log("");
  const narrowAp = meanOf(
    PROJECTS.map((p) => {
      const scored = scoredFor(narrow, p.id);
      return scored.filter((s) => s.positive).length === 0 ? Number.NaN : averagePrecision(scored);
    }),
  );
  console.log(`  AP over the k=60 survivors: ${num(narrowAp)} asked narrow, ${num(evaluate(full, "overlap", 60).ap)} taken from the wide run`);
}

function sectionDistractors(rows: Row[]): void {
  const full = rows.filter((r) => r.arm === "full");
  if (full.length === 0) return;
  console.log("\n  5. THE DISTRACTORS THE JUDGMENT LIKES BEST\n");
  console.log("  Every one of these is labelled `no` because it is not a row in mizchi's catalog.");
  console.log("  That is a label by construction, so here are the top three per project to read.\n");
  for (const p of PROJECTS) {
    const cs = new Map(CANDS.get(p.id)!.map((c) => [c.name, c]));
    const top = full
      .filter((r) => r.project === p.id && cs.get(r.name)?.catalogued === null)
      .sort((a, b) => b.value - a.value)
      .slice(0, 3);
    const cells = top.map((r) => `${r.name} ${num(r.value)}`).join("  |  ");
    console.log(`  ${pad(p.id, 16)} ${cells}`);
  }
  const catalogued = full.filter((r) => CANDS.get(r.project)!.find((c) => c.name === r.name)?.catalogued !== null);
  const distractors = full.filter((r) => CANDS.get(r.project)!.find((c) => c.name === r.name)?.catalogued === null);
  const at3 = (xs: Row[]) => xs.filter((r) => r.value >= 2.5).length / xs.length;
  console.log("");
  console.log(
    `  share scoring 2.5 or more: catalogued ${pct(at3(catalogued))} of ${catalogued.length}, ` +
      `distractors ${pct(at3(distractors))} of ${distractors.length}`,
  );
}

/**
 * The fix §3 and §5 point at.
 *
 * §3 says more recall makes the proposal worse, and §5 says why: the roster
 * holds real skills -- `code-reviewer`, `devops-engineer`, `test-automator`,
 * `dependency-manager` -- that score 2.9 to 3.0 for EVERY project, because
 * they genuinely do apply to every project. A proposal made of those is
 * correct and useless.
 *
 * So subtract what a skill scores everywhere. It is IDF, applied to the
 * judgment instead of to the vocabulary: what is informative is not the
 * score but how much this project's score exceeds the skill's own baseline.
 *
 * The baseline has to come from OTHER projects or it is circular, so it is
 * held out: a skill's prior is its mean over the thirteen projects that are
 * not the one being scored. A real tool computes the same thing once, over
 * whatever reference repositories it has, and ships it with the roster.
 */
function specificity(rows: Row[], project: string): Map<string, number> {
  const out = new Map<string, number>();
  const byName = new Map<string, { here: number; others: number[] }>();
  for (const r of rows) {
    const e = byName.get(r.name) ?? { here: Number.NaN, others: [] };
    if (r.project === project) e.here = r.value;
    else e.others.push(r.value);
    byName.set(r.name, e);
  }
  for (const [name, e] of byName) {
    if (!Number.isFinite(e.here)) continue;
    out.set(name, e.here - meanOf(e.others));
  }
  return out;
}

function sectionSpecificity(rows: Row[]): void {
  const full = rows.filter((r) => r.arm === "full");
  if (full.length === 0) return;
  console.log("\n  6. SUBTRACTING WHAT A SKILL SCORES EVERYWHERE\n");
  const byProject = new Map(PROJECTS.map((p) => [p.id, specificity(full, p.id)]));
  const scoredWith = (project: string, keep?: Set<string>): Scored[] => {
    const spec = byProject.get(project)!;
    return scoredFor(full, project, keep).map((s) => ({ ...s, value: spec.get(s.skill) ?? s.value }));
  };
  console.log(`  ${pad("prefilter", 11)} ${pad("k", 5)} ${pad("P@12 raw", 9)} ${pad("P@12 spec", 10)} ${pad("AP raw", 7)} ${pad("AP spec", 8)} worst raw -> spec`);
  for (const [filter, k] of [["overlap", 60], ["overlap", 120], ["overlap", 260], ["none", ALL.length]] as [Prefilter, number][]) {
    const raws: Scored[][] = [];
    const specs: Scored[][] = [];
    for (const p of PROJECTS) {
      const cs = CANDS.get(p.id)!;
      const keep = filter === "none" ? undefined : new Set(keepTop(prescore(filter, cs, p), cs, k).map((c) => c.name));
      const raw = scoredFor(full, p.id, keep);
      if (raw.filter((s) => s.positive).length === 0) continue;
      raws.push(raw);
      specs.push(scoredWith(p.id, keep));
    }
    console.log(
      `  ${pad(filter, 11)} ${pad(String(k), 5)} ${pad(num(meanOf(raws.map((x) => precisionAtK(x, 12)))), 9)} ` +
        `${pad(num(meanOf(specs.map((x) => precisionAtK(x, 12)))), 10)} ` +
        `${pad(num(meanOf(raws.map(averagePrecision))), 7)} ${pad(num(meanOf(specs.map(averagePrecision))), 8)} ` +
        `${num(meanOf(raws.map(worstPositiveRank)), 1)} -> ${num(meanOf(specs.map(worstPositiveRank)), 1)}`,
    );
  }
  console.log("");
  console.log("  The skills with the highest and lowest priors, over all 14 projects:");
  const priors = new Map<string, number[]>();
  for (const r of full) priors.set(r.name, [...(priors.get(r.name) ?? []), r.value]);
  const ranked = [...priors]
    .map(([name, vs]) => ({ name, mean: meanOf(vs), catalogued: ALL.find((c) => c.name === name)?.catalogued !== null }))
    .sort((a, b) => b.mean - a.mean);
  for (const r of ranked.slice(0, 8)) {
    console.log(`     ${pad(r.name, 34)} ${num(r.mean)}  ${r.catalogued ? "catalogued" : "distractor"}`);
  }
  console.log("     ...");
  const midHigh = ranked.filter((r) => r.mean > 0.05).length;
  console.log(`     ${ranked.filter((r) => r.mean >= 2.5).length} of ${ranked.length} score 2.5+ on average; ${ranked.length - midHigh} average under 0.05`);
  console.log("");
  console.log("  A prior is held out by project: a skill's baseline is its mean over the other thirteen,");
  console.log("  so nothing in a project's own answers sets its own correction.");
}

/**
 * What the criteria text costs, and whether it is buying anything.
 *
 * §1 measured 251 tokens per question against 131 tokens of description. The
 * gap is the four criteria and the task sentence, repeated once per question
 * -- the only part of a fan-out payload that is identical across questions.
 * The `terse` arm moves the task sentence into the state, leaves the four
 * levels as four words, and changes nothing else.
 */
function sectionTerse(rows: Row[]): void {
  const full = rows.filter((r) => r.arm === "full");
  const terse = rows.filter((r) => r.arm === "terse");
  if (terse.length === 0 || full.length === 0) return;
  console.log("\n  7. WHAT THE CRITERIA TEXT COSTS\n");
  const perQuestion = (xs: Row[]) => {
    const reqs = [...new Map(xs.map((r) => [r.requestId, r])).values()];
    return reqs.reduce((a, r) => a + r.requestInputTokens, 0) / xs.length;
  };
  console.log(`  ${pad("arm", 8)} ${pad("tokens/question", 16)} ${pad("tokens/project", 15)} ${pad("questions per request", 22)} ms/req`);
  for (const [name, xs] of [["full", full], ["terse", terse]] as [string, Row[]][]) {
    const reqs = [...new Map(xs.map((r) => [r.requestId, r])).values()];
    const per = perQuestion(xs);
    console.log(
      `  ${pad(name, 8)} ${pad(num(per, 0), 16)} ` +
        `${pad(num(reqs.reduce((a, r) => a + r.requestInputTokens, 0) / PROJECTS.length, 0), 15)} ` +
        `${pad(`${Math.floor(65536 / per)} would fit`, 22)} ${num(meanOf(reqs.map((r) => r.requestMs)), 0)}`,
    );
  }
  const key = (r: Row) => `${r.project}/${r.name}`;
  const byFull = new Map(full.map((r) => [key(r), r.value]));
  let n = 0;
  let same = 0;
  let near = 0;
  let total = 0;
  for (const r of terse) {
    const v = byFull.get(key(r));
    if (v === undefined) continue;
    n += 1;
    total += Math.abs(v - r.value);
    if (Math.round(v) === Math.round(r.value)) same += 1;
    if (Math.abs(v - r.value) < 0.25) near += 1;
  }
  console.log("");
  console.log(`  ${n} pairs: same level ${pct(same / n)}, within 0.25 ${pct(near / n)}, mean |diff| ${num(total / n, 3)}`);
  const ap = (xs: Row[], spec: boolean) =>
    meanOf(
      PROJECTS.map((p) => {
        const cs = CANDS.get(p.id)!;
        const keep = new Set(keepTop(prescore("overlap", cs, p), cs, 60).map((c) => c.name));
        const base = scoredFor(xs, p.id, keep);
        if (base.filter((s) => s.positive).length === 0) return Number.NaN;
        if (!spec) return averagePrecision(base);
        const s = specificity(xs.filter((r) => r.arm === xs[0].arm), p.id);
        return averagePrecision(base.map((b) => ({ ...b, value: s.get(b.skill) ?? b.value })));
      }),
    );
  const p12 = (xs: Row[]) =>
    meanOf(
      PROJECTS.map((p) => {
        const cs = CANDS.get(p.id)!;
        const keep = new Set(keepTop(prescore("overlap", cs, p), cs, 60).map((c) => c.name));
        const base = scoredFor(xs, p.id, keep);
        return base.filter((s) => s.positive).length === 0 ? Number.NaN : precisionAtK(base, 12);
      }),
    );
  console.log("");
  console.log(`  at overlap@60: AP ${num(ap(full, false))} -> ${num(ap(terse, false))}, P@12 ${num(p12(full))} -> ${num(p12(terse))}`);
  console.log(`  with the §6 correction: AP ${num(ap(full, true))} -> ${num(ap(terse, true))}`);
  console.log("");
  console.log("  The four criteria were the same string in every question, so they were the one part of");
  console.log("  the payload that a fan-out pays for n times without learning anything new n times.");
}

/**
 * The tool on two real repositories.
 *
 * docs/29's standing limit was that its fourteen projects were written by
 * me. These two are read off disk by `project.ts`: a file survey, whatever
 * `CLAUDE.md` holds, and one sentence of what the work is. There is no label
 * for a real repository, so the only thing to do with the output is read it,
 * which is what docs/30 §9 does.
 */
function sectionReal(): void {
  const path = resolve(HERE, "../records/real.json");
  if (!existsSync(path)) return;
  const runs = JSON.parse(readFileSync(path, "utf8")) as {
    repo: string;
    intent: string;
    prefilter: string;
    k: number;
    requests: number;
    inputTokens: number;
    dollars: number;
    rows: { name: string; source: string; score: number; raw: number }[];
  }[];
  console.log("\n  9. THE TOOL, ON TWO REAL REPOSITORIES\n");
  for (const run of runs) {
    console.log(`  ${run.repo} -- ${run.prefilter}@${run.k}, ${run.requests} request, ${run.inputTokens} tokens, $${run.dollars}`);
    console.log(`    "${run.intent.slice(0, 92)}"`);
    for (const row of run.rows.slice(0, 8)) {
      console.log(`      ${num(row.score).padStart(6)}  ${pad(row.name, 34)} ${row.source}`);
    }
    console.log("");
  }
  console.log("  Scores are after the §6 subtraction, so they are not comparable to §3's raw levels.");
  console.log("  Nothing here has a label: docs/30 §9 reads them instead of scoring them.");
}

function sectionLedger(rows: Row[]): void {
  const full = rows.filter((r) => r.arm === "full");
  const terse = rows.filter((r) => r.arm === "terse");
  if (full.length === 0) return;
  console.log("\n  8. THE EVAL LOOP\n");
  const configs: { prefilter: Prefilter; k: number; form: "full" | "terse"; spec: boolean; change: string }[] = [
    { prefilter: "random", k: 60, form: "full", spec: false, change: "the control: keep 60 at random" },
    { prefilter: "overlap", k: 60, form: "full", spec: false, change: "IDF overlap instead of random" },
    { prefilter: "firstline", k: 60, form: "full", spec: false, change: "only the description's first sentence" },
    { prefilter: "tfidf", k: 60, form: "full", spec: false, change: "squared IDF, against the 183 same-shaped agents" },
    { prefilter: "overlap", k: 120, form: "full", spec: false, change: "plain overlap again, twice the budget" },
    { prefilter: "overlap", k: 260, form: "full", spec: false, change: "the most that fits in one full-form request" },
    { prefilter: "none", k: ALL.length, form: "full", spec: false, change: "no prefilter at all: the whole roster, full form" },
    { prefilter: "none", k: ALL.length, form: "terse", spec: false, change: "criteria paid for once: the roster in 1 request (§7)" },
    { prefilter: "none", k: ALL.length, form: "terse", spec: true, change: "and subtract each skill's prior (§6)" },
    { prefilter: "overlap", k: 60, form: "terse", spec: true, change: "prefilter back on top of that" },
  ];
  const evaluateWith = (
    xs: Row[],
    filter: Prefilter,
    k: number,
    spec: boolean,
  ): { recall: number; ap: number; p12: number; worst: number } => {
    if (!spec) return filter === "none" ? evaluate(xs, "none", ALL.length) : evaluate(xs, filter, k);
    const aps: number[] = [];
    const p12s: number[] = [];
    const worsts: number[] = [];
    for (const p of PROJECTS) {
      const cs = CANDS.get(p.id)!;
      const keep = filter === "none" ? undefined : new Set(keepTop(prescore(filter, cs, p), cs, k).map((c) => c.name));
      const prior = specificity(xs, p.id);
      const scored = scoredFor(xs, p.id, keep).map((x) => ({ ...x, value: prior.get(x.skill) ?? x.value }));
      if (scored.filter((x) => x.positive).length === 0) continue;
      aps.push(averagePrecision(scored));
      p12s.push(precisionAtK(scored, 12));
      worsts.push(worstPositiveRank(scored));
    }
    return {
      recall: filter === "none" ? 1 : recallAt(filter, k),
      ap: meanOf(aps),
      p12: meanOf(p12s),
      worst: meanOf(worsts),
    };
  };
  /** Measured, not estimated: the mean request cost of the arm that produced it. */
  const perQuestion = (xs: Row[]): number => {
    const reqs = [...new Map(xs.map((r) => [r.requestId, r])).values()];
    return reqs.reduce((a, r) => a + r.requestInputTokens, 0) / xs.length;
  };
  const cost = { full: perQuestion(full), terse: terse.length > 0 ? perQuestion(terse) : Number.NaN };
  const ledger: LedgerRow[] = configs
    .filter((c) => c.form === "full" || terse.length > 0)
    .map((c, i) => {
      const xs = c.form === "terse" ? terse : full;
      const e = evaluateWith(xs, c.prefilter, c.k, c.spec);
      const tokens = Math.round(cost[c.form] * c.k);
      return {
        iteration: i + 1,
        prefilter: c.prefilter,
        k: c.k,
        form: c.form,
        specificity: c.spec,
        change: c.change,
        recall: Number(num(e.recall, 4)),
        ap: Number(num(e.ap, 4)),
        p12: Number(num(e.p12, 4)),
        worst: Number(num(e.worst, 2)),
        // The full form holds 260 questions and the terse one 520 (§1).
        requestsPerProject: Math.ceil(c.k / (c.form === "terse" ? 520 : 260)),
        tokensPerProject: tokens,
        dollarsPerProject: Number(((tokens / 1e6) * 0.042).toFixed(5)),
      };
    });
  writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
  console.log(
    `  ${pad("#", 3)} ${pad("config", 24)} ${pad("recall", 7)} ${pad("AP", 6)} ${pad("P@12", 6)} ` +
      `${pad("reqs", 5)} ${pad("$/proj", 8)} what changed`,
  );
  for (const r of ledger) {
    const name = `${r.prefilter}@${r.k}${r.form === "terse" ? " terse" : ""}${r.specificity ? "+prior" : ""}`;
    console.log(
      `  ${pad(String(r.iteration), 3)} ${pad(name, 24)} ${pad(pct(r.recall), 7)} ${pad(num(r.ap), 6)} ` +
        `${pad(num(r.p12), 6)} ${pad(String(r.requestsPerProject), 5)} ` +
        `${pad(`$${r.dollarsPerProject.toFixed(4)}`, 8)} ${r.change}`,
    );
  }
  console.log("");
  const best = [...ledger].sort((a, b) => b.p12 - a.p12 || a.tokensPerProject - b.tokensPerProject)[0];
  const label = (r: LedgerRow) => `${r.prefilter}@${r.k}${r.form === "terse" ? " terse" : ""}${r.specificity ? "+prior" : ""}`;
  console.log(`  best P@12: ${label(best)} at ${num(best.p12)} for $${best.dollarsPerProject.toFixed(4)} a project`);
  const cheapest = [...ledger]
    .filter((r) => r.p12 >= best.p12 - 0.02)
    .sort((a, b) => a.tokensPerProject - b.tokensPerProject)[0];
  console.log(`  cheapest within 0.02 of it: ${label(cheapest)} at $${cheapest.dollarsPerProject.toFixed(4)}`);
  console.log("  -> records/ledger.json");
  console.log("");
  console.log("  Every row is measured from the same recorded judgments, and the token cost of each is the");
  console.log("  measured mean of the arm that produced it -- not an estimate. What an iteration changes is");
  console.log("  one thing, so a row that does not move says that thing did not matter.");
  console.log("");
  console.log("  Read P@12, not AP. AP here is computed over the SURVIVORS, so a prefilter that throws away");
  console.log("  most of the positives can still rank the two it kept perfectly -- which is why `random@60`");
  console.log("  shows AP 0.39 and P@12 0.08. P@12 asks what is actually in the twelve rows a user reads.");
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

async function measureCeiling(): Promise<void> {
  const jev = new Jev({ retries: 0 });
  const project = PROJECTS[0];
  const rows: CeilingRow[] = [];
  const plan: [number, "full" | "terse"][] = [
    [120, "full"], [200, "full"], [240, "full"], [260, "full"], [280, "full"], [300, "full"],
    [ALL.length, "full"],
    // The same ladder with the criteria paid for once (§8): the question is
    // whether the roster fits at all, not whether the estimate was right.
    [ALL.length, "terse"], [520, "terse"], [560, "terse"],
  ];
  for (const [n, form] of plan) {
    const terse = form === "terse";
    // Above the roster's size the extra questions are the roster again, so
    // the ladder can go past 461 without inventing entries.
    const group = Array.from({ length: n }, (_, i) => {
      const base = ALL[i % ALL.length];
      // Past the roster's size the ladder repeats it, and a repeat needs a
      // distinct question key. Below it the names are untouched.
      return i < ALL.length ? base : { ...base, name: `${base.name}__${Math.floor(i / ALL.length)}` };
    });
    try {
      const res = await jev.ask(stateFor(project, terse), questionsFor(group, terse));
      rows.push({ questions: n, form, ok: true, inputTokens: res.usage.input_tokens, detail: "" });
      console.log(`  ${form} ${n} -> OK (${res.usage.input_tokens} tokens)`);
    } catch (err) {
      const detail = String(err).replace(/^Error: /, "").slice(0, 80);
      rows.push({ questions: n, form, ok: false, inputTokens: 0, detail });
      console.log(`  ${form} ${n} -> ${detail}`);
    }
  }
  writeFileSync(CEILING, `${JSON.stringify(rows, null, 2)}\n`);
}

async function collect(arm: Arm): Promise<Row[]> {
  const jev = new Jev();
  const jobs: (() => Promise<Row[]>)[] = [];
  for (const p of PROJECTS) {
    const cs = CANDS.get(p.id)!;
    const target = arm === "narrow" ? keepTop(prescore("overlap", cs, p), cs, 60) : cs;
    const terse = arm === "terse";
    chunk(target, arm === "narrow" ? target.length : PER_REQUEST).forEach((group, i) => {
      const id = `${arm}:${p.id}:${i}`;
      jobs.push(async () => {
        const started = Date.now();
        const res = await jev.ask(stateFor(p, terse), questionsFor(group, terse));
        const ms = Date.now() - started;
        return group.map((c) => {
          const a = score(res.answers[keyFor(c.name)]);
          return {
            project: p.id,
            arm,
            name: c.name,
            value: a.score,
            confidence: a.confidence,
            requestId: id,
            requestMs: ms,
            requestInputTokens: res.usage.input_tokens,
            batchSize: group.length,
          };
        });
      });
    });
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
  const rows = results.flat();
  const all = [...readRecord().filter((r) => r.arm !== arm), ...rows];
  writeFileSync(RECORD, dehydrate(all));
  console.log(
    `  ${jev.calls} calls, ${jev.inputTokens} input tokens, $${((jev.inputTokens / 1e6) * 0.042).toFixed(4)}, ` +
      `${Math.round(jev.totalMs / jev.calls)} ms mean` + (jev.retriedCalls > 0 ? `, ${jev.retriedCalls} retried` : ""),
  );
  return all;
}

async function main(): Promise<void> {
  console.log("=".repeat(104));
  console.log("  SELECTING FROM A 461-SKILL ROSTER: WHAT FITS, AND WHAT A PREFILTER BUYS (docs/30)");
  rule();
  let rows: Row[] = readRecord();
  if (flag("ceiling")) await measureCeiling();
  if (ARGS.includes("--arm")) {
    for (const arm of opt("arm", "full").split(",")) {
      if (arm !== "full" && arm !== "narrow" && arm !== "terse") throw new Error(`unknown arm ${arm}`);
      rows = await collect(arm);
    }
  }
  sectionRoster();
  rule();
  sectionCeiling();
  rule();
  sectionPrefilters();
  if (rows.length > 0) {
    rule();
    sectionEndToEnd(rows);
    rule();
    sectionWidthCheck(rows);
    rule();
    sectionDistractors(rows);
    rule();
    sectionSpecificity(rows);
    rule();
    sectionTerse(rows);
    rule();
    sectionLedger(rows);
    rule();
    sectionReal();
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
