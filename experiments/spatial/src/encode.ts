/**
 * One space, seven encodings.
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
 * are identical in every encoding, and docs/34 measured them at 100%. If
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

/** The encodings. `ascii` is the control: docs/34's state, unchanged. */
export type ArmName = "ascii" | "ruler" | "coords" | "sparse" | "code" | "runs" | "relative";

/** Picture forms, then coordinate forms, then the arm that leaks. */
export const ARMS: readonly ArmName[] = [
  "ascii",
  "ruler",
  "coords",
  "sparse",
  "code",
  "runs",
  "relative",
] as const;

/**
 * Arms whose encoding contains the answer to a directional question.
 *
 * Reported on its own line, never averaged into "the coordinate arms". The
 * distinction is the whole reason the arm is here.
 */
export const LEAKY: ReadonlySet<ArmName> = new Set<ArmName>(["relative"]);

/**
 * Arms from which the grid CANNOT be rebuilt character for character.
 *
 * `sparse` is the only one, and it is the point of the arm rather than a
 * defect: see `FORM.sparse`. Named in a set so `test.ts` can assert
 * losslessness for everything else instead of relaxing the assertion to
 * whatever happens to pass.
 */
export const LOSSY: ReadonlySet<ArmName> = new Set<ArmName>(["sparse"]);

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
  /**
   * The glyph `sparse` leaves out. `.` in both corpora; overridable so a
   * future space can name its own filler rather than inherit NetHack's.
   */
  floor?: string;
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
  sparse: `, as a table of coordinates with the ordinary floor left out: one entry per drawn character that is not floor. ${AXES}`,
  code: `, as a program that draws it: one statement per drawn character. ${AXES}`,
  runs: `, as a program that draws it: one statement per run of identical characters along a row. ${AXES}`,
  relative:
    ", as a list of offsets from your own position. " +
    "dx is columns to the right of you and dy is rows below you; " +
    "a negative dx is to the left and a negative dy is above.",
};

/**
 * WHAT `sparse` IS FOR, AND WHAT IT MUST BREAK -- WRITTEN BEFORE THE RUN.
 *
 * docs/63 §2.3 measured a trade: the coordinate table fixed the column axis
 * (74% -> 99%) and dropped `monster_count`'s AUC from 0.926 to 0.781. I called
 * that "no free lunch", and [TODO §1.13](../../../TODO.md) says why that
 * reading is not yet earned: the table carries ONE ENTRY PER DRAWN CELL and
 * 73% of those entries are floor, so "coordinates hurt counting" and "the
 * haystack grew to 300 entries" are the same observation so far.
 *
 * `sparse` separates them. Same coordinates, same order, floor omitted.
 *
 *   If the counting loss is about VOLUME, `sparse` recovers `monster_count`
 *   while keeping the column axis, and docs/63 §2.3's "no free lunch" was
 *   wrong -- the lunch was just badly packed.
 *   If the loss is about the COORDINATE FORM, `sparse` stays at ~0.78 and
 *   §2.3 stands.
 *
 * AND IT HAS TO BREAK TWO PROBES. `dead_end` and `in_room` count how many of
 * the eight neighbours can be WALKED ON, and floor is walkable while
 * unexplored blank is not. Once floor is unlisted those two answers are no
 * longer in the state on a NetHack screen: "not listed" means floor OR
 * unexplored. So this arm is expected to fall on exactly those two and on
 * nothing else, and the report prints it rather than hiding it -- a predicted
 * failure that arrives is evidence about the encoding; an unpredicted one is
 * evidence about me.
 *
 * On the drawn rooms of §1 the omission is LOSSLESS, because those rooms are
 * full rectangles with no unexplored blank in them: every position inside the
 * wall that is not listed is floor. The wording below is computed from the
 * grid for that reason, and it is the one place where an arm says something
 * different in §1 and §2.
 */
function sparseNote(rows: readonly string[], floor: string): string {
  const blank = rows.some((r) => r.includes(" "));
  return blank
    ? `Every position that is not listed is either ordinary floor, drawn as ${floor}, or a position that has not been explored.`
    : `Every position that is not listed is ordinary floor, drawn as ${floor}.`;
}

