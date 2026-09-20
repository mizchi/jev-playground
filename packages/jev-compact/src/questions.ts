/**
 * One request: one `score` per candidate entry, plus one escape hatch.
 *
 * The shapes are the ones docs/29 and docs/30 measured, for the same reasons
 * the skill router uses them -- an ordered conclusion is a `score` (docs/01
 * §3), fan-out width is free (docs/29 §4), and shared text belongs in the
 * state (docs/30 §7 took 251 tokens per question down to 118, so ~520
 * questions fit one request instead of 260).
 *
 * The part that is specific to compaction is `digest`. The transcript being
 * compacted is, by definition, too big to send -- that is why compaction is
 * happening. So a question carries a BOUNDED digest of its entry rather than
 * the entry, and the request size stops depending on the transcript size.
 * Head-and-tail rather than head alone, because for a tool result the head
 * says what was attempted and the tail says how it ended, and "did this
 * command fail" is most of what decides whether its output is still needed.
 */
import type { Question } from "@jev-playground/jev-core";
import { tokensOf, type Entry } from "./entries.js";

export const NOTHING_SPARE = "nothing_spare";

/** The ordered levels, in full. These go in the state, once. */
export const LEVELS = [
  "Spent. Whatever it did is already reflected in the files or in a later entry; losing it changes nothing about what happens next.",
  "Superseded. A later entry covers the same ground -- the same file read again, the same command retried, a question since answered.",
  "Background. Not needed for the next step, but it records a fact, a decision or a constraint that nothing else on this list records.",
  "Live. The next step depends on it directly.",
];

/** The same four levels in three words. What each question carries. */
export const TERSE_LEVELS = ["spent", "superseded", "background", "live"];

const ASK =
  "An agent is running out of context and must drop some of the transcript below. Dropped entries are " +
  "deleted, not summarised: nothing of them survives. Judge each entry by what the agent would lose if " +
  "it were gone -- not by how interesting it was, and not by how long ago it happened. How strongly " +
  "does the work still need this entry?";

export function keyFor(id: string): string {
  return `e_${id.replace(/[^\w]/g, "_")}`;
}

/**
 * A bounded excerpt: the head, and the tail when the entry is long enough for
 * the two to differ. The cap is per-entry, so the request grows with the
 * NUMBER of candidates and not with their size.
 */
export function digest(entry: Entry, cap = 400): string {
  const text = entry.text.replace(/\s+/g, " ").trim();
  if (text.length <= cap) return text;
  const half = Math.floor((cap - 5) / 2);
  return `${text.slice(0, half)} ... ${text.slice(-half)}`;
}

export interface CompactContext {
  /** What the session is for. The first user message, usually. */
  goal: string;
  /** The entries that are NOT candidates because they are pinned recent --
   *  what "the next step" means, without which every score is a guess. */
  recent: string[];
  cwd?: string;
}

export function stateFor(ctx: CompactContext): Record<string, unknown> {
  return {
    what: "the transcript of a coding agent that has run out of context",
    goal: ctx.goal,
    ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
    // Not candidates. Present so "the next step" is a fact rather than an
    // inference: an entry is spent or live RELATIVE to where the work is now.
    still_in_context: ctx.recent,
    task: ASK,
    level_meaning: LEVELS,
  };
}

export function questionsFor(candidates: readonly Entry[], cap = 400): Record<string, Question> {
  const out: Record<string, Question> = {};
  for (const e of candidates) {
    out[keyFor(e.id)] = {
      type: "score",
      instructions: {
        role: e.role,
        ...(e.label ? { about: e.label } : {}),
        // The size is stated because it is the whole reason an entry is a
        // candidate, and it is free to include -- but it is NOT the question:
        // a large spent entry and a large live one must still separate.
        tokens: tokensOf(e),
        entry: digest(e, cap),
      },
      criteria: TERSE_LEVELS,
    };
  }
  out[NOTHING_SPARE] = {
    type: "noul",
    // docs/17 §3: the escape hatch is its own noul. As an extra level on the
    // score it would pull ordinary entries into it (16/18 against 18/18).
    instructions:
      "Taking the whole transcript above together: is this a session where nothing can be dropped yet, because every entry is still part of the work in progress?",
    criteria: {
      true: "every entry listed is still doing something for the current step",
      false: "at least some of the entries listed have served their purpose",
    },
  };
  return out;
}

/** Everything one request would carry, for the leak and budget tests. */
export function payloadOf(ctx: CompactContext, candidates: readonly Entry[], cap = 400): string {
  return JSON.stringify({ state: stateFor(ctx), questions: questionsFor(candidates, cap) });
}
