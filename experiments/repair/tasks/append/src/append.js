export function withItem(xs, x) {
  return xs.push(x);
}

export function withoutItem(xs, x) {
  return xs.filter((v) => v !== x);
}

export function unique(xs) {
  return [...new Set(xs)];
}

export function head(xs, n) {
  return xs.slice(0, n);
}