/**
 * WHAT `runs` IS FOR -- ALSO WRITTEN BEFORE THE RUN.
 *
 * docs/63 §2.4 found the code form 47% cheaper in tokens than the JSON table
 * at the same byte count. `runs` compresses the same form again, one statement
 * per run of identical characters instead of per character, and sits exactly
 * between `ascii` (no coordinate anywhere) and `code` (a coordinate on every
 * character).
 *
 * MY PREDICTION: the column axis holds. `<` and `@` are single characters, so
 * each is its own run of length one and still carries an explicit x -- the two
 * numbers `upstairs_east` compares are in the state either way. If the column
 * axis DROPS under `runs`, then what helped was not the coordinate on the
 * glyph being asked about but the uniformity of the form, which would be a
 * different finding and a more interesting one.
 */
export interface Run {
  x: number;
  y: number;
  text: string;
}

/** Maximal runs of one repeated character along a row, in reading order. */
export function runsOf(rows: readonly string[], skip = " "): Run[] {
  const out: Run[] = [];
  for (let y = 0; y < rows.length; y += 1) {
    const row = rows[y];
    let x = 0;
    while (x < row.length) {
      const glyph = row[x];
      let end = x;
      while (end < row.length && row[end] === glyph) end += 1;
      if (glyph !== skip) out.push({ x, y, text: glyph.repeat(end - x) });
      x = end;
    }
  }
  return out;
}

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
  // EVERY LABELLED COLUMN CARRIES ITS WHOLE NUMBER, and it took two tries.
  // The first version printed the tens digit as `floor(x / 10) % 10`, so
  // column 100 read as "0"; the second added a hundreds line but only at
  // multiples of 100, so column 110 read as blank-1-0, which is column 10.
  // The anchor is every tenth column and each place prints its digit there.
  // NetHack is 80 columns and the rooms here reach 60, so no recorded payload
  // ever contained a wrong form -- which is the reason to fix it rather than a
  // reason not to, because the next caller has no way to know the limit. A
  // hundreds line appears only above 99, so output below that is unchanged and
  // the recorded `ruler` payloads stay valid.
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
 * The same coordinates as a program, one statement per character.
 *
 * `runs` below is the run-length version of this, and the pair is the
 * comparison: `ascii` puts a coordinate on nothing, `code` on every character,
 * `runs` on the start of each stretch. Keeping both means "does an explicit
 * coordinate help" and "does it have to be on every character" are separate
 * questions instead of one.
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

/** The same picture as a program, one statement per run of equal characters. */
export function drawRuns(rows: readonly string[], width: number, height: number): string {
  const lines = [
    `const screen = new Screen({ width: ${width}, height: ${height} });`,
    "// screen.span(x, y, text) writes text rightwards along row y, starting at column x",
  ];
  for (const r of runsOf(rows)) {
    lines.push(`screen.span(${r.x}, ${r.y}, ${JSON.stringify(r.text)});`);
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
  } else if (arm === "sparse") {
    const floor = scene.floor ?? ".";
    // The omission rule goes in the state. Leaving the floor out WITHOUT
    // saying so would be a shorter state and a different question: "what is
    // at an unlisted position" has to be answerable, or the arm is measuring
    // whether an omission can be guessed.
    state.floor_is_omitted = sparseNote(scene.rows, floor);
    state.grid = { width, height: scene.rows.length };
    state.cells = cellsOf(scene.rows)
      .filter((c) => c.glyph !== floor)
      .map((c) => ({ x: c.x, y: c.y, glyph: c.glyph }));
  } else if (arm === "code") {
    state.code = drawCode(scene.rows, width, scene.rows.length);
  } else if (arm === "runs") {
    state.code = drawRuns(scene.rows, width, scene.rows.length);
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
 * Every encoding of one scene, so a caller cannot ask several different
 * scenes by accident. All the states are built from one `rows` array.
 */
export function encodeAll(scene: Scene): Record<ArmName, Record<string, unknown>> {
  return Object.fromEntries(ARMS.map((a) => [a, encode(scene, a)])) as Record<
    ArmName,
    Record<string, unknown>
  >;
}
