#!/usr/bin/env node
/**
 * How deep is the hole that enumerating defect classes leaves?
 *
 *   node experiment/run-loo.mjs --repeat 2 --out experiment/out-loo.json
 *   node experiment/run-loo.mjs --from experiment/out-loo.json     # free
 *
 * docs/22 tried to answer this with five held-out bugs and could not: all five
 * were visible from the function's own text, so the generic question caught
 * 15/15 of them and the hole looked shallow. Two fixes, and this file is the
 * second:
 *
 *   1. `access.js` adds five held-out bugs that need outside knowledge. That
 *      is `run-criteria.mjs`, which now splits its numbers named/unnamed x
 *      easy/hard.
 *   2. **Leave one criterion out.** For each of the eight, drop it from the
 *      REQUEST and ask whether its own class still gets caught -- by the other
 *      seven, or by the generic noul. This measures the hole on bugs whose
 *      difficulty is already known, with no new corpus to argue about.
 *
 * It is the honest version of the question because the alternative -- writing
 * new "unnamed" classes -- runs into `api_default` being broad enough to
 * subsume most hard bugs. Here the class is definitionally unnamed: its
 * question is not in the request.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Jev, mapLimit } from "../src/jev.mjs";
import {
  ATOMS,
  ATOM_NAMES,
  DEFAULT_THRESHOLDS,
  firedAtom,
  questionsFor,
  stateFor,
  topAtom,
  verdictFrom,
} from "../src/judge.mjs";
import { collectFiles, planBatches } from "../src/warm.mjs";
import { assertNoLabelLeak, labelKey, labelOf } from "./labels.mjs";
import { mean, pct } from "./metrics.mjs";

function parseArgs(argv) {
  const opts = { repeat: 2, concurrency: 8, model: undefined, out: null, from: null, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
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
      case "--only":
        opts.only = next().split(",");
        break;
      case "--current-thresholds":
        break;
      default:
        throw new Error(`unknown flag ${argv[i]}`);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
let units = await collectFiles(["experiment/corpus/*.js"]);
for (const unit of units) unit.file = `src/${unit.file.split("/").pop()}`;
units.sort((a, b) => labelKey(a).localeCompare(labelKey(b)));

/**
 * The cells. `all` keeps every criterion (the control); each `drop:<name>`
 * cell sends the other seven plus the generic noul.
 *
 * Only functions whose class is the dropped one need re-asking to answer the
 * headline question -- but the clean functions are needed too, because a
 * criterion that fires more once its neighbour is gone is a false-positive
 * story, not a recovery story. So every cell asks about the whole corpus.
 */
const cells = [{ name: "all", omit: [] }];
for (const atom of ATOMS) {
  if (opts.only && !opts.only.includes(atom.name)) continue;
  // Nothing to measure for a criterion with no bug of its own in the corpus.
  const own = units.filter((u) => labelOf(u)?.covers === atom.name);
  if (own.length === 0) continue;
  cells.push({ name: `drop:${atom.name}`, omit: [atom.name] });
}

const verdicts = {};
const costs = {};
const dump = opts.from ? JSON.parse(readFileSync(opts.from, "utf8")) : null;
if (dump) {
  const recorded = new Set(dump.units.map((u) => u.key));
  units = units.filter((u) => recorded.has(labelKey(u)));
}

const keys = units.map(labelKey);
const labelFor = new Map(units.map((u) => [labelKey(u), labelOf(u).label]));
const coversFor = new Map(units.map((u) => [labelKey(u), labelOf(u).covers ?? null]));
const tierFor = new Map(units.map((u) => [labelKey(u), labelOf(u).tier ?? null]));

if (dump) {
  opts.repeat = dump.repeat;
  Object.assign(costs, dump.costs ?? {});
  for (const cell of dump.cells) {
    verdicts[cell] = Array.from({ length: opts.repeat }, () => new Map());
    for (const row of dump.units) {
      (row.cells[cell] ?? []).forEach((v, r) => {
        if (v && verdicts[cell][r]) verdicts[cell][r].set(row.key, v);
      });
    }
  }
  process.stderr.write(
    `  replaying ${opts.from}: ${dump.model} recorded ${dump.at}, ` +
      `${dump.cells.length} cell(s) x ${opts.repeat}\n`,
  );
}

