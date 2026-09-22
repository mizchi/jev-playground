/**
 * Shapes and a third dimension -- the two questions docs/63 could not ask.
 *
 *   npx tsx src/shapes.ts --sample        # one case of each part, every encoding, no API
 *   npx tsx src/shapes.ts --instruments   # the generators' balance, no API
 *   npx tsx src/shapes.ts --report        # every table, from the records, no API
 *   TYPESAFEAI_API_KEY=... npx tsx src/shapes.ts --rects   # §1, two rectangles
 *   TYPESAFEAI_API_KEY=... npx tsx src/shapes.ts --solid   # §2, a stack of layers
 *
 * [docs/63](../../../docs/63-spatial.md) measured relations between the
 * OBSERVER and one thing, on a two-dimensional picture. Two of its limits are
 * about what the corpus could not contain:
 *
 *   every relation it asked about had the `@` as one of its two terms, so
 *   "the relation must be pre-computed" could be about relations or about
 *   egocentricity, and nothing there separated them;
 *   a list of strings has two axes, so the finding "an axis that is an array
 *   index is free, an axis counted inside a string is not" was measured on
 *   one of each and never on two indices at once.
 *
 * §1 removes the observer: two rectangles, and no `@` anywhere. §2 adds a third
 * axis, which in a stack of slices is a SECOND array index -- so the reading
 * makes a prediction, written down in `solid.ts` before the run.
 *
 * The report helpers are imported from `spatial.ts` rather than rewritten. The
 * cost of reimplementing a rule instead of reusing it is the whole subject of
 * `check-doc-links.mjs`'s docblock.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Jev, type Answer, type Question } from "../../shared/jev.js";
import { auc as aucOf, separation } from "../../shared/thresholds.js";
import { encode, type ArmName } from "./encode.js";
import {
  PAIRED_HEAD,
  type ProbeRow,
  type Record_,
  type Row,
  add,
  blank,
  type Cell,
  costTable,
  pairedLine,
  pct,
  read,
  right,
  write,
} from "./spatial.js";
import {
  MARGINS,
  SHAPE_ARMS,
  SHAPE_LEAKY,
  type Margin,
  type RectCase,
  type ShapeArm,
  corpus as rectCorpus,
  draw as drawRects,
  encodeShape,
  probesFor as rectProbes,
  sceneOf as rectScene,
  overlapArea,
} from "./rects.js";
import {
  SOLID_ARMS,
  SOLID_LEAKY,
  type SolidArm,
  type SolidCase,
  corpus as solidCorpus,
  draw as drawSolid,
  encode3,
  probesFor as solidProbes,
  WIDTHS as SOLID_WIDTHS,
} from "./solid.js";

/**
 * §1's encodings.
 *
 * The first four are docs/63's, applied to this picture unchanged -- `ascii`
 * is the raster, `coords` and `sparse` are the pixels with coordinates, `runs`
 * is the compressed code form that docs/63 §2.4 ended up recommending.
 * `relative` is absent because there is no observer to be relative to, which
 * is the point of this corpus.
 *
 * The last two are the rungs a picture cannot have: `rects` is the figure
 * itself, `bounds` is the figure as the four intervals the overlap predicate
 * reads. BOTH are ceilings -- see `SHAPE_LEAKY` in `rects.ts` for why calling
 * only one of them a leak was wrong -- and they differ by exactly one addition
 * per rectangle, which makes the pair its own measurement.
 */
const PIXEL_ARMS: readonly ArmName[] = ["ascii", "coords", "sparse", "runs"] as const;
type RectArm = ArmName | ShapeArm;
const RECT_ARMS: readonly RectArm[] = [...PIXEL_ARMS, ...SHAPE_ARMS] as const;
const RECT_LEAKY = (a: RectArm): boolean => SHAPE_LEAKY.has(a as ShapeArm);

const star = (a: string, leaky: boolean): string => (leaky ? `${a}*` : a);

// ------------------------------------------------------------- §1 rectangles

