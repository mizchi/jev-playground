/**
 * Can judgment read an 80x24 ASCII picture?
 *
 * Every earlier experiment in this repository handed Jev STRUCTURED state --
 * objects, fields, lists. A roguelike hands a player a two-dimensional
 * drawing and expects them to see a room in it. That is a different demand,
 * and it is worth measuring on its own before asking whether Jev can play,
 * because a policy cannot be better than its perception.
 *
 * So each question here has a ground truth computed from the grid by code,
 * and the set is split three ways on purpose:
 *
 *   status  read off the two status lines -- ordinary text, the CONTROL. If
 *           these are right and the map ones are wrong, the failure is
 *           two-dimensional layout and not reading.
 *   local   the eight squares around the `@`.
 *   global  the whole 21x80 map.
 *
 * Nothing here is a judgment call. `dead end` means one steppable
 * neighbour, not "feels like a dead end".
 */
import { MAP_ROWS, type Screen, glyphAt, heroAt, mapOf, vitalsOf } from "./nethack.js";
import { DIRS, kindOf, steppable } from "./actions.js";
import type { Question } from "../../shared/jev.js";

export type Band = "status" | "local" | "global";

export interface Probe {
  key: string;
  band: Band;
  question: Question;
  /** True/false questions only; `score` probes carry `level` instead. */
  truth: boolean;
}

export interface ScorePrimer {
  key: string;
  band: Band;
  question: Question;
  level: number;
}

export interface Probes {
  nouls: Probe[];
  scores: ScorePrimer[];
}