const jev = new Jev({
  model: opts.model,
  onBody: assertNoLabelLeak,
  apiKey: dump ? "replay" : undefined,
});

for (const cell of dump ? [] : cells) {
  const before = { calls: jev.calls, tokens: jev.inputTokens };
  verdicts[cell.name] = [];
  const batches = planBatches(units, "located", "full", cell.omit);
  for (let r = 0; r < opts.repeat; r += 1) {
    const round = new Map();
    const groups = await mapLimit(batches, opts.concurrency, async (batch) => {
      const res = await jev.askSplitting(
        stateFor(batch.file, batch.source, batch.units, batch.arm),
        questionsFor(batch.units, batch.arm, "full", batch.omit),
      );
      return batch.units.map((unit, i) => [labelKey(unit), verdictFrom(res.answers, i, "full")]);
    });
    for (const group of groups) {
      for (const [key, v] of group) if (v) round.set(key, v);
    }
    verdicts[cell.name].push(round);
    process.stderr.write(`  ${cell.name} r${r + 1}: ${round.size}/${units.length}\n`);
  }
  costs[cell.name] = {
    requests: jev.calls - before.calls,
    tokens: jev.inputTokens - before.tokens,
  };
}

const cellNames = dump ? dump.cells : cells.map((c) => c.name);
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
const line = (...c) => console.log(c.join(""));
const isOk = (label) => label === "clean" || label === "nearmiss";

/** Would the plugin report this function, and on what grounds? */
function outcome(verdict) {
  const atom = firedAtom(verdict, t);
  if (atom) return { fired: true, how: `criterion:${atom.name}` };
  if (verdict.bug !== null && verdict.bug >= t.bugAt) return { fired: true, how: "generic" };
  if (verdict.score !== null && verdict.score >= t.reportAt) return { fired: true, how: "score" };
  return { fired: false, how: "-" };
}

function rows(cell, filter) {
  const out = [];
  for (const round of verdicts[cell] ?? []) {
    for (const key of keys) {
      const v = round.get(key);
      if (!v) continue;
      const row = {
        key,
        label: labelFor.get(key),
        covers: coversFor.get(key),
        tier: tierFor.get(key),
        verdict: v,
      };
      if (!filter || filter(row)) out.push(row);
    }
  }
  return out;
}

console.log("");
console.log(
  `CORPUS  ${units.length} functions in ${new Set(units.map((u) => u.file)).size} files, ` +
    `rubric full, arm located, ${opts.repeat} repeat(s)`,
);

// ---------------------------------------------------------------- the 2x2

console.log("");
console.log("THE TWO AXES, control cell (`all`)  -- what docs/22 could not separate");
line("  ", "cell         ", "named/easy  ", "named/hard  ", "unnamed/easy  ", "unnamed/hard  ", "clean+nm");
for (const cell of cellNames.slice(0, 1)) {
  const cellOf = (named, tier) => {
    const r = rows(cell, (x) => x.label === "bug" && (x.covers !== "unnamed") === named && x.tier === tier);
    return `${r.filter((x) => outcome(x.verdict).fired).length}/${r.length}`;
  };
  const oks = rows(cell, (x) => isOk(x.label));
  line(
    "  ",
    `${cell.padEnd(13)}`,
    `${cellOf(true, "easy").padEnd(12)}`,
    `${cellOf(true, "hard").padEnd(12)}`,
    `${cellOf(false, "easy").padEnd(14)}`,
    `${cellOf(false, "hard").padEnd(14)}`,
    `${oks.filter((x) => outcome(x.verdict).fired).length}/${oks.length}`,
  );
}
console.log("  If `unnamed/hard` tracks `named/hard`, naming the class is not what was doing the work.");

// ------------------------------------------------------- leave one out

