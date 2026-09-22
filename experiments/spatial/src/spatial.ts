/**
 * Does the ENCODING of a space decide whether judgment can read it?
 *
 *   npx tsx src/spatial.ts --sample        # every encoding of one space, side by side, no API
 *   npx tsx src/spatial.ts --instruments   # what the harness checks about itself, no API
 *   npx tsx src/spatial.ts --report        # every table below, from the records, no API
 *   TYPESAFEAI_API_KEY=... npx tsx src/spatial.ts --grid      # §1, the drawn rooms
 *   TYPESAFEAI_API_KEY=... npx tsx src/spatial.ts --screens   # §2, the 244 NetHack screens
 *   TYPESAFEAI_API_KEY=... npx tsx src/spatial.ts --cut       # §3, the nine-square crop
 *
 * THE ENTRY POINT IS NOT CALLED `run.ts` ON PURPOSE. The roguelike
 * experiment's `run.ts` ends with `if (process.argv[1]?.endsWith("run.ts"))`,
 * which is true for ANY file named `run.ts` -- importing `rehydrate` from it
 * out of a sibling `run.ts` would run its main and exit(2) for want of
 * NetHack. Reimplementing three lines to dodge that is how
 * `check-doc-links.mjs` came to disagree with its own sibling about heading
 * slugs, so the import stays and the file name moves.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { Jev, type Answer, type Question } from "../../shared/jev.js";
import { auc as aucOf, pairedPermutation, separation } from "../../shared/thresholds.js";
import { glyphAt, heroAt, mapOf, type Screen } from "../../roguelike/src/nethack.js";
import { probesFor as screenProbes } from "../../roguelike/src/perceive.js";
import { rehydrate } from "../../roguelike/src/run.js";
import { ARMS, type ArmName, LEAKY, encode, type Scene } from "./encode.js";
import {
  type GridCase,
  type Quadrant,
  type Range,
  WIDTHS,
  corpus,
  draw,
  probesFor as gridProbes,
  sceneOf,
} from "./grid.js";

const HERE = resolve(import.meta.dirname, "..");
const RECORDS = resolve(HERE, "records");
const WALK = resolve(HERE, "../roguelike/records/walk.json");

// --------------------------------------------------------------------- records

export interface ProbeRow {
  key: string;
  band: string;
  truth: boolean;
  answer: number;
  /** `score` probes only: the band the truth falls in. */
  level?: number;
  confidence?: number;
}

export interface Row {
  case: string;
  arm: ArmName;
  probes: ProbeRow[];
  /** Per-request input tokens, so the report can price each encoding. */
  input: number;
  ms: number;
  /** §3 only: whether the state was the whole map or the nine-square crop. */
  scope?: Scope;
  /** §1 only: the generator's factors, so the report can split by them. */
  width?: number;
  quadrant?: Quadrant;
  range?: Range;
}

export interface Record_ {
  model: string;
  usage: { input: number; output: number; calls: number; ms: number };
  rows: Row[];
}

export function write(name: string, rec: Record_): void {
  mkdirSync(RECORDS, { recursive: true });
  writeFileSync(
    resolve(RECORDS, name),
    `{\n"model": ${JSON.stringify(rec.model)},\n"usage": ${JSON.stringify(rec.usage)},\n"rows": [\n${rec.rows
      .map((r) => JSON.stringify(r))
      .join(",\n")}\n]\n}\n`,
  );
}

export function read(name: string): Record_ | null {
  const p = resolve(RECORDS, name);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record_) : null;
}

// ---------------------------------------------------------------------- asking

/**
 * One case, every encoding.
 *
 * The requests differ in the `state` and in nothing else: the questions object
 * is built ONCE and handed to each. That is the experiment, so it is worth
 * saying in code rather than in a comment -- `questions` is out of the loop.
 */
async function askAll(
  jev: Jev,
  scene: Scene,
  questions: Record<string, Question>,
  nouls: { key: string; band: string; truth: boolean }[],
  scores: { key: string; band: string; level: number }[],
): Promise<{ arm: ArmName; probes: ProbeRow[]; input: number; ms: number }[]> {
  return Promise.all(
    ARMS.map(async (arm) => {
      const started = Date.now();
      const res = await jev.ask(encode(scene, arm), questions);
      const probes: ProbeRow[] = [];
      for (const p of nouls) {
        const a = res.answers[p.key] as Answer & { noul?: number };
        probes.push({ key: p.key, band: p.band, truth: p.truth, answer: a?.noul ?? Number.NaN });
      }
      for (const p of scores) {
        const a = res.answers[p.key];
        if (a?.type !== "score") continue;
        probes.push({
          key: p.key,
          band: p.band,
          truth: Math.round(a.score) === p.level,
          answer: a.score,
          level: p.level,
          confidence: a.confidence,
        });
      }
      return { arm, probes, input: res.usage.input_tokens, ms: Date.now() - started };
    }),
  );
}

