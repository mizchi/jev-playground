/**
 * The standalone entry: a request in, a plan out, never throwing.
 *
 * One request carries all four questions (docs/29 §4: width is free), so the
 * topology is known before the gate has been read and the audit line can say
 * what the alternative would have been.
 */
import { Jev, noulOf, type SystemOneResponse } from "@jev-playground/jev-core";
import {
  GATE,
  SIZE,
  STAY_SINGLE,
  TOPOLOGY,
  questionsFor,
  stateFor,
  type Framing,
  type Pattern,
  type PlanInput,
} from "./questions.js";
import { DEFAULT_ORCHESTRATOR_CONFIG, decide, type Judgment, type OrchestratorConfig, type Plan } from "./policy.js";

export interface PlanConfig extends OrchestratorConfig {
  /** Which wording of the gate to use. See questions.ts: this is the dial. */
  framing: Framing;
  timeoutMs: number;
}

export const DEFAULT_PLAN_CONFIG: PlanConfig = {
  ...DEFAULT_ORCHESTRATOR_CONFIG,
  // Strict by default. docs/31 §2b: naming the cost catches the traps (6/7)
  // and refuses work that should have been split (6/22 on plainly-multi).
  // For a resident agent the unnecessary fan-out is the expensive error.
  framing: "cost",
  timeoutMs: 10_000,
};

export interface PlanResult {
  plan: Plan;
  judgment: Judgment | null;
  error?: string;
  ms: number;
  usage?: { input: number; output: number };
}

export function judgmentOf(res: SystemOneResponse): Judgment {
  const topology = res.answers[TOPOLOGY];
  const isChoice = topology && topology.type === "choice";
  return {
    gate: noulOf(res.answers, GATE),
    topology: isChoice ? (topology.choice as Pattern) : null,
    topologyConfidence: isChoice ? topology.confidence : Number.NaN,
    probabilities: isChoice ? topology.probabilities : {},
    staySingle: noulOf(res.answers, STAY_SINGLE),
    size: noulOf(res.answers, SIZE),
  };
}

export async function plan(
  input: PlanInput,
  opts: { config?: Partial<PlanConfig>; jev?: Jev } = {},
): Promise<PlanResult> {
  const config: PlanConfig = { ...DEFAULT_PLAN_CONFIG, ...opts.config };
  const started = Date.now();

  let jev: Jev;
  try {
    jev = opts.jev ?? new Jev({ timeoutMs: config.timeoutMs });
  } catch (err) {
    return { plan: decide(null, config), judgment: null, error: String(err), ms: Date.now() - started };
  }
  try {
    const res = await jev.ask(stateFor(input), questionsFor(config.framing));
    const judgment = judgmentOf(res);
    return {
      plan: decide(judgment, config),
      judgment,
      ms: Date.now() - started,
      usage: { input: res.usage.input_tokens, output: res.usage.output_tokens },
    };
  } catch (err) {
    // Falling back to `single` is falling back to doing the work, which is
    // both the cheap answer and the one that cannot go wrong in a way the
    // caller did not ask for.
    return { plan: decide(null, config), judgment: null, error: String(err).slice(0, 300), ms: Date.now() - started };
  }
}

/**
 * The plan as a sentence for a model to act on.
 *
 * Deliberately describes the SHAPE and not the steps. docs/31's topology
 * `choice` was 22/22 at naming which pattern fits; nothing measured says Jev
 * can decompose the work, and writing "worker 1 does X, worker 2 does Y"
 * here would be inventing that.
 */
export function brief(result: PlanResult): string {
  const { plan: p } = result;
  if (!p.split) return `Do this yourself, in one agent. ${p.reason}.`;
  return (
    `This work fits the ${p.shape} pattern with about ${p.workers} workers. ${p.reason}. ` +
    `Decide the actual division of labour yourself; what was judged is the shape, not the steps.`
  );
}

export { DEFAULT_ORCHESTRATOR_CONFIG, decide } from "./policy.js";
export type { Judgment, OrchestratorConfig, Plan } from "./policy.js";
export {
  GATE,
  PARALLEL,
  PATTERNS,
  PATTERN_USE,
  SIZE,
  STAY_SINGLE,
  TOPOLOGY,
  payloadOf,
  questionsFor,
  stateFor,
} from "./questions.js";
export type { Framing, Pattern, PlanInput } from "./questions.js";
