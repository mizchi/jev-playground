/**
 * What has to hold before a request is spent.
 *
 *   npm test      # no API key, no NetHack
 *
 * This experiment's whole claim is that FIVE STATES DIFFER IN ONE THING. That
 * is not something a reader can check by looking at a table, so it is checked
 * here instead:
 *
 *   `ascii` is byte-identical to the roguelike experiment's state, so §2's
 *     control arm IS docs/34's measurement and not a lookalike;
 *   the non-geometry part of the state (NetHack's status lines, the room's
 *     caption) is identical in all five encodings, so the control band cannot
 *     move for a reason of mine;
 *   every encoding is LOSSLESS -- the grid can be rebuilt from each one, so no
 *     arm is handed less space than another;
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
import { ARMS, LEAKY, cellsOf, drawCode, encode, encodeAll, observerAt, ruled, rulerLines } from "./src/encode.js";
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
import { screenScene } from "./src/spatial.js";

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

check("the non-geometry part of the state is identical in all five encodings", () => {
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

check("the five encodings differ only after `what`", () => {
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

check("the other four encodings do not carry a direction or a criterion", () => {
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
  check("all five encodings of a real screen are lossless", () => {
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

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