// ------------------------------------------------------------- §1 drawn rooms

async function runGrid(reps: number): Promise<void> {
  const cases = corpus(reps);
  const jev = new Jev();
  const rec: Record_ = { model: jev.model, usage: { input: 0, output: 0, calls: 0, ms: 0 }, rows: [] };
  for (const [i, c] of cases.entries()) {
    const { nouls, scores } = gridProbes(c);
    const questions = Object.fromEntries([
      ...nouls.map((p) => [p.key, p.question] as const),
      ...scores.map((p) => [p.key, p.question] as const),
    ]);
    const out = await askAll(jev, sceneOf(c), questions, nouls, scores);
    for (const o of out) {
      rec.rows.push({
        case: c.key,
        arm: o.arm,
        probes: o.probes,
        input: o.input,
        ms: o.ms,
        width: c.width,
        quadrant: c.quadrant,
        range: c.range,
      });
    }
    if ((i + 1) % 10 === 0 || i + 1 === cases.length) {
      console.log(`  ${i + 1}/${cases.length} rooms`);
      rec.usage = { input: jev.inputTokens, output: jev.outputTokens, calls: jev.calls, ms: jev.totalMs };
      write("grid.json", rec);
    }
  }
  console.log(`  ${cases.length} rooms x ${ARMS.length} arms, ${jev.calls} requests -> records/grid.json`);
}

// ---------------------------------------------------- §2 the NetHack screens

interface ScreenRow {
  game: number;
  turn: number;
  policy: string;
  rows: string[];
}

/**
 * The scene for a recorded screen.
 *
 * `subject` carries no mention of the form, so `ascii` reproduces docs/34's
 * state exactly -- `test.ts` asserts the two are byte-identical, because the
 * whole value of §2 is that its control arm is the earlier measurement rather
 * than a new one that resembles it.
 *
 * NO LEGEND, deliberately. docs/34 supplied none and NetHack's glyphs are
 * public knowledge; adding one here would move two things at once.
 */
export function screenScene(screen: Screen): Scene {
  return {
    rows: mapOf(screen),
    subject: "a screen from NetHack 3.6.7",
    observer: "@",
    extra: { status_lines: [screen.rows[22].trim(), screen.rows[23].trim()] },
  };
}

async function runScreens(limit: number): Promise<void> {
  const walk = JSON.parse(readFileSync(WALK, "utf8")) as { screens: ScreenRow[] };
  const jev = new Jev();
  const rec: Record_ = { model: jev.model, usage: { input: 0, output: 0, calls: 0, ms: 0 }, rows: [] };
  const screens = walk.screens.slice(0, limit);
  let done = 0;
  for (const row of screens) {
    const screen = rehydrate(row);
    const { nouls, scores } = screenProbes(screen);
    if (nouls.length === 0) continue;
    const questions = Object.fromEntries([
      ...nouls.map((p) => [p.key, p.question] as const),
      ...scores.map((p) => [p.key, p.question] as const),
    ]);
    const out = await askAll(jev, screenScene(screen), questions, nouls, scores);
    for (const o of out) {
      rec.rows.push({ case: `${row.game}/${row.turn}`, arm: o.arm, probes: o.probes, input: o.input, ms: o.ms });
    }
    done += 1;
    if (done % 10 === 0 || done === screens.length) {
      console.log(`  ${done}/${screens.length} screens`);
      rec.usage = { input: jev.inputTokens, output: jev.outputTokens, calls: jev.calls, ms: jev.totalMs };
      write("screens.json", rec);
    }
  }
  console.log(`  ${done} screens x ${ARMS.length} arms, ${jev.calls} requests -> records/screens.json`);
}

// ------------------------------------------------- §3 the three-by-three crop

/**
 * The nine squares around the `@`, cropped out of the 21x80 map.
 *
 * docs/34's SECOND suggestion, and the one §2 could not settle. `adjacent_monster`
 * sits at 63% on the full picture and coordinates made it WORSE (53%); only the
 * `@`-relative arm helped (74%). Two explanations survive that:
 *
 *   LOCALISATION -- finding the `@` inside 21 rows of 80 characters is the hard
 *     part, and once the nine squares are handed over the question is easy;
 *   CLASSIFICATION -- reading which of eight glyphs is a monster is the hard
 *     part, and cropping changes nothing.
 *
 * A 3x3 crop separates them, because in a 3x3 crop there is no spatial relation
 * left to get wrong: every listed square IS adjacent. If accuracy jumps, the
 * failure was localisation. If it stays near 60%, it was never about space.
 *
 * Out-of-bounds squares come back as the blank that `glyphAt` returns, which is
 * what the map itself shows for unexplored -- so an `@` against the edge is
 * cropped the same way the game draws it.
 */
