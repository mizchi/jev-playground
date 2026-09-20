/**
 * The decision, once the scores are in: what is worth running.
 *
 * docs/23 shipped one cutoff plus a constant floor ("anything under ten
 * seconds runs unconditionally"). Both numbers were typed in by hand, and the
 * floor exists because a cheap recipe and an expensive one do not deserve the
 * same bar -- its single miss was a four-second formatter that scored 1.24
 * against a 1.25 cutoff.
 *
 * This is the same idea with the numbers taken out of the two tables that are
 * already measured. A score becomes a probability, and then the selection
 * minimises
 *
 *   machine seconds of the closure  +  penalty x P(something red, none of it run)
 *
 * so the only parameter left is `penalty`: what a missed red check costs. The
 * per-recipe cutoff falls out of it (`impliedCutoff`), and cheap recipes ride
 * along without a special case.
 *
 * docs/25 §B measures this against the cutoff-and-floor form on this
 * repository's own recipes, with labels from recorded exit codes.
 */
import type { TaskGraph } from "./graph.js";
import { plan, type Plan } from "./select.js";

export interface Calibration {
  a: number;
  b: number;
}

/**
 * p(this recipe goes red) = sigmoid(a * score + b).
 *
 * Fitted on `real/scores-draws.json` (15 real diffs x 10 draws x 16 goals =
 * 2400 judgments, 240 of them on a recipe that actually went red) against the
 * exit codes in `real/runs.json`. `npm run report` in experiments/threshold-fit
 * re-fits it and says so if these numbers have drifted, the same way
 * eslint-plugin-jev checks its shipped cutoffs.
 *
 * It is one pooled curve for every recipe, which docs/22 §4 warns against --
 * but no single recipe here has more than two failures to calibrate on, so
 * pooling is forced rather than chosen. docs/25 §B1 has the per-recipe AUCs
 * that say whether it is defensible.
 */
export const CALIBRATION: Calibration = { a: 2.2979, b: -5.4132 };

export function probability(score: number, model: Calibration = CALIBRATION): number {
  return 1 / (1 + Math.exp(-(model.a * score + model.b)));
}

/**
 * The score this recipe has to reach before running it pays for itself: the
 * point where cost = penalty x p. docs/23's floor, as a function of the
 * recipe's own measured seconds.
 *
 * Returns 0 when the recipe is cheap enough to run on no evidence at all.
 */
export function impliedCutoff(cost: number, penalty: number, model: Calibration = CALIBRATION): number {
  const need = cost / penalty;
  if (need >= 1) return Number.POSITIVE_INFINITY;
  const p = Math.min(1 - 1e-9, Math.max(1e-9, need));
  const at = (Math.log(p / (1 - p)) - model.b) / model.a;
  return Math.max(0, at);
}

/** Expected loss of running `run` (a task bitmask) when `skipped` goals are left out. */
interface Loss {
  (run: number, skippedGoals: readonly number[]): number;
}

/**
 * Least-expected-loss selection over the goals.
 *
 * Exhaustive while the goal count allows it, because greedy cannot follow this
 * objective: recipes that share a prerequisite are only worth adding together,
 * so one goal at a time stops early. The first version was greedy and lost to
 * exhaustive search on 7 of 45 decisions by up to 0.94 machine seconds; adding
 * single-goal hill-climbing still lost 6. Sixteen goals is 65536 candidate
 * sets and a few milliseconds, against the ~300 ms the request itself costs.
 *
 * Above `exactUpTo` goals it falls back to the climb, which is a known
 * approximation -- the bound above is what it costs on this repository.
 *
 * Costs come from the graph (measured seconds), probabilities from the
 * calibration, and the closure means a goal's marginal cost depends on what
 * else is already selected -- which is the whole reason the decision is a set
 * and not sixteen independent cutoffs.
 */
export function planLeastLoss(
  graph: TaskGraph,
  scores: Record<string, number>,
  penalty: number,
  model: Calibration = CALIBRATION,
  exactUpTo = 18,
): Plan {
  const goals = graph.goals().map((t) => t.name);
  const index = new Map(graph.tasks.map((t, i) => [t.name, i]));
  const survive = graph.tasks.map((t) => {
    const s = scores[t.name];
    return 1 - (typeof s === "number" && goals.includes(t.name) ? probability(s, model) : 0);
  });
  const cost = graph.tasks.map((t) => t.cost);
  // One bitmask per goal: everything that runs if that goal is asked for.
  const closureOf = goals.map((name) => {
    let mask = 0;
    for (const n of graph.closure([name])) mask |= 1 << index.get(n)!;
    return mask;
  });
  const goalBit = goals.map((name) => 1 << index.get(name)!);
  // Indexed by GOAL, not by task: the two orders are different, and mixing
  // them up quietly changes the objective rather than crashing.
  const goalSurvive = goals.map((name) => survive[index.get(name)!]);

  const loss: Loss = (run, skippedGoals) => {
    let seconds = 0;
    let inside = 1;
    // Walk the set bits, not all of the tasks: this runs once per candidate
    // set, and there are 2^goals of them.
    for (let m = run; m !== 0; m &= m - 1) {
      const i = 31 - Math.clz32(m & -m);
      seconds += cost[i];
      inside *= survive[i];
    }
    let outside = 1;
    for (const g of skippedGoals) outside *= goalSurvive[g];
    // P(miss) = nothing red inside the run set, and something red outside it.
    return seconds + penalty * inside * (1 - outside);
  };

  const skippedBuffer: number[] = [];
  const lossOf = (run: number): number => {
    skippedBuffer.length = 0;
    for (let i = 0; i < goals.length; i += 1) if ((run & goalBit[i]) === 0) skippedBuffer.push(i);
    return loss(run, skippedBuffer);
  };
  const evaluate = (selected: readonly number[]): number => {
    let run = 0;
    for (const i of selected) run |= closureOf[i];
    return lossOf(run);
  };

  let bestSet: number[] = [];
  let best = evaluate(bestSet);
  if (goals.length <= exactUpTo) {
    const bitOf = new Map<number, number>();
    for (let i = 0; i < goals.length; i += 1) bitOf.set(1 << i, i);
    // runOf[mask] is built from the mask with its lowest goal removed, so each
    // candidate costs one OR instead of a walk over the selection.
    const runOf = new Int32Array(1 << goals.length);
    let bestMask = 0;
    for (let mask = 1; mask < 1 << goals.length; mask += 1) {
      const low = mask & -mask;
      runOf[mask] = runOf[mask ^ low] | closureOf[bitOf.get(low)!];
      const value = lossOf(runOf[mask]);
      if (value < best - 1e-12) {
        best = value;
        bestMask = mask;
      }
    }
    bestSet = [];
    for (let i = 0; i < goals.length; i += 1) if ((bestMask >> i) & 1) bestSet.push(i);
  } else {
    for (;;) {
      let move: { set: number[]; value: number } | null = null;
      for (let i = 0; i < goals.length; i += 1) {
        const next = bestSet.includes(i) ? bestSet.filter((x) => x !== i) : [...bestSet, i];
        const value = evaluate(next);
        if (value < best - 1e-9 && (move === null || value < move.value)) move = { set: next, value };
      }
      if (!move) break;
      bestSet = move.set;
      best = move.value;
    }
  }
  return plan(
    graph,
    bestSet.map((i) => goals[i]),
  );
}
