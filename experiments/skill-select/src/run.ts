/**
 * docs/29 -- picking skills out of a catalog that does not fit in context.
 *
 *   npx tsx src/run.ts --replay              # re-derive every table, no API key
 *   npx tsx src/run.ts --arm fanout          # ask Jev: 14 requests, 74 questions each
 *   npx tsx src/run.ts --arm solo,single     # 1,036 requests each, the width controls
 *   npx tsx src/run.ts --repeat 3 --arm fanout --concurrency 8
 *
 * The corpus is mizchi's real curated catalog and the labels are its own tier
 * legend; `catalog.ts` says how, `projects.ts` says what the label rule is.
 * Nothing in this file decides what the right answer is.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Jev, noul, score } from "../../shared/jev.js";
import { advise, crossValidate, mean, place, sd, separation, type Sample } from "../../shared/thresholds.js";
import {
  ARM_BLURB,
  ARMS,
  NEEDED,
  WIDTH,
  batches,
  keyFor,
  questionFor,
  singleQuestion,
  stateFor,
  type ArmName,
} from "./arms.js";
import { loadSnapshot } from "./catalog.js";
import { averagePrecision, meanOf, precisionAtK, recallAtK, worstPositiveRank, type Scored } from "./metrics.js";
import { PROJECTS, candidates, projectText, type Candidate, type Label, type Project } from "./projects.js";
import { deciderFor, fileShapedSections, routeFor, type Decider, type Route } from "./route.js";
import { ruleScores } from "./rules.js";

const HERE = import.meta.dirname;
const RECORD = resolve(HERE, "../records/select.json");

const ARGS = process.argv.slice(2);
const flag = (n: string) => ARGS.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = ARGS.indexOf(`--${n}`);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d;
};

/** Requests in flight. The width-1 arms make 1,036 requests; one at a time is ten minutes. */
const CONCURRENCY = Number(opt("concurrency", "6"));

interface Row {
  project: string;
  arm: ArmName;
  skill: string;
  repeat: number;
  /** A score 0-3, or a noul probability 0-1. */
  value: number;
  /** 0 for a noul, which has none. */
  confidence: number;
  /** Shared by every row of one request, so totals can dedupe on it. */
  requestId: string;
  requestMs: number;
  requestInputTokens: number;
  batchSize: number;
}

const pad = (s: string, n: number) => s.padEnd(n);
const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "  - ");
const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : "  - ");
const rule = (n = 104) => console.log("-".repeat(n));

// ------------------------------------------------------------------ the corpus

const SNAPSHOT = loadSnapshot(resolve(HERE, ".."));

/** Candidates are the same list for every project; only labels move. */
const CANDIDATES = new Map<string, Candidate[]>();
for (const p of PROJECTS) CANDIDATES.set(p.id, candidates(SNAPSHOT, p));
const SKILLS = CANDIDATES.get(PROJECTS[0].id)!.map((c) => c.skill);

const labelOf = (project: string, skill: string): Label =>
  CANDIDATES.get(project)!.find((c) => c.skill === skill)?.label ?? "no";

/**
 * `want` is positive, `no` is negative, and `mention` is NEITHER.
 *
 * A T3 row is a skill the catalog says to name in prose and keep out of the
 * proposal. Counting it as a positive would punish a selector for obeying;
 * counting it as a negative would punish one for noticing. It is dropped
 * from the ranking metrics and reported on its own (§6).
 */
function scoredFor(rows: Row[], project: string, opts: { dropPolicy?: boolean } = {}): Scored[] {
  const byProject = rows.filter((r) => r.project === project);
  const out: Scored[] = [];
  for (const skill of SKILLS) {
    const label = labelOf(project, skill);
    if (label === "mention") continue;
    if (opts.dropPolicy && POLICY.has(skill)) continue;
    const mine = byProject.filter((r) => r.skill === skill);
    if (mine.length === 0) continue;
    out.push({ skill, value: meanOf(mine.map((r) => r.value)), positive: label === "want" });
  }
  return out;
}

/**
 * The T0 rows: "always want, whatever the project is".
 *
 * These are a POLICY, and nothing in a skill's own description says it is
 * one. There are two of them and they are `want` in all fourteen projects,
 * so they are 28 of the 135 positives -- enough to move every number here.
 * Every table reports the metric twice: with them, which is the task as
 * stated, and without, which is the part a judgment could possibly get
 * right. docs/29 §3.
 */
const POLICY = new Set(
  SNAPSHOT.rows.filter((r) => r.tier === "T0" && r.description).map((r) => r.skill),
);

/** Which sections declare filename signals; see `route.ts`. */
const FILE_SHAPED = fileShapedSections(SNAPSHOT);
const routeOf = (skill: string): Route => routeFor(SNAPSHOT, FILE_SHAPED, skill);
const deciderOf = (project: Project, skill: string): Decider | null =>
  deciderFor(SNAPSHOT, FILE_SHAPED, project, skill);

