#!/usr/bin/env node
/**
 * The measurement.
 *
 *   node experiment/run.mjs                                   # 4 arms x 1
 *   node experiment/run.mjs --repeat 3                        # 4 arms x 3
 *   node experiment/run.mjs --arms located,solo --repeat 5
 *
 * Four questions, in order of how much they decide whether this plugin is
 * worth switching on:
 *
 *   Q1  Does the per-function score separate real defects from clean code?
 *   Q2  How often does it fire on code that is fine -- and specifically on
 *       the `nearmiss` functions, the ones that LOOK wrong? A linter that
 *       cries wolf gets switched off, so this matters more than Q1.
 *   Q3  Does batching a whole file into one request change the answers? The
 *       plugin's entire cost story is "one request per file", and if judging
 *       50 functions together drifts from judging them one at a time, that
 *       story is bought with accuracy.
 *   Q4  Does the surrounding file help, or is the function enough?
 *
 * Q3 and Q4 are separate arms on purpose: `located` and `solo` send the same
 * state and the same question text and differ only in batch size, so their
 * difference is batching alone. `solo` and `isolated` differ only in whether
 * the file is in the state.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Jev, mapLimit } from "../src/jev.mjs";
import {
  ARMS,
  ARM_BLURB,
  DEFAULT_THRESHOLDS,
  LEVEL_NAMES,
  armShape,
  decide,
  questionsFor,
  stateFor,
  verdictFrom,
} from "../src/judge.mjs";
import { collectFiles, planBatches } from "../src/warm.mjs";
import { CLASSES, assertNoLabelLeak, labelKey, labelOf } from "./labels.mjs";
import { auc, confuse, confuseBool, mean, pct, sd, spearman, sweep } from "./metrics.mjs";

function parseArgs(argv) {
  const opts = {
    arms: ARMS.slice(),
    repeat: 1,
    concurrency: 6,
    model: undefined,
    out: null,
    from: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case "--arms":
        opts.arms = next().split(",");
        break;
      case "--from":
        opts.from = next();
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
      case "--current-thresholds":
        break;
      default:
        throw new Error(`unknown flag ${argv[i]}`);
    }
  }
  for (const arm of opts.arms) if (!ARMS.includes(arm)) throw new Error(`unknown arm ${arm}`);
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
let units = await collectFiles(["experiment/corpus/*.js"]);
// The state carries the file path, and an absolute path ending in
// `experiment/corpus/` tells Jev it is looking at a test set rather than a
// repository. Same reasoning as docs/16 using `sample.js`: the payload must
// not hint at what the payload is for. `labelKey` reads the basename, so the
// scoring is unaffected -- and `assertNoLabelLeak` fails the run if the word
// gets through anyway.
for (const unit of units) unit.file = `src/${unit.file.split("/").pop()}`;
units.sort((a, b) => labelKey(a).localeCompare(labelKey(b)));
for (const unit of units) {
  if (!labelOf(unit)) throw new Error(`no label for ${labelKey(unit)} -- run truth.mjs`);
}

/** verdicts[arm] = [ Map<key, verdict> ] one per repeat. */
const verdicts = {};
const costs = {};

/**
 * Replay. docs/19 landed on this for jevlang and the reason is the same here:
 * the answers are probabilistic, so re-running to re-score mixes a threshold
 * change with a fresh draw from the model. `--from` re-derives every number
 * in this report from a recorded run, with no API call and no variance --
 * which is how the gate in judge.mjs was retuned after the first run.
 */
const dump = opts.from ? JSON.parse(readFileSync(opts.from, "utf8")) : null;
if (dump) {
  // A replay reports on the set that was RECORDED. The corpus has grown since
  // (docs/22 added five held-out bugs), and letting those count as units with
  // no verdict would make this report's own header disagree with its tables.
  const recorded = new Set(dump.units.map((u) => u.key));
  units = units.filter((u) => recorded.has(labelKey(u)));
}

const keys = units.map(labelKey);
const labelFor = new Map(units.map((u) => [labelKey(u), labelOf(u).label]));

