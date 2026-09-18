/**
 * The strategies being compared, and the one rule they all obey: whatever a
 * strategy selects, the GRAPH decides what actually runs.
 *
 * That is the division of labour the experiment is about. A strategy only ever
 * names goals ("run the auth browser suite"); `runSet` turns a set of goals
 * into the prerequisite closure, in topological order, with a cost. Nothing
 * that picks tasks -- static matching or Jev -- ever has to know that
 * `e2e-auth` needs `build-web`, which needs `build-ui`, which needs `install`.
 * docs/17's last limit was that it could only ever pick one task; here the
 * closure is what makes a chain expressible.
 */
import { matchesAny, type TaskGraph } from "./graph.js";
import { changedPaths, type Scenario } from "./scenarios.js";

export interface Plan {
  /** The goals the strategy asked for. */
  selected: string[];
  /** Everything that runs, prerequisites included, in topological order. */
  run: string[];
  /** Machine seconds: the whole run set, nothing in parallel. */
  serial: number;
  /** Wall-clock seconds: the longest chain, unlimited parallelism. */
  wall: number;
}

export function plan(graph: TaskGraph, selected: Iterable<string>): Plan {
  const goals = [...new Set(selected)].sort();
  const run = graph.closure(goals);
  return {
    selected: goals,
    run: graph.ordered(run),
    serial: graph.serialCost(run),
    wall: graph.criticalPath(run),
  };
}

/** Run everything: the `ci` recipe's own closure, not a list kept by hand. */
export function planAll(graph: TaskGraph): Plan {
  const ci = graph.tasks.find((t) => graph.isMeta(t.name));
  if (!ci) throw new Error("no meta recipe to define the 'all' baseline");
  return plan(graph, ci.deps);
}

/** Tasks whose own declared inputs the change touches. No propagation. */
function globHits(graph: TaskGraph, scenario: Scenario): Set<string> {
  const paths = changedPaths(scenario);
  const hit = new Set<string>();
  for (const task of graph.tasks) {
    if (graph.isMeta(task.name)) continue;
    if (task.inputs.length > 0 && paths.some((p) => matchesAny(p, task.inputs))) {
      hit.add(task.name);
    }
  }
  return hit;
}

function goalsOf(graph: TaskGraph, names: Iterable<string>): string[] {
  // Only goals are selectable; a prerequisite comes back through the closure.
  const goalNames = new Set(graph.goals().map((t) => t.name));
  return [...names].filter((n) => goalNames.has(n));
}

/**
 * Glob matching and nothing else, which is the cheap thing to reach for and
 * the reason real tools do not stop there: a task whose declared inputs do not
 * mention the changed file is skipped even when it is the only task that could
 * have caught the failure. `a11y` declares `web/**` and the change is in
 * `packages/ui`.
 */
export function globsOnly(graph: TaskGraph, scenario: Scenario): Plan {
  return plan(graph, goalsOf(graph, globHits(graph, scenario)));
}

/**
 * The sound baseline, and what turborepo/bazel-shaped tools do: a task is
 * affected if the change touches its declared inputs, or if it depends on a
 * task that is affected. Sound, in the sense that it only ever over-selects --
 * and over-select it does, because one file in `packages/shared` is an input
 * to everything downstream of it.
 */
export function staticAffected(graph: TaskGraph, scenario: Scenario): Plan {
  const hit = globHits(graph, scenario);
  for (const up of graph.dependents(hit)) hit.add(up);
  return plan(graph, goalsOf(graph, hit));
}

/** Goals whose score clears the threshold. */
export function planFromScores(
  graph: TaskGraph,
  scores: Record<string, number>,
  threshold: number,
): Plan {
  const goals = Object.entries(scores)
    .filter(([, v]) => v >= threshold)
    .map(([k]) => k);
  return plan(graph, goals);
}

/**
 * The same threshold, except that a task cheap enough to be rounding error is
 * never skipped. A 4-second formatter and a 320-second browser suite do not
 * deserve the same bar: skipping the formatter saves nothing and can lose the
 * only check that would have gone red, which is exactly how the one miss in
 * the no-intent run happened (fmt-check, scored 1.24 against a 1.25 cutoff).
 */
export function planCostAware(
  graph: TaskGraph,
  scores: Record<string, number>,
  threshold: number,
  freeUnder: number,
): Plan {
  const goals = graph
    .goals()
    .filter((t) => (scores[t.name] ?? 0) >= threshold || t.cost <= freeUnder)
    .map((t) => t.name);
  return plan(graph, goals);
}

/**
 * Jev pruning inside the static set: it may drop a task the globs caught, but
 * never add one they missed. The conservative way to deploy a filter, and the
 * arrangement where a miss can only ever be Jev's fault.
 */
export function planPruned(
  graph: TaskGraph,
  scenario: Scenario,
  scores: Record<string, number>,
  threshold: number,
): Plan {
  const affected = new Set(staticAffected(graph, scenario).selected);
  const goals = [...affected].filter((n) => (scores[n] ?? 0) >= threshold);
  return plan(graph, goals);
}

/** Did anything in the run set actually go red? */
export function caught(p: Plan, failing: Set<string>): boolean {
  return p.run.some((n) => failing.has(n));
}

/** Seconds spent on tasks that were never going to fail. */
export function wasted(graph: TaskGraph, p: Plan, failing: Set<string>): number {
  let total = 0;
  for (const n of p.run) if (!failing.has(n)) total += graph.task(n).cost;
  return total;
}
