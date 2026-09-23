/**
 * What has to hold before a request is spent.
 *
 *   npm test      # no API key, no NetHack
 *
 * This experiment's whole claim is that THE STATES DIFFER IN ONE THING. That
 * is not something a reader can check by looking at a table, so it is checked
 * here instead:
 *
 *   `ascii` is byte-identical to the roguelike experiment's state, so §2's
 *     control arm IS docs/34's measurement and not a lookalike;
 *   the non-geometry part of the state (NetHack's status lines, the room's
 *     caption) is identical in every encoding, so the control band cannot
 *     move for a reason of mine;
 *   every encoding NOT NAMED IN `LOSSY` is lossless -- an independent decoder
 *     per arm rebuilds the grid character for character, so no arm is handed
 *     less space than another. `sparse` is the one exemption and it is named
 *     in the source, not in whatever assertion happened to pass;
 *   `relative` really does contain the answer. The docblock in `encode.ts`
 *     says so; this asserts it on all 144 rooms, because a claim about a leak
 *     that is only written in prose is a claim nobody checked;
 *   no other encoding carries a probe's answer or its criteria text.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { heroAt, mapOf, ROWS, type Screen } from "../roguelike/src/nethack.js";
import { probesFor as screenProbes, stairsAt, stateFor as perceiveState } from "../roguelike/src/perceive.js";
import { rehydrate } from "../roguelike/src/run.js";
import { ARMS, LEAKY, LOSSY, cellsOf, drawCode, encode, encodeAll, observerAt, ruled, rulerLines, runsOf } from "./src/encode.js";
import {
  HEIGHT,
  LEGEND,
  OBSERVER,
  QUADRANTS,
  RANGES,
  TARGET,
  WIDTHS,
  chebyshev,
  corpus,
  draw,
  probesFor as gridProbes,
  sceneOf,
} from "./src/grid.js";
import { PIXEL_ARMS } from "./src/shapes.js";
import {
  MARGINS,
  SHAPE_ARMS,
  SHAPE_LEAKY,
  corpus as rectCorpus,
  draw as rectDraw,
  encodeShape,
  overlapArea as rectArea,
  overlaps as rectOverlaps,
  probesFor as rectProbes,
  sceneOf as rectScene,
} from "./src/rects.js";
import {
  DEPTH as SOLID_DEPTH,
  HEIGHT as SOLID_HEIGHT,
  SOLID_LEAKY,
  chebyshev3,
  corpus as solidCorpus,
  draw as solidDraw,
  encode3,
  probesFor as solidProbes,
} from "./src/solid.js";
import {
  BLOCK,
  GAPS,
  VARIANTS,
  corpus as pairCorpus,
  draw as pairDraw,
  probesFor as pairProbes,
  sceneOf as pairScene,
} from "./src/pairs.js";
import { auc } from "../shared/thresholds.js";
import { FOLDS, type Record_, type Row, SUPERSEDED, heldOut, read, screenScene } from "./src/spatial.js";

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void): void => {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}: ${(err as Error).message}`);
  }
};
const skip = (name: string, why: string): void => console.log(`  skip ${name} (${why})`);
const ok = (cond: boolean, what: string): void => {
  if (!cond) throw new Error(what);
};
const eq = <T>(got: T, want: T, what: string): void => {
  if (got !== want) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

const CASES = corpus();

// ------------------------------------------------------- the recorded screens

const WALK = resolve(import.meta.dirname, "../roguelike/records/walk.json");

/** A screen with a known geometry, for when `walk.json` is not checked out. */
function handmade(): Screen {
  const rows = Array.from({ length: ROWS }, () => " ".repeat(80));
  const put = (y: number, x: number, text: string): void => {
    rows[y] = rows[y].slice(0, x) + text + rows[y].slice(x + text.length);
  };
  put(1, 10, "-----------");
  put(2, 10, "|....<....|");
  put(3, 10, "|...@.....|");
  put(4, 10, "-----------");
  put(22, 0, "Jev the Stripling         St:18 Dx:10 Co:16 In:7 Wi:7 Ch:8 Neutral");
  put(23, 0, "Dlvl:1 $:0 HP:16(16) Pw:2(2) AC:6 Xp:1/0 T:1");
  return { rows, message: "", status: `${rows[22].trim()} ${rows[23].trim()}` };
}

const SCREENS: Screen[] = (() => {
  if (!existsSync(WALK)) return [];
  const walk = JSON.parse(readFileSync(WALK, "utf8")) as {
    screens: { game: number; turn: number; policy: string; rows: string[] }[];
  };
  return walk.screens.map(rehydrate);
})();
const SCREEN: Screen = SCREENS[0] ?? handmade();

// ------------------------------------------------------------- the generator

check("the corpus is balanced on both axes, exactly", () => {
  eq(CASES.filter((c) => c.target.x > c.observer.x).length * 2, CASES.length, "east is not half");
  eq(CASES.filter((c) => c.target.y > c.observer.y).length * 2, CASES.length, "south is not half");
  eq(CASES.filter((c) => c.range === "near").length * 2, CASES.length, "adjacent is not half");
});

check("the two axes are independent, so one cannot answer the other", () => {
  // Each of the four quadrants gets the same count, so knowing `east` says
  // nothing about `south`. Without this, a single "which corner is it in"
  // ability would read as competence on both questions.
  for (const q of QUADRANTS) {
    eq(CASES.filter((c) => c.quadrant === q).length * 4, CASES.length, `quadrant ${q} is not a quarter`);
  }
});

check("adjacency is crossed with the quadrant, not confounded with it", () => {
  for (const q of QUADRANTS) {
    for (const r of RANGES) {
      eq(CASES.filter((c) => c.quadrant === q && c.range === r).length * 8, CASES.length, `cell ${q}/${r}`);
    }
  }
});

check("every width carries the same balanced design", () => {
  for (const w of WIDTHS) {
    const at = CASES.filter((c) => c.width === w);
    ok(at.length > 0, `no rooms at width ${w}`);
    eq(at.filter((c) => c.target.x > c.observer.x).length * 2, at.length, `east at width ${w}`);
    eq(at.filter((c) => c.target.y > c.observer.y).length * 2, at.length, `south at width ${w}`);
    eq(at.filter((c) => c.range === "near").length * 2, at.length, `near at width ${w}`);
    eq(at.every((c) => c.height === HEIGHT), true, `height moved at width ${w}`);
  }
});

