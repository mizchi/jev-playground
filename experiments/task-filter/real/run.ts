/**
 * The real-repository measurement: same filter, real diffs, observed labels.
 *
 *   npx tsx real/run.ts                 # asks Jev once per diff
 *   npx tsx real/run.ts --repeat 3
 *   npx tsx real/run.ts --replay        # re-analyse real/scores.json, no API
 *
 * Needs real/runs.json first (npx tsx real/observe-mutations.ts), which is
 * where the labels come from. Nothing in here decides what should have failed:
 * `failing` is read off the recorded exit codes.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Jev, noul, score } from "../../shared/jev.js";
import { ALL_WASTE, ARM_BLURB, BEHAVIOUR, questionsFor, stateFor, type ArmName } from "../src/arms.js";
import { loadGraph, TaskGraph } from "../src/graph.js";
import type { Run } from "../src/observe.js";
import type { ChangedFile, Scenario } from "../src/scenarios.js";
import {
  caught,
  globsOnly,
  plan,
  planAll,
  planCostAware,
  planFromScores,
  staticAffected,
  type Plan,
} from "../src/select.js";
import type { Mutation } from "./mutations.js";

const HERE = import.meta.dirname;
const REPO = resolve(HERE, "../../..");

const ARGS = process.argv.slice(2);
const flag = (n: string) => ARGS.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = ARGS.indexOf(`--${n}`);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d;
};

const REPEATS = Number(opt("repeat", "3"));
const ARM = opt("arm", "diff") as ArmName;
const THRESHOLDS = [0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
const DEFAULT_T = Number(opt("threshold", "1.0"));
const FREE_UNDER = Number(opt("free-under", "1"));

interface MutationRun {
  mutation: Mutation;
  files: ChangedFile[];
  run: Run;
}

interface Row {
  id: string;
  arm: ArmName;
  repeat: number;
  scores: Record<string, number>;
  confidence: Record<string, number>;
  behaviour: number;
  allWaste: number;
  ms: number;
  inputTokens: number;
}

const graph = new TaskGraph(loadGraph(REPO, resolve(HERE, "graph.json")));
const runs = JSON.parse(readFileSync(resolve(HERE, "runs.json"), "utf8")) as MutationRun[];

/** The filter's input, in the shape arms.ts already knows how to render. */
function asScenario(m: MutationRun): Scenario {
  return {
    id: m.mutation.id,
    branch: m.mutation.branch,
    subject: m.mutation.subject,
    files: m.files,
    // There is no declared defect here on purpose: the label is the exit code.
    defect: null,
    shape: "narrow",
  };
}

/** Observed, not derived: the recipes whose exit code was non-zero. */
const failingById = new Map(
  runs.map((r) => [
    r.mutation.id,
    new Set(r.run.observations.filter((o) => o.status === "fail").map((o) => o.task)),
  ]),
);
/** Recipes that never ran because a prerequisite failed. */
const blockedById = new Map(
  runs.map((r) => [
    r.mutation.id,
    new Set(r.run.observations.filter((o) => o.status === "blocked").map((o) => o.task)),
  ]),
);

const ALL = planAll(graph);
const BREAKING = runs.filter((r) => failingById.get(r.mutation.id)!.size > 0);
const CLEAN = runs.filter((r) => failingById.get(r.mutation.id)!.size === 0);

const dur = (s: number) => `${s.toFixed(1).padStart(5)}s`;
const pct = (x: number) => `${(x * 100).toFixed(1).padStart(5)}%`;

interface Summary {
  label: string;
  caught: number;
  of: number;
  serial: number;
  wall: number;
  serialClean: number;
  tasks: number;
}

function summarise(label: string, plans: { id: string; plan: Plan }[]): Summary {
  const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
  const breaking = plans.filter((p) => failingById.get(p.id)!.size > 0);
  const clean = plans.filter((p) => failingById.get(p.id)!.size === 0);
  return {
    label,
    caught: breaking.filter((p) => caught(p.plan, failingById.get(p.id)!)).length,
    of: breaking.length,
    serial: mean(plans.map((p) => p.plan.serial)),
    wall: mean(plans.map((p) => p.plan.wall)),
    serialClean: mean(clean.map((p) => p.plan.serial)),
    tasks: mean(plans.map((p) => p.plan.run.length)),
  };
}

function line(s: Summary): string {
  return (
    `  ${s.label.padEnd(24)} caught ${String(s.caught).padStart(2)}/${s.of}  ` +
    `machine ${dur(s.serial)} (${pct(1 - s.serial / ALL.serial)} saved)  ` +
    `wall ${dur(s.wall)}  ${s.tasks.toFixed(1).padStart(4)} tasks  ` +
    `no-op edits ${dur(s.serialClean)}`
  );
}

