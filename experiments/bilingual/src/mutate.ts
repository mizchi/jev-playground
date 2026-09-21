/**
 * Eight ways a translation can drift, six of them wrong and two of them fine.
 *
 * The two harmless ones are the point. docs/26 measured what happens when a
 * corpus has no version of the shape that is DELIBERATE: the rule fires on
 * healthy code and the false positives are invisible until you run it on
 * something real. A paraphrase and a reflowed list are what a translator
 * legitimately does, so they are in the corpus with a label that says so.
 *
 * Every mutation is a deterministic string edit on the Japanese side, and
 * `apply` returns null when the pattern is not in that section -- so the
 * corpus builder can walk sections until each class lands somewhere, and the
 * record says where it landed.
 */
import type { Pair } from "./align.js";

export type Verdict = "diverged" | "equivalent";

export interface Mutation {
  id: string;
  verdict: Verdict;
  blurb: string;
  apply: (ja: string) => string | null;
}

/** Replace the first match, or return null if there is nothing to replace. */
const swap = (ja: string, pattern: RegExp, to: string): string | null => {
  const m = pattern.exec(ja);
  if (!m) return null;
  return ja.slice(0, m.index) + to + ja.slice(m.index + m[0].length);
};

/** Sentences, Japanese style: split on the full stop and keep it. */
export function sentencesOf(ja: string): string[] {
  return ja
    .split("\n")
    .flatMap((line) => line.split(/(?<=。)/))
    .filter((s) => s.trim().length > 0);
}

/** Character ranges inside ``` fences, which are examples rather than prose. */
function fencedRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  const re = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push([m.index, m.index + m[0].length]);
  return out;
}

const inFence = (ranges: [number, number][], at: number): boolean =>
  ranges.some(([lo, hi]) => at >= lo && at < hi);

export const MUTATIONS: Mutation[] = [
  {
    id: "number_changed",
    verdict: "diverged",
    blurb: "a measurement in the prose is wrong (digits transposed)",
    apply: (ja) => {
      // SECOND DRAFT. The first took the first two-digit run anywhere, and it
      // landed on a line number inside an example lint output ("13:8" ->
      // "31:8"). The model caught it 3/3 and the label was still weak: two
      // documents showing different sample output is a divergence nobody
      // cares about. This one only touches a MEASUREMENT (a decimal, a
      // percent, a millisecond count) and only outside code fences.
      const ranges = fencedRanges(ja);
      const re = /(\d+\.\d+)|(\d{2,}) ?(?:%|ms)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(ja)) !== null) {
        if (inFence(ranges, m.index)) continue;
        const digits = (m[1] ?? m[2]).replace(".", "");
        if (digits.length < 2) continue;
        const flippedDigits = digits[1] + digits[0] + digits.slice(2);
        if (flippedDigits === digits) continue;
        const original = m[1] ?? m[2];
        const flipped = m[1]
          ? `${flippedDigits.slice(0, m[1].indexOf("."))}.${flippedDigits.slice(m[1].indexOf("."))}`
          : flippedDigits;
        return ja.slice(0, m.index) + flipped + ja.slice(m.index + original.length);
      }
      return null;
    },
  },
  {
    id: "number_changed_v1",
    verdict: "diverged",
    blurb: "FIRST DRAFT: any two-digit run, which landed inside an example",
    apply: (ja) => {
      const m = /(?<![\d.])(\d{2,})(?![\d.])/.exec(ja);
      if (!m) return null;
      const digits = m[1];
      const flipped = digits.length >= 2 ? digits[1] + digits[0] + digits.slice(2) : digits;
      if (flipped === digits) return null;
      return ja.slice(0, m.index) + flipped + ja.slice(m.index + digits.length);
    },
  },
  {
    id: "negation_flipped",
    verdict: "diverged",
    blurb: "a negated statement is affirmed",
    apply: (ja) =>
      swap(ja, /しません。/, "します。") ??
      swap(ja, /ではありません。/, "です。") ??
      swap(ja, /ありません。/, "あります。") ??
      swap(ja, /不要です。/, "必要です。") ??
      null,
  },
  {
    id: "omission",
    verdict: "diverged",
    blurb: "a sentence the English side states is missing",
    apply: (ja) => {
      const sentences = sentencesOf(ja);
      // Drop the longest sentence: the one most likely to carry a claim.
      const target = [...sentences].sort((a, b) => b.length - a.length)[0];
      if (!target || target.length < 30) return null;
      const out = ja.replace(target, "");
      return out === ja ? null : out;
    },
  },
  {
    id: "addition",
    verdict: "diverged",
    blurb: "the Japanese side states something the English side does not",
    apply: (ja) => {
      if (ja.trim().length === 0) return null;
      return `${ja}\n\nなお、この機能は次のリリースで廃止される予定です。`;
    },
  },
  {
    id: "claim_strength",
    verdict: "diverged",
    blurb: "a hedged claim becomes an absolute one",
    // SECOND DRAFT, and the first one is kept below because it is the more
    // interesting of the two: it scored 0.14 and the model was RIGHT.
    apply: (ja) =>
      swap(ja, /ことがあります/, "ことが必ず起きます") ??
      swap(ja, /場合がある/, "場合が必ずある") ??
      swap(ja, /可能性があります/, "必ずそうなります") ??
      null,
  },
  {
    id: "claim_strength_v1",
    verdict: "diverged",
    blurb: "FIRST DRAFT: `ほとんど` -> `すべて`, which barely moved the claim",
    apply: (ja) => swap(ja, /ほとんど/, "すべて") ?? swap(ja, /多くの/, "すべての") ?? null,
  },
  {
    id: "terminology",
    verdict: "diverged",
    blurb: "an identifier is swapped for a different real one",
    apply: (ja) =>
      swap(ja, /`jev\/quality`/, "`jev/rule`") ??
      swap(ja, /`reportAt`/, "`bugAt`") ??
      swap(ja, /`--rubric`/, "`--arm`") ??
      swap(ja, /`noul`/, "`score`") ??
      null,
  },

  // ------------------------------------------------------------ and the two
  // that a translator is allowed to do.
  {
    id: "paraphrase",
    verdict: "equivalent",
    blurb: "the same statements, differently worded",
    apply: (ja) => {
      const rules: [RegExp, string][] = [
        [/できます。/g, "可能です。"],
        [/ただし/g, "しかし"],
        [/たとえば/g, "例えば"],
        [/そのため/g, "したがって"],
        [/という/g, "といった"],
      ];
      let out = ja;
      let changed = 0;
      for (const [from, to] of rules) {
        if (from.test(out)) {
          out = out.replace(from, to);
          changed += 1;
        }
      }
      return changed >= 1 && out !== ja ? out : null;
    },
  },
  {
    id: "reflowed",
    verdict: "equivalent",
    blurb: "a bullet list written out as a paragraph",
    apply: (ja) => {
      const lines = ja.split("\n");
      const bullets = lines.filter((l) => /^\s*[-*]\s+/.test(l));
      if (bullets.length < 3) return null;
      const first = lines.findIndex((l) => /^\s*[-*]\s+/.test(l));
      const flowed = bullets.map((l) => l.replace(/^\s*[-*]\s+/, "").trim()).join("。").replace(/。。/g, "。");
      const kept = lines.filter((l) => !/^\s*[-*]\s+/.test(l));
      kept.splice(first, 0, `${flowed}。`);
      return kept.join("\n");
    },
  },
];

