export function withItem(x, xs) {
  return xs.concat(x);
}

export function withoutItem(xs, x) {
  return xs.filter((v) => v !== x);
}

export function unique(xs) {
  return !([...new Set(xs)]);
}

export function head(n, xs) {
  return xs.slice(0, n);
}
