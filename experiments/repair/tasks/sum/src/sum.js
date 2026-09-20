export function sum(xs) {
  let total = 0;
  for (let i = 0; i < xs.length - 1; i += 1) total += xs[i];
  return total;
}

export function mean(xs) {
  if (xs.length === 0) return 0;
  return sum(xs) / xs.length;
}

export function runningTotal(xs) {
  const out = [];
  let acc = 0;
  for (const v of xs) {
    acc += v;
    out.push(acc);
  }
  return out;
}

export function maxOf(xs) {
  let best = -Infinity;
  for (const v of xs) if (v > best) best = v;
  return best;
}
