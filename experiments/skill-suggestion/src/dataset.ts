/**
 * Build the labelled request set the evaluation needs.
 *
 * The cookbook evaluates on 488 requests, 315 covered by exactly one skill and
 * 173 covered by none. There is no such set for this repository, so it gets
 * generated: one request per skill, plus a batch of requests that no skill in
 * the roster should serve.
 *
 * The obvious hazard is leakage — a request written FROM a skill's description
 * tends to echo its wording, which makes the retrieval task easier than the
 * real one. The prompt pushes against that (write as a user who has not read
 * the roster, do not name the skill, do not reuse its phrasing), but the
 * effect cannot be removed this way, only reduced. Treat the absolute accuracy
 * numbers as optimistic; the comparison BETWEEN arms is what the experiment is
 * for, and both arms see the same requests.
 *
 *   npx tsx src/dataset.ts [--per-batch 8] [--none 22]
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import type { SkillEntry } from "./roster.js";

const run = promisify(execFile);

export interface Case {
  request: string;
  /** The skill that should be loaded, or null when none should be. */
  expect: string | null;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const MODEL = arg("gen-model", "claude-sonnet-5");

function extractJson(text: string): unknown {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error(`no JSON array in: ${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start, end + 1));
}

async function ask(prompt: string): Promise<string> {
  const res = await run("claude", ["-p", "--model", MODEL, prompt], {
    maxBuffer: 1 << 24,
    timeout: 300_000,
  });
  return res.stdout.trim();
}

/** One realistic request per skill in the batch. */
async function coveredBatch(batch: SkillEntry[]): Promise<Case[]> {
  const listing = batch
    .map((s, i) => `${i + 1}. ${s.name}\n   ${s.description}\n   opening: ${s.body.slice(0, 300)}`)
    .join("\n\n");
  const prompt = `
Here are ${batch.length} skills from an engineer's personal skill library. Each one is a
documented procedure an AI coding agent can load.

${listing}

For each skill, write ONE request that a developer might actually send to their
coding agent, where loading that skill would be the right move.

Rules:
- Write as the developer would write it, in the middle of their work. Concrete
  and specific: name real tools, files, error messages, or symptoms.
- The developer has NOT read the skill library and does not know these skills
  exist. Never mention the skill's name, and do not reuse its phrasing.
- Describe the SITUATION or the GOAL, not the procedure.
- Some of these skills are about Japanese-language workflows; match the
  language of the skill's own description where it is not English.
- One or two sentences.

Reply with ONLY a JSON array, no prose and no markdown fence:
[{"skill": "<exact skill name>", "request": "<the request>"}, ...]
`.trim();
  const parsed = extractJson(await ask(prompt)) as { skill: string; request: string }[];
  const valid = new Set(batch.map((s) => s.name));
  return parsed
    .filter((p) => p && typeof p.request === "string" && valid.has(p.skill))
    .map((p) => ({ request: p.request, expect: p.skill }));
}

/** Requests that no skill in this roster should be loaded for. */
async function uncoveredBatch(roster: SkillEntry[], count: number): Promise<Case[]> {
  const names = roster.map((s) => `${s.name}: ${s.description.slice(0, 90)}`).join("\n");
  const prompt = `
An AI coding agent has this skill library:

${names}

Write ${count} requests a developer might send to that agent where loading ANY of
those skills would be a mistake — the agent should just answer, or just do the
work, with no skill.

Cover a spread of these kinds:
- conceptual questions ("why does X happen", "what is the difference between A and B")
- tiny mechanical edits ("rename this variable", "add a type annotation here")
- requests about technologies nowhere in the library
- chat, scheduling, or non-technical asks
- requests so vague that no procedure could apply

Rules:
- Concrete and natural, as a developer would type it. One or two sentences.
- Do NOT make them accidentally match a skill above. Read the list first.
- Vary the language: write roughly a third of them in Japanese.

Reply with ONLY a JSON array, no prose and no markdown fence:
[{"request": "<the request>"}, ...]
`.trim();
  const parsed = extractJson(await ask(prompt)) as { request: string }[];
  return parsed
    .filter((p) => p && typeof p.request === "string")
    .map((p) => ({ request: p.request, expect: null }));
}

async function main() {
  const roster = JSON.parse(readFileSync("out/roster.json", "utf8")) as SkillEntry[];
  const perBatch = Number.parseInt(arg("per-batch", "8"), 10);
  const noneCount = Number.parseInt(arg("none", "22"), 10);
  mkdirSync("out", { recursive: true });
  const CACHE = "out/dataset.json";
  const cases: Case[] = existsSync(CACHE) && process.argv.includes("--resume")
    ? (JSON.parse(readFileSync(CACHE, "utf8")) as Case[])
    : [];
  const done = new Set(cases.filter((c) => c.expect).map((c) => c.expect as string));
  const todo = roster.filter((s) => !done.has(s.name));
  console.log(`${roster.length} skills, ${done.size} already have a request, ${todo.length} to go`);

  for (let i = 0; i < todo.length; i += perBatch) {
    const batch = todo.slice(i, i + perBatch);
    try {
      const got = await coveredBatch(batch);
      cases.push(...got);
      writeFileSync(CACHE, JSON.stringify(cases, null, 2));
      console.log(`  covered ${i + batch.length}/${todo.length}  (+${got.length})`);
    } catch (err) {
      console.warn(`  batch at ${i} failed: ${String(err).slice(0, 160)}`);
    }
  }

  const haveNone = cases.filter((c) => c.expect === null).length;
  if (haveNone < noneCount) {
    try {
      const got = await uncoveredBatch(roster, noneCount - haveNone);
      cases.push(...got);
      writeFileSync(CACHE, JSON.stringify(cases, null, 2));
      console.log(`  uncovered +${got.length}`);
    } catch (err) {
      console.warn(`  uncovered batch failed: ${String(err).slice(0, 160)}`);
    }
  }

  const covered = cases.filter((c) => c.expect).length;
  console.log("");
  console.log(`${cases.length} cases: ${covered} covered by one skill, ${cases.length - covered} covered by none`);
  console.log(`written to ${CACHE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
