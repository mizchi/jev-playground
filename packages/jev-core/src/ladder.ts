/**
 * Turning one continuous `score` into one rung of an ordered ladder.
 *
 * This is the piece the model router needs and that docs/25's components do
 * not cover. docs/25 fits ONE cutoff for a two-class decision; a tier ladder
 * needs k-1 cutoffs, and the two ways of being wrong are not symmetric:
 *
 *   under-route  the chosen tier cannot do the task. The task fails, and the
 *                money spent failing is spent anyway.
 *   over-route   the chosen tier can do the task but a cheaper one could too.
 *                The cost is the price difference, and nothing breaks.
 *
 * So the cutoffs are not placed mid-gap (docs/25's usual advice) -- mid-gap
 * assumes the two errors cost the same. They are placed where expected cost is
 * lowest, with the penalty for a failed task as an explicit parameter. Naming
 * that penalty is the caller's job, not this function's: it is the one number
 * that says how much a wasted turn is worth relative to a wasted dollar.
 *
 * `score` answers are CONTINUOUS. A four-level rubric returns 1.34, not 1
 * (docs/34 §1.2 lost a table to assuming otherwise), which is exactly why
 * cutoffs between rungs are a real question rather than a rounding rule.
 */

export interface Rung {
  /** The tier's name, as the caller's config spells it. */
  name: string;
  /** Relative price. Any consistent unit; only ratios matter. */
  price: number;
}

export interface LadderSample {
  /** The `score` answer for this task. */
  score: number;
  /**
   * The index of the cheapest rung that actually worked, measured rather than
   * judged. `null` when no rung worked -- those samples cannot punish a
   * cutoff, because no choice would have been right.
   */
  cheapest: number | null;
  /** Repeated draws of one task share a group, so folds cut along tasks. */
  group?: string;
}

/** Which rung a score lands on. `cuts` must be ascending, length rungs-1. */
export function rungFor(score: number, cuts: readonly number[]): number {
  let i = 0;
  while (i < cuts.length && score >= cuts[i]) i += 1;
  return i;
}

export interface CostModel {
  /**
   * What a failed task costs, in the same units as `Rung.price`.
   *
   * There is no default. A code-review router and a production-deploy router
   * disagree about this by orders of magnitude, and a default would hide the
   * disagreement inside a library.
   */
  failurePenalty: number;
}

/** The cost of sending a task needing `cheapest` to `chosen`. */
export function costOf(chosen: number, sample: LadderSample, rungs: readonly Rung[], cost: CostModel): number {
  if (sample.cheapest === null) return rungs[chosen].price;
  if (chosen < sample.cheapest) return rungs[chosen].price + cost.failurePenalty;
  return rungs[chosen].price;
}

export function expectedCost(
  cuts: readonly number[],
  samples: readonly LadderSample[],
  rungs: readonly Rung[],
  cost: CostModel,
): number {
  if (samples.length === 0) return Number.NaN;
  let total = 0;
  for (const s of samples) total += costOf(rungFor(s.score, cuts), s, rungs, cost);
  return total / samples.length;
}

export interface FittedLadder {
  cuts: number[];
  /** Mean cost per task on the samples the cuts were fitted to. */
  cost: number;
  /** False when the samples cannot support a fit at all. */
  fitted: boolean;
  why: string;
}

/**
 * The cutoffs with the lowest expected cost, by exhaustive search over the
 * observed scores.
 *
 * Exhaustive rather than clever: the candidate cutoffs are the midpoints
 * between adjacent observed scores, so for n tasks and k rungs the search is
 * over at most n^(k-1) combinations, and k is two or three. A gradient method
 * would be faster and would also make the objective's steps invisible -- this
 * objective is piecewise constant, so there is no gradient to follow.
 */
export function fitLadder(
  samples: readonly LadderSample[],
  rungs: readonly Rung[],
  cost: CostModel,
): FittedLadder {
  const k = rungs.length;
  if (k < 2) return { cuts: [], cost: Number.NaN, fitted: false, why: "a ladder needs at least two rungs" };
  const usable = samples.filter((s) => Number.isFinite(s.score));
  if (usable.length === 0) return { cuts: [], cost: Number.NaN, fitted: false, why: "no finite scores" };
  const sorted = [...new Set(usable.map((s) => s.score))].sort((a, b) => a - b);
  const candidates: number[] = [sorted[0] - 0.5];
  for (let i = 1; i < sorted.length; i += 1) candidates.push((sorted[i - 1] + sorted[i]) / 2);
  candidates.push(sorted[sorted.length - 1] + 0.5);

  let best: number[] | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  const walk = (prefix: number[], from: number): void => {
    if (prefix.length === k - 1) {
      const c = expectedCost(prefix, usable, rungs, cost);
      if (c < bestCost) {
        bestCost = c;
        best = [...prefix];
      }
      return;
    }
    for (let i = from; i < candidates.length; i += 1) walk([...prefix, candidates[i]], i);
  };
  walk([], 0);
  if (!best) return { cuts: [], cost: Number.NaN, fitted: false, why: "no cutoff combination evaluated" };
  return {
    cuts: best,
    cost: bestCost,
    fitted: true,
    why: `lowest expected cost over ${candidates.length} candidate cutoffs, penalty ${cost.failurePenalty}`,
  };
}

/**
 * Fit on one part of the samples, score on the other, cut along groups.
 *
 * Here because docs/22 reported an in-sample number and docs/25 had to go back
 * and show it was 24/36 fitted and 18/36 held out. A ladder has more freedom
 * than a single cutoff, so it overfits more easily, not less.
 */
export function crossValidateLadder(
  samples: readonly LadderSample[],
  rungs: readonly Rung[],
  cost: CostModel,
  folds = 5,
  seed = 1,
): { heldOutCost: number; inSampleCost: number; folds: number; perFold: { cost: number; n: number }[] } {
  const groups = [...new Set(samples.map((s) => s.group ?? JSON.stringify(s)))];
  // A deterministic shuffle, so a reported number can be reproduced.
  let state = seed >>> 0 || 1;
  const rand = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
  const shuffled = [...groups].sort(() => rand() - 0.5);
  const buckets: string[][] = Array.from({ length: folds }, () => []);
  for (const [i, g] of shuffled.entries()) buckets[i % folds].push(g);

  const perFold: { cost: number; n: number }[] = [];
  let weighted = 0;
  let counted = 0;
  for (const held of buckets) {
    if (held.length === 0) continue;
    const isHeld = (s: LadderSample): boolean => held.includes(s.group ?? JSON.stringify(s));
    const train = samples.filter((s) => !isHeld(s));
    const test = samples.filter(isHeld);
    if (train.length === 0 || test.length === 0) continue;
    const fit = fitLadder(train, rungs, cost);
    if (!fit.fitted) continue;
    const c = expectedCost(fit.cuts, test, rungs, cost);
    perFold.push({ cost: c, n: test.length });
    weighted += c * test.length;
    counted += test.length;
  }
  const whole = fitLadder(samples, rungs, cost);
  return {
    heldOutCost: counted === 0 ? Number.NaN : weighted / counted,
    inSampleCost: whole.fitted ? whole.cost : Number.NaN,
    folds: perFold.length,
    perFold,
  };
}

/** Always this rung, whatever the score: the baseline a fit has to beat. */
export function fixedRungCost(
  rung: number,
  samples: readonly LadderSample[],
  rungs: readonly Rung[],
  cost: CostModel,
): number {
  if (samples.length === 0) return Number.NaN;
  let total = 0;
  for (const s of samples) total += costOf(rung, s, rungs, cost);
  return total / samples.length;
}