// -------------------------------------------------------------------- sections

function sectionCorpus(): void {
  console.log("\n  0. THE CORPUS (mizchi/skills, catalog.md)\n");
  const sections = new Set(SNAPSHOT.rows.map((r) => r.section));
  const readable = SNAPSHOT.rows.filter((r) => r.description);
  const tiers = new Map<string, number>();
  for (const r of readable) tiers.set(r.tier, (tiers.get(r.tier) ?? 0) + 1);
  const chars = readable.reduce((a, r) => a + r.description.length, 0);
  console.log(`  ${SNAPSHOT.rows.length} catalog rows in ${sections.size} sections, ${readable.length} with a readable SKILL.md`);
  console.log(`  candidates after merging duplicate rows: ${SKILLS.length} skills`);
  console.log(`  tiers among the candidates: ${[...tiers].sort().map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`  descriptions: ${chars} chars, about ${Math.round(chars / 2.4)} tokens -- the whole catalog at once`);
  console.log(`  unresolved rows (no public SKILL.md): ${SNAPSHOT.unresolved.length}`);
  console.log(`  read at ${Object.entries(SNAPSHOT.revs).map(([r, v]) => `${r}@${v.slice(0, 7)}`).join(", ")}`);
  console.log("");
  console.log(`  ${pad("project", 16)} ${pad("want", 5)} ${pad("mention", 8)} ${pad("no", 4)}  wanted skills`);
  for (const p of PROJECTS) {
    const cs = CANDIDATES.get(p.id)!;
    const want = cs.filter((c) => c.label === "want");
    const mention = cs.filter((c) => c.label === "mention").length;
    const no = cs.filter((c) => c.label === "no").length;
    const names = want.map((c) => c.skill).join(" ");
    console.log(`  ${pad(p.id, 16)} ${pad(String(want.length), 5)} ${pad(String(mention), 8)} ${pad(String(no), 4)}  ${names.slice(0, 62)}`);
  }
  const totalWant = PROJECTS.reduce((a, p) => a + CANDIDATES.get(p.id)!.filter((c) => c.label === "want").length, 0);
  console.log("");
  console.log(`  ${PROJECTS.length} projects x ${SKILLS.length} skills = ${PROJECTS.length * SKILLS.length} judgments per arm,`);
  console.log(`  ${totalWant} of them labelled want (${pct(totalWant / (PROJECTS.length * SKILLS.length))} of the pairs)`);
}

function ruleRows(): Row[] {
  const out: Row[] = [];
  for (const p of PROJECTS) {
    for (const s of ruleScores(CANDIDATES.get(p.id)!, p)) {
      out.push({
        project: p.id,
        arm: "fanout",
        skill: s.skill,
        repeat: 0,
        value: s.score,
        confidence: 0,
        requestId: "rules",
        requestMs: 0,
        requestInputTokens: 0,
        batchSize: 0,
      });
    }
  }
  return out;
}

function report(rows: Row[], opts: { dropPolicy?: boolean } = {}): { map: number; pk: number; worst: number } {
  const maps: number[] = [];
  const pks: number[] = [];
  const worsts: number[] = [];
  for (const p of PROJECTS) {
    const scored = scoredFor(rows, p.id, opts);
    if (scored.filter((s) => s.positive).length === 0) continue;
    maps.push(averagePrecision(scored));
    pks.push(precisionAtK(scored));
    worsts.push(worstPositiveRank(scored));
  }
  return { map: meanOf(maps), pk: meanOf(pks), worst: meanOf(worsts) };
}

function sectionRules(): void {
  console.log("\n  1. THE FREE BASELINE (IDF-weighted overlap, no API)\n");
  const rows = ruleRows();
  console.log(`  ${pad("project", 16)} ${pad("AP", 6)} ${pad("P@k", 6)} ${pad("worst", 6)}  top 5 by overlap`);
  for (const p of PROJECTS) {
    const scored = scoredFor(rows, p.id);
    const top = [...scored].sort((a, b) => b.value - a.value).slice(0, 5);
    const marks = top.map((t) => `${t.positive ? "+" : "-"}${t.skill}`).join(" ");
    console.log(
      `  ${pad(p.id, 16)} ${pad(num(averagePrecision(scored)), 6)} ${pad(num(precisionAtK(scored)), 6)} ` +
        `${pad(num(worstPositiveRank(scored), 0), 6)}  ${marks.slice(0, 58)}`,
    );
  }
  const r = report(rows);
  const rp = report(rows, { dropPolicy: true });
  console.log("");
  console.log(`  mean AP ${num(r.map)}, mean P@k ${num(r.pk)}, mean worst-positive rank ${num(r.worst, 1)} of ${SKILLS.length}`);
  console.log(`  without the two always-on skills: AP ${num(rp.map)}, P@k ${num(rp.pk)}, worst ${num(rp.worst, 1)}`);
  const ties = PROJECTS.map((p) => scoredFor(rows, p.id).filter((s) => s.value === 0).length);
  console.log(`  skills the overlap cannot separate at all (score 0): ${Math.min(...ties)}-${Math.max(...ties)} per project`);
  // The named failure: a skill whose name IS the signal.
  for (const p of PROJECTS.filter((x) => x.files.includes("justfile"))) {
    const all = rows
      .filter((x) => x.project === p.id)
      .map((x) => ({ skill: x.skill, value: x.value }))
      .sort((a, b) => b.value - a.value);
    const rank = all.findIndex((s) => s.skill === "justfile") + 1;
    console.log(`  \`justfile\` in ${p.id}: overlap ranks it ${rank || "-"} of ${all.length}; the catalog says mention, not want`);
  }
}

