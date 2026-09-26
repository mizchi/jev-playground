/** Small, dependency-free statistics: every number in docs/66 comes through here. */

/** Mann-Whitney AUC: P(score of a positive > score of a negative), ties half. */
export function auc(pos: number[], neg: number[]): number {
  if (!pos.length || !neg.length) return NaN;
  let s = 0;
  for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0;
  return s / (pos.length * neg.length);
}

/** Macro-F1 over the two classes, predicting positive when score >= t. */
export function macroF1(y: number[], score: number[], t = 0.5): number {
  const f1 = (cls: number) => {
    let tp = 0, fp = 0, fn = 0;
    for (let i = 0; i < y.length; i++) {
      const pred = score[i] >= t ? 1 : 0;
      if (pred === cls && y[i] === cls) tp++;
      else if (pred === cls) fp++;
      else if (y[i] === cls) fn++;
    }
    return tp === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn);
  };
  return (f1(0) + f1(1)) / 2;
}

export const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
export const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
};

/** Cohen's d with the release's convention: RMS of the two group SDs (Table F2 note). */
export function cohenD(a: number[], b: number[]): number {
  return (mean(a) - mean(b)) / Math.sqrt((sd(a) ** 2 + sd(b) ** 2) / 2);
}

/** Deterministic PRNG so every bootstrap interval reproduces exactly. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 95% interval of `stat` over resamples of whole groups (company domains),
 * the release's primary CI basis: posts from one company resemble each other.
 */
export function clusterCI<T>(
  items: T[],
  group: (t: T) => string,
  stat: (sample: T[]) => number,
  B = 2000,
  seed = 66,
): [number, number] {
  const groups = new Map<string, T[]>();
  for (const it of items) groups.set(group(it), [...(groups.get(group(it)) ?? []), it]);
  const keys = [...groups.keys()].sort();
  const r = rng(seed);
  const vals: number[] = [];
  for (let b = 0; b < B; b++) {
    const sample: T[] = [];
    for (let i = 0; i < keys.length; i++) sample.push(...groups.get(keys[Math.floor(r() * keys.length)])!);
    const v = stat(sample);
    if (Number.isFinite(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * vals.length)], vals[Math.floor(0.975 * vals.length)]];
}

/**
 * L2-regularized logistic regression on standardized columns, full-batch
 * gradient descent from zero: deterministic, no library, and small enough to
 * read. Columns constant in the training rows are dropped (scale 0).
 */
export function fitLogistic(X: number[][], y: number[], lambda = 1, iters = 600, lr = 0.1) {
  const d = X[0].length;
  const mu = Array.from({ length: d }, (_, j) => mean(X.map((r) => r[j])));
  const sc = Array.from({ length: d }, (_, j) => sd(X.map((r) => r[j])));
  const Z = X.map((r) => r.map((v, j) => (sc[j] > 1e-9 ? (v - mu[j]) / sc[j] : 0)));
  const w = new Array(d).fill(0);
  let b = 0;
  const n = Z.length;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * Z[i][j];
      const e = 1 / (1 + Math.exp(-z)) - y[i];
      gb += e;
      for (let j = 0; j < d; j++) gw[j] += e * Z[i][j];
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + (lambda * w[j]) / n);
    b -= lr * (gb / n);
  }
  return (x: number[]) => {
    let z = b;
    for (let j = 0; j < d; j++) if (sc[j] > 1e-9) z += w[j] * ((x[j] - mu[j]) / sc[j]);
    return 1 / (1 + Math.exp(-z));
  };
}

/** Pooled Cohen's kappa over paired categorical labels. */
export function kappa(a: string[], b: string[]): number {
  const n = a.length;
  const cats = [...new Set([...a, ...b])];
  const po = a.filter((x, i) => x === b[i]).length / n;
  const pe = cats.reduce((s, c) => s + (a.filter((x) => x === c).length / n) * (b.filter((x) => x === c).length / n), 0);
  return (po - pe) / (1 - pe);
}
