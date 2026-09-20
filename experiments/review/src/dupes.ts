/**
 * `similarity-ts` over this repository's own experiments.
 *
 *   npx tsx src/dupes.ts
 *
 * docs/33's own corpus is twenty-one modules of two-to-six-line functions,
 * and the tool reports nothing on any of them -- its default minimum is
 * three lines and lowering it to one changes nothing, because short
 * functions with different bodies are not near-duplicates. That is a real
 * result about the corpus, not about the tool.
 *
 * So the tool gets pointed at code where it can say something: the 179
 * TypeScript and JavaScript files under `experiments/`, which is code I
 * wrote. Each pair gets a MECHANICAL label -- are the two function bodies
 * the same once whitespace and the function's own name are normalised --
 * which is a thing a review would otherwise have to eyeball.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../..");
const BIN = process.env.SIMILARITY_TS ?? `${process.env.HOME}/.cargo/bin/similarity-ts`;
const THRESHOLD = Number(process.env.SIMILARITY_THRESHOLD ?? "0.85");

export interface Pair {
  similarity: number;
  a: string;
  b: string;
  /** The two bodies are the same once whitespace and comments are removed. */
  identical: boolean;
  /**
   * The same once every identifier is also replaced by its position -- so a
   * pure rename counts, and a different field name does not.
   *
   * This is the label that turned out to matter. `similarity-ts` reports a
   * 100% match for two functions with the same AST shape and completely
   * different bodies, so "100%" is a statement about STRUCTURE. Whether the
   * two are the same code is a separate, mechanical question.
   */
  alphaEquivalent: boolean;
  lines: number;
}

/** `path:from-to name` -> the function's text. */
function textAt(spec: string): string | null {
  const m = /^(.+):(\d+)-(\d+)$/.exec(spec);
  if (!m) return null;
  try {
    const lines = readFileSync(resolve(ROOT, m[1]), "utf8").split("\n");
    return lines.slice(Number(m[2]) - 1, Number(m[3])).join("\n");
  } catch {
    return null;
  }
}

/** Whitespace out, the leading name out: what is left is the body's shape. */
export function normalise(text: string): string {
  return text
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*(export\s+)?(async\s+)?function\s+[A-Za-z_$][\w$]*/, "function")
    .replace(/\s+/g, " ")
    .trim();
}

const KEYWORDS = new Set([
  "function", "const", "let", "var", "return", "if", "else", "for", "of", "in", "while",
  "await", "async", "new", "true", "false", "null", "undefined", "typeof", "this", "throw",
  "try", "catch", "finally", "break", "continue", "export", "import", "from", "default",
  "class", "extends", "super", "yield", "void", "delete", "instanceof", "case", "switch",
]);

/**
 * Type annotations out.
 *
 * Needed because half this repository is `.ts` and half is `.mjs`, and the
 * pair that made the point is `auc` written twice -- once with
 * `(pairs: Pair[]): number` and once with `(pairs)`. Without this the
 * mechanical check calls a real duplicate "different", which is exactly the
 * mistake it exists to prevent.
 */
export function stripTypes(text: string): string {
  return text
    .replace(/:\s*[A-Za-z_$][\w$.]*(?:<[^<>]*>)?(?:\[\])?(?:\s*\|\s*[A-Za-z_$][\w$.]*(?:\[\])?)*/g, "")
    .replace(/\bas\s+[A-Za-z_$][\w$.]*(?:\[\])?/g, "")
    .replace(/[!?](?=[,)\s])/g, "");
}

/**
 * Every identifier replaced by its position, so a pure rename normalises away.
 *
 * PROPERTY names are left alone. `items.length` and `items.size` are not the
 * same code, and a version of this that renamed both to `v1.v2` said they
 * were -- caught by a test rather than by a reading, which is the only
 * reason the distinction is here.
 */
export function alphaNormalise(text: string): string {
  const seen = new Map<string, string>();
  return stripTypes(normalise(text)).replace(/(\.?)([A-Za-z_$][\w$]*)/g, (whole, dot: string, word: string) => {
    if (dot === ".") return whole;
    if (KEYWORDS.has(word)) return whole;
    if (!seen.has(word)) seen.set(word, `v${seen.size}`);
    return seen.get(word)!;
  });
}

export function parse(out: string): Pair[] {
  const pairs: Pair[] = [];
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^Similarity:\s*([\d.]+)%.*\(lines\s*([\d~]+)/.exec(lines[i].trim());
    if (!head) continue;
    const a = lines[i + 1]?.trim().split(/\s+/)[0];
    const b = lines[i + 2]?.trim().split(/\s+/)[0];
    if (!a || !b) continue;
    const ta = textAt(a);
    const tb = textAt(b);
    pairs.push({
      similarity: Number(head[1]) / 100,
      a,
      b,
      identical: ta !== null && tb !== null && normalise(ta) === normalise(tb),
      alphaEquivalent: ta !== null && tb !== null && alphaNormalise(ta) === alphaNormalise(tb),
      lines: Number(head[2].split("~")[0]),
    });
  }
  return pairs;
}

function main(): void {
  let out = "";
  try {
    out = execFileSync(BIN, ["experiments", "--threshold", String(THRESHOLD)], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    console.error(`could not run ${BIN}: ${String(err).slice(0, 160)}`);
    console.error("install it with `cargo install similarity-ts`, or set SIMILARITY_TS");
    process.exit(2);
  }
  const pairs = parse(out).sort((x, y) => y.similarity - x.similarity || y.lines - x.lines);
  const path = resolve(import.meta.dirname, "../records/duplicates.json");
  writeFileSync(path, `${JSON.stringify({ bin: BIN, threshold: THRESHOLD, pairs }, null, 2)}\n`);
  console.log(
    `  ${pairs.length} pairs at threshold ${THRESHOLD}, ${pairs.filter((p) => p.identical).length} identical, ` +
      `${pairs.filter((p) => p.alphaEquivalent).length} the same up to renaming`,
  );
  for (const p of pairs.slice(0, 12)) {
    const label = p.identical ? "identical" : p.alphaEquivalent ? "renamed  " : "different";
    console.log(`  ${(100 * p.similarity).toFixed(0)}% ${label} ${p.a}  ~  ${p.b}`);
  }
  console.log(`  -> ${path}`);
}

if (process.argv[1]?.endsWith("dupes.ts")) main();