function sectionArms(rows: Row[]): void {
  console.log("\n  2. THE ARMS\n");
  console.log("  AP / P@k / worst-positive rank, first over every pair, then with the two T0 policy rows dropped.\n");
  console.log(
    `  ${pad("arm", 9)} ${pad("width", 6)} ${pad("AP", 6)} ${pad("P@k", 6)} ${pad("worst", 6)} | ` +
      `${pad("AP-", 6)} ${pad("P@k-", 6)} ${pad("worst-", 7)} | ` +
      `${pad("reqs", 5)} ${pad("tok/proj", 9)} ${pad("ms/req", 7)} ${pad("$", 8)}`,
  );
  const line = (
    name: string,
    width: string,
    r: ReturnType<typeof report>,
    rp: ReturnType<typeof report>,
    reqs: number,
    tokens: number,
    ms: number,
    dollars: number,
  ) =>
    console.log(
      `  ${pad(name, 9)} ${pad(width, 6)} ${pad(num(r.map), 6)} ${pad(num(r.pk), 6)} ${pad(num(r.worst, 1), 6)} | ` +
        `${pad(num(rp.map), 6)} ${pad(num(rp.pk), 6)} ${pad(num(rp.worst, 1), 7)} | ` +
        `${pad(String(reqs), 5)} ${pad(String(Math.round(tokens)), 9)} ${pad(num(ms, 0), 7)} ${pad(`$${dollars.toFixed(4)}`, 8)}`,
    );
  const base = ruleRows();
  line("rules", "-", report(base), report(base, { dropPolicy: true }), 0, 0, 0, 0);
  for (const arm of ARMS) {
    const mine = rows.filter((r) => r.arm === arm);
    if (mine.length === 0) continue;
    const requests = new Map<string, Row>();
    for (const row of mine) if (!requests.has(row.requestId)) requests.set(row.requestId, row);
    const reqs = [...requests.values()];
    const repeats = new Set(mine.map((x) => x.repeat)).size;
    const total = reqs.reduce((a, x) => a + x.requestInputTokens, 0);
    line(
      arm,
      Number.isFinite(WIDTH[arm]) ? String(WIDTH[arm]) : "all",
      report(mine),
      report(mine, { dropPolicy: true }),
      reqs.length,
      total / (PROJECTS.length * repeats),
      meanOf(reqs.map((x) => x.requestMs)),
      (total / 1e6) * 0.042,
    );
  }
  console.log("");
  for (const arm of ARMS) console.log(`    ${pad(arm, 9)} ${ARM_BLURB[arm]}`);
  console.log(`\n    the policy rows: ${[...POLICY].join(", ")} -- T0, "always want", in all ${PROJECTS.length} projects`);
}

function sectionWidth(rows: Row[]): void {
  const have = ARMS.filter((a) => rows.some((r) => r.arm === a));
  const widths = ["applies", "batch10", "solo", "single"].filter((a) => have.includes(a as ArmName)) as ArmName[];
  if (widths.length < 2) return;
  console.log("\n  3. FAN-OUT WIDTH: the same question, asked in wider and wider requests\n");
  for (const w of widths) {
    const mine = rows.filter((r) => r.arm === w);
    const r = report(mine, { dropPolicy: true });
    const reqs = new Set(mine.map((x) => x.requestId)).size;
    const tok = [...new Map(mine.map((x) => [x.requestId, x])).values()].reduce((a, x) => a + x.requestInputTokens, 0);
    console.log(
      `  ${pad(w, 9)} ${pad(`${Number.isFinite(WIDTH[w]) ? WIDTH[w] : SKILLS.length} q/request`, 16)} ` +
        `AP- ${num(r.map)}  ${pad(String(reqs), 5)} requests  ${pad(String(tok), 7)} input tokens`,
    );
  }
  // The number that matters is not the metric, it is whether the ANSWERS
  // moved. A per-pair comparison says that directly.
  console.log("");
  const at = (arm: ArmName) => new Map(rows.filter((r) => r.arm === arm).map((r) => [`${r.project}/${r.skill}`, r.value]));
  const reference = widths[0];
  const ref = at(reference);
  console.log(`  every pair against the widest arm (${reference}, ${SKILLS.length} questions in one request):`);
  console.log(`  ${pad("arm", 9)} ${pad("n", 6)} ${pad("same level", 11)} ${pad("within 0.25", 12)} mean |diff|`);
  for (const w of widths) {
    const mine = at(w);
    let n = 0;
    let same = 0;
    let near = 0;
    let total = 0;
    for (const [k, v] of ref) {
      const other = mine.get(k);
      if (other === undefined) continue;
      n += 1;
      total += Math.abs(v - other);
      if (Math.round(v) === Math.round(other)) same += 1;
      if (Math.abs(v - other) < 0.25) near += 1;
    }
    if (n === 0) continue;
    console.log(
      `  ${pad(w, 9)} ${pad(String(n), 6)} ${pad(pct(same / n), 11)} ${pad(pct(near / n), 12)} ${num(total / n, 3)}`,
    );
  }
  console.log("");
  console.log("  `solo` and `single` are both one question per request; they differ only in whether the");
  console.log("  skill rides in the question or in the state. That pair separates width from placement.");
}

