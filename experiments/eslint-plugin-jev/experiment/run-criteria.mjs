#!/usr/bin/env node
/**
 * Does naming concrete criteria recover what the vague question missed?
 *
 *   node experiment/run-criteria.mjs --repeat 3 --out experiment/out-criteria.json
 *   node experiment/run-criteria.mjs --from experiment/out-criteria.json   # free
 *
 * docs/21 asked one vague question -- "how hard would a reviewer push back" --
 * and missed six of twelve bugs, every one of them a specific library call not
 * behaving the way the code assumed. docs/01 section 5 says a rubric answers
 * the axis you wrote and nothing else, so:
 *
 *   Q1  If you NAME the eight defect classes, are the six recovered? That
 *       separates "cannot see it" from "was not asked".
 *   Q2  What does naming classes cost on the classes you did not name? The
 *       five bugs in ranges.js and pool.js are held out for exactly this, and
 *       docs/01 section 4 predicts a hole there.
 *   Q3  When a named criterion fires on a bug, does it name the RIGHT one? If
 *       not, eight criteria are just eight shots at the same target and the
 *       taxonomy is decoration.
 *   Q4  Do the eight nouls beat one generic noul at a MATCHED false-positive
 *       rate? Firing more often is not the same as being better, and for a
 *       lint rule the false-positive rate is the binding constraint.
 *
 * The eight criteria were written by looking at this corpus's defect classes,
 * so Q1 measures a ceiling, not generalisation. Q2 is the honest complement.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Jev, mapLimit } from "../src/jev.mjs";
import {
  ATOMS,
  ATOM_NAMES,
  DEFAULT_THRESHOLDS,
  RUBRICS,
  RUBRIC_BLURB,
  decide,
  questionsFor,
  rubricShape,
  stateFor,
  firedAtom,
  topAtom,
  verdictFrom,
} from "../src/judge.mjs";
import { collectFiles, planBatches } from "../src/warm.mjs";
import { CLASSES, assertNoLabelLeak, labelKey, labelOf } from "./labels.mjs";
import { auc, confuse, confuseBool, mean, pct, sd } from "./metrics.mjs";

function parseArgs(argv) {
  const opts = {
    rubrics: RUBRICS.slice(),
    arm: "located",
    repeat: 1,
    concurrency: 6,
    model: undefined,
    out: null,
    from: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case "--rubrics":
        opts.rubrics = next().split(",");
        break;
      case "--arm":
        opts.arm = next();
        break;
      case "--repeat":
        opts.repeat = Number.parseInt(next(), 10);
        break;
      case "--concurrency":
        opts.concurrency = Number.parseInt(next(), 10);
        break;
      case "--model":
        opts.model = next();
        break;
      case "--out":
        opts.out = next();
        break;
      case "--from":
        opts.from = next();
        break;
      case "--current-thresholds":
        break;
      default:
        throw new Error(`unknown flag ${argv[i]}`);
    }
  }
  for (const r of opts.rubrics) if (!RUBRICS.includes(r)) throw new Error(`unknown rubric ${r}`);
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
let units = await collectFiles(["experiment/corpus/*.js"]);
// Same reasoning as run.mjs: an absolute path ending in `experiment/corpus/`
// tells Jev it is looking at a test set.
for (const unit of units) unit.file = `src/${unit.file.split("/").pop()}`;
units.sort((a, b) => labelKey(a).localeCompare(labelKey(b)));
for (const unit of units) {
  if (!labelOf(unit)) throw new Error(`no label for ${labelKey(unit)} -- run truth.mjs`);
}

/** verdicts[rubric] = [Map<key, verdict>] per repeat. */
const verdicts = {};
const costs = {};
const dump = opts.from ? JSON.parse(readFileSync(opts.from, "utf8")) : null;
if (dump) {
  const recorded = new Set(dump.units.map((u) => u.key));
  units = units.filter((u) => recorded.has(labelKey(u)));
}

const keys = units.map(labelKey);
const entryFor = new Map(units.map((u) => [labelKey(u), labelOf(u)]));
const labelFor = new Map(units.map((u) => [labelKey(u), labelOf(u).label]));
const coversFor = new Map(units.map((u) => [labelKey(u), labelOf(u).covers ?? null]));
const tierFor = new Map(units.map((u) => [labelKey(u), labelOf(u).tier ?? null]));

