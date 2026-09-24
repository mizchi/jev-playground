/**
 * The component's invariants, and the two properties the report leans on.
 *
 *   npm test        # no API key
 *
 * Two of these are load-bearing for docs/25 rather than for the code:
 * `crossValidate` must never let a held-out sample into the fit (otherwise
 * every number in section A is in-sample again), and `advise` must refuse
 * rather than invent a cutoff when the classes overlap -- docs/24's finding
 * that a narrow gap is a question problem only means something if the
 * component says so out loud.
 */
import {
  advise,
  auc,
  confusion,
  crossValidate,
  drawNoise,
  groupFolds,
  logisticFit,
  logisticP,
  logisticValueAt,
  place,
  quantile,
  separation,
  type Sample,
} from "../shared/thresholds.js";

let pass = 0;
let fail = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

function ok(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

function eq<T>(actual: T, expected: T, what = ""): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}${what ? ": " : ""}${a} !== ${b}`);
}

function near(actual: number, expected: number, tol: number, what = ""): void {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${what}${what ? ": " : ""}${actual} is not within ${tol} of ${expected}`);
  }
}

const neg = (...values: number[]): Sample[] => values.map((v, i) => ({ value: v, positive: false, group: `n${i}` }));
const pos = (...values: number[]): Sample[] => values.map((v, i) => ({ value: v, positive: true, group: `p${i}` }));

// ---------------------------------------------------------------- statistics

check("quantile interpolates and clamps", () => {
  near(quantile([0, 1], 0.5), 0.5, 1e-9, "midpoint");
  near(quantile([0, 1, 2, 3], 0.9), 2.7, 1e-9, "q90");
  near(quantile([5], 0.3), 5, 1e-9, "single sample");
  near(quantile([0, 1], 2), 1, 1e-9, "clamped above");
});

check("AUC is 1 when separated, 0.5 on ties", () => {
  near(auc([...pos(1, 2), ...neg(0, 0.5)]), 1, 1e-9, "separated");
  near(auc([...pos(1), ...neg(1)]), 0.5, 1e-9, "a tie counts half");
  ok(Number.isNaN(auc(pos(1, 2))), "one class only is not a number");
});

check("separation reports the gap, signed", () => {
  eq(separation([...pos(0.8), ...neg(0.2)]).gap, 0.6000000000000001, "wide");
  ok(separation([...pos(0.2), ...neg(0.8)]).gap < 0, "overlapping is negative");
});

check("drawNoise is within-group only", () => {
  // Two groups, each asked twice: the spread BETWEEN groups must not count.
  const samples: Sample[] = [
    { value: 0.1, positive: false, group: "a" },
    { value: 0.2, positive: false, group: "a" },
    { value: 0.9, positive: false, group: "b" },
    { value: 1.0, positive: false, group: "b" },
  ];
  const n = drawNoise(samples);
  eq(n.groups, 2, "two groups");
  // Two values 0.1 apart have a sample sd of 0.1/sqrt(2), and pooling two such
  // groups leaves it there -- the 0.8 between the groups must not appear.
  near(n.sd, 0.1 / Math.SQRT2, 1e-9, "pooled within-group sd");
  near(n.maxSpread, 0.1, 1e-9, "widest single-group spread");
});

// ---------------------------------------------------------------- placements

check("the boundary rule sits just above the highest negative", () => {
  const fit = place([...pos(0.9), ...neg(0.1, 0.4)], { rule: "boundary", margin: 0.01 });
  near(fit.at, 0.41, 1e-9, "0.40 + 0.01");
  eq(confusion([...pos(0.9), ...neg(0.1, 0.4)], fit.at).fp, 0, "zero false positives in sample");
});

check("midgap refuses when the classes overlap", () => {
  ok(!place([...pos(0.2), ...neg(0.8)], { rule: "midgap" }).fittable, "refused");
  const fit = place([...pos(0.8), ...neg(0.2)], { rule: "midgap" });
  near(fit.at, 0.5, 1e-9, "midpoint");
});

check("the quantile rule ignores one loud negative", () => {
  const samples = [...pos(0.9), ...neg(0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.8)];
  const boundary = place(samples, { rule: "boundary", margin: 0.01 });
  const q = place(samples, { rule: "quantile", q: 0.8, margin: 0.01 });
  ok(q.at < boundary.at, "the outlier moves the boundary rule and not the quantile rule");
});

check("auto sits in the gap when there is one and pays the margin when there is not", () => {
  const wide = place([...pos(0.9, 0.95), ...neg(0.1, 0.2)], { rule: "auto", margin: 0.2 });
  near(wide.at, 0.55, 1e-9, "midpoint of 0.2..0.9");
  ok(wide.why.startsWith("wide gap"), `explains itself: ${wide.why}`);
  const overlap = place([...pos(0.3, 0.5), ...neg(0.1, 0.4)], { rule: "auto", margin: 0.2 });
  near(overlap.at, 0.6, 1e-9, "clean side 0.4 plus the margin");
});

