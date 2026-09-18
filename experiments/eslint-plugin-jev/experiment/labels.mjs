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
import * as auth from "./corpus/auth.js";
import * as cart from "./corpus/cart.js";
import * as counters from "./corpus/counters.js";
import * as dates from "./corpus/dates.js";
import { EventBus } from "./corpus/events.js";
import * as fsutil from "./corpus/fsutil.js";
import * as http from "./corpus/http.js";
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

const L = (label, basis, note, probe) => ({ label, basis, note, probe });
const clean = (note) => L("clean", "review", note, null);

export const LABELS = {
  // ------------------------------------------------------------------ auth
  "auth.js#compareTokens": L(
    "bug",
    "test",
    "Two empty tokens compare equal, so a request with no token authenticates against a session with no token.",
    () => auth.compareTokens("", "") === false,
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
  ),
  "retry.js#withTimeout": clean("Races a guard and clears the timer in a finally."),
  "retry.js#settleAll": clean("Sequential, and both outcomes are recorded."),

  // ------------------------------------------------------------------ slug
  "slug.js#slugify": L(
    "bug",
    "test",
    "The character-class replace has no /g, so only the first run of separators becomes a dash.",
    () => slug.slugify("Hello World Again") === "hello-world-again",
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
  ),
  "stats.js#percentile": L(
    "bug",
    "test",
    "floor(p/100 * length) indexes one past the end at p=100, returning undefined.",
    () => stats.percentile([1, 2, 3], 100) === 3,
  ),
  "stats.js#stddev": clean("Sample standard deviation with an n<2 guard."),
  "stats.js#histogram": clean("Clamps the top bucket and guards a zero span."),
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
