/**
 * Append-only JSONL records, keyed so a run resumes where it stopped.
 * A `.gz` path is written as one gzip member per row (a valid gzip stream:
 * members concatenate), because 307 answers a post is ~50 KB of JSON.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import type { Answer } from "../../shared/jev.js";
import type { Source } from "./corpus.js";

export interface Row {
  id: string;
  source: Source;
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
  ms: number;
}

export function load(path: string): Row[] {
  if (!existsSync(path)) return [];
  const buf = readFileSync(path);
  return (path.endsWith(".gz") ? gunzipSync(buf) : buf)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row);
}

/** The score legend repeats the question's own criteria on every row; drop it. */
function compact(a: Answer): Answer {
  if (a.type !== "score") return a;
  const { legend: _legend, ...rest } = a;
  return rest as Answer;
}

export function append(path: string, row: Row): void {
  mkdirSync(dirname(path), { recursive: true });
  const answers = Object.fromEntries(Object.entries(row.answers).map(([k, a]) => [k, compact(a)]));
  const line = `${JSON.stringify({ ...row, answers })}\n`;
  appendFileSync(path, path.endsWith(".gz") ? gzipSync(line) : line);
}

export const key = (r: { id: string; source: string }) => `${r.id}/${r.source}`;