if (dump) {
  opts.repeat = dump.repeat;
  opts.arms = opts.arms.filter((arm) => dump.units[0]?.arms[arm]);
  Object.assign(costs, dump.costs ?? {});
  for (const arm of opts.arms) {
    verdicts[arm] = Array.from({ length: opts.repeat }, () => new Map());
    for (const row of dump.units) {
      (row.arms[arm] ?? []).forEach((verdict, r) => {
        if (verdict && verdicts[arm][r]) verdicts[arm][r].set(row.key, verdict);
      });
    }
  }
  process.stderr.write(
    `  replaying ${opts.from}: ${dump.model} recorded ${dump.at}, ` +
      `${opts.arms.join(", ")} x ${opts.repeat}\n`,
  );
}

// The label never crosses the wire; nor does the corpus directory name, which
// would hint that this is a test set rather than a repository.
const jev = new Jev({
  model: opts.model,
  onBody: assertNoLabelLeak,
  apiKey: opts.from ? "replay" : undefined,
});

for (const arm of opts.from ? [] : opts.arms) {
  const before = { calls: jev.calls, tokens: jev.inputTokens, ms: jev.totalMs };
  verdicts[arm] = [];
  const batches = planBatches(units, arm);
  for (let r = 0; r < opts.repeat; r += 1) {
    const round = new Map();
    const pairs = await mapLimit(batches, opts.concurrency, async (batch) => {
      const res = await jev.askSplitting(
        stateFor(batch.file, batch.source, batch.units, batch.arm),
        questionsFor(batch.units, batch.arm),
      );
      return batch.units.map((unit, i) => [labelKey(unit), verdictFrom(res.answers, i)]);
    });
    for (const group of pairs) {
      for (const [key, verdict] of group) if (verdict) round.set(key, verdict);
    }
    verdicts[arm].push(round);
    process.stderr.write(
      `  ${arm} r${r + 1}: ${round.size}/${units.length} verdicts, ${batches.length} request(s)\n`,
    );
  }
  costs[arm] = {
    requests: jev.calls - before.calls,
    tokens: jev.inputTokens - before.tokens,
    ms: jev.totalMs - before.ms,
    batchesPerRepeat: batches.length,
  };
}

// --------------------------------------------------------------------- score

/** Every (arm, repeat, unit) judgment pooled, with its label. */
function pool(arm, pick) {
  const out = [];
  for (const round of verdicts[arm]) {
    for (const key of keys) {
      const verdict = round.get(key);
      if (!verdict) continue;
      out.push({ key, label: labelFor.get(key), ...pick(verdict), verdict });
    }
  }
  return out;
}

/** The headline set: a real defect against code that is fine. */
const isHeadline = (label) => label === "bug" || label === "clean" || label === "nearmiss";

function headline(arm, value) {
  return pool(arm, (v) => ({ value: value(v) }))
    .filter((x) => isHeadline(x.label))
    .map((x) => ({ value: x.value, truth: x.label === "bug" }));
}

// Score a replay with the thresholds it was recorded with, so a later
// retune cannot rewrite an already-published report. See run-criteria.mjs.
const t =
  dump && dump.thresholds && !process.argv.includes("--current-thresholds")
    ? { ...DEFAULT_THRESHOLDS, ...dump.thresholds }
    : DEFAULT_THRESHOLDS;

function line(...cells) {
  console.log(cells.join(""));
}

console.log("");
console.log(
  `CORPUS  ${units.length} functions in ${new Set(units.map((u) => u.file)).size} files  ` +
    CLASSES.map((c) => `${units.filter((u) => labelOf(u).label === c).length} ${c}`).join(" / "),
);
console.log(`ARMS    ${opts.arms.join(", ")} x ${opts.repeat} repeat(s)`);
console.log(
  `GATE    score >= ${t.reportAt} or bug >= ${t.bugAt}; ` +
    `confidence < ${t.unsureBelow} makes it jev/unsure rather than silencing it`,
);

