/**
 * What the judgment sees, and what it is asked.
 *
 * Two arms, and the second one is the docs/21 §6 question in a new domain:
 * does the rest of the document help decide whether this section matches, or
 * does it only give the answer more places to hide?
 *
 *   section   the aligned pair, and nothing else
 *   withdoc   the pair plus both whole documents
 */
import type { Question } from "../../shared/jev.js";
import type { Subject } from "./mutate.js";

export const ARMS = ["section", "withdoc"] as const;
export type ArmName = (typeof ARMS)[number];

export const ARM_BLURB: Record<ArmName, string> = {
  section: "the aligned section pair alone",
  withdoc: "the pair plus both documents in full",
};

export const KINDS = [
  "number_changed",
  "negation_flipped",
  "omission",
  "addition",
  "claim_strength",
  "terminology",
] as const;

export function stateFor(
  arm: ArmName,
  subject: Subject,
  whole: { en: string; ja: string },
): Record<string, unknown> {
  const head = {
    comparing: "one section of a README against the same section of its translation",
    source_language: "English",
    target_language: "Japanese",
    relationship: "the English file is the source of truth; the Japanese file is its translation",
    section: subject.enTitle,
    english: subject.en,
    japanese: subject.ja,
  };
  if (arm === "section") return head;
  return {
    ...head,
    english_document: whole.en,
    japanese_document: whole.ja,
    note: "the two documents are provided in full; the section above is the one being judged",
  };
}

export const SAME = "same";
export const DIVERGENCE = "divergence";
export const KIND = "kind";
export const NO_DIVERGENCE = "no_divergence";
export const JA_OMITS = "japanese_omits";
export const JA_ADDS = "japanese_adds";
export const NUMBERS_AGREE = "numbers_agree";
export const CONTRADICTION = "contradiction";

/**
 * Eight questions, one request. The ordered one is a score, the class is a
 * choice, the predicates are nouls, and "nothing is wrong here" is its own
 * question rather than an option inside the choice (docs/17 §3).
 */
export function questions(): Record<string, Question> {
  return {
    [DIVERGENCE]: {
      type: "score",
      instructions: "How far apart are the two texts in what they state?",
      criteria: [
        "They state the same things. Wording, ordering and formatting may differ freely.",
        "One side says something the other only implies, or is less precise, without stating anything different.",
        "A detail differs or is missing: a number, an identifier, a condition, a sentence that carries a claim.",
        "They contradict each other: a reader following one would be wrong about what the other says.",
      ],
    },
    [KIND]: {
      type: "choice",
      instructions: "If they differ, what kind of difference is it?",
      criteria: {
        number_changed: "A number does not match: a measurement, a count, a threshold.",
        negation_flipped: "One side negates what the other asserts.",
        omission: "The Japanese side is missing a statement the English side makes.",
        addition: "The Japanese side states something the English side does not.",
        claim_strength: "The same claim, but hedged on one side and absolute on the other.",
        terminology: "A name is different: an option, an identifier, a rule id.",
      },
    },
    [NO_DIVERGENCE]: {
      type: "noul",
      instructions: "A reader of either text would come away believing the same things.",
      criteria: {
        true: "The two texts are equivalent, including when the translation rewords or reflows freely.",
        false: "Something one text says is not in the other, or is different there.",
      },
    },
    [SAME]: {
      type: "noul",
      instructions: "Every claim in the English text appears in the Japanese text, and the reverse.",
      criteria: { true: "Both directions hold.", false: "At least one claim is only on one side." },
    },
    [JA_OMITS]: {
      type: "noul",
      instructions: "The Japanese text leaves out something the English text states.",
      criteria: { true: "Something is missing on the Japanese side.", false: "Nothing is missing." },
    },
    [JA_ADDS]: {
      type: "noul",
      instructions: "The Japanese text states something that is not in the English text.",
      criteria: { true: "There is an extra claim on the Japanese side.", false: "Nothing extra." },
    },
    [NUMBERS_AGREE]: {
      type: "noul",
      instructions: "Every number that appears in either text agrees with the other text.",
      criteria: {
        true: "The numbers match, including when one side spells a number as a word.",
        false: "At least one number differs.",
      },
    },
    [CONTRADICTION]: {
      type: "noul",
      instructions: "Following one text would leave a reader wrong about what the other says.",
      criteria: { true: "They disagree, not merely differ in detail.", false: "No contradiction." },
    },
  };
}