if (dump) {
  opts.repeat = dump.repeat;
  opts.arm = dump.arm ?? opts.arm;
  opts.rubrics = opts.rubrics.filter((r) => dump.units[0]?.rubrics[r]);
  Object.assign(costs, dump.costs ?? {});
  for (const rubric of opts.rubrics) {
    verdicts[rubric] = Array.from({ length: opts.repeat }, () => new Map());
    for (const row of dump.units) {
      (row.rubrics[rubric] ?? []).forEach((v, r) => {
        if (v && verdicts[rubric][r]) verdicts[rubric][r].set(row.key, v);
      });
    }
  }
  process.stderr.write(
    `  replaying ${opts.from}: ${dump.model} recorded ${dump.at}, ` +
      `${opts.rubrics.join(", ")} x ${opts.repeat}\n`,
  );
}

const jev = new Jev({
  model: opts.model,
  onBody: assertNoLabelLeak,
  apiKey: dump ? "replay" : undefined,
});

for (const rubric of dump ? [] : opts.rubrics) {
  const before = { calls: jev.calls, tokens: jev.inputTokens, ms: jev.totalMs };
  verdicts[rubric] = [];
  const batches = planBatches(units, opts.arm, rubric);
  for (let r = 0; r < opts.repeat; r += 1) {
    const round = new Map();
    const groups = await mapLimit(batches, opts.concurrency, async (batch) => {
      const res = await jev.askSplitting(
        stateFor(batch.file, batch.source, batch.units, batch.arm),
        questionsFor(batch.units, batch.arm, rubric),
      );
      return batch.units.map((unit, i) => [labelKey(unit), verdictFrom(res.answers, i, rubric)]);
    });
    for (const group of groups) {
      for (const [key, v] of group) if (v) round.set(key, v);
    }
    verdicts[rubric].push(round);
    process.stderr.write(
      `  ${rubric} r${r + 1}: ${round.size}/${units.length} verdicts, ${batches.length} request(s)\n`,
    );
  }
  costs[rubric] = {
    requests: jev.calls - before.calls,
    tokens: jev.inputTokens - before.tokens,
    ms: jev.totalMs - before.ms,
    batchesPerRepeat: batches.length,
  };
}

// --------------------------------------------------------------------- score

/**
 * On replay, score with the thresholds the run was RECORDED with.
 *
 * Without this, retuning a cutoff silently rewrites every number in an
 * already-published report, and `--from` stops being a record of anything.
 * `--current-thresholds` opts into the other reading -- what today's defaults
 * would have done to that run -- which is how the retune in docs/22's
 * addendum was measured.
 */
const t =
  dump && dump.thresholds && !process.argv.includes("--current-thresholds")
    ? { ...DEFAULT_THRESHOLDS, ...dump.thresholds }
    : DEFAULT_THRESHOLDS;
const line = (...cells) => console.log(cells.join(""));
const isOk = (label) => label === "clean" || label === "nearmiss";

/** Every (rubric, repeat, unit) judgment, with its label and `covers`. */
function pool(rubric) {
  const out = [];
  for (const round of verdicts[rubric] ?? []) {
    for (const key of keys) {
      const verdict = round.get(key);
      if (!verdict) continue;
      out.push({
        key,
        label: labelFor.get(key),
        covers: coversFor.get(key),
        tier: tierFor.get(key),
        verdict,
      });
    }
  }
  return out;
}

/** The plugin's own gate: any non-null outcome is a report. */
const fires = (verdict) => decide(verdict, t) !== null;

/** Strongest available number for "this is a defect", per rubric. */
function signal(verdict) {
  const atom = topAtom(verdict);
  const parts = [];
  if (atom) parts.push(atom.p);
  if (verdict.bug !== null) parts.push(verdict.bug);
  if (verdict.score !== null) parts.push(verdict.score / 3);
  return parts.length === 0 ? 0 : Math.max(...parts);
}

/**
 * Recall at ZERO false positives on clean+nearmiss -- the only comparison that
 * is fair across rubrics that fire at different rates, and the one a team
 * actually cares about. Sweeps the signal threshold down until the first
 * false positive, and reports the recall just above it.
 */
function recallAtCleanSweep(rows, allowedFp = 0) {
  const scored = rows.map((x) => ({ s: signal(x.verdict), bug: x.label === "bug", ok: isOk(x.label) }));
  const bugs = scored.filter((x) => x.bug).length;
  let best = { recall: 0, threshold: 1, caught: 0 };
  const cuts = [...new Set(scored.map((x) => x.s))].sort((a, b) => b - a);
  for (const cut of cuts) {
    const fp = scored.filter((x) => x.ok && x.s >= cut).length;
    if (fp > allowedFp) break;
    const caught = scored.filter((x) => x.bug && x.s >= cut).length;
    if (caught > best.caught) best = { recall: caught / bugs, threshold: cut, caught };
  }
  return { ...best, bugs };
}