console.log("");
console.log("Q1/Q2  THE PLUGIN'S OWN GATE, bug vs (clean+nearmiss)");
line(
  "  arm        ",
  "fires  ",
  "of which unsure  ",
  "caught     ",
  "false pos  ",
  "balanced  ",
  "AUC(score)  ",
  "AUC(bug)",
);
for (const arm of opts.arms) {
  const rows = pool(arm, () => ({})).filter((x) => isHeadline(x.label));
  const gate = rows.map((x) => ({
    predicted: decide(x.verdict, t) !== null,
    truth: x.label === "bug",
  }));
  const c = confuseBool(gate);
  const unsure = rows.filter((x) => decide(x.verdict, t)?.messageId === "unsure").length;
  line(
    `  ${arm.padEnd(11)}`,
    `${String(c.tp + c.fp).padEnd(7)}`,
    `${String(unsure).padEnd(17)}`,
    `${`${c.tp}/${c.tp + c.fn}`.padEnd(11)}`,
    `${`${c.fp}/${c.fp + c.tn}`.padEnd(11)}`,
    `${pct(c.balanced).padEnd(10)}`,
    `${auc(headline(arm, (v) => v.score))
      .toFixed(2)
      .padEnd(12)}`,
    `${auc(headline(arm, (v) => v.bug ?? 0)).toFixed(2)}`,
  );
}
console.log(
  `  baseline: reporting nothing scores ${pct(confuse(headline(opts.arms[0], (v) => v.score), 99).accuracy)} accuracy, ` +
    "50.0% balanced",
);

console.log("");
console.log("WHICH SIGNAL   (docs/18 found the conservative side of two signals beat either alone)");
line(
  "  arm        ",
  "score       ",
  "score+conf  ",
  "bug noul    ",
  "either (gate)  ",
  "both required",
);
for (const arm of opts.arms) {
  const rows = pool(arm, () => ({})).filter((x) => isHeadline(x.label));
  const as = (predicted) =>
    pct(
      confuseBool(
        rows.map((x) => ({ predicted: predicted(x.verdict), truth: x.label === "bug" })),
      ).balanced,
    );
  const byScore = (v) => v.score >= t.reportAt;
  // What the first version of the gate did: require confidence before a score
  // may report anything. The column exists because it is what we removed.
  const byScoreConf = (v) => v.score >= t.reportAt && v.confidence >= t.unsureBelow;
  const byBug = (v) => v.bug !== null && v.bug >= t.bugAt;
  line(
    `  ${arm.padEnd(11)}`,
    `${as(byScore).padEnd(12)}`,
    `${as(byScoreConf).padEnd(12)}`,
    `${as(byBug).padEnd(12)}`,
    `${as((v) => byScore(v) || byBug(v)).padEnd(15)}`,
    `${as((v) => byScore(v) && byBug(v))}`,
  );
}
console.log("  `score+conf` is the gate this plugin started with -- the column is what it cost.");

console.log("");
console.log("Q2  WHERE THE FALSE POSITIVES ARE  (the number that decides whether anyone leaves it on)");
line("  arm        ", ...CLASSES.map((c) => `${c} `.padEnd(20)));
for (const arm of opts.arms) {
  const cells = CLASSES.map((cls) => {
    const rows = pool(arm, () => ({})).filter((x) => x.label === cls);
    const fired = rows.filter((x) => {
      const o = decide(x.verdict, t);
      return o !== null && o.messageId !== "unsure";
    }).length;
    const unsure = rows.filter((x) => decide(x.verdict, t)?.messageId === "unsure").length;
    return `${fired}/${rows.length}${unsure > 0 ? ` (+${unsure}?)` : ""}`.padEnd(20);
  });
  line(`  ${arm.padEnd(11)}`, ...cells);
}
console.log(
  "  `n/N` are confident findings; `(+k?)` are the `jev/unsure` ones, which also report",
);
console.log("  but as a question. Both are counted as fires in the table above.");

