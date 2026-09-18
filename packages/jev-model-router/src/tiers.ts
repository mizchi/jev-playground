/**
 * The ladder the router chooses a rung of.
 *
 * A tier list is ORDERED, and that is the single most consequential fact about
 * this router's design. docs/01 §3 measured the same decision asked both ways
 * on shell-command risk: a `choice` over the ordered outcomes got 14/24 no
 * matter how the thresholds were bent, and switching to `score` over the same
 * ladder got 23/24. The reason is what `confidence` means in each shape --
 * a `choice`'s confidence says "which of these two labels", not "how far up
 * the ladder", so the number you threshold is answering a different question
 * than the one you asked.
 *
 * `gargpratyush/jev-router`, the closest prior art, asks a `choice` here and
 * reads `jev.choice`. That is the shape docs/01 measured as the worse one, so
 * this router asks a `score` and keeps the disagreement testable: the recorded
 * corpus in `experiments/router` runs both shapes over the same tasks.
 */

export interface Tier {
  /** The model id the host will actually run. */
  model: string;
  /** The name the ladder's rubric uses. Short, because it goes in a status line. */
  label: string;
  /**
   * Relative price. Any consistent unit -- only ratios reach the cost model.
   * Defaults below use published per-million input prices as of writing; a
   * caller with a subscription should set their own, because "price" for them
   * is a rate limit rather than a dollar figure.
   */
  price: number;
  /** What kind of work this rung is for. Goes verbatim into the rubric. */
  says: string;
}

export interface EffortLevel {
  name: string;
  says: string;
}

export interface RouterConfig {
  /** Cheapest first. The order IS the ladder. */
  tiers: Tier[];
  /** Used when judgment is unavailable, and it must be one of `tiers`. */
  fallback: string;
  /**
   * Cutoffs between rungs, ascending, length `tiers.length - 1`.
   *
   * Null means "not fitted yet", and then the router falls back to rounding
   * the score, which is the behaviour a caller gets before they have run the
   * labelling. It is deliberately worse than a fitted ladder rather than
   * secretly the same: `experiments/router` exists to produce these numbers,
   * and a default that looked fitted would hide that it is not.
   */
  cuts: number[] | null;
  /** Below this, never move DOWN the ladder. docs/21 §7's lesson. */
  minConfidence: number;
  /**
   * A downgrade is refused above this much conversation, because the cheaper
   * model has to rebuild the prompt cache.
   *
   * Carried over from `gargpratyush/jev-router`, where it is also a rule with
   * no measurement behind it. Flagged in docs/36 as untested rather than
   * quietly inherited.
   */
  downgradeMaxContextTokens: number;
  effort: EffortLevel[] | null;
  timeoutMs: number;
}

export const DEFAULT_TIERS: Tier[] = [
  {
    model: "claude-haiku-4-5-20251001",
    label: "haiku",
    price: 1,
    says: "a small fast model is enough: a mechanical edit, a rename, formatting, running a command, one obvious fix in one file",
  },
  {
    model: "claude-sonnet-5",
    label: "sonnet",
    price: 3,
    says: "a mid model is needed: several files, ordinary reasoning about existing code, a fix that has to be found before it can be made",
  },
  {
    model: "claude-opus-5",
    label: "opus",
    price: 15,
    says: "the strongest model is needed: subtle debugging, an unfamiliar domain, design with consequences, or a task whose own description has to be worked out first",
  },
];

/**
 * Effort levels, as a second ladder.
 *
 * Asked as its own `score` in the SAME request rather than as a cross product
 * with the tier. Two reasons, both measured: a cross product of 3 tiers x 5
 * levels is a 15-way `choice`, which throws away both orderings (docs/01);
 * and a question's answer does not move with the request's width, so asking
 * two questions costs one round trip either way (docs/29 §4, 99.8% of answers
 * within 0.25 between a 74-wide request and a 1-wide one).
 *
 * `pi-jev-router` states the opposite -- "Model and effort are chosen
 * together, not in separate evaluations". That is a testable claim and
 * `experiments/router` tests it rather than picking a side by assertion.
 */
export const DEFAULT_EFFORT: EffortLevel[] = [
  { name: "low", says: "no deliberation needed; the answer is apparent from the request" },
  { name: "medium", says: "some working out, of a kind the model does routinely" },
  { name: "high", says: "genuine deliberation: several interacting constraints, or a cause that has to be traced" },
];

export const DEFAULT_CONFIG: RouterConfig = {
  tiers: DEFAULT_TIERS,
  fallback: "claude-sonnet-5",
  cuts: null,
  minConfidence: 0.5,
  downgradeMaxContextTokens: 40_000,
  effort: DEFAULT_EFFORT,
  timeoutMs: 10_000,
};

export function indexOfModel(config: RouterConfig, model: string): number {
  return config.tiers.findIndex((t) => t.model === model || t.label === model);
}

/** Throws on a configuration that cannot produce a decision. */
export function validateConfig(config: RouterConfig): void {
  if (config.tiers.length < 2) throw new Error("a router needs at least two tiers");
  if (indexOfModel(config, config.fallback) < 0) {
    throw new Error(`fallback ${config.fallback} is not one of the configured tiers`);
  }
  if (config.cuts) {
    if (config.cuts.length !== config.tiers.length - 1) {
      throw new Error(`${config.tiers.length} tiers need ${config.tiers.length - 1} cuts, got ${config.cuts.length}`);
    }
    for (let i = 1; i < config.cuts.length; i += 1) {
      if (!(config.cuts[i] > config.cuts[i - 1])) throw new Error("cuts must be strictly ascending");
    }
  }
  const labels = new Set(config.tiers.map((t) => t.label));
  if (labels.size !== config.tiers.length) throw new Error("tier labels must be unique");
}