check("a rule that needs a positive says so instead of returning a number", () => {
  for (const rule of ["midgap", "youden"] as const) {
    const fit = place(neg(0.1, 0.2), { rule });
    ok(!fit.fittable, `${rule} refuses without positives`);
    ok(Number.isNaN(fit.at), `${rule} returns no number`);
  }
  ok(place(neg(0.1), { rule: "boundary" }).fittable, "the clean side alone is enough for boundary");
});

check("the accuracy rule keeps the plain accuracy that youden trades for balance", () => {
  // Two positives, one of them low. Youden buys it with false positives
  // (balanced 0.81); plain accuracy gives it up (0.90). Which one a report
  // fits decides what its held-out column means, so the difference is pinned
  // rather than assumed (TODO §1.17).
  const samples = [...pos(0.9, 0.3), ...neg(0.1, 0.1, 0.2, 0.2, 0.25, 0.35, 0.4, 0.45)];
  const y = place(samples, { rule: "youden" });
  const a = place(samples, { rule: "accuracy" });
  const plain = (at: number): number => {
    const c = confusion(samples, at);
    return (c.tp + c.tn) / c.n;
  };
  ok(plain(y.at) < 0.9, `youden's cut should give plain accuracy away, got ${plain(y.at)}`);
  near(a.at, 0.46, 1e-9, "the lowest cut that stops firing on 0.45");
  near(plain(a.at), 0.9, 1e-9, "the accuracy rule's own objective");
  // The cut returned is the cut that was scored. `youden` does not have this
  // property -- its accumulated `t += step` reaches 0.2500000000000001, scores
  // the partition that leaves 0.25 out (balanced 0.81, plain 0.70), and
  // returns 0.25, which puts it back in (0.75 and 0.60) -- TODO §3.6.
  eq(a.why, "accuracy 0.90", "the scored objective, as the rule reports it");
});

check("the accuracy rule can call everything negative, and refuses a missing answer", () => {
  // One positive buried among negatives: every cut inside the values loses to
  // "nothing fires", so the rule has to be able to sit above the top answer.
  const buried = [...pos(0.2), ...neg(0.1, 0.3, 0.4, 0.5)];
  const fit = place(buried, { rule: "accuracy" });
  const c = confusion(buried, fit.at);
  eq(c.tp + c.fp, 0, "nothing fires at the chosen cut");
  eq(c.tn, 4, "the four negatives are all kept");
  const broken = place([...pos(Number.NaN), ...neg(0.1)], { rule: "accuracy" });
  ok(!broken.fittable && Number.isNaN(broken.at), "a NaN answer is refused, not scanned forever");
});

// ---------------------------------------------------------------- folds

check("folds are cut along groups, never through them", () => {
  const samples: Sample[] = [];
  for (const g of ["a", "b", "c", "d", "e", "f"]) {
    for (let draw = 0; draw < 3; draw += 1) samples.push({ value: draw / 10, positive: false, group: g });
  }
  const folds = groupFolds(samples, 3, 1);
  eq(folds.length, 3, "three folds");
  eq(folds.flat().sort(), ["a", "b", "c", "d", "e", "f"], "every group exactly once");
});

check("folds do not depend on the order the samples arrive in", () => {
  const mk = (names: string[]): Sample[] => names.map((g) => ({ value: 0, positive: false, group: g }));
  const a = groupFolds(mk(["x", "y", "z", "w"]), 2, 3).map((f) => [...f].sort());
  const b = groupFolds(mk(["w", "z", "y", "x"]), 2, 3).map((f) => [...f].sort());
  eq(a, b, "same split");
});

check("crossValidate never fits on the sample it scores", () => {
  // One loud negative. If it were in its own training set, the cutoff would be
  // above it and it could not be a false positive -- so seeing it fire is the
  // proof that it was held out.
  const samples = [...pos(0.9), ...neg(0.1, 0.1, 0.1, 0.1, 0.8)];
  const cv = crossValidate(samples, { rule: "boundary", margin: 0.01 }, { folds: 6, seed: 2 });
  eq(cv.inSample.fp, 0, "nothing fires when the fit saw everything");
  ok(cv.heldOut.fp > 0, "the loud negative fires when it is held out");
});

