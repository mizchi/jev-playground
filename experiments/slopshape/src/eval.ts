/**
 * Every number in docs/66, recomputed from the committed records. No API key.
 *
 *   npx tsx src/eval.ts            # markdown report on stdout
 *   npx tsx src/eval.ts --json     # the same numbers as JSON (records/report.json)
 *
 * Sections, in the order docs/66 reads them:
 *   corpus     sizes and lengths (paper Table A2)
 *   A          the paper's pipeline with Jev as the scorer: features -> a
 *              classifier fitted here, leave-one-company-out (paper Table 3)
 *   A0         no fitting at all: the paper's ten core values and their
 *              released directions, scored by Jev (paper Table 6)
 *   directions do the core values lean the way the paper says, on this data?
 *   rarity     the human rarity gap (paper Table 7)
 *   B          Jev as the detector, with the paper handed over as context
 *   title      the release's human posts reach the scorer without a title
 *   reword     every mirror rewritten by its own writer (paper Table 4)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Answer } from "../../shared/jev.js";
import { DATA, REL, RECORDS, type Source, isHuman, loadIndex, normalize, wordCount } from "./corpus.js";
import { type Feature, type Variant, coreSelection, instrument, label, slug, variantSets } from "./instrument.js";
import { ARMS } from "./judge.js";
import { type Row, key, load } from "./records.js";
import { auc, clusterCI, cohenD, fitLogistic, kappa, macroF1, mean } from "./stats.js";

// ---------------------------------------------------------------- encoding

export type Encoded = Record<string, number>;

/** The release's encoding (r6_build.py): one-hot, multi-hot, ordinal position. */
export function encode(answers: Record<string, Answer>, features: Feature[], soft = false): Encoded {
  const x: Encoded = {};
  for (const f of features) {
    if (f.type === "multi_select") {
      for (const v of f.values) {
        const a = answers[`${f.id}__${slug(v)}`];
        const p = a?.type === "noul" ? a.noul : NaN;
        x[`${f.id}__${v}`] = soft ? p : p >= 0.5 ? 1 : 0;
      }
    } else if (f.type === "ordinal" || f.type === "scale") {
      const a = answers[f.id];
      if (a?.type !== "score") {
        x[`${f.id}__ord`] = NaN;
        continue;
      }
      const probs = Object.entries(a.probabilities).map(([k, p]) => [Number(k), p] as const);
      const top = probs.reduce((b, c) => (c[1] > b[1] ? c : b))[0];
      x[`${f.id}__ord`] = soft ? a.score : top;
    } else {
      const a = answers[f.id];
      for (const v of f.values) {
        const p = a?.type === "choice" ? (a.probabilities[label(v)] ?? 0) : NaN;
        x[`${f.id}__${v}`] = soft ? p : a?.type === "choice" && a.choice === label(v) ? 1 : 0;
      }
    }
  }
  return x;
}

// ------------------------------------------------------------------ data

const FEATURES = instrument();
const SETS = variantSets();
const CORE = coreSelection();
const featureRows = load(resolve(RECORDS, "features.jsonl.gz"));
const judgeRows = load(resolve(RECORDS, "judge.jsonl.gz"));
const byKey = new Map<string, Row>(featureRows.map((r) => [key(r), r]));
const judgeByKey = new Map<string, Row>(judgeRows.map((r) => [key(r), r]));
/** The ten core features asked alone, one request per post (score.ts --core). */
const coreRows = load(resolve(RECORDS, "core.jsonl.gz"));
const coreByKey = new Map<string, Row>(coreRows.map((r) => [key(r), r]));
const index = loadIndex();
const domainOf = new Map(index.map((e) => [e.id, e.domain]));
const wordsOf = (id: string, s: Source) => index.find((e) => e.id === id)?.words[s] ?? NaN;
/** Mirrors that are not a first draft (records/generation_notes.json): a sensitivity row drops them. */
const NOT_SINGLE_PASS = new Set<string>(
  JSON.parse(readFileSync(resolve(RECORDS, "generation_notes.json"), "utf8")).not_single_pass_mirrors.ids,
);
const dropEdited = process.argv.includes("--single-pass-only");
const ids = index.map((e) => e.id).filter(
  (id) => byKey.has(`${id}/human`) && byKey.has(`${id}/ai`) && !(dropEdited && NOT_SINGLE_PASS.has(id)),
);

const variantFeatures = (v: Variant | "core"): Feature[] => {
  const keep = new Set(v === "core" ? CORE.core_values.map((c) => c.split("__")[0]) : SETS[v]);
  return FEATURES.filter((f) => keep.has(f.id));
};

