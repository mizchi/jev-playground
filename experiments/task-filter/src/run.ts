/**
 * The measurement: does a per-task score, read off one Jev request, pick a
 * cheaper run set than the dependency graph alone without letting a defect
 * through?
 *
 *   npx tsx src/run.ts                          # every arm, 3 repeats
 *   npx tsx src/run.ts --arms diff --repeat 5
 *   npx tsx src/run.ts --no-intent              # drop the branch and subject
 *   npx tsx src/run.ts --replay                 # re-analyse saved rows, no API key
 *   npx tsx src/run.ts --replay transcripts/raw.jsonl --threshold 1.25
 *
 * `--replay` with no path takes out/raw.jsonl when a run has produced one, and
 * otherwise the committed transcripts/ rows that docs/23 is written from.
 *
 * Collection and analysis are separate on purpose: every number in docs/23
 * comes out of `analyse()` over those saved rows, so a different threshold or a
 * new strategy costs no requests at all.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Jev, noul, score } from "../../shared/jev.js";
import { ALL_WASTE, ARM_BLURB, ARMS, BEHAVIOUR, questionsFor, stateFor, type ArmName } from "./arms.js";
import { loadGraph, ROOT, TaskGraph } from "./graph.js";
import { failingTasks, unwinnable } from "./oracle.js";
import {
  caught,
  globsOnly,
  plan,
  planAll,
  planCostAware,
  planFromScores,
  planPruned,
  staticAffected,
  wasted,
  type Plan,
} from "./select.js";
import { SCENARIOS, WITH_DEFECT, type Scenario } from "./scenarios.js";

const ARGS = process.argv.slice(2);
const flag = (name: string) => ARGS.includes(`--${name}`);
const opt = (name: string, fallback: string) => {
  const i = ARGS.indexOf(`--${name}`);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : fallback;
};

const REPEATS = Number(opt("repeat", "3"));
const SELECTED = (opt("arms", ARMS.join(",")).split(",") as ArmName[]).filter((a) => a.length > 0);
const INTENT = !flag("no-intent");
const MAIN: ArmName = SELECTED.includes("diff") ? "diff" : SELECTED[0];
const THRESHOLDS = [0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
const DEFAULT_T = Number(opt("threshold", "1.0"));
// A task this cheap is rounding error; the cost-aware sweep never skips one.
const FREE_UNDER = Number(opt("free-under", "10"));
// Ablations write elsewhere so they never clobber the main corpus.
const RAW = opt("out", `${ROOT}/out/raw${INTENT ? "" : "-no-intent"}.jsonl`);
// The committed rows behind docs/23, so a fresh checkout can replay without a key.
const TRANSCRIPT = `${ROOT}/transcripts/raw${INTENT ? "" : "-no-intent"}.jsonl`;

const graph = new TaskGraph(loadGraph(ROOT));

/** One scenario, one arm, one repeat. Everything the analysis needs. */
interface Row {
  arm: ArmName;
  repeat: number;
  intent: boolean;
  scenario: string;
  scores: Record<string, number>;
  confidence: Record<string, number>;
  behaviour: number;
  allWaste: number;
  ms: number;
  inputTokens: number;
}

// ---------------------------------------------------------------- collection

async function collect(jev: Jev, arm: ArmName, repeat: number): Promise<Row[]> {
  const rows: Row[] = [];
  const questions = questionsFor(arm, graph);
  for (const scenario of SCENARIOS) {
    const started = Date.now();
    const res = await jev.ask(stateFor(arm, scenario, INTENT), questions);
    const scores: Record<string, number> = {};
    const confidence: Record<string, number> = {};
    for (const task of graph.goals()) {
      const a = score(res.answers[task.name]);
      scores[task.name] = a.score;
      confidence[task.name] = a.confidence;
    }
    rows.push({
      arm,
      repeat,
      intent: INTENT,
      scenario: scenario.id,
      scores,
      confidence,
      behaviour: noul(res.answers[BEHAVIOUR]),
      allWaste: noul(res.answers[ALL_WASTE]),
      ms: Date.now() - started,
      inputTokens: res.usage.input_tokens,
    });
  }
  return rows;
}