check("crossValidate's per-sample outcomes sum to its held-out confusion", () => {
  // `fired` exists so a paired test can read per-case outcomes out of the same
  // loop; if it ever disagreed with `heldOut` there would be two answers to
  // "what did the held-out cut do", which is the thing it was added to avoid.
  const samples = [...pos(0.9, 0.6, 0.3, 0.8), ...neg(0.1, 0.5, 0.2, 0.7, 0.35, 0.05)];
  const cv = crossValidate(samples, { rule: "accuracy" }, { folds: 3, seed: 4 });
  eq(cv.fired.length, samples.length, "one outcome per sample, in input order");
  ok(cv.fired.every((f) => f !== null), "the accuracy rule fits every fold");
  const count = (fires: boolean, positive: boolean): number =>
    samples.filter((s, i) => cv.fired[i] === fires && s.positive === positive).length;
  eq(
    [count(true, true), count(true, false), count(false, true), count(false, false)],
    [cv.heldOut.tp, cv.heldOut.fp, cv.heldOut.fn, cv.heldOut.tn],
    "tp/fp/fn/tn",
  );
  const unfit = crossValidate([...pos(0.9), ...neg(0.1, 0.2, 0.3, 0.4)], { rule: "midgap" }, { folds: 5, seed: 1 });
  ok(unfit.fired.some((f) => f === null), "a fold that could not be fitted leaves its samples unscored");
});

check("crossValidate counts the folds it could not fit", () => {
  const samples = [...pos(0.9), ...neg(0.1, 0.2, 0.3, 0.4)];
  const cv = crossValidate(samples, { rule: "midgap" }, { folds: 5, seed: 1 });
  ok(cv.unfittable >= 1, "the fold holding the only positive cannot be fitted");
  eq(cv.heldOut.tp + cv.heldOut.fn, 0, "so its own class is never scored either");
});

// ---------------------------------------------------------------- advise

check("advise separates the three reasons a cutoff does not help", () => {
  eq(advise([...pos(0.9), ...neg(0.1)], { range: 1 }).verdict, "wide-gap", "nothing to tune");
  eq(advise([...pos(0.3), ...neg(0.1)], { range: 1 }).verdict, "fit", "narrow but ordered");
  eq(advise([...pos(0.3, 0.4), ...neg(0.1, 0.35)], { range: 1 }).verdict, "overlapping", "no sound cutoff");
  eq(
    advise([...pos(0.1, 0.2, 0.3), ...neg(0.4, 0.5, 0.6)], { range: 1 }).verdict,
    "no-signal",
    "ordered the wrong way round",
  );
  eq(advise(neg(0.1, 0.2), { range: 1 }).verdict, "no-signal", "one class missing");
});

check("advise reads the gap against the scale, not in absolute terms", () => {
  // docs/24's scores run 0..3, so a gap of 0.6 there is narrow and the same
  // number on a probability is wide.
  eq(advise([...pos(2.0), ...neg(1.6)], { range: 3 }).verdict, "fit", "0.4 of 3 is narrow");
  eq(advise([...pos(2.0), ...neg(1.6)], { range: 1 }).verdict, "wide-gap", "0.4 of 1 is wide");
});

// ---------------------------------------------------------------- calibration

check("the logistic is monotone and invertible", () => {
  const points = [
    ...[0.1, 0.2, 0.3, 0.4].map((x) => ({ x, y: false })),
    ...[2.0, 2.2, 2.4].map((x) => ({ x, y: true })),
  ];
  const model = logisticFit(points, { ridge: 1 });
  ok(model.a > 0, "higher score, higher probability");
  ok(logisticP(model, 0.2) < logisticP(model, 2.2), "monotone");
  const at = logisticValueAt(model, 0.5);
  near(logisticP(model, at), 0.5, 1e-6, "inverse agrees with the model");
});

check("the ridge keeps a separable fit finite", () => {
  const points = [
    ...[0, 0.1].map((x) => ({ x, y: false })),
    ...[1, 1.1].map((x) => ({ x, y: true })),
  ];
  const model = logisticFit(points, { ridge: 1 });
  ok(Number.isFinite(model.a) && Number.isFinite(model.b), "finite coefficients");
  ok(model.a < 50, "not run off to infinity");
});

check("a cost model reads a cutoff out of the calibration", () => {
  const points = [
    ...[0.1, 0.2, 0.3, 0.5, 0.7].map((x) => ({ x, y: false })),
    ...[1.8, 2.0, 2.4].map((x) => ({ x, y: true })),
  ];
  const model = logisticFit(points, { ridge: 1 });
  // A cheap task needs less suspicion than an expensive one: same penalty,
  // different cost, so the implied cutoff has to be lower for the cheap one.
  const cheap = logisticValueAt(model, 0.5 / 600);
  const dear = logisticValueAt(model, 12.8 / 600);
  ok(cheap < dear, `cheap ${cheap.toFixed(2)} runs on less evidence than dear ${dear.toFixed(2)}`);
});

console.log("");
console.log(`  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
