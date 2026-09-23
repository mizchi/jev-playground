/**
 * Three dimensions, where a list of strings has no third axis at all.
 *
 * [docs/64](../../../docs/64-spatial.md) found one mechanism and measured it
 * three ways: an axis that is an ARRAY INDEX is free (rows: 100% under every
 * encoding, at every width), and an axis that must be COUNTED INSIDE A STRING
 * is not (columns: 74% in the picture, 100% with coordinates, and decaying
 * 90% -> 73% as the picture widens while the rows stay put).
 *
 * That reading makes a prediction about a space it never saw, and this file
 * exists to write the prediction down before collecting anything.
 *
 * A stack of ASCII slices has THREE nestings:
 *
 *   z  the slice -- the OUTER array index
 *   y  the row inside a slice -- the INNER array index
 *   x  the column -- a character position inside a string
 *
 * SO THE PREDICTION IS: `above` (z) and `south` (y) both read like docs/64's
 * row axis and come out at or near 100%, and `east` (x) is the only axis that
 * costs anything. If instead z is WORSE than y, then nesting costs something
 * that indexing does not, and docs/64's "index versus count" reading is
 * incomplete rather than wrong. Either result says something; that is the
 * point of writing it here first.
 *
 * NO EXPLICIT z LABELS IN THE PICTURE ARM. The slices go in as a plain array of
 * arrays of strings, because `ascii` in docs/64 did not number its rows either
 * -- numbering was `ruler`'s job, and it did not help. Labelling z but not y
 * would hand one of the two index axes an advantage the other does not have,
 * and the comparison between them is the measurement.
 *
 * THE BOX IS MOSTLY AIR. Filling it would put docs/64's haystack confound back
 * in (a 20x7x5 box is 700 cells), and the question here is about locating
 * things across three axes, not about volume. Clutter is added so that every
 * slice has something in it -- otherwise "which slice is the `*` on" would be
 * "which slice is not blank".
 */
import type { Question } from "../../shared/jev.js";

export const OBSERVER = "@";
export const TARGET = "*";
export const CLUTTER = "%";
export const AIR = " ";

/** Rows and slices are held constant; only the width moves. */
export const HEIGHT = 7;
export const DEPTH = 5;
export const WIDTHS = [8, 20] as const;

/** All three signs are non-zero, so every axis question is well defined. */
export type Octant = "ENE" | "ENW" | "ESE" | "ESW" | "WNE" | "WNW" | "WSE" | "WSW";
export type Range = "near" | "far";
export const RANGES: readonly Range[] = ["near", "far"] as const;

export interface Point {
  x: number;
  y: number;
  z: number;
}

export interface SolidCase {
  key: string;
  width: number;
  height: number;
  depth: number;
  octant: Octant;
  range: Range;
  observer: Point;
  target: Point;
  clutter: Point[];
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

/** `E`/`W` on x, `N`/`S` on y, `E`/`W` again on z -- the third letter is depth. */
function octantOf(dx: number, dy: number, dz: number): Octant | null {
  if (dx === 0 || dy === 0 || dz === 0) return null;
  return `${dx > 0 ? "E" : "W"}${dy > 0 ? "S" : "N"}${dz > 0 ? "E" : "W"}` as Octant;
}

export const OCTANTS: readonly Octant[] = ["ENE", "ENW", "ESE", "ESW", "WNE", "WNW", "WSE", "WSW"] as const;

export function chebyshev3(a: Point, b: Point): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
}

/**
 * The corpus: `reps` cases per (width x octant x range) cell.
 *
 * Eight octants with equal counts makes each of the three axis questions
 * exactly 50/50 AND mutually independent -- knowing the answer to `east` says
 * nothing about `south` or `above`. Rejection sampling for the same reason as
 * docs/64's rooms: a hand-derived placement rule is where a bias hides.
 */
