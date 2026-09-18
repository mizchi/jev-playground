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
import { Jev, noul, score } from "../../shared/jev.js";
import { ALL_WASTE, BEHAVIOUR, questionsFor, stateFor, type ArmName } from "./arms.js";
import { changedFiles, DEFAULT_LIMITS, git } from "./gitdiff.js";
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
const LIMITS = {
  maxHunk: Number(opt("max-hunk", String(DEFAULT_LIMITS.maxHunk))),
  maxTotal: Number(opt("max-diff", String(DEFAULT_LIMITS.maxTotal))),
};

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
    const base = flag("base") ? [`${opt("base", "main")}...HEAD`] : [];
    const files = changedFiles(process.cwd(), base, LIMITS);
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

  const dur = (s: number) => (s < 90 ? `${s.toFixed(1)}s` : `${(s / 60).toFixed(1)}m`);
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
        `${`${r.cost}s`.padStart(7)}  ${mark} ${r.task}`,
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
        `${dur(chosen.serial)} machine / ${dur(chosen.wall)} wall  ` +
        `(everything: ${dur(all.serial)} / ${dur(all.wall)}, ` +
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
