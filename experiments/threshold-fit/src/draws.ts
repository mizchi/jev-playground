/**
 * Section C -- how much of a cutoff's fragility is just asking again.
 *
 * docs/23 §11's last piece of homework: "throw the same diff ten times and get
 * the standard deviation per task. If the wobble near the boundary can be
 * quantified, the floor can be replaced by 'skip when the lower bound of the
 * interval is under the cutoff'."
 *
 * So: ten draws of the same fifteen diffs (real/scores-draws.json, 150
 * requests, $0.0179). The question is not whether the answers move -- they do
 * -- but whether they move enough to change what runs, because a filter that
 * needs ten requests to be stable is a different product from one that needs
 * one.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { logisticFit, mean, sd } from "../../shared/thresholds.js";
import { planLeastLoss } from "../../task-filter/src/cost.js";
import { caught, planFromScores } from "../../task-filter/src/select.js";
import { loadTasks, pairs, score } from "./tasks.js";

const HERE = import.meta.dirname;
const FILE = "scores-draws.json";

const pad = (s: string, n: number) => s.padEnd(n);
const dur = (s: number) => `${s.toFixed(1).padStart(5)}s`;

export function drawsSection(): void {
  if (!existsSync(resolve(HERE, "../../task-filter/real", FILE))) {
    console.log("");
    console.log(`  C. skipped: real/${FILE} is missing (collect it with`);
    console.log(`     npx tsx experiments/task-filter/real/run.ts --repeat 10 --out ${FILE})`);
    return;
  }
  const data = loadTasks(FILE);
  const { graph, runs, rows, failing, all } = data;
  const draws = rows.length / runs.length;
  const goals = graph.goals();

  console.log("");
  console.log("=".repeat(104));
  console.log(`  C. THE SAME DIFF, ${draws} TIMES -- what moves, and whether it changes what runs`);
  console.log("");

  // Per (diff, goal) spread across draws.
  const spreads: { id: string; task: string; mean: number; sd: number; lo: number; hi: number; red: boolean }[] = [];
  for (const r of runs) {
    const mine = rows.filter((x) => x.id === r.mutation.id);
    for (const task of goals) {
      const values = mine.map((x) => x.scores[task.name]).filter((v) => typeof v === "number");
      if (values.length < 2) continue;
      spreads.push({
        id: r.mutation.id,
        task: task.name,
        mean: mean(values),
        sd: sd(values),
        lo: Math.min(...values),
        hi: Math.max(...values),
        red: failing.get(r.mutation.id)!.has(task.name),
      });
    }
  }
  const straddles = (t: number) => spreads.filter((s) => s.lo < t && s.hi >= t);
  console.log(
    `  ${spreads.length} (diff, goal) pairs, each asked ${draws} times. ` +
      `mean sd ${mean(spreads.map((s) => s.sd)).toFixed(3)}, ` +
      `worst sd ${Math.max(...spreads.map((s) => s.sd)).toFixed(3)}, ` +
      `widest spread ${Math.max(...spreads.map((s) => s.hi - s.lo)).toFixed(2)} on a 0..3 score`,
  );
  console.log("");
  console.log(`  ${pad("cutoff", 10)}${"pairs that straddle it".padStart(24)}${"of them red".padStart(14)}   the unstable ones`);
  for (const t of [0.75, 1.0, 1.25, 1.5]) {
    const s = straddles(t);
    console.log(
      `  ${pad(t.toFixed(2), 10)}${String(s.length).padStart(24)}${String(s.filter((x) => x.red).length).padStart(14)}   ` +
        s
          .slice(0, 2)
          .map((x) => `${x.task} on ${x.id} ${x.lo.toFixed(2)}..${x.hi.toFixed(2)}`)
          .join(", ") +
        (s.length > 2 ? ` +${s.length - 2}` : ""),
    );
  }
  console.log("");
  console.log("  A pair straddles a cutoff when ten draws do not agree on which side of it the score is.");

  // Draw-level outcome.
  console.log("");
  console.log("-".repeat(104));
  console.log("  C2. THE OUTCOME, DRAW BY DRAW (one cutoff at 1.25, the operating point from section B)");
  console.log("");
  const perDraw: { caught: number; of: number; serial: number }[] = [];
  for (let d = 0; d < draws; d += 1) {
    const mine = rows.filter((x) => x.repeat === d);
    let hit = 0;
    let of = 0;
    const serial: number[] = [];
    for (const row of mine) {
      const p = planFromScores(graph, row.scores, 1.25);
      serial.push(p.serial);
      const f = failing.get(row.id)!;
      if (f.size === 0) continue;
      of += 1;
      if (caught(p, f)) hit += 1;
    }
    perDraw.push({ caught: hit, of, serial: mean(serial) });
  }
  console.log(
    `  ${perDraw.map((d, i) => `draw ${i + 1}: ${d.caught}/${d.of} ${d.serial.toFixed(1)}s`).join("   ")}`,
  );
  console.log(
    `  machine seconds across draws: mean ${mean(perDraw.map((d) => d.serial)).toFixed(2)}s, ` +
      `sd ${sd(perDraw.map((d) => d.serial)).toFixed(2)}s, ` +
      `range ${Math.min(...perDraw.map((d) => d.serial)).toFixed(1)}..${Math.max(...perDraw.map((d) => d.serial)).toFixed(1)}s ` +
      `(the whole suite is ${all.serial.toFixed(1)}s)`,
  );

  // Would averaging help?
  console.log("");
  console.log("-".repeat(104));
  console.log(`  C3. IS ONE DRAW ENOUGH? (${draws} requests per diff against one)`);
  console.log("");
  const meanScores = new Map<string, Record<string, number>>();
  for (const r of runs) {
    const mine = rows.filter((x) => x.id === r.mutation.id);
    const avg: Record<string, number> = {};
    for (const task of goals) {
      const values = mine.map((x) => x.scores[task.name]).filter((v) => typeof v === "number");
      if (values.length > 0) avg[task.name] = mean(values);
    }
    meanScores.set(r.mutation.id, avg);
  }
  console.log(`  ${pad("decided from", 26)}${"caught".padStart(8)}${"machine".padStart(10)}${"disagrees with the mean".padStart(26)}`);
  for (const t of [1.0, 1.25]) {
    const avgPlans = runs.map((r) => ({
      id: r.mutation.id,
      plan: planFromScores(graph, meanScores.get(r.mutation.id)!, t),
    }));
    const avgCaught = avgPlans.filter((p) => failing.get(p.id)!.size > 0 && caught(p.plan, failing.get(p.id)!)).length;
    const of = runs.filter((r) => failing.get(r.mutation.id)!.size > 0).length;
    console.log(
      `  ${pad(`mean of ${draws}, cutoff ${t}`, 26)}${`${avgCaught}/${of}`.padStart(8)}` +
        `${dur(mean(avgPlans.map((p) => p.plan.serial))).padStart(10)}${"-".padStart(26)}`,
    );
    // A single draw against the mean: how often does the selected set differ?
    let differing = 0;
    let total = 0;
    for (const row of rows) {
      const one = new Set(planFromScores(graph, row.scores, t).selected);
      const many = new Set(planFromScores(graph, meanScores.get(row.id)!, t).selected);
      total += 1;
      if (one.size !== many.size || [...one].some((n) => !many.has(n))) differing += 1;
    }
    let hit = 0;
    let of1 = 0;
    const serial: number[] = [];
    for (const row of rows) {
      const p = planFromScores(graph, row.scores, t);
      serial.push(p.serial);
      const f = failing.get(row.id)!;
      if (f.size === 0) continue;
      of1 += 1;
      if (caught(p, f)) hit += 1;
    }
    console.log(
      `  ${pad(`one draw, cutoff ${t}`, 26)}${`${hit}/${of1}`.padStart(8)}${dur(mean(serial)).padStart(10)}` +
        `${`${differing}/${total} diffs`.padStart(26)}`,
    );
  }
  console.log("");
  console.log("  `disagrees with the mean` counts single draws whose selected set differs from the set the");
  console.log(`  ${draws}-draw mean picks -- the price of deciding from one request instead of ${draws}.`);

  // Section B's two rules, on ten draws instead of three.
  console.log("");
  console.log("-".repeat(104));
  console.log(`  C4. SECTION B's RULES ON ${draws} DRAWS (same diffs, same labels, ${rows.length} decisions)`);
  console.log("");
  const ids = new Set(runs.map((r) => r.mutation.id));
  const model = new Map(
    [...ids].map((id) => [id, logisticFit(pairs(data, new Set([...ids].filter((x) => x !== id))), { ridge: 1 })]),
  );
  const show = (label: string, s: { caught: number; of: number; serial: number }) =>
    console.log(
      `  ${pad(label, 38)}${`${s.caught}/${s.of}`.padStart(8)}${dur(s.serial).padStart(10)}` +
        `${`${((1 - s.serial / all.serial) * 100).toFixed(1)}%`.padStart(8)}`,
    );
  console.log(`  ${pad("rule", 38)}${"caught".padStart(8)}${"machine".padStart(10)}${"saved".padStart(8)}`);
  show("one cutoff, score >= 1.25", score(data, (r) => planFromScores(graph, r.scores, 1.25)));
  for (const penalty of [60, 120]) {
    show(
      `least expected loss, penalty ${penalty}s`,
      score(data, (row) => planLeastLoss(graph, row.scores, penalty, model.get(row.id)!)),
    );
  }
  console.log("");
  console.log("  Section B fitted and scored on three draws; these are ten fresh ones, same numbers.");
}