console.log("");
console.log("MEAN SCORE BY CLASS  (does the rubric come out monotone?)");
line("  arm        ", ...CLASSES.map((c) => c.padEnd(18)), "conf");
for (const arm of opts.arms) {
  const rows = pool(arm, (v) => ({ value: v.score }));
  const cells = CLASSES.map((cls) => {
    const xs = rows.filter((x) => x.label === cls).map((x) => x.value);
    return `${mean(xs).toFixed(2)} ±${sd(xs).toFixed(2)}`.padEnd(18);
  });
  line(
    `  ${arm.padEnd(11)}`,
    ...cells,
    mean(pool(arm, (v) => ({ value: v.confidence })).map((x) => x.value)).toFixed(2),
  );
}

console.log("");
console.log("MEAN bug-noul BY CLASS");
line("  arm        ", ...CLASSES.map((c) => c.padEnd(18)));
for (const arm of opts.arms) {
  const rows = pool(arm, (v) => ({ value: v.bug ?? Number.NaN }));
  line(
    `  ${arm.padEnd(11)}`,
    ...CLASSES.map((cls) => {
      const xs = rows.filter((x) => x.label === cls).map((x) => x.value);
      return `${mean(xs).toFixed(2)} ±${sd(xs).toFixed(2)}`.padEnd(18);
    }),
  );
}

console.log("");
console.log("BEST OPERATING POINT  (sweeping the threshold, balanced accuracy)");
for (const arm of opts.arms) {
  const s = sweep(headline(arm, (v) => v.score), 0.1, 2.9, 0.1);
  const b = sweep(headline(arm, (v) => v.bug ?? 0), 0.05, 0.95, 0.05);
  line(
    `  ${arm.padEnd(11)}`,
    `score >= ${s.threshold.toFixed(1)} -> ${pct(s.balanced)}   `,
    `bug >= ${b.threshold.toFixed(2)} -> ${pct(b.balanced)}`,
  );
}

// -------------------------------------------------- Q3 batching, Q4 context

function meanByKey(arm, pick) {
  const out = new Map();
  for (const key of keys) {
    const xs = verdicts[arm]
      .map((round) => round.get(key))
      .filter(Boolean)
      .map(pick);
    if (xs.length > 0) out.set(key, mean(xs));
  }
  return out;
}

function compare(a, b, title, note) {
  if (!verdicts[a] || !verdicts[b]) return null;
  const sa = meanByKey(a, (v) => v.score);
  const sb = meanByKey(b, (v) => v.score);
  const shared = keys.filter((k) => sa.has(k) && sb.has(k));
  const deltas = shared.map((k) => sa.get(k) - sb.get(k));
  const abs = deltas.map(Math.abs);
  let flips = 0;
  for (const key of shared) {
    const ra = verdicts[a][0].get(key);
    const rb = verdicts[b][0].get(key);
    const oa = decide(ra, t);
    const ob = decide(rb, t);
    if ((oa?.messageId ?? "-") !== (ob?.messageId ?? "-")) flips += 1;
  }
  const rho = spearman(
    shared.map((k) => sa.get(k)),
    shared.map((k) => sb.get(k)),
  );
  console.log("");
  console.log(title);
  console.log(`  ${note}`);
  console.log(
    `  mean |delta score| ${mean(abs).toFixed(3)} (max ${Math.max(...abs).toFixed(2)}), ` +
      `mean signed ${mean(deltas) >= 0 ? "+" : ""}${mean(deltas).toFixed(3)}, ` +
      `Spearman rho ${rho.toFixed(3)}`,
  );
  console.log(
    `  decisions that differ on repeat 1: ${flips}/${shared.length} ` +
      `(${pct(flips / shared.length)})`,
  );
  const moved = shared
    .map((k) => ({ k, d: sa.get(k) - sb.get(k) }))
    .sort((x, y) => Math.abs(y.d) - Math.abs(x.d))
    .slice(0, 5);
  for (const m of moved) {
    console.log(
      `    ${m.k.padEnd(34)} ${labelFor.get(m.k).padEnd(9)} ${m.d >= 0 ? "+" : ""}${m.d.toFixed(2)}`,
    );
  }
  return { meanAbs: mean(abs), meanSigned: mean(deltas), rho, flips, n: shared.length };
}