console.log("");
console.log(
  `CORPUS   ${units.length} functions in ${new Set(units.map((u) => u.file)).size} files  ` +
    CLASSES.map((c) => `${units.filter((u) => labelOf(u).label === c).length} ${c}`).join(" / "),
);
const namedBugs = keys.filter((k) => labelFor.get(k) === "bug" && coversFor.get(k) !== "unnamed");
const unnamedBugs = keys.filter((k) => coversFor.get(k) === "unnamed");
console.log(
  `         of the ${namedBugs.length + unnamedBugs.length} bugs, ${namedBugs.length} are in a NAMED class ` +
    `and ${unnamedBugs.length} are held out; ${keys.filter((k) => tierFor.get(k) === "hard").length} ` +
    `of all of them are \`hard\` (need knowledge outside the function's text)`,
);
console.log(`RUBRICS  ${opts.rubrics.join(", ")} x ${opts.repeat} repeat(s), arm ${opts.arm}`);
console.log(
  `GATE     a named criterion over ITS OWN cutoff | generic noul >= ${t.bugAt} | score >= ${t.reportAt}`,
);
console.log(
  `         cutoffs: ${Object.entries(t.criterionAt ?? {})
    .map(([n, c]) => `${n} ${c}`)
    .join(", ")}`,
);

console.log("");
console.log("Q1  THE GATE, bug vs (clean+nearmiss)");
line("  rubric     ", "fires  ", "caught      ", "false pos   ", "balanced");
for (const rubric of opts.rubrics) {
  const rows = pool(rubric).filter((x) => x.label === "bug" || isOk(x.label));
  const c = confuseBool(rows.map((x) => ({ predicted: fires(x.verdict), truth: x.label === "bug" })));
  line(
    `  ${rubric.padEnd(11)}`,
    `${String(c.tp + c.fp).padEnd(7)}`,
    `${`${c.tp}/${c.tp + c.fn}`.padEnd(12)}`,
    `${`${c.fp}/${c.fp + c.tn}`.padEnd(12)}`,
    pct(c.balanced),
  );
}

console.log("");
console.log("Q2  THE TWO AXES  -- is the class NAMED, and is the defect visible from the text?");
line(
  "  rubric     ",
  "named/easy  ",
  "named/hard  ",
  "unnamed/easy  ",
  "unnamed/hard  ",
  "hard: named vs not",
);
for (const rubric of opts.rubrics) {
  const rows = pool(rubric).filter((x) => x.label === "bug");
  const cellOf = (named, tier) => {
    const r = rows.filter((x) => (x.covers !== "unnamed") === named && x.tier === tier);
    return { fired: r.filter((x) => fires(x.verdict)).length, n: r.length };
  };
  const nh = cellOf(true, "hard");
  const uh = cellOf(false, "hard");
  const rate = (c) => (c.n === 0 ? Number.NaN : c.fired / c.n);
  const show = (c) => `${c.fired}/${c.n}`;
  line(
    `  ${rubric.padEnd(11)}`,
    `${show(cellOf(true, "easy")).padEnd(12)}`,
    `${show(nh).padEnd(12)}`,
    `${show(cellOf(false, "easy")).padEnd(14)}`,
    `${show(uh).padEnd(14)}`,
    `${pct(rate(nh))} vs ${pct(rate(uh))}`,
  );
}
console.log(
  "  docs/22's first held-out set was all `unnamed/easy`, where naming makes no difference at all.",
);
console.log(
  "  The hole is the `unnamed/hard` column, and its depth is the gap in the last one.",
);

console.log("");
console.log("Q4  AT A MATCHED FALSE-POSITIVE RATE  (the comparison that is fair across rubrics)");
line("  rubric     ", "recall @ 0 FP        ", "recall @ 3 FP        ", "AUC(best signal)");
for (const rubric of opts.rubrics) {
  const rows = pool(rubric).filter((x) => x.label === "bug" || isOk(x.label));
  const z = recallAtCleanSweep(rows, 0);
  const three = recallAtCleanSweep(rows, 3);
  const a = auc(rows.map((x) => ({ value: signal(x.verdict), truth: x.label === "bug" })));
  line(
    `  ${rubric.padEnd(11)}`,
    `${`${z.caught}/${z.bugs}  ${pct(z.recall)}`.padEnd(21)}`,
    `${`${three.caught}/${three.bugs}  ${pct(three.recall)}`.padEnd(21)}`,
    a.toFixed(2),
  );
}
console.log("  Sweeps the strongest signal each rubric has, down to the stated false-positive budget.");

