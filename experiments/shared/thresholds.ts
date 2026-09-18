/**
 * Thresholds, as a component instead of a hand fit.
 *
 * docs/04 landed on "questions are design, thresholds are data"; docs/22 had to
 * draw one cutoff per question by hand and then watched the fitted numbers
 * break on the next ten functions; docs/24 found that the number worth reading
 * is not the cutoff but the GAP between the violations and everything else.
 * This is those three findings written down once, so the next experiment does
 * not fit anything by eye.
 *
 * Three things live here and nothing else:
 *
 *   advise()        should you fit at all? (docs/24: a narrow gap is a
 *                   question problem, and no cutoff repairs it)
 *   place()         where to put the cutoff, as a named rule rather than a
 *                   number typed into a config
 *   crossValidate() what that rule scores on samples it did not see, which is
 *                   the only number that was ever worth quoting
 *
 * Everything is pure and dependency-free: the values come from a recorded run,
 * so nothing in here needs an API key.
 */

/** One answer, with the label it should have cleared. */
export interface Sample {
  /** The answer being thresholded: a noul probability, or a score. */
  value: number;
  /** True when this sample SHOULD be at or above the cutoff. */
  positive: boolean;
  /**
   * Repeated draws of the same subject share a group. Folds are cut along
   * groups, so the same function asked three times can never be half in the
   * training set and half in the held-out set.
   */
  group?: string;
}

export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function sd(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Linear-interpolated quantile, q in [0,1]. */
export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const at = (s.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (at - lo);
}

/** Mann-Whitney AUC: does the value ORDER the two classes at all? */
export function auc(samples: readonly Sample[]): number {
  const pos = samples.filter((s) => s.positive).map((s) => s.value);
  const neg = samples.filter((s) => !s.positive).map((s) => s.value);
  if (pos.length === 0 || neg.length === 0) return Number.NaN;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

export interface Separation {
  n: number;
  pos: number;
  neg: number;
  /** The highest negative answer: the floor any zero-false-positive cutoff has to clear. */
  maxNeg: number;
  /** The lowest positive answer: the ceiling any full-recall cutoff has to stay under. */
  minPos: number;
  /**
   * docs/24's number. Positive means the two classes do not overlap at all and
   * any cutoff inside the gap gives the same answers; negative means they do
   * overlap, and then no cutoff exists that is both sound and complete.
   */
  gap: number;
  auc: number;
}

export function separation(samples: readonly Sample[]): Separation {
  const pos = samples.filter((s) => s.positive).map((s) => s.value);
  const neg = samples.filter((s) => !s.positive).map((s) => s.value);
  const maxNeg = neg.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...neg);
  const minPos = pos.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...pos);
  return {
    n: samples.length,
    pos: pos.length,
    neg: neg.length,
    maxNeg,
    minPos,
    gap: minPos - maxNeg,
    auc: auc(samples),
  };
}

/**
 * Within-group spread: the same subject asked more than once.
 *
 * This is the noise floor of any fitted cutoff. A margin thinner than this is
 * not a margin -- the next draw of the SAME sample crosses it. docs/22 §11.4
 * put a cutoff 0.01 above the highest clean answer and the next corpus walked
 * over it; the pooled number here says how much of that was the corpus and how
 * much was just asking again.
 */
export function drawNoise(samples: readonly Sample[]): { sd: number; groups: number; maxSpread: number } {
  const byGroup = new Map<string, number[]>();
  for (const s of samples) {
    if (s.group === undefined) continue;
    const at = byGroup.get(s.group);
    if (at) at.push(s.value);
    else byGroup.set(s.group, [s.value]);
  }
  let ss = 0;
  let df = 0;
  let maxSpread = 0;
  let groups = 0;
  for (const values of byGroup.values()) {
    if (values.length < 2) continue;
    groups += 1;
    const m = mean(values);
    for (const v of values) ss += (v - m) ** 2;
    df += values.length - 1;
    maxSpread = Math.max(maxSpread, Math.max(...values) - Math.min(...values));
  }
  return { sd: df === 0 ? 0 : Math.sqrt(ss / df), groups, maxSpread };
}

/**
 * Where to put the cutoff, as a rule with a name.
 *
 * `boundary` is what docs/22 did by hand: sit just above the highest negative,
 * which buys zero false positives on the corpus you fitted on and nothing at
 * all on the next one. `quantile` throws away the extreme order statistic --
 * the single loudest clean sample -- which is the part that does not survive a
 * redraw. `midgap` needs the classes to be separated and then places the
 * cutoff as far from both as possible. `youden` maximises balanced accuracy,
 * i.e. it is allowed to spend false positives to buy recall.
 */
