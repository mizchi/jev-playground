/**
 * Cache the decision, keyed on the state — stagehand's action cache.
 *
 * `packages/protocol/schemas.ts` carries a `CacheMetadataSchema` with a
 * hit count, a threshold ("must be seen before the cache serves a hit"),
 * `cachedInputTokens` saved, and a list of miss reasons. Two of those
 * reasons are the interesting part: `threshold` (seen, but not often
 * enough yet) and **`replay_failed`** — "a cached value was found but
 * could not be applied".
 *
 * That second one is not an edge case here, it is the default. This
 * harness's selectors are `data-probe-idx` attributes that the probe
 * **re-stamps every step**, exactly so an index cannot go stale
 * (`probes.ts` documents why). So a cached decision's selector is
 * meaningless by the time it is replayed, and the cache has to store
 * something that survives: the candidate's *description*, re-resolved
 * against the current list. A cache that stored the selector would
 * appear to work and click whatever now happens to carry that index.
 *
 * What this is really measuring is narrower than "does caching help".
 * docs/29 found Jev's decisions stable across runs — identical picks,
 * identical token counts, on identical prompts. So on a deterministic
 * board an exact-key cache cannot change the answer; it can only change
 * the bill. The question worth asking is what happens when the page is
 * **not** identical to what was recorded, because that is when a hit is
 * served for a state that no longer means the same thing.
 */
import type { Operation } from "./fanout.js";

export interface CachedDecision {
  operation: Operation;
  /**
   * The candidate's description, not its index or selector. The index is
   * re-stamped every probe and the selector with it; the description is
   * what a human would recognise and what survives a re-render.
   */
  target?: string;
  /** For a SELECT, the option value. */
  option?: string;
}

export interface CacheEntry extends CachedDecision {
  /** How many times this key has been seen, this request included. */
  seen: number;
}

export type MissReason =
  | "not_found"
  | "threshold"
  | "replay_failed";

export interface Lookup {
  hit: boolean;
  decision?: CachedDecision;
  reason?: MissReason;
  /** The key's hit count, for reporting how close a miss was. */
  seen: number;
}

export type Granularity = "exact" | "loose";

export interface ActionCacheOptions {
  /**
   * How much of the state the key covers.
   *
   *   exact  route + full screen text + every field value. Two states
   *          are the same key only if the page reads identically.
   *   loose  route + which fields are empty. Ignores the *content* of
   *          what was typed and anything else on the page, so it hits far
   *          more often — and can hit on a page that has changed.
   *
   * Both are measured, because the granularity IS the tradeoff: a key
   * narrow enough to be always-right is narrow enough to rarely hit.
   */
  granularity: Granularity;
  /**
   * How many times a key must be seen before a hit is served.
   * stagehand's threshold. On a flow where each step is a fresh state
   * this only ever delays, so `1` is the default here and the effect of
   * raising it is reported rather than assumed.
   */
  minSeen?: number;
}

/** Everything the key can be built from, supplied by the caller. */
export interface StateKeyParts {
  route: string;
  screen: string;
  /** `id=value` for every field on the page, in document order. */
  fields: string;
}

export function cacheKey(parts: StateKeyParts, granularity: Granularity): string {
  if (granularity === "exact") return `${parts.route}|${parts.screen}|${parts.fields}`;
  // Which fields are empty, not what is in them. `email=a@b.co` and
  // `email=z@y.co` are the same situation for the purpose of "what next";
  // `email=` is a different one.
  const shape = parts.fields
    .split(",")
    .map((f) => {
      const eq = f.indexOf("=");
      return eq === -1 ? f : `${f.slice(0, eq)}=${f.slice(eq + 1) ? "set" : "empty"}`;
    })
    .join(",");
  return `${parts.route}|${shape}`;
}

export class ActionCache {
  #entries = new Map<string, CacheEntry>();
  #granularity: Granularity;
  #minSeen: number;

  hits = 0;
  misses = new Map<MissReason, number>();
  /** Input tokens not spent, summed from what the served steps cost. */
  savedInputTokens = 0;

  constructor(opts: ActionCacheOptions) {
    this.#granularity = opts.granularity;
    this.#minSeen = Math.max(1, opts.minSeen ?? 1);
  }

  key(parts: StateKeyParts): string {
    return cacheKey(parts, this.#granularity);
  }

  /**
   * Look the state up, and say why on a miss.
   *
   * `available` is the current candidate descriptions. A stored decision
   * whose target is not among them is `replay_failed` — the honest
   * outcome, rather than acting on an index that now names something
   * else.
   */
  lookup(parts: StateKeyParts, available: ReadonlySet<string>): Lookup {
    const key = this.key(parts);
    const entry = this.#entries.get(key);
    if (!entry) {
      this.#bump("not_found");
      return { hit: false, reason: "not_found", seen: 0 };
    }
    entry.seen += 1;
    if (entry.seen < this.#minSeen) {
      this.#bump("threshold");
      return { hit: false, reason: "threshold", seen: entry.seen };
    }
    // A targetless operation (DONE / BLOCKED / a scroll) has nothing to
    // re-resolve, so it always replays.
    if (entry.target !== undefined && !available.has(entry.target)) {
      this.#bump("replay_failed");
      return { hit: false, reason: "replay_failed", seen: entry.seen };
    }
    this.hits += 1;
    return {
      hit: true,
      decision: { operation: entry.operation, target: entry.target, option: entry.option },
      seen: entry.seen,
    };
  }

  store(parts: StateKeyParts, decision: CachedDecision): void {
    const key = this.key(parts);
    const existing = this.#entries.get(key);
    // A new key starts at zero sightings: recording is not seeing. Start
    // it at 1 and `minSeen: 3` serves on the second lookup, because
    // `lookup` counts the current request — stagehand's `seen` is
    // "including this request", so the two have to agree on where the
    // count begins. An existing key keeps its count, so re-recording a
    // decision does not reset how well known its state is.
    this.#entries.set(key, { ...decision, seen: existing?.seen ?? 0 });
  }

  /** Record what a cache hit avoided paying, measured from a real step. */
  credit(inputTokens: number): void {
    this.savedInputTokens += inputTokens;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Serializable, so a run can record and a later run can replay it. */
  dump(): Record<string, CacheEntry> {
    return Object.fromEntries(this.#entries);
  }

  load(dumped: Record<string, CacheEntry>): void {
    // `seen` resets on load: the threshold is about how often a key has
    // come up in the session doing the serving, not in the one that
    // recorded it.
    for (const [k, v] of Object.entries(dumped)) this.#entries.set(k, { ...v, seen: 0 });
  }

  missReport(): string {
    const parts = [...this.misses].map(([r, n]) => `${r}=${n}`);
    return parts.length > 0 ? parts.join(" ") : "none";
  }

  #bump(reason: MissReason): void {
    this.misses.set(reason, (this.misses.get(reason) ?? 0) + 1);
  }
}