export interface Subject {
  id: string;
  /** Which aligned section this is about. */
  pairIndex: number;
  enTitle: string;
  en: string;
  ja: string;
  /** "original" for an untouched pair, else the mutation id. */
  mutation: string;
  verdict: Verdict;
}

/**
 * Build the labelled corpus: every untouched pair, plus one instance of each
 * mutation, planted in the first section where its pattern exists.
 *
 * The untouched pairs are labelled `equivalent` on the ASSUMPTION that the
 * real translation is faithful, which is exactly the assumption the findings
 * run tests -- so a false positive there is read rather than counted (docs/28
 * §4).
 */
export function buildSubjects(pairs: Pair[], minChars = 400): { subjects: Subject[]; unplanted: string[] } {
  const usable = pairs.filter((p) => p.en.length >= minChars && p.ja.length >= minChars);
  const subjects: Subject[] = usable.map((p) => ({
    id: `original:${p.index}`,
    pairIndex: p.index,
    enTitle: p.enTitle,
    en: p.en,
    ja: p.ja,
    mutation: "original",
    verdict: "equivalent" as Verdict,
  }));
  const unplanted: string[] = [];
  let cursor = 0;
  for (const mutation of MUTATIONS) {
    let planted = false;
    // Walk the sections in a rotating order so the mutations do not all land
    // in the same (longest) section.
    for (let i = 0; i < usable.length && !planted; i += 1) {
      const p = usable[(cursor + i) % usable.length];
      const ja = mutation.apply(p.ja);
      if (ja === null || ja === p.ja) continue;
      subjects.push({
        id: `${mutation.id}:${p.index}`,
        pairIndex: p.index,
        enTitle: p.enTitle,
        en: p.en,
        ja,
        mutation: mutation.id,
        verdict: mutation.verdict,
      });
      planted = true;
      cursor = (cursor + i + 1) % usable.length;
    }
    if (!planted) unplanted.push(mutation.id);
  }
  return { subjects, unplanted };
}
