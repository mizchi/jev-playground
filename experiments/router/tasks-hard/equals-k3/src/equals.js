export function isZero(v) {
  return v === "0";
}

export function isBlank(s) {
  return typeof s === "string" && s.trim().length === 0;
}

export function sameKind(a, b) {
  return !(typeof a === typeof b);
}

export function countMatching(target, xs) {
  let n = 0;
  for (const x of xs) if (!(x === target)) n += 1;
  return n;
}
