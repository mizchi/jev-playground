/**
 * A suspicion score for a blog post: how much its STRUCTURE looks like an
 * unedited AI draft (docs/66 §2, §8). A ranking signal for triage, not a verdict.
 *
 *   npx tsx src/suspect.ts --fit                   # fit from the committed records -> records/suspect-model.json (no API)
 *   TYPESAFEAI_API_KEY=... npx tsx src/suspect.ts post.md [more.md ...]          # 187 features, ~$0.001/post
 *   TYPESAFEAI_API_KEY=... npx tsx src/suspect.ts --core post.md                 # 9 of the 10 core values, ~$0.0001/post
 *
 * Input: plain text or markdown, TITLE ON THE FIRST LINE. The model is fitted on
 * human posts with their title put back (docs/66 §4), so both classes carry one.
 *
 * Output, one JSON line per file:
 *   score       full: P(AI) from the logistic model; core: signed sum of 9 core values
 *   percentile  where the score falls among the pre-2022 human posts (out of fold)
 *   flag        score above the cutoff that flags 10% of pre-2022 human posts.
 *               At that cutoff (docs/66 §8): 87% of AI mirrors, and at most 16% of
 *               the companies' own 2023+ posts; the core mode catches 40% of AI.
 *   why         the values present in the post that pushed the score up the most
 *
 * Measured on B2B blog posts, one AI writer, unedited drafts. Refit the cutoff
 * on your own posts before relying on `flag`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { type Answer, Jev } from "../../shared/jev.js";
import { RECORDS, loadIndex, prepared } from "./corpus.js";
import { coreSelection, encode, instrument, questionsFor, stateFor, variantSets } from "./instrument.js";
import { key, load } from "./records.js";
import { auc, fitLogistic } from "./stats.js";

const MODEL = resolve(RECORDS, "suspect-model.json");
const LAMBDA = 10; // docs/66 §1 L5: fixed before any result was read
const FEATURES = instrument();
const STRUCT = FEATURES.filter((f) => new Set(variantSets().narrative_strict).has(f.id));
const CORE = coreSelection();
const CORE_FEATURES = FEATURES.filter((f) => CORE.core_values.some((c) => c.startsWith(`${f.id}__`)));

interface Model {
  cols: string[];
  mu: number[];
  sc: number[];
  w: number[];
  b: number;
  cutoff: number;
  human_scores: number[];
  core_cutoff: number;
  core_human_scores: number[];
  fitted_on: string;
}

const clean = (xs: number[]) => xs.map((v) => (Number.isFinite(v) ? v : 0));
const p90 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(0.9 * xs.length) - 1];

/**
 * "Payoff first promised in the title" is left out: its direction holds only when
 * the human side has no title (docs/66 §4), and this script is fed titled posts.
 * Dropping it moves the titled AUC from 0.691 to 0.737.
 */
const DROPPED = "PUR_OUT_003__title";

/** The paper's core values with their released directions, summed (docs/66 §7 A0), minus DROPPED. */
function coreScore(answers: Record<string, Answer>): { score: number; fired: string[] } {
  const e = encode(answers, CORE_FEATURES);
  let score = 0;
  const fired: string[] = [];
  for (const cv of CORE.core_values.filter((c) => c !== DROPPED)) {
    const f = CORE_FEATURES.find((x) => cv.startsWith(`${x.id}__`))!;
    const v = cv.endsWith("__ord") ? e[cv] / (f.values.length - 1) : e[cv];
    const sign = CORE.value_signs[cv] === "ai" ? 1 : -1;
    score += sign * v;
    if (sign * v > 0) fired.push(`${f.name}: ${cv.split("__")[1]}`);
  }
  return { score, fired };
}