interface Item {
  id: string;
  domain: string;
  source: Source;
  y: number;
  x: number[];
}

function items(sources: Source[], v: Variant | "core", soft = false): { cols: string[]; rows: Item[] } {
  const feats = variantFeatures(v);
  let cols: string[] = [];
  const rows: Item[] = [];
  for (const id of ids) {
    for (const s of sources) {
      const r = byKey.get(`${id}/${s}`);
      if (!r) continue;
      const e = encode(r.answers, feats, soft);
      if (!cols.length) cols = Object.keys(e).sort();
      rows.push({ id, domain: domainOf.get(id)!, source: s, y: isHuman(s) ? 0 : 1, x: cols.map((c) => e[c]) });
    }
  }
  return { cols, rows };
}

// ------------------------------------------------------------ A: classifier

interface Scored {
  id: string;
  domain: string;
  source: Source;
  y: number;
  p: number;
}

/**
 * Leave-one-company-out: fit on every other domain's (human, ai) pairs and
 * score the held-out domain's posts from `testSources`. The held-out domain
 * is never seen, which is the release's split discipline (D6) at our size.
 */
function crossValidate(
  trainSources: [Source, Source],
  testSources: Source[],
  v: Variant | "core",
  soft = false,
): Scored[] {
  const all = items([...new Set([...trainSources, ...testSources])], v, soft);
  const domains = [...new Set(all.rows.map((r) => r.domain))].sort();
  const out: Scored[] = [];
  for (const dom of domains) {
    const train = all.rows.filter((r) => r.domain !== dom && trainSources.includes(r.source));
    const test = all.rows.filter((r) => r.domain === dom && testSources.includes(r.source));
    if (!test.length) continue;
    const f = fitLogistic(
      train.map((r) => r.x.map((z) => (Number.isFinite(z) ? z : 0))),
      train.map((r) => r.y),
      LAMBDA,
    );
    for (const r of test) out.push({ id: r.id, domain: r.domain, source: r.source, y: r.y, p: f(r.x.map((z) => (Number.isFinite(z) ? z : 0))) });
  }
  return out;
}
const LAMBDA = 10;

interface Metric {
  n: number;
  macro_f1: number;
  macro_f1_ci: [number, number];
  auc: number;
  auc_ci: [number, number];
  /** Share of prompts where the AI post outscores its own human post. */
  paired: number;
  /**
   * Macro-F1 with the cutoff fitted on the other companies' posts, per held-out
   * company (docs/25: fit the threshold, then read it held out).
   */
  macro_f1_fit: number;
}

function fittedF1(s: Scored[]): number {
  const domains = [...new Set(s.map((r) => r.domain))];
  const y: number[] = [];
  const pred: number[] = [];
  for (const dom of domains) {
    const train = s.filter((r) => r.domain !== dom);
    const cuts = [...new Set(train.map((r) => r.p))].sort((a, b) => a - b);
    let best = 0.5;
    let bestF = -1;
    for (const c of cuts) {
      const f = macroF1(train.map((r) => r.y), train.map((r) => r.p), c);
      if (f > bestF) [best, bestF] = [c, f];
    }
    for (const r of s.filter((r) => r.domain === dom)) {
      y.push(r.y);
      pred.push(r.p >= best ? 1 : 0);
    }
  }
  return macroF1(y, pred, 0.5);
}

function metrics(s: Scored[], threshold = 0.5): Metric {
  const f1 = (xs: Scored[]) => macroF1(xs.map((r) => r.y), xs.map((r) => r.p), threshold);
  const a = (xs: Scored[]) => auc(xs.filter((r) => r.y === 1).map((r) => r.p), xs.filter((r) => r.y === 0).map((r) => r.p));
  const byId = new Map<string, Scored[]>();
  for (const r of s) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
  const pairs = [...byId.values()].filter((g) => g.some((r) => r.y === 1) && g.some((r) => r.y === 0));
  const wins = pairs.map((g) => {
    const h = g.find((r) => r.y === 0)!.p;
    const ai = g.find((r) => r.y === 1)!.p;
    return ai > h ? 1 : ai === h ? 0.5 : 0;
  });
  return {
    n: s.length,
    macro_f1: f1(s),
    macro_f1_ci: clusterCI(s, (r) => r.domain, f1),
    auc: a(s),
    auc_ci: clusterCI(s, (r) => r.domain, a),
    paired: mean(wins),
    macro_f1_fit: fittedF1(s),
  };
}