function sectionCutoff(rows: Row[]): void {
  const arm = (opt("cutoff-arm", "applies") as ArmName);
  const mine = rows.filter((r) => r.arm === arm);
  if (mine.length === 0) return;
  console.log(`\n  4. ONE CUTOFF ACROSS EVERY PROJECT (arm: ${arm})\n`);
  const samples: Sample[] = [];
  for (const p of PROJECTS) {
    for (const s of scoredFor(mine, p.id)) samples.push({ value: s.value, positive: s.positive, group: p.id });
  }
  const sep = separation(samples);
  const a = advise(samples);
  const pos = samples.filter((s) => s.positive).map((s) => s.value);
  const neg = samples.filter((s) => !s.positive).map((s) => s.value);
  console.log(`  ${samples.length} pairs, ${sep.pos} of them want`);
  console.log(`  want ${num(mean(pos))} +/- ${num(sd(pos))}, no ${num(mean(neg))} +/- ${num(sd(neg))}`);
  console.log(`  AUC ${num(sep.auc, 3)}, gap ${num(sep.gap)}, verdict: ${a.verdict} -- ${a.reason}`);
  console.log("");
  console.log(`  ${pad("placement", 22)} ${pad("at", 6)} ${pad("in-sample", 26)} held out by project`);
  for (const placement of [
    { rule: "auto", margin: 0.05, range: 3, wide: 0.2 },
    { rule: "boundary", margin: 0.05 },
    { rule: "midgap" },
    { rule: "youden" },
    { rule: "quantile", q: 0.9 },
  ] as const) {
    const cv = crossValidate(samples, placement, { folds: 5 });
    const at = place(samples, placement);
    const f = (c: typeof cv.inSample) => `tp ${c.tp} fp ${c.fp} fn ${c.fn} P ${pct(c.precision)} R ${pct(c.recall)}`;
    console.log(`  ${pad(cv.placement, 22)} ${pad(num(at.at), 6)} ${pad(f(cv.inSample), 26)} ${f(cv.heldOut)}`);
  }
  console.log("");
  console.log("  Held out by PROJECT: the cutoff is fitted on four projects' pairs and scored on the fifth,");
  console.log("  which is the only version of this number a tool could rely on for a project it has not seen.");
}

function sectionCuration(rows: Row[]): void {
  const a = rows.filter((r) => r.arm === "applies");
  const b = rows.filter((r) => r.arm === "usewhen");
  if (a.length === 0 || b.length === 0) return;
  console.log("\n  5. WHAT THE CURATION IS WORTH (own description vs the catalog's `Use when`)\n");
  console.log(`  ${pad("project", 16)} ${pad("own", 7)} ${pad("curated", 8)} delta   (AP, policy rows dropped)`);
  for (const p of PROJECTS) {
    const x = averagePrecision(scoredFor(a, p.id, { dropPolicy: true }));
    const y = averagePrecision(scoredFor(b, p.id, { dropPolicy: true }));
    const d = y - x;
    console.log(`  ${pad(p.id, 16)} ${pad(num(x), 7)} ${pad(num(y), 8)} ${d >= 0 ? "+" : ""}${num(d)}`);
  }
  const ra = report(a, { dropPolicy: true });
  const rb = report(b, { dropPolicy: true });
  console.log("");
  console.log(`  mean AP ${num(ra.map)} -> ${num(rb.map)}; mean worst rank ${num(ra.worst, 1)} -> ${num(rb.worst, 1)}`);
  const chars = (pick: (c: Candidate) => string) =>
    CANDIDATES.get(PROJECTS[0].id)!.reduce((sum, c) => sum + pick(c).length, 0);
  console.log(
    `  the two texts are ${chars((c) => c.description)} chars (own) against ` +
      `${chars((c) => c.rows.map((r) => r.useWhen).join(" / "))} chars (curated)`,
  );
}

