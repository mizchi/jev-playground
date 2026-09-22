/**
 * One space, five encodings.
 *
 * [docs/34 §1.1](../../../docs/34-roguelike.md#11-一番はっきりした構造-行は読めて列は読めない)
 * found the sharpest structure in this repository: on the SAME board and the
 * SAME `<`, "is it on a lower row" scored 96% / AUC 0.997 and "is it in a
 * column to the right" scored 74% / AUC 0.857. The map went in as twenty-one
 * strings, so comparing rows is comparing array indices and comparing columns
 * is counting characters inside a string.
 *
 * That leaves a question docs/34 wrote down and could not answer: is the
 * column axis a limit of the JUDGMENT, or a limit of the STATE I chose? Its
 * "next to try" list names the three shapes to measure -- a column ruler,
 * `@`-relative coordinates, and an `(x, y)` table -- and notes that all three
 * are measurable on the 244 screens already recorded.
 *
 * So this module is the independent variable and nothing else. Every arm
 * receives:
 *
 *   the same space (the same grid of characters),
 *   the same questions (`probesFor` from the roguelike experiment, byte for
 *     byte, so the wording cannot drift between arms),
 *   the same non-spatial text (NetHack's two status lines, passed through
 *     verbatim).
 *
 * THE STATUS LINES ARE THE INSTRUMENT CHECK. They are ordinary prose, they
 * are identical in all five encodings, and docs/34 measured them at 100%. If
 * the `status` band moves when the geometry encoding changes, the harness is
 * leaking and no other number here means anything.
 *
 * ONE ARM ANSWERS THE QUESTION IT IS ASKED. `relative` hands over each cell as
 * an offset from the `@`, and `upstairs_east` asks whether the `<` is in a
 * column to the right of the `@` -- which is the sign of `dx`. That is not
 * perception, it is reading a number that was computed by my code, and a high
 * score there measures my encoder. It is kept because it is the ceiling: it
 * separates "cannot see the relation" from "cannot do the comparison". It is
 * never pooled with the other arms, and `LEAKY` exists so the report cannot
 * forget.
 */

/** The five encodings. `ascii` is the control: docs/34's state, unchanged. */
export type ArmName = "ascii" | "ruler" | "coords" | "code" | "relative";

export const ARMS: readonly ArmName[] = ["ascii", "ruler", "coords", "code", "relative"] as const;

/**
 * Arms whose encoding contains the answer to a directional question.
 *
 * Reported on its own line, never averaged into "the coordinate arms". The
 * distinction is the whole reason the arm is here.
 */
export const LEAKY: ReadonlySet<ArmName> = new Set<ArmName>(["relative"]);

export interface Scene {
  /** The picture, as rows of text. Row 0 is the top. */
  rows: string[];
  /**
   * The subject, without any mention of the form -- each arm appends its own.
   * Splitting it is what lets `ascii` reproduce docs/34's state exactly while
   * the other four describe themselves.
   */
  subject: string;
  /**
   * Passed to every arm unchanged, after the geometry. NetHack's status lines
   * ride here: they are the control band, so they must not vary.
   */
  extra?: Record<string, unknown>;
  /**
   * What the glyphs mean, when the glyphs are not public knowledge.
   *
   * Absent for NetHack on purpose: docs/34 did not supply one, and adding it
   * to these arms would change two things at once.
   */
  legend?: Record<string, string>;
  /** The observer's glyph, the origin for `relative`. */
  observer?: string;
}

/**
 * The axis convention, written ONCE.
 *
 * `coords`, `code` and `relative` all need x and y defined or they are
 * unanswerable, and if each arm phrased it differently a difference between
 * them could be my prose rather than the form. One string, three arms.
 */
const AXES =
  "x is the column, counted from 0 at the left edge; y is the row, counted from 0 at the top. " +
  "A larger x is further right on the screen; a larger y is further down.";

const FORM: Record<ArmName, string> = {
  // Byte for byte docs/34's wording. A test pins it.
  ascii: ", in plain ASCII, exactly as the terminal shows it",
  ruler: ", in plain ASCII, with a column ruler above it and a row number on every line",
  coords: `, as a table of coordinates: one entry per drawn character. ${AXES}`,
  code: `, as a program that draws it: one statement per drawn character. ${AXES}`,
  relative:
    ", as a list of offsets from your own position. " +
    "dx is columns to the right of you and dy is rows below you; " +
    "a negative dx is to the left and a negative dy is above.",
};

export interface Cell {
  x: number;
  y: number;
  glyph: string;
}

/**
 * The drawn characters, in reading order.
 *
 * ROW-MAJOR IS A DECISION, not a detail. Sorting these by `x` would hand the
 * column ordering to the arm for free -- "is the `<` right of the `@`" would
 * become "which one came later in the list" -- and the difference from `ascii`
 * would then be an ordering I supplied, not a coordinate system. Reading order
 * is the order the ASCII arm sees, so the two differ in form alone.
 */
export function cellsOf(rows: readonly string[], skip = " "): Cell[] {
  const out: Cell[] = [];
  for (let y = 0; y < rows.length; y += 1) {
    const row = rows[y];
    for (let x = 0; x < row.length; x += 1) {
      const glyph = row[x];
      if (glyph !== skip) out.push({ x, y, glyph });
    }
  }
  return out;
}