export function cutScene(screen: Screen): Scene | null {
  const hero = heroAt(screen);
  if (!hero) return null;
  const rows: string[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    let row = "";
    for (let dx = -1; dx <= 1; dx += 1) row += glyphAt(screen, hero.x + dx, hero.y + dy);
    rows.push(row);
  }
  return {
    rows,
    subject: "the nine squares of a screen from NetHack 3.6.7 centred on your @, cropped out of the map",
    observer: "@",
    extra: { status_lines: [screen.rows[22].trim(), screen.rows[23].trim()] },
  };
}

/** `full` is the whole 21x80 picture; `cut` is the nine squares. */
export type Scope = "full" | "cut";

/**
 * The three measurements, chosen so each pair isolates one thing.
 *
 *   full/ascii     docs/34's state -- the control, and §2's number again
 *   cut/ascii      the same picture form, localisation removed
 *   cut/relative   the crop with the relation pre-computed as well
 */
const CUT_ARMS: { scope: Scope; arm: ArmName }[] = [
  { scope: "full", arm: "ascii" },
  { scope: "cut", arm: "ascii" },
  { scope: "cut", arm: "relative" },
];

async function runCut(limit: number): Promise<void> {
  const walk = JSON.parse(readFileSync(WALK, "utf8")) as { screens: ScreenRow[] };
  const jev = new Jev();
  const rec: Record_ = { model: jev.model, usage: { input: 0, output: 0, calls: 0, ms: 0 }, rows: [] };
  const screens = walk.screens.slice(0, limit);
  let done = 0;
  for (const row of screens) {
    const screen = rehydrate(row);
    const cut = cutScene(screen);
    const { nouls } = screenProbes(screen);
    // The LOCAL band only, plus the status control. `monster_count` and the
    // staircase questions are about the whole map and a crop cannot answer
    // them -- asking anyway would measure my cropping, not the encoding.
    const asked = nouls.filter((p) => p.band === "local" || p.band === "status");
    if (!cut || asked.length === 0) continue;
    const questions = Object.fromEntries(asked.map((p) => [p.key, p.question] as const));
    const full = screenScene(screen);
    const out = await Promise.all(
      CUT_ARMS.map(async ({ scope, arm }) => {
        const started = Date.now();
        const res = await jev.ask(encode(scope === "full" ? full : cut, arm), questions);
        const probes: ProbeRow[] = asked.map((p) => {
          const a = res.answers[p.key] as Answer & { noul?: number };
          return { key: p.key, band: p.band, truth: p.truth, answer: a?.noul ?? Number.NaN };
        });
        return { scope, arm, probes, input: res.usage.input_tokens, ms: Date.now() - started };
      }),
    );
    for (const o of out) {
      rec.rows.push({
        case: `${row.game}/${row.turn}`,
        arm: o.arm,
        scope: o.scope,
        probes: o.probes,
        input: o.input,
        ms: o.ms,
      });
    }
    done += 1;
    if (done % 20 === 0 || done === screens.length) {
      console.log(`  ${done}/${screens.length} screens`);
      rec.usage = { input: jev.inputTokens, output: jev.outputTokens, calls: jev.calls, ms: jev.totalMs };
      write("cut.json", rec);
    }
  }
  console.log(`  ${done} screens x ${CUT_ARMS.length} states, ${jev.calls} requests -> records/cut.json`);
}

// --------------------------------------------------------------------- reading

export const pct = (hit: number, n: number): string => (n === 0 ? "   -" : `${Math.round((hit / n) * 100)}%`.padStart(4));
export const right = (p: ProbeRow): boolean => p.truth === p.answer > 0.5;

export interface Cell {
  n: number;
  hit: number;
  t: number;
  tHit: number;
  f: number;
  fHit: number;
  samples: { value: number; positive: boolean }[];
}

export function blank(): Cell {
  return { n: 0, hit: 0, t: 0, tHit: 0, f: 0, fHit: 0, samples: [] };
}

export function add(cell: Cell, p: ProbeRow): void {
  cell.n += 1;
  if (right(p)) cell.hit += 1;
  if (p.truth) {
    cell.t += 1;
    if (right(p)) cell.tHit += 1;
  } else {
    cell.f += 1;
    if (right(p)) cell.fHit += 1;
  }
  cell.samples.push({ value: p.answer, positive: p.truth });
}

