/**
 * The labels -- and, wherever it is possible, a PROBE that proves the label
 * by running the code instead of asserting it.
 *
 * This is the weak joint of the whole experiment and it deserves saying
 * plainly. In docs/16 the oracle was the real ESLint, so the labels were not
 * ours. "Code quality" has no such oracle: someone has to say what is wrong
 * with a function. So the labels here are pushed as close to fact as they go:
 *
 * - `basis: "test"` -- a probe runs the function and shows the behaviour. For
 *   a `bug` the probe FAILS on the corpus code; for everything else it
 *   passes. `truth.mjs` checks both directions and spends no API call, so a
 *   label that is merely an opinion cannot hide in the set.
 * - `basis: "review"` -- no probe. These are opinions. Two kinds: the `smell`
 *   labels, where the claim is about maintainability and a reviewer could
 *   disagree, and the `clean` labels, which cannot be probed at all because
 *   you cannot execute the absence of a defect. The write-up reports `smell`
 *   separately for that reason, and treats `clean` as the negative class only
 *   alongside `nearmiss`, which IS probed.
 *
 * `label`, `basis` and `note` are NEVER sent to Jev. `run.mjs` asserts it on
 * every request body, the same way docs/16 asserted the rule implementations
 * never leaked.
 */
import * as access from "./corpus/access.js";
import { Formatter } from "./corpus/access.js";
import * as auth from "./corpus/auth.js";
import * as cart from "./corpus/cart.js";
import * as counters from "./corpus/counters.js";
import * as dates from "./corpus/dates.js";
import { EventBus } from "./corpus/events.js";
import * as fsutil from "./corpus/fsutil.js";
import * as http from "./corpus/http.js";
import * as pool from "./corpus/pool.js";
import * as ranges from "./corpus/ranges.js";
import { LruCache } from "./corpus/lru.js";
import * as report from "./corpus/report.js";
import * as retry from "./corpus/retry.js";
import * as slug from "./corpus/slug.js";
import * as stats from "./corpus/stats.js";

/**
 * `bug`      -- misbehaves for an input it will realistically receive.
 * `smell`    -- works; a reviewer would still want it changed.
 * `nearmiss` -- looks alarming and is correct. The class that decides whether
 *               anyone leaves the plugin switched on.
 * `clean`    -- nothing to say.
 */
export const CLASSES = ["bug", "smell", "nearmiss", "clean"];

const L = (label, basis, note, probe, covers = null, tier = null) => ({
  label,
  basis,
  note,
  probe,
  covers,
  tier,
});
const clean = (note) => L("clean", "review", note, null);

/**
 * Two axes on every bug, because docs/22's first held-out set conflated them.
 *
 * `covers` -- which of the eight named criteria in judge.mjs is SUPPOSED to
 * catch this bug, or `"unnamed"` when the class is deliberately absent from
 * that list. That is the axis docs/01 section 4 is about.
 *
 * `tier` -- how the defect is SEEN, which turned out to matter more:
 *
 *   "easy"  the function's own text contradicts itself. A careful reader needs
 *           no outside knowledge: no `return`, no `break`, no `try/finally`,
 *           a discount subtracted as an amount.
 *   "hard"  you have to know how one specific thing behaves. `.sort()` has no
 *           default comparator, `splice(at)` takes a count, spread is
 *           shallow, `{}` inherits `toString`, `fill` stores one reference,
 *           a returned promise escapes its `try`.
 *
 * docs/22's held-out five were ALL `unnamed` + `easy`, so they measured
 * nothing about the hole: the generic question caught 15/15 of them because
 * they were easy, not because they were covered. `access.js` adds five that
 * are `unnamed` + `hard`, which is the cell that was empty.
 */