function fit(): void {
  const rows = load(resolve(RECORDS, "features.jsonl.gz"));
  const byKey = new Map(rows.map((r) => [key(r), r]));
  const index = loadIndex().filter((e) => byKey.has(`${e.id}/titled`) && byKey.has(`${e.id}/ai`));
  const data = index.flatMap((e) =>
    (["titled", "ai"] as const).map((s) => {
      const x = encode(byKey.get(`${e.id}/${s}`)!.answers, STRUCT, true);
      return { domain: e.domain, y: s === "ai" ? 1 : 0, x };
    }),
  );
  const cols = Object.keys(data[0].x).sort();
  const X = data.map((d) => clean(cols.map((c) => d.x[c])));
  // Out-of-fold scores, one company held out at a time, set the cutoff and the percentiles.
  const oof: number[] = new Array(data.length);
  for (const dom of new Set(data.map((d) => d.domain))) {
    const tr = data.map((d, i) => i).filter((i) => data[i].domain !== dom);
    const m = fitLogistic(tr.map((i) => X[i]), tr.map((i) => data[i].y), LAMBDA);
    data.forEach((d, i) => d.domain === dom && (oof[i] = m(X[i])));
  }
  const human = oof.filter((_, i) => data[i].y === 0);
  const ai = oof.filter((_, i) => data[i].y === 1);
  const full = fitLogistic(X, data.map((d) => d.y), LAMBDA);
  const coreRows = new Map(load(resolve(RECORDS, "core.jsonl.gz")).map((r) => [key(r), r]));
  const coreHuman = index.map((e) => coreRows.get(`${e.id}/titled`)).filter((r) => r).map((r) => coreScore(r!.answers).score);
  const model: Model = {
    cols,
    mu: full.mu,
    sc: full.sc,
    w: full.w,
    b: full.b,
    cutoff: p90(human),
    human_scores: human.sort((a, b) => a - b),
    core_cutoff: p90(coreHuman),
    core_human_scores: coreHuman.sort((a, b) => a - b),
    fitted_on: `${index.length} prompts: titled human vs AI mirror, structural 187, soft encoding, L2 logistic lambda ${LAMBDA}`,
  };
  writeFileSync(MODEL, `${JSON.stringify(model)}\n`);
  const recall = ai.filter((p) => p > model.cutoff).length / ai.length;
  console.log(`wrote ${MODEL}\nout-of-fold AUC ${auc(ai, human).toFixed(3)}; cutoff ${model.cutoff.toFixed(3)} flags ${(human.filter((p) => p > model.cutoff).length / human.length).toFixed(3)} of human, ${recall.toFixed(3)} of AI`);
}

async function score(files: string[], coreOnly: boolean): Promise<void> {
  const m = JSON.parse(readFileSync(MODEL, "utf8")) as Model;
  const jev = new Jev();
  const qs = questionsFor(coreOnly ? CORE_FEATURES : STRUCT);
  const pct = (xs: number[], v: number) => xs.filter((h) => h < v).length / xs.length;
  for (const file of files) {
    const r = await jev.ask(stateFor(prepared(readFileSync(file, "utf8"))), qs);
    if (coreOnly) {
      const { score: s, fired } = coreScore(r.answers);
      console.log(JSON.stringify({ file, mode: "core", score: s, percentile: pct(m.core_human_scores, s), flag: s > m.core_cutoff, why: fired }));
      continue;
    }
    const e = encode(r.answers, STRUCT, true);
    const x = clean(m.cols.map((c) => e[c]));
    const contrib = m.cols.map((c, j) => ({ c, v: m.sc[j] > 1e-9 ? (m.w[j] * (x[j] - m.mu[j])) / m.sc[j] : 0 }));
    const z = m.b + contrib.reduce((a, t) => a + t.v, 0);
    const p = 1 / (1 + Math.exp(-z));
    const name = (c: string) => `${STRUCT.find((f) => c.startsWith(`${f.id}__`))!.name}: ${c.split("__")[1]}`;
    // Only values the post HAS: an absent one-hot value with a negative weight also
    // "pushes up", and naming it would say the post contains what it lacks.
    const present = (t: { c: string; v: number }) => t.c.endsWith("__ord") || x[m.cols.indexOf(t.c)] >= 0.5;
    const why = contrib.filter((t) => t.v > 0 && present(t)).sort((a, b) => b.v - a.v).slice(0, 5).map((t) => name(t.c));
    console.log(JSON.stringify({ file, mode: "full", score: p, percentile: pct(m.human_scores, p), flag: p > m.cutoff, why }));
  }
  console.error(`calls ${jev.calls}, input ${jev.inputTokens} tokens`);
}

const args = process.argv.slice(2);
if (args.includes("--fit")) fit();
else {
  const files = args.filter((a) => !a.startsWith("--"));
  if (!files.length) {
    console.error("usage: suspect.ts [--core] <post.md> ...   |   suspect.ts --fit");
    process.exit(2);
  }
  await score(files, args.includes("--core"));
}
