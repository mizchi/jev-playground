/**
 * The policy question: one `choice` over the enumerated actions.
 *
 * Two arms, differing only in how much the CRITERIA say:
 *
 *   jev      each action is labelled with what the square it leads to is
 *            drawn as, and what that glyph means -- "step west; the square
 *            there shows `.` = floor". All of it derived by code from the
 *            same screen.
 *   jevbare  the direction and nothing else. The map is in the state either
 *            way, so this arm has to find the `@` on a 21x80 picture and
 *            read its surroundings itself.
 *
 * The gap between them is the experiment: it separates "can pick a sensible
 * action given a described local situation" from "can see the situation".
 * docs/33 ran the same split for code review and found the mechanical
 * metrics worth +0.05 on one measure and nothing on another; here the thing
 * being withheld is not extra analysis but the ability to read the picture
 * at all.
 */
import type { Question } from "../../shared/jev.js";
import type { Vitals, Screen } from "./nethack.js";
import { mapOf } from "./nethack.js";
import type { Action } from "./actions.js";

export const ARMS = ["jev", "jevbare"] as const;
export type ArmName = (typeof ARMS)[number];

export const ARM_BLURB: Record<ArmName, string> = {
  jev: "each action labelled with the glyph it leads to",
  jevbare: "the direction names alone; the map must be read from the state",
};

export const MOVE = "move";

/**
 * The state: the screen, the vitals, and what the game last said.
 *
 * `recent` is the message line from the last few actions, because a NetHack
 * screen alone does not say "you hit the newt" and a policy with no memory
 * of the last message cannot tell an ongoing fight from a quiet corridor.
 * It is the game's own output, not a summary of it.
 */
export function stateFor(screen: Screen, vitals: Vitals, recent: string[]): Record<string, unknown> {
  return {
    what: "a turn of NetHack 3.6.7. You are the @ on the map. Choose the next action.",
    map_rows: mapOf(screen),
    legend: {
      "@": "you",
      ".": "room floor or an empty doorway",
      "#": "corridor",
      "-  |": "wall, or an open door",
      "+": "a closed door (walking into it opens it)",
      "<  >": "staircase up, staircase down",
      "letters and & ' : ; ~": "monsters",
      ") [ ! ? / = \" ( * % $": "objects on the floor",
      "^": "a trap you have found",
      "blank": "not yet explored, or solid rock",
    },
    status_lines: [screen.rows[22].trim(), screen.rows[23].trim()],
    hit_points: `${vitals.hp} of ${vitals.hpMax}`,
    dungeon_level: vitals.dlvl,
    turn: vitals.turn,
    conditions: vitals.flags,
    recent_messages: recent.slice(-4),
  };
}

/**
 * The goal, stated once, in the instructions rather than the state.
 *
 * docs/29 §4 measured that moving the subject of a question out of the
 * question and into the state costs agreement, and the subject here is "this
 * turn". So the standing goal rides with the question.
 */
const GOAL = [
  "Choose the single best action for this turn.",
  "The aim is to survive and to descend: find the down staircase `>`, stand on it, and descend.",
  "Kill weak monsters that are next to you for experience, but retreat and keep your distance when hit points are low.",
  "Do not waste turns: walking into a wall or a blank square achieves nothing.",
].join(" ");

export function questionFor(arm: ArmName, actions: Action[]): Record<string, Question> {
  const criteria: Record<string, string> = {};
  for (const a of actions) criteria[a.name] = arm === "jev" ? a.says : a.name;
  return { [MOVE]: { type: "choice", instructions: GOAL, criteria } };
}

/** Everything one request would carry, for the leak tests. */
export function payloadOf(arm: ArmName, screen: Screen, vitals: Vitals, recent: string[], actions: Action[]): string {
  return JSON.stringify({ state: stateFor(screen, vitals, recent), questions: questionFor(arm, actions) });
}
