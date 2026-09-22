/**
 * A synthetic space, so the questions can be balanced by construction.
 *
 * The 244 NetHack screens measure the real thing, and §2 uses them. But
 * [docs/34's limits](../../../docs/34-roguelike.md#正直な限界) are blunt about
 * what they cannot settle: `dead_end` had ONE positive example, `downstairs_visible`
 * three, `upstairs_visible` was true on 99% of screens. On a lopsided probe
 * the accuracy is mostly the base rate, and `upstairs_east` (40% true) and
 * `upstairs_south` (36% true) are not balanced either -- so the 74%-versus-96%
 * gap that started this experiment is measured against two different base
 * rates on two different subsets (239 and 226 screens).
 *
 * Here I draw the space, so I can fix all of that:
 *
 *   `east` and `south` are true on EXACTLY half the grids, and independent of
 *     each other -- the four quadrants get equal counts;
 *   `adjacent` is true on exactly half, crossed with the quadrant, so
 *     "is it next to me" cannot be answered from "which side is it on";
 *   THE HEIGHT IS FIXED AND THE WIDTH VARIES.
 *
 * That last one is the mechanism test. docs/34's reading of its own result was
 * that rows are array indices and columns are character counts inside a
 * string. If that is right, widening the picture should cost the COLUMN axis
 * and leave the ROW axis alone -- the rows stay eleven however wide the room
 * gets. If both axes decay, or neither does, the character-counting story is
 * wrong.
 *
 * Nothing here is a judgment call: every answer is computed from the two
 * coordinates my own generator placed.
 */
import type { Question } from "../../shared/jev.js";
import type { Scene } from "./encode.js";

/** The observer and the target. Neither glyph means anything to NetHack. */
export const OBSERVER = "@";
export const TARGET = "*";
/** Clutter, so "find the *" is not "find the only thing that is not a dot". */
export const DISTRACTOR = "%";

/** Rows are held constant across the width sweep; only the width moves. */
export const HEIGHT = 11;
export const WIDTHS = [12, 28, 60] as const;

export type Quadrant = "NE" | "NW" | "SE" | "SW";
export const QUADRANTS: readonly Quadrant[] = ["NE", "NW", "SE", "SW"] as const;
/** Chebyshev distance 1 (a diagonal neighbour) against 3 or more. */
export type Range = "near" | "far";
export const RANGES: readonly Range[] = ["near", "far"] as const;

export interface Cellspec {
  quadrant: Quadrant;
  range: Range;
}

export interface GridCase {
  key: string;
  width: number;
  height: number;
  quadrant: Quadrant;
  range: Range;
  observer: { x: number; y: number };
  target: { x: number; y: number };
  distractors: { x: number; y: number }[];
  /** The prose line, identical in shape for every arm -- the control band. */
  caption: string;
  level: number;
  lit: boolean;
}

/** Seeded, so the corpus is a function of the seed and not of the day. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quadrantOf(dx: number, dy: number): Quadrant | null {
  if (dx === 0 || dy === 0) return null;
  // dy < 0 is north, because row 0 is the top row.
  return dy < 0 ? (dx > 0 ? "NE" : "NW") : dx > 0 ? "SE" : "SW";
}

export function chebyshev(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function rangeOf(d: number): Range | null {
  if (d === 1) return "near";
  return d >= 3 ? "far" : null;
}

/**
 * The corpus: `reps` grids for each (width x quadrant x range) cell.
 *
 * REJECTION SAMPLING RATHER THAN A FORMULA. Deriving the legal observer
 * positions for each cell by hand is where a bias would hide -- a constraint
 * that forces the observer onto the middle row would make the row axis
 * artificially easy without saying so. Here positions are uniform over the
 * room's interior and a draw is kept only while its cell is still short, so
 * within a cell the placement is unbiased and across cells the counts are
 * exactly equal.
 */
export function corpus(reps = 6, seed = 20260922): GridCase[] {
  const rnd = mulberry32(seed);
  const out: GridCase[] = [];
  for (const width of WIDTHS) {
    const need = new Map<string, number>();
    for (const q of QUADRANTS) for (const r of RANGES) need.set(`${q}/${r}`, reps);
    let attempts = 0;
    while ([...need.values()].some((n) => n > 0)) {
      attempts += 1;
      if (attempts > 4_000_000) throw new Error(`corpus: width ${width} cannot be filled`);
      const pick = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
      const ax = pick(1, width - 2);
      const ay = pick(1, HEIGHT - 2);
      const tx = pick(1, width - 2);
      const ty = pick(1, HEIGHT - 2);
      const quadrant = quadrantOf(tx - ax, ty - ay);
      if (!quadrant) continue;
      const range = rangeOf(chebyshev({ x: ax, y: ay }, { x: tx, y: ty }));
      if (!range) continue;
      const slot = `${quadrant}/${range}`;
      if ((need.get(slot) ?? 0) <= 0) continue;
      need.set(slot, (need.get(slot) ?? 0) - 1);
      // Clutter never lands on either of the two squares the questions are about.
      const distractors: { x: number; y: number }[] = [];
      const taken = new Set([`${ax},${ay}`, `${tx},${ty}`]);
      const wanted = Math.max(2, Math.round((width - 2) * (HEIGHT - 2) * 0.04));
      for (let i = 0; i < wanted * 4 && distractors.length < wanted; i += 1) {
        const x = pick(1, width - 2);
        const y = pick(1, HEIGHT - 2);
        if (taken.has(`${x},${y}`)) continue;
        taken.add(`${x},${y}`);
        distractors.push({ x, y });
      }
      // The control band, balanced the same way the spatial questions are.
      const level = out.length % 2 === 0 ? 1 : pick(2, 9);
      const lit = out.length % 2 === 0;
      out.push({
        key: `w${width}-${quadrant}-${range}-${reps - (need.get(slot) ?? 0)}`,
        width,
        height: HEIGHT,
        quadrant,
        range,
        observer: { x: ax, y: ay },
        target: { x: tx, y: ty },
        distractors,
        caption: `Dlvl:${level} lamp:${lit ? "lit" : "out"}`,
        level,
        lit,
      });
    }
  }
  return out;
}

