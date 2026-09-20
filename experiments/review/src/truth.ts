/**
 * The recorded truth: for every diff, does the suite stay green?
 *
 *   npx tsx src/truth.ts
 *
 * 261 diffs, one `node --test` each, plus one coverage run and one
 * `similarity-ts` run per task. About 50 seconds. Committed so the report
 * replays with neither an API key nor a node process.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runWith } from "../../repair/src/world.js";
import { coverageOf, duplicatePairsOf, metricsOf, type Metrics } from "./metrics.js";
import { loadGreenTasks, subjectsOf } from "./subjects.js";

export interface SubjectTruth {
  id: string;
  task: string;
  line: number;
  before: string;
  after: string;
  /** The suite still passes with this diff applied. */
  safe: boolean;
  metrics: Metrics;
}

export interface ReviewTruth {
  /** Where `similarity-ts` was found, or "" when it was not. */
  similarityBin: string;
  tasks: { id: string; green: string; baselineGreen: boolean }[];
  subjects: SubjectTruth[];
}

const BIN = process.env.SIMILARITY_TS ?? `${process.env.HOME}/.cargo/bin/similarity-ts`;

function main(): void {
  const tasks = loadGreenTasks();
  const subjects: SubjectTruth[] = [];
  const taskRows: ReviewTruth["tasks"] = [];
  let bin = "";
  for (const task of tasks) {
    const started = Date.now();
    const base = runWith(task, task.green);
    if (!base.pass) throw new Error(`${task.id}: the green baseline is not green`);
    const coverage = coverageOf(task);
    const dup = duplicatePairsOf(task.dir, BIN);
    if (dup !== null) bin = BIN;
    let safe = 0;
    for (const s of subjectsOf(task)) {
      const ok = runWith(task, s.text).pass;
      if (ok) safe += 1;
      subjects.push({
        id: s.id,
        task: s.task,
        line: s.candidate.line,
        before: s.candidate.before,
        after: s.candidate.after,
        safe: ok,
        metrics: metricsOf(s, task, coverage, dup),
      });
    }
    taskRows.push({ id: task.id, green: task.green, baselineGreen: true });
    const n = subjects.filter((x) => x.task === task.id).length;
    console.log(
      `  ${task.id.padEnd(16)} ${String(n).padStart(3)} diffs, ${String(safe).padStart(3)} safe, ` +
        `branches ${(100 * (coverage.branchesFound === 0 ? 1 : coverage.branchesHit / coverage.branchesFound)).toFixed(0)}%, ` +
        `dup ${dup === null ? "n/a" : dup}, ${Date.now() - started} ms`,
    );
  }
  const out: ReviewTruth = { similarityBin: bin, tasks: taskRows, subjects };
  const path = resolve(import.meta.dirname, "../records/truth.json");
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
  const safe = subjects.filter((s) => s.safe).length;
  console.log(
    `\n  ${tasks.length} tasks, ${subjects.length} diffs, ${safe} safe ` +
      `(${((100 * safe) / subjects.length).toFixed(0)}%) -> ${path}`,
  );
  console.log(`  similarity-ts: ${bin || "not found; the metric is null everywhere"}`);
}

main();
