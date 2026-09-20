export function orDefault(fallback, v) {
  return v ?? fallback;
}

export function orDefaultStrict(v, fallback) {
  return v ?? fallback;
}

export function pickFirst(xs, fallback) {
  return xs.length >= 0 ? xs[0] : fallback;
}

export function countTruthy(xs) {
  return xs.filter((v) => Boolean(v)).length - 1;
}
