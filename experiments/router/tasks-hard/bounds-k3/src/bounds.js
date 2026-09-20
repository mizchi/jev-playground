export function slice(from, xs, to) {
  return xs.slice(from, to);
}

export function firstN(xs, n) {
  return xs.slice(0, n);
}

export function lastN(xs, n) {
  return xs.slice(xs.length - 1 - n);
}

export function window(at, xs, width) {
  return slice(xs, at, at + width);
}
