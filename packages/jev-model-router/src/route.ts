/**
 * The standalone API. One request, one decision, never throws on a bad day.
 *
 * `route()` is what the CLI calls and what the Pi adapter calls, so the thing
 * measured in `experiments/router` is the thing that ships. The Pi adapter
 * adds session pinning and a status line and nothing else that can change a
 * decision.
 */
import { Jev, noulOf, scoreOf, type SystemOneResponse } from "@jev-playground/jev-core";
import { EFFORT, OVERSIZED, TIER, UNDERSPECIFIED, questionsFor, stateFor, type RouteInput } from "./questions.js";
import { decide, detectOverride, type Decision, type Judgment } from "./policy.js";
import { DEFAULT_CONFIG, validateConfig, type RouterConfig } from "./tiers.js";

export interface RouteResult {
  decision: Decision;
  /** Null when judgment was not reached. The decision is still valid. */
  judgment: Judgment | null;
  /** Present when judgment failed, so a caller can log it once and move on. */
  error?: string;
  ms: number;
  usage?: { input: number; output: number };
}

export function judgmentOf(res: SystemOneResponse, askedEffort: boolean): Judgment {
  const tier = scoreOf(res.answers, TIER);
  const effort = askedEffort ? scoreOf(res.answers, EFFORT) : { score: Number.NaN, confidence: Number.NaN };
  return {
    tier: tier.score,
    tierConfidence: tier.confidence,
    effort: effort.score,
    effortConfidence: effort.confidence,
    underspecified: noulOf(res.answers, UNDERSPECIFIED),
    oversized: noulOf(res.answers, OVERSIZED),
  };
}

/**
 * Route one request.
 *
 * Fails soft on purpose. A dead endpoint, a timeout, a 429, a malformed
 * response: each returns the fallback tier with `reason: "unavailable"` and
 * the error text alongside, because the caller is a coding agent about to do
 * work and an exception here stops work that judgment was only advising on.
 */
export async function route(
  input: RouteInput,
  opts: { config?: Partial<RouterConfig>; jev?: Jev; current?: string; available?: string[] } = {},
): Promise<RouteResult> {
  const config: RouterConfig = { ...DEFAULT_CONFIG, ...opts.config };
  validateConfig(config);
  const started = Date.now();
  const current = opts.current ?? config.fallback;
  const askedEffort = Boolean(config.effort && config.effort.length >= 2);

  const override = detectOverride(config, input.task);
  if (override) {
    return {
      decision: decide({ config, judgment: null, current, available: opts.available, override }),
      judgment: null,
      ms: Date.now() - started,
    };
  }

  let jev: Jev;
  try {
    jev = opts.jev ?? new Jev({ timeoutMs: config.timeoutMs });
  } catch (err) {
    return {
      decision: decide({ config, judgment: null, current, available: opts.available }),
      judgment: null,
      error: String(err),
      ms: Date.now() - started,
    };
  }

  try {
    const res = await jev.ask(stateFor(input, config), questionsFor(config));
    const judgment = judgmentOf(res, askedEffort);
    return {
      decision: decide({
        config,
        judgment,
        current,
        available: opts.available,
        contextTokens: input.contextTokens,
      }),
      judgment,
      ms: Date.now() - started,
      usage: { input: res.usage.input_tokens, output: res.usage.output_tokens },
    };
  } catch (err) {
    return {
      decision: decide({ config, judgment: null, current, available: opts.available }),
      judgment: null,
      error: String(err).slice(0, 300),
      ms: Date.now() - started,
    };
  }
}

export { DEFAULT_CONFIG, DEFAULT_EFFORT, DEFAULT_TIERS, indexOfModel, validateConfig } from "./tiers.js";
export type { EffortLevel, RouterConfig, Tier } from "./tiers.js";
export { decide, detectOverride } from "./policy.js";
export type { Decision, Judgment } from "./policy.js";
export { EFFORT, OVERSIZED, TIER, UNDERSPECIFIED, payloadOf, questionsFor, stateFor } from "./questions.js";
export type { RouteInput } from "./questions.js";