check("the quadrant and range labels agree with the coordinates", () => {
  for (const c of CASES) {
    const dx = c.target.x - c.observer.x;
    const dy = c.target.y - c.observer.y;
    ok(dx !== 0 && dy !== 0, `${c.key}: the target shares a row or column with the observer`);
    const want = dy < 0 ? (dx > 0 ? "NE" : "NW") : dx > 0 ? "SE" : "SW";
    eq(c.quadrant, want as typeof c.quadrant, `${c.key}: quadrant label`);
    const d = chebyshev(c.observer, c.target);
    eq(c.range, d === 1 ? "near" : "far", `${c.key}: range label`);
    ok(c.range === "near" || d >= 3, `${c.key}: a "far" target only ${d} away`);
  }
});

check("the corpus is a function of the seed", () => {
  eq(JSON.stringify(corpus(2, 7)), JSON.stringify(corpus(2, 7)), "two calls disagree");
  ok(JSON.stringify(corpus(2, 7)) !== JSON.stringify(corpus(2, 8)), "the seed does nothing");
});

check("the drawing puts the two squares where the generator says", () => {
  for (const c of CASES) {
    const rows = draw(c);
    eq(rows.length, c.height, `${c.key}: height`);
    eq(rows.every((r) => r.length === c.width), true, `${c.key}: ragged rows`);
    eq(rows[c.observer.y][c.observer.x], OBSERVER, `${c.key}: no observer`);
    eq(rows[c.target.y][c.target.x], TARGET, `${c.key}: no target`);
    eq(rows.join("").split(TARGET).length - 1, 1, `${c.key}: more than one target`);
    eq(rows.join("").split(OBSERVER).length - 1, 1, `${c.key}: more than one observer`);
  }
});

check("the probe truths come from the coordinates and nothing else", () => {
  for (const c of CASES) {
    const { nouls, scores } = gridProbes(c);
    const by = new Map(nouls.map((p) => [p.key, p.truth]));
    eq(by.get("east"), c.target.x > c.observer.x, `${c.key}: east`);
    eq(by.get("south"), c.target.y > c.observer.y, `${c.key}: south`);
    eq(by.get("adjacent"), chebyshev(c.observer, c.target) === 1, `${c.key}: adjacent`);
    eq(by.get("deep"), c.level > 1, `${c.key}: deep`);
    eq(by.get("lit"), c.lit, `${c.key}: lit`);
    eq(scores.length, 1, `${c.key}: score probes`);
  }
});

check("every glyph drawn has a legend entry", () => {
  const drawn = new Set(CASES.flatMap((c) => draw(c).flatMap((r) => [...r])));
  for (const g of drawn) ok(g in LEGEND, `glyph ${JSON.stringify(g)} is drawn but not explained`);
});

// -------------------------------------------------------------- the encodings

check("ascii is byte-identical to the roguelike experiment's state", () => {
  // THE LOAD-BEARING TEST. §2 compares four new encodings against docs/34's
  // numbers, which is only legitimate while the control arm sends the same
  // bytes docs/34 sent. `stateFor` is imported, not copied, so a change there
  // fails here instead of quietly making the comparison false.
  eq(
    JSON.stringify(encode(screenScene(SCREEN), "ascii")),
    JSON.stringify(perceiveState(SCREEN)),
    "the control arm has drifted from docs/34",
  );
});

check("the non-geometry part of the state is identical in every encoding", () => {
  // The control band's job is to be unmoved by the independent variable. If
  // these strings differed by an encoding, a `status` difference would be my
  // harness rather than a finding -- and the report reads that band as the
  // instrument check.
  for (const c of CASES.slice(0, 24)) {
    const states = encodeAll(sceneOf(c));
    const first = JSON.stringify(states.ascii.status_line);
    for (const arm of ARMS) {
      eq(JSON.stringify(states[arm].status_line), first, `${c.key}: ${arm} moved the status line`);
      eq(JSON.stringify(states[arm].legend), JSON.stringify(LEGEND), `${c.key}: ${arm} moved the legend`);
    }
  }
});

check("the encodings differ only after `what`", () => {
  const c = CASES[0];
  const states = encodeAll(sceneOf(c));
  const geometry = new Set(ARMS.map((a) => JSON.stringify(Object.keys(states[a]))));
  ok(geometry.size > 1, "the arms all have the same shape; nothing is being varied");
  for (const arm of ARMS) {
    const keys = Object.keys(states[arm]);
    eq(keys[0], "what", `${arm}: what is not first`);
    eq(keys[1], "legend", `${arm}: legend is not second`);
    eq(keys[keys.length - 1], "status_line", `${arm}: the control text is not last`);
  }
});

/**
 * An INDEPENDENT decoder per arm, so losslessness is a round trip rather than
 * a claim.
 *
 * Deliberately not shared with `encode.ts`: a round-trip test that calls the
 * encoder's own inverse proves the two agree, not that either is right. The
 * regexes here read the emitted code the way a reader would, and they parse
 * the glyph as a JSON string literal because NetHack draws `"` (an amulet) and
 * `\` (a throne) -- `"(.)"` looked fine on the synthetic rooms and would have
 * silently skipped those two on a real screen.
 */
function rebuild(scene: Parameters<typeof encode>[0], arm: (typeof ARMS)[number]): string[] {
  const state = encode(scene, arm) as Record<string, never>;
  const width = Math.max(0, ...scene.rows.map((r) => r.length));
  const blank = (): string[][] => scene.rows.map((r) => " ".repeat(r.length).split(""));
  const join = (g: string[][]): string[] => g.map((r) => r.join(""));
  const LITERAL = String.raw`("(?:[^"\\]|\\.)*")`;
  if (arm === "ascii") return state.map_rows as unknown as string[];
  if (arm === "ruler") {
    return (state.map_rows as unknown as string[]).slice(rulerLines(width)).map((l) => l.slice(3));
  }
  if (arm === "coords" || arm === "sparse") {
    const g = blank();
    // `sparse` omits the floor, so the rebuild starts from floor rather than
    // from blank -- which is exactly the rule the state states. On a NetHack
    // screen that rule cannot be applied (unlisted is floor OR unexplored),
    // and the test below asserts the arm is lossy there instead of pretending.
    if (arm === "sparse") {
      for (const row of g) for (let x = 0; x < row.length; x += 1) row[x] = scene.floor ?? ".";
    }
    for (const c of state.cells as unknown as { x: number; y: number; glyph: string }[]) {
      g[c.y][c.x] = c.glyph;
    }
    return join(g);
  }
  if (arm === "code") {
    const g = blank();
    for (const m of (state.code as unknown as string).matchAll(
      new RegExp(String.raw`screen\.put\((\d+), (\d+), ${LITERAL}\);`, "g"),
    )) {
      g[Number(m[2])][Number(m[1])] = JSON.parse(m[3]) as string;
    }
    return join(g);
  }
  if (arm === "runs") {
    const g = blank();
    for (const m of (state.code as unknown as string).matchAll(
      new RegExp(String.raw`screen\.span\((\d+), (\d+), ${LITERAL}\);`, "g"),
    )) {
      const x = Number(m[1]);
      const y = Number(m[2]);
      [...(JSON.parse(m[3]) as string)].forEach((ch, i) => {
        g[y][x + i] = ch;
      });
    }
    return join(g);
  }
  const you = observerAt(scene.rows, scene.observer ?? "@");
  if (!you) throw new Error("no observer");
  const g = blank();
  g[you.y][you.x] = (state.you as unknown as { glyph: string }).glyph;
  for (const c of state.cells as unknown as { dx: number; dy: number; glyph: string }[]) {
    g[you.y + c.dy][you.x + c.dx] = c.glyph;
  }
  return join(g);
}

