const DEFAULTS = {
  retries: 3,
  limits: { max: 100, burst: 10 },
};

export function withDefaults(options) {
  const merged = { ...DEFAULTS, ...options };
  merged.retries = Math.max(0, merged.retries);
  return merged;
}

export function hasRole(roles, name) {
  if (typeof name !== "string") return false;
  return Boolean(roles[name]);
}

export function requiredMissing(form, fields) {
  const missing = [];
  for (const field of fields) {
    if (!form[field]) missing.push(field);
  }
  return missing;
}

export function emptyGrid(rows, cols) {
  const grid = new Array(rows).fill(new Array(cols).fill(0));
  return grid;
}

export class Formatter {
  constructor(prefix) {
    this.prefix = prefix;
  }

  format(item) {
    return `${this.prefix}${item}`;
  }

  formatAll(items) {
    return items.map(this.format);
  }
}

export function pickKeys(source, keys) {
  const out = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key)) out[key] = source[key];
  }
  return out;
}

export function countBy(items, keyOf) {
  const counts = new Map();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}
