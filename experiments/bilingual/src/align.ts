/**
 * The parallel corpus, and the deterministic half of the check.
 *
 * The pair is real: `eslint-plugin-jev/README.md` and its `README.ja.md`,
 * written for this repository and 1,244 lines between them. They are aligned
 * by heading ORDER rather than by heading text, because the headings are
 * translated too ("Contents" / "目次") -- and that they align at all is an
 * invariant the test checks rather than something to assume.
 *
 * What rules can do here, rules do (docs/23 §5, docs/27 §3): a number that
 * appears on one side and not the other is a diff, not a judgment, and so is
 * a backticked identifier. Those checks are the baseline the judgment has to
 * beat, and they are free.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface Section {
  index: number;
  level: number;
  title: string;
  body: string;
}

export interface Pair {
  index: number;
  /** Heading level, which must match across the two sides. */
  level: number;
  enTitle: string;
  jaTitle: string;
  en: string;
  ja: string;
}

/**
 * Split a Markdown document into sections.
 *
 * Fence-aware, because the first version was not: `# 1. Ask.` inside a bash
 * block became four extra "sections" and the two sides still aligned, which
 * is the kind of agreement that hides a bug.
 */
export function sections(markdown: string): Section[] {
  const out: Section[] = [];
  let current: { level: number; title: string; lines: string[] } | null = null;
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      if (current) out.push({ index: out.length, level: current.level, title: current.title, body: current.lines.join("\n").trim() });
      current = { level: heading[1].length, title: heading[2].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) out.push({ index: out.length, level: current.level, title: current.title, body: current.lines.join("\n").trim() });
  return out;
}

export interface Corpus {
  pairs: Pair[];
  enWhole: string;
  jaWhole: string;
  source: { en: string; ja: string };
}

export function loadCorpus(root = resolve(import.meta.dirname, "../../..")): Corpus {
  const enPath = resolve(root, "experiments/eslint-plugin-jev/README.md");
  const jaPath = resolve(root, "experiments/eslint-plugin-jev/README.ja.md");
  const enWhole = readFileSync(enPath, "utf8");
  const jaWhole = readFileSync(jaPath, "utf8");
  const en = sections(enWhole);
  const ja = sections(jaWhole);
  if (en.length !== ja.length) {
    throw new Error(`the two documents no longer align: ${en.length} sections against ${ja.length}`);
  }
  const pairs = en.map((e, i) => ({
    index: i,
    level: e.level,
    enTitle: e.title,
    jaTitle: ja[i].title,
    en: e.body,
    ja: ja[i].body,
  }));
  return { pairs, enWhole, jaWhole, source: { en: "README.md", ja: "README.ja.md" } };
}

// ------------------------------------------------------------------ the rules

/**
 * Spelled-out English numbers, because this is where a digit diff dies.
 *
 * English documentation writes "one request per file"; the Japanese
 * translation writes "1 リクエスト". Comparing digits across the two then
 * reports a difference on almost every section -- a false positive produced
 * by orthography rather than by drift. Normalising the English side is the
 * cheap half of the fix; the expensive half ("a third" against "33%") is
 * still out of reach for a regex, which is §1's finding.
 */
const SPELLED: Record<string, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
};

/** Numbers with their unit glued on, which is how documentation states them. */
export function numbersIn(text: string, opts: { spelled?: boolean } = {}): string[] {
  let stripped = text.replace(/```[\s\S]*?```/g, " ");
  if (opts.spelled) {
    for (const [word, digit] of Object.entries(SPELLED)) {
      stripped = stripped.replace(new RegExp(`\\b${word}\\b`, "gi"), digit);
    }
  }
  const found = stripped.match(/\$?\d[\d,]*(?:\.\d+)?\s?(?:%|ms|s\b|K|Ki|MB|GB|x\b)?/g) ?? [];
  return found.map((n) => n.replace(/\s+/g, "").replace(/,/g, "")).filter((n) => n !== "");
}

/**
 * The numbers worth comparing.
 *
 * A bare small integer in prose is orthography, not a measurement: English
 * writes "one of the two ways" and Japanese writes "2 通りのうちの 1 つ", and
 * neither is wrong. What has to match is a MEASUREMENT -- something with a
 * unit, a decimal, a percent, a currency, or three digits. Defined by what
 * the number is rather than by which mutation it catches, which is why one of
 * docs/28's planted edits slips past it (§1).
 */
export function significantNumbers(text: string, opts: { spelled?: boolean } = {}): string[] {
  return numbersIn(text, opts).filter((n) => /[.%$]|ms|Ki|K|MB|GB|x$/.test(n) || Number(n.replace(/[^\d.]/g, "")) >= 100);
}

/** Backticked tokens: option names, rule ids, file names. */
export function identifiersIn(text: string): string[] {
  const found = text.match(/`[^`\n]{1,60}`/g) ?? [];
  return found.map((s) => s.slice(1, -1).trim());
}

const bag = (xs: string[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};

/** Multiset difference, so "three mentions of 0.5" is not the same as one. */
function missing(a: string[], b: string[]): string[] {
  const have = bag(b);
  const out: string[] = [];
  for (const x of a) {
    const n = have.get(x) ?? 0;
    if (n === 0) out.push(x);
    else have.set(x, n - 1);
  }
  return out;
}

export interface RuleVerdict {
  /** Numbers the English side states and the Japanese one does not. */
  numbersMissing: string[];
  numbersExtra: string[];
  identifiersMissing: string[];
  identifiersExtra: string[];
  /** Japanese characters per English character. Japanese is denser. */
  lengthRatio: number;
  /** The rules' own answer: does anything here look diverged? */
  diverged: boolean;
}

/**
 * The deterministic check.
 *
 * `ratioBand` is the one typed-in number: Japanese prose covering the same
 * content runs shorter per character, and how much shorter is a property of
 * the writer rather than of the language. It is fitted on THIS corpus's
 * median in `run.ts` rather than guessed here.
 */
export function checkPair(pair: Pair, ratioBand: { lo: number; hi: number }): RuleVerdict {
  const enNumbers = significantNumbers(pair.en, { spelled: true });
  const jaNumbers = significantNumbers(pair.ja);
  const numbersMissing = missing(enNumbers, jaNumbers);
  const numbersExtra = missing(jaNumbers, enNumbers);
  const identifiersMissing = missing(identifiersIn(pair.en), identifiersIn(pair.ja));
  const identifiersExtra = missing(identifiersIn(pair.ja), identifiersIn(pair.en));
  const lengthRatio = pair.en.length === 0 ? 1 : pair.ja.length / pair.en.length;
  return {
    numbersMissing,
    numbersExtra,
    identifiersMissing,
    identifiersExtra,
    lengthRatio,
    diverged:
      numbersMissing.length > 0 ||
      numbersExtra.length > 0 ||
      identifiersMissing.length > 0 ||
      identifiersExtra.length > 0 ||
      lengthRatio < ratioBand.lo ||
      lengthRatio > ratioBand.hi,
  };
}