// ---------------------------------------------------------------- analysis

const scenarioById = new Map(SCENARIOS.map((s) => [s.id, s]));
const failingById = new Map(SCENARIOS.map((s) => [s.id, failingTasks(graph, s)]));

interface Summary {
  label: string;
  /** Defect scenarios where something in the run set goes red. */
  caught: number;
  of: number;
  /** Mean machine seconds and mean critical path, over every scenario. */
  serial: number;
  wall: number;
  /** Mean machine seconds on the scenarios that break nothing. */
  serialClean: number;
  tasks: number;
}

function summarise(label: string, plans: { scenario: Scenario; plan: Plan }[]): Summary {
  const defective = plans.filter((p) => p.scenario.defect !== null);
  const clean = plans.filter((p) => p.scenario.defect === null);
  const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
  return {
    label,
    caught: defective.filter((p) => caught(p.plan, failingById.get(p.scenario.id)!)).length,
    of: defective.length,
    serial: mean(plans.map((p) => p.plan.serial)),
    wall: mean(plans.map((p) => p.plan.wall)),
    serialClean: mean(clean.map((p) => p.plan.serial)),
    tasks: mean(plans.map((p) => p.plan.run.length)),
  };
}

const ALL = planAll(graph);

function jevPlans(rows: Row[], threshold: number, pruned: boolean) {
  return rows.map((r) => {
    const scenario = scenarioById.get(r.scenario)!;
    return {
      scenario,
      plan: pruned
        ? planPruned(graph, scenario, r.scores, threshold)
        : planFromScores(graph, r.scores, threshold),
    };
  });
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "  n/a" : `${((part / whole) * 100).toFixed(1).padStart(5)}%`;
}

function mins(seconds: number): string {
  return `${(seconds / 60).toFixed(1).padStart(6)}m`;
}

function line(s: Summary): string {
  const saved = 1 - s.serial / ALL.serial;
  return (
    `  ${s.label.padEnd(26)} caught ${String(s.caught).padStart(2)}/${s.of}  ` +
    `machine ${mins(s.serial)} (${pct(saved, 1).trim().padStart(6)} saved)  ` +
    `wall ${mins(s.wall)}  ${s.tasks.toFixed(1).padStart(4)} tasks  ` +
    `clean-diff ${mins(s.serialClean)}`
  );
}

