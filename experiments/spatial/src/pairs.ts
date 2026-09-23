/**
 * Two things on a grid: is it the observer, the size, or the gap?
 *
 * [docs/65 §1.4](../../../docs/65-shapes.md#two-rectangles) compared a column
 * question with no observer (two rectangles, `a_starts_left`: 95% in the
 * picture) against [docs/64](../../../docs/64-spatial.md)'s version with one
 * (`*` against `@`, `east`: 74-83%) and concluded the difficulty was the
 * precision the answer demands. [TODO §1.15](../../../TODO.md) says why half
 * of that is not earned: the two corpora differ in at least three ways at once.
 *
 *   OBSERVER -- one term is "you" in docs/64 and neither is in docs/65;
 *   SIZE     -- docs/64's terms are single characters, docs/65's span dozens;
 *   GAP      -- docs/64's rooms put HALF their targets one column away (the
 *               `near` cases), while docs/65's left edges differ by whatever
 *               the rectangle generator happened to produce.
 *
 * The third was not in the TODO item. It turned up when designing this, and it
 * may be the largest of the three: if the picture's column estimate is noisy,
 * a one-column gap is the case the noise flips and an eight-column gap is not.
 *
 * So this corpus holds the geometry fixed and moves one thing at a time:
 *
 *   `you/cell`      A is a single cell and the legend says A is you
 *   `object/cell`   the SAME grid, and the legend says A is an object
 *   `object/block`  the SAME left columns, and A and B are 3x3 blocks
 *
 * The first pair differs in ONE LEGEND ENTRY -- the glyphs, the geometry and
 * the question text are byte-identical -- so it isolates observer-ness. The
 * second pair differs in the objects' extent and nothing else. Every geometry
 * is asked in all three, so both comparisons are paired.
 *
 * NOT A FULL 2x2. A "you" that covers nine cells is not a thing a legend can
 * say without inventing something, and the question §1.15 asks needs only the
 * three cells above: (observer, small) against (none, small) is the observer
 * effect, and (none, small) against (none, large) is the size effect.
 *
 * THE GAP IS A CONTROLLED FACTOR, not a nuisance: exactly 1, 2, 4 or 8 columns,
 * each sign equally often. The prediction, written before the run: if the
 * difficulty is precision, accuracy climbs with the gap in the picture and is
 * flat with coordinates.
 */
import type { Question } from "../../shared/jev.js";
import type { Scene } from "./encode.js";

export const WIDTH = 40;
export const HEIGHT = 13;
export const GAPS = [1, 2, 4, 8] as const;
export type Gap = (typeof GAPS)[number];

export type Variant = "you/cell" | "object/cell" | "object/block";
export const VARIANTS: readonly Variant[] = ["you/cell", "object/cell", "object/block"] as const;

export interface PairCase {
  key: string;
  gap: Gap;
  /** A's leftmost column and top row, and B's. */
  a: { x: number; y: number };
  b: { x: number; y: number };
  caption: string;
  level: number;
  lit: boolean;
}

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

/** Blocks are 3x3; a cell is 1x1. */
export const BLOCK = 3;

/**
 * The geometries: `reps` per (gap x which-is-right x which-is-on-top).
 *
 * A and B sit in DISJOINT ROW BANDS -- one in rows 1-3, the other in rows 7-9 --
 * so a 3x3 block never overlaps the other object however close the columns
 * are. Without that, a one-column gap between two blocks would draw one on top
 * of the other, and the block variant would be measuring occlusion.
 *
 * Positions are placed so the SAME geometry is valid at both sizes: the left
 * column leaves room for a block to its right, so `object/cell` and
 * `object/block` really are the same leftmost columns.
 */
export function corpus(reps = 8, seed = 20260923): PairCase[] {
  const rnd = mulberry32(seed);
  const pick = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const out: PairCase[] = [];
  for (const gap of GAPS) {
    for (const aRight of [true, false]) {
      for (const aTop of [true, false]) {
        for (let r = 0; r < reps; r += 1) {
          // Room for a 3-wide block at the rightmost left column.
          const left = pick(1, WIDTH - 1 - BLOCK - gap);
          const ax = aRight ? left + gap : left;
          const bx = aRight ? left : left + gap;
          const top = pick(1, 3);
          const bottom = pick(7, 9);
          const level = out.length % 2 === 0 ? 1 : pick(2, 9);
          const lit = out.length % 2 === 0;
          out.push({
            key: `g${gap}-${aRight ? "Ar" : "Al"}-${aTop ? "At" : "Ab"}-${r}`,
            gap,
            a: { x: ax, y: aTop ? top : bottom },
            b: { x: bx, y: aTop ? bottom : top },
            caption: `Dlvl:${level} lamp:${lit ? "lit" : "out"}`,
            level,
            lit,
          });
        }
      }
    }
  }
  return out;
}

export function draw(c: PairCase, variant: Variant): string[] {
  const size = variant === "object/block" ? BLOCK : 1;
  const g = Array.from({ length: HEIGHT }, () => ".".repeat(WIDTH).split(""));
  const fill = (p: { x: number; y: number }, glyph: string): void => {
    for (let dy = 0; dy < size; dy += 1) for (let dx = 0; dx < size; dx += 1) g[p.y + dy][p.x + dx] = glyph;
  };
  fill(c.a, "A");
  fill(c.b, "B");
  return g.map((r) => r.join(""));
}

/**
 * The legends -- the ONLY place the observer variants differ.
 *
 * `you/cell` and `object/cell` share every other byte of the state: same
 * glyphs, same grid, same question. A test pins that.
 */
export function legendOf(variant: Variant): Record<string, string> {
  const size = variant === "object/block" ? "a three-by-three block of cells" : "a single cell";
  return {
    A: variant === "you/cell" ? "you: the A marks the cell you are standing on" : `object A, which occupies ${size}`,
    B: `object B, which occupies ${size}`,
    ".": "empty floor",
  };
}

const SUBJECT = "a room drawn on a grid, with two things in it";

export function sceneOf(c: PairCase, variant: Variant): Scene {
  return {
    rows: draw(c, variant),
    subject: SUBJECT,
    legend: legendOf(variant),
    extra: { status_line: c.caption },
  };
}

const noul = (instructions: string, t: string, f: string): Question => ({
  type: "noul",
  instructions,
  criteria: { true: t, false: f },
});

export interface PairProbe {
  key: string;
  band: "status" | "axis";
  question: Question;
  truth: boolean;
}

/**
 * The questions -- identical in all three variants.
 *
 * "The leftmost column of A" is A's column for a single cell and the block's
 * left edge for a block, so ONE sentence covers both sizes; if the sizes were
 * asked differently, a size effect could be my wording. `a_above` is the
 * row-axis control, the same sentence with the axis swapped: rows were free in
 * docs/64, and if they are not free here the corpus is doing something docs/64
 * did not.
 */
export function probesFor(c: PairCase): PairProbe[] {
  return [
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
      key: "a_right",
      band: "axis",
      truth: c.a.x > c.b.x,
      question: noul(
        "Compare the leftmost column of A with the leftmost column of B. Does A begin in a column further right than B?",
        "the leftmost column of A is further right than the leftmost column of B",
        "the leftmost column of A is further left than the leftmost column of B",
      ),
    },
    {
      key: "a_above",
      band: "axis",
      truth: c.a.y < c.b.y,
      question: noul(
        "Compare the topmost row of A with the topmost row of B. Does A begin on a row further up than B?",
        "the topmost row of A is further up than the topmost row of B",
        "the topmost row of A is further down than the topmost row of B",
      ),
    },
  ];
}
