import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const CACHE = resolve(import.meta.dirname, "../.cache/rates.json");

/** The table this module is about. */
const TABLE = { usd: 1, eur: 0.92, jpy: 157 };

/**
 * Read the rates, preferring the cache when it is there.
 *
 * The cache was added to avoid recomputing on every call. Nothing invalidates
 * it, which is the bug a run can trip over.
 */
export function rates() {
  if (existsSync(CACHE)) return JSON.parse(readFileSync(CACHE, "utf8"));
  return TABLE;
}

export function convert(amount, to) {
  const r = rates()[to];
  if (r === undefined) throw new Error(`no rate for ${to}`);
  return Math.round(amount * r * 100) / 100;
}
