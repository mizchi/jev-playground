/**
 * Regenerate real/graph.json from the REPOSITORY ROOT justfile.
 *
 *   npx tsx real/build.ts        # needs `just` on PATH
 *
 * The root graph is cached here rather than at the root, so the repository
 * does not carry a generated file beside its justfile.
 */
import { resolve } from "node:path";
import { TaskGraph, writeGraph } from "../src/graph.js";

const repo = resolve(import.meta.dirname, "../../..");
const graph = new TaskGraph(writeGraph(repo, resolve(import.meta.dirname, "graph.json")));
console.log(`  ${graph.tasks.length} recipes -> real/graph.json`);
console.log(`  ${graph.goals().length} goals: ${graph.goals().map((t) => t.name).join(" ")}`);
const missing = graph.tasks.filter((t) => !graph.isMeta(t.name) && t.cost === 0);
if (missing.length > 0) console.log(`  !! no @cost: ${missing.map((t) => t.name).join(" ")}`);
