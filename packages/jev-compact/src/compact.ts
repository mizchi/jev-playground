/**
 * The standalone compactor: a transcript and a budget in, a smaller
 * transcript out. Deletes only. Never throws.
 *
 * The policy is `dropUntilFits` with Jev's ranking instead of a free one, and
 * the whole experimental question is whether that ranking is worth anything
 * over `oldest` / `largest` / `stale`. docs/33 §1 is the reason the baselines
 * are in the same module and run on the same transcript: there, the free
 * features already contained the answer and the paid judgment added nothing,
 * and that was only visible because the free version was measured first.
 *
 * TWO CASES THIS RETURNS WITHOUT DELETING, and they are different:
 *
 *   `fits`        already under budget. Nothing to do.
 *   `cannot-fit`  the floors alone exceed the budget. Deletion is the wrong
 *                 tool here and saying so matters: a compactor that deleted
 *                 everything droppable and still came back over budget would
 *                 have spent the transcript and solved nothing. The host
 *                 should summarise.
 *
 * ON FAILURE it defers rather than guessing. See `onError`.
 */
import { Jev, noulOf, scoreOf } from "@jev-playground/jev-core";
import {
  DEFAULT_FLOORS,
  dropUntilFits,
  pinned,
  rankBy,
  totalTokens,
  valid,
  type Baseline,
  type Entry,
  type Floors,
} from "./entries.js";
import { NOTHING_SPARE, keyFor, questionsFor, stateFor, type CompactContext } from "./questions.js";

export interface CompactConfig extends Floors {
  /** Target size. Deletion stops as soon as the transcript is at or under it. */
  budgetTokens: number;
  /**
   * An entry is a deletion candidate only at or below this level. 0..3.
   *
   * 1.5 sits between "superseded" and "background", so an entry that records
   * a fact nothing else records is not a candidate however big it is. Not
   * fitted: docs/25's rule is that a cutoff belongs to a corpus, and this one
   * was chosen to be timid rather than measured.
   */
  dropAt: number;
  /** Above this, the escape noul cancels the whole compaction. */
  nothingSpareAt: number;
  /** Per-entry digest cap, in characters. */
  digestCap: number;
  /** The most entries to ask about in one request. */
  maxCandidates: number;
  /**
   * What to do when judgment is unavailable.
   *
   * `defer` returns the transcript untouched, which hands the problem to
   * whatever the host does when it runs out of context -- usually a
   * summarising compaction. That is the right default because OVER-DELETION
   * IS UNDETECTABLE: an entry deleted on no judgment is gone, and nothing
   * afterwards can notice that the fact it carried is missing. A summary that
   * loses the same fact is at least a known quantity.
   *
   * `baseline` falls back to `largest`, for a caller whose reason for being
   * here is that summarisation costs too much to run at all. It trades a
   * silent loss for a bounded bill, and it should be chosen deliberately.
   */
  onError: "defer" | "baseline";
  timeoutMs: number;
}

export const DEFAULT_COMPACT_CONFIG: CompactConfig = {
  ...DEFAULT_FLOORS,
  budgetTokens: 60_000,
  dropAt: 1.5,
  nothingSpareAt: 0.8,
  digestCap: 400,
  maxCandidates: 200,
  onError: "defer",
  timeoutMs: 20_000,
};

export interface Ranked {
  entry: Entry;
  /** The `score` answer, continuous over the four levels. NaN if not asked. */
  level: number;
  confidence: number;
}

export interface CompactResult {
  keep: Entry[];
  dropped: Entry[];
  outcome: "fits" | "deleted" | "cannot-fit" | "nothing-spare" | "deferred";
  tokensBefore: number;
  tokensAfter: number;
  /** Ranked candidates, weakest first. For an audit line and for replay. */
  ranked: Ranked[];
  nothingSpare: number;
  reason: string;
  error?: string;
  ms: number;
  usage?: { input: number; output: number };
}

function done(entries: readonly Entry[], outcome: CompactResult["outcome"], reason: string, ms: number): CompactResult {
  const size = totalTokens(entries);
  return {
    keep: [...entries],
    dropped: [],
    outcome,
    tokensBefore: size,
    tokensAfter: size,
    ranked: [],
    nothingSpare: Number.NaN,
    reason,
    ms,
  };
}

/**
 * Compact with a free ranking. No key, no request, and the baseline every
 * paid result has to beat.
 */
export function compactBy(
  baseline: Baseline,
  entries: readonly Entry[],
  config: Partial<CompactConfig> = {},
): CompactResult {
  const full: CompactConfig = { ...DEFAULT_COMPACT_CONFIG, ...config };
  const before = totalTokens(entries);
  if (before <= full.budgetTokens) return done(entries, "fits", `${before} tokens is already within budget`, 0);
  const floor = totalTokens(entries.filter((e) => pinned(entries, full).has(e.id)));
  if (floor > full.budgetTokens) {
    return done(
      entries,
      "cannot-fit",
      `the floors alone are ${floor} tokens against a budget of ${full.budgetTokens}; deletion cannot reach it`,
      0,
    );
  }
  const { keep, dropped } = dropUntilFits(entries, rankBy(baseline, entries), full.budgetTokens, full);
  return {
    keep,
    dropped,
    outcome: dropped.length > 0 ? "deleted" : "fits",
    tokensBefore: before,
    tokensAfter: totalTokens(keep),
    ranked: [],
    nothingSpare: Number.NaN,
    reason: `${baseline}: dropped ${dropped.length} of ${entries.length}`,
    ms: 0,
  };
}

