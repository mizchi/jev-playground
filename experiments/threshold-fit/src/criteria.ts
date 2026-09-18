/**
 * Section A -- docs/22's eight named criteria, re-fitted by the component.
 *
 * docs/22 drew one cutoff per criterion with this rule: sit 0.01 above the
 * highest clean answer in the corpus. It reported 24/36 own-class bugs caught
 * at zero false positives, and said in the same breath that the number was
 * optimistic because the cutoffs were fitted on the corpus they were scored
 * on. Then §11.4 added ten functions and watched one criterion fire on every
 * template literal in the new set.
 *
 * Nothing new is asked here. The recorded answers are the same ones docs/22
 * quotes; what changes is that the cutoff is fitted on samples it is not
 * scored on. Three shifts, in the order they get worse:
 *
 *   folds     fit on 4/5 of the functions, score the other 1/5
 *   draws     fit on the first draw, score the second and third
 *   corpus    fit on the original 68 functions, score the 10 added later
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  addConfusion,
  advise,
  confusion,
  crossValidate,
  drawNoise,
  mean,
  place,
  placementName,
  quantile,
  separation,
  type Confusion,
  type Placement,
  type Sample,
} from "../../shared/thresholds.js";

const HERE = import.meta.dirname;
const RECORDS = resolve(HERE, "../../eslint-plugin-jev/experiment");
const RUBRIC = "full";

interface Verdict {
  score: number | null;
  confidence: number | null;
  bug: number | null;
  atoms: Record<string, number> | null;
}

interface Unit {
  key: string;
  label: "bug" | "smell" | "nearmiss" | "clean";
  covers: string | null;
  basis: string;
  rubrics: Record<string, Verdict[]>;
}

interface Record_ {
  atoms: { name: string; covers: string }[];
  thresholds: { atomAt: number; criterionAt: Record<string, number> };
  units: Unit[];
}

const load = (name: string): Record_ =>
  JSON.parse(readFileSync(resolve(RECORDS, name), "utf8")) as Record_;

const isOk = (u: Unit): boolean => u.label === "clean" || u.label === "nearmiss";

/** A sample that remembers which draw it came from, so a draw can be held out. */
type Row = Sample & { draw: number };

/**
 * One criterion's samples: its own class is positive, clean and nearmiss are
 * negative, and everything else is out of scope. Same split docs/22 scores on,
 * so the in-sample numbers below have to reproduce its table.
 */
function samplesFor(units: Unit[], criterion: string): Row[] {
  const out: Row[] = [];
  for (const u of units) {
    const own = u.label === "bug" && u.covers === criterion;
    if (!own && !isOk(u)) continue;
    (u.rubrics[RUBRIC] ?? []).forEach((draw, i) => {
      const p = draw.atoms?.[criterion];
      if (typeof p !== "number") return;
      out.push({ value: p, positive: own, group: u.key, draw: i });
    });
  }
  return out;
}

const pad = (s: string, n: number) => s.padEnd(n);
const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const EMPTY = confusion([], 0);

/** Pooled draw-to-draw spread of the clean side: the thinnest margin worth writing down. */
const noiseOf = (samples: Sample[]): number => drawNoise(samples.filter((s) => !s.positive)).sd;

/** Pooled over the eight questions: one cutoff each, fitted and scored the same way. */
function pooled(
  byName: Map<string, Row[]>,
  p: Placement,
  opts: { folds?: number; seed?: number } = {},
): { inSample: Confusion; heldOut: Confusion; refused: number; cutoffs: number[] } {
  let inSample = EMPTY;
  let heldOut = EMPTY;
  let refused = 0;
  const cutoffs: number[] = [];
  for (const samples of byName.values()) {
    const cv = crossValidate(samples, p, { folds: opts.folds ?? 5, seed: opts.seed ?? 7 });
    inSample = addConfusion(inSample, cv.inSample);
    heldOut = addConfusion(heldOut, cv.heldOut);
    refused += cv.unfittable;
    cutoffs.push(...cv.cutoffs);
  }
  return { inSample, heldOut, refused, cutoffs };
}