function sectionDisagreements(rows: Row[]): void {
  const arm = (opt("read-arm", "applies") as ArmName);
  const mine = rows.filter((r) => r.arm === arm);
  if (mine.length === 0) return;
  console.log(`\n  6. WHERE IT DISAGREES WITH THE CATALOG (arm: ${arm})\n`);
  // The `youden` cutoff, because that is the operating point a tool would
  // actually pick: `auto` lands above every answer here (§4) and flagging
  // nothing has nothing to read.
  const at = place(
    PROJECTS.flatMap((p) => scoredFor(mine, p.id).map((s) => ({ value: s.value, positive: s.positive, group: p.id }))),
    { rule: "youden" },
  );
  // Grouped by SKILL, because the interesting question is whether a
  // disagreement is systematic. A row missed in ten projects is the label's
  // shape; a row missed in one is worth reading.
  const misses = new Map<string, number[]>();
  const extras = new Map<string, number[]>();
  for (const p of PROJECTS) {
    for (const s of scoredFor(mine, p.id)) {
      const bucket = s.positive ? misses : extras;
      const fires = s.value >= at.at;
      if (s.positive === fires) continue;
      bucket.set(s.skill, [...(bucket.get(s.skill) ?? []), s.value]);
    }
  }
  const tierOf = (skill: string) =>
    [...new Set(SNAPSHOT.rows.filter((r) => r.skill === skill).map((r) => r.tier))].sort().join("/");
  const show = (title: string, m: Map<string, number[]>, total: number) => {
    console.log(`  ${total} ${title}, by skill:`);
    const sorted = [...m].sort((a, b) => b[1].length - a[1].length);
    for (const [skill, values] of sorted) {
      console.log(
        `     ${pad(skill, 32)} ${pad(tierOf(skill), 6)} ${pad(`${values.length} project(s)`, 13)} mean ${num(mean(values))}`,
      );
    }
  };
  const missCount = [...misses.values()].reduce((a, v) => a + v.length, 0);
  const extraCount = [...extras.values()].reduce((a, v) => a + v.length, 0);
  console.log(`  cutoff ${num(at.at)} (${at.why})`);
  show("wanted skills below it", misses, missCount);
  console.log("");
  show("unwanted skills at or above it", extras, extraCount);
  console.log("");
  // And the T3 class, which is in neither set.
  const t3: string[] = [];
  for (const p of PROJECTS) {
    for (const c of CANDIDATES.get(p.id)!.filter((x) => x.label === "mention")) {
      const v = meanOf(mine.filter((r) => r.project === p.id && r.skill === c.skill).map((r) => r.value));
      if (Number.isFinite(v)) t3.push(`${p.id}/${c.skill} ${num(v)}${v >= at.at ? " <- above the cutoff" : ""}`);
    }
  }
  console.log(`  the ${t3.length} \`mention\` pairs, which are in neither the positives nor the negatives:`);
  for (const t of t3) console.log(`     ${t}`);
}

/**
 * What DECIDES each label, and which selector wins there.
 *
 * The label rule is not one rule, it is three, and they take their evidence
 * from different places:
 *
 *   policy    a T0 row. Nothing in the project decides it and nothing in the
 *             description says it is one.
 *   files     a T1 row whose section declares FILE signals. A `wrangler.toml`
 *             in the tree settles it; no judgment is needed and a grep wins.
 *   ask       a T2 row, or a T1 row in a section whose signals are an
 *             activity rather than a file. Only the request text decides it.
 *
 * Splitting the positives this way needs no new labels and no new requests --
 * it is a regrouping of the rows already recorded -- and it says where each
 * kind of selector belongs.
 */