async function collect(jev: Jev, repeat: number): Promise<Row[]> {
  const questions = questionsFor(ARM, graph);
  const rows: Row[] = [];
  for (const m of runs) {
    const started = Date.now();
    const res = await jev.ask(stateFor(ARM, asScenario(m), true), questions);
    const scores: Record<string, number> = {};
    const confidence: Record<string, number> = {};
    for (const t of graph.goals()) {
      const a = score(res.answers[t.name]);
      scores[t.name] = a.score;
      confidence[t.name] = a.confidence;
    }
    rows.push({
      id: m.mutation.id,
      arm: ARM,
      repeat,
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

function analyse(rows: Row[], jev?: Jev): void {
  console.log("");
  console.log("=".repeat(104));
  console.log("  0. WHAT THE EDITS ACTUALLY BROKE — the labels, from exit codes");
  console.log("");
  console.log(`  ${"edit".padEnd(30)}${"files".padStart(6)}  failed (blocked)`);
  for (const r of runs) {
    const f = failingById.get(r.mutation.id)!;
    const b = blockedById.get(r.mutation.id)!;
    console.log(
      `  ${r.mutation.id.padEnd(30)}${String(r.files.length).padStart(6)}  ` +
        (f.size === 0
          ? "— nothing"
          : `${[...f].join(" ")}${b.size > 0 ? `   (blocked: ${[...b].join(" ")})` : ""}`),
    );
  }
  console.log("");
  console.log(
    `  ${BREAKING.length} of ${runs.length} edits break something; ` +
      `${CLEAN.length} break nothing. Whole suite: ${ALL.run.length} recipes, ` +
      `${ALL.serial.toFixed(1)}s machine / ${ALL.wall.toFixed(1)}s wall`,
  );

  console.log("");
  console.log("-".repeat(104));
  console.log("  1. BASELINES — no API");
  console.log("");
  console.log(line(summarise("all (the ci recipe)", runs.map((r) => ({ id: r.mutation.id, plan: ALL })))));
  console.log(
    line(
      summarise(
        "static (inputs + deps)",
        runs.map((r) => ({ id: r.mutation.id, plan: staticAffected(graph, asScenario(r)) })),
      ),
    ),
  );
  console.log(
    line(
      summarise(
        "globs only (no deps)",
        runs.map((r) => ({ id: r.mutation.id, plan: globsOnly(graph, asScenario(r)) })),
      ),
    ),
  );
  console.log(
    line(summarise("nothing", runs.map((r) => ({ id: r.mutation.id, plan: plan(graph, []) })))),
  );

  if (rows.length === 0) return;

  console.log("");
  console.log("-".repeat(104));
  console.log(`  2. THE FILTER — ${ARM} arm, ${rows.length / runs.length} repeat(s)`);
  console.log("");
  for (const t of [DEFAULT_T]) {
    console.log(
      line(
        summarise(
          `jev >= ${t}`,
          rows.map((r) => ({ id: r.id, plan: planFromScores(graph, r.scores, t) })),
        ),
      ),
    );
    console.log(
      line(
        summarise(
          `jev >= ${t}, floor ${FREE_UNDER}s`,
          rows.map((r) => ({ id: r.id, plan: planCostAware(graph, r.scores, t, FREE_UNDER) })),
        ),
      ),
    );
  }

  console.log("");
  console.log("-".repeat(104));
  console.log("  3. THE CURVE");
  console.log("");
  console.log(`  ${"threshold".padEnd(12)}${"caught".padStart(9)}${"machine".padStart(10)}${"saved".padStart(9)}${"tasks".padStart(8)}   with a ${FREE_UNDER}s floor`);
  for (const t of THRESHOLDS) {
    const bare = summarise("", rows.map((r) => ({ id: r.id, plan: planFromScores(graph, r.scores, t) })));
    const floored = summarise(
      "",
      rows.map((r) => ({ id: r.id, plan: planCostAware(graph, r.scores, t, FREE_UNDER) })),
    );
    console.log(
      `  ${t.toFixed(2).padEnd(12)}${`${bare.caught}/${bare.of}`.padStart(9)}` +
        `${dur(bare.serial).padStart(10)}${pct(1 - bare.serial / ALL.serial).padStart(9)}` +
        `${bare.tasks.toFixed(1).padStart(8)}   ` +
        `${`${floored.caught}/${floored.of}`.padStart(7)} ${dur(floored.serial)} ${pct(1 - floored.serial / ALL.serial)}`,
    );
  }

  console.log("");
  console.log("-".repeat(104));
  console.log(`  4. MISSES — an edit whose failing recipe the filter skipped (t=${DEFAULT_T})`);
  console.log("");
  let misses = 0;
  for (const r of rows) {
    const failing = failingById.get(r.id)!;
    if (failing.size === 0) continue;
    const p = planFromScores(graph, r.scores, DEFAULT_T);
    if (caught(p, failing)) continue;
    misses += 1;
    const scored = [...failing]
      .filter((n) => r.scores[n] !== undefined)
      .map((n) => `${n} ${r.scores[n].toFixed(2)}`);
    console.log(
      `  ${r.id.padEnd(30)} run ${r.repeat + 1}  needed one of {${[...failing].join(", ")}}`,
    );
    console.log(
      `  ${"".padEnd(30)} scored: ${scored.length > 0 ? scored.join(", ") : "none of them is a goal"}`,
    );
  }
  if (misses === 0) console.log("  none.");

  console.log("");
  console.log("-".repeat(104));
  console.log("  5. PER EDIT — what it cost and whether the failure was caught");
  console.log("");
  console.log(`  ${"edit".padEnd(30)}${"static".padStart(8)}${"jev".padStart(8)}${"caught".padStart(9)}  selected`);
  for (const r of runs) {
    const mine = rows.filter((x) => x.id === r.mutation.id);
    if (mine.length === 0) continue;
    const failing = failingById.get(r.mutation.id)!;
    const cost = mine.reduce((a, x) => a + planFromScores(graph, x.scores, DEFAULT_T).serial, 0) / mine.length;
    const hit = mine.filter((x) => caught(planFromScores(graph, x.scores, DEFAULT_T), failing)).length;
    const picked = [...new Set(mine.flatMap((x) => planFromScores(graph, x.scores, DEFAULT_T).selected))];
    console.log(
      `  ${r.mutation.id.padEnd(30)}${dur(staticAffected(graph, asScenario(r)).serial).padStart(8)}` +
        `${dur(cost).padStart(8)}${(failing.size === 0 ? "   (no-op)" : `${hit}/${mine.length}`).padStart(9)}  ` +
        picked.join(" ").slice(0, 60),
    );
  }

  console.log("");
  console.log("-".repeat(104));
  console.log("  6. THE TWO WHOLE-DIFF JUDGMENTS");
  console.log("");
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const br = rows.filter((r) => failingById.get(r.id)!.size > 0);
  const cl = rows.filter((r) => failingById.get(r.id)!.size === 0);
  console.log(
    `  p(alters behaviour)   breaking ${mean(br.map((r) => r.behaviour)).toFixed(3)}   ` +
      `no-op ${mean(cl.map((r) => r.behaviour)).toFixed(3)}`,
  );
  console.log(
    `  p(nothing needs run)  breaking ${mean(br.map((r) => r.allWaste)).toFixed(3)}   ` +
      `no-op ${mean(cl.map((r) => r.allWaste)).toFixed(3)}`,
  );
  for (const t of [0.3, 0.4, 0.5]) {
    console.log(
      `    p >= ${t}: fires on ${cl.filter((r) => r.allWaste >= t).length}/${cl.length} no-op edits, ` +
        `${br.filter((r) => r.allWaste >= t).length}/${br.length} breaking ones`,
    );
  }

  if (jev && jev.calls > 0) {
    const perRun = jev.inputTokens / jev.calls;
    const filterCost = jev.totalMs / jev.calls / 1000;
    const saved = ALL.serial - summarise("", rows.map((r) => ({ id: r.id, plan: planFromScores(graph, r.scores, DEFAULT_T) }))).serial;
    console.log("");
    console.log("-".repeat(104));
    console.log(
      `  ${jev.calls} requests · ${jev.inputTokens} input tokens · ` +
        `$${((jev.inputTokens / 1e6) * 0.042).toFixed(4)} · ` +
        `${perRun.toFixed(0)} tokens and ${filterCost.toFixed(2)}s per diff`,
    );
    console.log(
      `  the filter costs ${filterCost.toFixed(2)}s and saves ${saved.toFixed(1)}s per diff, ` +
        `so it pays for itself ${(saved / filterCost).toFixed(0)}x over — on a suite this small, ` +
        `in absolute terms that is ${saved.toFixed(0)} seconds`,
    );
  }
  console.log("");
}

async function main(): Promise<void> {
  const out = resolve(HERE, "scores.json");
  if (flag("replay")) {
    if (!existsSync(out)) throw new Error(`no ${out}; run without --replay first`);
    analyse(JSON.parse(readFileSync(out, "utf8")) as Row[]);
    return;
  }
  console.log(
    `  ${graph.goals().length} goals scored per request, ${runs.length} real diffs, ` +
      `${REPEATS} repeat(s), arm: ${ARM} (${ARM_BLURB[ARM]})`,
  );
  const jev = new Jev();
  const rows: Row[] = [];
  for (let r = 0; r < REPEATS; r += 1) {
    const got = await collect(jev, r);
    rows.push(...got);
    const s = summarise("", got.map((x) => ({ id: x.id, plan: planFromScores(graph, x.scores, DEFAULT_T) })));
    console.log(`    run ${r + 1}: caught ${s.caught}/${s.of}, ${s.serial.toFixed(1)}s mean machine time`);
  }
  writeFileSync(out, JSON.stringify(rows, null, 2) + "\n");
  analyse(rows, jev);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