console.log("");
console.log("LEAVE ONE CRITERION OUT  -- its own class, with and without its question");
line(
  "  criterion             ",
  "with it     ",
  "without it  ",
  "recovered by            ",
  "clean+nm FP",
);
const loo = {};
for (const atom of ATOMS) {
  const dropCell = `drop:${atom.name}`;
  if (!verdicts[dropCell]) continue;
  const own = (cell) => rows(cell, (x) => x.label === "bug" && x.covers === atom.name);
  const withIt = own("all");
  const without = own(dropCell);
  if (withIt.length === 0) continue;
  const firedWith = withIt.filter((x) => outcome(x.verdict).fired).length;
  const firedWithout = without.filter((x) => outcome(x.verdict).fired).length;
  // What picked them up once the right question was gone?
  const how = new Map();
  for (const x of without) {
    const o = outcome(x.verdict);
    if (!o.fired) continue;
    how.set(o.how, (how.get(o.how) ?? 0) + 1);
  }
  const oks = rows(dropCell, (x) => isOk(x.label));
  const fp = oks.filter((x) => outcome(x.verdict).fired).length;
  const oksAll = rows("all", (x) => isOk(x.label));
  const fpAll = oksAll.filter((x) => outcome(x.verdict).fired).length;
  loo[atom.name] = {
    n: withIt.length,
    withIt: firedWith,
    without: firedWithout,
    how: Object.fromEntries(how),
    fp,
    fpAll,
  };
  line(
    `  ${atom.name.padEnd(22)}`,
    `${`${firedWith}/${withIt.length}`.padEnd(12)}`,
    `${`${firedWithout}/${without.length}`.padEnd(12)}`,
    `${(
      [...how.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}x${v}`)
        .join(" ") || "-"
    ).padEnd(24)}`,
    `${fp}/${oks.length} (was ${fpAll}/${oksAll.length})`,
  );
}
const totalWith = Object.values(loo).reduce((a, x) => a + x.withIt, 0);
const totalWithout = Object.values(loo).reduce((a, x) => a + x.without, 0);
const totalN = Object.values(loo).reduce((a, x) => a + x.n, 0);
console.log(
  `  -> pooled: ${totalWith}/${totalN} with the right question, ${totalWithout}/${totalN} without it ` +
    `(${totalN === 0 ? "n/a" : pct((totalWith - totalWithout) / totalN)} of the set is the hole)`,
);

// ---------------------------------------- did dropping it move the others?

console.log("");
console.log("  The `clean+nm FP` column above compares SEPARATE DRAWS, so most of its movement is");
console.log("  variance, not the criterion's contribution. The attribution below is the honest read.");

// ------------------------------------------------- where the false positives are

console.log("");
console.log("FALSE POSITIVES IN THE CONTROL CELL, attributed");
console.log(
  `  a finding on ${opts.repeat}/${opts.repeat} repeats is systematic; fewer is a boundary case`,
);
const fpByGround = new Map();
for (const key of keys) {
  if (!isOk(labelFor.get(key))) continue;
  const rounds = (verdicts.all ?? []).map((r) => r.get(key)).filter(Boolean);
  const hits = rounds.map((v) => outcome(v)).filter((o) => o.fired);
  if (hits.length === 0) continue;
  for (const h of hits) fpByGround.set(h.how, (fpByGround.get(h.how) ?? 0) + 1);
  console.log(
    `  ${hits.length === rounds.length ? "every" : `${hits.length}/${rounds.length}`.padEnd(5)} ` +
      `${key.padEnd(30)} ${labelFor.get(key).padEnd(9)} ` +
      `${[...new Set(hits.map((h) => h.how))].join(", ")}`,
  );
}
console.log(
  `  -> by grounds: ${[...fpByGround.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(", ")}`,
);

/**
 * What would raising a criterion's cutoff past its systematic false positives
 * cost in own-class catches?
 *
 * Free: it re-scores the recording. docs/22 fitted every cutoff to the highest
 * clean answer plus 0.01, which puts it exactly on the boundary; this asks
 * what the next notch up is worth.
 */
console.log("");
console.log("RAISING A CUTOFF PAST ITS SYSTEMATIC FALSE POSITIVES  (re-scored, no new requests)");
line("  criterion             ", "cutoff  ", "own class  ", "its FPs  ", "raised to  ", "own class  ", "its FPs");
for (const atom of ATOMS) {
  const cutoff = t.criterionAt?.[atom.name] ?? t.atomAt;
  const p = (row) => row.verdict.atoms?.[atom.name] ?? 0;
  const own = rows("all", (x) => x.label === "bug" && x.covers === atom.name);
  const oks = rows("all", (x) => isOk(x.label));
  if (own.length === 0) continue;
  const fpNow = oks.filter((x) => p(x) >= cutoff);
  if (fpNow.length === 0) continue;
  // Just above the worst clean answer THIS criterion gives.
  const raised = Number((Math.max(...fpNow.map(p)) + 0.01).toFixed(2));
  line(
    `  ${atom.name.padEnd(22)}`,
    `${cutoff.toFixed(2).padEnd(8)}`,
    `${`${own.filter((x) => p(x) >= cutoff).length}/${own.length}`.padEnd(11)}`,
    `${String(fpNow.length).padEnd(9)}`,
    `${raised.toFixed(2).padEnd(11)}`,
    `${`${own.filter((x) => p(x) >= raised).length}/${own.length}`.padEnd(11)}`,
    `${oks.filter((x) => p(x) >= raised).length}`,
  );
}
console.log("  A criterion whose own class survives the raise is one whose cutoff was simply too low.");

console.log("");
console.log("DID DROPPING A QUESTION MOVE THE OTHER ANSWERS?");
console.log("  docs/00 measured that bundled questions do not affect each other. Same check here,");
console.log("  because the whole method depends on it: mean |delta| of the SURVIVING criteria.");
for (const atom of ATOMS) {
  const dropCell = `drop:${atom.name}`;
  if (!verdicts[dropCell]) continue;
  const deltas = [];
  for (const key of keys) {
    const a = (verdicts.all ?? []).map((r) => r.get(key)).filter(Boolean);
    const b = (verdicts[dropCell] ?? []).map((r) => r.get(key)).filter(Boolean);
    if (a.length === 0 || b.length === 0) continue;
    for (const name of ATOM_NAMES) {
      if (name === atom.name) continue;
      const pa = mean(a.map((v) => v.atoms?.[name]).filter((x) => typeof x === "number"));
      const pb = mean(b.map((v) => v.atoms?.[name]).filter((x) => typeof x === "number"));
      if (Number.isNaN(pa) || Number.isNaN(pb)) continue;
      deltas.push(Math.abs(pa - pb));
    }
  }
  console.log(
    `  ${atom.name.padEnd(22)} mean |delta| ${mean(deltas).toFixed(3)} over ${deltas.length} pairs, ` +
      `max ${Math.max(...deltas).toFixed(2)}`,
  );
}

// -------------------------------------------------------------- per bug

console.log("");
console.log("EVERY BUG, control cell  -- grouped by the two axes");
for (const named of [true, false]) {
  for (const tier of ["easy", "hard"]) {
    const group = keys.filter(
      (k) =>
        labelFor.get(k) === "bug" && (coversFor.get(k) !== "unnamed") === named && tierFor.get(k) === tier,
    );
    if (group.length === 0) continue;
    console.log("");
    console.log(`  ${named ? "named  " : "unnamed"} / ${tier}`);
    for (const key of group) {
      const rounds = (verdicts.all ?? []).map((r) => r.get(key)).filter(Boolean);
      if (rounds.length === 0) continue;
      const fired = rounds.filter((v) => outcome(v).fired).length;
      const hows = new Set(rounds.filter((v) => outcome(v).fired).map((v) => outcome(v).how));
      const top = rounds.map((v) => topAtom(v)).filter(Boolean);
      console.log(
        `    ${fired === rounds.length ? "hit " : fired === 0 ? "MISS" : `${fired}/${rounds.length} `} ` +
          `${key.padEnd(30)} ${String(coversFor.get(key)).padEnd(22)} ` +
          `${[...hows].join(",").padEnd(30)} ` +
          `top ${top.length ? `${top[0].name} ${mean(top.map((x) => x.p)).toFixed(2)}` : "-"}`,
      );
    }
  }
}

console.log("");
console.log("COST");
let reqs = 0;
let toks = 0;
for (const cell of cellNames) {
  const c = costs[cell];
  if (!c) continue;
  reqs += c.requests;
  toks += c.tokens;
}
console.log(
  `  ${cellNames.length} cell(s), ${reqs} request(s), ${toks} input tokens, ` +
    `$${((toks / 1e6) * 0.042).toFixed(5)}`,
);

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
        repeat: opts.repeat,
        thresholds: t,
        cells: cellNames,
        costs,
        loo,
        units: keys.map((key) => ({
          key,
          label: labelFor.get(key),
          covers: coversFor.get(key),
          tier: tierFor.get(key),
          cells: Object.fromEntries(
            cellNames.map((c) => [c, (verdicts[c] ?? []).map((r) => r.get(key) ?? null)]),
          ),
        })),
      },
    )}\n`,
  );
  console.log(`raw -> ${opts.out}`);
}
