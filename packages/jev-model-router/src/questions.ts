/**
 * One request, four questions, and what goes in the state instead.
 *
 * The split follows two measurements:
 *
 *   - The TASK is shared by every question, so it goes in the state and is
 *     paid for once. docs/30 §7 moved shared criteria text out of per-question
 *     `instructions` and the number of questions that fit a request went from
 *     260 to 520, with answers unchanged (level agreement 95%).
 *   - The RUBRIC is per-question, so it stays in the question. docs/29 §4
 *     measured the other direction: moving a question's own subject into the
 *     state dropped agreement to 53%.
 *
 * The two escape hatches are separate `noul`s and not extra rungs on the
 * ladder. docs/17 §3 measured that directly: an out-of-scope option added to
 * a `choice` caught 16/18 and pulled answerable-but-hard cases into it, while
 * the same question asked as its own `noul` caught 18/18 with no side effect.
 */
import type { Question } from "@jev-playground/jev-core";
import type { RouterConfig } from "./tiers.js";

export const TIER = "tier";
export const EFFORT = "effort";
export const UNDERSPECIFIED = "underspecified";
export const OVERSIZED = "oversized";

export interface RouteInput {
  /** What the user just asked for. The subject of every question. */
  task: string;
  /** Earlier turns, oldest first. Trimmed by the caller before it gets here. */
  recent?: string[];
  /** Approximate size of the conversation so far, for the downgrade rule. */
  contextTokens?: number;
  /** Where the work is happening. A repo name changes what "hard" means. */
  cwd?: string;
}

export function stateFor(input: RouteInput, config: RouterConfig): Record<string, unknown> {
  const ceiling = Math.max(...config.tiers.map((t) => t.price));
  return {
    what: "a request about to be handed to a coding agent. Judge the request, not the agent.",
    request: input.task,
    ...(input.recent && input.recent.length > 0 ? { earlier_turns: input.recent } : {}),
    ...(input.cwd ? { working_directory: input.cwd } : {}),
    ...(input.contextTokens ? { conversation_size_tokens: input.contextTokens } : {}),
    // Named so the rubric can say "the strongest model" without the state
    // having to repeat which models exist. The prices are NOT here: a judgment
    // that can see the price of its own answer is being asked two things.
    tiers_available: config.tiers.length,
    price_ratio_cheapest_to_dearest: Number((ceiling / Math.min(...config.tiers.map((t) => t.price))).toFixed(1)),
  };
}

export function questionsFor(config: RouterConfig): Record<string, Question> {
  const questions: Record<string, Question> = {
    [TIER]: {
      type: "score",
      instructions:
        "How capable a model does this request need? Judge the difficulty of the work itself, not how long the answer will be and not how polite the request is.",
      criteria: config.tiers.map((t) => t.says),
    },
    [UNDERSPECIFIED]: {
      type: "noul",
      instructions:
        "Is the request too vague to tell what work it asks for? This is about the request's own clarity, not about the work being hard.",
      criteria: {
        true: "a competent engineer would have to ask a question before starting",
        false: "a competent engineer could start on this as written",
      },
    },
    [OVERSIZED]: {
      type: "noul",
      instructions:
        "Does this request need more of the codebase held at once than a single model context can hold? Judge the breadth of what must be read, not the length of the request.",
      criteria: {
        true: "the work spans more code than can be read into one context",
        false: "the work touches a part of the codebase that fits in one context",
      },
    },
  };
  if (config.effort && config.effort.length >= 2) {
    questions[EFFORT] = {
      type: "score",
      instructions:
        "How much deliberation does this request need before the first edit? This is separate from how capable the model must be: a simple change to unfamiliar code needs thought, and a hard change to code the model knows well may not.",
      criteria: config.effort.map((e) => e.says),
    };
  }
  return questions;
}

/** Everything one request would carry, for the leak and budget tests. */
export function payloadOf(input: RouteInput, config: RouterConfig): string {
  return JSON.stringify({ state: stateFor(input, config), questions: questionsFor(config) });
}
