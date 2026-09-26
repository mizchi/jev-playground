/**
 * What has to hold before a request is spent, and before a number is read.
 *
 *   npm test      # no API key; needs `npm run release` (the pinned release)
 *
 *   the normalizer is the release's: study_b/normalize.py is run by Python on
 *     every post in the corpus and must agree with ours byte for byte, so no
 *     judge here sees text the release's scorer would not have;
 *   the instrument is the release's: 214 features, 187/27 structural/style,
 *     and the encoding has the release's 868 columns (paper §4.6);
 *   no feature question says who wrote the post, and no judge context is typed
 *     here: the core arm's ten lines are read from the release's core values;
 *   the mirror writer saw the brief and nothing else: its prompt file is the
 *     brief plus the release's word-count sentence, and no brief or mirror
 *     shares a 13-word run with its human post (the release's memorization
 *     rule, Brown et al. 2020) beyond the few the release itself reports;
 *   the statistics do what their names say on cases small enough to check by hand.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { DATA, REL, corpus, humans, normalize } from "./src/corpus.js";
import { encode } from "./src/eval.js";
import { instrument, questionsFor, variantSets } from "./src/instrument.js";
import { judgeQuestions } from "./src/judge.js";
import { cleanBrief, mirrorPrompt } from "./src/prompts.js";
import { auc, clusterCI, cohenD, kappa, macroF1 } from "./src/stats.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

if (!existsSync(REL)) {
  console.error("vendor/slopshape missing: run `npm run release` first");
  process.exit(1);
}

// ---- normalizer parity with the release, on every post we have
{
  // Human posts only when data/human exists (it is gitignored); mirrors and rewrites always.
  const docs = [
    ...corpus(["human"], false).map((d) => ({ name: `${d.id}/human`, raw: d.raw })),
    ...["mirrors", "reworded"].flatMap((dir) =>
      existsSync(resolve(DATA, dir))
        ? readdirSync(resolve(DATA, dir)).map((f) => ({ name: `${f}/${dir}`, raw: readFileSync(resolve(DATA, dir, f), "utf8") }))
        : [],
    ),
  ];
  const texts = docs.map((d) => d.raw);
  const py = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(REL)})`,
    "from study_b.normalize import normalize",
    "print(json.dumps([normalize(t) for t in json.load(sys.stdin)]))",
  ].join("\n");
  const theirs = JSON.parse(execFileSync("python3", ["-c", py], { input: JSON.stringify(texts), maxBuffer: 1 << 28 }).toString()) as string[];
  const bad = texts.map((t, i) => (normalize(t) === theirs[i] ? -1 : i)).filter((i) => i >= 0);
  check(`normalize == study_b/normalize.py on ${texts.length} posts`, bad.length === 0, bad.length ? `differs on ${bad.map((i) => docs[i].name).slice(0, 3).join(", ")}` : "");
}

// ---- the instrument
{
  const feats = instrument();
  const sets = variantSets();
  check("214 features", feats.length === 214, String(feats.length));
  check("187 structural + 27 style", sets.narrative_strict.length === 187 && sets.style_only.length === 27);
  const blank = Object.fromEntries(Object.keys(questionsFor(feats)).map((k) => [k, undefined])) as never;
  const cols = Object.keys(encode(blank, feats));
  check("encoding has the release's 868 columns", cols.length === 868, String(cols.length));
  const qs = questionsFor(feats);
  check("307 questions per post (201 single + 106 multi-select values)", Object.keys(qs).length === 307, String(Object.keys(qs).length));
  const leaky = Object.entries(qs).filter(([, q]) => /\b(AI|artificial intelligence|language model|machine[- ]generated|written by a human)\b/i.test(String(q.instructions)));
  check("no feature question names the author class", leaky.length === 0, leaky.map(([k]) => k).join(", "));
}

// ---- judge contexts come from the release
{
  const core = JSON.parse(readFileSync(resolve(REL, "artifacts/r6/core_values_selection.json"), "utf8"));
  const lines = String(judgeQuestions().core.instructions).split("\n").filter((l) => l.startsWith("- "));
  check("core arm lists the release's ten core values", lines.length === core.core_values.length && core.core_values.length === 10);
  check("bare arm carries no context", String(judgeQuestions().bare.instructions).split(/\s+/).length < 20);
}

// ---- generation hygiene (needs the human posts: `npm run fetch`)
if (humans().length === 0) console.log("skip generation-hygiene checks: data/human is empty (gitignored; `npm run fetch` rebuilds it)");
else {
  const grams = (t: string, n = 13) => {
    const w = normalize(t).toLowerCase().split(/\s+/).filter(Boolean);
    const s = new Set<string>();
    for (let i = 0; i + n <= w.length; i++) s.add(w.slice(i, i + n).join(" "));
    return s;
  };
  let briefs = 0;
  let briefHits = 0;
  let mirrors = 0;
  let mirrorHits = 0;
  let promptMismatch = 0;
  for (const h of humans()) {
    const hg = grams(h.text);
    const bp = resolve(DATA, "briefs", `${h.doc_id}.txt`);
    if (existsSync(bp)) {
      briefs += 1;
      const brief = readFileSync(bp, "utf8");
      if ([...grams(brief)].some((g) => hg.has(g))) briefHits += 1;
      const pp = resolve(DATA, "prompts/mirror", `${h.doc_id}.txt`);
      const want = mirrorPrompt({ doc_id: h.doc_id, prompt: cleanBrief(brief), target_words: Math.round(h.manifest_words / 100) * 100 || 100 });
      if (!existsSync(pp) || !readFileSync(pp, "utf8").includes(want)) promptMismatch += 1;
    }
    const mp = resolve(DATA, "mirrors", `${h.doc_id}.md`);
    if (existsSync(mp)) {
      mirrors += 1;
      if ([...grams(readFileSync(mp, "utf8"))].some((g) => hg.has(g))) mirrorHits += 1;
    }
  }
  // A template filled with String.replace(str) expands `$'` in the post (46dbdbe15cffaaa0 was hit).
  let unfaithful = 0;
  for (const h of humans()) {
    const bp = resolve(DATA, "prompts/brief", `${h.doc_id}.txt`);
    if (existsSync(bp) && !readFileSync(bp, "utf8").includes(h.text)) unfaithful += 1;
    const rp = resolve(DATA, "prompts/reword", `${h.doc_id}.txt`);
    const mp = resolve(DATA, "mirrors", `${h.doc_id}.md`);
    if (existsSync(rp) && !readFileSync(rp, "utf8").includes(readFileSync(mp, "utf8").trim())) unfaithful += 1;
  }
  check("every brief/reword prompt contains its source post verbatim", unfaithful === 0, `${unfaithful} do not`);
  check(`every mirror prompt is its brief + the word-count sentence (${briefs} briefs)`, promptMismatch === 0, `${promptMismatch} differ`);
  check("no brief shares a 13-gram with its human post", briefHits === 0, `${briefHits}/${briefs}`);
  // The release flags 0.19% of pairs; with ~55 pairs, more than one hit is a leak, not chance.
  check("at most one mirror shares a 13-gram with its human post", mirrorHits <= 1, `${mirrorHits}/${mirrors}`);
  const oneline = [...new Set(corpus(["ai"]).map((d) => d.raw.trim().split("\n")[0]))];
  check("every mirror begins with a title line", oneline.every((l) => l.length > 0 && l.length < 200));
}

// ---- the shipped suspicion model (src/suspect.ts --fit)
{
  const m = JSON.parse(readFileSync(resolve(DATA, "../records/suspect-model.json"), "utf8"));
  const struct = instrument().filter((f) => new Set(variantSets().narrative_strict).has(f.id));
  const blank = Object.fromEntries(Object.keys(questionsFor(struct)).map((k) => [k, undefined])) as never;
  const cols = Object.keys(encode(blank, struct, true)).sort();
  check("suspect model columns are the structural encoding", JSON.stringify(cols) === JSON.stringify(m.cols) && m.w.length === cols.length);
  const flagged = m.human_scores.filter((p: number) => p > m.cutoff).length / m.human_scores.length;
  check("suspect cutoff flags at most 10% of pre-2022 human posts", flagged <= 0.1, flagged.toFixed(3));
}

// ---- statistics
{
  check("auc: perfect / reversed / ties", auc([2, 3], [0, 1]) === 1 && auc([0], [1]) === 0 && auc([1], [1]) === 0.5);
  check("macroF1: perfect is 1, all-one-class is 1/3 on a balanced pair", macroF1([0, 1], [0.1, 0.9]) === 1 && Math.abs(macroF1([0, 1, 0, 1], [1, 1, 1, 1]) - 1 / 3) < 1e-9);
  check("cohenD is 0 for identical groups", cohenD([1, 2, 3], [1, 2, 3]) === 0);
  check("kappa is 1 for identical labels", kappa(["a", "b", "a"], ["a", "b", "a"]) === 1);
  const [lo, hi] = clusterCI([1, 2, 3, 4].map((v) => ({ v, g: String(v) })), (x) => x.g, (xs) => xs.reduce((s, x) => s + x.v, 0) / xs.length, 500, 1);
  check("clusterCI brackets the mean", lo <= 2.5 && hi >= 2.5, `[${lo}, ${hi}]`);
}

console.log(failures ? `\n${failures} failing` : "\nall ok");
process.exit(failures ? 1 : 0);
