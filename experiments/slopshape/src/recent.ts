/**
 * Score the 2023+ posts (docs/66 §9) with the same three requests every
 * pre-2022 post got, in the same form: body text only, no title, because the
 * detectors were fitted on human posts scored that way.
 *
 *   features  307 questions   -> records/recent-features.jsonl.gz
 *   core      20 questions    -> records/recent-core.jsonl.gz
 *   judge     3 noul arms     -> records/recent-judge.jsonl.gz
 *
 * Also writes records/recent.json (id, company, date, words; no text) so the
 * report runs without data/recent/. Resumes on rerun.
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/recent.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { Jev, type Question } from "../../shared/jev.js";
import { RECORDS, prepared, recents, wordCount } from "./corpus.js";
import { coreSelection, instrument, questionsFor, stateFor } from "./instrument.js";
import { judgeQuestions } from "./judge.js";
import { append, load } from "./records.js";

const posts = recents();
writeFileSync(
  resolve(RECORDS, "recent.json"),
  `${JSON.stringify(posts.map((p) => ({ id: p.id, domain: p.domain, url: p.url, date: p.date, words: wordCount(p.text) })), null, 1)}\n`,
);

const coreIds = new Set(coreSelection().core_values.map((c) => c.split("__")[0]));
const all = instrument();
const kinds: [string, Record<string, Question>, (t: string) => string][] = [
  ["features", questionsFor(all), stateFor],
  ["core", questionsFor(all.filter((f) => coreIds.has(f.id))), stateFor],
  ["judge", judgeQuestions(), (t) => `A company blog post.\n\nPOST:\n${t}`],
];

const jev = new Jev();
for (const [kind, qs, state] of kinds) {
  const out = resolve(RECORDS, `recent-${kind}.jsonl.gz`);
  const done = new Set(load(out).map((r) => r.id));
  const todo = posts.filter((p) => !done.has(p.id));
  console.error(`${kind}: ${todo.length} posts, ${Object.keys(qs).length} questions`);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const p = todo[next++];
      const t0 = Date.now();
      const r = await jev.ask(state(prepared(p.text)), qs);
      append(out, { id: p.id, source: "recent", model: r.model, answers: r.answers, usage: r.usage, ms: Date.now() - t0 });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
}
console.error(`calls ${jev.calls}, input ${jev.inputTokens}, output ${jev.outputTokens}, retried ${jev.retriedCalls}`);
