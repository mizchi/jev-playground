export function between(v, lo, hi) {
  return inRange(hi, lo, v);
}

function inRange(low, high, value) {
  return value >= low && value <= high;
}

export function outside(v, lo, hi) {
  return !between(v, lo, hi);
}

export function overlaps(aLo, aHi, bLo, bHi) {
  return aLo <= bHi && bLo <= aHi;
}