console.log("");
console.log("Q3  WHEN A CRITERION FIRES ON A BUG, IS IT THE RIGHT CRITERION?");
for (const rubric of opts.rubrics) {
  if (!rubricShape(rubric).atoms) continue;
  const rows = pool(rubric).filter((x) => x.label === "bug" && x.covers !== "unnamed");
  let right = 0;
  let fired = 0;
  for (const x of rows) {
    const atom = topAtom(x.verdict);
    if (!atom || atom.p < t.atomAt) continue;
    fired += 1;
    if (atom.name === x.covers) right += 1;
  }
  console.log(
    `  ${rubric.padEnd(11)} ${right}/${fired} of the fires on a named-class bug pick that class ` +
      `(${fired === 0 ? "n/a" : pct(right / fired)})`,
  );
  // Rank matters more than the argmax: a criterion that is second by 0.01 is
  // still telling you the right thing.
  let top1 = 0;
  let top2 = 0;
  for (const x of rows) {
    const ranked = Object.entries(x.verdict.atoms ?? {}).sort((a, b) => b[1] - a[1]);
    if (ranked[0]?.[0] === x.covers) top1 += 1;
    if (ranked.slice(0, 2).some(([n]) => n === x.covers)) top2 += 1;
  }
  console.log(
    `  ${" ".repeat(11)} ignoring the threshold: the right class ranks 1st in ${top1}/${rows.length}, ` +
      `top-2 in ${top2}/${rows.length}`,
  );
  // The same question at the LOWERED per-criterion cutoffs. This is the
  // tension the rest of this report sets up: those cutoffs are what makes the
  // criteria catch anything, and the name is the only reason to use criteria
  // at all. If the name stops being right there, the recall was bought with
  // the thing it was supposed to buy.
  let lowRight = 0;
  let lowFired = 0;
  for (const x of rows) {
    const fired = firedAtom(x.verdict, t);
    if (!fired) continue;
    lowFired += 1;
    if (fired.name === x.covers) lowRight += 1;
  }
  console.log(
    `  ${" ".repeat(11)} at the per-criterion cutoffs: ${lowRight}/${lowFired} ` +
      `(${lowFired === 0 ? "n/a" : pct(lowRight / lowFired)}) -- compare the 100% above`,
  );
}

/** Fitted per-criterion cutoffs, filled in by the PER-CRITERION section. */
const cutoffs = {};

console.log("");
console.log("PER-CRITERION  (on the `full` rubric if present, else `atoms`)");
const atomRubric = opts.rubrics.includes("full")
  ? "full"
  : opts.rubrics.find((r) => rubricShape(r).atoms);
