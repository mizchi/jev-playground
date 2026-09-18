/**
 * Run a task graph for real and write down what happened.
 *
 *   npx tsx src/observe.ts --dir ../.. --out real/baseline.json
 *
 * This is the part docs/23 did not have. There, a scenario declared a defect
 * and src/oracle.ts decided by rule which recipes that defect would fail --
 * a rule I wrote, which was the report's largest admitted weakness (§9). Here
 * nothing decides: every recipe is executed in the worktree as it currently
 * stands, and the label is the exit code.
 *
 * Recipes run once each, in topological order, so a prerequisite is already
 * satisfied when its dependents run -- the same shape as CI with a warm cache,
 * and the shape the @cost annotations are measured in. A recipe whose
 * prerequisite failed is recorded as `blocked` rather than `fail`, because it
 * never ran and its result is unknown.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGraph, TaskGraph } from "./graph.js";

export type Status = "pass" | "fail" | "blocked";

export interface Observation {
  task: string;
  status: Status;
  /** Exit code, or null when the recipe never ran. */
  code: number | null;
  ms: number;
  /** Last few lines of combined output, for the report and for debugging. */
  tail: string;
}

export interface Run {
  /** What state the worktree was in: "baseline", or a mutation's id. */
  label: string;
  /** The commit the worktree is based on. */
  head: string;
  observations: Observation[];
}

/** Recipe bodies as `just` would run them: one shell per line, `@` stripped. */
function bodyOf(graph: TaskGraph, task: string): string[] {
  return graph
    .task(task)
    .body.map((line) => line.replace(/^@/, "").trim())
    .filter((line) => line.length > 0);
}

const shell = (dir: string, line: string) =>
  spawnSync("bash", ["-c", line], {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 64 << 20,
    // The MoonBit toolchain installs to ~/.moon/bin, which a non-login shell
    // does not have; the recipes assume it the way a developer's shell does.
    env: { ...process.env, PATH: `${process.env.HOME}/.moon/bin:${process.env.PATH}` },
  });

export function runTask(
  dir: string,
  graph: TaskGraph,
  task: string,
  isolate = false,
): Observation {
  // Measuring a cost means measuring it cold: whichever MoonBit recipe runs
  // first otherwise pays for everyone else's compile, and the rest read 0.0s.
  const reset = graph.task(task).reset;
  if (isolate && reset) shell(dir, reset);
  const started = Date.now();
  let code = 0;
  let out = "";
  for (const line of bodyOf(graph, task)) {
    const res = shell(dir, line);
    out += `${res.stdout ?? ""}${res.stderr ?? ""}`;
    code = res.status ?? 1;
    if (code !== 0) break;
  }
  const tail = out.trim().split("\n").slice(-3).join(" / ").slice(0, 400);
  return {
    task,
    status: code === 0 ? "pass" : "fail",
    code,
    ms: Date.now() - started,
    tail,
  };
}

/** Every non-meta recipe, once, in dependency order. */
export function observe(
  dir: string,
  graph: TaskGraph,
  label: string,
  onTask?: (o: Observation) => void,
  isolate = false,
): Run {
  const all = graph.tasks.filter((t) => !graph.isMeta(t.name)).map((t) => t.name);
  const order = graph.ordered(graph.closure(all));
  const byTask = new Map<string, Observation>();
  for (const task of order) {
    const broken = graph.task(task).deps.filter((d) => byTask.get(d)?.status !== "pass");
    const o: Observation =
      broken.length > 0
        ? {
            task,
            status: "blocked",
            code: null,
            ms: 0,
            tail: `never ran: ${broken.join(", ")} did not pass`,
          }
        : runTask(dir, graph, task, isolate);
    byTask.set(task, o);
    onTask?.(o);
  }
  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
  return { label, head, observations: order.map((t) => byTask.get(t)!) };
}

export function failing(run: Run): Set<string> {
  return new Set(run.observations.filter((o) => o.status === "fail").map((o) => o.task));
}

// ---------------------------------------------------------------- CLI

function main(): void {
  const args = process.argv.slice(2);
  const opt = (n: string, d: string) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : d;
  };
  const dir = resolve(opt("dir", "../.."));
  const out = opt("out", "");
  const graph = new TaskGraph(loadGraph(dir, opt("graph", "real/graph.json")));
  const label = opt("label", "baseline");

  console.log(`  ${graph.tasks.length} recipes from ${graph.source}`);
  console.log(`  running every one of them in ${dir}\n`);
  const isolate = args.includes("--isolate");
  const run = observe(dir, graph, label, (o) => {
    const mark = o.status === "pass" ? "ok  " : o.status === "fail" ? "FAIL" : "----";
    console.log(
      `  ${mark} ${o.task.padEnd(22)} ${`${(o.ms / 1000).toFixed(1)}s`.padStart(7)}  ${o.tail.split("\n")[0].slice(0, 60)}`,
    );
  }, isolate);

  const bad = run.observations.filter((o) => o.status !== "pass");
  const total = run.observations.reduce((a, o) => a + o.ms, 0);
  console.log("");
  console.log(
    `  ${run.observations.length - bad.length}/${run.observations.length} pass, ` +
      `${(total / 1000).toFixed(0)}s of machine time at ${run.head}`,
  );
  if (bad.length > 0) console.log(`  not passing: ${bad.map((o) => o.task).join(" ")}`);

  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), JSON.stringify(run, null, 2) + "\n");
    console.log(`  -> ${out}`);
  }
}

// Only when invoked directly, so real-run.ts can import the helpers.
const invoked = process.argv[1];
if (invoked && realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
