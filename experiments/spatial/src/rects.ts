/**
 * Two rectangles. Do they overlap?
 *
 * [docs/63](../../../docs/63-spatial.md) measured relations between the
 * OBSERVER and one thing: "is the `<` to my right", "is the `*` next to me".
 * It found two shapes of answer -- the axis that is an array index is free,
 * the axis that must be counted inside a string is not -- and one limit that
 * coordinates did not lift: the egocentric relation had to be pre-computed.
 *
 * A rectangle overlap is a different question in three ways, and that is why
 * it is worth its own corpus:
 *
 *   THE RELATION IS BETWEEN TWO THINGS, neither of which is the observer. There
 *     is no `@` here at all. If docs/63's "compute the relation for it" result
 *     is about egocentricity, object-to-object relations should behave better;
 *     if it is about relations generally, they should behave the same.
 *   THE ANSWER HAS A ONE-CELL BOUNDARY. Overlapping by one column, touching
 *     with no gap, and missing by one column are three different answers to
 *     three nearly identical pictures. The margin is a difficulty dial I can
 *     turn, which docs/63 had no equivalent of.
 *   THE OBJECT IS A SHAPE, so there is an encoding docs/63 could not have:
 *     the figure itself, `{x, y, width, height}`. That is the rung above
 *     coordinates on the same ladder -- pixels, then pixels with coordinates,
 *     then the shape -- and it is the encoding a program would actually use.
 *
 * DRAWN AS OUTLINES, AND THAT IS A DECISION. Two FILLED rectangles cannot be
 * rastered without either hiding one under the other or marking the
 * intersection with a third glyph -- and a third glyph IS the answer
 * ("is there an X anywhere"), which would make the picture arm a lookup and
 * the whole comparison meaningless. Outlines have neither problem: each
 * rectangle's extent is recoverable from its own corners, and nothing in the
 * picture says whether the interiors meet.
 *
 * Every answer is computed from the four numbers the generator placed.
 */
import type { Question } from "../../shared/jev.js";
import type { Scene } from "./encode.js";

export const GLYPH_A = "A";
export const GLYPH_B = "B";
export const BACKGROUND = ".";

/** The grid the two rectangles are drawn on. Height fixed, width swept. */
export const HEIGHT = 14;
export const WIDTHS = [20, 48] as const;

/**
 * How close the two rectangles come along the deciding axis.
 *
 * `edge1` and `touch` differ by ONE CELL and have opposite answers, which is
 * the pair this corpus exists for. `deep` and `gap1` are the easy sides of
 * each answer, kept so accuracy is not reported only on the hard cases.
 */
export type Margin = "deep" | "edge1" | "touch" | "gap1";
export const MARGINS: readonly Margin[] = ["deep", "edge1", "touch", "gap1"] as const;
/** Two of the four overlap, so `overlap` is true on exactly half the corpus. */
export const OVERLAPPING: ReadonlySet<Margin> = new Set<Margin>(["deep", "edge1"]);

export type Axis = "x" | "y";
export const AXES_: readonly Axis[] = ["x", "y"] as const;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RectCase {
  key: string;
  gridWidth: number;
  gridHeight: number;
  /** The axis whose margin decides the answer. */
  axis: Axis;
  margin: Margin;
  a: Rect;
  b: Rect;
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

const hi = (r: Rect, axis: Axis): number => (axis === "x" ? r.x + r.width - 1 : r.y + r.height - 1);
const lo = (r: Rect, axis: Axis): number => (axis === "x" ? r.x : r.y);

/** Do the two rectangles share at least one cell? The truth, from the numbers. */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.width - 1 && b.x <= a.x + a.width - 1 && a.y <= b.y + b.height - 1 && b.y <= a.y + a.height - 1;
}

/** How many cells the two share. Zero when they do not overlap. */
export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The overlap along one axis, in cells. Negative is a gap. */
function span(a: Rect, b: Rect, axis: Axis): number {
  return Math.min(hi(a, axis), hi(b, axis)) - Math.max(lo(a, axis), lo(b, axis)) + 1;
}

function marginOf(a: Rect, b: Rect, axis: Axis): Margin | null {
  const s = span(a, b, axis);
  if (s >= 2) return "deep";
  if (s === 1) return "edge1";
  if (s === 0) return "touch";
  return s === -1 ? "gap1" : null;
}

/**
 * The corpus: `reps` cases for each (width x axis x margin) cell.
 *
 * REJECTION SAMPLING, for the same reason as docs/63's rooms: deriving the
 * legal placements per cell by hand is where a bias hides, and a constraint
 * that (say) always put A on the left would silently make one directional
 * question trivial.
 *
 * TWO CONSTRAINTS, both there to keep a question answerable:
 *
 *   the two rectangles never share a left edge or a top edge, so
 *   `a_starts_left` and `a_starts_above` are always defined and, because the
 *   signs are free, come out balanced;
 *   neither rectangle contains the other, because a contained rectangle's
 *   outline sits inside the other's and the "do the regions meet" question
 *   stops being about a margin.
 */
