/**
 * What gets asked, and the one thing this experiment is about.
 *
 * The question is whether a documented boolean gate is better ASKED or
 * COMPOSED. The skill writes it as `(1 or 2) and (4)` over four named
 * conditions, so there are two ways to get an answer:
 *
 *   direct     one noul: "does this need more than one agent?"
 *   composed   four nouls, one per condition, and the boolean in code
 *
 * And because the first measurement showed the direct noul 21 points behind
 * the same decision asked from the other side, the whole decision is asked
 * THREE ways: with the cost named first, with nothing named, and inverted as
 * `stay_single`. §2b is that comparison.
 *
 * All of it lives in the SAME request. docs/29 §4 measured that a question's
 * answer does not move with the request's width, so asking all eight at once
 * costs one request and does not let either reading see the other's answer
 * any more than a separate request would. §7 re-checks that with repeats.
 *
 * `withThree` is free: it is the same four answers composed as
 * `(1 or 2 or 3) and 4` instead. The skill says in bold that condition 3 is
 * not a reason to spawn, and four scenarios are built so the two readings
 * disagree -- so the cost of getting the documented rule wrong is measurable
 * without spending anything.
 *
 * The topology `choice` carries the skill's own table. `stay_single` is a
 * separate noul rather than a ninth option, which is docs/17 §3's rule; the
 * `nohatch` arm removes it to price that decision.
 */
import type { Question } from "../../shared/jev.js";
import { PATTERNS, PATTERN_USE, type Scenario } from "./scenarios.js";

export const ARMS = ["all", "nohatch"] as const;
export type ArmName = (typeof ARMS)[number];

export const ARM_BLURB: Record<ArmName, string> = {
  all: "one request: the decision, the four conditions, the topology, and the escape hatch",
  nohatch: "the topology choice alone, with no `stay_single` noul beside it",
};

export const DECISION = "needs_more_than_one";
export const DECISION_PLAIN = "more_than_one_plain";
export const INDEPENDENT = "independent_parts";
export const DIFFERENT = "different_vantage";
export const THREE = "checkable_artifacts";
export const BIG_ENOUGH = "big_enough";
export const TOPOLOGY = "topology";
export const STAY_SINGLE = "stay_single";

/** The state: the request, and nothing about the answer. */
export function stateFor(scenario: Scenario): Record<string, unknown> {
  return {
    what: "someone describing a piece of work they are about to start",
    request: scenario.text,
  };
}

/**
 * The eight questions.
 *
 * Each condition is worded from the skill's own numbered line, with the
 * numbering and the word "condition" removed -- a question that says "this is
 * condition 1 of the gate" would be handing over the structure. The four are
 * ATOMIC: none of them mentions agents at all except the two that have to.
 */
export function questions(arm: ArmName): Record<string, Question> {
  if (arm === "nohatch") {
    return {
      [TOPOLOGY]: {
        type: "choice",
        instructions:
          "The work below is going to be split across more than one worker. Which shape fits it?",
        criteria: Object.fromEntries(PATTERNS.map((p) => [p, PATTERN_USE[p]])),
      },
    };
  }
  return {
    [DECISION]: {
      type: "noul",
      instructions:
        "Running a second worker on this costs tokens, latency and a chance of one worker's " +
        "mistake propagating into the other's input. Is this work better done by more than one?",
      criteria: {
        true: "More than one worker is worth it here.",
        false: "One worker, taking as many turns as it needs, is the better way to do this.",
      },
    },
    // The same decision with the cost sentence removed. `DECISION` names what
    // a second worker costs before asking, `STAY_SINGLE` asks from the other
    // side, and this one asks flat -- three framings of one question (§2b).
    [DECISION_PLAIN]: {
      type: "noul",
      instructions: "Is this work better done by more than one worker, or by one?",
      criteria: {
        true: "By more than one.",
        false: "By one.",
      },
    },
    [INDEPENDENT]: {
      type: "noul",
      instructions:
        "Does this work contain parts that could be done at the same time without waiting for " +
        "each other, and without two of them writing the same files?",
      criteria: {
        true: "There are such parts, or there would be once a named interface is written down first.",
        false: "Each step needs what the step before it produced, or they would edit the same files.",
      },
    },
    [DIFFERENT]: {
      type: "noul",
      instructions:
        "Would two workers on this actually hold different things -- different information, a " +
        "different tool, a different credential, a different way of getting evidence?",
      criteria: {
        true: "Yes: what they can see or do genuinely differs.",
        false: "No: the same information and the same tools, whatever the workers are called.",
      },
    },
    [THREE]: {
      type: "noul",
      instructions:
        "Can a result here be checked by something other than a person reading it -- a test, a " +
        "schema, a linter, a re-derivation from the source?",
      criteria: {
        true: "Yes, there is a mechanical check.",
        false: "No, someone has to read it and decide.",
      },
    },
    [BIG_ENOUGH]: {
      type: "noul",
      instructions:
        "How large is this piece of work? A second worker costs tokens and latency whatever the " +
        "task is, so the question is whether the task is large enough for that to be small.",
      criteria: {
        true: "Large: hours to weeks of work, or many items to get through.",
        false: "Small: minutes, a handful of lines, or a single edit.",
      },
    },
    [TOPOLOGY]: {
      type: "choice",
      instructions:
        "If this work were split across more than one worker, which shape would fit it?",
      criteria: Object.fromEntries(PATTERNS.map((p) => [p, PATTERN_USE[p]])),
    },
    [STAY_SINGLE]: {
      type: "noul",
      instructions:
        "Setting the shapes aside: is this work one that one worker should simply do by itself?",
      criteria: {
        true: "Yes, none of the shapes apply; one worker is right.",
        false: "No, splitting it is right.",
      },
    },
  };
}

/** Everything one request sends, as text, for the leak test. */
export function payloadOf(arm: ArmName, scenario: Scenario): string {
  return JSON.stringify([stateFor(scenario), questions(arm)]);
}