export type Placement =
  | { rule: "fixed"; at: number }
  | { rule: "boundary"; margin?: number }
  | { rule: "quantile"; q: number; margin?: number }
  | { rule: "midgap" }
  | { rule: "youden"; step?: number }
  /**
   * The rule to reach for: sit in the middle of the gap when there is one, and
   * fall back to the clean side plus a margin when the classes overlap. It is
   * `advise` and `place` wired together, because "is there a gap" is the
   * question that decides which placement is even meaningful (docs/24 §1).
   */
  | { rule: "auto"; margin?: number; range?: number; wide?: number };

export interface Placed {
  at: number;
  /** False when the training samples cannot support this rule at all. */
  fittable: boolean;
  why: string;
}

export function placementName(p: Placement): string {
  switch (p.rule) {
    case "fixed":
      return `fixed ${p.at}`;
    case "boundary":
      return `boundary+${(p.margin ?? 0.01).toFixed(2)}`;
    case "quantile":
      return `q${Math.round(p.q * 100)}+${(p.margin ?? 0).toFixed(2)}`;
    case "midgap":
      return "midgap";
    case "youden":
      return "youden";
    case "auto":
      return `auto+${(p.margin ?? 0.01).toFixed(2)}`;
  }
}

export function place(samples: readonly Sample[], placement: Placement): Placed {
  const pos = samples.filter((s) => s.positive).map((s) => s.value);
  const neg = samples.filter((s) => !s.positive).map((s) => s.value);
  switch (placement.rule) {
    case "fixed":
      return { at: placement.at, fittable: true, why: "given" };
    case "boundary": {
      if (neg.length === 0) return { at: Number.NaN, fittable: false, why: "no negatives to sit above" };
      const margin = placement.margin ?? 0.01;
      return { at: Math.max(...neg) + margin, fittable: true, why: `max negative ${Math.max(...neg).toFixed(2)} + ${margin}` };
    }
    case "quantile": {
      if (neg.length === 0) return { at: Number.NaN, fittable: false, why: "no negatives to quantile" };
      const margin = placement.margin ?? 0;
      const q = quantile(neg, placement.q);
      return { at: q + margin, fittable: true, why: `negatives q${Math.round(placement.q * 100)} ${q.toFixed(2)} + ${margin}` };
    }
    case "midgap": {
      if (pos.length === 0 || neg.length === 0) {
        return { at: Number.NaN, fittable: false, why: "midgap needs both classes" };
      }
      const maxNeg = Math.max(...neg);
      const minPos = Math.min(...pos);
      if (minPos <= maxNeg) {
        // The classes overlap, so there is no gap to sit in the middle of.
        // docs/24: that is a question problem, and this rule refuses rather
        // than pretending a cutoff exists.
        return { at: Number.NaN, fittable: false, why: `overlapping (gap ${(minPos - maxNeg).toFixed(2)})` };
      }
      return { at: (maxNeg + minPos) / 2, fittable: true, why: `midpoint of ${maxNeg.toFixed(2)}..${minPos.toFixed(2)}` };
    }
    case "youden": {
      if (pos.length === 0 || neg.length === 0) {
        return { at: Number.NaN, fittable: false, why: "youden needs both classes" };
      }
      const step = placement.step ?? 0.01;
      const lo = Math.min(...samples.map((s) => s.value));
      const hi = Math.max(...samples.map((s) => s.value));
      let best = { at: lo, balanced: -1 };
      for (let t = lo; t <= hi + 1e-9; t += step) {
        const c = confusion(samples, t);
        if (c.balanced > best.balanced) best = { at: Number(t.toFixed(4)), balanced: c.balanced };
      }
      return { at: best.at, fittable: true, why: `balanced accuracy ${best.balanced.toFixed(2)}` };
    }
    case "auto": {
      const verdict = advise(samples, { range: placement.range, wide: placement.wide }).verdict;
      if (verdict === "wide-gap") {
        const mid = place(samples, { rule: "midgap" });
        if (mid.fittable) return { at: mid.at, fittable: true, why: `wide gap, ${mid.why}` };
      }
      const fallback = place(samples, { rule: "boundary", margin: placement.margin ?? 0.01 });
      return { ...fallback, why: `${verdict}, ${fallback.why}` };
    }
  }
}

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  n: number;
  recall: number;
  specificity: number;
  precision: number;
  balanced: number;
}

