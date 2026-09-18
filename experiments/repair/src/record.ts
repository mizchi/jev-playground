/**
 * The recorded ground truth, and the hash that keeps it honest.
 *
 * Separate from `truth.ts` because that file RUNS -- it spends 30 seconds of
 * node processes rebuilding the cache. Importing a type from it re-ran the
 * whole rebuild at the top of every replay, which is the kind of bug that
 * shows up as an unexplained delay rather than as an error.
 */
export interface TaskTruth {
  task: string;
  /** The file's text, so a stale truth is detectable. */
  sourceHash: number;
  candidates: number;
  /** Candidate ids that make the suite pass. */
  fixes: string[];
  /** The failing output before any edit, which is what the state carries. */
  baseline: string;
  ms: number;
}

/** A cheap stable hash, only ever compared for equality. */
export function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
