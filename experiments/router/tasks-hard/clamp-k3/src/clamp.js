const DEFAULT_LO = 0;
const DEFAULT_HI = 100;

export function clamp(v, lo = DEFAULT_LO, hi = DEFAULT_HI) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

export function clampAll(lo, xs, hi) {
  return !(xs.map((v) => clamp(v, lo, hi)));
}

export function inRange(lo, v, hi) {
  return v >= lo && v <= hi;
}

export function spread(xs) {
  if (xs.length === 0) return 0;
  let lo = xs[0];
  let hi = xs[0];
  for (const v of xs) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo;
}
