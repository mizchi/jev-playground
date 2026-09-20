/**
 * Section B -- docs/23's task filter, with the cutoff weighed against cost.
 *
 * docs/23 ran one cutoff for every recipe and then had to bolt a constant onto
 * it: "anything under ten seconds runs unconditionally", because its single
 * miss was a four-second formatter that scored 1.24 against a 1.25 cutoff.
 * §11 left the obvious homework: the floor should not be a constant, it should
 * come out of the two numbers that are already measured -- what the task costs
 * and how likely it is to be the one that goes red.
 *
 * That is what this section fits. A score becomes a probability (one pooled
 * logistic, because no single recipe has enough failures to calibrate on its
 * own), and then the decision is not a cutoff at all: pick the set of goals
 * that minimises
 *
 *   machine seconds of the closure  +  penalty x P(something red, none of it run)
 *
 * The cutoff comes back out of that as a per-task number -- run recipe i when
 * p_i >= cost_i / penalty -- which is the floor docs/23 wanted, as a function
 * instead of a constant.
 *
 * Labels are the recorded exit codes (real/runs.json), never a rule. The
 * calibration is fitted leave-one-diff-out, so no diff is ever scored with a
 * model that saw it.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CALIBRATION, planLeastLoss } from "../../task-filter/src/cost.js";
import { loadGraph, TaskGraph } from "../../task-filter/src/graph.js";
import type { Run } from "../../task-filter/src/observe.js";
import type { ChangedFile, Scenario } from "../../task-filter/src/scenarios.js";
import {
  caught,
  globsOnly,
  planAll,
  planCostAware,
  planFromScores,
  staticAffected,
  type Plan,
} from "../../task-filter/src/select.js";
import { auc, logisticFit, logisticP, logisticValueAt, mean, type Logistic, type Sample } from "../../shared/thresholds.js";

const HERE = import.meta.dirname;
const REPO = resolve(HERE, "../../..");
const REAL = resolve(HERE, "../../task-filter/real");

interface Row {
  id: string;
  repeat: number;
  scores: Record<string, number>;
}

interface MutationRun {
  mutation: { id: string; subject: string };
  files: ChangedFile[];
  run: Run;
}

const pad = (s: string, n: number) => s.padEnd(n);
const dur = (s: number) => `${s.toFixed(1).padStart(5)}s`;
const pct = (x: number) => `${(x * 100).toFixed(1).padStart(5)}%`;

export interface TaskData {
  graph: TaskGraph;
  runs: MutationRun[];
  rows: Row[];
  failing: Map<string, Set<string>>;
  all: Plan;
}

export function loadTasks(scoresFile = "scores.json"): TaskData {
  const graph = new TaskGraph(loadGraph(REPO, resolve(REAL, "graph.json")));
  const runs = JSON.parse(readFileSync(resolve(REAL, "runs.json"), "utf8")) as MutationRun[];
  const rows = JSON.parse(readFileSync(resolve(REAL, scoresFile), "utf8")) as Row[];
  const failing = new Map(
    runs.map((r) => [
      r.mutation.id,
      new Set(r.run.observations.filter((o) => o.status === "fail").map((o) => o.task)),
    ]),
  );
  return { graph, runs, rows, failing, all: planAll(graph) };
}

const asScenario = (m: MutationRun): Scenario => ({
  id: m.mutation.id,
  branch: "",
  subject: "",
  files: m.files,
  defect: null,
  shape: "narrow",
});

/** Detection and machine seconds over every (diff, draw), the way docs/23 reports them. */
export function score(
  data: TaskData,
  decide: (row: Row) => Plan,
): { caught: number; of: number; serial: number; serialClean: number } {
  let hit = 0;
  let of = 0;
  const serial: number[] = [];
  const clean: number[] = [];
  for (const row of data.rows) {
    const p = decide(row);
    serial.push(p.serial);
    const failing = data.failing.get(row.id)!;
    if (failing.size === 0) {
      clean.push(p.serial);
      continue;
    }
    of += 1;
    if (caught(p, failing)) hit += 1;
  }
  return { caught: hit, of, serial: mean(serial), serialClean: mean(clean) };
}

/** (score, went red) for every goal in every draw of the given diffs. */
export function pairs(data: TaskData, ids: Set<string>): { x: number; y: boolean }[] {
  const out: { x: number; y: boolean }[] = [];
  for (const row of data.rows) {
    if (!ids.has(row.id)) continue;
    const failing = data.failing.get(row.id)!;
    for (const task of data.graph.goals()) {
      const s = row.scores[task.name];
      if (typeof s !== "number") continue;
      out.push({ x: s, y: failing.has(task.name) });
    }
  }
  return out;
}