export function corpus(
  reps = 4,
  seed = 20260922,
  // THE DIMENSIONS ARE A PARAMETER so TODO §1.15 can swap them. docs/65 §2.1
  // read z 98% / y 88% as "outer index against inner index", but the block had
  // five layers and seven rows, so the same numbers are also "five against
  // seven". The defaults are the original 7 rows x 5 layers, so the recorded
  // corpus -- and `solid.json` -- are exactly what they were.
  dims: { height: number; depth: number } = { height: HEIGHT, depth: DEPTH },
): SolidCase[] {
  const rnd = mulberry32(seed);
  const out: SolidCase[] = [];
  const H = dims.height;
  const D = dims.depth;
  for (const width of WIDTHS) {
    const need = new Map<string, number>();
    for (const o of OCTANTS) for (const r of RANGES) need.set(`${o}/${r}`, reps);
    let attempts = 0;
    while ([...need.values()].some((n) => n > 0)) {
      attempts += 1;
      if (attempts > 8_000_000) throw new Error(`solid: width ${width} cannot be filled`);
      const pick = (loV: number, hiV: number): number => loV + Math.floor(rnd() * (hiV - loV + 1));
      const at = (): Point => ({ x: pick(0, width - 1), y: pick(0, H - 1), z: pick(0, D - 1) });
      const observer = at();
      const target = at();
      const octant = octantOf(target.x - observer.x, target.y - observer.y, target.z - observer.z);
      if (!octant) continue;
      const d = chebyshev3(observer, target);
      const range: Range | null = d === 1 ? "near" : d >= 3 ? "far" : null;
      if (!range) continue;
      const slot = `${octant}/${range}`;
      if ((need.get(slot) ?? 0) <= 0) continue;
      need.set(slot, (need.get(slot) ?? 0) - 1);
      // Two per slice on average, so no slice is blank and "which slice" is a
      // real search rather than "the one that is not empty".
      const taken = new Set([`${observer.x},${observer.y},${observer.z}`, `${target.x},${target.y},${target.z}`]);
      const clutter: Point[] = [];
      const wanted = D * 2;
      for (let i = 0; i < wanted * 8 && clutter.length < wanted; i += 1) {
        const p = at();
        const k = `${p.x},${p.y},${p.z}`;
        if (taken.has(k)) continue;
        taken.add(k);
        clutter.push(p);
      }
      const level = out.length % 2 === 0 ? 1 : pick(2, 9);
      const lit = out.length % 2 === 0;
      out.push({
        key: `w${width}-${octant}-${range}-${reps - (need.get(slot) ?? 0)}`,
        width,
        height: H,
        depth: D,
        octant,
        range,
        observer,
        target,
        clutter,
        caption: `Dlvl:${level} lamp:${lit ? "lit" : "out"}`,
        level,
        lit,
      });
    }
  }
  return out;
}

/** The slices, top layer first. Each slice is `height` strings of `width`. */
export function draw(c: SolidCase): string[][] {
  const g = Array.from({ length: c.depth }, () =>
    Array.from({ length: c.height }, () => AIR.repeat(c.width).split("")),
  );
  for (const p of c.clutter) g[p.z][p.y][p.x] = CLUTTER;
  g[c.observer.z][c.observer.y][c.observer.x] = OBSERVER;
  g[c.target.z][c.target.y][c.target.x] = TARGET;
  return g.map((slice) => slice.map((row) => row.join("")));
}

export const LEGEND: Record<string, string> = {
  "@": "you",
  "*": "the target",
  "%": "a crate floating in the air",
  " ": "empty air",
};

// ------------------------------------------------------------------ encodings

export type SolidArm = "layers" | "coords" | "code" | "relative";
export const SOLID_ARMS: readonly SolidArm[] = ["layers", "coords", "code", "relative"] as const;
/** `relative` hands over the sign of every axis, exactly as in docs/64. */
export const SOLID_LEAKY: ReadonlySet<SolidArm> = new Set<SolidArm>(["relative"]);

const SUBJECT = "a rectangular block of air inside a dungeon, sliced into horizontal layers";

/**
 * The axis convention, written ONCE for the three arms that need it.
 *
 * `z` is described as a layer number with 0 at the top, so that "a larger z is
 * lower down" parallels "a larger y is further down" exactly. If the two were
 * phrased differently, a difference between the `south` and `above` questions
 * could be my prose instead of the nesting.
 */
const AXES3 =
  "x is the column, counted from 0 at the left edge of a layer; " +
  "y is the row, counted from 0 at the top of a layer; " +
  "z is the layer, counted from 0 at the topmost layer. " +
  "A larger x is further right, a larger y is further towards the back of a layer, " +
  "and a larger z is further down the stack.";

const FORM: Record<SolidArm, string> = {
  layers: ", drawn in plain ASCII: the layers from the top down, and inside each layer the rows from the front to the back",
  coords: `, as a table of coordinates: one entry per thing in the block. ${AXES3}`,
  code: `, as a program that places things: one statement per thing. ${AXES3}`,
  relative:
    ", as a list of offsets from your own position. " +
    "dx is columns to the right of you, dy is rows behind you, and dz is layers below you; " +
    "a negative value is to the left, in front, or above.",
};

export interface Thing {
  x: number;
  y: number;
  z: number;
  glyph: string;
}

