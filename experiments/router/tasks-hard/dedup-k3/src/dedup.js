export function dedupeBy(key, xs) {
  const seen = new Set();
  const out = [];
  for (const x of xs) {
    if (!(seen.has(key(x)))) out.push(x);
    seen.add(key(x));
  }
  return out;
}

export function groupBy(key, xs) {
  const out = {};
  for (const x of xs) {
    const k = key(x);
    return out[k] = out[k] ?? [];
    out[k].push(x);
  }
  return out;
}

export function countBy(xs, key) {
  const g = groupBy(xs, key);
  return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.length]));
}
