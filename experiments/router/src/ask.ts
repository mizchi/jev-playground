/**
 * The router's prediction over the same tasks the labels were measured on.
 *
 *   npx tsx src/ask.ts --arms plain,failure,source,choice --repeats 3
 *
 * The thing that has to be got right here is WHAT THE ROUTER SEES, and it
 * took noticing a flat result to get it right: the agent's prompt is
 * IDENTICAL for all twenty-one tasks ("the tests under test/ are failing,
 * fix the source"). A router shown only that has nothing to discriminate on
 * -- every task is the same string -- so a run of it would measure the draw
 * noise of one question and nothing else.
 *
 * So `plain` is kept as the CONTROL rather than deleted. It says what the
 * floor is. The realistic arm is `failure`: at the start of a real turn where
 * someone says "the tests are failing", the failing test output is on screen,
 * and `experiments/repair/records/truth.json` already holds it per task,
 * measured rather than written.
 *
 *   plain    the prompt alone. Identical across tasks: the floor.
 *   failure  the prompt plus the failing test output. The realistic one.
 *   source   that plus the buggy file. The upper bound on what context buys.
 *   choice   the `failure` input, asked as a `choice` over the tiers instead
 *            of a `score` over the ladder -- docs/36 §2.1's disagreement with
 *            gargpratyush/jev-router, measured rather than asserted.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { failureOf } from "../../repair/src/world.js";
import { Jev, type Question } from "../../../packages/jev-core/src/index.js";
import {
  DEFAULT_CONFIG,
  EFFORT,
  OVERSIZED,
  TIER,
  UNDERSPECIFIED,
  questionsFor,
  stateFor,
  type RouteInput,
} from "../../../packages/jev-model-router/src/route.js";
import { PROMPT, TIERS } from "./label.js";

const RECORDS = resolve(import.meta.dirname, "../records");
const REPAIR = resolve(import.meta.dirname, "../../repair");
const HARD = resolve(import.meta.dirname, "../tasks-hard");

export const ARMS = ["plain", "failure", "source", "choice"] as const;
export type Arm = (typeof ARMS)[number];

export const ARM_BLURB: Record<Arm, string> = {
  plain: "the prompt alone, identical for every task: the floor",
  failure: "the prompt plus the failing test output",
  source: "that plus the buggy source file",
  choice: "the failure input asked as a choice over tiers, not a score",
};

export interface AskRow {
  task: string;
  corpus: "easy" | "hard";
  arm: Arm;
  repeat: number;
  /** The `score` answer, or the chosen tier's index for the `choice` arm. */
  tier: number;
  tierConfidence: number;
  effort: number;
  underspecified: number;
  oversized: number;
  /** Free features, recorded so the no-judgment baselines cost nothing extra. */
  promptChars: number;
  sourceChars: number;
  failingTests: number;
  ms: number;
  inputTokens: number;
}

interface Truth {
  [index: string]: { task: string; baseline: string; candidates: number };
}

export interface TaskInput {
  task: string;
  corpus: "easy" | "hard";
  baseline: string;
  source: string;
}

/**
 * The failing test output for a composed task, formatted the way the easy
 * corpus records it.
 *
 * Formatted by `repair`'s own `failureOf` rather than by anything written
 * here. The `failure` arm's whole claim is that the test output carries the
 * signal, and two corpora whose outputs were shaped by two different
 * functions would make that claim about the formatter.
 */
function baselineOf(dir: string): string {
  let raw = "";
  try {
    execFileSync("node", ["--test"], { cwd: dir, encoding: "utf8", timeout: 120_000 });
  } catch (err) {
    raw = String((err as { stdout?: string }).stdout ?? "");
  }
  return failureOf(raw);
}

export function taskInputs(corpus: "easy" | "hard" | "both" = "both"): TaskInput[] {
  const out: TaskInput[] = [];
  if (corpus !== "hard") {
    const truth = JSON.parse(readFileSync(resolve(REPAIR, "records/truth.json"), "utf8")) as Truth;
    for (const r of Object.values(truth)) {
      if (!r || typeof r.task !== "string") continue;
      const dir = resolve(REPAIR, "tasks", r.task, "src");
      const names = existsSync(dir) ? readdirSync(dir) : [];
      out.push({
        task: r.task,
        corpus: "easy",
        baseline: r.baseline ?? "",
        source: names.length === 1 ? readFileSync(resolve(dir, names[0]), "utf8") : "",
      });
    }
  }
  if (corpus !== "easy" && existsSync(resolve(HARD, "index.json"))) {
    const listed = (JSON.parse(readFileSync(resolve(HARD, "index.json"), "utf8")) as {
      tasks: { id: string }[];
    }).tasks;
    for (const t of listed) {
      const dir = resolve(HARD, t.id);
      const src = resolve(dir, "src");
      const names = readdirSync(src);
      out.push({
        task: t.id,
        corpus: "hard",
        baseline: baselineOf(dir),
        source: names.length === 1 ? readFileSync(resolve(src, names[0]), "utf8") : "",
      });
    }
  }
  return out.sort((a, b) => a.task.localeCompare(b.task));
}