check("every encoding not named in LOSSY rebuilds the grid exactly", () => {
  // The general form of what used to be three hand-written round trips. An
  // arm added later is covered the moment it appears in ARMS, and the only way
  // to exempt one is to name it in LOSSY, in the source, where a reader sees it.
  for (const c of CASES.slice(0, 16)) {
    const scene = sceneOf(c);
    const want = draw(c).join("\n");
    for (const arm of ARMS) {
      if (LOSSY.has(arm)) continue;
      eq(rebuild(scene, arm).join("\n"), want, `${c.key}: ${arm} lost the picture`);
    }
  }
});

check("sparse rebuilds the drawn rooms too, because there floor is the only filler", () => {
  // §1's rooms are full rectangles with no unexplored blank, so the omission
  // rule ("every unlisted position is floor") is exactly true and the arm is
  // lossless HERE. This is the one place an arm means something different in
  // §1 and §2, so it is asserted rather than described.
  for (const c of CASES.slice(0, 16)) {
    eq(rebuild(sceneOf(c), "sparse").join("\n"), draw(c).join("\n"), `${c.key}: sparse lost a room`);
    ok(!draw(c).some((r) => r.includes(" ")), `${c.key}: a drawn room has blank in it`);
  }
});

check("sparse drops the floor and nothing else", () => {
  for (const c of CASES.slice(0, 16)) {
    const scene = sceneOf(c);
    const all = cellsOf(draw(c));
    const kept = (encode(scene, "sparse") as { cells: { glyph: string }[] }).cells;
    const want = all.filter((x) => x.glyph !== ".");
    eq(kept.length, want.length, `${c.key}: wrong number of entries`);
    eq(kept.every((k) => k.glyph !== "."), true, `${c.key}: a floor entry survived`);
    eq(
      JSON.stringify(kept.map((k) => k.glyph)),
      JSON.stringify(want.map((w) => w.glyph)),
      `${c.key}: sparse changed the order or the contents`,
    );
    ok(all.length > want.length, `${c.key}: nothing was dropped, so the arm is a copy of coords`);
  }
});

check("sparse says what an unlisted position means, and the sentence is true", () => {
  // The omission has to be answerable from the state. Without the rule the arm
  // would be measuring whether a gap can be guessed.
  for (const c of CASES.slice(0, 8)) {
    const state = encode(sceneOf(c), "sparse") as { floor_is_omitted: string; grid: { width: number; height: number } };
    ok(/floor/.test(state.floor_is_omitted), `${c.key}: no omission rule in the state`);
    // No blank in these rooms, so the sentence must NOT hedge with "unexplored".
    eq(/unexplored/.test(state.floor_is_omitted), false, `${c.key}: hedged about a room with no blank`);
    eq(state.grid.width, c.width, `${c.key}: grid width`);
    eq(state.grid.height, c.height, `${c.key}: grid height`);
  }
});

check("runsOf makes maximal runs, so no two neighbours share a glyph", () => {
  for (const c of CASES.slice(0, 16)) {
    const rows = draw(c);
    const runs = runsOf(rows);
    for (const r of runs) {
      eq(new Set([...r.text]).size, 1, `${c.key}: a run mixes glyphs`);
      eq(rows[r.y].slice(r.x, r.x + r.text.length), r.text, `${c.key}: a run is not where it says`);
      const before = r.x > 0 ? rows[r.y][r.x - 1] : "";
      const after = rows[r.y][r.x + r.text.length] ?? "";
      ok(before !== r.text[0], `${c.key}: run at ${r.x},${r.y} could extend left`);
      ok(after !== r.text[0], `${c.key}: run at ${r.x},${r.y} could extend right`);
    }
    // And it really is a compression, or the arm is just `code` with a longer name.
    ok(runs.length < cellsOf(rows).length, `${c.key}: runs did not compress anything`);
  }
});

check("cellsOf is row-major, and the grid rebuilds from it", () => {
  // Row-major is the decision recorded in `encode.ts`: sorting by x would
  // hand the column order over for free. Both halves are checked -- the order
  // AND the losslessness.
  for (const c of CASES.slice(0, 12)) {
    const rows = draw(c);
    const cells = cellsOf(rows);
    for (let i = 1; i < cells.length; i += 1) {
      const a = cells[i - 1];
      const b = cells[i];
      ok(a.y < b.y || (a.y === b.y && a.x < b.x), `${c.key}: cell ${i} is out of reading order`);
    }
    const back = rows.map((r) => " ".repeat(r.length).split(""));
    for (const cell of cells) back[cell.y][cell.x] = cell.glyph;
    eq(back.map((r) => r.join("")).join("\n"), rows.join("\n"), `${c.key}: coords lost the picture`);
  }
});

check("the ruler lines up with the picture it annotates", () => {
  for (const c of CASES) {
    const rows = draw(c);
    const out = ruled(rows);
    const head = rulerLines(c.width);
    eq(out.length, rows.length + head, `${c.key}: wrong number of lines`);
    for (let y = 0; y < rows.length; y += 1) {
      const line = out[y + head];
      eq(line.slice(0, 3), `${String(y).padStart(2, "0")} `, `${c.key}: row ${y} prefix`);
      for (let x = 0; x < rows[y].length; x += 1) {
        eq(line[3 + x], rows[y][x], `${c.key}: row ${y} column ${x} moved`);
        eq(out[head - 1][3 + x], String(x % 10), `${c.key}: the ones ruler is off at ${x}`);
      }
    }
  }
});

check("the ruler still reads correctly past a hundred columns", () => {
  // The tens digit was `floor(x / 10) % 10`, so column 100 printed as "0".
  // Nothing recorded is that wide, which is why this needed a test rather
  // than a reader noticing.
  const rows = ["x".repeat(150)];
  const out = ruled(rows);
  eq(out.length, rows.length + 3, "no hundreds line above a hundred columns");
  const digit = (line: string, x: number): string => line[3 + x];
  for (const x of [0, 10, 99, 100, 110, 149]) {
    const read = Number(`${digit(out[0], x).trim() || "0"}${digit(out[1], x).trim() || "0"}${digit(out[2], x)}`);
    if (x % 10 === 0) eq(read, x % 1000, `column ${x} reads wrong`);
  }
  eq(digit(out[0], 100), "1", "column 100 has no hundreds digit");
  eq(digit(out[1], 110), "1", "column 110 has the wrong tens digit");
});

