/**
 * BEFORE THE SWEEP: does each component have anything to decide here?
 *
 * This file exists because of a trap I got most of the way into. The plan was
 * to add a `router` arm to `run.ts`, run 53 tasks under it, and compare
 * completion against the fixed-model arms. That would have burned an hour of
 * agent time to produce a table whose rows were all the same model -- because
 * docs/32's and docs/36's repair tasks SHARE ONE PROMPT. `REPAIR_PROMPT` is a
 * single string, so a router asked about the request is asked the identical
 * question 53 times.
 *
 * The same doubt applies to the other two:
 *
 *   model router          does the tier vary across tasks, and on what input?
 *   orchestration gate    would it ever let a `Task` spawn through?
 *   skill router          does it load anything from a real 300-skill
 *                         catalogue, for a repair task?
 *
 * Each is one judgment call per task -- cents, and minutes. The end-to-end
 * sweep is hours. So the probe runs first and the sweep is shaped by it, which
 * is the order docs/24 §2 argues for and the order I keep having to relearn.
 *
 *   tsx src/probe.ts              all three, recorded to records/probe.json
 *   tsx src/probe.ts --show       re-read the record, no API key needed
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { plan } from "../../../packages/jev-orchestrator/src/plan.js";
import { DEFAULT_CONFIG, route as routeModel } from "../../../packages/jev-model-router/src/route.js";
import { DEFAULT_SKILL_CONFIG, route as routeSkills } from "../../../packages/jev-skill-router/src/route.js";
import { catalogue } from "./catalogue.js";
import { REPAIR_PROMPT, tasks, type Task } from "./world.js";

const HERE = import.meta.dirname;
const RECORDS = resolve(HERE, "../records");
const PATH = resolve(RECORDS, "probe.json");

export interface ProbeRow {
  task: string;
  corpus: string;
  /** The first 600 characters of the real `node --test` output. */
  failure: string;
  /** The router asked about the prompt alone. */
  onPrompt?: { tier: string; score: number; confidence: number; reason: string; ms: number; error?: string };
  /** The router asked about the prompt plus the real failure. */
  onFailure?: { tier: string; score: number; confidence: number; reason: string; ms: number; error?: string };
  /** The orchestration gate on the same text. */
  gate?: { gate: number; split: boolean; shape: string; staySingle: number; ms: number; error?: string };
  /** The skill router over the 300-skill catalogue. */
  skills?: { loaded: string[]; considered: number; reason: string; noneApply: number; ms: number; error?: string };
}

export interface Probe {
  note: string;
  rows: ProbeRow[];
}

/** The real failing-test output for one task, from a throwaway copy. */
function failureOf(task: Task): string {
  const sandbox = mkdtempSync(resolve(tmpdir(), `jev-probe-${task.id}-`));
  try {
    cpSync(task.dir, sandbox, { recursive: true });
    const dotgit = resolve(sandbox, "dotgit");
    if (existsSync(dotgit)) renameSync(dotgit, resolve(sandbox, ".git"));
    const out = spawnSync("node", ["--test"], { cwd: sandbox, encoding: "utf8", timeout: 120_000 });
    return `${out.stdout ?? ""}\n${out.stderr ?? ""}`.trim().slice(0, 4000);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--show")) {
    show(JSON.parse(readFileSync(PATH, "utf8")) as Probe);
    return;
  }
  const only = args.includes("--corpus") ? args[args.indexOf("--corpus") + 1] : "all";
  const all = tasks(only as never);
  const skills = catalogue();
  const rows: ProbeRow[] = [];

  for (const [i, task] of all.entries()) {
    const failure = failureOf(task);
    const row: ProbeRow = { task: task.id, corpus: task.corpus, failure: failure.slice(0, 600) };

    // THE ROUTER, TWICE, on the two inputs a host could plausibly give it.
    // Both under the SHIPPED config -- `cuts: null`, so the score is rounded
    // to a rung rather than placed on a fitted ladder.
    for (const [key, text] of [
      ["onPrompt", task.prompt],
      ["onFailure", `${task.prompt}\n\nThe test run currently says:\n\n${failure}`],
    ] as const) {
      const res = await routeModel({ task: text }, { config: DEFAULT_CONFIG });
      row[key] = {
        tier: res.decision.label,
        score: res.judgment ? res.judgment.tier : Number.NaN,
        confidence: res.judgment ? res.judgment.tierConfidence : Number.NaN,
        reason: res.decision.reason,
        ms: res.ms,
        ...(res.error ? { error: res.error.slice(0, 200) } : {}),
      };
    }

    // THE ORCHESTRATION GATE, on the prompt the agent is launched with. If it
    // refuses a split here it refuses every `Task` spawn in the sweep, and the
    // arm is then a measurement of a veto that fires every time.
    const p = await plan({ request: task.prompt });
    row.gate = {
      gate: p.judgment ? p.judgment.gate : Number.NaN,
      split: p.plan.split,
      shape: p.plan.shape,
      staySingle: p.judgment ? p.judgment.staySingle : Number.NaN,
      ms: p.ms,
      ...(p.error ? { error: p.error.slice(0, 200) } : {}),
    };

    // THE SKILL ROUTER, over the real catalogue, with the failure as `notes` --
    // the field a host uses for project notes it already loads.
    const s = await routeSkills({ request: task.prompt, notes: failure }, skills, { config: DEFAULT_SKILL_CONFIG });
    row.skills = {
      loaded: s.load.map((x) => x.skill.name),
      considered: s.considered.length,
      reason: s.reason,
      noneApply: s.noneApply,
      ms: s.ms,
      ...(s.error ? { error: s.error.slice(0, 200) } : {}),
    };

    rows.push(row);
    process.stderr.write(
      `[${i + 1}/${all.length}] ${task.id}: router ${row.onPrompt?.tier}/${row.onFailure?.tier}, ` +
        `gate ${row.gate.gate.toFixed(2)} ${row.gate.split ? "SPLIT" : "single"}, ` +
        `skills ${row.skills.loaded.length}\n`,
    );
    save({ note: NOTE, rows });
  }
  show({ note: NOTE, rows });
}