// --------------------------------------------------------- A0: core rule

/** Σ over the ten core values of (+1 if it leans AI, -1 if human) × its value. */
function coreRuleScore(answers: Record<string, Answer>, soft = false): number {
  const e = encode(answers, variantFeatures("core"), soft);
  const byId = new Map(FEATURES.map((f) => [f.id, f]));
  let s = 0;
  for (const cv of CORE.core_values) {
    const [id] = cv.split("__");
    const sign = CORE.value_signs[cv] === "ai" ? 1 : -1;
    const v = cv.endsWith("__ord") ? e[cv] / (byId.get(id)!.values.length - 1) : e[cv];
    // In soft mode the ordinal is Jev's expected position, already on the same scale.
    s += sign * v;
  }
  return s;
}

function scoredBy(sources: Source[], f: (r: Row) => number, table = byKey): Scored[] {
  const out: Scored[] = [];
  for (const id of ids)
    for (const s of sources) {
      const r = table.get(`${id}/${s}`);
      if (r) out.push({ id, domain: domainOf.get(id)!, source: s, y: isHuman(s) ? 0 : 1, p: f(r) });
    }
  return out;
}

// ------------------------------------------------ directions of core values

function valueMeans(sources: Source[], col: string, v: Variant | "core" = "narrative_strict"): number {
  const { cols, rows } = items(sources, v);
  const j = cols.indexOf(col);
  const byId = new Map(FEATURES.map((f) => [f.id, f]));
  const div = col.endsWith("__ord") ? byId.get(col.split("__")[0])!.values.length - 1 : 1;
  return mean(rows.map((r) => r.x[j] / div));
}

function directions(human: Source, ai: Source) {
  return CORE.core_values.map((cv) => {
    const h = valueMeans([human], cv);
    const a = valueMeans([ai], cv);
    const ours = h > a ? "human" : "ai";
    return {
      value: cv,
      paper_leans: CORE.value_signs[cv],
      paper_gap: CORE.value_gaps[cv],
      human_mean: h,
      ai_mean: a,
      ours_leans: ours,
      ours_gap: Math.abs(h - a),
      agrees: ours === CORE.value_signs[cv],
    };
  });
}

/** The values that separate most on this data: what Jev's reading says the shape is. */
function topGaps(human: Source, ai: Source, n = 12) {
  const { cols, rows } = items([human, ai], "narrative_strict");
  const byId = new Map(FEATURES.map((f) => [f.id, f]));
  return cols
    .map((c, j) => {
      const div = c.endsWith("__ord") ? byId.get(c.split("__")[0])!.values.length - 1 : 1;
      const h = mean(rows.filter((r) => r.source === human).map((r) => r.x[j] / div));
      const a = mean(rows.filter((r) => r.source === ai).map((r) => r.x[j] / div));
      return { value: c, name: byId.get(c.split("__")[0])!.name, human_mean: h, ai_mean: a, gap: a - h };
    })
    .sort((p, q) => Math.abs(q.gap) - Math.abs(p.gap))
    .slice(0, n);
}

// ----------------------------------------------------------------- rarity

/**
 * The release's rarity (study_b/rarity.py): z-score the structural encoding,
 * mean Euclidean distance to the 25 nearest neighbours in the pooled set,
 * as a percentile of the pooled distribution. Pooled = human + ai here.
 */
function rarity(human: Source, ai: Source) {
  const { rows } = items([human, ai], "narrative_strict");
  const d = rows[0].x.length;
  const X = rows.map((r) => r.x.map((v) => (Number.isFinite(v) ? v : 0)));
  const mu = Array.from({ length: d }, (_, j) => mean(X.map((r) => r[j])));
  const sdv = Array.from({ length: d }, (_, j) => Math.sqrt(mean(X.map((r) => (r[j] - mu[j]) ** 2))));
  const Z = X.map((r) => r.map((v, j) => (sdv[j] > 1e-9 ? (v - mu[j]) / sdv[j] : 0)));
  const k = Math.min(25, Z.length - 1);
  const raw = Z.map((zi, i) => {
    const ds = Z.map((zj, j) => (i === j ? Infinity : Math.sqrt(zi.reduce((s, v, t) => s + (v - zj[t]) ** 2, 0))));
    ds.sort((a, b) => a - b);
    return mean(ds.slice(0, k));
  });
  const pct = raw.map((r) => raw.filter((q) => q < r).length / raw.length);
  const hs = rows.map((r, i) => (r.y === 0 ? pct[i] : NaN)).filter(Number.isFinite);
  const as = rows.map((r, i) => (r.y === 1 ? pct[i] : NaN)).filter(Number.isFinite);
  const byId = new Map<string, number[]>();
  rows.forEach((r, i) => byId.set(r.id, [...(byId.get(r.id) ?? []), r.y === 0 ? pct[i] : -pct[i]]));
  const rarest = [...byId.values()].filter((g) => g.length === 2).map((g) => {
    const h = g.find((v) => v >= 0)!;
    const a = -g.find((v) => v <= 0)!;
    return h > a ? 1 : 0;
  });
  return {
    human_mean: mean(hs),
    ai_mean: mean(as),
    cohens_d: cohenD(hs, as),
    auc: auc(hs, as),
    human_rarest_of_pair: mean(rarest),
    k,
  };
}

