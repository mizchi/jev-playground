/**
 * Jev as the detector itself: one noul per arm, "an AI model wrote this",
 * with more of the paper handed over as context in each arm. No arm is shown
 * a single labelled example from this corpus, so nothing here is fitted.
 *
 *   bare    the question alone
 *   shape   + the paper's §6 description of the AI shape, in prose
 *   core    + the ten core values of the paper's Table 6, each as the
 *             question the instrument asks and the answer that leans AI
 *             or human (read from the release, not retyped)
 *
 * All three arms go in one request per post: the state is the same, and a
 * noul is answered per question. Writes records/judge.jsonl.gz; resumes.
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/judge.ts [--sources ...]
 */
import { resolve } from "node:path";

import { Jev, type Question } from "../../shared/jev.js";
import { RECORDS, SOURCES, type Source, corpus, prepared } from "./corpus.js";
import { coreSelection, instrument, label } from "./instrument.js";
import { append, key, load } from "./records.js";

const CLAIM = "This blog post was written by an AI language model, not by a human author.";

/** Paper §6, close to its own words (the human side is its last sentence there). */
const SHAPE = [
  "AI-written company blog posts share a tidy, self-announcing shape.",
  "They promise the payoff already in the title; they state the thesis and announce the flow of the post before the first section",
  '("In this post, we\'ll cover ..."); they speak in an editorial-explainer voice; and they close with a section that summarizes',
  "or restates the thesis. Human-written posts lack those signposts: no announced section flow, no escalation of stakes,",
  "and no closing section that restates the thesis. Human posts also tend to take structural shapes that are rare, where AI posts share the common ones.",
].join(" ");

function coreContext(): string {
  const byId = new Map(instrument().map((f) => [f.id, f]));
  const core = coreSelection();
  const lines = core.core_values.map((cv) => {
    const [id, value] = cv.split("__");
    const f = byId.get(id)!;
    const lean = core.value_signs[cv] === "ai" ? "AI" : "a human";
    const answer =
      value === "ord"
        ? `a later answer on this ordered list leans towards ${lean}: ${f.values.map(label).join(" < ")}`
        : `the answer "${label(value)}" leans towards ${lean} author`;
    return `- ${f.question} -> ${answer}.`;
  });
  return `Ten structural signals separate AI-written from human-written company blog posts:\n${lines.join("\n")}`;
}

export function judgeQuestions(): Record<string, Question> {
  const criteria = { true: "Written by an AI language model", false: "Written by a human author" };
  return {
    bare: { type: "noul", instructions: CLAIM, criteria },
    shape: { type: "noul", instructions: `${SHAPE}\n\n${CLAIM}`, criteria },
    core: { type: "noul", instructions: `${coreContext()}\n\n${CLAIM}`, criteria },
  };
}

export const ARMS = ["bare", "shape", "core"] as const;

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf("--sources");
  const sources = i < 0 ? SOURCES : (process.argv[i + 1].split(",") as Source[]);
  const out = resolve(RECORDS, "judge.jsonl.gz");
  const jev = new Jev();
  const qs = judgeQuestions();
  const done = new Set(load(out).map(key));
  const todo = corpus(sources, !sources.every((s) => s === "human" || s === "titled")).filter((d) => !done.has(key(d)));
  console.error(`${todo.length} posts to judge -> ${out}`);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const d = todo[next++];
      const t0 = Date.now();
      const r = await jev.ask(`A company blog post.\n\nPOST:\n${prepared(d.raw)}`, qs);
      append(out, { id: d.id, source: d.source, model: r.model, answers: r.answers, usage: r.usage, ms: Date.now() - t0 });
      const s = ARMS.map((a) => (r.answers[a] as { noul: number }).noul.toFixed(2)).join(" ");
      console.error(`  ${d.id} ${d.source.padEnd(8)} ${s}`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  console.error(`calls ${jev.calls}, input ${jev.inputTokens}, output ${jev.outputTokens}`);
}