function tally(rows: Row[], keep: (r: Row, p: ProbeRow) => boolean, key: (r: Row, p: ProbeRow) => string): Map<string, Cell> {
  const out = new Map<string, Cell>();
  for (const r of rows) {
    for (const p of r.probes) {
      if (p.level !== undefined) continue; // `score` probes are read separately
      if (!keep(r, p)) continue;
      const k = key(r, p);
      const cell = out.get(k) ?? blank();
      add(cell, p);
      out.set(k, cell);
    }
  }
  return out;
}

function armXquestion(rec: Record_, title: string): void {
  const keys = [...new Set(rec.rows.flatMap((r) => r.probes.filter((p) => p.level === undefined).map((p) => p.key)))];
  const cells = tally(rec.rows, () => true, (r, p) => `${r.arm}\u0000${p.key}`);
  console.log(`\n${title}\n`);
  console.log(`  ${"probe".padEnd(20)}${ARMS.map((a) => (LEAKY.has(a) ? `${a}*` : a).padStart(11)).join("")}`);
  for (const key of keys) {
    const line = ARMS.map((a) => {
      const c = cells.get(`${a}\u0000${key}`);
      if (!c) return "     -     ";
      const s = separation(c.samples);
      const showAuc = s.pos > 0 && s.neg > 0;
      return `${pct(c.hit, c.n)}/${showAuc ? s.auc.toFixed(2) : " -  "}`.padStart(11);
    }).join("");
    console.log(`  ${key.padEnd(20)}${line}`);
  }
  console.log(`\n  each cell is accuracy at 0.5 / AUC. ${[...LEAKY].join(", ")}* has the answer in its state (see encode.ts).`);
  console.log("  sparse omits the floor, so it cannot answer `dead_end` or `in_room` on a NetHack screen -- predicted in encode.ts, not discovered here.");
}

function bands(rec: Record_): void {
  const cells = tally(rec.rows, () => true, (r, p) => `${r.arm}\u0000${p.band}`);
  const order = ["status", "local", "global"];
  console.log(`\n  ${"band".padEnd(10)}${ARMS.map((a) => a.padStart(11)).join("")}`);
  for (const band of order) {
    const line = ARMS.map((a) => {
      const c = cells.get(`${a}\u0000${band}`);
      return c ? `${pct(c.hit, c.n)} (${c.n})`.padStart(11) : "     -     ";
    }).join("");
    if (order.some((b) => cells.has(`${ARMS[0]}\u0000${b}`))) console.log(`  ${band.padEnd(10)}${line}`);
  }
  console.log("\n  `status` is the control: the same prose in every state. It must not move.");
}

/**
 * The paired test.
 *
 * Every case is measured under every encoding, so a comparison between two
 * arms is paired by construction -- the same room, the same questions, the
 * same wording. On a 0/1 outcome the pairs that agree are ties, they are
 * dropped, and what is left is the count of cases where exactly one arm was
 * right: the exact sign test, enumerated.
 *
 * `maxSplits` is lowered from the default because these `n` run to the
 * hundreds, where 2^n cannot be enumerated and the function samples with a
 * fixed seed. 2^18 splits is ample for a p read to three decimals and keeps
 * `--report` quick; the printed `exact` column says which path ran.
 */
const SPLITS = 1 << 18;

function pairOn(rec: Record_, key: string, a: ArmName, b: ArmName): { a: number; b: number }[] {
  const of = (arm: ArmName): Map<string, boolean> => {
    const m = new Map<string, boolean>();
    for (const r of rec.rows) {
      if (r.arm !== arm) continue;
      for (const p of r.probes) if (p.key === key && p.level === undefined) m.set(r.case, right(p));
    }
    return m;
  };
  const A = of(a);
  const B = of(b);
  const out: { a: number; b: number }[] = [];
  for (const [c, v] of A) {
    const w = B.get(c);
    if (w !== undefined) out.push({ a: v ? 1 : 0, b: w ? 1 : 0 });
  }
  return out;
}

/** Two questions, the same arm, paired case by case. */
function pairAcross(rec: Record_, arm: ArmName, x: string, y: string): { a: number; b: number }[] {
  const of = (key: string): Map<string, boolean> => {
    const m = new Map<string, boolean>();
    for (const r of rec.rows) {
      if (r.arm !== arm) continue;
      for (const p of r.probes) if (p.key === key && p.level === undefined) m.set(r.case, right(p));
    }
    return m;
  };
  const A = of(x);
  const B = of(y);
  const out: { a: number; b: number }[] = [];
  for (const [c, v] of A) {
    const w = B.get(c);
    if (w !== undefined) out.push({ a: v ? 1 : 0, b: w ? 1 : 0 });
  }
  return out;
}

