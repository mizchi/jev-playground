/**
 * The filter as a tool rather than as an experiment.
 *
 *   npx tsx src/cli.ts                      # the justfile here, `git diff` in cwd
 *   npx tsx src/cli.ts --dir ../my-repo     # someone else's justfile
 *   npx tsx src/cli.ts --base main          # diff a branch instead of the worktree
 *   npx tsx src/cli.ts --scenario comment_typo   # a corpus branch, no git needed
 *   npx tsx src/cli.ts --threshold 1.25 --json
 *
 * It prints a score per goal and a `just` command line. The command line names
 * only the goals: `just` resolves the prerequisites itself, which is the same
 * division of labour the experiment measures -- the graph is never something
 * the model has to get right.
 */
import { execFileSync } from "node:child_process";
import { Jev, noul, score } from "../../shared/jev.js";
import { ALL_WASTE, BEHAVIOUR, questionsFor, stateFor, type ArmName } from "./arms.js";
import { loadGraph, ROOT, TaskGraph } from "./graph.js";
import { plan, planAll } from "./select.js";
import { SCENARIOS, type ChangedFile, type Scenario } from "./scenarios.js";

const ARGS = process.argv.slice(2);
const flag = (n: string) => ARGS.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = ARGS.indexOf(`--${n}`);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d;
};

/** A lockfile diff can be tens of thousands of lines; the budget is not. */
const MAX_HUNK = Number(opt("max-hunk", "4000"));
const MAX_TOTAL = Number(opt("max-diff", "60000"));

// ---------------------------------------------------------------- git

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 << 20 });
}

/** Split a `git diff` into per-file patches, keyed by the new path. */
function splitDiff(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  let path = "";
  let lines: string[] = [];
  const flush = () => {
    if (path) out.set(path, lines.join("\n"));
    lines = [];
  };
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      flush();
      path = header[2];
      continue;
    }
    if (path) lines.push(line);
  }
  flush();
  return out;
}

function changedFiles(dir: string, base: string | null): ChangedFile[] {
  const range = base ? [`${base}...HEAD`] : ["HEAD"];
  const numstat = git(["diff", "--numstat", ...range], dir).trim();
  if (numstat === "") return [];
  const patches = splitDiff(git(["diff", "-U3", ...range], dir));
  const statuses = new Map<string, string>();
  for (const line of git(["diff", "--name-status", ...range], dir).trim().split("\n")) {
    const [code, ...rest] = line.split("\t");
    statuses.set(rest[rest.length - 1], code);
  }
  let budget = MAX_TOTAL;
  return numstat.split("\n").map((line) => {
    const [added, removed, path] = line.split("\t");
    const code = statuses.get(path) ?? "M";
    let hunk = patches.get(path) ?? "";
    if (hunk.length > MAX_HUNK) hunk = `${hunk.slice(0, MAX_HUNK)}\n... (truncated)`;
    if (hunk.length > budget) hunk = budget > 0 ? `${hunk.slice(0, budget)}\n... (truncated)` : "(omitted)";
    budget -= hunk.length;
    return {
      path,
      status: code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified",
      // A binary file reports "-" for both counts.
      added: Number(added) || 0,
      removed: Number(removed) || 0,
      hunk,
    } satisfies ChangedFile;
  });
}

function headSubject(dir: string): string {
  try {
    return git(["log", "-1", "--pretty=%s"], dir).trim();
  } catch {
    return "";
  }
}

function branchName(dir: string): string {
  try {
    return git(["rev-parse", "--abbrev-ref", "HEAD"], dir).trim();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const dir = opt("dir", ROOT);
  const arm = opt("arm", "diff") as ArmName;
  const threshold = Number(opt("threshold", "1.0"));
  const graph = new TaskGraph(loadGraph(dir));

  let scenario: Scenario;
  const fixture = opt("scenario", "");
  if (fixture) {
    const found = SCENARIOS.find((s) => s.id === fixture);
    if (!found) throw new Error(`unknown scenario '${fixture}'; see src/scenarios.ts`);
    scenario = found;
  } else {
    const base = flag("base") ? opt("base", "main") : null;
    const files = changedFiles(process.cwd(), base);
    if (files.length === 0) {
      console.log("  nothing changed; no tasks to filter");
      return;
    }
    scenario = {
      id: "worktree",
      branch: branchName(process.cwd()),
      subject: headSubject(process.cwd()),
      files,
      defect: null,
      shape: "narrow",
    };
  }

  const jev = new Jev({ model: opt("model", "jev-latest") });
  const started = Date.now();
  const res = await jev.ask(stateFor(arm, scenario, true), questionsFor(arm, graph));
  const elapsed = Date.now() - started;

  const rows = graph.goals().map((t) => {
    const a = score(res.answers[t.name]);
    return { task: t.name, score: a.score, confidence: a.confidence, cost: t.cost };
  });
  rows.sort((a, b) => b.score - a.score || b.cost - a.cost);
  const selected = rows.filter((r) => r.score >= threshold).map((r) => r.task);
  const chosen = plan(graph, selected);
  const all = planAll(graph);
  const behaviour = noul(res.answers[BEHAVIOUR]);
  const allWaste = noul(res.answers[ALL_WASTE]);

  if (flag("json")) {
    console.log(JSON.stringify({ scores: rows, selected, run: chosen.run, behaviour, allWaste }, null, 2));
    return;
  }

  const mins = (s: number) => `${(s / 60).toFixed(1)}m`;
  console.log("");
  console.log(`  graph   ${graph.tasks.length} recipes, ${graph.goals().length} goals — ${graph.source}`);
  console.log(
    `  change  ${scenario.files.length} file(s), ` +
      `+${scenario.files.reduce((a, f) => a + f.added, 0)} ` +
      `-${scenario.files.reduce((a, f) => a + f.removed, 0)}` +
      (scenario.branch ? `  on ${scenario.branch}` : ""),
  );
  console.log("");
  console.log(`  ${"score".padStart(6)} ${"conf".padStart(5)} ${"cost".padStart(6)}  task`);
  for (const r of rows) {
    const mark = r.score >= threshold ? "RUN " : "skip";
    console.log(
      `  ${r.score.toFixed(2).padStart(6)} ${r.confidence.toFixed(2).padStart(5)} ` +
        `${`${r.cost}s`.padStart(6)}  ${mark} ${r.task}`,
    );
  }
  console.log("");
  console.log(
    `  p(this change alters behaviour) ${behaviour.toFixed(2)}   ` +
      `p(nothing needs running) ${allWaste.toFixed(2)}`,
  );
  console.log("");
  if (selected.length === 0) {
    console.log("  nothing scored above the threshold. Run nothing, or lower --threshold.");
  } else {
    console.log(
      `  ${chosen.run.length} of ${all.run.length} tasks: ` +
        `${mins(chosen.serial)} machine / ${mins(chosen.wall)} wall  ` +
        `(everything: ${mins(all.serial)} / ${mins(all.wall)}, ` +
        `${((1 - chosen.serial / all.serial) * 100).toFixed(0)}% saved)`,
    );
    console.log("");
    // Only the goals: `just` pulls the prerequisites in itself.
    console.log(`  just ${selected.join(" ")}`);
  }
  console.log("");
  console.log(
    `  ${elapsed}ms · ${res.usage.input_tokens} input tokens · ` +
      `$${((res.usage.input_tokens / 1e6) * 0.042).toFixed(6)}`,
  );
  console.log("");
}

main().catch((err) => {
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