/** How many tests the baseline output says are failing. Free. */
export function failingTestsOf(baseline: string): number {
  return (baseline.match(/failing test:/g) ?? []).length;
}

export function inputFor(arm: Arm, row: { baseline: string; source: string }): RouteInput {
  if (arm === "plain") return { task: PROMPT };
  const failure = `${PROMPT}\n\nThe test runner reports:\n${row.baseline}`;
  if (arm === "failure" || arm === "choice") return { task: failure };
  return { task: `${failure}\n\nThe file under src/ currently reads:\n${row.source}` };
}

/** The `choice` form, for docs/36 §2.1. Same input, the other answer shape. */
export function choiceQuestions(): Record<string, Question> {
  const criteria: Record<string, string> = {};
  for (const tier of DEFAULT_CONFIG.tiers) criteria[tier.label] = tier.says;
  return {
    [TIER]: {
      type: "choice",
      instructions:
        "How capable a model does this request need? Judge the difficulty of the work itself, not how long the answer will be and not how polite the request is.",
      criteria,
    },
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (name: string, dflt: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const arms = arg("arms", ARMS.join(",")).split(",") as Arm[];
  const repeats = Number(arg("repeats", "3"));
  const jev = new Jev();
  const rows: AskRow[] = (() => {
    const path = resolve(RECORDS, "asks.json");
    if (!existsSync(path)) return [];
    return (JSON.parse(readFileSync(path, "utf8")) as { rows: AskRow[] }).rows;
  })();
  const tasks = taskInputs();
  const flush = (): void => {
    mkdirSync(RECORDS, { recursive: true });
    writeFileSync(
      resolve(RECORDS, "asks.json"),
      `{\n"model": ${JSON.stringify(jev.model)},\n"rows": [\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]\n}\n`,
    );
  };

  for (const arm of arms) {
    for (let r = 0; r < repeats; r += 1) {
      for (const row of tasks) {
        if (rows.some((x) => x.task === row.task && x.arm === arm && x.repeat === r)) continue;
        const input = inputFor(arm, row);
        const questions = arm === "choice" ? choiceQuestions() : questionsFor(DEFAULT_CONFIG);
        const started = Date.now();
        const res = await jev.ask(stateFor(input, DEFAULT_CONFIG), questions);
        const a = res.answers[TIER];
        const tier =
          a.type === "choice"
            ? DEFAULT_CONFIG.tiers.findIndex((t) => t.label === a.choice)
            : a.type === "score"
              ? a.score
              : Number.NaN;
        const eff = res.answers[EFFORT];
        rows.push({
          task: row.task,
          corpus: row.corpus,
          arm,
          repeat: r,
          tier,
          tierConfidence: a.type === "noul" ? Number.NaN : a.confidence,
          effort: eff && eff.type === "score" ? eff.score : Number.NaN,
          underspecified: readNoul(res.answers, UNDERSPECIFIED),
          oversized: readNoul(res.answers, OVERSIZED),
          promptChars: input.task.length,
          sourceChars: row.source.length,
          failingTests: failingTestsOf(row.baseline),
          ms: Date.now() - started,
          inputTokens: res.usage.input_tokens,
        });
        flush();
      }
      const mine = rows.filter((x) => x.arm === arm && x.repeat === r);
      const mean = mine.reduce((s, x) => s + x.tier, 0) / Math.max(1, mine.length);
      const spread = Math.max(...mine.map((x) => x.tier)) - Math.min(...mine.map((x) => x.tier));
      console.log(`  ${arm.padEnd(8)} repeat ${r}: mean tier ${mean.toFixed(2)}, spread ${spread.toFixed(2)}`);
    }
  }
  const u = jev.usage();
  console.log(`  ${u.calls} requests, ${u.input} input tokens, $${u.usd.toFixed(4)} -> records/asks.json`);
}

function readNoul(answers: Record<string, { type: string } & Record<string, unknown>>, key: string): number {
  const a = answers[key];
  return a && a.type === "noul" && typeof a.noul === "number" ? a.noul : Number.NaN;
}

export { TIERS };

if (process.argv[1]?.endsWith("ask.ts")) {
  main().catch((err: unknown) => {
    console.error(String(err));
    process.exit(1);
  });
}