if (atomRubric) {
  const rows = pool(atomRubric);
  line(
    "  criterion             ",
    "own @0.80     ",
    "others@0.80 ",
    "clean+nm@0.80   ",
    "mean own  ",
    "mean clean  ",
    "AUC own",
  );
  for (const atom of ATOMS) {
    const p = (x) => x.verdict.atoms?.[atom.name];
    const own = rows.filter((x) => x.covers === atom.name);
    const otherBugs = rows.filter((x) => x.label === "bug" && x.covers !== atom.name);
    const oks = rows.filter((x) => isOk(x.label));
    const hot = (set) => set.filter((x) => (p(x) ?? 0) >= t.atomAt).length;
    // AUC of this criterion's own class against clean code. A criterion that
    // never crosses the threshold may still RANK correctly -- which would
    // mean it is cold, not dead, and worth keeping at a lower cutoff. One
    // that sits at 0.5 carries no information at any cutoff.
    const a = auc([
      ...own.map((x) => ({ value: p(x) ?? 0, truth: true })),
      ...oks.map((x) => ({ value: p(x) ?? 0, truth: false })),
    ]);
    line(
      `  ${atom.name.padEnd(22)}`,
      `${(own.length === 0 ? "-" : `${hot(own)}/${own.length}`).padEnd(14)}`,
      `${`${hot(otherBugs)}/${otherBugs.length}`.padEnd(12)}`,
      `${`${hot(oks)}/${oks.length}`.padEnd(16)}`,
      `${(own.length === 0 ? "-" : mean(own.map((x) => p(x) ?? Number.NaN)).toFixed(2)).padEnd(10)}`,
      `${mean(oks.map((x) => p(x) ?? Number.NaN)).toFixed(2).padEnd(12)}`,
      Number.isNaN(a) ? "-" : a.toFixed(2),
    );
  }
  console.log(
    "  The three counts use the GLOBAL 0.80 cutoff, to show why one global cutoff does not work.",
  );
  console.log(
    "  `own` = bugs this criterion was written for; `clean+nm` = its false positives.",
  );
  console.log(
    "  `AUC own` ranks its own class against clean code: 0.50 is no information at any cutoff.",
  );

  // A criterion with a high AUC and a low mean is not dead, it is COLD: it
  // ranks correctly and never reaches the global cutoff. That is a
  // calibration problem, not a detection problem, and the instrument for it
  // is one cutoff per criterion -- docs/04's "questions are design,
  // thresholds are data", applied per question instead of per gate.
  console.log("");
  console.log("PER-CRITERION CUTOFF, fitted for the most own-class catches at zero false positives");
  line("  criterion             ", "cutoff  ", "own class caught  ", "vs global 0.80");
  let fittedCaught = 0;
  let fittedTotal = 0;
  for (const atom of ATOMS) {
    const p = (x) => x.verdict.atoms?.[atom.name] ?? 0;
    const own = rows.filter((x) => x.covers === atom.name);
    const oks = rows.filter((x) => isOk(x.label));
    if (own.length === 0) continue;
    // The highest clean answer is the floor: anything at or below it costs a
    // false positive, so the cutoff sits just above it.
    const worstClean = Math.max(...oks.map(p));
    const cutoff = Math.min(1, Number((worstClean + 0.01).toFixed(2)));
    const caught = own.filter((x) => p(x) >= cutoff).length;
    const global = own.filter((x) => p(x) >= t.atomAt).length;
    cutoffs[atom.name] = cutoff;
    fittedCaught += caught;
    fittedTotal += own.length;
    line(
      `  ${atom.name.padEnd(22)}`,
      `${cutoff.toFixed(2).padEnd(8)}`,
      `${`${caught}/${own.length}`.padEnd(18)}`,
      `${global}/${own.length}`,
    );
  }
  console.log(
    `  -> named-class bugs caught: ${fittedCaught}/${fittedTotal} with fitted cutoffs, ` +
      `against ${rows.filter((x) => x.label === "bug" && x.covers !== "unnamed" && (topAtom(x.verdict)?.p ?? 0) >= t.atomAt).length}/${fittedTotal} at the global ${t.atomAt}`,
  );
  console.log(
    "  These cutoffs are FITTED ON THIS CORPUS, so the number is optimistic. The robust claim is",
  );
  console.log(
    "  the AUC column above: two criteria rank their own class correctly and never reach 0.80.",
  );
  // The shipped defaults in judge.mjs ARE these numbers. Checking it here
  // means the write-up and the plugin cannot drift apart without one of the
  // two runs saying so.
  const drift = Object.entries(cutoffs).filter(
    ([name, cut]) => Math.abs((t.criterionAt?.[name] ?? -1) - cut) > 0.005,
  );
  console.log(
    drift.length === 0
      ? "  judge.mjs ships exactly these cutoffs."
      : `  judge.mjs DRIFTED from this run: ${drift
          .map(([n, c]) => `${n} ships ${t.criterionAt?.[n]}, fits ${c}`)
          .join("; ")}`,
  );
}

console.log("");
console.log("MEAN SIGNAL BY CLASS");
line("  rubric     ", "signal        ", ...CLASSES.map((c) => c.padEnd(16)));
for (const rubric of opts.rubrics) {
  const rows = pool(rubric);
  const show = (pick, name) => {
    const cells = CLASSES.map((cls) => {
      const xs = rows.filter((x) => x.label === cls).map(pick).filter((v) => typeof v === "number");
      return (xs.length === 0 ? "-" : `${mean(xs).toFixed(2)} ±${sd(xs).toFixed(2)}`).padEnd(16);
    });
    line(`  ${rubric.padEnd(11)}`, `${name.padEnd(14)}`, ...cells);
  };
  if (rubricShape(rubric).score) show((x) => x.verdict.score, "score/3");
  if (rubricShape(rubric).generic) show((x) => x.verdict.bug, "generic noul");
  if (rubricShape(rubric).atoms) show((x) => topAtom(x.verdict)?.p, "max criterion");
}