export function corpus(reps = 15, seed = 20260922): RectCase[] {
  const rnd = mulberry32(seed);
  const out: RectCase[] = [];
  for (const gridWidth of WIDTHS) {
    const need = new Map<string, number>();
    for (const axis of AXES_) for (const m of MARGINS) need.set(`${axis}/${m}`, reps);
    let attempts = 0;
    while ([...need.values()].some((n) => n > 0)) {
      attempts += 1;
      if (attempts > 8_000_000) throw new Error(`rects: width ${gridWidth} cannot be filled`);
      const pick = (loV: number, hiV: number): number => loV + Math.floor(rnd() * (hiV - loV + 1));
      const mk = (): Rect => {
        const w = pick(3, Math.max(3, Math.floor(gridWidth / 3)));
        const h = pick(3, Math.max(3, Math.floor(HEIGHT / 3)));
        return { x: pick(0, gridWidth - w), y: pick(0, HEIGHT - h), width: w, height: h };
      };
      const a = mk();
      const b = mk();
      if (a.x === b.x || a.y === b.y) continue;
      const inside = (p: Rect, q: Rect): boolean =>
        p.x >= q.x && p.y >= q.y && p.x + p.width <= q.x + q.width && p.y + p.height <= q.y + q.height;
      if (inside(a, b) || inside(b, a)) continue;
      // The DECIDING axis is the one whose span is smallest: that is the axis
      // the answer turns on. The other axis must overlap, or the margin on the
      // deciding axis would not be what decides.
      const sx = span(a, b, "x");
      const sy = span(a, b, "y");
      const axis: Axis = sx <= sy ? "x" : "y";
      const other: Axis = axis === "x" ? "y" : "x";
      if (span(a, b, other) < 1) continue;
      const margin = marginOf(a, b, axis);
      if (!margin) continue;
      const slot = `${axis}/${margin}`;
      if ((need.get(slot) ?? 0) <= 0) continue;
      need.set(slot, (need.get(slot) ?? 0) - 1);
      const level = out.length % 2 === 0 ? 1 : pick(2, 9);
      const lit = out.length % 2 === 0;
      out.push({
        key: `w${gridWidth}-${axis}-${margin}-${reps - (need.get(slot) ?? 0)}`,
        gridWidth,
        gridHeight: HEIGHT,
        axis,
        margin,
        a,
        b,
        caption: `Dlvl:${level} lamp:${lit ? "lit" : "out"}`,
        level,
        lit,
      });
    }
  }
  return out;
}

/**
 * The picture: two outlines on a background.
 *
 * B is drawn after A, so a cell on both outlines shows `B`. That happens only
 * when the two share a row or column of cells -- the `edge1` class -- and the
 * legend says so, because a reader who does not know it would have to guess
 * whether `A` went missing or was never there.
 */
export function draw(c: RectCase): string[] {
  const g = Array.from({ length: c.gridHeight }, () => BACKGROUND.repeat(c.gridWidth).split(""));
  const outline = (r: Rect, glyph: string): void => {
    for (let x = r.x; x < r.x + r.width; x += 1) {
      for (let y = r.y; y < r.y + r.height; y += 1) {
        const edge = x === r.x || x === r.x + r.width - 1 || y === r.y || y === r.y + r.height - 1;
        if (edge) g[y][x] = glyph;
      }
    }
  };
  outline(c.a, GLYPH_A);
  outline(c.b, GLYPH_B);
  return g.map((row) => row.join(""));
}

export const LEGEND: Record<string, string> = {
  A: "a cell on the outline of rectangle A",
  B: "a cell on the outline of rectangle B; where the two outlines cross, B is drawn over A",
  ".": "empty space, inside a rectangle or outside both",
};

const SUBJECT = "two rectangles drawn on a grid, each shown as its outline";

export function sceneOf(c: RectCase): Scene {
  return {
    rows: draw(c),
    subject: SUBJECT,
    legend: LEGEND,
    floor: BACKGROUND,
    extra: { status_line: c.caption },
  };
}

// ------------------------------------------------------------- the shape arms

/**
 * The two encodings a picture cannot have -- and BOTH are ceilings.
 *
 * `rects` is the figure itself, the rung above coordinates on the same ladder
 * and the form a program would actually pass. `bounds` is the same figure as
 * the four intervals the overlap predicate reads.
 *
 * MY FIRST VERSION MARKED ONLY `bounds` AS LEAKY, AND THAT WAS WRONG.
 * `overlap` on `bounds` is `a.first_column <= b.last_column && ...` -- four
 * comparisons on numbers I computed. On `rects` it is the same thing after one
 * addition, `x + width - 1`. Neither requires looking at a space, so calling
 * one of them perception and the other a leak would have been a distinction
 * about my arithmetic rather than about the encoding. Both are named here.
 *
 * WHICH MAKES THE PAIR ITS OWN MEASUREMENT. docs/63 found that reading the
 * SIGN of a number handed over was free (`relative` scored 100%). Here the two
 * ceiling arms differ by exactly one addition per rectangle, so `rects`
 * against `bounds` asks whether that addition is free too. And `ascii` against
 * either says how far the picture falls short of having the numbers.
 */