/**
 * One line of a paired comparison.
 *
 * `Paired.diff` IS NOT THE GAP, and printing it as one was this report's first
 * bug: it is the mean of the deltas AFTER ties are dropped, so when every
 * discordant case leans the same way it reads ±1 -- "-100.0pp" for a
 * 75%-versus-100% difference. The gap below is computed over ALL the pairs,
 * and `wins / discordant` carries what `diff` was actually saying.
 *
 * `floor` is printed beside `p` because it bounds it: with 5 discordant pairs
 * the smallest two-sided p reachable is 2/2^5 = 0.0625, so a p of 0.0625 there
 * is the instrument at full stretch and not a measurement of anything.
 */
/**
 * `0.0000` IS NOT A P-VALUE, and four decimals will print one.
 *
 * With 55 discordant pairs the floor is 2/2^55, which rounds to 0.0000 at four
 * places; a report that prints it flat says "impossible" where the honest
 * statement is "smaller than this table can show".
 */
export const p4 = (x: number): string => (x < 0.0001 ? "<1e-4" : x.toFixed(4)).padStart(6);

export function pairedLine(label: string, pairs: { a: number; b: number }[]): void {
  if (pairs.length === 0) return;
  const a = pairs.filter((p) => p.a === 1).length;
  const b = pairs.filter((p) => p.b === 1).length;
  const gap = ((a - b) / pairs.length) * 100;
  const t = pairedPermutation(pairs, SPLITS);
  const agree = t.n === 0;
  console.log(
    `  ${label.padEnd(12)}${pct(a, pairs.length)}  ${pct(b, pairs.length)}  ${String(pairs.length).padStart(5)}  ` +
      `${`${gap >= 0 ? "+" : ""}${gap.toFixed(1)}pp`.padStart(9)}  ${String(t.n).padStart(10)}  ` +
      `${agree ? "    -" : String(t.wins).padStart(5)}  ${agree ? "     -" : p4(t.p)}  ` +
      `${agree ? "     -" : p4(t.floor)}  ${agree ? " -" : t.exact ? "yes" : " no"}`,
  );
}

export const PAIRED_HEAD = (x: string, y: string): string =>
  `  ${"encoding".padEnd(12)}${x.padStart(4)}  ${y.padStart(4)}  ${"n".padStart(5)}  ${"gap".padStart(9)}  discordant   wins       p   floor  exact`;

function axisTests(rec: Record_, colKey: string, rowKey: string, label: string): void {
  console.log(`\n  ${label}: is the column axis worse than the row axis, within one encoding?`);
  console.log("  (the same case, the same encoding, two questions -- so this is paired)\n");
  console.log(PAIRED_HEAD("col", "row"));
  for (const arm of ARMS) {
    const pairs = pairAcross(rec, arm, colKey, rowKey);
    if (pairs.length > 0) pairedLine(LEAKY.has(arm) ? `${arm}*` : arm, pairs);
  }
  console.log(`\n  col = \`${colKey}\`, row = \`${rowKey}\`. wins = cases where the column question was right and the row one wrong.`);
  console.log("  a blank row means the two questions agreed on every case, which leaves nothing to test.");
}

function armTests(rec: Record_, key: string): void {
  console.log(`\n  \`${key}\`: does the encoding beat plain ASCII on the same cases?\n`);
  console.log(PAIRED_HEAD("arm", "asc"));
  for (const arm of ARMS) {
    if (arm === "ascii") continue;
    const pairs = pairOn(rec, key, arm, "ascii");
    if (pairs.length > 0) pairedLine(LEAKY.has(arm) ? `${arm}*` : arm, pairs);
  }
  console.log("\n  wins = cases where the encoding was right and plain ASCII wrong.");
}

/** The width sweep: the rows stay eleven, so only the column axis widens. */
function widthTable(rec: Record_): void {
  console.log("\n  the width sweep -- the room is eleven rows tall at every width\n");
  console.log(`  ${"probe".padEnd(10)}${"encoding".padEnd(10)}${WIDTHS.map((w) => `w=${w}`.padStart(9)).join("")}`);
  for (const key of ["east", "south", "adjacent"]) {
    for (const arm of ARMS) {
      const line = WIDTHS.map((w) => {
        const cells = tally(
          rec.rows.filter((r) => r.arm === arm && r.width === w),
          (_r, p) => p.key === key,
          () => "x",
        );
        const c = cells.get("x");
        return c ? pct(c.hit, c.n).padStart(9) : "        -";
      }).join("");
      console.log(`  ${key.padEnd(10)}${(LEAKY.has(arm) ? `${arm}*` : arm).padEnd(10)}${line}`);
    }
    console.log("");
  }
}

