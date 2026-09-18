/**
 * Scoring.
 *
 * The headline number is easy to fake here: the set is 12 bugs against 39
 * clean-or-nearmiss functions, so a plugin that reports nothing scores 76.5%.
 * Every accuracy therefore comes with the always-negative baseline next to
 * it, and the write-up leads with balanced accuracy and AUC.
 */

/** pairs: [{ value, truth }] where truth = "should be reported". */
export function confuse(pairs, threshold) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const { value, truth } of pairs) {
    const predicted = value >= threshold;
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
    specificity,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    majority: n === 0 ? 0 : Math.max(pos, neg) / n,
  };
}

/** Confusion for a boolean predictor (the plugin's own gate, thresholds and all). */
export function confuseBool(pairs) {
  return confuse(
    pairs.map(({ predicted, truth }) => ({ value: predicted ? 1 : 0, truth })),
    1,
  );
}

/** Mann-Whitney AUC: does the number ORDER the two classes at all? */
export function auc(pairs) {
  const pos = pairs.filter((x) => x.truth).map((x) => x.value);
  const neg = pairs.filter((x) => !x.truth).map((x) => x.value);
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

/** Best balanced accuracy over a threshold sweep, and where it sits. */
export function sweep(pairs, lo, hi, step) {
  let best = { threshold: lo, balanced: -1, accuracy: 0 };
  for (let t = lo; t <= hi + 1e-9; t += step) {
    const c = confuse(pairs, t);
    if (c.balanced > best.balanced) {
      best = { threshold: Number(t.toFixed(2)), balanced: c.balanced, accuracy: c.accuracy };
    }
  }
  return best;
}

export function mean(xs) {
  return xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function sd(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export function pct(x) {
  return `${(100 * x).toFixed(1)}%`;
}

/** Spearman rank correlation, for comparing two arms' orderings. */
export function spearman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) return Number.NaN;
  const rank = (values) => {
    const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(values.length);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
      const r = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) out[order[k][1]] = r;
      i = j + 1;
    }
    return out;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i += 1) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx === 0 || dy === 0 ? Number.NaN : num / Math.sqrt(dx * dy);
}