export function confusion(samples: readonly Sample[], at: number): Confusion {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const s of samples) {
    const fires = s.value >= at;
    if (fires && s.positive) tp += 1;
    else if (fires) fp += 1;
    else if (s.positive) fn += 1;
    else tn += 1;
  }
  const recall = tp + fn === 0 ? Number.NaN : tp / (tp + fn);
  const specificity = fp + tn === 0 ? Number.NaN : tn / (fp + tn);
  const precision = tp + fp === 0 ? Number.NaN : tp / (tp + fp);
  return {
    tp,
    fp,
    fn,
    tn,
    n: samples.length,
    recall,
    specificity,
    precision,
    balanced: (recall + specificity) / 2,
  };
}

export function addConfusion(a: Confusion, b: Confusion): Confusion {
  const tp = a.tp + b.tp;
  const fp = a.fp + b.fp;
  const fn = a.fn + b.fn;
  const tn = a.tn + b.tn;
  const recall = tp + fn === 0 ? Number.NaN : tp / (tp + fn);
  const specificity = fp + tn === 0 ? Number.NaN : tn / (fp + tn);
  return {
    tp,
    fp,
    fn,
    tn,
    n: a.n + b.n,
    recall,
    specificity,
    precision: tp + fp === 0 ? Number.NaN : tp / (tp + fp),
    balanced: (recall + specificity) / 2,
  };
}

const EMPTY: Confusion = {
  tp: 0,
  fp: 0,
  fn: 0,
  tn: 0,
  n: 0,
  recall: Number.NaN,
  specificity: Number.NaN,
  precision: Number.NaN,
  balanced: Number.NaN,
};

/** Deterministic group -> fold assignment. Same samples, same folds, forever. */
export function groupFolds(samples: readonly Sample[], folds: number, seed = 1): string[][] {
  const groups = [...new Set(samples.map((s, i) => s.group ?? `#${i}`))];
  // A tiny string hash, so the split does not depend on the input order.
  const hash = (s: string): number => {
    let h = seed * 2654435761;
    for (let i = 0; i < s.length; i += 1) h = (h ^ s.charCodeAt(i)) * 16777619 >>> 0;
    return h >>> 0;
  };
  const ordered = [...groups].sort((a, b) => hash(a) - hash(b) || (a < b ? -1 : 1));
  const out: string[][] = Array.from({ length: folds }, () => []);
  ordered.forEach((g, i) => out[i % folds].push(g));
  return out;
}

export interface CrossValidated {
  placement: string;
  /** Fit on everything, score on everything: the number a hand fit reports. */
  inSample: Confusion;
  /** Fit on the other folds, score on this one: the number that means something. */
  heldOut: Confusion;
  /** Cutoffs one per fold, to show how much the fit itself moves. */
  cutoffs: number[];
  /** Folds whose training half could not support the rule at all. */
  unfittable: number;
}

/**
 * K-fold over groups.
 *
 * Note what this does NOT do: it never stratifies. A question with one
 * positive sample gets folds with no positives, and rules that need a positive
 * (`midgap`, `youden`) then report themselves unfittable. That is the honest
 * answer -- docs/22's eight criteria have 1 to 4 own-class bugs each, which is
 * enough to fit a cutoff FROM THE NEGATIVE SIDE and not enough to fit one from
 * both.
 */
export function crossValidate(
  samples: readonly Sample[],
  placement: Placement,
  opts: { folds?: number; seed?: number } = {},
): CrossValidated {
  const folds = opts.folds ?? 5;
  const split = groupFolds(samples, folds, opts.seed ?? 1);
  const keyOf = (s: Sample, i: number) => s.group ?? `#${i}`;
  let heldOut = EMPTY;
  let unfittable = 0;
  const cutoffs: number[] = [];
  for (const held of split) {
    if (held.length === 0) continue;
    const inHeld = new Set(held);
    const train = samples.filter((s, i) => !inHeld.has(keyOf(s, i)));
    const test = samples.filter((s, i) => inHeld.has(keyOf(s, i)));
    const fit = place(train, placement);
    if (!fit.fittable) {
      unfittable += 1;
      continue;
    }
    cutoffs.push(fit.at);
    heldOut = addConfusion(heldOut, confusion(test, fit.at));
  }
  const all = place(samples, placement);
  return {
    placement: placementName(placement),
    inSample: all.fittable ? confusion(samples, all.at) : EMPTY,
    heldOut,
    cutoffs,
    unfittable,
  };
}

export type Verdict = "no-signal" | "overlapping" | "wide-gap" | "fit";

export interface Advice {
  verdict: Verdict;
  separation: Separation;
  /** The draw-to-draw noise, when the samples carry repeats. */
  noise: number;
  reason: string;
}