const NOTE =
  "One judgment per component per task, with NO agent running. Answers the " +
  "question that has to come before the sweep: does the component have " +
  "anything to decide on this corpus. The model router is asked twice -- about " +
  "the prompt alone, which is shared verbatim by 53 tasks, and about the " +
  "prompt plus the task's real `node --test` output.";

function save(p: Probe): void {
  mkdirSync(RECORDS, { recursive: true });
  writeFileSync(PATH, `${JSON.stringify(p, null, 2)}\n`);
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(0)}%`;
}

function show(p: Probe): void {
  const rows = p.rows;
  console.log(`\n# Can these three components decide anything here? (${rows.length} tasks)\n`);

  console.log("## The model router, on two different inputs\n");
  console.log("| input | haiku | sonnet | opus | distinct | median score |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const [label, key] of [
    ["the prompt alone", "onPrompt"],
    ["prompt + real test failure", "onFailure"],
  ] as const) {
    const got = rows.map((r) => r[key]).filter(Boolean) as NonNullable<ProbeRow["onPrompt"]>[];
    const n = (t: string): number => got.filter((g) => g.tier === t).length;
    const scores = got.map((g) => g.score).filter((s) => Number.isFinite(s)).sort((a, b) => a - b);
    const med = scores.length ? scores[Math.floor(scores.length / 2)] : Number.NaN;
    console.log(
      `| ${label} | ${n("haiku")} | ${n("sonnet")} | ${n("opus")} | ` +
        `${new Set(got.map((g) => g.tier)).size} | ${Number.isFinite(med) ? med.toFixed(2) : "n/a"} |`,
    );
  }

  const varied = rows.filter((r) => r.onPrompt && r.onFailure && r.onPrompt.tier !== r.onFailure.tier).length;
  console.log(
    `\nThe two inputs disagree on ${varied} of ${rows.length} tasks (${pct(varied, rows.length)}). ` +
      "The prompt-alone column CANNOT vary across the 53 repair tasks -- they share one prompt string -- " +
      "so any variation there is draw noise on the same request, which docs/25 is about.",
  );

  console.log("\n## The orchestration gate\n");
  const split = rows.filter((r) => r.gate?.split).length;
  const gates = rows.map((r) => r.gate?.gate ?? Number.NaN).filter(Number.isFinite);
  const mean = gates.length ? gates.reduce((a, b) => a + b, 0) / gates.length : Number.NaN;
  console.log(
    `It would let a \`Task\` spawn through on ${split} of ${rows.length} tasks (${pct(split, rows.length)}). ` +
      `Mean gate ${Number.isFinite(mean) ? mean.toFixed(2) : "n/a"}, cutoff 0.50.`,
  );
  if (split === 0) {
    console.log(
      "\n**So the veto fires on every spawn.** An arm wired this way measures one thing: what happens to an " +
        "agent that is refused permission to delegate. That is a real question and it is NOT the question " +
        "`jev-orchestrator` was built to answer.",
    );
  }

  console.log("\n## The skill router, over 300 harvested skills\n");
  const loads = rows.map((r) => r.skills?.loaded.length ?? 0);
  const anyLoad = loads.filter((n) => n > 0).length;
  const freq = new Map<string, number>();
  for (const r of rows) for (const s of r.skills?.loaded ?? []) freq.set(s, (freq.get(s) ?? 0) + 1);
  console.log(
    `It loaded at least one skill on ${anyLoad} of ${rows.length} tasks (${pct(anyLoad, rows.length)}); ` +
      `${loads.reduce((a, b) => a + b, 0)} loads in total, cap ${DEFAULT_SKILL_CONFIG.maxLoad}, ` +
      `cutoff ${DEFAULT_SKILL_CONFIG.loadAt}.`,
  );
  if (freq.size > 0) {
    console.log("\n| skill | loaded on |");
    console.log("| --- | --- |");
    for (const [name, n] of [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`| \`${name}\` | ${n} |`);
    }
  }

  const costs = rows.flatMap((r) => [r.onFailure?.ms, r.gate?.ms, r.skills?.ms]).filter((m): m is number => Boolean(m));
  console.log(
    `\nThree judgments per task, ${costs.length} calls, median ` +
      `${costs.sort((a, b) => a - b)[Math.floor(costs.length / 2)]} ms.\n`,
  );
}

if (process.argv[1]?.endsWith("probe.ts")) await main();
