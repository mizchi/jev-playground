/**
 * Gate answer in, plan out. Pure, total, and where the cost lives.
 *
 * docs/31 §2's result is the reason this file exists separately from the
 * question: naming a cost IN THE PROMPT moved the gate 21 points and skewed
 * every error to one side. Naming it in CODE cannot -- a cutoff applied to an
 * answer does not change the answer. So the economics of a resident agent
 * belong here: how many workers, a ceiling, and a floor under which fanning
 * out is refused whatever the gate says.
 */
import { GATE_AT, PARALLEL, type Pattern } from "./questions.js";

export interface OrchestratorConfig {
  /**
   * The gate fires at or above this.
   *
   * Null means "use the cutoff fitted for the framing in use", which is what
   * `plan()` resolves via `gateAtFor`. A number pins it regardless of framing,
   * which is almost always the wrong thing -- see `GATE_AT` for why the two
   * wordings cannot share one.
   */
  gateAt: number | null;
  /** The most workers a plan may ask for. */
  maxWorkers: number;
  /**
   * Below this size answer, stay single however the gate reads.
   *
   * The floor is in code, not in the question, and it is the whole of the
   * cost model: a second worker's fixed cost does not shrink with the task,
   * so a small task cannot repay it. docs/31's `big_enough` is condition (4)
   * of the documented rule, and this is that condition applied as a veto
   * rather than as a term in a boolean the gate was measured not to need.
   */
  minSize: number;
  /** Patterns this host cannot run. Trimmed from the plan, with a reason. */
  unavailable: Pattern[];
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  // Null, not 0.5: the cutoff belongs to the framing (see GATE_AT). `decide()`
  // falls back to the `cost` framing's number when nobody resolved it, which
  // is the shipped default framing, so a caller that ignores all of this gets
  // the configuration docs/31 §8 measured as best in the asymmetric regime.
  gateAt: null,
  maxWorkers: 3,
  minSize: 0.5,
  // `evolution` searches over workflows and `blackboard` wants a durable
  // shared board; neither is something a single pi session can do, so the
  // default host cannot offer them. Naming them here rather than deleting
  // them from the criteria keeps the 22/22 `choice` intact -- removing an
  // option changes the question, and the measurement was of all eight.
  unavailable: ["evolution", "blackboard"],
};

export interface Judgment {
  gate: number;
  topology: Pattern | null;
  topologyConfidence: number;
  /** All eight, for the audit line. */
  probabilities: Record<string, number>;
  staySingle: number;
  size: number;
}

export interface Plan {
  /** What to do. `single` is the default and the cheap answer. */
  shape: "single" | Pattern;
  workers: number;
  /** True when the plan differs from just doing the work. */
  split: boolean;
  reason: string;
  /** Present when the topology was picked but the host cannot run it. */
  substituted?: { from: Pattern; to: "single" | Pattern };
  /** The gate fired and `stay_single` agreed with it being split, or not. */
  agreement: "agree" | "disagree" | "unknown";
}

/** How many workers a shape wants, given the size answer. */
function workersFor(pattern: Pattern, size: number, max: number): number {
  if (!PARALLEL.has(pattern)) return 2;
  // Two for an ordinary split, three or more only when the work is large.
  // There is no measurement behind the step; it is a deliberately timid
  // reading of "big enough" and it is the number a caller is most likely to
  // want to change, so it is one expression rather than a table.
  return Math.max(2, Math.min(max, size >= 0.8 ? max : 2));
}

/**
 * Decide. Never throws, and returns `single` for every missing answer -- the
 * cheap default is also the safe one, which is a piece of luck this file
 * should not be read as relying on: it is stated as a rule so that a future
 * change cannot quietly make "no judgment" mean "fan out".
 */
export function decide(judgment: Judgment | null, config: OrchestratorConfig = DEFAULT_ORCHESTRATOR_CONFIG): Plan {
  // A null cutoff means `plan()` did not resolve one from the framing. Fall
  // back to the default framing's fitted number rather than to a round 0.5:
  // docs/31 §8 measured `plain` at 0.5 as the worst configuration of the nine
  // it tried, so a bare 0.5 is not a safe default for an unknown framing.
  const gateAt = config.gateAt ?? GATE_AT.cost;
  if (!judgment || !Number.isFinite(judgment.gate)) {
    return { shape: "single", workers: 1, split: false, reason: "no judgment; one worker", agreement: "unknown" };
  }
  const agreement: Plan["agreement"] = !Number.isFinite(judgment.staySingle)
    ? "unknown"
    : (judgment.gate >= gateAt) === judgment.staySingle < 0.5
      ? "agree"
      : "disagree";

  if (judgment.gate < gateAt) {
    return {
      shape: "single",
      workers: 1,
      split: false,
      reason: `the gate reads ${judgment.gate.toFixed(2)}, below ${gateAt}`,
      agreement,
    };
  }
  if (Number.isFinite(judgment.size) && judgment.size < config.minSize) {
    return {
      shape: "single",
      workers: 1,
      split: false,
      reason:
        `the gate fired (${judgment.gate.toFixed(2)}) but the work reads small (${judgment.size.toFixed(2)} ` +
        `against a floor of ${config.minSize}); a second worker's fixed cost does not shrink with the task`,
      agreement,
    };
  }
  const pattern = judgment.topology;
  if (!pattern) {
    return {
      shape: "single",
      workers: 1,
      split: false,
      reason: `the gate fired (${judgment.gate.toFixed(2)}) but no shape came back`,
      agreement,
    };
  }
  if (config.unavailable.includes(pattern)) {
    // The second-best shape this host CAN run, from the same answer's
    // probabilities. No extra request: a `choice` returns all of them.
    const ranked = Object.entries(judgment.probabilities)
      .filter(([name]) => !config.unavailable.includes(name as Pattern))
      .sort((a, b) => b[1] - a[1]);
    const next = ranked[0]?.[0] as Pattern | undefined;
    if (!next) {
      return {
        shape: "single",
        workers: 1,
        split: false,
        reason: `${pattern} fits but this host cannot run it, and no alternative is available`,
        substituted: { from: pattern, to: "single" },
        agreement,
      };
    }
    return {
      shape: next,
      workers: workersFor(next, judgment.size, config.maxWorkers),
      split: true,
      reason: `${pattern} fits best but this host cannot run it; ${next} is the closest it can (${(judgment.probabilities[next] ?? 0).toFixed(2)})`,
      substituted: { from: pattern, to: next },
      agreement,
    };
  }
  return {
    shape: pattern,
    workers: workersFor(pattern, judgment.size, config.maxWorkers),
    split: true,
    reason:
      `${pattern} (confidence ${judgment.topologyConfidence.toFixed(2)}), gate ${judgment.gate.toFixed(2)}` +
      (agreement === "disagree" ? ", though the inverted framing disagrees" : ""),
    agreement,
  };
}
