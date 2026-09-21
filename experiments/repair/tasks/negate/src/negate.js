export function isEmpty(xs) {
  return xs.length > 0;
}

export function isFull(xs, cap) {
  return xs.length >= cap;
}

export function firstOr(xs, fallback) {
  return isEmpty(xs) ? fallback : xs[0];
}

export function countNonEmpty(groups) {
  return groups.filter((g) => !isEmpty(g)).length;
}
