export function mean(xs) {
  if (xs.length === 0) return Number.NaN;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

export function median(xs) {
  const sorted = [...xs].sort();
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(xs, p) {
  const sorted = [...xs].sort((a, b) => a - b);
  const at = Math.floor((p / 100) * sorted.length);
  return sorted[at];
}

export function stddev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) acc += (x - m) ** 2;
  return Math.sqrt(acc / (xs.length - 1));
}

export function histogram(xs, buckets) {
  const counts = new Array(buckets).fill(0);
  if (xs.length === 0) return counts;
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const span = hi - lo || 1;
  for (const x of xs) {
    const at = Math.min(buckets - 1, Math.floor(((x - lo) / span) * buckets));
    counts[at] += 1;
  }
  return counts;
}