const MONSTERS = /[a-zA-Z&';:~@]/;
const ITEMS = /[)\[!?/="(*%$]/;

function neighbours(screen: Screen, hero: { x: number; y: number }): string[] {
  return DIRS.map((d) => glyphAt(screen, hero.x + d.dx, hero.y + d.dy));
}

/** Monster glyphs on the whole map, not counting the hero's own `@`. */
export function monsterCount(screen: Screen): number {
  let n = 0;
  let heroSeen = false;
  for (const row of mapOf(screen)) {
    for (const ch of row) {
      if (ch === "@" && !heroSeen) {
        heroSeen = true;
        continue;
      }
      if (MONSTERS.test(ch)) n += 1;
    }
  }
  return n;
}

export function itemCount(screen: Screen): number {
  let n = 0;
  for (const row of mapOf(screen)) for (const ch of row) if (ITEMS.test(ch)) n += 1;
  return n;
}

export function stairsAt(screen: Screen, glyph: "<" | ">" = ">"): { x: number; y: number } | null {
  for (let y = 0; y < MAP_ROWS; y += 1) {
    const x = screen.rows[1 + y].indexOf(glyph);
    if (x >= 0) return { x, y };
  }
  return null;
}

const noul = (instructions: string, t: string, f: string): Question => ({
  type: "noul",
  instructions,
  criteria: { true: t, false: f },
});

/**
 * The probes for one screen.
 *
 * A probe is only included when its answer is well defined on this screen --
 * "the staircase is east of you" is not a question when no `>` is drawn, and
 * asking it anyway would measure my question-writing rather than Jev.
 */
export function probesFor(screen: Screen): Probes {
  const hero = heroAt(screen);
  const vitals = vitalsOf(screen);
  const nouls: Probe[] = [];
  const scores: ScorePrimer[] = [];
  if (!hero || !vitals) return { nouls, scores };

  // ---- the control: two lines of ordinary text at the bottom of the screen
  nouls.push({
    key: "hurt",
    band: "status",
    truth: vitals.hp < vitalsOf(screen)!.hpMax,
    question: noul(
      "The status lines report current and maximum hit points as HP:current(maximum). Has the character taken damage?",
      "current hit points are below the maximum",
      "current hit points equal the maximum",
    ),
  });
  nouls.push({
    key: "deep",
    band: "status",
    truth: vitals.dlvl > 1,
    question: noul(
      "The status lines report the dungeon level as Dlvl:n. Is the character below the top level of the dungeon?",
      "Dlvl is 2 or more",
      "Dlvl is 1",
    ),
  });
  nouls.push({
    key: "rich",
    band: "status",
    truth: vitals.gold > 0,
    question: noul(
      "The status lines report carried gold as $:n. Is the character carrying any gold?",
      "the gold amount is one or more",
      "the gold amount is zero",
    ),
  });

  // ---- local: the eight squares touching the `@`
  const around = neighbours(screen, hero);
  const openCount = around.filter((g) => steppable(kindOf(g))).length;
  nouls.push({
    key: "adjacent_monster",
    band: "local",
    truth: around.some((g) => MONSTERS.test(g)),
    question: noul(
      "Look at the eight map squares immediately surrounding the @ (including the diagonals). Is a monster standing on one of them? Monsters are drawn as letters, and also as & ' : ; ~ and a second @.",
      "at least one of the eight squares around the @ holds a monster",
      "none of the eight squares around the @ holds a monster",
    ),
  });
  nouls.push({
    key: "dead_end",
    band: "local",
    truth: openCount <= 1,
    question: noul(
      "Look at the eight map squares immediately surrounding the @. A square can be walked on if it is drawn as . or # or + or < or > or a letter or an item symbol; it cannot if it is blank or drawn as - or |. Is the @ in a dead end, with at most one walkable square around it?",
      "at most one of the eight squares around the @ can be walked on",
      "two or more of the eight squares around the @ can be walked on",
    ),
  });
  nouls.push({
    key: "in_room",
    band: "local",
    truth: openCount >= 5,
    question: noul(
      "Look at the eight map squares immediately surrounding the @, counting how many can be walked on (drawn as . or # or + or < or > or a letter or an item symbol; blank, - and | cannot). Is the @ standing in open space rather than a corridor or a doorway?",
      "five or more of the eight squares around the @ can be walked on",
      "four or fewer of the eight squares around the @ can be walked on",
    ),
  });

  // ---- global: the whole twenty-one-row map
  //
  // The two staircases are asked about separately and on purpose. The hero
  // STARTS on the up staircase, so `<` is drawn on nearly every screen once
  // the first room is mapped, and the direction questions have something to
  // be about. The down staircase is the opposite: across six baseline games
  // of up to 420 actions not one screen ever showed a `>`, so
  // `downstairs_visible` is almost always false -- which is exactly what
  // balances `items_visible`, almost always true. A probe set where every
  // answer is "yes" measures nothing.
  const up = stairsAt(screen, "<");
  nouls.push({
    key: "upstairs_visible",
    band: "global",
    truth: up !== null,
    question: noul(
      "Scan the whole map. Is an up staircase, drawn as the single character <, anywhere on it?",
      "a < appears somewhere on the map",
      "no < appears anywhere on the map",
    ),
  });
  nouls.push({
    key: "downstairs_visible",
    band: "global",
    truth: stairsAt(screen, ">") !== null,
    question: noul(
      "Scan the whole map. Is a down staircase, drawn as the single character >, anywhere on it?",
      "a > appears somewhere on the map",
      "no > appears anywhere on the map",
    ),
  });
  if (up && up.x !== hero.x) {
    nouls.push({
      key: "upstairs_east",
      band: "global",
      truth: up.x > hero.x,
      question: noul(
        "Find the < on the map and compare its column with the @'s column. Is the < to the right of the @ on the screen?",
        "the < is in a column to the right of the @",
        "the < is in a column to the left of the @",
      ),
    });
  }
  if (up && up.y !== hero.y) {
    nouls.push({
      key: "upstairs_south",
      band: "global",
      truth: up.y > hero.y,
      question: noul(
        "Find the < on the map and compare its row with the @'s row. Is the < on a lower row of the screen than the @?",
        "the < is on a row below the @",
        "the < is on a row above the @",
      ),
    });
  }
  nouls.push({
    key: "items_visible",
    band: "global",
    truth: itemCount(screen) > 0,
    question: noul(
      "Scan the whole map for object symbols: ) [ ! ? / = \" ( * % and $. Is at least one object lying on the floor somewhere on the map?",
      "at least one object symbol appears on the map",
      "no object symbol appears on the map",
    ),
  });
  const monsters = monsterCount(screen);
  scores.push({
    key: "monster_count",
    band: "global",
    level: monsters === 0 ? 0 : monsters === 1 ? 1 : monsters === 2 ? 2 : 3,
    question: {
      type: "score",
      instructions:
        "Scan the whole map and count the monsters on it. Monsters are drawn as letters, and also as & ' : ; ~ and a second @. The character's own @ is not a monster; if two @ are drawn, one of them is a monster.",
      criteria: ["no monsters are on the map", "exactly one monster is on the map", "exactly two monsters are on the map", "three or more monsters are on the map"],
    },
  });
  return { nouls, scores };
}

/**
 * The state: the map, the status lines, and nothing else.
 *
 * The map goes in as twenty-one strings rather than one blob, because a
 * roguelike screen IS a list of rows and flattening it would be a
 * presentation choice smuggled in as a format. The status lines go in
 * separately for the same reason -- they are a different kind of thing, and
 * the control questions are about them.
 *
 * NetHack's MESSAGE LINE is deliberately left out. It is a third channel and
 * it answers some of these questions directly: "the jackal bites!" settles
 * whether a monster is adjacent without looking at the map at all, and
 * `adjacent_monster` would then be measuring whether Jev can read one
 * English sentence. The policy arms in `arms.ts` do get the messages,
 * because a player has them and playing is a different question.
 */
export function stateFor(screen: Screen): Record<string, unknown> {
  return {
    what: "a screen from NetHack 3.6.7, in plain ASCII, exactly as the terminal shows it",
    map_rows: mapOf(screen),
    status_lines: [screen.rows[22].trim(), screen.rows[23].trim()],
  };
}