async function runRects(reps: number): Promise<void> {
  const cases = rectCorpus(reps);
  const jev = new Jev();
  const rec: Record_ = { model: jev.model, usage: { input: 0, output: 0, calls: 0, ms: 0 }, rows: [] };
  for (const [i, c] of cases.entries()) {
    const { nouls, scores } = rectProbes(c);
    const questions: Record<string, Question> = Object.fromEntries([
      ...nouls.map((p) => [p.key, p.question] as const),
      ...scores.map((p) => [p.key, p.question] as const),
    ]);
    const scene = rectScene(c);
    const out = await Promise.all(
      RECT_ARMS.map(async (arm) => {
        const started = Date.now();
        const state = SHAPE_ARMS.includes(arm as ShapeArm)
          ? encodeShape(c, arm as ShapeArm)
          : encode(scene, arm as ArmName);
        const res = await jev.ask(state, questions);
        const probes: ProbeRow[] = nouls.map((p) => {
          const a = res.answers[p.key] as Answer & { noul?: number };
          return { key: p.key, band: p.band, truth: p.truth, answer: a?.noul ?? Number.NaN };
        });
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
    for (const o of out) {
      rec.rows.push({
        case: c.key,
        arm: o.arm as ArmName,
        probes: o.probes,
        input: o.input,
        ms: o.ms,
        width: c.gridWidth,
        // `margin` rides in the field docs/63 used for its near/far factor, so
        // the report can split by it with the machinery that already exists.
        range: c.margin as unknown as Row["range"],
      });
    }
    if ((i + 1) % 20 === 0 || i + 1 === cases.length) {
      console.log(`  ${i + 1}/${cases.length} pairs`);
      rec.usage = { input: jev.inputTokens, output: jev.outputTokens, calls: jev.calls, ms: jev.totalMs };
      write("rects.json", rec);
    }
  }
  console.log(`  ${cases.length} pairs x ${RECT_ARMS.length} encodings, ${jev.calls} requests -> records/rects.json`);
}

// ------------------------------------------------------------------ §2 solids

async function runSolid(reps: number): Promise<void> {
  const cases = solidCorpus(reps);
  const jev = new Jev();
  const rec: Record_ = { model: jev.model, usage: { input: 0, output: 0, calls: 0, ms: 0 }, rows: [] };
  for (const [i, c] of cases.entries()) {
    const { nouls, scores } = solidProbes(c);
    const questions: Record<string, Question> = Object.fromEntries([
      ...nouls.map((p) => [p.key, p.question] as const),
      ...scores.map((p) => [p.key, p.question] as const),
    ]);
    const out = await Promise.all(
      SOLID_ARMS.map(async (arm) => {
        const started = Date.now();
        const res = await jev.ask(encode3(c, arm), questions);
        const probes: ProbeRow[] = nouls.map((p) => {
          const a = res.answers[p.key] as Answer & { noul?: number };
          return { key: p.key, band: p.band, truth: p.truth, answer: a?.noul ?? Number.NaN };
        });
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
    for (const o of out) {
      rec.rows.push({
        case: c.key,
        arm: o.arm as unknown as ArmName,
        probes: o.probes,
        input: o.input,
        ms: o.ms,
        width: c.width,
      });
    }
    if ((i + 1) % 10 === 0 || i + 1 === cases.length) {
      console.log(`  ${i + 1}/${cases.length} blocks`);
      rec.usage = { input: jev.inputTokens, output: jev.outputTokens, calls: jev.calls, ms: jev.totalMs };
      write("solid.json", rec);
    }
  }
  console.log(`  ${cases.length} blocks x ${SOLID_ARMS.length} encodings, ${jev.calls} requests -> records/solid.json`);
}

// ------------------------------------------------------------------- reading

function armTable(rec: Record_, arms: readonly string[], leaky: (a: string) => boolean, title: string): void {
  const keys = [...new Set(rec.rows.flatMap((r) => r.probes.filter((p) => p.level === undefined).map((p) => p.key)))];
  const cells = new Map<string, Cell>();
  for (const r of rec.rows) {
    for (const p of r.probes) {
      if (p.level !== undefined) continue;
      const k = `${r.arm}\u0000${p.key}`;
      const cell = cells.get(k) ?? blank();
      add(cell, p);
      cells.set(k, cell);
    }
  }
  console.log(`\n${title}\n`);
  console.log(`  ${"probe".padEnd(16)}${arms.map((a) => star(a, leaky(a)).padStart(12)).join("")}`);
  for (const key of keys) {
    const line = arms
      .map((a) => {
        const cell = cells.get(`${a}\u0000${key}`);
        if (!cell) return "      -     ";
        const s = separation(cell.samples);
        const showAuc = s.pos > 0 && s.neg > 0;
        return `${pct(cell.hit, cell.n)}/${showAuc ? s.auc.toFixed(2) : " -  "}`.padStart(12);
      })
      .join("");
    console.log(`  ${key.padEnd(16)}${line}`);
  }
  console.log(`\n  accuracy at 0.5 / AUC. ${arms.filter(leaky).map((a) => `${a}*`).join(", ")} reads the answer off numbers I computed.`);
}

function pairsOn(rec: Record_, key: string, a: string, b: string): { a: number; b: number }[] {
  const of = (arm: string): Map<string, boolean> => {
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

function againstBaseline(rec: Record_, arms: readonly string[], leaky: (a: string) => boolean, baseline: string, keys: string[]): void {
  for (const key of keys) {
    console.log(`\n  \`${key}\`: does the encoding beat \`${baseline}\` on the same cases?\n`);
    console.log(PAIRED_HEAD("arm", "base"));
    for (const arm of arms) {
      if (arm === baseline) continue;
      const p = pairsOn(rec, key, arm, baseline);
      if (p.length > 0) pairedLine(star(arm, leaky(arm)), p);
    }
  }
}

/** §1's difficulty dial: the answer flips across a one-cell margin. */
function marginTable(rec: Record_): void {
  console.log("\n  the margin sweep -- `edge1` and `touch` differ by one cell and have opposite answers\n");
  console.log(`  ${"encoding".padEnd(12)}${MARGINS.map((m) => m.padStart(9)).join("")}   overlap`);
  for (const arm of RECT_ARMS) {
    const line = MARGINS.map((m) => {
      const at = rec.rows.filter((r) => r.arm === arm && (r.range as unknown as Margin) === m);
      const cell = blank();
      for (const r of at) for (const p of r.probes) if (p.key === "overlap") add(cell, p);
      return cell.n === 0 ? "        -" : pct(cell.hit, cell.n).padStart(9);
    }).join("");
    const all = blank();
    for (const r of rec.rows.filter((r) => r.arm === arm)) {
      for (const p of r.probes) if (p.key === "overlap") add(all, p);
    }
    console.log(`  ${star(arm, RECT_LEAKY(arm)).padEnd(12)}${line}   ${pct(all.hit, all.n)}`);
  }
  console.log("\n  `deep`/`edge1` overlap, `touch`/`gap1` do not. Each column is 60 pairs.");
}

/** §2's three axes, which is the whole prediction. */
function axisTable(rec: Record_): void {
  console.log("\n  the three axes -- z is the outer array index, y the inner one, x a character position\n");
  console.log(`  ${"encoding".padEnd(12)}${["east (x)", "south (y)", "above (z)"].map((s) => s.padStart(12)).join("")}`);
  for (const arm of SOLID_ARMS) {
    const line = ["east", "south", "above"]
      .map((key) => {
        const cell = blank();
        for (const r of rec.rows.filter((r) => (r.arm as unknown as SolidArm) === arm)) {
          for (const p of r.probes) if (p.key === key) add(cell, p);
        }
        return cell.n === 0 ? "      -     " : pct(cell.hit, cell.n).padStart(12);
      })
      .join("");
    console.log(`  ${star(arm, SOLID_LEAKY.has(arm)).padEnd(12)}${line}`);
  }
  console.log("\n  the block is seven rows and five layers at both widths, so only x changes size.");
  console.log(`\n  ${"encoding".padEnd(12)}${SOLID_WIDTHS.map((w) => `east w=${w}`.padStart(12)).join("")}`);
  for (const arm of SOLID_ARMS) {
    const line = SOLID_WIDTHS.map((w) => {
      const cell = blank();
      for (const r of rec.rows.filter((r) => (r.arm as unknown as SolidArm) === arm && r.width === w)) {
        for (const p of r.probes) if (p.key === "east") add(cell, p);
      }
      return cell.n === 0 ? "      -     " : pct(cell.hit, cell.n).padStart(12);
    }).join("");
    console.log(`  ${star(arm, SOLID_LEAKY.has(arm)).padEnd(12)}${line}`);
  }
}

function scoreTable(rec: Record_, arms: readonly string[], leaky: (a: string) => boolean, key: string, labels: string[]): void {
  const rows = rec.rows.flatMap((r) => r.probes.filter((p) => p.key === key && p.level !== undefined).map((p) => ({ arm: r.arm as string, p })));
  if (rows.length === 0) return;
  console.log(`\n  \`${key}\` -- does the answer MOVE with the truth?\n`);
  console.log(`  ${"encoding".padEnd(12)}${labels.map((l, i) => `${i}:${l}`.padStart(13)).join("")}    band hit   AUC(>=2)`);
  for (const arm of arms) {
    const mine = rows.filter((r) => r.arm === arm);
    if (mine.length === 0) continue;
    const means = labels.map((_, level) => {
      const at = mine.filter((r) => r.p.level === level);
      return at.length === 0 ? "     -   " : `${(at.reduce((s, r) => s + r.p.answer, 0) / at.length).toFixed(2)} (${at.length})`;
    });
    const hit = mine.filter((r) => r.p.truth).length;
    const a = aucOf(mine.map((r) => ({ value: r.p.answer, positive: (r.p.level ?? 0) >= 2 })));
    console.log(
      `  ${star(arm, leaky(arm)).padEnd(12)}${means.map((m) => m.padStart(13)).join("")}    ${pct(hit, mine.length)}      ${Number.isFinite(a) ? a.toFixed(3) : "  -  "}`,
    );
  }
}

function report(): void {
  const rects = read("rects.json");
  const solid = read("solid.json");
  if (!rects && !solid) {
    console.log("no records yet; run with --rects and --solid");
    return;
  }
  if (rects) {
    console.log(`\n=== §1  two rectangles -- ${new Set(rects.rows.map((r) => r.case)).size} pairs x ${RECT_ARMS.length} encodings, ${rects.usage.calls} requests`);
    armTable(rects, RECT_ARMS, (a) => RECT_LEAKY(a as RectArm), "  every question, every encoding");
    marginTable(rects);
    againstBaseline(rects, RECT_ARMS, (a) => RECT_LEAKY(a as RectArm), "ascii", ["overlap", "a_starts_left"]);
    scoreTable(rects, RECT_ARMS, (a) => RECT_LEAKY(a as RectArm), "shared_cells", ["none", "1-2", "3-8", "9+"]);
    costTable(rects, RECT_ARMS);
  }
  if (solid) {
    console.log(`\n\n=== §2  a stack of layers -- ${new Set(solid.rows.map((r) => r.case)).size} blocks x ${SOLID_ARMS.length} encodings, ${solid.usage.calls} requests`);
    armTable(solid, SOLID_ARMS, (a) => SOLID_LEAKY.has(a as SolidArm), "  every question, every encoding");
    axisTable(solid);
    againstBaseline(solid, SOLID_ARMS, (a) => SOLID_LEAKY.has(a as SolidArm), "layers", ["east", "above", "adjacent"]);
    scoreTable(solid, SOLID_ARMS, (a) => SOLID_LEAKY.has(a as SolidArm), "distance", ["1 step", "2-4", "5-9", "10+"]);
    costTable(solid, SOLID_ARMS);
  }
}

// ---------------------------------------------------------------- no-API views

function sample(): void {
  const r = rectCorpus(1).find((c) => c.margin === "edge1");
  if (r) {
    console.log(`\na pair that overlaps by one column -- ${r.axis}/${r.margin}, shared cells ${overlapArea(r.a, r.b)}\n`);
    for (const row of drawRects(r)) console.log(`  ${row}`);
    for (const arm of RECT_ARMS) {
      const state = SHAPE_ARMS.includes(arm as ShapeArm)
        ? encodeShape(r, arm as ShapeArm)
        : encode(rectScene(r), arm as ArmName);
      const payload = JSON.stringify(state);
      console.log(`\n--- ${star(arm, RECT_LEAKY(arm))}  ${payload.length} chars on the wire`);
      const shown = JSON.stringify(state, null, 1);
      console.log(shown.length > 900 ? `${shown.slice(0, 900)}\n  ... [${shown.length - 900} more chars, indented]` : shown);
    }
  }
  const s = solidCorpus(1)[0];
  console.log(`\n\na block -- ${s.width}x${s.height}x${s.depth}, ${s.octant}/${s.range}\n`);
  drawSolid(s).forEach((slice, z) => {
    console.log(`  layer ${z}:`);
    for (const row of slice) console.log(`    |${row}|`);
  });
  console.log(`\n  truth: east=${s.target.x > s.observer.x} south=${s.target.y > s.observer.y} above=${s.target.z > s.observer.z}`);
  for (const arm of SOLID_ARMS) {
    const payload = JSON.stringify(encode3(s, arm));
    console.log(`\n--- ${star(arm, SOLID_LEAKY.has(arm))}  ${payload.length} chars on the wire`);
    const shown = JSON.stringify(encode3(s, arm), null, 1);
    console.log(shown.length > 900 ? `${shown.slice(0, 900)}\n  ... [${shown.length - 900} more chars, indented]` : shown);
  }
}

function instruments(): void {
  const rs = rectCorpus();
  console.log(`\n§1 the rectangle generator: ${rs.length} pairs\n`);
  const frac = (n: number, d: number): string => `${n}/${d} (${Math.round((n / d) * 100)}%)`;
  for (const key of ["overlap", "a_starts_left", "a_starts_above", "a_is_wider", "deep", "lit"]) {
    const asked = rs.filter((c) => rectProbes(c).nouls.some((p) => p.key === key));
    const t = asked.filter((c) => rectProbes(c).nouls.find((p) => p.key === key)!.truth).length;
    console.log(`  ${key.padEnd(16)} asked on ${String(asked.length).padStart(3)}, true ${frac(t, asked.length)}`);
  }
  for (const m of MARGINS) {
    const at = rs.filter((c) => c.margin === m);
    const areas = at.map((c) => overlapArea(c.a, c.b));
    console.log(`  margin ${m.padEnd(6)} n=${at.length}  shared cells ${Math.min(...areas)}..${Math.max(...areas)}`);
  }
  const ss = solidCorpus();
  console.log(`\n§2 the block generator: ${ss.length} blocks\n`);
  console.log(`  east true   ${frac(ss.filter((c) => c.target.x > c.observer.x).length, ss.length)}`);
  console.log(`  south true  ${frac(ss.filter((c) => c.target.y > c.observer.y).length, ss.length)}`);
  console.log(`  above true  ${frac(ss.filter((c) => c.target.z > c.observer.z).length, ss.length)}`);
  console.log(`  all three   ${frac(ss.filter((c) => c.target.x > c.observer.x && c.target.y > c.observer.y && c.target.z > c.observer.z).length, ss.length)}`);
  console.log(`  adjacent    ${frac(ss.filter((c) => c.range === "near").length, ss.length)}`);
  for (const [name, rec] of [["rects", read("rects.json")], ["solid", read("solid.json")]] as const) {
    if (!rec) continue;
    const perCase = new Map<string, Set<string>>();
    for (const r of rec.rows) perCase.set(r.case, (perCase.get(r.case) ?? new Set()).add(r.arm));
    const want = name === "rects" ? RECT_ARMS.length : SOLID_ARMS.length;
    const complete = [...perCase.values()].filter((s) => s.size === want).length;
    const nan = rec.rows.flatMap((r) => r.probes).filter((p) => !Number.isFinite(p.answer)).length;
    console.log(`\n  ${name}.json: ${rec.rows.length} rows, ${perCase.size} cases, ${complete} under all ${want} encodings, ${nan} answers missing`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    const next = i >= 0 ? argv[i + 1] : undefined;
    return next && !next.startsWith("--") ? next : fallback;
  };
  if (argv.includes("--sample")) return sample();
  if (argv.includes("--instruments")) return instruments();
  if (argv.includes("--report") || argv.length === 0) return report();
  if (argv.includes("--rects")) await runRects(Number(arg("reps", "15")));
  if (argv.includes("--solid")) await runSolid(Number(arg("reps", "4")));
}

if (import.meta.filename === process.argv[1]) {
  main().catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}

export { RECT_ARMS, RECT_LEAKY, PIXEL_ARMS };