export function criteriaSection(): void {
  const tiers = load("out-criteria-tiers.json");
  const original = load("out-criteria.json");
  const names = tiers.atoms.map((a) => a.name);
  const byName = new Map(names.map((n) => [n, samplesFor(tiers.units, n)]));
  const draws = tiers.units[0].rubrics[RUBRIC].length;
  const global = tiers.thresholds.atomAt;

  console.log("");
  console.log("=".repeat(104));
  console.log(
    `  A. ONE CUTOFF PER QUESTION -- docs/22's ${names.length} criteria, ` +
      `${tiers.units.length} functions x ${draws} draws, \`${RUBRIC}\` rubric`,
  );
  console.log("");
  console.log(
    `  ${pad("criterion", 24)}${"own".padStart(4)}${"neg".padStart(5)}` +
      `${"mean own".padStart(10)}${"mean neg".padStart(10)}${"max neg".padStart(9)}` +
      `${"draw sd".padStart(9)}${"gap".padStart(7)}${"AUC".padStart(6)}   what the component says`,
  );
  for (const name of names) {
    const s = byName.get(name)!;
    const sep = separation(s);
    const a = advise(s, { range: 1 });
    console.log(
      `  ${pad(name, 24)}${String(sep.pos).padStart(4)}${String(sep.neg).padStart(5)}` +
        `${num(mean(s.filter((x) => x.positive).map((x) => x.value))).padStart(10)}` +
        `${num(mean(s.filter((x) => !x.positive).map((x) => x.value))).padStart(10)}` +
        `${num(sep.maxNeg).padStart(9)}${num(noiseOf(s), 3).padStart(9)}` +
        `${num(sep.gap).padStart(7)}${num(sep.auc).padStart(6)}   ${a.verdict}`,
    );
  }
  console.log("");
  console.log("  `own` and `neg` count function-draws: each function asked three times, as docs/22 scores it.");
  console.log("  `gap` is docs/24's number, here on a probability: lowest own-class answer minus highest clean one.");
  console.log("  `draw sd` is the spread of the SAME clean function asked three times -- the noise floor under");
  console.log("  any margin. docs/22's cutoffs sit 0.01 above the highest clean answer, which is inside it.");

  // ------------------------------------------------- where the 13 -> 24 came from
  console.log("");
  console.log("-".repeat(104));
  console.log(`  A2. WHERE docs/22's GAIN CAME FROM (global ${global} against one cutoff per question)`);
  console.log("");
  console.log(
    `  ${pad("criterion", 24)}${"own @global".padStart(12)}${"own @fitted".padStart(13)}` +
      `${"fitted at".padStart(11)}${"gap".padStart(7)}   verdict`,
  );
  let gGlobal = 0;
  let gFitted = 0;
  let gOwn = 0;
  const byVerdict = new Map<string, { own: number; global: number; fitted: number }>();
  for (const name of names) {
    const s = byName.get(name)!;
    const sep = separation(s);
    const a = advise(s, { range: 1 });
    const fit = place(s, { rule: "boundary", margin: 0.01 });
    const atGlobal = confusion(s, global);
    const atFitted = confusion(s, fit.at);
    gGlobal += atGlobal.tp;
    gFitted += atFitted.tp;
    gOwn += sep.pos;
    const bucket = byVerdict.get(a.verdict) ?? { own: 0, global: 0, fitted: 0 };
    byVerdict.set(a.verdict, {
      own: bucket.own + sep.pos,
      global: bucket.global + atGlobal.tp,
      fitted: bucket.fitted + atFitted.tp,
    });
    console.log(
      `  ${pad(name, 24)}${`${atGlobal.tp}/${sep.pos}`.padStart(12)}${`${atFitted.tp}/${sep.pos}`.padStart(13)}` +
        `${num(fit.at).padStart(11)}${num(sep.gap).padStart(7)}   ${a.verdict}`,
    );
  }
  console.log(`  ${pad("TOTAL", 24)}${`${gGlobal}/${gOwn}`.padStart(12)}${`${gFitted}/${gOwn}`.padStart(13)}`);
  console.log("");
  for (const [verdict, b] of [...byVerdict].sort()) {
    console.log(
      `  ${pad(verdict, 16)} own ${String(b.own).padStart(2)} draws:  ` +
        `global ${b.global}/${b.own} -> fitted ${b.fitted}/${b.own}`,
    );
  }
  console.log("");
  console.log("  The whole gain sits in the wide-gap questions, where the cutoff can be put anywhere inside");
  console.log("  the gap and the answers do not change. The overlapping ones gain nothing from any cutoff:");
  console.log("  a clean function answers higher than the bug, so sound and complete cannot both hold.");

  // ---------------------------------------------------------------- placements
  const placements: Placement[] = [
    { rule: "fixed", at: global },
    { rule: "boundary", margin: 0.01 },
    { rule: "boundary", margin: 0.05 },
    { rule: "quantile", q: 0.9, margin: 0.05 },
    { rule: "quantile", q: 0.95, margin: 0.05 },
    { rule: "midgap" },
    { rule: "youden" },
    { rule: "auto", margin: 0.2 },
  ];

  console.log("");
  console.log("-".repeat(104));
  console.log("  A3. THE SAME RULES, IN SAMPLE AND HELD OUT (5 folds over functions, pooled over the 8 questions)");
  console.log("");
  console.log(`  ${pad("", 18)}${pad("in sample", 20)}${pad("held out", 26)}`);
  console.log(
    `  ${pad("placement", 18)}${"own".padStart(8)}${"FP".padStart(6)}` +
      `${"|".padStart(6)}${"own".padStart(8)}${"FP".padStart(6)}${"refused".padStart(9)}   cutoffs`,
  );
  for (const p of placements) {
    const r = pooled(byName, p);
    const spread =
      r.cutoffs.length === 0 ? "-" : `${num(Math.min(...r.cutoffs))}..${num(Math.max(...r.cutoffs))}`;
    console.log(
      `  ${pad(placementName(p), 18)}${`${r.inSample.tp}/${r.inSample.tp + r.inSample.fn}`.padStart(8)}` +
        `${String(r.inSample.fp).padStart(6)}${"|".padStart(6)}` +
        `${`${r.heldOut.tp}/${r.heldOut.tp + r.heldOut.fn}`.padStart(8)}${String(r.heldOut.fp).padStart(6)}` +
        `${String(r.refused).padStart(9)}   ${spread}`,
    );
  }
  const neg = pooled(byName, { rule: "fixed", at: 2 }).inSample;
  console.log("");
  console.log(`  FP counts clean-or-nearmiss function-draws out of ${neg.tn} pooled over the eight questions.`);
  console.log("  In sample the boundary rule has zero by construction: it is placed above every negative it saw.");
  console.log("  `own` does not change between the two halves for the boundary and quantile rules, because a");
  console.log("  positive sample never enters those fits -- only the clean side does. `refused` is the component");
  console.log("  declining: midgap and youden need a positive in the training half, and six of the eight");
  console.log("  criteria have exactly one own-class bug. Detection for those two cannot be held out at all.");
  const on68 = pooled(
    new Map(names.map((n) => [n, samplesFor(tiers.units.filter((u) => original.units.some((o) => o.key === u.key)), n)])),
    { rule: "boundary", margin: 0.01 },
  );
  console.log("");
  console.log("  Held-out false positives, per question, for the rule docs/22 used (boundary+0.01):");
  console.log("");
  console.log(`  ${pad("criterion", 24)}${"FP held out".padStart(12)}${"of".padStart(6)}   verdict`);
  for (const name of names) {
    const s = byName.get(name)!;
    const cv = crossValidate(s, { rule: "boundary", margin: 0.01 }, { folds: 5, seed: 7 });
    console.log(
      `  ${pad(name, 24)}${String(cv.heldOut.fp).padStart(12)}` +
        `${String(cv.heldOut.fp + cv.heldOut.tn).padStart(6)}   ${advise(s, { range: 1 }).verdict}`,
    );
  }
  console.log("");
  console.log(
    `  Consistency check: the same rule on docs/22's original 68 functions catches ` +
      `${on68.inSample.tp}/${on68.inSample.tp + on68.inSample.fn} in sample, which is docs/22 §4's table. ` +
      `On all 78 it is ${gFitted}/${gOwn}:`,
  );
  console.log("  the ten added functions raised one cutoff past its own bug. That is the drift, in one number.");

  // -------------------------------------------------------------- margin sweep
  console.log("");
  console.log("-".repeat(104));
  console.log("  A4. HOW MUCH MARGIN THE HELD-OUT HALF ASKS FOR (5 folds)");
  console.log("");
  console.log(
    `  ${pad("margin", 8)}${pad("boundary: clean side + margin", 34)}${pad("auto: midgap where there is a gap", 34)}` +
      `${"draw sd x".padStart(11)}`,
  );
  console.log(
    `  ${pad("", 8)}${pad("own caught   FP in    FP held out", 34)}${pad("own caught   FP in    FP held out", 34)}`,
  );
  const meanNoise = mean(names.map((n) => noiseOf(byName.get(n)!)));
  for (const margin of [0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3]) {
    const cells = (["boundary", "auto"] as const).map((rule) => {
      const r = pooled(byName, rule === "boundary" ? { rule, margin } : { rule, margin });
      return pad(
        `${`${r.heldOut.tp}/${r.heldOut.tp + r.heldOut.fn}`.padStart(10)}` +
          `${String(r.inSample.fp).padStart(7)}${String(r.heldOut.fp).padStart(15)}`,
        34,
      );
    });
    console.log(`  ${pad(margin.toFixed(2), 8)}${cells.join("")}${(margin / meanNoise).toFixed(1).padStart(11)}`);
  }
  console.log("");
  console.log(`  The last column is the margin in units of the mean draw sd (${num(meanNoise, 3)}).`);
  console.log("  Margin buys the clean side and costs the bug side; both columns are the same recorded answers.");
  console.log("  `auto` only pays the margin on the overlapping questions -- on the five with a gap it sits in");
  console.log("  the middle of that gap instead, which is what the boundary rule throws away.");

  // ---------------------------------------------------------------- draw shift
  console.log("");
  console.log("-".repeat(104));
  console.log("  A5. DRAW SHIFT -- fit on the first draw, score the other two. Same functions, new answers.");
  console.log("");
  console.log(
    `  ${pad("placement", 18)}${"own".padStart(8)}${"FP".padStart(6)}${"of".padStart(6)}   which clean functions cross it`,
  );
  for (const p of placements.slice(0, 5)) {
    let out = EMPTY;
    const crossed = new Set<string>();
    for (const name of names) {
      const s = byName.get(name)!;
      const fit = place(
        s.filter((x) => x.draw === 0),
        p,
      );
      if (!fit.fittable) continue;
      const later = s.filter((x) => x.draw > 0);
      out = addConfusion(out, confusion(later, fit.at));
      for (const sample of later) {
        if (!sample.positive && sample.value >= fit.at) crossed.add(`${name} on ${sample.group}`);
      }
    }
    console.log(
      `  ${pad(placementName(p), 18)}${`${out.tp}/${out.tp + out.fn}`.padStart(8)}${String(out.fp).padStart(6)}` +
        `${String(out.fp + out.tn).padStart(6)}   ` +
        [...crossed].slice(0, 2).join(", ") +
        (crossed.size > 2 ? ` +${crossed.size - 2} more` : ""),
    );
  }
  console.log("");
  console.log("  No new code and no new question: the same clean function, asked a second time.");

  // -------------------------------------------------------------- corpus shift
  const originalKeys = new Set(original.units.map((u) => u.key));
  const olds = tiers.units.filter((u) => originalKeys.has(u.key));
  const news = tiers.units.filter((u) => !originalKeys.has(u.key));
  console.log("");
  console.log("-".repeat(104));
  console.log(
    `  A6. CORPUS SHIFT -- fit on docs/22's original ${olds.length} functions, score the ${news.length} it added in §11`,
  );
  console.log("");
  console.log(`  ${pad("placement", 18)}${"FP".padStart(6)}${"of".padStart(6)}   where`);
  // The first row is not a rule at all: it is the numbers the plugin actually
  // ships, fitted by hand in docs/22 on those same 68 functions.
  const rows: { label: string; at: (name: string) => number | null }[] = [
    { label: "shipped by hand", at: (name) => original.thresholds.criterionAt[name] ?? null },
    ...placements.slice(0, 5).map((p) => ({
      label: placementName(p),
      at: (name: string) => {
        const fit = place(samplesFor(olds, name), p);
        return fit.fittable ? fit.at : null;
      },
    })),
  ];
  for (const row of rows) {
    let out = EMPTY;
    const where: string[] = [];
    for (const name of names) {
      const at = row.at(name);
      const test = samplesFor(news, name);
      if (at === null || test.length === 0) continue;
      const c = confusion(test, at);
      out = addConfusion(out, c);
      if (c.fp > 0) where.push(`${name} ${c.fp}`);
    }
    console.log(
      `  ${pad(row.label, 18)}${String(out.fp).padStart(6)}${String(out.fp + out.tn).padStart(6)}   ${where.join(", ")}`,
    );
  }
  console.log("");
  console.log("  The ten added functions are five unnamed bugs, two nearmisses and three clean ones, so only");
  console.log("  the false-positive side is measurable here -- which is the side that broke in docs/22 §11.4.");
}