/** The picture: a walled room, a floor, the two squares, and the clutter. */
export function draw(c: GridCase): string[] {
  const rows: string[][] = [];
  for (let y = 0; y < c.height; y += 1) {
    const row: string[] = [];
    for (let x = 0; x < c.width; x += 1) {
      const edgeY = y === 0 || y === c.height - 1;
      const edgeX = x === 0 || x === c.width - 1;
      row.push(edgeY ? "-" : edgeX ? "|" : ".");
    }
    rows.push(row);
  }
  for (const d of c.distractors) rows[d.y][d.x] = DISTRACTOR;
  rows[c.observer.y][c.observer.x] = OBSERVER;
  rows[c.target.y][c.target.x] = TARGET;
  return rows.map((r) => r.join(""));
}

/**
 * The legend.
 *
 * NetHack's glyphs are public knowledge and docs/34 supplied no legend, so §2
 * supplies none either. These glyphs are mine, so withholding a legend would
 * measure guessing. It is identical across every arm.
 */
export const LEGEND: Record<string, string> = {
  "@": "you",
  "*": "the target",
  "%": "a piece of food lying on the floor",
  ".": "floor you could walk on",
  "-": "a horizontal wall",
  "|": "a vertical wall",
};

export function sceneOf(c: GridCase): Scene {
  return {
    rows: draw(c),
    subject: "a room in a dungeon, drawn on a grid",
    legend: LEGEND,
    observer: OBSERVER,
    extra: { status_line: c.caption },
  };
}

export type Band = "status" | "local" | "global";

export interface GridProbe {
  key: string;
  band: Band;
  question: Question;
  truth: boolean;
}

export interface GridScore {
  key: string;
  band: Band;
  question: Question;
  level: number;
}

const noul = (instructions: string, t: string, f: string): Question => ({
  type: "noul",
  instructions,
  criteria: { true: t, false: f },
});

/**
 * The questions.
 *
 * `east` and `south` are deliberately worded as close to docs/34's
 * `upstairs_east` and `upstairs_south` as the different glyph allows -- "find
 * the X and compare its column/row with the @'s" -- so the two experiments are
 * asking the same thing about the same kind of relation.
 *
 * The two `status` probes are the control: they are answerable from the one
 * prose line that every arm receives unchanged, so they must not move when the
 * geometry encoding changes. If they do, the harness is at fault.
 */
export function probesFor(c: GridCase): { nouls: GridProbe[]; scores: GridScore[] } {
  const d = chebyshev(c.observer, c.target);
  const nouls: GridProbe[] = [
    {
      key: "deep",
      band: "status",
      truth: c.level > 1,
      question: noul(
        "The status line reports the dungeon level as Dlvl:n. Is the dungeon level 2 or deeper?",
        "Dlvl is 2 or more",
        "Dlvl is 1",
      ),
    },
    {
      key: "lit",
      band: "status",
      truth: c.lit,
      question: noul(
        "The status line reports the lamp as lamp:lit or lamp:out. Is the lamp lit?",
        "the status line says the lamp is lit",
        "the status line says the lamp is out",
      ),
    },
    {
      key: "east",
      band: "global",
      truth: c.target.x > c.observer.x,
      question: noul(
        "Find the * and compare its column with the @'s column. Is the * in a column to the right of the @?",
        "the * is in a column to the right of the @",
        "the * is in a column to the left of the @",
      ),
    },
    {
      key: "south",
      band: "global",
      truth: c.target.y > c.observer.y,
      question: noul(
        "Find the * and compare its row with the @'s row. Is the * on a row below the @?",
        "the * is on a row below the @",
        "the * is on a row above the @",
      ),
    },
    {
      key: "adjacent",
      band: "local",
      truth: d === 1,
      question: noul(
        "Look at the eight squares immediately surrounding the @, including the diagonals. Is the * standing on one of them?",
        "the * is on one of the eight squares touching the @",
        "the * is further away than the eight squares touching the @",
      ),
    },
  ];
  const scores: GridScore[] = [
    {
      key: "distance",
      band: "global",
      // The same banding the truth uses, so "right" means the band and not a
      // rounding of a continuous distance.
      level: d === 1 ? 0 : d <= 4 ? 1 : d <= 9 ? 2 : 3,
      question: {
        type: "score",
        instructions:
          "Find the * and measure how far it is from the @, counting a diagonal step as one step. How many steps would it take to walk from the @ to the *?",
        criteria: [
          "the * is on a square touching the @: one step",
          "the * is two to four steps away",
          "the * is five to nine steps away",
          "the * is ten or more steps away",
        ],
      },
    },
  ];
  return { nouls, scores };
}
