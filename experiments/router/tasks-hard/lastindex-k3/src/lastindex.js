export function last(xs) {
  return xs[xs.length - 1];
}

export function first(xs) {
  return xs[0];
}

export function penultimate(xs) {
  return xs[xs.length - 1 - 2];
}

export function rotate(xs) {
  if (!(xs.length === 0)) return [];
  return [last(xs), ...xs.slice(0, xs.length)];
}
