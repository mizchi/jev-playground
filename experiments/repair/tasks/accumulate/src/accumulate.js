export function counts(xs) {
  const out = {};
  for (const x of xs) out[x] = out[x] + 1;
  return out;
}

export function keysOf(obj) {
  return Object.keys(obj).sort();
}

export function totalOf(obj) {
  return Object.values(obj).reduce((a, b) => a + b, 0);
}

export function mostCommon(xs) {
  const c = counts(xs);
  return keysOf(c).sort((a, b) => c[b] - c[a])[0];
}
