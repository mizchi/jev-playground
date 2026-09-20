/**
 * Narrow the candidate list before asking — the `browser_find` move.
 *
 * playwright-mcp ships a `browser_find` tool: search the accessibility
 * snapshot for text or a regex and get back the matching nodes with their
 * refs, "cheaper than capturing the whole snapshot when you only need to
 * locate an element". docs/30 §1 flagged it as the mechanism this repo
 * lacked, and docs/29 §9 left the 255-choice limit in `shared/jev.ts`
 * untested.
 *
 * **It cannot be ported as-is, and the reason matters.** In
 * playwright-mcp an agent calls the tool, so a model writes the query.
 * Jev answers `choice` / `noul` / `score` — it cannot emit text at all,
 * so there is nobody to write a query with. Retrieval for a Jev driver
 * has to be done in code, against the goal it was given.
 *
 * Which is the same shape as every other thing that worked here: decide
 * in code what code can decide. The difference, and the reason this needs
 * measuring rather than assuming, is that the earlier ones were
 * *deterministic* — the browser knows whether a click lands. Lexical
 * similarity to the goal is a guess, and a retriever that guesses wrong
 * does not merely waste tokens: it removes the right answer from the
 * question, and no amount of model quality recovers from that.
 */
import type { ProbedCandidate } from "./probes.js";

/** Words too common to carry any signal about which control to use. */
const STOP = new Set([
  "the", "a", "an", "and", "or", "to", "of", "for", "in", "on", "at", "by", "with",
  "is", "are", "be", "it", "this", "that", "then", "when", "if", "as", "from",
  "your", "you", "i", "we", "my", "me", "any", "all", "one", "next", "step",
  "complete", "choose", "select", "use", "go", "get", "make", "do", "not",
]);

export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * How well one candidate matches the query terms.
 *
 * Deliberately the obvious thing — token overlap, weighted by how rare
 * the term is across the candidate list — because the question being
 * measured is whether *retrieval at all* is safe here, not whether a
 * better scorer exists. A scorer tuned on this fixture would answer a
 * question nobody asked.
 */
export function score(
  candidate: ProbedCandidate,
  queryTerms: readonly string[],
  df: ReadonlyMap<string, number>,
  total: number,
): number {
  const own = new Set(terms(candidate.description));
  let s = 0;
  for (const q of queryTerms) {
    if (!own.has(q)) continue;
    // A term on half the candidates says nothing; a term on one says a lot.
    const n = df.get(q) ?? 1;
    s += Math.log(1 + total / n);
  }
  return s;
}

export function documentFrequency(candidates: readonly ProbedCandidate[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const c of candidates) {
    for (const t of new Set(terms(c.description))) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return df;
}

export interface RetrieveOptions {
  /** How many candidates to keep. */
  k: number;
  /**
   * Candidates that are always kept regardless of score, by description.
   * The recent-history and inert sets live outside this module, so a
   * caller that knows "the model just tried this" can pin or drop it.
   */
  pin?: ReadonlySet<string>;
}

export interface Retrieved {
  kept: ProbedCandidate[];
  /** Everything, scored and ordered, for measuring recall at other k. */
  ranked: { candidate: ProbedCandidate; score: number }[];
}

/**
 * Rank every candidate against the goal and keep the top `k`.
 *
 * Ties are broken by the candidate's own index, so the result is stable:
 * two arms on the same page get the same list, and a score of zero — no
 * overlap with the goal at all — still keeps document order rather than
 * shuffling. That matters more than it sounds, because on a wide board
 * most candidates score exactly zero.
 */
export function retrieve(
  candidates: readonly ProbedCandidate[],
  goal: string,
  opts: RetrieveOptions,
): Retrieved {
  const df = documentFrequency(candidates);
  const queryTerms = [...new Set(terms(goal))];
  const ranked = candidates
    .map((candidate) => ({ candidate, score: score(candidate, queryTerms, df, candidates.length) }))
    .sort((a, b) => b.score - a.score || a.candidate.index - b.candidate.index);

  const pin = opts.pin;
  if (!pin || pin.size === 0) {
    return { kept: ranked.slice(0, opts.k).map((r) => r.candidate), ranked };
  }
  // Pinned first, then the best of the rest, without duplicating.
  const pinned = ranked.filter((r) => pin.has(r.candidate.description));
  const rest = ranked.filter((r) => !pin.has(r.candidate.description));
  const kept = [...pinned, ...rest].slice(0, opts.k).map((r) => r.candidate);
  return { kept, ranked };
}

/**
 * Where the correct candidate landed in the ranking, or -1 if it is not
 * among the candidates at all.
 *
 * This is the number the whole mechanism turns on. Retrieval trades
 * prompt size for recall, and a rank of `k` or worse means the right
 * answer was not in the question.
 */
export function rankOf(ranked: Retrieved["ranked"], matches: (c: ProbedCandidate) => boolean): number {
  return ranked.findIndex((r) => matches(r.candidate));
}

/**
 * The server's cap on one `choice` question, from `shared/jev.ts`.
 * Reaching it is not a soft failure — `Jev.ask` throws before sending —
 * so a driver on a wide page has to narrow to *something* whether or not
 * narrowing helps it decide.
 */
export const MAX_CHOICES = 255;