export async function compact(
  entries: readonly Entry[],
  ctx: Omit<CompactContext, "recent"> & { recent?: string[] },
  opts: { config?: Partial<CompactConfig>; jev?: Jev } = {},
): Promise<CompactResult> {
  const config: CompactConfig = { ...DEFAULT_COMPACT_CONFIG, ...opts.config };
  const started = Date.now();
  const before = totalTokens(entries);
  if (before <= config.budgetTokens) {
    return done(entries, "fits", `${before} tokens is already within budget`, Date.now() - started);
  }

  const keepSet = pinned(entries, config);
  const floor = totalTokens(entries.filter((e) => keepSet.has(e.id)));
  if (floor > config.budgetTokens) {
    return done(
      entries,
      "cannot-fit",
      `the floors alone are ${floor} tokens against a budget of ${config.budgetTokens}; deletion cannot reach it, so summarise`,
      Date.now() - started,
    );
  }

  /**
   * Candidates, largest first.
   *
   * The ORDER here is not the deletion order -- that comes from the answers.
   * It decides which entries get a question when there are more candidates
   * than `maxCandidates`, and largest-first is the right triage because the
   * budget is in tokens: fifty short turns cannot free what one file read
   * can, so spending questions on them is spending them on nothing.
   */
  const candidates = entries
    .filter((e) => !keepSet.has(e.id))
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, config.maxCandidates);
  if (candidates.length === 0) {
    return done(entries, "cannot-fit", "every entry is pinned by the floors", Date.now() - started);
  }

  const fallback = (error: string): CompactResult => {
    if (config.onError === "baseline") {
      const result = compactBy("largest", entries, config);
      return { ...result, reason: `${result.reason} (judgment unavailable)`, error, ms: Date.now() - started };
    }
    return { ...done(entries, "deferred", "judgment unavailable; left to the host", Date.now() - started), error };
  };

  let jev: Jev;
  try {
    jev = opts.jev ?? new Jev({ timeoutMs: config.timeoutMs });
  } catch (err) {
    return fallback(String(err));
  }

  const recent = ctx.recent ?? entries.filter((e) => keepSet.has(e.id)).map((e) => `${e.role}: ${e.text.slice(0, 200)}`);

  let ranked: Ranked[];
  let nothingSpare: number;
  let usage: { input: number; output: number };
  try {
    const res = await jev.ask(
      stateFor({ ...ctx, recent }),
      questionsFor(candidates, config.digestCap),
    );
    ranked = candidates
      .map((entry) => {
        const { score, confidence } = scoreOf(res.answers, keyFor(entry.id));
        return { entry, level: score, confidence };
      })
      .sort((a, b) => a.level - b.level);
    nothingSpare = noulOf(res.answers, NOTHING_SPARE);
    usage = { input: res.usage.input_tokens, output: res.usage.output_tokens };
  } catch (err) {
    return fallback(String(err).slice(0, 300));
  }

  if (nothingSpare >= config.nothingSpareAt) {
    return {
      ...done(
        entries,
        "nothing-spare",
        `the escape hatch says every entry is still in play (${nothingSpare.toFixed(2)})`,
        Date.now() - started,
      ),
      ranked,
      nothingSpare,
      usage,
    };
  }

  // Only entries at or below the cutoff are offered for deletion, weakest
  // first. An entry above it is not a candidate however much room it would
  // free -- which is why this can come back still over budget, and says so.
  const droppable = ranked.filter((r) => r.level <= config.dropAt).map((r) => r.entry);
  const { keep, dropped } = dropUntilFits(entries, droppable, config.budgetTokens, config);
  const after = totalTokens(keep);
  const soundness = valid(keep);
  if (!soundness.ok) {
    // Unreachable if `closePairs` is right, and checked anyway: shipping a
    // transcript a provider will reject is worse than not compacting.
    return { ...fallback(`refusing an unsound transcript: ${soundness.why}`), ranked, nothingSpare, usage };
  }
  return {
    keep,
    dropped,
    outcome: dropped.length === 0 ? "cannot-fit" : "deleted",
    tokensBefore: before,
    tokensAfter: after,
    ranked,
    nothingSpare,
    reason:
      dropped.length === 0
        ? `nothing scored at or below ${config.dropAt}; ${ranked.length} candidates, weakest ${ranked[0]?.level.toFixed(2) ?? "-"}`
        : `dropped ${dropped.length} of ${entries.length} entries, ${before} -> ${after} tokens` +
          (after > config.budgetTokens ? ` (still over the ${config.budgetTokens} budget: the rest scored above ${config.dropAt})` : ""),
    ms: Date.now() - started,
    usage,
  };
}

export {
  DEFAULT_FLOORS,
  closePairs,
  dropUntilFits,
  pinned,
  rankBy,
  tokensOf,
  totalTokens,
  valid,
} from "./entries.js";
export type { Baseline, Entry, Floors } from "./entries.js";
export { LEVELS, NOTHING_SPARE, TERSE_LEVELS, digest, keyFor, payloadOf, questionsFor, stateFor } from "./questions.js";
export type { CompactContext } from "./questions.js";
export { callsOf, entriesOf, textOf } from "./messages.js";
export type { MessageLike } from "./messages.js";