/** Where the observer stands, or null when it is not drawn. */
export function observerAt(rows: readonly string[], glyph: string): Cell | null {
  for (const cell of cellsOf(rows)) if (cell.glyph === glyph) return cell;
  return null;
}

/**
 * Two header lines giving each column's number, and a row number per line.
 *
 * The prefix is a fixed width so the ruler stays aligned with the picture; if
 * it did not, this arm would be a worse ASCII rather than a different one.
 * Nothing is inserted INSIDE a row -- the picture survives the prefix intact.
 *
 * THE SEPARATOR IS A SPACE, AND `|` WAS THE FIRST TRY. `|` is a wall glyph, so
 * a room's left wall came out as `01||.........|` and the wall looked two
 * cells thick. That is not a neutral notation: it damages the picture this arm
 * is supposed to ANNOTATE, and a "the ruler did not help" result would then be
 * partly my separator. A space cannot collide with a glyph, and the ruler
 * above is what says where column 0 begins.
 */
export function ruled(rows: readonly string[]): string[] {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const pad = "   "; // "NN " -- two digits and the separator
  // THE TENS DIGIT WAS `Math.floor(x / 10) % 10`, which prints column 100 as
  // "0" and column 110 as "1" -- a ruler that lies at exactly the widths where
  // a reader would need it most. NetHack is 80 columns and the rooms here go
  // to 60, so no recorded payload contains the wrong form, and that is the
  // reason to fix it now rather than a reason not to: the next caller has no
  // way to know the limit. A hundreds line appears only above 99, so the
  // output below that is unchanged and `grid.json` stays valid.
  // EVERY LABELLED COLUMN CARRIES ITS WHOLE NUMBER. Printing the hundreds
  // digit only at multiples of 100 was the second version of this bug: column
  // 110 then came out blank-1-0, which reads as column 10. So the anchor is
  // every tenth column and each place prints its digit there.
  const digits: string[] = [];
  for (const place of [100, 10]) {
    if (place === 100 && width <= 99) continue;
    let line = "";
    for (let x = 0; x < width; x += 1) {
      line += x % 10 === 0 ? String(Math.floor(x / place) % 10) : " ";
    }
    digits.push(`${pad}${line}`);
  }
  let ones = "";
  for (let x = 0; x < width; x += 1) ones += String(x % 10);
  return [
    ...digits,
    `${pad}${ones}`,
    ...rows.map((row, y) => `${String(y).padStart(2, "0")} ${row}`),
  ];
}

/** How many header lines `ruled` puts above the picture, for a given width. */
export function rulerLines(width: number): number {
  return width > 99 ? 3 : 2;
}

/**
 * The same coordinates as a program.
 *
 * Deliberately one statement per character rather than one per run of
 * characters: a run-length form (`row(10, 40, "------")`) is halfway back to
 * the ASCII rows, and the question here is whether an explicit
 * coordinate-per-character form reads better than a picture. It is the most
 * expensive encoding of the five and the report prints what it cost.
 */
export function drawCode(rows: readonly string[], width: number, height: number): string {
  const lines = [
    `const screen = new Screen({ width: ${width}, height: ${height} });`,
    "// screen.put(x, y, glyph)",
  ];
  for (const c of cellsOf(rows)) {
    lines.push(`screen.put(${c.x}, ${c.y}, ${JSON.stringify(c.glyph)});`);
  }
  return lines.join("\n");
}

/**
 * The state for one arm.
 *
 * Key order is fixed and the same everywhere: what, then the geometry, then
 * `extra`. `ascii` must deep-equal the roguelike experiment's `stateFor`, so
 * the two experiments' §1 numbers are about the same request.
 */
export function encode(scene: Scene, arm: ArmName): Record<string, unknown> {
  const state: Record<string, unknown> = { what: `${scene.subject}${FORM[arm]}` };
  if (scene.legend) state.legend = scene.legend;
  const width = Math.max(0, ...scene.rows.map((r) => r.length));

  if (arm === "ascii") {
    state.map_rows = [...scene.rows];
  } else if (arm === "ruler") {
    state.map_rows = ruled(scene.rows);
  } else if (arm === "coords") {
    state.cells = cellsOf(scene.rows).map((c) => ({ x: c.x, y: c.y, glyph: c.glyph }));
  } else if (arm === "code") {
    state.code = drawCode(scene.rows, width, scene.rows.length);
  } else {
    const glyph = scene.observer ?? "@";
    const you = observerAt(scene.rows, glyph);
    if (!you) throw new Error(`relative: no observer '${glyph}' on the grid`);
    state.you = { glyph, dx: 0, dy: 0 };
    state.cells = cellsOf(scene.rows)
      .filter((c) => !(c.x === you.x && c.y === you.y))
      .map((c) => ({ dx: c.x - you.x, dy: c.y - you.y, glyph: c.glyph }));
  }

  for (const [k, v] of Object.entries(scene.extra ?? {})) state[k] = v;
  return state;
}

/**
 * Every encoding of one scene, so a caller cannot ask five different scenes
 * by accident. The five states are built from one `rows` array.
 */
export function encodeAll(scene: Scene): Record<ArmName, Record<string, unknown>> {
  return Object.fromEntries(ARMS.map((a) => [a, encode(scene, a)])) as Record<
    ArmName,
    Record<string, unknown>
  >;
}
