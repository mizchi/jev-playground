/**
 * Scoring. Kept separate because the headline number here is easy to fake:
 * the full (snippet x rule) matrix is only 3.7% violations, so "always pass"
 * scores 96.3%. Every accuracy is therefore reported next to a baseline, and
 * the balanced subsets are the ones the write-up leads with.
 */
export interface Pair {
  /** p(violation) from Jev. */
  p: number;
  /** ESLint's verdict. */
  truth: boolean;
}

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  n: number;
  accuracy: number;
  /** Mean of per-class recall — the honest number on an imbalanced set. */
  balanced: number;
  precision: number;
  recall: number;
  f1: number;
  /** Accuracy of always answering the majority class. */
  majority: number;
}

export function confuse(pairs: Pair[], threshold: number): Confusion {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const { p, truth } of pairs) {
    const predicted = p >= threshold;
    if (predicted && truth) tp += 1;
    else if (predicted && !truth) fp += 1;
    else if (!predicted && truth) fn += 1;
    else tn += 1;
  }
  const n = pairs.length;
  const pos = tp + fn;
  const neg = fp + tn;
  const recall = pos === 0 ? 0 : tp / pos;
  const specificity = neg === 0 ? 0 : tn / neg;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  return {
    tp,
    fp,
    fn,
    tn,
    n,
    accuracy: n === 0 ? 0 : (tp + tn) / n,
    balanced: (recall + specificity) / 2,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    majority: n === 0 ? 0 : Math.max(pos, neg) / n,
  };
}

/** Mann-Whitney AUC: does the probability ORDER the two classes at all? */
export function auc(pairs: Pair[]): number {
  const pos = pairs.filter((x) => x.truth).map((x) => x.p);
  const neg = pairs.filter((x) => !x.truth).map((x) => x.p);
  if (pos.length === 0 || neg.length === 0) return Number.NaN;
  let wins = 0;
  for (const a of pos) {
    for (const b of neg) {
      if (a > b) wins += 1;
      else if (a === b) wins += 0.5;
    }
  }
  return wins / (pos.length * neg.length);
}

/** Best accuracy over a threshold sweep, and where it sits. */
export function sweep(pairs: Pair[]): { threshold: number; accuracy: number } {
  let best = { threshold: 0.5, accuracy: -1 };
  for (let t = 0.05; t <= 0.96; t += 0.05) {
    const a = confuse(pairs, t).accuracy;
    if (a > best.accuracy) best = { threshold: Number(t.toFixed(2)), accuracy: a };
  }
  return best;
}

export function mean(xs: number[]): number {
  return xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function pct(x: number): string {
  return `${(100 * x).toFixed(1)}%`;
}

/** Run a list of jobs with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