check("widths at or below ninety-nine are unchanged by the hundreds fix", () => {
  // `grid.json` was recorded before the fix. Two header lines below 100 means
  // every recorded `ruler` payload is still the payload this code produces.
  for (const c of CASES) {
    eq(rulerLines(c.width), 2, `${c.key}: the header grew`);
    eq(ruled(draw(c)).length, c.height + 2, `${c.key}: the ruler changed shape`);
  }
});

check("the ruler's separator is not a glyph, so it cannot be read as the map", () => {
  // `|` was the first separator and a room's left wall came out `||`. That is
  // a damaged picture pretending to be an annotated one.
  const c = CASES[0];
  const out = ruled(draw(c));
  for (const line of out.slice(2)) eq(line[2], " ", "the separator is drawable");
  ok(!(" " in LEGEND), "a space means something on this grid; pick another separator");
});

check("the code encoding draws exactly the cells and nothing more", () => {
  for (const c of CASES.slice(0, 12)) {
    const rows = draw(c);
    const cells = cellsOf(rows);
    const code = drawCode(rows, c.width, c.height);
    const puts = [...code.matchAll(/screen\.put\((\d+), (\d+), "(.)"\);/g)];
    eq(puts.length, cells.length, `${c.key}: statement count`);
    const back = rows.map((r) => " ".repeat(r.length).split(""));
    for (const m of puts) back[Number(m[2])][Number(m[1])] = m[3];
    eq(back.map((r) => r.join("")).join("\n"), rows.join("\n"), `${c.key}: the code draws a different room`);
  }
});

check("relative offsets rebuild the absolute grid", () => {
  for (const c of CASES.slice(0, 12)) {
    const rows = draw(c);
    const state = encode(sceneOf(c), "relative") as {
      cells: { dx: number; dy: number; glyph: string }[];
    };
    const you = observerAt(rows, OBSERVER)!;
    const back = rows.map((r) => " ".repeat(r.length).split(""));
    back[you.y][you.x] = OBSERVER;
    for (const cell of state.cells) back[you.y + cell.dy][you.x + cell.dx] = cell.glyph;
    eq(back.map((r) => r.join("")).join("\n"), rows.join("\n"), `${c.key}: relative lost the picture`);
  }
});

// -------------------------------------------------------------------- the leak

check("relative contains the answer to east and south, on every room", () => {
  // `encode.ts` says this arm is a ceiling and not a competitor. Here is the
  // proof rather than the claim: for all 144 rooms the sign of the target's
  // `dx` IS the truth of `east`, so a perfect score there is arithmetic on a
  // number my own encoder computed.
  let checked = 0;
  for (const c of CASES) {
    const state = encode(sceneOf(c), "relative") as {
      cells: { dx: number; dy: number; glyph: string }[];
    };
    const target = state.cells.find((cell) => cell.glyph === TARGET);
    ok(target !== undefined, `${c.key}: no target in the relative state`);
    const truths = new Map(gridProbes(c).nouls.map((p) => [p.key, p.truth]));
    eq(target!.dx > 0, truths.get("east")!, `${c.key}: dx does not encode east`);
    eq(target!.dy > 0, truths.get("south")!, `${c.key}: dy does not encode south`);
    eq(Math.max(Math.abs(target!.dx), Math.abs(target!.dy)) === 1, truths.get("adjacent")!, `${c.key}: adjacency`);
    checked += 1;
  }
  eq(checked, CASES.length, "not every room was checked");
  eq(LEAKY.has("relative"), true, "the arm leaks but is not marked leaky");
});

check("no encoding but `relative` carries a direction or a criterion", () => {
  // The convention this repository keeps breaking and re-fixing: a label must
  // not ride along in the payload. `relative` is exempt BY NAME, which is the
  // only kind of exemption that survives a refactor.
  for (const c of CASES.slice(0, 24)) {
    const { nouls } = gridProbes(c);
    const criteria = nouls.flatMap((p) => {
      const q = p.question as { criteria?: { true?: unknown; false?: unknown } };
      return [q.criteria?.true, q.criteria?.false].filter((s): s is string => typeof s === "string");
    });
    for (const arm of ARMS) {
      if (LEAKY.has(arm)) continue;
      const text = JSON.stringify(encode(sceneOf(c), arm));
      for (const crit of criteria) ok(!text.includes(crit), `${c.key}: ${arm} carries a criterion`);
      for (const word of ["east", "west", "north", "south", "right of", "left of", "adjacent"]) {
        ok(!text.toLowerCase().includes(word), `${c.key}: ${arm} carries the word "${word}"`);
      }
    }
  }
});

check("no encoding carries a truth value", () => {
  for (const c of CASES.slice(0, 24)) {
    for (const arm of ARMS) {
      const state = encode(sceneOf(c), arm);
      const found: string[] = [];
      const walk = (v: unknown, path: string): void => {
        if (typeof v === "boolean") found.push(path);
        else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
        else if (v && typeof v === "object") {
          for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
        }
      };
      walk(state, arm);
      eq(found.join(","), "", `${c.key}: boolean fields in the payload`);
    }
  }
});

// -------------------------------------------------- against the real screens

