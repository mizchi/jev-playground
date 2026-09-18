/**
 * Regenerate `graph.json` from the justfile.
 *
 *   npm run graph        # needs `just` on PATH
 *
 * The cache is committed so that `npm run demo` and `npm test` work without
 * `just` installed, the same reason `examples/` carries transcripts.
 */
import { ROOT, TaskGraph, writeGraph } from "./graph.js";

const graph = new TaskGraph(writeGraph(ROOT));
const goals = graph.goals().map((t) => t.name);
console.log(`  ${graph.tasks.length} recipes -> graph.json`);
console.log(`  ${goals.length} goals: ${goals.join(" ")}`);
const missing = graph.tasks.filter((t) => !graph.isMeta(t.name) && t.cost === 0);
if (missing.length > 0) {
  console.log(`  !! no @cost annotation: ${missing.map((t) => t.name).join(" ")}`);
  process.exit(1);
}