/** The `score` probe, read as the continuous thing it is. */
function scoreTable(rec: Record_, key: string, labels: string[]): void {
  const rows = rec.rows.flatMap((r) => r.probes.filter((p) => p.key === key && p.level !== undefined).map((p) => ({ arm: r.arm, p })));
  if (rows.length === 0) return;
  console.log(`\n  \`${key}\` -- does the answer MOVE with the truth?\n`);
  console.log(`  ${"encoding".padEnd(10)}${labels.map((l, i) => `${i}:${l}`.padStart(14)).join("")}      band hit   AUC(band>=2)`);
  for (const arm of ARMS) {
    const mine = rows.filter((r) => r.arm === arm);
    if (mine.length === 0) continue;
    const means = labels.map((_, level) => {
      const at = mine.filter((r) => r.p.level === level);
      return at.length === 0 ? "     -   " : `${(at.reduce((s, r) => s + r.p.answer, 0) / at.length).toFixed(2)} (${at.length})`;
    });
    const hit = mine.filter((r) => r.p.truth).length;
    const a = aucOf(mine.map((r) => ({ value: r.p.answer, positive: (r.p.level ?? 0) >= 2 })));
    console.log(
      `  ${(LEAKY.has(arm) ? `${arm}*` : arm).padEnd(10)}${means.map((m) => m.padStart(14)).join("")}      ${pct(hit, mine.length)}          ${Number.isFinite(a) ? a.toFixed(3) : "  -  "}`,
    );
  }
}

/**
 * The control arm against docs/34's own record.
 *
 * `ascii` sends the bytes docs/34 sent -- `test.ts` proves the states are
 * identical and the token totals agree to the digit. So the two runs are the
 * same experiment run twice, months apart, and the difference between them is
 * RUN-TO-RUN NOISE with nothing else in it.
 *
 * That number is needed to read the rest of the report. A 2-point difference
 * between two encodings means nothing if repeating one encoding moves it 3
 * points; a 23-point one is another matter. Rather than assert a tolerance,
 * this measures it, and from the earlier record rather than from numbers typed
 * out of the prose -- `perceive.json` is committed, so the comparison is
 * between two records and no figure here is transcribed by hand.
 */
function replication(mine: Record_): void {
  const path = resolve(HERE, "../roguelike/records/perceive.json");
  if (!existsSync(path)) {
    console.log("\n  no roguelike/records/perceive.json; skipping the replication check");
    return;
  }
  const theirs = JSON.parse(readFileSync(path, "utf8")) as {
    usage: { input: number; calls: number };
    screens: { probes: ProbeRow[] }[];
  };
  const accuracy = (rows: ProbeRow[]): Map<string, { hit: number; n: number }> => {
    const out = new Map<string, { hit: number; n: number }>();
    for (const p of rows) {
      if (p.level !== undefined) continue;
      const c = out.get(p.key) ?? { hit: 0, n: 0 };
      c.n += 1;
      if (right(p)) c.hit += 1;
      out.set(p.key, c);
    }
    return out;
  };
  const a = accuracy(mine.rows.filter((r) => r.arm === "ascii").flatMap((r) => r.probes));
  const b = accuracy(theirs.screens.flatMap((s) => s.probes));
  const ourInput = mine.rows.filter((r) => r.arm === "ascii").reduce((s, r) => s + r.input, 0);
  console.log("\n  the control arm against docs/34's record -- the same bytes, measured twice\n");
  console.log(`  ${"probe".padEnd(20)}  docs/34   ascii   gap`);
  let worst = 0;
  let within1 = 0;
  let compared = 0;
  for (const [key, mineCell] of a) {
    const theirCell = b.get(key);
    if (!theirCell) continue;
    const x = (mineCell.hit / mineCell.n) * 100;
    const y = (theirCell.hit / theirCell.n) * 100;
    const gap = x - y;
    compared += 1;
    if (Math.abs(gap) <= 1) within1 += 1;
    if (Math.abs(gap) > Math.abs(worst)) worst = gap;
    console.log(
      `  ${key.padEnd(20)}  ${`${Math.round(y)}%`.padStart(7)}  ${`${Math.round(x)}%`.padStart(6)}  ` +
        `${`${gap >= 0 ? "+" : ""}${gap.toFixed(1)}`.padStart(5)}`,
    );
  }
  console.log(
    `\n  ${compared} probes, ${within1} within one point, the largest gap ${worst >= 0 ? "+" : ""}${worst.toFixed(1)}pp.`,
  );
  console.log(
    `  input tokens: docs/34 ${theirs.usage.input.toLocaleString()} over ${theirs.usage.calls} requests, ` +
      `this run ${ourInput.toLocaleString()} over 244.`,
  );
  console.log(
    ourInput === theirs.usage.input
      ? "  IDENTICAL, which is what byte-identical payloads have to produce."
      : "  NOT identical -- the control arm is no longer sending docs/34's bytes.",
  );
}