if (SCREENS.length > 0) {
  check("every lossless encoding of a real screen really is lossless", () => {
    const scene = screenScene(SCREEN);
    const rows = mapOf(SCREEN);
    const coords = encode(scene, "coords") as { cells: { x: number; y: number; glyph: string }[] };
    const back = rows.map((r) => " ".repeat(r.length).split(""));
    for (const cell of coords.cells) back[cell.y][cell.x] = cell.glyph;
    eq(back.map((r) => r.join("")).join("\n"), rows.join("\n"), "coords lost part of the screen");
    const ascii = encode(scene, "ascii") as { map_rows: string[] };
    eq(ascii.map_rows.join("\n"), rows.join("\n"), "ascii lost part of the screen");
  });

  check("a real screen's status lines survive every encoding unchanged", () => {
    const states = encodeAll(screenScene(SCREEN));
    const want = JSON.stringify([SCREEN.rows[22].trim(), SCREEN.rows[23].trim()]);
    for (const arm of ARMS) {
      eq(JSON.stringify(states[arm].status_lines), want, `${arm} moved the status lines`);
    }
  });

  check("a real screen gets no legend, so §2's arms match docs/34's state", () => {
    const states = encodeAll(screenScene(SCREEN));
    for (const arm of ARMS) eq("legend" in states[arm], false, `${arm} invented a legend`);
  });

  check("the screen probes are the conditional set docs/34 measured", () => {
    // §2 reuses `probesFor` so the wording cannot drift between arms OR
    // between experiments. The two direction probes are CONDITIONAL -- docs/34
    // omits `upstairs_east` when the `<` shares the `@`'s column, because
    // there is no answer then. The first recorded screen is one of those, which
    // is how an earlier version of this test came to fail.
    let east = 0;
    let south = 0;
    let both = 0;
    for (const screen of SCREENS) {
      const { nouls, scores } = screenProbes(screen);
      const keys = new Set([...nouls.map((p) => p.key), ...scores.map((p) => p.key)]);
      if (keys.size === 0) continue;
      ok(keys.has("monster_count"), "a screen with probes but no monster_count");
      const hero = heroAt(screen);
      const up = stairsAt(screen, "<");
      eq(keys.has("upstairs_east"), Boolean(hero && up && up.x !== hero.x), "upstairs_east is not conditional on the column");
      eq(keys.has("upstairs_south"), Boolean(hero && up && up.y !== hero.y), "upstairs_south is not conditional on the row");
      if (keys.has("upstairs_east")) east += 1;
      if (keys.has("upstairs_south")) south += 1;
      if (keys.has("upstairs_east") && keys.has("upstairs_south")) both += 1;
    }
    // Printed because it is the n of the paired axis test, and a paired test
    // on a handful of screens would be the instrument's floor talking.
    console.log(`       (${east} screens ask east, ${south} ask south, ${both} ask both)`);
    ok(both >= 100, `only ${both} screens ask both directions; the paired test would be underpowered`);
  });

  check("relative works on a real screen, and the observer is the origin", () => {
    const state = encode(screenScene(SCREEN), "relative") as {
      you: { dx: number; dy: number };
      cells: { dx: number; dy: number; glyph: string }[];
    };
    eq(state.you.dx, 0, "the observer is not the origin");
    eq(state.you.dy, 0, "the observer is not the origin");
    eq(state.cells.some((c) => c.dx === 0 && c.dy === 0), false, "the origin is listed twice");
  });
} else {
  skip("the real screens", "no roguelike/records/walk.json");
}


// ------------------------------------------------------ docs/65: rectangles

const RECTS = rectCorpus();

check("the rectangle corpus is balanced on `overlap`, exactly", () => {
  eq(RECTS.filter((c) => rectOverlaps(c.a, c.b)).length * 2, RECTS.length, "overlap is not half");
  for (const m of MARGINS) {
    const at = RECTS.filter((c) => c.margin === m);
    eq(at.length * 4, RECTS.length, `margin ${m} is not a quarter`);
    // The margin class IS the answer, which is what makes it a difficulty dial
    // rather than a nuisance factor.
    const want = m === "deep" || m === "edge1";
    eq(at.every((c) => rectOverlaps(c.a, c.b) === want), true, `margin ${m} disagrees with overlap`);
  }
});

check("`edge1` and `touch` really are one cell apart", () => {
  // The pair this corpus exists for. `edge1` shares exactly one row or column
  // of cells; `touch` shares none and has no gap. If the generator let them
  // blur, the hard cases would stop being hard.
  for (const c of RECTS.filter((x) => x.margin === "edge1")) {
    ok(rectArea(c.a, c.b) > 0, `${c.key}: edge1 shares nothing`);
  }
  for (const c of RECTS.filter((x) => x.margin === "touch")) {
    eq(rectArea(c.a, c.b), 0, `${c.key}: touch shares a cell`);
  }
  for (const c of RECTS.filter((x) => x.margin === "gap1")) {
    eq(rectArea(c.a, c.b), 0, `${c.key}: gap1 shares a cell`);
  }
});

check("the rectangle probes' truths come from the four numbers", () => {
  for (const c of RECTS) {
    const by = new Map(rectProbes(c).nouls.map((p) => [p.key, p.truth]));
    eq(by.get("overlap"), rectOverlaps(c.a, c.b), `${c.key}: overlap`);
    eq(by.get("a_starts_left"), c.a.x < c.b.x, `${c.key}: a_starts_left`);
    eq(by.get("a_starts_above"), c.a.y < c.b.y, `${c.key}: a_starts_above`);
    // Always defined: the generator never lets the two share a left or top edge.
    ok(by.has("a_starts_left") && by.has("a_starts_above"), `${c.key}: a direction probe is missing`);
    // Conditional: skipped when the widths tie, so the floor is not the base rate.
    eq(by.has("a_is_wider"), c.a.width !== c.b.width, `${c.key}: a_is_wider is not conditional`);
  }
});

check("the drawn outlines recover both rectangles", () => {
  // The picture arm can only be fair if the extents are IN the picture. B is
  // drawn over A where the outlines cross, so A is recovered from the cells
  // that remain -- and this asserts that enough of them do.
  for (const c of RECTS) {
    const rows = rectDraw(c);
    eq(rows.length, c.gridHeight, `${c.key}: height`);
    const seen = { A: [] as number[][], B: [] as number[][] };
    rows.forEach((row, y) => {
      [...row].forEach((ch, x) => {
        if (ch === "A") seen.A.push([x, y]);
        if (ch === "B") seen.B.push([x, y]);
      });
    });
    ok(seen.A.length > 0, `${c.key}: rectangle A is entirely hidden`);
    ok(seen.B.length > 0, `${c.key}: rectangle B is entirely hidden`);
    // B is never occluded, so its extent must come back exactly.
    const bx = seen.B.map((p) => p[0]);
    const byy = seen.B.map((p) => p[1]);
    eq(Math.min(...bx), c.b.x, `${c.key}: B's left edge`);
    eq(Math.max(...bx), c.b.x + c.b.width - 1, `${c.key}: B's right edge`);
    eq(Math.min(...byy), c.b.y, `${c.key}: B's top edge`);
    eq(Math.max(...byy), c.b.y + c.b.height - 1, `${c.key}: B's bottom edge`);
  }
});

check("no glyph in the picture marks the intersection", () => {
  // A third glyph for "both" would BE the answer to `overlap`, which is why
  // the rectangles are drawn as outlines. Only three characters may appear.
  const drawn = new Set(RECTS.flatMap((c) => rectDraw(c).flatMap((r) => [...r])));
  eq([...drawn].sort().join(""), ".AB", `the picture uses ${[...drawn].sort().join("")}`);
});

