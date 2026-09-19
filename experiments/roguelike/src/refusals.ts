/**
 * What the game refused, broken down. From `records/play.json`, no API key.
 *
 *   npx tsx src/refusals.ts
 *
 * This is docs/06's homework item (b): `jevmemo` refuses 19% of its moves, and
 * the question is whether that is the map's edge or docs/34 §1.1's column
 * problem -- rows read at 96%, columns at 74%.
 *
 * THE HOMEWORK SAID THIS WAS FREE FROM THE RECORD AND IT WAS WRONG. It said
 * "the rejected move's position on screen is in the record". It is not.
 * `play.ts` computes `probe.hero.x/y` on every step -- it needs it for the
 * visit counts `jevmemo` is given -- and then does not put it in `StepRow`.
 * So a positional answer needs a re-run, which costs requests for three of the
 * five arms. `StepRow` now carries `x`/`y` so the next run answers it for
 * free, and this file answers what the existing record CAN answer.
 *
 * Which turns out to be the substantive half. "Edge of the map" and "column
 * misread" make DIFFERENT PREDICTIONS ABOUT DIRECTION, and the direction of
 * every refused move is recorded:
 *
 *   A WALL is a wall in whatever direction it faces. If refusals are the map's
 *   edge, they should fall on north/south and east/west alike -- there is no
 *   reason for a dungeon's walls to prefer an axis.
 *   A COLUMN MISREAD is direction-specific by construction. docs/34 §1.1
 *   measured the failure as vertical: the model reads `@` against the wrong
 *   ROW. A model that cannot tell which row it is on mistakes north and south,
 *   and says nothing wrong about west and east.
 *
 * So: refusal rate on vertical moves against horizontal ones, per arm, with
 * the free arms as the control -- `random` and `greedy` have no model in them
 * at all, so whatever axis asymmetry the dungeon itself has shows up there.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const HERE = import.meta.dirname;

interface StepRow {
  turn: number;
  key: string;
  name: string;
  offered: number;
  refused: boolean;
  hp: number;
  dlvl: number;
  xp: number;
  confidence?: number;
  x?: number;
  y?: number;
}

interface Game {
  policy: string;
  seed: number;
  actions: number;
  refused: number;
  steps: StepRow[];
}

const VERTICAL = new Set(["j", "k"]);
const HORIZONTAL = new Set(["h", "l"]);
const DIAGONAL = new Set(["y", "u", "b", "n"]);

type Axis = "vertical" | "horizontal" | "diagonal" | "other";
const axisOf = (key: string): Axis =>
  VERTICAL.has(key) ? "vertical" : HORIZONTAL.has(key) ? "horizontal" : DIAGONAL.has(key) ? "diagonal" : "other";

const pct = (x: number, n: number): string => (n === 0 ? "    -" : `${((100 * x) / n).toFixed(0).padStart(4)}%`);

function main(): void {
  const path = resolve(HERE, "../records/play.json");
  if (!existsSync(path)) throw new Error("no records/play.json");
  const games = (JSON.parse(readFileSync(path, "utf8")) as { games: Game[] }).games;
  const policies = [...new Set(games.map((g) => g.policy))];

  console.log("\n  docs/06 homework (b): what is `jevmemo` refusing?\n");

  // ------------------------------------------------ the premise was wrong

  const withPosition = games.flatMap((g) => g.steps).filter((s) => s.x !== undefined).length;
  console.log("§0 the homework's premise");
  console.log(
    `\n  steps in the record: ${games.reduce((n, g) => n + g.steps.length, 0)}\n` +
      `  steps carrying a screen position: ${withPosition}\n`,
  );
  console.log(
    "  >> The homework said the rejected move's screen position was in the record. It\n" +
      "     is not. `play.ts` computes the hero's x/y on every step -- it has to, for the\n" +
      "     visit counts `jevmemo` is handed -- and drops it before writing `StepRow`.\n" +
      "     `StepRow` now has `x`/`y`, so a later run answers the positional question\n" +
      "     for nothing; this record cannot, and no amount of re-reading it will.\n",
  );

  // -------------------------------------------- the axis, which IS recorded

  console.log("§1 refusal rate by direction");
  console.log("\n  policy      vertical (j/k)   horizontal (h/l)   diagonal   other   all");
  for (const policy of policies) {
    const steps = games.filter((g) => g.policy === policy).flatMap((g) => g.steps);
    const cell = (axis: Axis): string => {
      const of = steps.filter((s) => axisOf(s.key) === axis);
      return `${pct(of.filter((s) => s.refused).length, of.length)} (${String(of.length).padStart(4)})`;
    };
    console.log(
      `  ${policy.padEnd(10)} ${cell("vertical")}   ${cell("horizontal")}   ` +
        `${cell("diagonal")}   ${cell("other")}   ${pct(steps.filter((s) => s.refused).length, steps.length)}`,
    );
  }

  console.log("\n§2 the asymmetry, against the arms with no model in them");
  console.log("\n  policy      vertical   horizontal   difference   reading");
  for (const policy of policies) {
    const steps = games.filter((g) => g.policy === policy).flatMap((g) => g.steps);
    const rate = (axis: Axis): number => {
      const of = steps.filter((s) => axisOf(s.key) === axis);
      return of.length === 0 ? Number.NaN : of.filter((s) => s.refused).length / of.length;
    };
    const v = rate("vertical");
    const h = rate("horizontal");
    const gap = v - h;
    console.log(
      `  ${policy.padEnd(10)} ${(100 * v).toFixed(0).padStart(7)}%   ${(100 * h).toFixed(0).padStart(9)}%   ` +
        `${`${gap > 0 ? "+" : ""}${(100 * gap).toFixed(0)}`.padStart(10)}pt   ` +
        (Math.abs(gap) < 0.05 ? "no axis preference" : gap > 0 ? "vertical worse" : "horizontal worse"),
    );
  }

  // --------------------------------- does the model know it is about to fail

  console.log("\n§3 does confidence see the refusal coming?");
  console.log("\n  policy      confidence when accepted   when refused   difference   n refused");
  for (const policy of policies) {
    const steps = games
      .filter((g) => g.policy === policy)
      .flatMap((g) => g.steps)
      .filter((s) => s.confidence !== undefined);
    if (steps.length === 0) continue;
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const ok = mean(steps.filter((s) => !s.refused).map((s) => s.confidence as number));
    const no = mean(steps.filter((s) => s.refused).map((s) => s.confidence as number));
    const n = steps.filter((s) => s.refused).length;
    console.log(
      `  ${policy.padEnd(10)} ${ok.toFixed(3).padStart(24)}   ${no.toFixed(3).padStart(12)}   ` +
        `${`${no - ok > 0 ? "+" : ""}${(no - ok).toFixed(3)}`.padStart(10)}   ${String(n).padStart(9)}`,
    );
  }
  console.log(
    "\n  >> A refusal is the game saying the move was impossible, so a model that could\n" +
      "     see the wall should be less confident about the moves it gets refused. Read\n" +
      "     the difference against docs/35's finding that confidence can track something\n" +
      "     other than the output's correctness.",
  );

  // ------------------------------------- is it the same square over and over

  console.log("\n§4 how many offers were left when a move was refused?");
  console.log("\n  policy      mean `offered` when accepted   when refused   refusals at <=3 offers");
  for (const policy of policies) {
    const steps = games.filter((g) => g.policy === policy).flatMap((g) => g.steps);
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const refused = steps.filter((s) => s.refused);
    console.log(
      `  ${policy.padEnd(10)} ${mean(steps.filter((s) => !s.refused).map((s) => s.offered)).toFixed(1).padStart(28)}   ` +
        `${mean(refused.map((s) => s.offered)).toFixed(1).padStart(12)}   ` +
        `${pct(refused.filter((s) => s.offered <= 3).length, refused.length).padStart(22)}`,
    );
  }
  console.log(
    "\n  >> `play.ts` excludes a key the game has already refused FROM THE SAME SQUARE\n" +
      "     on the same turn, so `offered` falls as a square is exhausted. A low figure\n" +
      "     here means the refusals cluster where few moves were left -- a corner or a\n" +
      "     dead end -- and a figure near the accepted mean means they are spread.\n",
  );

  // ------------------------------- what the arms were actually told

  console.log("§5 wall avoidance, normalised against the blind arm");
  console.log(
    "\n  Every one of the eight steps is offered even when it walks into a wall\n" +
      "  (`actions.ts` says why: deleting the option would delete the measurement), and\n" +
      "  each option's text states what the square shows. So `random` picking uniformly\n" +
      "  measures how often a neighbour IS a wall, and every other arm can be scored\n" +
      "  against it: 100% means it never walked into one, 0% means it did as often as\n" +
      "  picking blind.\n",
  );
  const blind = (axis: Axis): number => {
    const of = games
      .filter((g) => g.policy === "random")
      .flatMap((g) => g.steps)
      .filter((s) => axisOf(s.key) === axis);
    return of.filter((s) => s.refused).length / Math.max(1, of.length);
  };
  console.log("  policy      walls avoided: vertical   horizontal   what the arm was given");
  const GIVEN: Record<string, string> = {
    random: "nothing; picks uniformly",
    greedy: "a hand-written heuristic",
    jev: "each square's glyph, in the option text",
    jevbare: "the direction name ONLY; map from the screen",
    jevmemo: "the glyph AND the visit count, + a new goal",
  };
  for (const policy of policies) {
    if (policy === "random") continue;
    const steps = games.filter((g) => g.policy === policy).flatMap((g) => g.steps);
    const avoided = (axis: Axis): string => {
      const of = steps.filter((s) => axisOf(s.key) === axis);
      if (of.length === 0) return "    -";
      const rate = of.filter((s) => s.refused).length / of.length;
      const base = blind(axis);
      return base === 0 ? "    -" : `${(100 * (1 - rate / base)).toFixed(0).padStart(4)}%`;
    };
    console.log(
      `  ${policy.padEnd(10)} ${avoided("vertical").padStart(22)}   ${avoided("horizontal").padStart(10)}   ` +
        GIVEN[policy],
    );
  }
  console.log(
    "\n  >> `jev` NEVER WALKS INTO A WALL, and `jevmemo` -- which is handed the same\n" +
      "     glyph text plus a visit count -- walks into vertical ones at the blind rate.\n" +
      "     So `jevmemo`'s 19% is not a reading failure. The information was in its\n" +
      "     payload and `jev` used it. It is a PRIORITY failure, and the payload says\n" +
      "     exactly why:",
  );
  console.log(
    "\n     a wall square has never been stood on, so its visit count is 0, so the\n" +
      "     sentence `jevmemo` adds to it is:\n\n" +
      "       step north; the square there shows `-` = wall; YOU HAVE NEVER STOOD THERE\n\n" +
      "     and the instructions it adds are:\n\n" +
      "       ...prefer a direction that leads to ground you have not walked...\n\n" +
      "     THE MEMORY RECOMMENDS WALLS. Every wall is unvisited by definition, so the\n" +
      "     added sentence and the added goal both point at it, against the base goal's\n" +
      "     `walking into a wall achieves nothing`. docs/34 §2.4 read the 19% as a price\n" +
      "     paid for exploring; it is a contradiction in the prompt, and it is mine.\n",
  );
  console.log(
    "     Two fixes, neither measured yet: suppress the visit count where the glyph is\n" +
      "     not walkable, or say `never stood there, and you cannot` so the two facts\n" +
      "     arrive joined. docs/06 homework (a) is the experiment that separates them.\n",
  );
}

main();