/**
 * §3: does cropping the map to the nine squares fix the local band?
 *
 * The three states are labelled `scope/arm` because the independent variable
 * here is not the encoding alone -- `full/ascii` and `cut/ascii` are the SAME
 * encoding of two different extents, and that pair is the measurement.
 */
function cutReport(rec: Record_): void {
  const label = (r: Row): string => `${r.scope ?? "full"}/${r.arm}`;
  const combos = [...new Set(rec.rows.map(label))];
  const keys = [...new Set(rec.rows.flatMap((r) => r.probes.map((p) => p.key)))];
  const cells = new Map<string, Cell>();
  for (const r of rec.rows) {
    for (const p of r.probes) {
      const k = `${label(r)}\u0000${p.key}`;
      const cell = cells.get(k) ?? blank();
      add(cell, p);
      cells.set(k, cell);
    }
  }
  console.log(`\n  every question, every extent\n`);
  console.log(`  ${"probe".padEnd(20)}${combos.map((c) => c.padStart(15)).join("")}`);
  for (const key of keys) {
    const line = combos
      .map((c) => {
        const cell = cells.get(`${c}\u0000${key}`);
        if (!cell) return "       -       ";
        const s = separation(cell.samples);
        const showAuc = s.pos > 0 && s.neg > 0;
        return `${pct(cell.hit, cell.n)}/${showAuc ? s.auc.toFixed(2) : " -  "}`.padStart(15);
      })
      .join("");
    console.log(`  ${key.padEnd(20)}${line}`);
  }
  const of = (combo: string, key: string): Map<string, boolean> => {
    const m = new Map<string, boolean>();
    for (const r of rec.rows) {
      if (label(r) !== combo) continue;
      for (const p of r.probes) if (p.key === key) m.set(r.case, right(p));
    }
    return m;
  };
  const pairs = (a: string, b: string, key: string): { a: number; b: number }[] => {
    const A = of(a, key);
    const B = of(b, key);
    const out: { a: number; b: number }[] = [];
    for (const [c, v] of A) {
      const w = B.get(c);
      if (w !== undefined) out.push({ a: v ? 1 : 0, b: w ? 1 : 0 });
    }
    return out;
  };
  for (const against of ["cut/ascii", "cut/relative"]) {
    if (!combos.includes(against)) continue;
    console.log(`\n  \`${against}\` against \`full/ascii\`, on the same screens\n`);
    console.log(PAIRED_HEAD("cut", "ful"));
    for (const key of keys) {
      const p = pairs(against, "full/ascii", key);
      if (p.length > 0) pairedLine(key, p);
    }
    console.log("\n  wins = screens where the cropped state was right and the whole picture wrong.");
  }
}

/** What each encoding cost, which is a result and not an aside. */
export function costTable(rec: Record_, arms: readonly string[] = ARMS): void {
  console.log("\n  what each encoding cost\n");
  console.log(`  ${"encoding".padEnd(10)}  requests   input tokens   per request     ms/request`);
  // The arm list is a PARAMETER because docs/64 has its own arms. Hardcoding
  // `ARMS` here silently dropped `rects` and `bounds` from that report's cost
  // table -- a missing row, which is the kind of omission a reader cannot see.
  for (const arm of arms) {
    const mine = rec.rows.filter((r) => r.arm === arm);
    if (mine.length === 0) continue;
    const input = mine.reduce((s, r) => s + r.input, 0);
    const ms = mine.reduce((s, r) => s + r.ms, 0);
    console.log(
      `  ${arm.padEnd(10)}  ${String(mine.length).padStart(8)}   ${input.toLocaleString().padStart(12)}   ` +
        `${Math.round(input / mine.length).toLocaleString().padStart(11)}   ${Math.round(ms / mine.length).toString().padStart(12)}`,
    );
  }
}

function report(): void {
  const grid = read("grid.json");
  const screens = read("screens.json");
  if (!grid && !screens && !read("cut.json")) {
    console.log("no records yet; run with --grid, --screens and --cut");
    return;
  }
  if (grid) {
    console.log(`\n=== §1  drawn rooms -- ${new Set(grid.rows.map((r) => r.case)).size} rooms x ${ARMS.length} encodings, ${grid.usage.calls} requests`);
    armXquestion(grid, "  every question, every encoding");
    bands(grid);
    axisTests(grid, "east", "south", "drawn rooms");
    armTests(grid, "east");
    armTests(grid, "adjacent");
    widthTable(grid);
    scoreTable(grid, "distance", ["1 step", "2-4", "5-9", "10+"]);
    costTable(grid);
  }
  if (screens) {
    console.log(`\n\n=== §2  real NetHack screens -- ${new Set(screens.rows.map((r) => r.case)).size} screens x ${ARMS.length} encodings, ${screens.usage.calls} requests`);
    armXquestion(screens, "  every question, every encoding");
    bands(screens);
    axisTests(screens, "upstairs_east", "upstairs_south", "NetHack screens");
    armTests(screens, "upstairs_east");
    armTests(screens, "adjacent_monster");
    scoreTable(screens, "monster_count", ["0", "1", "2", "3+"]);
    replication(screens);
    costTable(screens);
  }
  const cut = read("cut.json");
  if (cut) {
    console.log(
      `\n\n=== §3  the nine-square crop -- ${new Set(cut.rows.map((r) => r.case)).size} screens x ${CUT_ARMS.length} states, ${cut.usage.calls} requests`,
    );
    cutReport(cut);
    costTable(cut);
  }
}

