/**
 * Stage 5 with Jev as the scorer: every post against all 214 features, one
 * request per post (307 questions: 201 single-answer + 106 multi-select
 * values). Writes records/features.jsonl.gz; resumes on rerun.
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/score.ts [--sources human,titled,ai,reworded] [--repeat 1]
 *
 * `--repeat N` rescored the first 10 prompts N more times into
 * records/features-repeat.jsonl.gz (the release's repeatability check).
 * `--core` asks only the ten core features' questions (20: STR_STG_001 is a
 * multi-select of 11 values), one request per post, into records/core.jsonl.gz
 * —— does A0 depend on the other 287 questions sharing its request?
 */
import { resolve } from "node:path";

import { Jev } from "../../shared/jev.js";
import { RECORDS, SOURCES, type Source, corpus, prepared } from "./corpus.js";
import { coreSelection, instrument, questionsFor, stateFor } from "./instrument.js";
import { append, key, load } from "./records.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
};

const sources = (arg("sources")?.split(",") as Source[] | undefined) ?? SOURCES;
const repeat = Number(arg("repeat") ?? 0);
const limit = Number(arg("limit") ?? Infinity);
const concurrency = Number(arg("concurrency") ?? 4);
const coreOnly = process.argv.includes("--core");
const out = resolve(RECORDS, repeat ? "features-repeat.jsonl.gz" : coreOnly ? "core.jsonl.gz" : "features.jsonl.gz");

const jev = new Jev();
const coreIds = new Set(coreSelection().core_values.map((c) => c.split("__")[0]));
const questions = questionsFor(instrument().filter((f) => !coreOnly || coreIds.has(f.id)));
let docs = corpus(sources, !sources.every((s) => s === "human" || s === "titled"));
if (repeat) {
  const first = [...new Set(docs.map((d) => d.id))].slice(0, 10);
  docs = first.flatMap((id) => docs.filter((d) => d.id === id && (d.source === "human" || d.source === "ai")));
  docs = Array.from({ length: repeat }, (_, r) => docs.map((d) => ({ ...d, run: r }))).flat();
}
const done = new Map<string, number>();
for (const r of load(out)) done.set(key(r), (done.get(key(r)) ?? 0) + 1);
const seen = new Map<string, number>();
const todo = docs.filter((d) => {
  const k = key(d);
  seen.set(k, (seen.get(k) ?? 0) + 1);
  return seen.get(k)! > (done.get(k) ?? 0);
});
todo.splice(limit);
console.error(`${Object.keys(questions).length} questions, ${todo.length} posts to score -> ${out}`);

let next = 0;
async function worker() {
  while (next < todo.length) {
    const d = todo[next++];
    const t0 = Date.now();
    const r = await jev.ask(stateFor(prepared(d.raw)), questions);
    append(out, { id: d.id, source: d.source, model: r.model, answers: r.answers, usage: r.usage, ms: Date.now() - t0 });
    console.error(`  ${d.id} ${d.source.padEnd(8)} ${r.usage.input_tokens} tok ${Date.now() - t0} ms`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
console.error(`calls ${jev.calls}, input ${jev.inputTokens}, output ${jev.outputTokens}, retried ${jev.retriedCalls}`);