/**
 * The first thing the component should say is not a number, it is whether a
 * number would help. docs/24's two failures were 0.16 and 0.28 wide on a
 * 0..3 score and no cutoff repaired either of them; its four working rules
 * were 1.79..2.16 wide and the default 2.0 fell in the middle of all four.
 *
 *   range   the value scale (1 for a noul probability, 3 for a 4-level score)
 *   wide    gap/range above which the cutoff does not matter (default 0.2)
 */
export function advise(
  samples: readonly Sample[],
  opts: { range?: number; wide?: number; minAuc?: number } = {},
): Advice {
  const sep = separation(samples);
  const range = opts.range ?? 1;
  const wide = opts.wide ?? 0.2;
  const noise = drawNoise(samples).sd;
  if (sep.pos === 0 || sep.neg === 0) {
    return { verdict: "no-signal", separation: sep, noise, reason: "one of the two classes is empty" };
  }
  if (Number.isFinite(sep.auc) && sep.auc < (opts.minAuc ?? 0.6)) {
    // Not a calibration problem: the answers do not order the classes, so
    // every cutoff is equally wrong. Rewrite the question (docs/24 §2).
    return { verdict: "no-signal", separation: sep, noise, reason: `AUC ${sep.auc.toFixed(2)}: the answers do not order the classes` };
  }
  if (sep.gap <= 0) {
    return {
      verdict: "overlapping",
      separation: sep,
      noise,
      reason: `gap ${sep.gap.toFixed(2)}: some negative answers above some positive ones, so no cutoff is both sound and complete`,
    };
  }
  if (sep.gap / range >= wide) {
    return {
      verdict: "wide-gap",
      separation: sep,
      noise,
      reason: `gap ${sep.gap.toFixed(2)} of ${range}: anything inside ${sep.maxNeg.toFixed(2)}..${sep.minPos.toFixed(2)} gives the same answers`,
    };
  }
  return {
    verdict: "fit",
    separation: sep,
    noise,
    reason: `gap ${sep.gap.toFixed(2)} of ${range}: narrow enough that where the cutoff sits changes the answers`,
  };
}

/** One cutoff per question, because one cutoff for all of them throws two of docs/22's eight away. */
export function fitPerQuestion(
  byQuestion: Record<string, readonly Sample[]>,
  placement: Placement,
): Record<string, Placed> {
  const out: Record<string, Placed> = {};
  for (const [name, samples] of Object.entries(byQuestion)) out[name] = place(samples, placement);
  return out;
}

export interface Logistic {
  a: number;
  b: number;
  iterations: number;
}

/**
 * One-feature logistic regression, by IRLS with a ridge term.
 *
 * This is here for the one job a cutoff cannot do: turn a score into a
 * probability, so a DECISION can weigh it against a cost. docs/23 needed
 * exactly this and did it with a constant ("anything under ten seconds runs
 * unconditionally") because there was no calibration to weigh against.
 *
 * The ridge is not optional at this sample size: with a clean separation the
 * unpenalised fit runs off to infinity.
 */
export function logisticFit(
  points: readonly { x: number; y: boolean }[],
  opts: { ridge?: number; iterations?: number } = {},
): Logistic {
  const ridge = opts.ridge ?? 1;
  const iterations = opts.iterations ?? 50;
  let a = 0;
  let b = 0;
  let used = 0;
  for (let it = 0; it < iterations; it += 1) {
    // Gradient and Hessian of the penalised log-likelihood.
    let g0 = -ridge * b;
    let g1 = -ridge * a;
    let h00 = ridge;
    let h01 = 0;
    let h11 = ridge;
    for (const { x, y } of points) {
      const p = 1 / (1 + Math.exp(-(a * x + b)));
      const r = (y ? 1 : 0) - p;
      g0 += r;
      g1 += r * x;
      const w = p * (1 - p);
      h00 += w;
      h01 += w * x;
      h11 += w * x * x;
    }
    const det = h00 * h11 - h01 * h01;
    if (Math.abs(det) < 1e-12) break;
    const db = (h11 * g0 - h01 * g1) / det;
    const da = (h00 * g1 - h01 * g0) / det;
    b += db;
    a += da;
    used = it + 1;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  return { a, b, iterations: used };
}

export function logisticP(model: Logistic, x: number): number {
  return 1 / (1 + Math.exp(-(model.a * x + model.b)));
}

/** The value at which the model reaches probability p: the cutoff a cost model asks for. */
export function logisticValueAt(model: Logistic, p: number): number {
  const clamped = Math.min(1 - 1e-9, Math.max(1e-9, p));
  if (model.a === 0) return Number.NaN;
  return (Math.log(clamped / (1 - clamped)) - model.b) / model.a;
}