// ------------------------------------------------------------ rewording gates

const ngrams = (t: string, n = 13) => {
  const w = t.toLowerCase().split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
};

/**
 * The release's gates (artifacts/r7/GATES.md): length ratio in [0.6, 1.4],
 * trivial copy when >= 90% of the rewrite's 13-grams survive, and the attack
 * magnitude as the share of the original's 13-grams still present verbatim.
 */
export function rewordGates() {
  const rows = ids
    .map((id) => {
      const ap = resolve(DATA, "mirrors", `${id}.md`);
      const rp = resolve(DATA, "reworded", `${id}.md`);
      if (!existsSync(ap) || !existsSync(rp)) return null;
      const a = readFileSync(ap, "utf8");
      const r = readFileSync(rp, "utf8");
      const ga = ngrams(normalize(a));
      const gr = ngrams(normalize(r));
      return {
        ratio: wordCount(r) / wordCount(a),
        surviving: [...ga].filter((g) => gr.has(g)).length / Math.max(1, ga.size),
        copy: [...gr].filter((g) => ga.has(g)).length / Math.max(1, gr.size) >= 0.9,
      };
    })
    .filter((x) => x !== null);
  if (!rows.length) return null;
  return {
    n: rows.length,
    mean_ratio: mean(rows.map((x) => x.ratio)),
    min_ratio: Math.min(...rows.map((x) => x.ratio)),
    length_violations: rows.filter((x) => x.ratio < 0.6 || x.ratio > 1.4).length,
    trivial_copies: rows.filter((x) => x.copy).length,
    surviving_13gram_share: mean(rows.map((x) => x.surviving)),
  };
}

// ------------------------------------------------------------- repeatability

function repeatability() {
  const path = resolve(RECORDS, "features-repeat.jsonl.gz");
  if (!existsSync(path)) return null;
  const reps = load(path);
  const single = FEATURES.filter((f) => f.type !== "multi_select");
  const hard = (a: Answer | undefined) =>
    a?.type === "choice" ? a.choice : a?.type === "score" ? Object.entries(a.probabilities).reduce((b, c) => (c[1] > b[1] ? c : b))[0] : "";
  const A: string[] = [];
  const B: string[] = [];
  for (const r of reps) {
    const base = byKey.get(key(r));
    if (!base) continue;
    for (const f of single) {
      A.push(`${f.id}=${hard(base.answers[f.id])}`);
      B.push(`${f.id}=${hard(r.answers[f.id])}`);
    }
  }
  return { posts: reps.length, items: A.length, exact: A.filter((x, i) => x === B[i]).length / A.length, kappa: kappa(A, B) };
}

// ------------------------------------------------------ §9: posts from 2023 on

interface RecentMeta {
  id: string;
  domain: string;
  url: string;
  date: string;
  words: number;
}

/**
 * How often each detector flags the companies' own 2023+ posts, at cutoffs set
 * on the pre-2022 data only. The labels of 2023+ posts are unknown, so a flag
 * rate here is an UPPER BOUND on the false-positive rate.
 *
 * Every detector yields three score lists: pre-2022 human (out of fold where a
 * model is fitted), AI mirror, and 2023+. Two cutoffs, both from pre-2022:
 *   fpr10  flags at most 10% of pre-2022 human posts (score > the 90th percentile)
 *   f1     the macro-F1-best cutoff on the pre-2022 pairs (score >= c)
 */
