/**
 * What both routers share, and nothing that knows about a host.
 *
 * Nothing in this package imports from `@earendil-works/*`, from Claude Code,
 * or from anything else that only exists inside an agent. That is the whole
 * point of it being a package: `jev-model-router` and `jev-skill-router` each
 * have exactly one file that knows about Pi, and everything reachable from
 * their standalone CLI runs under plain `node`.
 */
export {
  Jev,
  JevError,
  JevTooLargeError,
  MAX_CHOICES,
  REQUEST_BUDGET_BYTES,
  bytesOf,
  type Answer,
  type Description,
  type Instructions,
  type JevOptions,
  type Question,
  type SystemOneResponse,
} from "./client.js";

export {
  costOf,
  crossValidateLadder,
  expectedCost,
  fitLadder,
  fixedRungCost,
  rungFor,
  type CostModel,
  type FittedLadder,
  type LadderSample,
  type Rung,
} from "./ladder.js";

/**
 * Read one `noul` answer, or NaN.
 *
 * A router branches on numbers that came off the wire, so "the answer is
 * missing" and "the answer is 0" have to stay distinguishable. Returning 0 for
 * a missing noul would silently read as "definitely not".
 */
export function noulOf(answers: Record<string, { type: string } & Record<string, unknown>>, key: string): number {
  const a = answers[key];
  if (!a || a.type !== "noul" || typeof a.noul !== "number") return Number.NaN;
  return a.noul;
}

/** Read one `score` answer and its confidence, or NaN. */
export function scoreOf(
  answers: Record<string, { type: string } & Record<string, unknown>>,
  key: string,
): { score: number; confidence: number } {
  const a = answers[key];
  if (!a || a.type !== "score" || typeof a.score !== "number") {
    return { score: Number.NaN, confidence: Number.NaN };
  }
  return { score: a.score, confidence: typeof a.confidence === "number" ? a.confidence : Number.NaN };
}