export const LABELS = {
  // ------------------------------------------------------------------ auth
  "auth.js#compareTokens": L(
    "bug",
    "test",
    "Two empty tokens compare equal, so a request with no token authenticates against a session with no token.",
    () => auth.compareTokens("", "") === false,
    "name_mismatch",
    "easy",
  ),
  "auth.js#isExpired": clean("A timestamp comparison, and both sides are ms."),
  "auth.js#parseBearer": clean("Guards the type, the prefix and the empty tail."),
  "auth.js#scopesAllow": clean("Set membership; nothing subtle."),

  // ------------------------------------------------------------------ cart
  "cart.js#subtotal": clean("A reduce over price*qty."),
  "cart.js#applyDiscount": L(
    "bug",
    "test",
    "Subtracts the percentage as if it were an amount: 10% off 1000 yen returns 990.",
    () => cart.applyDiscount(1000, 10) === 900,
    "unit_or_arithmetic",
    "easy",
  ),
  "cart.js#roundMoney": L(
    "smell",
    "review",
    "Rounds by going through a string and multiplying it back. It is correct for money-sized numbers; nobody should write it.",
    () => cart.roundMoney(3.14159) === 3.14,
  ),
  "cart.js#formatYen": L(
    "nearmiss",
    "test",
    "Hand-rolled thousands separators look like the classic off-by-one, and are exact here.",
    () =>
      cart.formatYen(1234567) === "¥1,234,567" &&
      cart.formatYen(0) === "¥0" &&
      cart.formatYen(-1234) === "-¥1,234" &&
      cart.formatYen(null) === "-",
  ),
  "cart.js#cheapestLine": clean("Linear minimum with a null seed."),

  // -------------------------------------------------------------- counters
  "counters.js#readRow": clean("An awaited read of one key."),
  "counters.js#writeRow": clean("An awaited write of one key."),
  "counters.js#increment": L(
    "bug",
    "test",
    "Read-modify-write across an await. Concurrent increments of the same key read the same value and one write wins.",
    async () => {
      counters.reset();
      await counters.incrementAll(["a", "a", "a"]);
      return counters.snapshot().a === 3;
    },
    "lost_update",
    "hard",
  ),
  "counters.js#incrementAll": L(
    "smell",
    "review",
    "Fans out concurrent increments over a list that may repeat a key, and returns keys.length as if every one landed. Opinion, not a defect.",
    null,
  ),
  "counters.js#reset": clean("Clears the map."),
  "counters.js#snapshot": clean("Copies the map into an object."),

  // ----------------------------------------------------------------- dates
  "dates.js#isWeekend": clean("Two day-number comparisons."),
  "dates.js#addMonths": L(
    "bug",
    "test",
    "setUTCMonth overflows: 31 January plus one month lands in March.",
    () => dates.addMonths(new Date("2026-01-31T00:00:00Z"), 1).getUTCMonth() === 1,
    "api_default",
    "hard",
  ),
  "dates.js#startOfDayUtc": L(
    "nearmiss",
    "test",
    "Copies before mutating and zeroes all four fields; the shape invites a mutation bug that is not there.",
    () => {
      const input = new Date("2026-03-05T13:45:12.500Z");
      const out = dates.startOfDayUtc(input);
      return (
        out.toISOString() === "2026-03-05T00:00:00.000Z" &&
        input.toISOString() === "2026-03-05T13:45:12.500Z"
      );
    },
  ),
  "dates.js#formatDuration": L(
    "nearmiss",
    "test",
    "A chain of integer divisions and moduli: the shape reviewers always suspect, and it is exact.",
    () =>
      dates.formatDuration(0) === "00:00" &&
      dates.formatDuration(59_999) === "00:59" &&
      dates.formatDuration(3_600_000) === "1:00:00" &&
      dates.formatDuration(3_661_000) === "1:01:01",
  ),
  "dates.js#withinWindow": clean("Inclusive range over getTime()."),

  // ---------------------------------------------------------------- events
  "events.js#EventBus#constructor": clean("Assigns one map."),
  "events.js#EventBus#on": clean("Appends and returns an unsubscribe."),
  "events.js#EventBus#off": L(
    "bug",
    "test",
    "splice(at) with no delete count removes the listener AND everything after it.",
    () => {
      const bus = new EventBus();
      const seen = [];
      const a = () => seen.push("a");
      bus.on("x", a);
      bus.on("x", () => seen.push("b"));
      bus.on("x", () => seen.push("c"));
      bus.off("x", a);
      bus.emit("x");
      return seen.join(",") === "b,c";
    },
    "api_default",
    "hard",
  ),
  "events.js#EventBus#emit": L(
    "nearmiss",
    "test",
    "The [...fns] copy looks redundant and is what stops a listener registered during emit from being called in the same round.",
    () => {
      const bus = new EventBus();
      let late = 0;
      bus.on("x", () => {
        bus.on("x", () => {
          late += 1;
        });
      });
      bus.emit("x");
      return late === 0;
    },
  ),
  "events.js#EventBus#clear": clean("Clears one event or all of them."),

  // ---------------------------------------------------------------- fsutil
  "fsutil.js#readJsonOrDefault": L(
    "nearmiss",
    "test",
    "A bare `catch {}` -- and the name says OrDefault, so swallowing is the contract.",
    () => fsutil.readJsonOrDefault("/nonexistent/nope.json", { fallback: true }).fallback === true,
  ),
  "fsutil.js#writeJsonAtomic": L(
    "smell",
    "review",
    "The temp file name is fixed, so two concurrent writers of the same path fight over it. Correct single-threaded.",
    null,
  ),
  "fsutil.js#loadConfig": L(
    "smell",
    "review",
    "Copies every key from the file over the defaults, so a misspelled key lands silently as a new field.",
    null,
  ),
  "fsutil.js#saveAll": L(
    "bug",
    "test",
    "Swallows every write failure, so a run where nothing was written is indistinguishable from success.",
    () => {
      try {
        fsutil.saveAll("/nonexistent/dir", { "a.txt": "a" });
        return false;
      } catch {
        return true;
      }
    },
    "swallows_failure",
    "easy",
  ),

  // ------------------------------------------------------------------ http
  "http.js#statusText": L(
    "nearmiss",
    "test",
    "66 lines of switch. Long, repetitive, and entirely right -- the volume-is-not-a-defect case.",
    () =>
      http.statusText(200) === "OK" &&
      http.statusText(429) === "Too Many Requests" &&
      http.statusText(599) === "Unknown",
  ),
  "http.js#normalizeHeaders": clean("Lowercases names, joins array values."),
  "http.js#isRetryable": clean("Two comparisons."),
  "http.js#buildQuery": L(
    "bug",
    "test",
    "No percent-encoding, so a value containing & or = silently becomes extra query parameters.",
    () => {
      const q = http.buildQuery({ q: "a&b=c" });
      return new URLSearchParams(q.slice(1)).get("q") === "a&b=c";
    },
    "unescaped_composition",
    "easy",
  ),

  // ------------------------------------------------------------------- lru
  "lru.js#LruCache#constructor": clean("Assigns the bound and the map."),
  "lru.js#LruCache#get": L(
    "bug",
    "test",
    "Does not refresh recency, so the eviction order is insertion order: this is an FIFO cache wearing an LRU's name.",
    () => {
      const cache = new LruCache(2);
      cache.set("a", 1);
      cache.set("b", 2);
      cache.get("a");
      cache.set("c", 3);
      return cache.has("a") && !cache.has("b");
    },
    "name_mismatch",
    "hard",
  ),
  "lru.js#LruCache#set": clean("Re-inserts to move to the end, then evicts from the front."),
  "lru.js#LruCache#has": clean("Delegates to the map."),
  "lru.js#LruCache#size": clean("Delegates to the map."),
  "lru.js#memoize": clean("Single-argument memo over the cache; honest about taking one argument."),

  // ---------------------------------------------------------------- report
  "report.js#renderRow": L(
    "smell",
    "review",
    "Four nested booleans and the same format string written eight times. Works; a reviewer would not merge it.",
    () => report.renderRow({ name: "x", count: 1, failed: false }, {}).includes("x"),
  ),
  "report.js#summarise": clean("One pass, two counters."),
  "report.js#sortRows": clean("Copies before sorting, comparator returns numbers."),
  "report.js#truncate": L(
    "nearmiss",
    "test",
    "width-1 plus an ellipsis reads like an off-by-one and lands on exactly `width`.",
    () =>
      report.truncate("abcdef", 4).length === 4 &&
      report.truncate("abc", 4) === "abc" &&
      report.truncate("abcd", 4) === "abcd",
  ),

  // ----------------------------------------------------------------- retry
  "retry.js#sleep": clean("Promisified setTimeout."),
  "retry.js#retry": L(
    "bug",
    "test",
    "Returns task(i) without awaiting it, so an async rejection escapes the try and the retry loop never runs.",
    async () => {
      let calls = 0;
      const flaky = async () => {
        calls += 1;
        if (calls < 3) throw new Error("boom");
        return "ok";
      };
      try {
        return (await retry.retry(flaky, 3)) === "ok" && calls === 3;
      } catch {
        return false;
      }
    },
    "unhandled_async",
    "hard",
  ),
  "retry.js#withTimeout": clean("Races a guard and clears the timer in a finally."),
  "retry.js#settleAll": clean("Sequential, and both outcomes are recorded."),

  // ------------------------------------------------------------------ slug
  "slug.js#slugify": L(
    "bug",
    "test",
    "The character-class replace has no /g, so only the first run of separators becomes a dash.",
    () => slug.slugify("Hello World Again") === "hello-world-again",
    "api_default",
    "hard",
  ),
  "slug.js#titleCase": clean("Global replace over the first letter of each word."),
  "slug.js#dedupeSlugs": clean("Counts occurrences and suffixes from the second onward."),
  "slug.js#parseSlug": clean("Splits, tests the tail for digits, falls back to index 1."),

  // ----------------------------------------------------------------- stats
  "stats.js#mean": clean("Guards the empty case, then sums."),
  "stats.js#median": L(
    "bug",
    "test",
    "Array.sort() with no comparator sorts lexicographically, so [10,9,8,100,1] has median 100.",
    () => stats.median([10, 9, 8, 100, 1]) === 9,
    "api_default",
    "hard",
  ),
  "stats.js#percentile": L(
    "bug",
    "test",
    "floor(p/100 * length) indexes one past the end at p=100, returning undefined.",
    () => stats.percentile([1, 2, 3], 100) === 3,
    "boundary",
    "easy",
  ),
  "stats.js#stddev": clean("Sample standard deviation with an n<2 guard."),
  "stats.js#histogram": clean("Clamps the top bucket and guards a zero span."),
  // ----------------------------------------------------------------- ranges
  // From here down: bugs in classes the eight named criteria in judge.mjs do
  // NOT name. `covers: "unnamed"` is the held-out set -- written before the
  // criteria were, so the criteria could not be shaped around them.
  "ranges.js#mergeRanges": L(
    "bug",
    "test",
    "Builds the merged list and never returns it, so every caller gets undefined.",
    () => {
      const out = ranges.mergeRanges([
        { from: 1, to: 3 },
        { from: 2, to: 5 },
      ]);
      return Array.isArray(out) && out.length === 1 && out[0].to === 5;
    },
    "unnamed",
    "easy",
  ),
  "ranges.js#modeFlags": L(
    "bug",
    "test",
    "The `read` case has no break, so asking for read returns read AND write.",
    () =>
      ranges.modeFlags("read").join(",") === "r" &&
      ranges.modeFlags("write").join(",") === "w",
    "unnamed",
    "easy",
  ),
  "ranges.js#spanOf": clean("Guards the empty case, then a linear min and max."),
  "ranges.js#overlaps": clean("Two strict comparisons; half-open intervals."),
  "ranges.js#clampRange": clean("Clamps both ends against the limit."),

  // ------------------------------------------------------------------- pool
  "pool.js#Pool#constructor": clean("Fills the free list and zeroes the counter."),
  "pool.js#Pool#acquire": clean("Pops, throws when exhausted, counts."),
  "pool.js#Pool#release": clean("Decrements and pushes back."),
  "pool.js#withConnection": L(
    "bug",
    "test",
    "No try/finally, so a throwing callback leaks the connection and the pool drains to nothing.",
    () => {
      const p = new pool.Pool(2);
      try {
        pool.withConnection(p, () => {
          throw new Error("boom");
        });
      } catch {
        // expected
      }
      return p.inUse === 0;
    },
    "unnamed",
    "easy",
  ),
  "pool.js#settingsFor": L(
    "bug",
    "test",
    "Caches by user id with no invalidation, so a changed theme is never seen again.",
    () => {
      const user = { id: "u-stale", theme: "dark", locale: "ja" };
      pool.settingsFor(user);
      user.theme = "light";
      return pool.settingsFor(user).theme === "light";
    },
    "unnamed",
    "easy",
  ),
  "pool.js#reachable": L(
    "bug",
    "test",
    "Walks a graph with no visited set, so any cycle recurses until the stack overflows.",
    () => {
      const a = { id: "a", next: [] };
      const b = { id: "b", next: [a] };
      a.next.push(b);
      try {
        const out = pool.reachable(a);
        return out.includes("a") && out.includes("b") && out.length <= 4;
      } catch {
        return false;
      }
    },
    "unnamed",
    "easy",
  ),
  "pool.js#describePool": clean("Two counters in a template string."),
  // ----------------------------------------------------------------- access
  // The rebuilt held-out set: `unnamed` AND `hard`. Each one needs you to know
  // how one specific JavaScript thing behaves -- knowledge that is not in the
  // function's own text -- and none of the eight named criteria is about it.
  //
  // `overlap` records the criterion someone could argue covers it anyway, so
  // the write-up can report the strict and the generous reading separately
  // rather than me deciding which is fair.
  "access.js#withDefaults": L(
    "bug",
    "test",
    "Object spread is shallow, so passing any part of `limits` replaces the whole nested object and the defaults inside it are silently lost.",
    () => {
      const merged = access.withDefaults({ limits: { max: 5 } });
      return merged.limits.max === 5 && merged.limits.burst === 10;
    },
    "unnamed",
    "hard",
  ),
  "access.js#hasRole": L(
    "bug",
    "test",
    "Every object inherits Object.prototype, so hasRole({}, 'toString') is true and any inherited name grants the role.",
    () => access.hasRole({}, "toString") === false && access.hasRole({ admin: 1 }, "admin"),
    "unnamed",
    "hard",
  ),
  "access.js#requiredMissing": L(
    "bug",
    "test",
    "Tests falsiness rather than presence, so a field legitimately set to 0, false or the empty string is reported missing.",
    () =>
      access.requiredMissing({ age: 0, agreed: false, note: "" }, ["age", "agreed", "note"])
        .length === 0,
    "unnamed",
    "hard",
  ),
  "access.js#emptyGrid": L(
    "bug",
    "test",
    "fill stores ONE reference, so every row of the grid is the same array and writing one cell writes the whole column.",
    () => {
      const grid = access.emptyGrid(2, 2);
      grid[0][0] = 1;
      return grid[1][0] === 0;
    },
    "unnamed",
    "hard",
  ),
  "access.js#Formatter#formatAll": L(
    "bug",
    "test",
    "Passing a method as a callback drops its receiver, so `this` is undefined inside format and the call throws.",
    () => {
      try {
        return new Formatter(">").formatAll(["a"]).join(",") === ">a";
      } catch {
        return false;
      }
    },
    "unnamed",
    "hard",
  ),
  "access.js#Formatter#constructor": clean("Assigns one field."),
  "access.js#Formatter#format": clean("Template string over its own field."),
  "access.js#pickKeys": L(
    "nearmiss",
    "test",
    "Object.hasOwn next to a plain lookup reads like paranoia, and it is exactly what stops `hasRole`'s bug.",
    () => {
      const out = access.pickKeys({ a: 1 }, ["a", "toString", "b"]);
      return Object.keys(out).join(",") === "a";
    },
  ),
  "access.js#countBy": clean("Map with a nullish-coalescing seed."),
  "access.js#deepFreeze": L(
    "nearmiss",
    "test",
    "Recursion plus mutation plus a default parameter; the WeakSet is what stops the cycle `reachable` falls into.",
    () => {
      const a = { n: 1 };
      a.self = a;
      const out = access.deepFreeze(a);
      return Object.isFrozen(out) && out.self === a;
    },
  ),
};

/** `file.js#name` for a unit, which is how LABELS is keyed. */
export function labelKey(unit) {
  const file = unit.file.split("/").pop();
  return `${file}#${unit.name}`;
}

export function labelOf(unit) {
  return LABELS[labelKey(unit)] ?? null;
}

/**
 * The experiment's central claim, checked on every request body rather than
 * asserted in prose: no label, no basis and no note crosses the wire.
 *
 * Notes are checked by their distinctive opening, because a whole note could
 * be reformatted by JSON.stringify; 40 characters of one of these sentences
 * appearing in a payload can only mean we leaked it.
 */
export function assertNoLabelLeak(payload) {
  for (const [key, entry] of Object.entries(LABELS)) {
    if (entry.note && entry.note.length >= 40 && payload.includes(entry.note.slice(0, 40))) {
      throw new Error(`label leak: payload carries the note for ${key}`);
    }
  }
  for (const word of ["nearmiss", '"bug"', "smell", "basis", "corpus"]) {
    if (payload.includes(word)) throw new Error(`label leak: payload contains "${word}"`);
  }
}

export function counts() {
  const out = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  for (const entry of Object.values(LABELS)) out[entry.label] += 1;
  return out;
}
