/**
 * The corpus this replication runs on, and the one normalizer every source
 * goes through before any judgment sees it.
 *
 * Three sources per prompt, keyed by the release's doc_id:
 *   human     data/human/<id>.json      live-fetched, gitignored (copyrighted)
 *   ai        data/mirrors/<id>.md      written from the brief alone
 *   reworded  data/reworded/<id>.md     the mirror, rewritten by its own writer
 *   titled    the human post with its title line put back (control arm, L4)
 *
 * `normalize` re-implements the release's study_b/normalize.py rule for rule
 * (markdown stripped, standalone furniture lines dropped), and `prepared`
 * adds what its scorer does on top: whitespace-joined, first 2,600 tokens.
 * AI writes markdown and extracted HTML does not, so keeping the markup would
 * let any judge "detect" the extraction pipeline instead of the writer.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REL = resolve(ROOT, "vendor/slopshape");
export const DATA = resolve(ROOT, "data");
export const RECORDS = resolve(ROOT, "records");

export type Source = "human" | "titled" | "ai" | "reworded";
export const SOURCES: Source[] = ["human", "titled", "ai", "reworded"];
/** Which sources are human-written, for every metric. */
export const isHuman = (s: Source) => s === "human" || s === "titled";

export interface Doc {
  id: string;
  domain: string;
  vertical: string;
  source: Source;
  /** Raw text as fetched or generated, before normalization. */
  raw: string;
}

const MD_RULES: [RegExp, string][] = [
  [/^\s{0,3}#{1,6}\s+/gm, ""],
  [/\*\*([^*\n]+)\*\*/g, "$1"],
  [/__([^_\n]+)__/g, "$1"],
  [/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1"],
  [/^\s{0,4}[-*+]\s+/gm, ""],
  [/^\s{0,4}\d+[.)]\s+/gm, ""],
  [/^\s{0,3}>\s?/gm, ""],
  [/`([^`\n]*)`/g, "$1"],
  [/!\[[^\]]*\]\([^)]*\)/g, ""],
  [/\[([^\]]+)\]\([^)]*\)/g, "$1"],
  [/^\s*([-*_])\s*(\1\s*){2,}$/gm, ""],
];

const FURNITURE = new RegExp(
  "^\\s*(?:" +
    "table of contents" +
    "|(?:share|subscribe|sign up|follow us|related (?:posts?|articles?)|read more)\\b.{0,40}" +
    "|by\\s+[A-Z][\\w.'-]+(?:\\s+[A-Z][\\w.'-]+){0,3}" +
    "|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{4}" +
    "|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\\s+.{0,24}\\d{4}" +
    "|\\d{1,2}\\s*min(?:ute)?s?\\s+read" +
    "|\\d+\\s*(?:comments?|shares?|likes?)" +
    ")\\s*$",
  "i",
);
const MAX_FURNITURE_WORDS = 9;

const words = (s: string) => s.split(/\s+/).filter(Boolean);

export function normalize(text: string): string {
  for (const [re, rep] of MD_RULES) text = text.replace(re, rep);
  text = text
    .split("\n")
    .filter((l) => !(words(l).length <= MAX_FURNITURE_WORDS && FURNITURE.test(l)))
    .join("\n");
  return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** What a judge is shown: normalized, whitespace-joined, first 2,600 tokens. */
export function prepared(raw: string): string {
  return words(normalize(raw)).slice(0, 2600).join(" ");
}

export function wordCount(raw: string): number {
  return words(normalize(raw)).length;
}

interface HumanFile {
  doc_id: string;
  domain: string;
  vertical: string;
  title: string;
  manifest_words: number;
  text: string;
}

export function humans(): HumanFile[] {
  const dir = resolve(DATA, "human");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(resolve(dir, f), "utf8")) as HumanFile);
}

/**
 * The human post as the release's corpus holds it: trafilatura's `text` is
 * the body without the title, and study_b/r5_apply.py scores `story_human`
 * with nothing prepended. The mirror begins with a title line because the
 * mirror prompt asks for one, and normalization keeps it. So in the release
 * the scorer sees a title on every AI post and on no human post, and one of
 * its ten core values is "payoff first promised in the title" (AI-leaning).
 * `titled` puts the title back so the effect of that asymmetry is measured.
 */
export function humanRaw(h: HumanFile, titled = false): string {
  return titled ? `${h.title}\n\n${h.text}` : h.text;
}

/**
 * Every doc whose file exists, in a stable order. By default only prompts
 * that have a mirror count, so every metric compares matched pairs.
 */
export function corpus(sources: Source[] = SOURCES, requireMirror = true): Doc[] {
  const out: Doc[] = [];
  for (const h of humans()) {
    const mirror = resolve(DATA, "mirrors", `${h.doc_id}.md`);
    if (requireMirror && !existsSync(mirror)) continue;
    const base = { id: h.doc_id, domain: h.domain, vertical: h.vertical };
    for (const source of sources) {
      if (isHuman(source)) {
        out.push({ ...base, source, raw: humanRaw(h, source === "titled") });
        continue;
      }
      const path = resolve(DATA, source === "ai" ? "mirrors" : "reworded", `${h.doc_id}.md`);
      if (existsSync(path)) out.push({ ...base, source, raw: readFileSync(path, "utf8") });
    }
  }
  return out;
}

/**
 * What eval needs to know about the corpus without its text (the human posts
 * are not committed): ids, companies, and every source's normalized length.
 * Written by src/prompts.ts to records/corpus.json.
 */
export interface IndexEntry {
  id: string;
  domain: string;
  vertical: string;
  words: Partial<Record<Source, number>>;
}

export function buildIndex(): IndexEntry[] {
  const byId = new Map<string, IndexEntry>();
  for (const d of corpus(SOURCES, false)) {
    const e = byId.get(d.id) ?? { id: d.id, domain: d.domain, vertical: d.vertical, words: {} };
    e.words[d.source] = wordCount(d.raw);
    byId.set(d.id, e);
  }
  return [...byId.values()];
}

export function loadIndex(): IndexEntry[] {
  return JSON.parse(readFileSync(resolve(RECORDS, "corpus.json"), "utf8"));
}

/** A `"""..."""` constant out of one of the release's Python files. */
export function pythonConstant(file: string, name: string): string {
  const src = readFileSync(resolve(REL, file), "utf8");
  const m = src.match(new RegExp(`^${name}\\s*=\\s*"""([\\s\\S]*?)"""`, "m"));
  if (!m) throw new Error(`${name} not found in ${file}`);
  // Python's backslash-newline inside a triple-quoted string joins the lines.
  return m[1].replace(/\\\n/g, "");
}

export function pythonString(file: string, name: string): string {
  const src = readFileSync(resolve(REL, file), "utf8");
  const m = src.match(new RegExp(`^${name}\\s*=\\s*\\(([\\s\\S]*?)\\)`, "m"));
  if (!m) throw new Error(`${name} not found in ${file}`);
  return [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]).join("");
}