function sectionDecomposed(rows: Row[]): void {
  console.log("\n  7. WHAT DECIDES THE LABEL, AND WHICH SELECTOR IS RIGHT THERE\n");
  const arms: { name: string; rows: Row[] }[] = [
    { name: "rules", rows: ruleRows() },
    ...ARMS.filter((a) => rows.some((r) => r.arm === a)).map((a) => ({ name: a as string, rows: rows.filter((r) => r.arm === a) })),
  ];
  const deciders: Decider[] = ["policy", "files", "ask"];
  const counts = new Map<Decider, number>();
  for (const p of PROJECTS) {
    for (const c of CANDIDATES.get(p.id)!) {
      if (c.label !== "want") continue;
      const d = deciderOf(p, c.skill);
      if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  console.log(`  positives by decider: ${deciders.map((d) => `${d} ${counts.get(d) ?? 0}`).join(", ")}`);
  console.log("");
  console.log("  mean rank of the positives of each kind, out of 74 (lower is better):");
  console.log(`  ${pad("arm", 9)} ${deciders.map((d) => pad(d, 9)).join(" ")}`);
  for (const arm of arms) {
    const ranks = new Map<Decider, number[]>();
    for (const p of PROJECTS) {
      const scored = [...scoredFor(arm.rows, p.id)].sort(
        (a, b) => b.value - a.value || Number(a.positive) - Number(b.positive),
      );
      scored.forEach((s, i) => {
        if (!s.positive) return;
        const d = deciderOf(p, s.skill);
        if (!d) return;
        ranks.set(d, [...(ranks.get(d) ?? []), i + 1]);
      });
    }
    console.log(`  ${pad(arm.name, 9)} ${deciders.map((d) => pad(num(meanOf(ranks.get(d) ?? []), 1), 9)).join(" ")}`);
  }
  console.log("");
  console.log("  `policy` is a T0 row: no description says it is always wanted, so no selector can place it.");
  console.log("  `files` is settled by a filename in the tree, which is a grep.");
  console.log("  `ask` is settled only by the request text, which is not.");
}

/**
 * The selector §7 implies: blend the grep with the judgment.
 *
 * Both selectors are turned into a per-project RANK first, because their
 * scales have nothing to do with each other -- an IDF sum against a 0-3
 * score -- and a rank is the part that is comparable. The blend weight is
 * then one number, fitted on four projects' pairs and scored on the fifth,
 * so what it reports is what a tool would get on a project it has not seen.
 *
 * `mention` rows stay out, as everywhere else, and the T0 policy rows stay
 * IN: a real tool has to place them somehow, and §7 says neither selector
 * can, so leaving them out here would flatter the blend.
 */
function normalisedRanks(scored: Scored[]): Map<string, number> {
  const sorted = [...scored].sort((a, b) => b.value - a.value || Number(a.positive) - Number(b.positive));
  const out = new Map<string, number>();
  const n = sorted.length;
  sorted.forEach((s, i) => out.set(s.skill, n <= 1 ? 1 : 1 - i / (n - 1)));
  return out;
}

function blendAt(alpha: number, rulesRows: Row[], jevRows: Row[], project: string): Scored[] {
  const base = scoredFor(rulesRows, project);
  const a = normalisedRanks(base);
  const b = normalisedRanks(scoredFor(jevRows, project));
  return base.map((s) => ({
    skill: s.skill,
    positive: s.positive,
    value: alpha * (a.get(s.skill) ?? 0) + (1 - alpha) * (b.get(s.skill) ?? 0),
  }));
}

function sectionBlend(rows: Row[]): void {
  const arm = (opt("blend-arm", "fanout") as ArmName);
  const jevRows = rows.filter((r) => r.arm === arm);
  if (jevRows.length === 0) return;
  const rulesRows = ruleRows();
  console.log(`\n  8. THE SELECTOR §7 IMPLIES: rank-blend the grep with the judgment (arm: ${arm})\n`);
  const alphas = Array.from({ length: 21 }, (_, i) => i / 20);
  const apAt = (alpha: number, projects: string[]) =>
    meanOf(projects.map((p) => averagePrecision(blendAt(alpha, rulesRows, jevRows, p))));

  console.log(`  ${pad("alpha", 7)} ${pad("AP", 6)}   (1.00 = the grep alone, 0.00 = the judgment alone)`);
  const all = PROJECTS.map((p) => p.id);
  for (const alpha of alphas) {
    if (Math.round(alpha * 20) % 4 !== 0) continue;
    console.log(`  ${pad(num(alpha), 7)} ${pad(num(apAt(alpha, all)), 6)}`);
  }
  const best = alphas.reduce((a, b) => (apAt(b, all) > apAt(a, all) ? b : a), alphas[0]);
  console.log(`  best in sample: alpha ${num(best)}, AP ${num(apAt(best, all))}`);
  console.log("");

  // Held out by project: one project out, fit on the rest, score on it.
  const heldApAll: number[] = [];
  const picks: number[] = [];
  console.log(`  ${pad("held-out project", 18)} ${pad("fitted alpha", 13)} ${pad("AP there", 9)} ${pad("grep", 6)} ${pad("jev", 6)}`);
  for (const p of PROJECTS) {
    const train = all.filter((x) => x !== p.id);
    const pick = alphas.reduce((a, b) => (apAt(b, train) > apAt(a, train) ? b : a), alphas[0]);
    const got = averagePrecision(blendAt(pick, rulesRows, jevRows, p.id));
    heldApAll.push(got);
    picks.push(pick);
    console.log(
      `  ${pad(p.id, 18)} ${pad(num(pick), 13)} ${pad(num(got), 9)} ` +
        `${pad(num(averagePrecision(scoredFor(rulesRows, p.id))), 6)} ${pad(num(averagePrecision(scoredFor(jevRows, p.id))), 6)}`,
    );
  }
  console.log("");
  console.log(
    `  held out: AP ${num(meanOf(heldApAll))} against ${num(report(rulesRows).map)} for the grep alone ` +
      `and ${num(report(jevRows).map)} for the judgment alone`,
  );
  console.log(`  the fitted weight moved between ${num(Math.min(...picks))} and ${num(Math.max(...picks))} across the folds`);

  // The routed version, which fits nothing at all.
  console.log("");
  console.log("  ROUTED instead of blended: the route comes from the CATALOG, not from the labels --");
  console.log("  a T0 row is policy, a T1 row in a file-shaped section is a grep, everything else is a");
  console.log("  judgment. That is decidable when the tool is built, so there is no weight to fit.");
  console.log("");
  console.log(`  ${pad("project", 18)} ${pad("grep", 6)} ${pad("jev", 6)} ${pad("routed", 7)} ${pad("P@k", 6)} worst`);
  const routedAll: number[] = [];
  const routedPk: number[] = [];
  const routedWorst: number[] = [];
  for (const p of PROJECTS) {
    const r = routed(rulesRows, jevRows, p.id);
    routedAll.push(averagePrecision(r));
    routedPk.push(precisionAtK(r));
    routedWorst.push(worstPositiveRank(r));
    console.log(
      `  ${pad(p.id, 18)} ${pad(num(averagePrecision(scoredFor(rulesRows, p.id))), 6)} ` +
        `${pad(num(averagePrecision(scoredFor(jevRows, p.id))), 6)} ${pad(num(averagePrecision(r)), 7)} ` +
        `${pad(num(precisionAtK(r)), 6)} ${num(worstPositiveRank(r), 0)}`,
    );
  }
  const g = report(rulesRows);
  const j = report(jevRows);
  console.log("");
  console.log(
    `  mean AP: grep ${num(g.map)}, judgment ${num(j.map)}, fitted blend (held out) ${num(meanOf(heldApAll))}, ` +
      `routed ${num(meanOf(routedAll))}`,
  );
  console.log(
    `  routed P@k ${num(meanOf(routedPk))} against ${num(g.pk)} and ${num(j.pk)}; ` +
      `worst-positive rank ${num(meanOf(routedWorst), 1)} against ${num(g.worst, 1)} and ${num(j.worst, 1)}`,
  );
  // The routed selector reads the tier column, which the arms never saw, and
  // the T0 policy rows are 28 of the 135 positives. Without them the
  // comparison is against the same positives the arms were scored on.
  const bare = PROJECTS.map((p) => routed(rulesRows, jevRows, p.id, { dropPolicy: true }));
  console.log("");
  console.log(
    `  with the two policy rows dropped -- the same positives the arms were scored on -- ` +
      `routed AP ${num(meanOf(bare.map(averagePrecision)))},`,
  );
  console.log(
    `  P@k ${num(meanOf(bare.map((x) => precisionAtK(x))))}, worst ${num(meanOf(bare.map(worstPositiveRank)), 1)}; ` +
      `the grep alone gets ${num(report(rulesRows, { dropPolicy: true }).map)} and the judgment ` +
      `${num(report(jevRows, { dropPolicy: true }).map)}`,
  );
  console.log("");
  const byRoute = new Map<Route, number>();
  for (const s of SKILLS) byRoute.set(routeOf(s), (byRoute.get(routeOf(s)) ?? 0) + 1);
  console.log(`  the routing sends ${[...byRoute].map(([r, n]) => `${n} skills to ${r}`).join(", ")}`);
  console.log("");
  console.log("  So the gain is the TIER COLUMN, not the routing: putting the two T0 rows on top by policy");
  console.log("  is most of the jump, and sending the file-shaped sections to the grep instead of to the");
  console.log("  judgment does not pay for itself. Read §7 for why -- the grep wins on mean rank there but");
  console.log("  not on precision, because its ties put negatives in the same place as the positives.");
}

/** The routed score: policy on top, then each route ranked by its own selector. */
function routed(rulesRows: Row[], jevRows: Row[], project: string, opts: { dropPolicy?: boolean } = {}): Scored[] {
  const base = scoredFor(rulesRows, project, opts);
  const a = normalisedRanks(base);
  const b = normalisedRanks(scoredFor(jevRows, project, opts));
  return base.map((s) => {
    const route = routeOf(s.skill);
    const value = route === "policy" ? 2 : route === "grep" ? (a.get(s.skill) ?? 0) : (b.get(s.skill) ?? 0);
    return { skill: s.skill, positive: s.positive, value };
  });
}

// ------------------------------------------------------------------ collection

/**
 * One row per line, still valid JSON.
 *
 * 7,252 rows pretty-printed at two spaces is 1.9 MB, which is most of this
 * repository's git history on its own. One line per row keeps a diff readable
 * and brings it to 1.5 MB -- not a large saving, but the two width-control
 * arms are 2,072 of those rows and they are what §4 rests on, so none of
 * them can be dropped instead.
 */
function writeRecord(rows: Row[]): void {
  const body = rows.map((r) => `  ${JSON.stringify(r)}`).join(",\n");
  writeFileSync(RECORD, `[\n${body}\n]\n`);
}

async function pool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= jobs.length) return;
      out[i] = await jobs[i]();
    }
  });
  await Promise.all(workers);
  return out;
}

