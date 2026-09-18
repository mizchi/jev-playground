/**
 * From answers to a model, in code, with no network call and no surprises.
 *
 * Pure and total. Every missing, malformed, or impossible input resolves to a
 * decision, because the alternative is a router that throws in front of a
 * human who only wanted to ask a question. The shape is lifted from
 * `gargpratyush/jev-router`'s `decide()`, which gets this right: judgment
 * supplies typed answers, code supplies the policy, and the policy is testable
 * without a key.
 *
 * What is added here is the ladder. That router reads a `choice` and moves one
 * label; this one reads a continuous `score` and has to say which rung it
 * lands on, which is a fitted question rather than a lookup (see
 * `jev-core/ladder.ts`).
 */
import { rungFor } from "@jev-playground/jev-core";
import { indexOfModel, type RouterConfig } from "./tiers.js";

export interface Judgment {
  /** The `tier` score, continuous over the rubric. NaN when unavailable. */
  tier: number;
  tierConfidence: number;
  /** The `effort` score, or NaN when effort was not asked. */
  effort: number;
  effortConfidence: number;
  underspecified: number;
  oversized: number;
}

export interface Decision {
  model: string;
  label: string;
  /** Null when effort was not asked or could not be read. */
  effort: string | null;
  /** Why this rung, in one token, for a status line and for the records. */
  reason: string;
  /** True when the decision moved off `current`. */
  changed: boolean;
  /** The rung index, so a caller can compare decisions without string work. */
  rung: number;
}

/**
 * Round a score to a rung when no cuts have been fitted.
 *
 * Deliberately separate from the fitted path and deliberately named: rounding
 * assumes the rubric's own levels are the right boundaries, which is the
 * assumption docs/25 spent a whole report showing to be wrong more often than
 * not. It is the pre-calibration default, not the recommendation.
 */
function roundToRung(score: number, rungs: number): number {
  return Math.min(rungs - 1, Math.max(0, Math.round(score)));
}

export function decide(input: {
  config: RouterConfig;
  judgment: Judgment | null;
  /** The model in use now. Every fallback path returns to it. */
  current: string;
  /** Models the host can actually run. Empty means "trust the config". */
  available?: string[];
  contextTokens?: number;
  /** A tier the user named outright, which outranks judgment. */
  override?: string | null;
}): Decision {
  const { config, judgment, current } = input;
  const available = input.available && input.available.length > 0 ? input.available : config.tiers.map((t) => t.model);
  const currentRung = Math.max(0, indexOfModel(config, current));

  const settle = (rung: number, reason: string, effort: string | null): Decision => {
    const clamped = clampToAvailable(config, rung, available);
    const tier = config.tiers[clamped] ?? config.tiers[currentRung] ?? config.tiers[0];
    const why = clamped === rung ? reason : `${reason}+unavailable`;
    return {
      model: tier.model,
      label: tier.label,
      effort,
      reason: clamped === currentRung ? `${why}/no-change` : why,
      changed: clamped !== currentRung,
      rung: clamped,
    };
  };

  const effortName = (): string | null => {
    if (!config.effort || !judgment || !Number.isFinite(judgment.effort)) return null;
    const i = roundToRung(judgment.effort, config.effort.length);
    return config.effort[i]?.name ?? null;
  };

  if (input.override) {
    const rung = indexOfModel(config, input.override);
    if (rung >= 0) return settle(rung, "override", effortName());
  }

  if (!judgment || !Number.isFinite(judgment.tier)) {
    const fb = indexOfModel(config, config.fallback);
    return settle(fb >= 0 ? fb : currentRung, "unavailable", null);
  }

  // An unreadable request is not a cheap request. Both escape hatches send the
  // work up rather than down, because the cost of being wrong is asymmetric:
  // too strong wastes money, too weak wastes the turn AND the money.
  if (judgment.underspecified > 0.7 || judgment.oversized > 0.7) {
    const top = config.tiers.length - 1;
    const reason = judgment.underspecified > 0.7 ? "underspecified" : "oversized";
    return settle(Math.max(currentRung, top), reason, effortName());
  }

  let target = config.cuts
    ? rungFor(judgment.tier, config.cuts)
    : roundToRung(judgment.tier, config.tiers.length);
  const reason = config.cuts ? "fitted" : "rounded";

  // docs/21 §7: confidence belongs on the routing decision, not on a gate.
  // A low-confidence answer is allowed to send work UP and never down, so an
  // uncertain judgment cannot quietly cost the user a failed turn.
  if (judgment.tierConfidence < config.minConfidence && target < currentRung) {
    return settle(currentRung, "low-confidence-no-downgrade", effortName());
  }

  const contextTokens = input.contextTokens ?? 0;
  if (target < currentRung && contextTokens > config.downgradeMaxContextTokens) {
    return settle(currentRung, "downgrade-not-worth-cache-rebuild", effortName());
  }

  target = Math.min(target, config.tiers.length - 1);
  return settle(target, reason, effortName());
}

/**
 * The nearest rung the host can run, preferring to step UP.
 *
 * Up rather than down for the same asymmetry as above. A router that silently
 * hands hard work to a weaker model because the right one was not installed
 * has converted a configuration problem into a wrong answer.
 */
function clampToAvailable(config: RouterConfig, rung: number, available: string[]): number {
  const runnable = (i: number): boolean => available.includes(config.tiers[i]?.model);
  if (runnable(rung)) return rung;
  for (let i = rung + 1; i < config.tiers.length; i += 1) if (runnable(i)) return i;
  for (let i = rung - 1; i >= 0; i -= 1) if (runnable(i)) return i;
  return rung;
}

/**
 * A tier the user named in the request itself.
 *
 * Patterns, not judgment: "use opus for this" is a fact about the text, and
 * docs/23 §5 is the general form -- what code can decide, code decides.
 */
export function detectOverride(config: RouterConfig, task: string): string | null {
  const text = (task ?? "").toLowerCase();
  for (const tier of config.tiers) {
    const label = tier.label.toLowerCase();
    if (new RegExp(`\\b(use|with|on|switch to)\\s+(the\\s+)?${label}\\b`).test(text)) return tier.model;
  }
  return null;
}
