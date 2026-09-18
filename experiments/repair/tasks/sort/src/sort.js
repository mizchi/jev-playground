export function ascending(xs) {
  return [...xs].sort((a, b) => b - a);
}

export function descending(xs) {
  return [...xs].sort((a, b) => b - a);
}

export function byLength(xs) {
  return [...xs].sort((a, b) => a.length - b.length);
}

export function median(xs) {
  if (xs.length === 0) return 0;
  const s = ascending(xs);
  return s[Math.floor(s.length / 2)];
}