export type ShapeArm = "rects" | "bounds";
export const SHAPE_ARMS: readonly ShapeArm[] = ["rects", "bounds"] as const;
export const SHAPE_LEAKY: ReadonlySet<ShapeArm> = new Set<ShapeArm>(["rects", "bounds"]);

const AXIS_NOTE =
  "x is the column, counted from 0 at the left edge; y is the row, counted from 0 at the top. " +
  "A larger x is further right; a larger y is further down.";

export function encodeShape(c: RectCase, arm: ShapeArm): Record<string, unknown> {
  const state: Record<string, unknown> = {
    what:
      arm === "rects"
        ? `${SUBJECT}, as the two rectangles themselves: a position and a size for each. ${AXIS_NOTE} A rectangle covers width columns starting at x, and height rows starting at y.`
        : `${SUBJECT}, as the range of columns and the range of rows each one covers. ${AXIS_NOTE} Both ends of every range are included.`,
    legend: { A: "rectangle A", B: "rectangle B" },
  };
  const each = (r: Rect): Record<string, number> =>
    arm === "rects"
      ? { x: r.x, y: r.y, width: r.width, height: r.height }
      : { first_column: r.x, last_column: r.x + r.width - 1, first_row: r.y, last_row: r.y + r.height - 1 };
  state.grid = { width: c.gridWidth, height: c.gridHeight };
  state.rectangles = [{ name: "A", ...each(c.a) }, { name: "B", ...each(c.b) }];
  state.status_line = c.caption;
  return state;
}

// --------------------------------------------------------------- the questions

export type Band = "status" | "relation" | "overlap";

export interface RectProbe {
  key: string;
  band: Band;
  question: Question;
  truth: boolean;
}

export interface RectScore {
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
 * `a_starts_left` is deliberately the same SHAPE as docs/63's `east` -- compare
 * one column number with another -- so the column axis can be read across the
 * two corpora. The difference is that neither rectangle is the observer.
 */
export function probesFor(c: RectCase): { nouls: RectProbe[]; scores: RectScore[] } {
  const area = overlapArea(c.a, c.b);
  const nouls: RectProbe[] = [
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
      key: "overlap",
      band: "overlap",
      truth: overlaps(c.a, c.b),
      question: noul(
        "Rectangle A covers a block of cells and so does rectangle B. Do the two blocks share at least one cell?",
        "at least one cell is covered by both rectangle A and rectangle B",
        "no cell is covered by both rectangles",
      ),
    },
    {
      key: "a_starts_left",
      band: "relation",
      truth: c.a.x < c.b.x,
      question: noul(
        "Compare the leftmost column of rectangle A with the leftmost column of rectangle B. Does A begin in a column further to the left than B?",
        "the leftmost column of A is further left than the leftmost column of B",
        "the leftmost column of B is further left than the leftmost column of A",
      ),
    },
    {
      key: "a_starts_above",
      band: "relation",
      truth: c.a.y < c.b.y,
      question: noul(
        "Compare the topmost row of rectangle A with the topmost row of rectangle B. Does A begin on a row above B?",
        "the topmost row of A is above the topmost row of B",
        "the topmost row of B is above the topmost row of A",
      ),
    },
  ];
  // CONDITIONAL, the way docs/34 omits `upstairs_east` when the `<` shares the
  // `@`'s column. With equal widths counted as "not wider" the probe came out
  // 38% true, so answering "no" every time scored 62% -- the base rate, not a
  // reading. Skipping the ties puts the floor back near a coin.
  //
  // This is a SIZE comparison and not a spatial relation, and it is here as
  // the control for the other two: it needs no locating at all, only two
  // numbers read off the same picture.
  if (c.a.width !== c.b.width) {
    nouls.push({
      key: "a_is_wider",
      band: "relation",
      truth: c.a.width > c.b.width,
      question: noul(
        "Compare how many columns wide rectangle A is with how many columns wide rectangle B is. Is A wider than B?",
        "rectangle A spans more columns than rectangle B",
        "rectangle B spans fewer columns than rectangle A",
      ),
    });
  }
  const scores: RectScore[] = [
    {
      key: "shared_cells",
      band: "overlap",
      level: area === 0 ? 0 : area <= 2 ? 1 : area <= 8 ? 2 : 3,
      question: {
        type: "score",
        instructions:
          "Count the cells that are covered by both rectangle A and rectangle B. How many cells do the two rectangles share?",
        criteria: [
          "the two rectangles share no cell at all",
          "the two rectangles share one or two cells",
          "the two rectangles share between three and eight cells",
          "the two rectangles share nine cells or more",
        ],
      },
    },
  ];
  return { nouls, scores };
}