async function askGroup(
  jev: Jev,
  arm: ArmName,
  project: Project,
  group: Candidate[],
  repeat: number,
  requestId: string,
): Promise<Row[]> {
  const started = Date.now();
  if (arm === "single") {
    const res = await jev.ask(stateFor(arm, project, group[0]), singleQuestion());
    const s = score(res.answers[NEEDED]);
    return [
      {
        project: project.id,
        arm,
        skill: group[0].skill,
        repeat,
        value: s.score,
        confidence: s.confidence,
        requestId,
        requestMs: Date.now() - started,
        requestInputTokens: res.usage.input_tokens,
        batchSize: 1,
      },
    ];
  }
  const questions: Record<string, ReturnType<typeof questionFor>> = {};
  for (const c of group) questions[keyFor(c.skill)] = questionFor(arm, c);
  const res = await jev.ask(stateFor(arm, project), questions);
  const ms = Date.now() - started;
  return group.map((c) => {
    const a = res.answers[keyFor(c.skill)];
    const value = arm === "noul" ? noul(a) : score(a).score;
    const confidence = arm === "noul" ? 0 : score(a).confidence;
    return {
      project: project.id,
      arm,
      skill: c.skill,
      repeat,
      value,
      confidence,
      requestId,
      requestMs: ms,
      requestInputTokens: res.usage.input_tokens,
      batchSize: group.length,
    };
  });
}