function recentProbe() {
  const metaPath = resolve(RECORDS, "recent.json");
  if (!existsSync(metaPath)) return null;
  const meta = new Map((JSON.parse(readFileSync(metaPath, "utf8")) as RecentMeta[]).map((m) => [m.id, m]));
  const rows = (kind: string) => new Map(load(resolve(RECORDS, `recent-${kind}.jsonl.gz`)).map((r) => [r.id, r]));
  const feat = rows("features");
  const core = rows("core");
  const judge = rows("judge");
  const recentIds = [...meta.keys()].filter((id) => feat.has(id) && core.has(id) && judge.has(id)).sort();
  if (!recentIds.length) return null;

  // The structural classifier, soft encoding: a 2023+ post from a company in the
  // training pairs is scored by the model fitted without that company.
  const struct = items(["human", "ai"], "narrative_strict", true);
  const clean = (x: number[]) => x.map((z) => (Number.isFinite(z) ? z : 0));
  const folds = new Map<string, (x: number[]) => number>();
  const modelFor = (domain: string) => {
    if (!folds.has(domain)) {
      const train = struct.rows.filter((r) => r.domain !== domain);
      folds.set(domain, fitLogistic(train.map((r) => clean(r.x)), train.map((r) => r.y), LAMBDA));
    }
    return folds.get(domain)!;
  };
  const structRecent = (r: Row) => {
    const e = encode(r.answers, variantFeatures("narrative_strict"), true);
    return modelFor(meta.get(r.id)!.domain)(clean(struct.cols.map((c) => e[c])));
  };
  const cv = crossValidate(["human", "ai"], ["human", "ai"], "narrative_strict", true);

  type Det = { name: string; human: number[]; ai: number[]; recent: number[] };
  const fromTable = (name: string, table: Map<string, Row>, recentTable: Map<string, Row>, f: (r: Row) => number): Det => ({
    name,
    human: scoredBy(["human"], f, table).map((r) => r.p),
    ai: scoredBy(["ai"], f, table).map((r) => r.p),
    recent: recentIds.map((id) => f(recentTable.get(id)!)),
  });
  const dets: Det[] = [
    fromTable("A0, core 10 alone (hard)", coreByKey, core, (r) => coreRuleScore(r.answers)),
    fromTable("A0, core 10 alone (soft)", coreByKey, core, (r) => coreRuleScore(r.answers, true)),
    fromTable("A0, inside 307 (hard)", byKey, feat, (r) => coreRuleScore(r.answers)),
    {
      name: "structural 187, soft, fitted",
      human: cv.filter((r) => r.y === 0).map((r) => r.p),
      ai: cv.filter((r) => r.y === 1).map((r) => r.p),
      recent: recentIds.map((id) => structRecent(feat.get(id)!)),
    },
    ...ARMS.map((arm) => fromTable(`judge: ${arm}`, judgeByKey, judge, judgeScore(arm))),
  ];

  const years = [...new Set(recentIds.map((id) => meta.get(id)!.date.slice(0, 4)))].sort();
  const matched = new Set(ids.map((id) => domainOf.get(id)));
  const rate = (xs: number[], pred: (v: number) => boolean) => xs.filter(pred).length / Math.max(1, xs.length);
  const out = dets.map((d) => {
    const hs = [...d.human].sort((a, b) => a - b);
    const c10 = hs[Math.ceil(0.9 * hs.length) - 1];
    const y = [...d.human.map(() => 0), ...d.ai.map(() => 1)];
    const sc = [...d.human, ...d.ai];
    let cF1 = 0.5;
    let best = -1;
    for (const c of [...new Set(sc)].sort((a, b) => a - b)) {
      const f = macroF1(y, sc, c);
      if (f > best) [cF1, best] = [c, f];
    }
    const recent = recentIds.map((id, i) => ({ id, domain: meta.get(id)!.domain, year: meta.get(id)!.date.slice(0, 4), p: d.recent[i] }));
    const flagCI = (pred: (v: number) => boolean) =>
      clusterCI(recent, (r) => r.domain, (xs) => rate(xs.map((r) => r.p), pred));
    const fpr10 = (v: number) => v > c10;
    const f1 = (v: number) => v >= cF1;
    return {
      detector: d.name,
      auc_ai_vs_old_human: auc(d.ai, d.human),
      auc_recent_vs_old_human: auc(d.recent, d.human),
      fpr10: {
        cutoff: c10,
        old_human_flagged: rate(d.human, fpr10),
        ai_recall: rate(d.ai, fpr10),
        recent_flagged: rate(d.recent, fpr10),
        recent_ci: flagCI(fpr10),
        matched_companies: rate(recent.filter((r) => matched.has(r.domain)).map((r) => r.p), fpr10),
        by_year: Object.fromEntries(years.map((yr) => [yr, rate(recent.filter((r) => r.year === yr).map((r) => r.p), fpr10)])),
      },
      f1: {
        cutoff: cF1,
        old_human_flagged: rate(d.human, f1),
        ai_recall: rate(d.ai, f1),
        recent_flagged: rate(d.recent, f1),
        recent_ci: flagCI(f1),
      },
    };
  });
  return {
    posts: recentIds.length,
    companies: new Set(recentIds.map((id) => meta.get(id)!.domain)).size,
    matched_posts: recentIds.filter((id) => matched.has(meta.get(id)!.domain)).length,
    by_year: Object.fromEntries(years.map((yr) => [yr, recentIds.filter((id) => meta.get(id)!.date.startsWith(yr)).length])),
    mean_words: mean(recentIds.map((id) => meta.get(id)!.words)),
    detectors: out,
  };
}