// ---------------------------------------------------------------- no-API views

function sample(): void {
  const c = corpus(1)[0];
  console.log(`\na drawn room -- width ${c.width}, ${c.quadrant}, ${c.range}\n`);
  for (const row of draw(c)) console.log(`  ${row}`);
  console.log(`\n  truth from the generator: east=${c.target.x > c.observer.x} south=${c.target.y > c.observer.y}`);
  for (const arm of ARMS) {
    const state = encode(sceneOf(c), arm);
    // The PAYLOAD length, not the pretty-printed one. Indenting for a human
    // inflated `coords` by a factor of two the first time this printed, which
    // would have put a made-up number in front of a cost comparison.
    const payload = JSON.stringify(state).length;
    const shown = JSON.stringify(state, null, 1);
    console.log(`\n--- ${arm}${LEAKY.has(arm) ? "  (contains the answer)" : ""}  ${payload} chars on the wire\n`);
    console.log(shown.length > 1200 ? `${shown.slice(0, 1200)}\n  ... [${shown.length - 1200} more chars, indented]` : shown);
  }
}

function instruments(): void {
  const cases = corpus();
  console.log(`\nthe generator: ${cases.length} rooms\n`);
  const count = (f: (c: GridCase) => boolean): string => `${cases.filter(f).length}/${cases.length}`;
  console.log(`  east true          ${count((c) => c.target.x > c.observer.x)}`);
  console.log(`  south true         ${count((c) => c.target.y > c.observer.y)}`);
  console.log(`  adjacent true      ${count((c) => c.range === "near")}`);
  console.log(`  east&south true    ${count((c) => c.target.x > c.observer.x && c.target.y > c.observer.y)}`);
  console.log(`  deep true          ${count((c) => c.level > 1)}`);
  console.log(`  lit true           ${count((c) => c.lit)}`);
  for (const w of WIDTHS) {
    const at = cases.filter((c) => c.width === w);
    console.log(
      `  width ${String(w).padStart(2)}: ${at.length} rooms, east ${at.filter((c) => c.target.x > c.observer.x).length}, ` +
        `south ${at.filter((c) => c.target.y > c.observer.y).length}, near ${at.filter((c) => c.range === "near").length}`,
    );
  }
  const grid = read("grid.json");
  const screens = read("screens.json");
  for (const [name, rec] of [["grid", grid], ["screens", screens]] as const) {
    if (!rec) continue;
    const perCase = new Map<string, Set<ArmName>>();
    for (const r of rec.rows) perCase.set(r.case, (perCase.get(r.case) ?? new Set()).add(r.arm));
    const complete = [...perCase.values()].filter((s) => s.size === ARMS.length).length;
    console.log(
      `\n  ${name}.json: ${rec.rows.length} rows, ${perCase.size} cases, ${complete} measured under all ${ARMS.length} encodings`,
    );
    const nan = rec.rows.flatMap((r) => r.probes).filter((p) => !Number.isFinite(p.answer)).length;
    console.log(`  ${name}.json: ${nan} answers missing or not a number`);
  }
}

// ------------------------------------------------------------------------ main

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // A value that starts with `--` is the NEXT FLAG, not this flag's value.
  // Without that guard `--screens --screens 244` read the limit as
  // `Number("--screens")` -- NaN -- and `slice(0, NaN)` is empty, so the run
  // would have recorded nothing and said "0 screens" on its way out.
  const arg = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    const next = i >= 0 ? argv[i + 1] : undefined;
    return next && !next.startsWith("--") ? next : fallback;
  };
  if (argv.includes("--sample")) return sample();
  if (argv.includes("--instruments")) return instruments();
  if (argv.includes("--report") || argv.length === 0) return report();
  if (argv.includes("--grid")) await runGrid(Number(arg("reps", "6")));
  if (argv.includes("--cut")) await runCut(Number(arg("screens", "244")));
  if (argv.includes("--screens")) await runScreens(Number(arg("screens", "244")));
}

if (import.meta.filename === process.argv[1]) {
  main().catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}