console.log("");
console.log(
  `EVERY BUG  (rubric ${atomRubric ?? opts.rubrics[0]}, mean over ${opts.repeat} repeat(s))`,
);
console.log(
  "  `own` is the probability of the criterion written for this bug's class, and whether it",
);
console.log("  clears THAT criterion's fitted cutoff. This is the docs/21 misses, re-asked by name.");
for (const key of keys) {
  if (labelFor.get(key) !== "bug") continue;
  const rubric = atomRubric ?? opts.rubrics[0];
  const rounds = (verdicts[rubric] ?? []).map((r) => r.get(key)).filter(Boolean);
  if (rounds.length === 0) continue;
  const hits = rounds.filter((v) => fires(v)).length;
  const best = rounds.map((v) => topAtom(v)).filter(Boolean);
  const name = best.length > 0 ? best[0].name : "-";
  const p = best.length > 0 ? mean(best.map((b) => b.p)) : Number.NaN;
  const covers = coversFor.get(key);
  const rightName = covers !== "unnamed" && name === covers;
  let own = "";
  if (covers && covers !== "unnamed" && cutoffs[covers] !== undefined) {
    const ps = rounds.map((v) => v.atoms?.[covers] ?? 0);
    const clears = ps.filter((x) => x >= cutoffs[covers]).length;
    own =
      `  own ${mean(ps).toFixed(2)} vs cutoff ${cutoffs[covers].toFixed(2)} ` +
      `${clears}/${ps.length}${clears === ps.length ? " RECOVERED" : ""}`;
  }
  console.log(
    `  ${hits === rounds.length ? "hit " : hits === 0 ? "MISS" : `${hits}/${rounds.length} `} ` +
      `${key.padEnd(28)} ${String(covers).padEnd(22)} ` +
      `top ${name.padEnd(22)}${Number.isNaN(p) ? "" : p.toFixed(2)}` +
      `${rightName ? " *" : "  "}${own}`,
  );
}

console.log("");
console.log("COST  (per repeat)");
line("  rubric     ", "requests  ", "tokens    ", "USD       ", "questions/fn  ", "what it asks");
for (const rubric of opts.rubrics) {
  const c = costs[rubric];
  if (!c) continue;
  const shape = rubricShape(rubric);
  const q = (shape.score ? 1 : 0) + (shape.generic ? 1 : 0) + (shape.atoms ? ATOM_NAMES.length : 0);
  line(
    `  ${rubric.padEnd(11)}`,
    `${String(Math.round(c.requests / opts.repeat)).padEnd(10)}`,
    `${String(Math.round(c.tokens / opts.repeat)).padEnd(10)}`,
    `$${((c.tokens / opts.repeat / 1e6) * 0.042).toFixed(5).padEnd(9)}`,
    `${String(q).padEnd(14)}`,
    RUBRIC_BLURB[rubric],
  );
}
if (jev.calls > 0) {
  console.log(
    `  total ${jev.calls} request(s), ${jev.inputTokens} input tokens, $${jev.usd.toFixed(5)}` +
      (jev.retriedCalls > 0 ? `, ${jev.retriedCalls} retried` : ""),
  );
}

/**
 * Recordings are machine-read, so they are written compactly and the
 * probabilities are rounded to 4 decimals. Every number this report prints is
 * a 2- or 3-decimal figure and every cutoff has 2, so the rounding is lossless
 * for the tables -- and it takes `out-loo.json` from 900 KB to a size worth
 * committing. The replays are checked against the full-precision numbers.
 */
function compact(value) {
  return JSON.stringify(value, (_key, v) =>
    typeof v === "number" && !Number.isInteger(v) ? Number(v.toFixed(4)) : v,
  );
}

if (opts.out) {
  writeFileSync(
    opts.out,
    `${compact(
      {
        at: new Date().toISOString(),
        model: jev.model,
        arm: opts.arm,
        repeat: opts.repeat,
        thresholds: t,
        atoms: ATOMS.map((a) => ({ name: a.name, covers: a.covers })),
        costs,
        units: keys.map((key) => ({
          key,
          label: labelFor.get(key),
          covers: coversFor.get(key),
          basis: entryFor.get(key).basis,
          rubrics: Object.fromEntries(
            opts.rubrics.map((r) => [r, (verdicts[r] ?? []).map((round) => round.get(key) ?? null)]),
          ),
        })),
      },
    )}\n`,
  );
  console.log(`raw -> ${opts.out}`);
}
