/**
 * How to score a selection.
 *
 * A selector produces a number per skill; the catalog says which ones the
 * proposal should hold. Two different things can be measured and they do not
 * agree, which is the point:
 *
 *   RANKING   ignore the absolute number, ask whether the wanted skills come
 *             first. Average precision, and precision at the size of the
 *             correct answer. A selector that ranks perfectly is usable with
 *             a per-project "take the top k".
 *   CUTOFF    use the absolute number, ask whether ONE threshold works across
 *             every project. That is what a tool has to do when it does not
 *             know k -- and docs/25's machinery is what decides whether such
 *             a threshold exists.
 *
 * Ties are the trap. The rules baseline gives dozens of skills a score of
 * exactly 0, and a ranking that puts the positives first WITHIN a tie is a
 * measurement of the sort order, not of the selector. Every function here
 * resolves a tie by its worst case.
 */
export interface Scored {
  skill: string;
  value: number;
  positive: boolean;
}

/** Sort descending, and inside a tie put the negatives first. */
function pessimistic(rows: readonly Scored[]): Scored[] {
  return [...rows].sort((a, b) => b.value - a.value || Number(a.positive) - Number(b.positive));
}

/**
 * Average precision: the mean of the precision at each positive's position.
 *
 * Equal to 1 only when every positive outranks every negative. Reported per
 * project and then averaged, because a project with many positives should not
 * dominate one with two.
 */
export function averagePrecision(rows: readonly Scored[]): number {
  const sorted = pessimistic(rows);
  let found = 0;
  let sum = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    if (!sorted[i].positive) continue;
    found += 1;
    sum += found / (i + 1);
  }
  return found === 0 ? Number.NaN : sum / found;
}

/** Precision at k, with k the number of positives: the "take the top k" score. */
export function precisionAtK(rows: readonly Scored[], k?: number): number {
  const positives = rows.filter((r) => r.positive).length;
  const cut = k ?? positives;
  if (cut === 0) return Number.NaN;
  const sorted = pessimistic(rows).slice(0, cut);
  return sorted.filter((r) => r.positive).length / cut;
}

/** How many of the positives are in the top k. Same number when k = |P|. */
export function recallAtK(rows: readonly Scored[], k: number): number {
  const positives = rows.filter((r) => r.positive).length;
  if (positives === 0) return Number.NaN;
  return pessimistic(rows).slice(0, k).filter((r) => r.positive).length / positives;
}

/**
 * The rank of the worst-placed positive, 1-based.
 *
 * This is the number a user feels: to see every skill the catalog wants, how
 * far down the list must they read? A mean average precision of 0.8 sounds
 * fine until this says 61 out of 75.
 */
export function worstPositiveRank(rows: readonly Scored[]): number {
  const sorted = pessimistic(rows);
  for (let i = sorted.length - 1; i >= 0; i -= 1) if (sorted[i].positive) return i + 1;
  return Number.NaN;
}

export function meanOf(xs: readonly number[]): number {
  const real = xs.filter((x) => Number.isFinite(x));
  return real.length === 0 ? Number.NaN : real.reduce((a, b) => a + b, 0) / real.length;
}
