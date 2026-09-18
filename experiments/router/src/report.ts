/**
 * The tables, from the records, with no API key and no `claude -p`.
 *
 *   npx tsx src/report.ts
 *
 * Two records meet here. `labels.json` says which tier actually fixed each
 * task, measured by `node --test`. `asks.json` says what the router predicted
 * for the same tasks. Everything below is the join.
 *
 * The order of the sections is the order the questions have to be asked in,
 * and §1 comes first for a reason: docs/33 §1 measured the metrics-only
 * classifier before measuring whether handing the metrics over helped, and
 * found the answer already there. Here the equivalent is the base rate. If the
 * cheapest tier fixes everything, there is nothing to route, and no arm's
 * accuracy means anything.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  crossValidateLadder,
  fitLadder,
  fixedRungCost,
  rungFor,
  type LadderSample,
} from "../../../packages/jev-core/src/index.js";
import { separation, type Sample } from "../../shared/thresholds.js";
import { TIERS, type Attempt, type LabelRecord } from "./label.js";
import { ARM_BLURB, ARMS, type Arm, type AskRow } from "./ask.js";

const RECORDS = resolve(import.meta.dirname, "../records");

function read<T>(name: string): T | null {
  const path = resolve(RECORDS, name);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
}

const pct = (a: number, b: number): string => (b === 0 ? "   - " : `${((100 * a) / b).toFixed(0).padStart(3)}%`);

/** The lowest tier that fixed the task, or null when none did. */
export function cheapestOf(attempts: readonly Attempt[], task: string): number | null {
  for (const [i, tier] of TIERS.entries()) {
    const mine = attempts.filter((a) => a.task === task && a.tier === tier.label);
    if (mine.length > 0 && mine.some((a) => a.passed)) return i;
    // A tier that was SKIPPED because a cheaper one passed cannot appear here:
    // the cheaper one already returned. A tier with no attempt at all and no
    // cheaper success means the run is incomplete, which is not the same as
    // "no tier worked" -- so keep looking rather than concluding null.
  }
  const tried = new Set(attempts.filter((a) => a.task === task).map((a) => a.tier));
  return tried.size === TIERS.length ? null : undefined as unknown as null;
}

