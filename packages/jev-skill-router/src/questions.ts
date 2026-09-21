/**
 * One request, one question per surviving skill, plus one escape hatch.
 *
 * Every shape here is the one docs/29 and docs/30 measured as best, and the
 * reasons are worth keeping next to the code because each has a plausible
 * alternative that measured worse:
 *
 *   A `score`, not a `noul`.  The four levels are ordered -- no use, adjacent,
 *   fits but unasked, needed now -- and docs/01 §3 measured what happens when
 *   an ordered conclusion is asked as an unordered one. docs/29 §2 also
 *   measured the `noul` form directly on this problem: 0.54 average precision
 *   against 0.56 for the `score` form that names when it applies.
 *
 *   Fan-out, one request.  docs/29 §4 asked 74 skills in one request and the
 *   same 74 one at a time: 99.8% of answers within 0.25, level agreement 97%,
 *   and 296,845 input tokens against 718,128. Asking one at a time buys the
 *   same answers for 2.4x the price.
 *
 *   Four words per question, the meaning in the state.  docs/30 §7 moved the
 *   level text and the shared task sentence out of the questions: 251 tokens
 *   per question became 118, the number that fits a request went from 260 to
 *   520, and the answers did not move (level agreement 95%).
 *
 *   The escape hatch is its own `noul`.  docs/17 §3: "none of these" as a
 *   choice option caught 16/18 and pulled answerable cases into it; as a
 *   separate question, 18/18.
 */
import type { Question } from "@jev-playground/jev-core";
import type { Context, Skill } from "./catalog.js";

export const NONE = "none_apply";

/** The ordered levels, in full. These go in the state, once. */
export const LEVELS = [
  "This context has no use for it. Nothing in the request or the files is about what it does.",
  "Adjacent, or superseded by something else. Worth naming in passing; not worth loading now.",
  "It fits an activity this context could want, but the request does not ask for that activity.",
  "This context needs it now: the request or the files are about what it does.",
];

/** The same four levels in four words. What each question actually carries. */
export const TERSE_LEVELS = ["no use", "adjacent only", "fits, but unasked", "needed now"];

const ASK =
  "An agent working in the context below can load this skill. Its whole cost is context: " +
  "loading it spends tokens in every following turn, so it should be loaded when the work at " +
  "hand is what the skill is about. How strongly does this context call for it?";

export function keyFor(name: string): string {
  return `q_${name.replace(/[^\w]/g, "_")}`;
}

export function stateFor(ctx: Context): Record<string, unknown> {
  return {
    what: "the context an agent is about to work in",
    request: ctx.request,
    ...(ctx.files && ctx.files.length > 0 ? { files: ctx.files } : {}),
    ...(ctx.notes ? { project_notes: ctx.notes } : {}),
    ...(ctx.recent && ctx.recent.length > 0 ? { earlier_turns: ctx.recent } : {}),
    // Paid for once here instead of once per question.
    task: ASK,
    level_meaning: LEVELS,
  };
}

export function questionsFor(shortlist: readonly Skill[]): Record<string, Question> {
  const out: Record<string, Question> = {};
  for (const s of shortlist) {
    out[keyFor(s.name)] = {
      type: "score",
      instructions: { skill: s.name, skill_description: s.description },
      criteria: TERSE_LEVELS,
    };
  }
  out[NONE] = {
    type: "noul",
    instructions:
      "Taking the whole list of skills above together: is this a request that none of them is for? Judge the request against what the skills do, not whether the request is hard.",
    criteria: {
      true: "no skill on the list is about this work",
      false: "at least one skill on the list is about this work",
    },
  };
  return out;
}

/** Everything one request would carry, for the leak and budget tests. */
export function payloadOf(ctx: Context, shortlist: readonly Skill[]): string {
  return JSON.stringify({ state: stateFor(ctx), questions: questionsFor(shortlist) });
}