// --------------------------------------------------------------- the report

const rel = (p: string) => JSON.parse(readFileSync(resolve(REL, p), "utf8"));
const paper = {
  variants: rel("artifacts/r6/variant_results_parity.json"),
  core: rel("artifacts/r6/core_values_selection.json").variants,
  rarity: rel("artifacts/r6/rarity_report.json").trainval,
  durability: rel("artifacts/r7/durability_aggregates.json").classifiers,
};

const VARIANTS: [Variant | "core", string][] = [
  ["narrative_strict", "structural (187)"],
  ["style_only", "style-only (27)"],
  ["all_features", "all (214)"],
  ["core", "core-only (10)"],
];

const judgeScore = (arm: string) => (r: Row) => (r.answers[arm] as { noul: number }).noul;
const hasReworded = ids.some((id) => byKey.has(`${id}/reworded`));

export function report() {
  const lengths = Object.fromEntries(
    (["human", "ai", "reworded"] as Source[]).map((s) => {
      const ws = ids.map((id) => wordsOf(id, s)).filter(Number.isFinite);
      return [s, { n: ws.length, mean_words: ws.length ? mean(ws) : NaN }];
    }),
  );
  const lengthOnly = metrics(scoredBy(["human", "ai"], (r) => wordsOf(r.id, r.source)), Infinity);
  const A = Object.fromEntries(
    VARIANTS.map(([v, name]) => [name, {
      as_released: metrics(crossValidate(["human", "ai"], ["human", "ai"], v)),
      titled: metrics(crossValidate(["titled", "ai"], ["titled", "ai"], v)),
      reworded: hasReworded ? metrics(crossValidate(["human", "ai"], ["human", "reworded"], v)) : null,
    }]),
  );
  const A_soft = metrics(crossValidate(["human", "ai"], ["human", "ai"], "narrative_strict", true));
  const A0 = {
    as_released: metrics(scoredBy(["human", "ai"], (r) => coreRuleScore(r.answers)), Infinity),
    titled: metrics(scoredBy(["titled", "ai"], (r) => coreRuleScore(r.answers)), Infinity),
    reworded: hasReworded ? metrics(scoredBy(["human", "reworded"], (r) => coreRuleScore(r.answers)), Infinity) : null,
    soft: metrics(scoredBy(["human", "ai"], (r) => coreRuleScore(r.answers, true)), Infinity),
    soft_titled: metrics(scoredBy(["titled", "ai"], (r) => coreRuleScore(r.answers, true)), Infinity),
    alone: coreRows.length
      ? {
          as_released: metrics(scoredBy(["human", "ai"], (r) => coreRuleScore(r.answers), coreByKey), Infinity),
          titled: metrics(scoredBy(["titled", "ai"], (r) => coreRuleScore(r.answers), coreByKey), Infinity),
          reworded: metrics(scoredBy(["human", "reworded"], (r) => coreRuleScore(r.answers), coreByKey), Infinity),
          soft: metrics(scoredBy(["human", "ai"], (r) => coreRuleScore(r.answers, true), coreByKey), Infinity),
        }
      : null,
  };
  const B = Object.fromEntries(
    ARMS.map((arm) => [arm, {
      as_released: metrics(scoredBy(["human", "ai"], judgeScore(arm), judgeByKey)),
      titled: metrics(scoredBy(["titled", "ai"], judgeScore(arm), judgeByKey)),
      reworded: hasReworded ? metrics(scoredBy(["human", "reworded"], judgeScore(arm), judgeByKey)) : null,
      mean_noul: {
        human: mean(scoredBy(["human"], judgeScore(arm), judgeByKey).map((r) => r.p)),
        ai: mean(scoredBy(["ai"], judgeScore(arm), judgeByKey).map((r) => r.p)),
      },
    }]),
  );
  const repeatRows = load(resolve(RECORDS, "features-repeat.jsonl.gz"));
  const usage = [...featureRows, ...judgeRows, ...coreRows, ...repeatRows].reduce(
    (s, r) => ({ calls: s.calls + 1, input: s.input + r.usage.input_tokens, output: s.output + r.usage.output_tokens }),
    { calls: 0, input: 0, output: 0 },
  );
  return {
    prompts: ids.length,
    domains: new Set(ids.map((id) => domainOf.get(id))).size,
    lengths,
    length_only: lengthOnly,
    reword_gates: rewordGates(),
    A,
    A_soft_structural: A_soft,
    A0,
    directions: { as_released: directions("human", "ai"), titled: directions("titled", "ai") },
    top_gaps: topGaps("human", "ai"),
    rarity: { as_released: rarity("human", "ai"), titled: rarity("titled", "ai") },
    B,
    repeatability: repeatability(),
    recent: recentProbe(),
    usage,
    paper: {
      structural: paper.variants.narrative_strict.test.macro_f1,
      style_only: paper.variants.style_only.test.macro_f1,
      all_features: paper.variants.all_features.test.macro_f1,
      core_only: paper.core.core_only.test.macro_f1,
      rarity: paper.rarity,
      reworded_structural: paper.durability.structural.attacked_test.macro_f1,
    },
  };
}