function reportBaseRate(labels: LabelRecord): Map<string, number | null> {
  const tasks = [...new Set(labels.attempts.map((a) => a.task))].sort();
  console.log(`\n§1 the base rate -- is there anything to route?\n`);
  console.log("  corpus  tier     attempted   fixed   untouched   mean s");
  for (const corpus of ["easy", "hard"] as const) {
    for (const tier of TIERS) {
      const mine = labels.attempts.filter((a) => a.corpus === corpus && a.tier === tier.label);
      if (mine.length === 0) continue;
      console.log(
        `  ${corpus.padEnd(7)} ${tier.label.padEnd(8)} ${String(mine.length).padStart(9)}   ` +
          `${pct(mine.filter((a) => a.passed).length, mine.length)}   ` +
          `${String(mine.filter((a) => a.untouched).length).padStart(9)}   ` +
          `${(mine.reduce((s, a) => s + a.ms, 0) / mine.length / 1000).toFixed(0).padStart(6)}`,
      );
    }
  }

  const cheapest = new Map<string, number | null>();
  for (const task of tasks) cheapest.set(task, cheapestOf(labels.attempts, task));
  console.log("\n  corpus   tasks   cheapest tier that worked");
  for (const corpus of ["easy", "hard"] as const) {
    const mine = tasks.filter((t) => labels.attempts.some((a) => a.task === t && a.corpus === corpus));
    if (mine.length === 0) continue;
    const counts = new Map<string, number>();
    for (const t of mine) {
      const c = cheapest.get(t);
      const key = c === null ? "none" : c === undefined ? "incomplete" : TIERS[c].label;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    console.log(
      `  ${corpus.padEnd(8)} ${String(mine.length).padStart(5)}   ` +
        [...counts].sort().map(([k, n]) => `${k} ${n}`).join(", "),
    );
  }
  const spread = new Set([...cheapest.values()].filter((v) => v !== undefined)).size;
  if (spread <= 1) {
    console.log(
      "\n  >> one rung serves every task. There is no routing decision on this corpus,\n" +
        "     and no arm's accuracy below would mean anything. The corpus is the finding.",
    );
  }
  return cheapest;
}

function reportArms(asks: { rows: AskRow[] }, cheapest: Map<string, number | null>): void {
  console.log(`\n§2 what the router sees -- does the answer move with the task at all?\n`);
  console.log("  arm       n   mean tier   within-task draw sd   across-task sd   tokens/req");
  for (const arm of ARMS) {
    const rows = asks.rows.filter((r) => r.arm === arm && Number.isFinite(r.tier));
    if (rows.length === 0) continue;
    const tasks = [...new Set(rows.map((r) => r.task))];
    // The two spreads are the whole section. A router needs the ACROSS-task
    // spread to exceed the WITHIN-task draw noise, or it is reporting noise.
    const within: number[] = [];
    const means: number[] = [];
    for (const task of tasks) {
      const mine = rows.filter((r) => r.task === task).map((r) => r.tier);
      const m = mine.reduce((a, b) => a + b, 0) / mine.length;
      means.push(m);
      if (mine.length > 1) within.push(Math.sqrt(mine.reduce((s, x) => s + (x - m) ** 2, 0) / (mine.length - 1)));
    }
    const sd = (xs: number[]): number => {
      if (xs.length < 2) return Number.NaN;
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
    };
    const drawSd = within.length > 0 ? within.reduce((a, b) => a + b, 0) / within.length : Number.NaN;
    console.log(
      `  ${arm.padEnd(8)} ${String(rows.length).padStart(3)}   ` +
        `${(means.reduce((a, b) => a + b, 0) / means.length).toFixed(2).padStart(9)}   ` +
        `${(Number.isNaN(drawSd) ? 0 : drawSd).toFixed(3).padStart(19)}   ` +
        `${sd(means).toFixed(3).padStart(14)}   ` +
        `${(rows.reduce((s, r) => s + r.inputTokens, 0) / rows.length).toFixed(0).padStart(10)}`,
    );
  }
  console.log(`\n  ${ARMS.map((a) => `${a}: ${ARM_BLURB[a]}`).join("\n  ")}`);
  void cheapest;
}

function reportSeparation(asks: { rows: AskRow[] }, cheapest: Map<string, number | null>): void {
  const usable = [...cheapest.entries()].filter(([, v]) => v !== undefined && v !== null);
  if (usable.length === 0) return;
  const rungs = new Set(usable.map(([, v]) => v));
  if (rungs.size < 2) return;

  const positives = usable.filter(([, v]) => (v as number) > 0).length;
  console.log(`\n§3 does the answer separate the tiers?\n`);
  if (positives < 5) {
    console.log(
      `  >> ${positives} of ${usable.length} tasks need more than the cheapest tier.\n` +
        "     An AUC over one or two positives is that task's draws, not a property of the arm,\n" +
        "     and the ordering below is not evidence about which arm reads the task better.\n",
    );
  }
  console.log("  arm        n   AUC(needs more than the cheapest)   mean score by cheapest tier");
  for (const arm of ARMS) {
    const rows = asks.rows.filter((r) => r.arm === arm && Number.isFinite(r.tier) && cheapest.get(r.task) != null);
    if (rows.length === 0) continue;
    const samples: Sample[] = rows.map((r) => ({
      value: r.tier,
      positive: (cheapest.get(r.task) as number) > 0,
      group: r.task,
    }));
    const sep = separation(samples);
    const byTier = TIERS.map((t, i) => {
      const mine = rows.filter((r) => cheapest.get(r.task) === i);
      return mine.length === 0 ? `${t.label} -` : `${t.label} ${(mine.reduce((s, r) => s + r.tier, 0) / mine.length).toFixed(2)}`;
    });
    console.log(
      `  ${arm.padEnd(8)} ${String(rows.length).padStart(4)}   ` +
        `${(sep.pos > 0 && sep.neg > 0 ? sep.auc.toFixed(3) : "  -  ").padStart(33)}   ${byTier.join("  ")}`,
    );
  }
}

function reportLadder(asks: { rows: AskRow[] }, cheapest: Map<string, number | null>): void {
  const rungs = TIERS.map((t) => ({ name: t.label, price: t.price }));
  const distinct = new Set([...cheapest.values()].filter((v) => v !== undefined && v !== null));
  if (distinct.size < 2) return;

  console.log(`\n§4 the cost ladder -- does a fitted cutoff beat always-cheap and always-dear?\n`);
  for (const penalty of [5, 20, 100]) {
    const cost = { failurePenalty: penalty };
    console.log(`  failurePenalty ${penalty}`);
    console.log("    arm        fitted   held out   always-haiku   always-opus   perfect   cuts");
    for (const arm of ARMS) {
      const samples: LadderSample[] = asks.rows
        .filter((r) => r.arm === arm && Number.isFinite(r.tier) && cheapest.get(r.task) !== undefined)
        .map((r) => ({ score: r.tier, cheapest: cheapest.get(r.task) as number | null, group: r.task }));
      if (samples.length === 0) continue;
      const fit = fitLadder(samples, rungs, cost);
      const cv = crossValidateLadder(samples, rungs, cost, 5, 1);
      // What an oracle would pay: send every task to the tier that actually
      // worked. It is the ceiling on what ANY router can buy, and without it
      // a "fitted beats always-cheap" line says nothing about how much of the
      // available saving was captured.
      const perfect =
        samples.reduce((sum, x) => sum + rungs[x.cheapest ?? rungs.length - 1].price, 0) / samples.length;
      console.log(
        `    ${arm.padEnd(8)} ${fit.cost.toFixed(2).padStart(7)}   ${cv.heldOutCost.toFixed(2).padStart(8)}   ` +
          `${fixedRungCost(0, samples, rungs, cost).toFixed(2).padStart(12)}   ` +
          `${fixedRungCost(TIERS.length - 1, samples, rungs, cost).toFixed(2).padStart(11)}   ` +
          `${perfect.toFixed(2).padStart(7)}   ` +
          `${fit.cuts.map((c) => c.toFixed(2)).join(", ")}`,
      );
    }
    console.log("");
  }
  console.log(
    "  `fitted` is scored on the samples it was fitted to and is NOT a result.\n" +
      "  `held out` is the one to read: five folds cut along tasks (docs/25 §2).",
  );
  void rungFor;
}

function main(): void {
  const labels = read<LabelRecord>("labels.json");
  const asks = read<{ rows: AskRow[] }>("asks.json");
  if (!labels) {
    console.log("no records/labels.json; run `npm run label` (needs the claude CLI)");
    return;
  }
  const cheapest = reportBaseRate(labels);
  if (!asks) {
    console.log("\nno records/asks.json; run `npm run ask` (needs TYPESAFE_API_KEY)");
    return;
  }
  reportArms(asks, cheapest);
  reportSeparation(asks, cheapest);
  reportLadder(asks, cheapest);

  const total = asks.rows.reduce((s, r) => s + r.inputTokens, 0);
  console.log(
    `\n  ${asks.rows.length} judgments, ${total} input tokens, $${((total / 1e6) * 0.042).toFixed(4)}` +
      ` · ${labels.attempts.length} labelling runs of \`claude -p\`, ` +
      `${(labels.attempts.reduce((s, a) => s + a.ms, 0) / 1000 / 60).toFixed(0)} minutes of wall clock`,
  );
}

if (process.argv[1]?.endsWith("report.ts")) main();
