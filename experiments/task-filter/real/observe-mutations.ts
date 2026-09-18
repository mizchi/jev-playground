/**
 * Apply each real edit to this repository, run every recipe, write down what
 * broke. No API key, no Jev: this produces the LABELS.
 *
 *   npx tsx real/observe-mutations.ts            # ~15 x the suite, a few minutes
 *   npx tsx real/observe-mutations.ts --verify    # only check the edits apply
 *   npx tsx real/observe-mutations.ts --only lib_wire_key
 *
 * The worktree must be clean before this starts, and it is left clean: each
 * mutation is reverted with `git checkout --` before the next one, and the
 * loop aborts if a revert ever fails to restore a clean tree. Losing
 * uncommitted work to a fixture is not a risk worth taking for a measurement.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadGraph, TaskGraph } from "../src/graph.js";
import { changedFiles, git, isClean } from "../src/gitdiff.js";
import { observe, type Run } from "../src/observe.js";
import type { ChangedFile } from "../src/scenarios.js";
import { MUTATIONS, type Mutation } from "./mutations.js";

const HERE = import.meta.dirname;
const REPO = resolve(HERE, "../../..");

const ARGS = process.argv.slice(2);
const only = (() => {
  const i = ARGS.indexOf("--only");
  return i >= 0 ? ARGS[i + 1] : "";
})();

/** One mutation, its real diff, and what actually happened. */
export interface MutationRun {
  mutation: Mutation;
  files: ChangedFile[];
  run: Run;
}

function siteCount(m: Mutation): number {
  const text = readFileSync(resolve(REPO, m.file), "utf8");
  return text.split(m.find).length - 1;
}

function apply(m: Mutation): void {
  const path = resolve(REPO, m.file);
  const text = readFileSync(path, "utf8");
  writeFileSync(path, text.replace(m.find, m.replace));
}

function revert(m: Mutation): void {
  git(["checkout", "--", m.file], REPO);
}

function main(): void {
  const selected = only ? MUTATIONS.filter((m) => m.id === only) : MUTATIONS;
  if (selected.length === 0) throw new Error(`no mutation matches '${only}'`);

  // Every `find` has to hit exactly one site, or the edit is not the edit the
  // fixture claims. Checked for all of them before anything is written.
  let broken = 0;
  for (const m of MUTATIONS) {
    const n = siteCount(m);
    if (n !== 1) {
      console.log(`  !! ${m.id.padEnd(26)} ${m.file}: ${n} matches for its 'find'`);
      broken += 1;
    }
  }
  if (broken > 0) {
    console.log(`\n  ${broken} mutation(s) do not identify a unique site; fix mutations.ts`);
    process.exit(1);
  }
  console.log(`  ${MUTATIONS.length} mutations, each matching exactly one site`);
  if (ARGS.includes("--verify")) return;

  if (!isClean(REPO)) {
    console.log("  the worktree has uncommitted changes; commit or stash them first");
    process.exit(1);
  }

  const graph = new TaskGraph(loadGraph(REPO, resolve(HERE, "graph.json")));
  const runs: MutationRun[] = [];

  for (const m of selected) {
    process.stdout.write(`\n  ${m.id} — ${m.subject}\n`);
    apply(m);
    let files: ChangedFile[] = [];
    let run: Run;
    try {
      files = changedFiles(REPO, []);
      run = observe(REPO, graph, m.id);
    } finally {
      revert(m);
      if (!isClean(REPO)) {
        console.log(`  !! ${m.file} did not revert cleanly; stopping`);
        process.exit(1);
      }
    }
    const failed = run.observations.filter((o) => o.status === "fail").map((o) => o.task);
    const blocked = run.observations.filter((o) => o.status === "blocked").map((o) => o.task);
    process.stdout.write(
      `    ${files.length} file(s) changed  ->  ` +
        (failed.length === 0
          ? "nothing failed"
          : `FAILED: ${failed.join(" ")}${blocked.length > 0 ? `  (blocked: ${blocked.join(" ")})` : ""}`) +
        "\n",
    );
    runs.push({ mutation: m, files, run });
  }

  mkdirSync(HERE, { recursive: true });
  const out = resolve(HERE, only ? `runs-${only}.json` : "runs.json");
  writeFileSync(out, JSON.stringify(runs, null, 2) + "\n");

  const withFailure = runs.filter((r) => r.run.observations.some((o) => o.status === "fail"));
  console.log("");
  console.log(
    `  ${withFailure.length}/${runs.length} mutations broke at least one recipe; ` +
      `${runs.length - withFailure.length} broke nothing`,
  );
  console.log(`  -> ${out}`);
}

main();
