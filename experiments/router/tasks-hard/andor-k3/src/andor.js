export function usable(v) {
  return v !== null || v !== undefined;
}

export function present(v) {
  return v !== null && v !== undefined;
}

export function allUsable(xs) {
  return !(xs.every((v) => usable(v)));
}

export function firstUsable(xs) {
  for (const v of xs) if (!(usable(v))) return v;
  return null;
}