async function collect(arms: ArmName[], repeats: number): Promise<Row[]> {
  const jev = new Jev();
  const jobs: (() => Promise<Row[]>)[] = [];
  for (const arm of arms) {
    for (let r = 0; r < repeats; r += 1) {
      for (const p of PROJECTS) {
        const groups = batches(arm, CANDIDATES.get(p.id)!);
        groups.forEach((group, i) => {
          const id = `${arm}:${p.id}:${r}:${i}`;
          jobs.push(() => askGroup(jev, arm, p, group, r, id));
        });
      }
    }
  }
  console.log(`  ${jobs.length} requests, ${CONCURRENCY} at a time`);
  let done = 0;
  const wrapped = jobs.map((job) => async () => {
    const out = await job();
    done += 1;
    if (done % 25 === 0 || done === jobs.length) process.stderr.write(`\r  ${done}/${jobs.length}`);
    return out;
  });
  const results = await pool(wrapped, CONCURRENCY);
  process.stderr.write("\n");
  const rows = results.flat();
  const kept = existsSync(RECORD)
    ? (JSON.parse(readFileSync(RECORD, "utf8")) as Row[]).filter(
        (r) => !arms.includes(r.arm) || r.repeat >= repeats,
      )
    : [];
  writeRecord([...kept, ...rows]);
  console.log(
    `  ${jev.calls} calls, ${jev.inputTokens} input tokens, $${((jev.inputTokens / 1e6) * 0.042).toFixed(4)}, ` +
      `${Math.round(jev.totalMs / jev.calls)} ms mean` + (jev.retriedCalls > 0 ? `, ${jev.retriedCalls} retried` : ""),
  );
  return [...kept, ...rows];
}

// ------------------------------------------------------------------------ main

async function main(): Promise<void> {
  console.log("=".repeat(104));
  console.log("  SKILL SELECTION OVER A CATALOG THAT DOES NOT FIT IN CONTEXT (docs/29)");
  rule();
  let rows: Row[] = existsSync(RECORD) ? (JSON.parse(readFileSync(RECORD, "utf8")) as Row[]) : [];
  if (!flag("replay")) {
    const arms = ARGS.includes("--arm")
      ? (opt("arm", "fanout").split(",") as ArmName[])
      : (ARMS as readonly ArmName[]).slice();
    for (const a of arms) if (!ARMS.includes(a)) throw new Error(`unknown arm ${a}`);
    rows = await collect(arms, Number(opt("repeat", "1")));
  }
  sectionCorpus();
  rule();
  sectionRules();
  if (rows.length > 0) {
    rule();
    sectionArms(rows);
    rule();
    sectionWidth(rows);
    rule();
    sectionCutoff(rows);
    rule();
    sectionCuration(rows);
    rule();
    sectionDisagreements(rows);
    rule();
    sectionDecomposed(rows);
    rule();
    sectionBlend(rows);
  }
  rule();
  const requests = new Map(rows.map((r) => [r.requestId, r]));
  const tokens = [...requests.values()].reduce((a, r) => a + r.requestInputTokens, 0);
  console.log(
    `  ${rows.length} recorded judgments over ${requests.size} requests: ` +
      `${tokens} input tokens, $${((tokens / 1e6) * 0.042).toFixed(4)}`,
  );
  void projectText;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
