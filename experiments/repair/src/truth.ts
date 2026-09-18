/**
 * Which candidates actually turn each suite green.
 *
 * Run once and committed, so the report replays without an API key AND
 * without 174 node processes. `npm run truth` rebuilds it; `test.ts` checks
 * that it still matches the tasks and the catalog, so a change to either
 * fails loudly instead of silently scoring against a stale truth.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { candidates } from "./mutate.js";
import { hashOf, type TaskTruth } from "./record.js";
import { loadTasks, runWith } from "./world.js";

function main(): void {
  const out: TaskTruth[] = [];
  for (const task of loadTasks()) {
    const started = Date.now();
    const base = runWith(task, null);
    if (base.pass) throw new Error(`${task.id} already passes; there is no bug to find`);
    const cs = candidates(task.source);
    const fixes = cs.filter((c) => runWith(task, c.text).pass).map((c) => c.id);
    out.push({
      task: task.id,
      sourceHash: hashOf(task.source),
      candidates: cs.length,
      fixes,
      baseline: base.output,
      ms: Date.now() - started,
    });
    console.log(`  ${task.id.padEnd(16)} ${String(cs.length).padStart(3)} candidates, ${fixes.length} fix, ${Date.now() - started} ms`);
  }
  const path = resolve(import.meta.dirname, "../records/truth.json");
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    `\n  ${out.length} tasks, ${out.reduce((a, t) => a + t.candidates, 0)} candidates, ` +
      `${out.reduce((a, t) => a + t.fixes.length, 0)} fixes -> ${path}`,
  );
}

main();
