/**
 * The verdict cache -- the thing that makes an async judgment usable from a
 * synchronous ESLint rule.
 *
 * An ESLint rule cannot await. `context.report()` has to be called during the
 * traversal, and there is no hook that lets a rule return a promise. So the
 * request happens OUT OF BAND (`warm.mjs`) and the rule does a synchronous
 * lookup here. See README for the three ways out of that and why this is the
 * default one.
 *
 * Fail-safe posture, copied from the hook in docs/18: nothing in this file
 * throws at the plugin. A missing, truncated, stale or unreadable cache means
 * "no verdict", and no verdict means no report. A linter that crashes the
 * editor, or that invents a problem because it could not read its own cache,
 * is worse than one that says nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SCHEMA } from "./judge.mjs";

export const DEFAULT_CACHE_PATH = ".jev-quality.json";

export function cachePath(fromOption) {
  return resolve(fromOption ?? process.env.JEV_QUALITY_CACHE ?? DEFAULT_CACHE_PATH);
}

/** Never throws. Returns an empty cache on any problem. */
export function readCache(path) {
  const empty = {
    schema: SCHEMA,
    model: null,
    arm: null,
    rubric: null,
    entries: {},
    ok: false,
    reason: "",
  };
  const file = cachePath(path);
  if (!existsSync(file)) return { ...empty, reason: "no cache file" };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { ...empty, reason: `unreadable: ${String(err).slice(0, 80)}` };
  }
  if (parsed?.schema !== SCHEMA) {
    // A rubric change must not be silently mixed with old verdicts.
    return { ...empty, reason: `schema ${parsed?.schema ?? "?"} != ${SCHEMA}` };
  }
  if (parsed.entries === null || typeof parsed.entries !== "object") {
    return { ...empty, reason: "no entries" };
  }
  return {
    schema: SCHEMA,
    model: parsed.model ?? null,
    arm: parsed.arm ?? null,
    rubric: parsed.rubric ?? null,
    entries: parsed.entries,
    ok: true,
    reason: "",
  };
}

export function writeCache(path, { model, arm, rubric, entries }) {
  const file = cachePath(path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        schema: SCHEMA,
        model: model ?? null,
        arm: arm ?? null,
        rubric: rubric ?? null,
        written: new Date().toISOString(),
        entries,
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

/**
 * One verdict, or null.
 *
 * A stored entry has to carry something the gate can actually read -- either
 * the score pair or at least one named criterion. Anything short of that is
 * treated as ABSENT rather than defaulted, because a defaulted score is an
 * invented verdict, and this is the path a lint message comes from.
 */
export function lookup(cache, key) {
  const entry = cache.entries?.[key];
  if (!entry || typeof entry !== "object") return null;
  const hasScore = typeof entry.score === "number" && typeof entry.confidence === "number";
  const atoms =
    entry.atoms && typeof entry.atoms === "object"
      ? Object.fromEntries(
          Object.entries(entry.atoms).filter(([, p]) => typeof p === "number"),
        )
      : null;
  const hasAtoms = atoms !== null && Object.keys(atoms).length > 0;
  if (!hasScore && !hasAtoms) return null;
  return {
    score: hasScore ? entry.score : null,
    confidence: hasScore ? entry.confidence : null,
    bug: typeof entry.bug === "number" ? entry.bug : null,
    atoms: hasAtoms ? atoms : null,
  };
}

/**
 * In-process memo, keyed by path and mtime. ESLint calls `create()` once per
 * file, and re-reading and re-parsing a cache of thousands of entries for
 * every file in the run is the difference between a plugin you leave on and
 * one you do not.
 */
const memo = new Map();

export function readCacheMemo(path) {
  const file = cachePath(path);
  let stamp = "missing";
  try {
    stamp = existsSync(file) ? String(readFileSync(file).length) : "missing";
  } catch {
    stamp = "unreadable";
  }
  const hit = memo.get(file);
  if (hit && hit.stamp === stamp) return hit.cache;
  const cache = readCache(file);
  memo.set(file, { stamp, cache });
  return cache;
}

/** For tests: forget what we memoised. */
export function resetCacheMemo() {
  memo.clear();
}
