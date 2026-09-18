/**
 * docs/25 -- cutoffs, fitted by a component and scored on samples it did not see.
 *
 *   npx tsx src/run.ts                # all three sections, no API key needed
 *   npx tsx src/run.ts --criteria     # A: docs/22's eight named criteria
 *   npx tsx src/run.ts --tasks        # B: docs/23's task filter, cost-weighted
 *   npx tsx src/run.ts --draws        # C: ten draws of the same diffs
 *
 * Everything reads a recorded run from a sibling experiment. Nothing here asks
 * Jev anything: the point of the section is what you can do with the answers
 * you already paid for.
 */
import { criteriaSection } from "./criteria.js";
import { drawsSection } from "./draws.js";
import { tasksSection } from "./tasks.js";

const ARGS = process.argv.slice(2);
const only = (n: string) => ARGS.includes(`--${n}`);
const all = !only("criteria") && !only("tasks") && !only("draws");

if (all || only("criteria")) criteriaSection();
if (all || only("tasks")) tasksSection();
if (all || only("draws")) drawsSection();
console.log("");