// ---------------------------------------------------------------- markdown

const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "-");
const ci = (c: [number, number]) => `[${f2(c[0])}, ${f2(c[1])}]`;
const cell = (m: Metric | null, withF1 = true) =>
  m ? `${withF1 ? `${f2(m.macro_f1)} ${ci(m.macro_f1_ci)} / ` : ""}${f2(m.auc)} ${ci(m.auc_ci)} / ${f2(m.paired)}` : "-";
const fitCell = (m: Metric | null) => (m ? f2(m.macro_f1_fit) : "-");

function markdown(r: ReturnType<typeof report>): string {
  const L: string[] = [];
  L.push(`prompts ${r.prompts} (domains ${r.domains}); Jev calls ${r.usage.calls}, input ${r.usage.input} tok, output ${r.usage.output} tok`);
  L.push("");
  L.push("## corpus");
  for (const [s, v] of Object.entries(r.lengths)) L.push(`- ${s}: n=${v.n}, mean words ${v.mean_words.toFixed(0)}`);
  L.push(`- length-only: AUC ${f2(r.length_only.auc)} ${ci(r.length_only.auc_ci)}`);
  const g = r.reword_gates;
  if (g)
    L.push(`- rewording gates (${g.n}): length ratio mean ${f2(g.mean_ratio)} (min ${f2(g.min_ratio)}), violations ${g.length_violations}, trivial copies ${g.trivial_copies}, surviving 13-gram share ${f2(g.surviving_13gram_share)} (paper 0.269)`);
  L.push("");
  L.push("## A: features scored by Jev -> logistic, leave-one-company-out");
  L.push("cells: macro-F1 [CI] / AUC [CI] / paired (AI post outscores its own human post)");
  L.push("");
  L.push("| variant | as released | titled humans | reworded mirrors | paper macro-F1 |");
  L.push("| --- | --- | --- | --- | --- |");
  const paperOf: Record<string, number> = {
    "structural (187)": r.paper.structural,
    "style-only (27)": r.paper.style_only,
    "all (214)": r.paper.all_features,
    "core-only (10)": r.paper.core_only,
  };
  for (const [name, v] of Object.entries(r.A))
    L.push(`| ${name} | ${cell(v.as_released)} | ${cell(v.titled)} | ${cell(v.reworded)} | ${f2(paperOf[name])} |`);
  L.push(`| structural, soft encoding | ${cell(r.A_soft_structural)} | | | |`);
  L.push("");
  L.push("## A0: the paper's ten core values, no fitting (AUC [CI] / paired)");
  L.push(`- as released ${cell(r.A0.as_released, false)}; titled ${cell(r.A0.titled, false)}; reworded ${cell(r.A0.reworded, false)}`);
  L.push(`- soft encoding: as released ${cell(r.A0.soft, false)}; titled ${cell(r.A0.soft_titled, false)}`);
  const al = r.A0.alone;
  if (al)
    L.push(`- asked alone (20 questions a request): as released ${cell(al.as_released, false)}; titled ${cell(al.titled, false)}; reworded ${cell(al.reworded, false)}; soft ${cell(al.soft, false)}`);
  L.push("");
  L.push("## directions of the core values (human mean vs ai mean on this data)");
  L.push("| value | paper leans (gap) | as released: h / ai | titled: h / ai | agrees (released, titled) |");
  L.push("| --- | --- | --- | --- | --- |");
  r.directions.as_released.forEach((d, i) => {
    const t = r.directions.titled[i];
    L.push(`| ${d.value} | ${d.paper_leans} (${d.paper_gap}) | ${f2(d.human_mean)} / ${f2(d.ai_mean)} | ${f2(t.human_mean)} / ${f2(t.ai_mean)} | ${d.agrees ? "yes" : "NO"}, ${t.agrees ? "yes" : "NO"} |`);
  });
  L.push("");
  L.push("## largest structural gaps on this data (ai mean - human mean)");
  for (const g of r.top_gaps) L.push(`- ${g.value} (${g.name}): human ${f2(g.human_mean)}, ai ${f2(g.ai_mean)}, gap ${g.gap > 0 ? "+" : ""}${f2(g.gap)}`);
  L.push("");
  L.push("## rarity");
  for (const [k, v] of Object.entries(r.rarity))
    L.push(`- ${k}: human ${f2(v.human_mean)} vs ai ${f2(v.ai_mean)}, d ${f2(v.cohens_d)}, AUC ${f2(v.auc)}, human rarer than its mirror ${f2(v.human_rarest_of_pair)} (chance 0.5), k=${v.k}`);
  L.push(`- paper: human ${r.paper.rarity.human_mean} vs ai ${r.paper.rarity.ai_mean}, d ${r.paper.rarity.cohens_d}`);
  L.push("");
  L.push("## B: Jev as the detector (noul, threshold 0.5): macro-F1 [CI] / AUC [CI] / paired");
  L.push("| arm | as released | titled humans | reworded mirrors | mean noul human / ai | macro-F1, fitted cutoff (released / titled / reworded) |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  for (const [arm, v] of Object.entries(r.B))
    L.push(`| ${arm} | ${cell(v.as_released)} | ${cell(v.titled)} | ${cell(v.reworded)} | ${f2(v.mean_noul.human)} / ${f2(v.mean_noul.ai)} | ${fitCell(v.as_released)} / ${fitCell(v.titled)} / ${fitCell(v.reworded)} |`);
  L.push("");
  const rc = r.recent;
  if (rc) {
    L.push("## §9: the companies' own posts from 2023 on (flag rate = upper bound on false positives)");
    L.push(`posts ${rc.posts} from ${rc.companies} companies (${rc.matched_posts} from the 33 pre-2022 companies), by year ${JSON.stringify(rc.by_year)}, mean words ${rc.mean_words.toFixed(0)}`);
    L.push("");
    L.push("| detector | AUC ai vs old human | AUC 2023+ vs old human | cutoff fpr10: old human / AI recall / **2023+** [CI] / matched | by year | cutoff F1: old human / AI recall / **2023+** [CI] |");
    L.push("| --- | --- | --- | --- | --- | --- |");
    for (const d of rc.detectors)
      L.push(`| ${d.detector} | ${f2(d.auc_ai_vs_old_human)} | ${f2(d.auc_recent_vs_old_human)} | ${f2(d.fpr10.old_human_flagged)} / ${f2(d.fpr10.ai_recall)} / **${f2(d.fpr10.recent_flagged)}** ${ci(d.fpr10.recent_ci)} / ${f2(d.fpr10.matched_companies)} | ${Object.entries(d.fpr10.by_year).map(([y, v]) => `${y}: ${f2(v)}`).join(", ")} | ${f2(d.f1.old_human_flagged)} / ${f2(d.f1.ai_recall)} / **${f2(d.f1.recent_flagged)}** ${ci(d.f1.recent_ci)} |`);
    L.push("");
  }
  if (r.repeatability)
    L.push(`## repeatability: ${r.repeatability.posts} rescored posts, ${r.repeatability.items} single-answer items, exact ${f2(r.repeatability.exact)}, kappa ${f2(r.repeatability.kappa)} (paper alpha 0.891)`);
  return L.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = report();
  if (process.argv.includes("--json")) {
    writeFileSync(resolve(RECORDS, "report.json"), `${JSON.stringify(r, null, 1)}\n`);
    console.log("wrote records/report.json");
  } else console.log(markdown(r));
}