check("both shape arms contain the answer, and are named as ceilings", () => {
  // `encodeShape`'s docblock says both are ceilings. This is the proof: the
  // overlap predicate evaluated on the numbers in the state equals the truth,
  // for every pair, in both arms.
  for (const c of RECTS) {
    const truth = rectOverlaps(c.a, c.b);
    for (const arm of SHAPE_ARMS) {
      ok(SHAPE_LEAKY.has(arm), `${arm} is not marked as a ceiling`);
      const state = encodeShape(c, arm) as { rectangles: Record<string, number>[] };
      const [A, B] = state.rectangles;
      const box = (r: Record<string, number>): number[] =>
        arm === "rects"
          ? [r.x, r.x + r.width - 1, r.y, r.y + r.height - 1]
          : [r.first_column, r.last_column, r.first_row, r.last_row];
      const [ax0, ax1, ay0, ay1] = box(A);
      const [bx0, bx1, by0, by1] = box(B);
      eq(ax0 <= bx1 && bx0 <= ax1 && ay0 <= by1 && by0 <= ay1, truth, `${c.key}: ${arm} does not encode overlap`);
    }
  }
});

check("the pixel arms of the rectangle corpus carry no answer", () => {
  for (const c of RECTS.slice(0, 24)) {
    const { nouls } = rectProbes(c);
    const criteria = nouls.flatMap((p) => {
      const q = p.question as { criteria?: { true?: unknown; false?: unknown } };
      return [q.criteria?.true, q.criteria?.false].filter((x): x is string => typeof x === "string");
    });
    for (const arm of PIXEL_ARMS) {
      const text = JSON.stringify(encode(rectScene(c), arm));
      for (const crit of criteria) ok(!text.includes(crit), `${c.key}: ${arm} carries a criterion`);
      for (const word of ["overlap", "share", "wider", "left of"]) {
        ok(!text.toLowerCase().includes(word), `${c.key}: ${arm} carries the word "${word}"`);
      }
    }
  }
});

// ---------------------------------------------------- docs/65: three dimensions

const BLOCKS = solidCorpus();

check("the block corpus makes all three axes half and independent", () => {
  // Eight octants with equal counts. Each axis is exactly 50/50 AND the three
  // are mutually independent, so "all three true" must be exactly an eighth --
  // which is the check that catches a generator that correlates two axes.
  eq(BLOCKS.filter((c) => c.target.x > c.observer.x).length * 2, BLOCKS.length, "east is not half");
  eq(BLOCKS.filter((c) => c.target.y > c.observer.y).length * 2, BLOCKS.length, "south is not half");
  eq(BLOCKS.filter((c) => c.target.z > c.observer.z).length * 2, BLOCKS.length, "above is not half");
  eq(
    BLOCKS.filter((c) => c.target.x > c.observer.x && c.target.y > c.observer.y && c.target.z > c.observer.z).length * 8,
    BLOCKS.length,
    "the three axes are not independent",
  );
  eq(BLOCKS.filter((c) => c.range === "near").length * 2, BLOCKS.length, "adjacent is not half");
});

check("only the width changes across the block sweep", () => {
  for (const c of BLOCKS) {
    eq(c.height, SOLID_HEIGHT, `${c.key}: the height moved`);
    eq(c.depth, SOLID_DEPTH, `${c.key}: the number of layers moved`);
  }
  eq(new Set(BLOCKS.map((c) => c.width)).size, 2, "the width does not vary");
});

check("the block probes' truths come from the three coordinates", () => {
  for (const c of BLOCKS) {
    const by = new Map(solidProbes(c).nouls.map((p) => [p.key, p.truth]));
    eq(by.get("east"), c.target.x > c.observer.x, `${c.key}: east`);
    eq(by.get("south"), c.target.y > c.observer.y, `${c.key}: south`);
    eq(by.get("above"), c.target.z > c.observer.z, `${c.key}: above`);
    eq(by.get("adjacent"), chebyshev3(c.observer, c.target) === 1, `${c.key}: adjacent`);
  }
});

check("the three axis questions are the same sentence with one word changed", () => {
  // A difference between the axes has to come from the nesting, not from my
  // prose. The three instructions must differ only where they name the axis.
  const { nouls } = solidProbes(BLOCKS[0]);
  const text = (k: string): string => {
    const q = nouls.find((p) => p.key === k)!.question as { instructions?: string };
    return q.instructions ?? "";
  };
  const shape = (s: string): string =>
    s.replace(/column|row|layer/g, "AXIS").replace(/right|left|back|forward|down|up/g, "DIR");
  eq(shape(text("east")), shape(text("south")), "east and south are not the same sentence");
  eq(shape(text("south")), shape(text("above")), "south and above are not the same sentence");
});

check("the layers arm labels neither y nor z", () => {
  // Numbering z but not y would give one of the two index axes an advantage
  // the other does not have, and the comparison between them is the point.
  const state = encode3(BLOCKS[0], "layers") as { layers: string[][] };
  ok(Array.isArray(state.layers), "layers is not an array");
  for (const slice of state.layers) {
    for (const row of slice) {
      eq(/^[ @*%]*$/.test(row), true, `a row carries something other than the glyphs: ${JSON.stringify(row)}`);
    }
  }
});

check("every block encoding rebuilds the block, and relative is the only leak", () => {
  for (const c of BLOCKS.slice(0, 12)) {
    const want = JSON.stringify(solidDraw(c));
    const blankBlock = (): string[][][] =>
      Array.from({ length: c.depth }, () => Array.from({ length: c.height }, () => " ".repeat(c.width).split("")));
    const finish = (g: string[][][]): string => JSON.stringify(g.map((s) => s.map((r) => r.join(""))));
    // layers
    eq(JSON.stringify((encode3(c, "layers") as { layers: string[][] }).layers), want, `${c.key}: layers`);
    // coords
    const g1 = blankBlock();
    for (const t of (encode3(c, "coords") as { things: { x: number; y: number; z: number; glyph: string }[] }).things) {
      g1[t.z][t.y][t.x] = t.glyph;
    }
    eq(finish(g1), want, `${c.key}: coords`);
    // code
    const g2 = blankBlock();
    for (const m of (encode3(c, "code") as { code: string }).code.matchAll(
      /block\.put\((\d+), (\d+), (\d+), "(.)"\);/g,
    )) {
      g2[Number(m[3])][Number(m[2])][Number(m[1])] = m[4];
    }
    eq(finish(g2), want, `${c.key}: code`);
    // relative, and the leak it carries
    const rel = encode3(c, "relative") as { things: { dx: number; dy: number; dz: number; glyph: string }[] };
    const g3 = blankBlock();
    g3[c.observer.z][c.observer.y][c.observer.x] = "@";
    for (const t of rel.things) g3[c.observer.z + t.dz][c.observer.y + t.dy][c.observer.x + t.dx] = t.glyph;
    eq(finish(g3), want, `${c.key}: relative`);
    const target = rel.things.find((t) => t.glyph === "*");
    ok(target !== undefined, `${c.key}: no target in the relative state`);
    const by = new Map(solidProbes(c).nouls.map((p) => [p.key, p.truth]));
    eq(target!.dx > 0, by.get("east")!, `${c.key}: dx does not encode east`);
    eq(target!.dy > 0, by.get("south")!, `${c.key}: dy does not encode south`);
    eq(target!.dz > 0, by.get("above")!, `${c.key}: dz does not encode above`);
    eq(SOLID_LEAKY.has("relative"), true, "relative is not marked as a leak");
  }
});