export function tasksSection(scoresFile = "scores.json"): void {
  const data = loadTasks(scoresFile);
  const { graph, runs, rows, all } = data;
  const draws = rows.length / runs.length;
  const goals = graph.goals();
  const ids = new Set(runs.map((r) => r.mutation.id));

  console.log("");
  console.log("=".repeat(104));
  console.log(
    `  B. THE CUTOFF AS A FUNCTION OF COST -- docs/23 §12's repository, ` +
      `${runs.length} real diffs x ${draws} draws, ${goals.length} goals`,
  );
  console.log("");

  // ------------------------------------------------- can a single recipe be fitted?
  console.log(`  ${pad("goal", 22)}${"cost".padStart(7)}${"red in".padStart(8)}${"mean score when red".padStart(21)}${"when green".padStart(12)}${"AUC".padStart(7)}`);
  let fittable = 0;
  for (const task of goals) {
    const red: number[] = [];
    const green: number[] = [];
    for (const row of rows) {
      const s = row.scores[task.name];
      if (typeof s !== "number") continue;
      (data.failing.get(row.id)!.has(task.name) ? red : green).push(s);
    }
    if (red.length === 0) continue;
    fittable += 1;
    const samples: Sample[] = [
      ...red.map((x) => ({ value: x, positive: true })),
      ...green.map((x) => ({ value: x, positive: false })),
    ];
    console.log(
      `  ${pad(task.name, 22)}${`${task.cost.toFixed(1)}s`.padStart(7)}` +
        `${`${red.length / draws}/${runs.length}`.padStart(8)}` +
        `${mean(red).toFixed(2).padStart(21)}${mean(green).toFixed(2).padStart(12)}` +
        `${auc(samples).toFixed(2).padStart(7)}`,
    );
  }
  console.log("");
  console.log(
    `  Only ${fittable} of the ${goals.length} goals ever went red, and none more than twice, so there is no` +
      ` per-recipe`,
  );
  console.log("  corpus to fit on: the calibration below is pooled over all goals. docs/22 §4 says that is");
  console.log("  the wrong thing to do when the scales differ -- here it is forced, and the AUC column is");
  console.log("  what says whether it is defensible.");

  // ---------------------------------------------------------------- calibration
  const model = logisticFit(pairs(data, ids), { ridge: 1 });
  console.log("");
  console.log("-".repeat(104));
  console.log("  B2. SCORE -> PROBABILITY (one pooled logistic, ridge 1)");
  console.log("");
  console.log(`  p(red) = sigmoid(${model.a.toFixed(2)} * score ${model.b >= 0 ? "+" : "-"} ${Math.abs(model.b).toFixed(2)})`);
  console.log(
    `  ${[0, 0.5, 1, 1.25, 1.5, 2, 2.5]
      .map((s) => `score ${s.toFixed(2)} -> ${logisticP(model, s).toFixed(3)}`)
      .join("   ")}`,
  );
  const allPairs = pairs(data, ids);
  console.log(
    `  fitted on ${allPairs.length} (goal, diff, draw) triples, ${allPairs.filter((p) => p.y).length} of them red; ` +
      `pooled AUC ${auc(allPairs.map((p) => ({ value: p.x, positive: p.y }))).toFixed(2)}`,
  );
  // The CLI ships constants; this is the check that they still match a fit of
  // the record they came from, the way eslint-plugin-jev checks its cutoffs
  // against docs/22's table. The coefficients are NOT stable across record
  // sets -- three draws fit a flatter curve than ten -- so the check names
  // which record it is comparing against.
  const shippedFrom = "scores-draws.json";
  if (existsSync(resolve(REAL, shippedFrom))) {
    const onShipped = logisticFit(pairs(loadTasks(shippedFrom), ids), { ridge: 1 });
    const drifted =
      Math.abs(CALIBRATION.a - onShipped.a) > 0.01 || Math.abs(CALIBRATION.b - onShipped.b) > 0.01;
    console.log(
      `  src/cost.ts ships a ${CALIBRATION.a.toFixed(2)}, b ${CALIBRATION.b.toFixed(2)} from real/${shippedFrom}, ` +
        `which now fits a ${onShipped.a.toFixed(2)}, b ${onShipped.b.toFixed(2)}` +
        (drifted ? "  <- DRIFTED" : "  (unchanged)"),
    );
    console.log(
      `  the two records do not agree with each other: ten draws fit a ${onShipped.a.toFixed(2)} against ` +
        `${model.a.toFixed(2)} here, and §B4 below is fitted per diff anyway.`,
    );
  }

  // ------------------------------------------------ the floor, as a per-task cutoff
  console.log("");
  console.log("-".repeat(104));
  console.log("  B3. WHAT THAT MAKES THE FLOOR -- the score each recipe has to reach, from its own measured cost");
  console.log("");
  const penalties = [60, 300, 1800];
  console.log(`  ${pad("goal", 22)}${"cost".padStart(7)}   ${penalties.map((p) => `penalty ${p}s`.padStart(14)).join("")}`);
  for (const task of [...goals].sort((a, b) => a.cost - b.cost)) {
    const cells = penalties.map((penalty) => {
      const need = task.cost / penalty;
      const at = logisticValueAt(model, need);
      return (need >= 1 ? "always" : at <= 0 ? "always" : at.toFixed(2)).padStart(14);
    });
    console.log(`  ${pad(task.name, 22)}${`${task.cost.toFixed(1)}s`.padStart(7)}   ${cells.join("")}`);
  }
  console.log("");
  console.log("  Read a column downwards: a 0.1-second recipe is worth running on almost any suspicion, a");
  console.log("  12.8-second build has to be argued for. docs/23's \"ten seconds is free\" is the same idea");
  console.log("  with one number for every recipe; this is the number each recipe's own cost implies.");

  // ------------------------------------------------------------------ strategies
  console.log("");
  console.log("-".repeat(104));
  console.log("  B4. WHAT EACH RULE ACTUALLY RUNS (leave-one-diff-out for everything that is fitted)");
  console.log("");
  console.log(
    `  ${pad("rule", 38)}${"caught".padStart(8)}${"machine".padStart(10)}${"saved".padStart(8)}` +
      `${"on no-op diffs".padStart(16)}`,
  );
  const show = (label: string, s: { caught: number; of: number; serial: number; serialClean: number }): void => {
    console.log(
      `  ${pad(label, 38)}${`${s.caught}/${s.of}`.padStart(8)}${dur(s.serial).padStart(10)}` +
        `${pct(1 - s.serial / all.serial).padStart(8)}${dur(s.serialClean).padStart(16)}`,
    );
  };
  const scenarioOf = new Map(runs.map((r) => [r.mutation.id, asScenario(r)]));
  show("all (the ci recipe)", score(data, () => all));
  show("static (inputs + deps)", score(data, (r) => staticAffected(graph, scenarioOf.get(r.id)!)));
  show("globs only (no deps)", score(data, (r) => globsOnly(graph, scenarioOf.get(r.id)!)));
  console.log("");
  for (const t of [1.0, 1.25, 1.5]) {
    show(`one cutoff, score >= ${t}`, score(data, (r) => planFromScores(graph, r.scores, t)));
  }
  show("score >= 1.0, floor 1s (docs/23 §12)", score(data, (r) => planCostAware(graph, r.scores, 1.0, 1)));
  console.log("");
  // Leave-one-diff-out: the model that decides a diff never saw that diff.
  const fitWithout = new Map<string, Logistic>();
  for (const id of ids) {
    const rest = new Set([...ids].filter((x) => x !== id));
    fitWithout.set(id, logisticFit(pairs(data, rest), { ridge: 1 }));
  }
  const withJev = (penalty: number, exactUpTo?: number) => (row: Row): Plan =>
    planLeastLoss(graph, row.scores, penalty, fitWithout.get(row.id)!, exactUpTo);
  for (const penalty of [15, 30, 60, 120, 300, 1800]) {
    show(`least expected loss, penalty ${penalty}s`, score(data, withJev(penalty)));
  }
  // Solving the same model less well, to see how much of the result is the
  // optimiser: `exactUpTo 0` forces the single-goal climb the exact search
  // replaced.
  show("the same, single-move climb, 60s", score(data, withJev(60, 0)));
  console.log("");
  // The control docs/07 insisted on: the same machinery with the judgment
  // removed. Every goal gets the base rate, so the rule still knows the costs
  // and the graph and still picks a cheap set -- just the same one every time.
  const base = allPairs.filter((p) => p.y).length / allPairs.length;
  for (const penalty of [60, 300]) {
    // Same machinery, same graph and costs, every score replaced by the one
    // that makes p equal to the base rate.
    const flatScore = logisticValueAt(model, base);
    const flat: Record<string, number> = {};
    for (const task of goals) flat[task.name] = flatScore;
    const fixed = planLeastLoss(graph, flat, penalty, model);
    show(`same rule, no Jev (p = ${base.toFixed(3)} flat), ${penalty}s`, score(data, () => fixed));
  }
  console.log("");
  console.log("  The penalty is the only free parameter left, and it is a number about the project rather");
  console.log("  than about the model: what a missed red check costs. Everything else -- the per-recipe");
  console.log("  cutoff, the floor, which cheap recipes ride along -- comes out of the graph and the costs.");
  console.log("  The last block is the control: the same loss model, the same graph and costs, with the");
  console.log("  per-diff judgment replaced by the base rate.");
}
