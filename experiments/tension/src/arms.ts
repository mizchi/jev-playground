/**
 * Two questions per position, one request.
 *
 *   move      a `choice` over the legal moves. Its `confidence` is the
 *             quantity the whole experiment is about.
 *   standing  a `score` over five levels of how the position looks. Its
 *             swing from move to move is the second axis: a game can have
 *             hard choices without ever feeling like it might turn around,
 *             and the two have to be measured separately or "tension" is
 *             just a word for both.
 *
 * Both ride in one request because width is nearly free -- docs/29 §4
 * measured 99.8% of answers within 0.25 between a 74-wide request and a
 * 1-wide one -- so the evaluation costs almost nothing beyond the move.
 *
 * The rules go in the state, the position goes in the state, and the move
 * list goes in the question, because the subject of "which move now" is the
 * move list (docs/29 §4 again: moving a question's subject into the state
 * costs agreement).
 */
import type { Question } from "../../shared/jev.js";
import { type Move, type Position, RULES } from "./games.js";

export const MOVE = "move";
export const STANDING = "standing";

export const ARMS = ["jev", "jevterse"] as const;
export type ArmName = (typeof ARMS)[number];

export const ARM_BLURB: Record<ArmName, string> = {
  jev: "each move labelled with what it does to the position",
  jevterse: "the move names alone",
};

/**
 * Five levels, worded so that the middle one is a real answer.
 *
 * A four-level scale forces a side and would manufacture swing; the games
 * here are full of genuinely balanced positions and the trajectory statistic
 * is about how often the reading MOVES, so the scale has to be able to say
 * "level".
 */
export const LEVELS = [
  "the player to move is losing: with careful play by the opponent there is no way out",
  "the player to move is worse off, though not yet beyond saving",
  "the position is balanced, or too unclear to call",
  "the player to move is better off, with a real advantage to convert",
  "the player to move is winning: careful play from here cannot lose it",
];

export function stateFor(p: Position, history: string[]): Record<string, unknown> {
  const rules = RULES[p.game];
  return {
    game: rules.name,
    how_to_play: rules.howToPlay,
    you_are: p.player === 0 ? "the first player (X)" : "the second player (O)",
    position: rules.render(p),
    moves_so_far: history,
    move_number: history.length + 1,
  };
}

export function questionsFor(arm: ArmName, moves: Move[]): Record<string, Question> {
  const criteria: Record<string, string> = {};
  for (const m of moves) criteria[m.name] = arm === "jev" ? m.says : m.name;
  return {
    [MOVE]: {
      type: "choice",
      instructions: "Choose the move that gives you the best result. Play to win; if you cannot win, play to draw.",
      criteria,
    },
    [STANDING]: {
      type: "score",
      instructions: "Judge the position as it stands now, before the move is made, from the point of view of the player to move.",
      criteria: LEVELS,
    },
  };
}

/** Everything one request would carry, for the leak tests. */
export function payloadOf(arm: ArmName, p: Position, history: string[], moves: Move[]): string {
  return JSON.stringify({ state: stateFor(p, history), questions: questionsFor(arm, moves) });
}
