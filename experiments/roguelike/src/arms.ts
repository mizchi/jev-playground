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
import { glyphAt, mapOf } from "./nethack.js";
import { kindOf, steppable, type Action } from "./actions.js";

export const ARMS = ["jev", "jevbare", "jevmemo", "jevcount", "jevintent", "jevmemofix"] as const;
export type ArmName = (typeof ARMS)[number];

export const ARM_BLURB: Record<ArmName, string> = {
  jev: "each action labelled with the glyph it leads to",
  jevbare: "the direction names alone; the map must be read from the state",
  jevmemo: "like jev, plus where it has already been, plus a goal that says to prefer it",
  jevcount: "the memory ALONE: visit counts, and the base goal unchanged",
  jevintent: "the sentence ALONE: the base goal plus 'prefer ground you have not walked'",
  jevmemofix: "like jevmemo, but the visit count is withheld where the square is not steppable",
};

/**
 * THE LAST THREE ARMS EXIST BECAUSE `jevmemo` CHANGED TWO THINGS AT ONCE.
 *
 * docs/34 §2.4 added the visit counts AND a new goal sentence in the same arm
 * and reported mapping 48 -> 152. That number cannot say which addition did
 * it, which is docs/06's homework (a): if the sentence alone moves it, what
 * was added was intent and not memory.
 *
 *   jevcount    the counts, with the ORIGINAL goal. Memory, no intent.
 *   jevintent   the new sentence, with NO counts. Intent, no memory.
 *   jevmemo     both. The arm as shipped.
 *
 * `jevmemofix` is a fourth arm, and it is here because homework (b) found a
 * contradiction in `jevmemo`'s own payload rather than in its results
 * (`src/refusals.ts`). A wall has never been stood on, so its visit count is
 * 0, so the sentence attached to it reads "you have never stood there" --
 * while the goal says to prefer exactly that, and the BASE goal says walking
 * into a wall achieves nothing. The memory recommends walls. Measured: `jev`
 * walks into no walls at all, and `jevmemo`, handed the same glyph text plus
 * the counts, walks into vertical ones at the blind-pick rate. So this arm
 * withholds the count where `steppable` is false, and the gap between it and
 * `jevmemo` is the price of that contradiction.
 */

export const MOVE = "move";

/**
 * A record of where the hero has already stood.
 *
 * This exists to remove a confound I put in myself. The explorer baseline
 * carries a visited set and a committed target; the `jev` arm carried
 * neither, walked 584 times in near-equal directions and mapped one room --
 * and the conclusion "it has no long-range plan" was drawn from that
 * comparison. It is not a fair one. The same missing memory made my own
 * explorer oscillate for four hundred actions before I gave it a visited set
 * (docs/34 §0.1).
 *
 * `jevmemo` gets the memory and NOT the plan: how often each neighbouring
 * square has been stood on, and how much of the level has been seen. Where
 * to go next is still the judgment's to decide. Handing over the committed
 * target as well would be handing over the explorer's policy and measuring
 * my own breadth-first search.
 */
export interface Memory {
  /** "x,y" -> how many times the hero has stood there. */
  counts: ReadonlyMap<string, number>;
  /** Distinct squares stood on, and map cells no longer blank. */
  walked: number;
  mapped: number;
}

export const EMPTY_MEMORY: Memory = { counts: new Map(), walked: 0, mapped: 0 };

/**
 * The state: the screen, the vitals, and what the game last said.
 *
 * `recent` is the message line from the last few actions, because a NetHack
 * screen alone does not say "you hit the newt" and a policy with no memory
 * of the last message cannot tell an ongoing fight from a quiet corridor.
 * It is the game's own output, not a summary of it.
 */
export function stateFor(
  screen: Screen,
  vitals: Vitals,
  recent: string[],
  memory?: Memory,
): Record<string, unknown> {
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
    ...(memory
      ? {
          squares_you_have_stood_on_so_far: memory.walked,
          map_squares_you_have_seen_so_far: memory.mapped,
        }
      : {}),
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

export function questionFor(
  arm: ArmName,
  actions: Action[],
  hero?: { x: number; y: number },
  memory?: Memory,
  /** Needed only by `jevmemofix`, to ask whether a square can be stepped on. */
  screen?: Screen,
): Record<string, Question> {
  const criteria: Record<string, string> = {};
  const carriesCounts = arm === "jevmemo" || arm === "jevcount" || arm === "jevmemofix";
  const carriesSentence = arm === "jevmemo" || arm === "jevintent" || arm === "jevmemofix";
  for (const a of actions) {
    if (arm === "jevbare") {
      criteria[a.name] = a.name;
      continue;
    }
    // The visit count rides with the action rather than in the state,
    // because "have I been there" is a fact about THIS option and docs/29 §4
    // measured that a question's subject belongs in the question.
    let says = a.says;
    if (carriesCounts && hero && memory && a.dir) {
      // `jevmemofix` withholds it where a step cannot land, because "you have
      // never stood there" is true of every wall and reads as a reason to go.
      const to = { x: hero.x + a.dir.dx, y: hero.y + a.dir.dy };
      const reachable = arm !== "jevmemofix" || (screen ? steppable(kindOf(glyphAt(screen, to.x, to.y))) : true);
      if (reachable) {
        const been = memory.counts.get(`${to.x},${to.y}`) ?? 0;
        says += been === 0 ? "; you have never stood there" : `; you have stood there ${been} time${been === 1 ? "" : "s"} already`;
      }
    }
    criteria[a.name] = says;
  }
  return { [MOVE]: { type: "choice", instructions: carriesSentence ? MEMO_GOAL : GOAL, criteria } };
}

/**
 * The same goal with one sentence added: prefer unvisited ground.
 *
 * Without it the memory is present and unused -- and an arm that is handed a
 * number nobody asked it to act on measures nothing. With it, the arm has
 * the explorer's INFORMATION and the explorer's INTENT, and still has to
 * work out the route itself, which is the part being tested.
 */
const MEMO_GOAL = [
  GOAL,
  "You have been walking for a while and have not found the staircase yet.",
  "Squares you have already stood on teach you nothing new: prefer a direction that leads to ground you have not walked, and keep going that way rather than turning back and forth.",
].join(" ");

/** Everything one request would carry, for the leak tests. */
export function payloadOf(
  arm: ArmName,
  screen: Screen,
  vitals: Vitals,
  recent: string[],
  actions: Action[],
  hero?: { x: number; y: number },
  memory?: Memory,
): string {
  return JSON.stringify({
    state: stateFor(screen, vitals, recent, arm === "jevmemo" ? memory : undefined),
    questions: questionFor(arm, actions, hero, memory),
  });
}