check("the picture arms of the block corpus carry no answer", () => {
  for (const c of BLOCKS.slice(0, 16)) {
    for (const arm of ["layers", "coords", "code"] as const) {
      const text = JSON.stringify(encode3(c, arm)).toLowerCase();
      for (const word of ["above the", "below the", "to the right of", "touching"]) {
        ok(!text.includes(word), `${c.key}: ${arm} carries "${word}"`);
      }
    }
  }
});


// ----------------------------------------------- TODO §1.15: observer, size, gap

const PAIRS = pairCorpus();

check("the pair corpus controls the gap exactly and balances both signs", () => {
  for (const g of GAPS) {
    const at = PAIRS.filter((c) => c.gap === g);
    eq(at.length * GAPS.length, PAIRS.length, `gap ${g} is not a quarter`);
    for (const c of at) eq(Math.abs(c.a.x - c.b.x), g, `${c.key}: the gap is not ${g}`);
    eq(at.filter((c) => c.a.x > c.b.x).length * 2, at.length, `gap ${g}: a_right is not half`);
    eq(at.filter((c) => c.a.y < c.b.y).length * 2, at.length, `gap ${g}: a_above is not half`);
  }
});

check("you/cell and object/cell differ in ONE legend entry and nothing else", () => {
  // The whole observer comparison rests on this. The glyphs, the geometry,
  // the status line and every other legend entry must be byte-identical, so a
  // difference between the two can only come from being told A is you.
  for (const c of PAIRS.slice(0, 16)) {
    const you = encode(pairScene(c, "you/cell"), "ascii") as Record<string, unknown>;
    const obj = encode(pairScene(c, "object/cell"), "ascii") as Record<string, unknown>;
    const strip = (st: Record<string, unknown>): string => {
      const legend = { ...(st.legend as Record<string, string>) };
      delete legend.A;
      return JSON.stringify({ ...st, legend });
    };
    eq(strip(you), strip(obj), `${c.key}: the observer variants differ outside legend.A`);
    ok((you.legend as Record<string, string>).A !== (obj.legend as Record<string, string>).A, `${c.key}: legend.A is the same`);
    ok(/you/.test((you.legend as Record<string, string>).A), `${c.key}: you/cell does not say A is you`);
    ok(!/you/.test((obj.legend as Record<string, string>).A), `${c.key}: object/cell says A is you`);
  }
});

check("object/block keeps the same left columns and top rows as object/cell", () => {
  // The size comparison is only about size if the positions do not move.
  for (const c of PAIRS) {
    const cell = pairDraw(c, "object/cell");
    const block = pairDraw(c, "object/block");
    const box = (rows: string[], glyph: string): { x0: number; x1: number; y0: number; y1: number } => {
      const xs: number[] = [];
      const ys: number[] = [];
      rows.forEach((r, y) => [...r].forEach((ch, x) => (ch === glyph ? (xs.push(x), ys.push(y)) : null)));
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    };
    for (const g of ["A", "B"]) {
      const a = box(cell, g);
      const b = box(block, g);
      eq(a.x0, b.x0, `${c.key}: ${g}'s left column moved`);
      eq(a.y0, b.y0, `${c.key}: ${g}'s top row moved`);
      eq(a.x1 - a.x0, 0, `${c.key}: ${g} is not a single cell`);
      eq(b.x1 - b.x0, BLOCK - 1, `${c.key}: ${g} is not ${BLOCK} wide`);
      eq(b.y1 - b.y0, BLOCK - 1, `${c.key}: ${g} is not ${BLOCK} tall`);
    }
    // Disjoint row bands, so a close pair of blocks never draws one over the other.
    eq(block.join("").split("A").length - 1, BLOCK * BLOCK, `${c.key}: A was overdrawn`);
    eq(block.join("").split("B").length - 1, BLOCK * BLOCK, `${c.key}: B was overdrawn`);
  }
});

check("every variant is asked the same questions, and the truths come from the numbers", () => {
  // `probesFor` takes the geometry and not the variant, which is the design.
  // This asserts the consequence: one question list, three variants.
  for (const c of PAIRS) {
    const probes = pairProbes(c);
    const by = new Map(probes.map((p) => [p.key, p.truth]));
    eq(by.get("a_right"), c.a.x > c.b.x, `${c.key}: a_right`);
    eq(by.get("a_above"), c.a.y < c.b.y, `${c.key}: a_above`);
  }
  eq(VARIANTS.length, 3, "the design is three variants, not a full 2x2");
});

check("the pair states carry no case-specific direction and no criterion", () => {
  // THE FIRST VERSION OF THIS TEST FAILED ON THE AXIS CONVENTION. `coords`
  // says "a larger x is further right on the screen", which shares two words
  // with the criteria -- and which is a definition, not an answer: without it
  // a coordinate cannot be read at all, and docs/64's coordinate arms carried
  // the same sentence.
  //
  // So the check is stated on principle instead of on a word list. `what` is
  // the same string for every case of an arm, so it cannot carry any one
  // case's answer; that is asserted. Everything else in the state must be
  // free of the criteria and of the direction words.
  const whatOf = new Map<string, Set<string>>();
  for (const c of PAIRS) {
    for (const variant of VARIANTS) {
      for (const arm of ["ascii", "coords"] as const) {
        const state = encode(pairScene(c, variant), arm) as Record<string, unknown>;
        const k = `${variant}/${arm}`;
        whatOf.set(k, (whatOf.get(k) ?? new Set()).add(String(state.what)));
      }
    }
  }
  for (const [k, whats] of whatOf) eq(whats.size, 1, `${k}: \`what\` varies between cases`);
  for (const c of PAIRS.slice(0, 16)) {
    const criteria = pairProbes(c).flatMap((p) => {
      const q = p.question as { criteria?: { true?: unknown; false?: unknown } };
      return [q.criteria?.true, q.criteria?.false].filter((x): x is string => typeof x === "string");
    });
    for (const variant of VARIANTS) {
      for (const arm of ["ascii", "coords"] as const) {
        const { what: _what, ...rest } = encode(pairScene(c, variant), arm) as Record<string, unknown>;
        const text = JSON.stringify(rest).toLowerCase();
        for (const crit of criteria) ok(!text.includes(crit.toLowerCase()), `${c.key}/${variant}/${arm}: a criterion`);
        for (const w of ["right", "left", "above", "below", "further"]) {
          ok(!text.includes(w), `${c.key}/${variant}/${arm}: carries "${w}" outside the axis convention`);
        }
      }
    }
  }
});