const q3 = compare(
  "located",
  "solo",
  "Q3  BATCHING: a whole file in one request vs one function per request",
  "same state, same question text -- only the number of questions differs.",
);
const q4 = compare(
  "solo",
  "isolated",
  "Q4  CONTEXT: the function with its file in the state vs the function alone",
  "same batch size (one) -- only the state differs.",
);

// ---------------------------------------------------------------- what fired

const arm0 = opts.arms[0];
console.log("");
console.log(
  `WHAT THE PLUGIN WOULD SAY  (arm ${arm0}, mean over ${opts.repeat} repeat(s))`,
);
console.log("  listing every bug and everything that fired at least once");
for (const key of keys) {
  const rounds = verdicts[arm0].map((r) => r.get(key)).filter(Boolean);
  if (rounds.length === 0) continue;
  const label = labelFor.get(key);
  const want = label === "bug";
  const outcomes = rounds.map((v) => decide(v, t)?.messageId ?? "silent");
  const firedAny = outcomes.some((m) => m !== "silent");
  if (!firedAny && !want) continue;
  const score = mean(rounds.map((v) => v.score));
  const conf = mean(rounds.map((v) => v.confidence));
  const bug = mean(rounds.map((v) => v.bug ?? Number.NaN));
  const confident = outcomes.filter((m) => m === "bug" || m === "quality").length;
  const mark = (confident > 0) === want ? "  " : want ? "FN" : "FP";
  // The most severe message it produced across the repeats, and how often.
  const worst = ["bug", "quality", "unsure", "silent"].find((m) => outcomes.includes(m));
  const hits = outcomes.filter((m) => m === worst).length;
  console.log(
    `  ${mark} ${`${worst} ${hits}/${rounds.length}`.padEnd(14)} ${key.padEnd(34)} ` +
      `${label.padEnd(9)} score ${score.toFixed(2)} conf ${conf.toFixed(2)} ` +
      `bug ${Number.isNaN(bug) ? " n/a" : bug.toFixed(2)}  ${LEVEL_NAMES[Math.round(score)] ?? ""}`,
  );
}

console.log("");
console.log("COST");
line("  arm        ", "requests  ", "tokens    ", "USD       ", "ms/request  ", "shape");
for (const arm of opts.arms) {
  const c = costs[arm];
  line(
    `  ${arm.padEnd(11)}`,
    `${String(c.requests).padEnd(10)}`,
    `${String(c.tokens).padEnd(10)}`,
    `$${((c.tokens / 1e6) * 0.042).toFixed(5).padEnd(9)}`,
    `${Math.round(c.ms / Math.max(1, c.requests)).toString().padEnd(12)}`,
    `${c.batchesPerRepeat} req/repeat, ${armShape(arm).state} state`,
  );
}
console.log(
  `  total ${jev.calls} request(s), ${jev.inputTokens} input tokens, $${jev.usd.toFixed(5)}` +
    (jev.retriedCalls > 0 ? `, ${jev.retriedCalls} retried` : "") +
    (jev.splits > 0 ? `, ${jev.splits} split` : ""),
);
console.log("");
console.log(`ARM SHAPES:`);
for (const arm of opts.arms) console.log(`  ${arm.padEnd(10)} ${ARM_BLURB[arm]}`);

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
  const dump = {
    at: new Date().toISOString(),
    model: jev.model,
    repeat: opts.repeat,
    thresholds: t,
    costs,
    q3,
    q4,
    units: keys.map((key) => ({
      key,
      label: labelFor.get(key),
      basis: labelOf(units.find((u) => labelKey(u) === key)).basis,
      arms: Object.fromEntries(
        opts.arms.map((arm) => [
          arm,
          verdicts[arm].map((round) => round.get(key) ?? null),
        ]),
      ),
    })),
  };
  writeFileSync(opts.out, `${compact(dump)}\n`);
  console.log(`raw -> ${opts.out}`);
}
