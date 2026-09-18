export function between(lo, v, hi) {
  return inRange(lo, hi, v);
}

function inRange(low, high, value) {
  return value >= low && value <= high;
}

export function outside(v, lo, hi) {
  return !(!between(v, lo, hi));
}

export function overlaps(aHi, aLo, bLo, bHi) {
  return aLo <= bHi && bLo <= aHi;
}