/** Everything that is not air, in layer-then-row-then-column order. */
export function thingsOf(slices: readonly string[][]): Thing[] {
  const out: Thing[] = [];
  for (let z = 0; z < slices.length; z += 1) {
    for (let y = 0; y < slices[z].length; y += 1) {
      const row = slices[z][y];
      for (let x = 0; x < row.length; x += 1) {
        if (row[x] !== AIR) out.push({ x, y, z, glyph: row[x] });
      }
    }
  }
  return out;
}

export function encode3(c: SolidCase, arm: SolidArm): Record<string, unknown> {
  const slices = draw(c);
  const state: Record<string, unknown> = {
    what: `${SUBJECT}${FORM[arm]}`,
    legend: LEGEND,
    block: { width: c.width, height: c.height, layers: c.depth },
  };
  if (arm === "layers") {
    // A plain array of arrays. No z labels, no y labels -- see the docblock.
    state.layers = slices;
  } else if (arm === "coords") {
    state.things = thingsOf(slices).map((t) => ({ x: t.x, y: t.y, z: t.z, glyph: t.glyph }));
  } else if (arm === "code") {
    const lines = [
      `const block = new Block({ width: ${c.width}, height: ${c.height}, layers: ${c.depth} });`,
      "// block.put(x, y, z, glyph)",
    ];
    for (const t of thingsOf(slices)) {
      lines.push(`block.put(${t.x}, ${t.y}, ${t.z}, ${JSON.stringify(t.glyph)});`);
    }
    state.code = lines.join("\n");
  } else {
    const you = c.observer;
    state.you = { glyph: OBSERVER, dx: 0, dy: 0, dz: 0 };
    state.things = thingsOf(slices)
      .filter((t) => !(t.x === you.x && t.y === you.y && t.z === you.z))
      .map((t) => ({ dx: t.x - you.x, dy: t.y - you.y, dz: t.z - you.z, glyph: t.glyph }));
  }
  state.status_line = c.caption;
  return state;
}

// ------------------------------------------------------------------ questions

export type Band = "status" | "axis" | "local";

export interface SolidProbe {
  key: string;
  band: Band;
  question: Question;
  truth: boolean;
}

export interface SolidScore {
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
 * `east`, `south` and `above` are deliberately the SAME SENTENCE with one word
 * changed -- "find the * and compare its column / row / layer with the @'s".
 * docs/64's two axis questions were already built that way, and the third one
 * has to join them or a difference between the axes could be my wording.
 */
export function probesFor(c: SolidCase): { nouls: SolidProbe[]; scores: SolidScore[] } {
  const d = chebyshev3(c.observer, c.target);
  const nouls: SolidProbe[] = [
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
    // ONE SENTENCE, THREE AXES. `test.ts` normalises the axis noun and the
    // direction word and then demands the three be byte-identical -- which is
    // how the first version was caught saying "in a column" and "on a row".
    // A one-word difference in my prose would sit inside the axis comparison
    // this corpus exists to make.
    ...(
      [
        ["east", "column", "right", "left", c.target.x > c.observer.x],
        ["south", "row", "back", "forward", c.target.y > c.observer.y],
        ["above", "layer", "down", "up", c.target.z > c.observer.z],
      ] as const
    ).map(([key, axis, near, away, truth]) => ({
      key,
      band: "axis" as Band,
      truth,
      question: noul(
        `Find the * and compare its ${axis} with the @'s ${axis}. Is the * in a ${axis} further ${near} than the @?`,
        `the * is in a ${axis} further ${near} than the @`,
        `the * is in a ${axis} further ${away} than the @`,
      ),
    })),
    {
      key: "adjacent",
      band: "local",
      truth: d === 1,
      question: noul(
        "Look at the twenty-six cells immediately surrounding the @ in three dimensions, including the diagonals and the cells directly above and below. Is the * in one of them?",
        "the * is in one of the twenty-six cells touching the @",
        "the * is further away than the cells touching the @",
      ),
    },
  ];
  const scores: SolidScore[] = [
    {
      key: "distance",
      band: "local",
      level: d === 1 ? 0 : d <= 4 ? 1 : d <= 9 ? 2 : 3,
      question: {
        type: "score",
        instructions:
          "Find the * and measure how far it is from the @, counting a move to any of the twenty-six touching cells as one step. How many steps would it take to reach the *?",
        criteria: [
          "the * is in a cell touching the @: one step",
          "the * is two to four steps away",
          "the * is five to nine steps away",
          "the * is ten or more steps away",
        ],
      },
    },
  ];
  return { nouls, scores };
}
