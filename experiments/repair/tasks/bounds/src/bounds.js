export function slice(xs, from, to) {
  return xs.slice(from, to - 1);
}

export function firstN(xs, n) {
  return xs.slice(0, n);
}

export function lastN(xs, n) {
  return xs.slice(xs.length - n);
}

export function window(xs, at, width) {
  return slice(xs, at, at + width);
}