function analyse(rows: Row[], jev?: Jev): void {
  const armsPresent = SELECTED.filter((a) => rows.some((r) => r.arm === a));

  console.log("");
  console.log("=".repeat(104));
  console.log(`  0. THE GRAPH — from ${graph.source}`);
  console.log("");
  console.log(
    `  ${graph.tasks.length} recipes, ${graph.goals().length} of them goals ` +
      `(nothing else depends on them; the rest arrive through the closure)`,
  );
  console.log(
    `  run everything: ${ALL.run.length} tasks, ${mins(ALL.serial)} of machine time, ` +
      `${mins(ALL.wall)} of wall clock on the critical path`,
  );
  const broken = unwinnable(graph, SCENARIOS);
  console.log(
    `  corpus: ${SCENARIOS.length} branches, ${WITH_DEFECT.length} with a planted defect, ` +
      `${SCENARIOS.length - WITH_DEFECT.length} that break nothing` +
      (broken.length > 0 ? `  !! ${broken.length} unwinnable: ${broken.map((s) => s.id)}` : ""),
  );

  console.log("");
  console.log("-".repeat(104));
  console.log("  1. BASELINES — no API. What the graph alone can do.");
  console.log("");
  const staticPlans = SCENARIOS.map((s) => ({ scenario: s, plan: staticAffected(graph, s) }));
  const globPlans = SCENARIOS.map((s) => ({ scenario: s, plan: globsOnly(graph, s) }));
  console.log(line(summarise("all (the ci recipe)", SCENARIOS.map((s) => ({ scenario: s, plan: ALL })))));
  console.log(line(summarise("static (inputs + deps)", staticPlans)));
  console.log(line(summarise("globs only (no deps)", globPlans)));
  console.log(line(summarise("nothing", SCENARIOS.map((s) => ({ scenario: s, plan: plan(graph, []) })))));

  console.log("");
  console.log("-".repeat(104));
  console.log(`  2. THE FILTER — one request per branch, score >= ${DEFAULT_T} runs`);
  console.log("");
  for (const arm of armsPresent) {
    const rs = rows.filter((r) => r.arm === arm);
    console.log(line(summarise(arm, jevPlans(rs, DEFAULT_T, false))));
  }
  console.log("");
  console.log("  ...and the same scores used only to prune the static set (never to add):");
  for (const arm of armsPresent) {
    const rs = rows.filter((r) => r.arm === arm);
    console.log(line(summarise(`${arm} ∩ static`, jevPlans(rs, DEFAULT_T, true))));
  }

  console.log("");
  console.log("-".repeat(104));
  console.log(`  3. THE CURVE — ${MAIN} arm, threshold swept. This is the whole trade-off.`);
  console.log("");
  const mainRows = rows.filter((r) => r.arm === MAIN);
  if (mainRows.length > 0) {
    console.log(`  ${"threshold".padEnd(12)}${"caught".padStart(10)}${"machine".padStart(12)}${"saved".padStart(9)}${"wall".padStart(10)}${"tasks".padStart(8)}`);
    for (const t of THRESHOLDS) {
      const s = summarise(String(t), jevPlans(mainRows, t, false));
      console.log(
        `  ${t.toFixed(2).padEnd(12)}${`${s.caught}/${s.of}`.padStart(10)}${mins(s.serial).padStart(12)}` +
          `${pct(1 - s.serial / ALL.serial, 1).padStart(9)}${mins(s.wall).padStart(10)}${s.tasks.toFixed(1).padStart(8)}`,
      );
    }
  }

  console.log("");
  console.log(`  ...and the same sweep with a floor: a task costing <= ${FREE_UNDER}s always runs.`);
  console.log("");
  if (mainRows.length > 0) {
    console.log(`  ${"threshold".padEnd(12)}${"caught".padStart(10)}${"machine".padStart(12)}${"saved".padStart(9)}${"wall".padStart(10)}${"tasks".padStart(8)}`);
    for (const t of THRESHOLDS) {
      const plans = mainRows.map((r) => ({
        scenario: scenarioById.get(r.scenario)!,
        plan: planCostAware(graph, r.scores, t, FREE_UNDER),
      }));
      const s = summarise(String(t), plans);
      console.log(
        `  ${t.toFixed(2).padEnd(12)}${`${s.caught}/${s.of}`.padStart(10)}${mins(s.serial).padStart(12)}` +
          `${pct(1 - s.serial / ALL.serial, 1).padStart(9)}${mins(s.wall).padStart(10)}${s.tasks.toFixed(1).padStart(8)}`,
      );
    }
  }

  console.log("");
  console.log("-".repeat(104));
  console.log(`  4. MISSES — a defect nothing in the run set would have caught (${MAIN}, t=${DEFAULT_T})`);
  console.log("");
  let misses = 0;
  for (const r of mainRows) {
    const scenario = scenarioById.get(r.scenario)!;
    if (!scenario.defect) continue;
    const failing = failingById.get(scenario.id)!;
    const p = planFromScores(graph, r.scores, DEFAULT_T);
    if (caught(p, failing)) continue;
    misses += 1;
    const best = [...failing]
      .map((n) => ({ n, s: r.scores[n] }))
      .filter((x) => x.s !== undefined)
      .sort((a, b) => b.s - a.s);
    console.log(
      `  ${scenario.id.padEnd(24)} run ${r.repeat + 1}  needed one of {${[...failing].join(", ")}}`,
    );
    console.log(
      `    ${"".padEnd(22)} highest-scored of those: ` +
        (best.length > 0
          ? best.map((x) => `${x.n} ${x.s.toFixed(2)}`).join(", ")
          : "none of them is a goal; only reachable as a prerequisite"),
    );
    console.log(`    ${"".padEnd(22)} ${scenario.defect.why}`);
  }
  if (misses === 0) console.log("  none.");

  console.log("");
  console.log("-".repeat(104));
  console.log("  5. CHANGES THAT BREAK NOTHING — every second spent here is spent to learn nothing");
  console.log("");
  const cleanScenarios = SCENARIOS.filter((s) => s.defect === null);
  console.log(`  ${"branch".padEnd(24)}${"all".padStart(9)}${"static".padStart(9)}${armsPresent.map((a) => a.padStart(12)).join("")}`);
  for (const s of cleanScenarios) {
    const cells = armsPresent.map((arm) => {
      const rs = rows.filter((r) => r.arm === arm && r.scenario === s.id);
      const mean =
        rs.reduce((a, r) => a + planFromScores(graph, r.scores, DEFAULT_T).serial, 0) /
        Math.max(rs.length, 1);
      return mins(mean).padStart(12);
    });
    console.log(
      `  ${s.id.padEnd(24)}${mins(ALL.serial).padStart(9)}` +
        `${mins(staticAffected(graph, s).serial).padStart(9)}${cells.join("")}`,
    );
  }

  console.log("");
  console.log("  ...and where the time goes on the branches that do break something:");
  console.log("");
  console.log(`  ${"branch".padEnd(24)}${"static".padStart(9)}${`${MAIN}@${DEFAULT_T}`.padStart(11)}${"caught".padStart(9)}  the failing tasks`);
  for (const s of SCENARIOS) {
    if (!s.defect) continue;
    const rs = mainRows.filter((r) => r.scenario === s.id);
    if (rs.length === 0) continue;
    const failing = failingById.get(s.id)!;
    const cost = rs.reduce((a, r) => a + planFromScores(graph, r.scores, DEFAULT_T).serial, 0) / rs.length;
    const hit = rs.filter((r) => caught(planFromScores(graph, r.scores, DEFAULT_T), failing)).length;
    console.log(
      `  ${s.id.padEnd(24)}${mins(staticAffected(graph, s).serial).padStart(9)}${mins(cost).padStart(11)}` +
        `${`${hit}/${rs.length}`.padStart(9)}  ${[...failing].join(" ")}`,
    );
  }

  console.log("");
  console.log("-".repeat(104));
  console.log("  6. THE TWO WHOLE-DIFF JUDGMENTS — what no glob can answer");
  console.log("");
  console.log(`  ${"arm".padEnd(12)}${"p(behaviour) defect".padStart(22)}${"clean".padStart(10)}${"p(all_waste) defect".padStart(22)}${"clean".padStart(10)}`);
  for (const arm of armsPresent) {
    const rs = rows.filter((r) => r.arm === arm);
    const m = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const d = rs.filter((r) => scenarioById.get(r.scenario)!.defect !== null);
    const c = rs.filter((r) => scenarioById.get(r.scenario)!.defect === null);
    console.log(
      `  ${arm.padEnd(12)}${m(d.map((r) => r.behaviour)).toFixed(3).padStart(22)}` +
        `${m(c.map((r) => r.behaviour)).toFixed(3).padStart(10)}` +
        `${m(d.map((r) => r.allWaste)).toFixed(3).padStart(22)}` +
        `${m(c.map((r) => r.allWaste)).toFixed(3).padStart(10)}`,
    );
  }

  console.log("");
  console.log(`  ...and p(all_waste) used on its own as a "run nothing at all" gate (${MAIN}):`);
  console.log("");
  for (const t of [0.3, 0.4, 0.5, 0.6]) {
    let firedClean = 0;
    let clean = 0;
    let firedDefect = 0;
    let defect = 0;
    for (const r of mainRows) {
      if (scenarioById.get(r.scenario)!.defect) {
        defect += 1;
        if (r.allWaste >= t) firedDefect += 1;
      } else {
        clean += 1;
        if (r.allWaste >= t) firedClean += 1;
      }
    }
    console.log(
      `  p >= ${t.toFixed(2)}  fires on ${String(firedClean).padStart(2)}/${clean} branches that break nothing, ` +
        `and on ${String(firedDefect).padStart(2)}/${defect} that do` +
        (firedDefect > 0 ? "  <- would have skipped a real failure" : ""),
    );
  }

  console.log("");
  console.log("-".repeat(104));
  console.log(`  7. BY SHAPE — caught, ${MAIN} arm at t=${DEFAULT_T}`);
  console.log("");
  for (const shape of ["narrow", "broad", "cosmetic"] as const) {
    const rs = mainRows.filter((r) => {
      const s = scenarioById.get(r.scenario)!;
      return s.shape === shape && s.defect !== null;
    });
    if (rs.length === 0) {
      console.log(`  ${shape.padEnd(10)} no defect scenarios of this shape`);
      continue;
    }
    const hit = rs.filter((r) =>
      caught(planFromScores(graph, r.scores, DEFAULT_T), failingById.get(r.scenario)!),
    ).length;
    console.log(`  ${shape.padEnd(10)} ${hit}/${rs.length}`);
  }

  if (jev && jev.calls > 0) {
    console.log("");
    console.log("-".repeat(104));
    const perRun = jev.inputTokens / jev.calls;
    const savedPerBranch =
      ALL.serial -
      summarise("", jevPlans(mainRows, DEFAULT_T, false)).serial;
    console.log(
      `  ${jev.calls} requests · ${jev.inputTokens} input tokens · ` +
        `$${((jev.inputTokens / 1e6) * 0.042).toFixed(4)} total · ` +
        `${perRun.toFixed(0)} tokens and ${(jev.totalMs / jev.calls / 1000).toFixed(2)}s per branch` +
        (jev.retriedCalls > 0 ? ` · ${jev.retriedCalls} retried` : ""),
    );
    console.log(
      `  the filter costs ${(jev.totalMs / jev.calls / 1000).toFixed(2)}s and ` +
        `$${((perRun / 1e6) * 0.042).toFixed(6)} per branch, and saves ` +
        `${(savedPerBranch / 60).toFixed(1)} machine minutes on the ${MAIN} arm`,
    );
  }
  console.log(`  raw rows: ${RAW}`);
  console.log("");
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  if (flag("replay")) {
    const given = ARGS[ARGS.indexOf("--replay") + 1];
    const path = given && !given.startsWith("--")
      ? given
      : existsSync(RAW)
        ? RAW
        : TRANSCRIPT;
    console.log(`  replaying ${path}`);
    const rows = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Row);
    analyse(rows);
    return;
  }

  console.log(`  ${graph.goals().length} goals scored per request, ${SCENARIOS.length} branches, ` +
    `${REPEATS} repeat(s), arms: ${SELECTED.join(", ")}${INTENT ? "" : " (no intent)"}`);
  const jev = new Jev();
  const rows: Row[] = [];
  for (const arm of SELECTED) {
    if (!ARMS.includes(arm)) throw new Error(`unknown arm '${arm}'`);
    process.stdout.write(`\n  ${arm}: ${ARM_BLURB[arm]}\n`);
    for (let r = 0; r < REPEATS; r += 1) {
      const got = await collect(jev, arm, r);
      rows.push(...got);
      const s = summarise("", got.map((x) => ({
        scenario: scenarioById.get(x.scenario)!,
        plan: planFromScores(graph, x.scores, DEFAULT_T),
      })));
      process.stdout.write(
        `    run ${r + 1}: caught ${s.caught}/${s.of}, ${mins(s.serial).trim()} mean machine time\n`,
      );
    }
  }
  mkdirSync(`${ROOT}/out`, { recursive: true });
  writeFileSync(RAW, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  analyse(rows, jev);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