check("the swapped block corpus has five rows and seven layers, and the original is untouched", () => {
  const original = solidCorpus();
  const swapped = solidCorpus(4, 20260922, { height: 5, depth: 7 });
  eq(original.every((c) => c.height === 7 && c.depth === 5), true, "the default corpus changed shape");
  eq(swapped.every((c) => c.height === 5 && c.depth === 7), true, "the swapped corpus has the wrong shape");
  eq(swapped.filter((c) => c.target.z > c.observer.z).length * 2, swapped.length, "above is not half when swapped");
  eq(swapped.filter((c) => c.target.y > c.observer.y).length * 2, swapped.length, "south is not half when swapped");
  // Same generator, so the octant design carries over exactly.
  eq(
    swapped.filter((c) => c.target.x > c.observer.x && c.target.y > c.observer.y && c.target.z > c.observer.z).length * 8,
    swapped.length,
    "the swapped axes are not independent",
  );
});

// ---------------------------------------------------------------- the records

check("the superseded sweep is kept, says what replaced it, and still gives §2.3's retracted numbers", () => {
  /**
   * TODO §3.4. docs/64 §2.3 retracts "coordinates break counting", and the
   * numbers it retracts (0.926 -> 0.781) came from a sweep the re-take
   * overwrote. Before `records/superseded/` they lived only in commit
   * b04c250 -- one squash merge from gone. This pins both ends: the old record
   * still produces the retracted pair, and the live one produces the pair the
   * correction quotes, so neither number in §2.3 is typed out of prose.
   */
  const aucOf = (rec: Record_, arm: string): string =>
    auc(
      rec.rows
        .filter((r) => r.arm === arm)
        .flatMap((r) => r.probes.filter((p) => p.key === "monster_count" && p.level !== undefined))
        .map((p) => ({ value: p.answer, positive: (p.level ?? 0) >= 2 })),
    ).toFixed(3);
  const old = read("screens.json", SUPERSEDED);
  const live = read("screens.json");
  if (!old || !live) return skip("superseded screens", "a record is not checked out");
  eq(aucOf(old, "ascii"), "0.926", "the retracted ascii AUC");
  eq(aucOf(old, "coords"), "0.781", "the retracted coords AUC");
  eq(aucOf(live, "ascii"), "0.934", "the corrected ascii AUC");
  eq(aucOf(live, "coords"), "0.744", "the corrected coords AUC");
  for (const name of ["grid.json", "screens.json"]) {
    const dead = read(name, SUPERSEDED);
    const now = read(name);
    ok(dead !== null && now !== null, `${name}: both records must exist`);
    eq(dead?.supersededBy, `records/${name}`, `${name}: a superseded record must say what replaced it`);
    ok(/^[0-9a-f]{40}$/.test(dead?.commit ?? ""), `${name}: and which commit it came from`);
    // The sweep predates two arms. If they ever appear here, someone pooled.
    const arms = [...new Set(dead?.rows.map((r) => r.arm))].sort().join(",");
    eq(arms, "ascii,code,coords,relative,ruler", `${name}: the superseded sweep's arms`);
    ok(JSON.stringify(dead?.rows) !== JSON.stringify(now?.rows), `${name}: the live record is a copy of the dead one`);
  }
});

check("the held-out column finds a shifted-but-separated arm, and cannot invent a signal", () => {
  /**
   * TODO §1.17's instrument, on answers whose calibration is known. `shifted`
   * separates perfectly and says "no" to everything at 0.5 -- the shape docs/64
   * kept reading off AUC -- so its held-out accuracy must be 100% against 50%
   * at 0.5. `flat` answers the same number every time: no cut can beat the
   * majority on it, and the table has to be able to say so.
   *
   * `twin` answers exactly as `shifted` does. Folds are cut along CASES, so
   * the two are held out on the same folds and must come back identical --
   * if the fold ever depended on the arm, the paired test on held-out
   * outcomes would be pairing cases scored under different splits.
   */
  const rows: Row[] = [];
  for (let i = 0; i < 40; i += 1) {
    const truth = i % 2 === 0;
    const probe = (answer: number) => [{ key: "adjacent", band: "local", truth, answer }];
    const base = { case: `c${i}`, input: 0, ms: 0 };
    rows.push({ ...base, arm: "coords", probes: probe(truth ? 0.3 : 0.1) });
    rows.push({ ...base, arm: "code", probes: probe(truth ? 0.3 : 0.1) });
    rows.push({ ...base, arm: "ruler", probes: probe(0.3) });
  }
  const rec: Record_ = { model: "test", usage: { input: 0, output: 0, calls: 0, ms: 0 }, rows };
  const byArm = (r: Row): string => r.arm;
  const shifted = heldOut(rec, byArm, "coords", "adjacent");
  const twin = heldOut(rec, byArm, "code", "adjacent");
  const flat = heldOut(rec, byArm, "ruler", "adjacent");
  ok(shifted !== null && twin !== null && flat !== null, "all three arms were read");
  eq(shifted?.atHalf, 0.5, "every positive sits below 0.5");
  eq(shifted?.held, 1, "and a fitted cut recovers all of them");
  eq(shifted?.cuts.length, FOLDS, "one cut per fold");
  eq(JSON.stringify([...(twin?.right ?? [])]), JSON.stringify([...(shifted?.right ?? [])]), "identical answers, identical folds");
  ok((flat?.held ?? 1) <= (flat?.majority ?? 0), `a constant answer cannot beat the majority: ${flat?.held}`);
});

check("a near target is one diagonal step from the observer at every width", () => {
  // TODO §1.18's premise: the near half cannot carry a distance effect, because
  // its distance never moves. The quadrant needs dx and dy both non-zero, so a
  // near target is always a diagonal neighbour -- at every width.
  for (const w of WIDTHS) {
    const near = CASES.filter((c) => c.width === w && c.range === "near");
    ok(near.length > 0, `width ${w} has near rooms`);
    for (const c of near) {
      eq(Math.abs(c.target.x - c.observer.x), 1, `${c.key}: dx`);
      eq(Math.abs(c.target.y - c.observer.y), 1, `${c.key}: dy`);
    }
    ok(CASES.filter((c) => c.width === w && c.range === "far").every((c) => chebyshev(c.observer, c.target) >= 3), `width ${w}: far is 3+`);
  }
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
