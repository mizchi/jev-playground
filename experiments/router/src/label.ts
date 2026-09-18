/**
 * The label: which tier actually fixed the bug.
 *
 *   npx tsx src/label.ts --tiers haiku --repeats 1     # the base rate first
 *   npx tsx src/label.ts --tiers haiku,sonnet,opus
 *
 * Nothing here is judged. Each task is copied into a fresh temporary
 * directory, a real `claude -p` is pointed at it with edit permission, and
 * then `node --test` decides. The label is the test runner's exit code, which
 * is the same kind docs/32 and docs/33 used and the best kind this repository
 * has.
 *
 * Two details are load-bearing:
 *
 *   `blurb.txt` is NOT copied. It is the one-line statement of what the bug
 *   is, written when the corpus was built, and a task directory containing it
 *   would be handing the agent the answer -- docs/32's arms are all careful
 *   about this and a labelling run has to be too.
 *
 *   The baseline is re-run per task before the agent sees it. A task that
 *   already passes cannot be fixed, and a corpus that drifted would otherwise
 *   look like a tier that succeeded.
 */
import { execFileSync, execSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const EASY = resolve(import.meta.dirname, "../../repair/tasks");
const HARD = resolve(import.meta.dirname, "../tasks-hard");
const RECORDS = resolve(import.meta.dirname, "../records");

/** The tiers, cheapest first. The order is the ladder docs/36 §2 routes over. */
export const TIERS = [
  { label: "haiku", model: "claude-haiku-4-5-20251001", price: 1 },
  { label: "sonnet", model: "claude-sonnet-5", price: 3 },
  { label: "opus", model: "claude-opus-5", price: 15 },
] as const;
export type TierLabel = (typeof TIERS)[number]["label"];

/**
 * What the agent is told.
 *
 * Deliberately the least the task can be stated in. Saying "there is one
 * wrong comparison" or naming the file would be measuring a different
 * problem, and any hint moves every tier at once -- which is exactly the
 * thing that would make the ladder look flat when it is not.
 */
export const PROMPT =
  "The tests under test/ are failing. Fix the source under src/ so that all tests pass. " +
  "Do not modify any test file.";

export interface Attempt {
  task: string;
  /** Which corpus: the one-bug repair tasks, or the composed multi-bug ones. */
  corpus: "easy" | "hard";
  tier: TierLabel;
  repeat: number;
  /** `node --test` exit code after the agent finished. 0 is a fix. */
  passed: boolean;
  /** The agent edited nothing. Counted separately: not the same as failing. */
  untouched: boolean;
  ms: number;
  /** Set when the CLI itself failed rather than the fix failing. */
  error?: string;
}

export interface LabelRecord {
  prompt: string;
  tiers: typeof TIERS;
  attempts: Attempt[];
}

function nodeTest(dir: string): boolean {
  try {
    execFileSync("node", ["--test"], { cwd: dir, stdio: "ignore", timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
}

/** A task, minus the answer. */
function stage(task: string, root: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), `router-${task}-`));
  mkdirSync(resolve(dir, "src"), { recursive: true });
  mkdirSync(resolve(dir, "test"), { recursive: true });
  cpSync(resolve(root, task, "src"), resolve(dir, "src"), { recursive: true });
  cpSync(resolve(root, task, "test"), resolve(dir, "test"), { recursive: true });
  return dir;
}

function sourceOf(dir: string): string {
  const files = readdirSync(resolve(dir, "src"));
  return files.map((f) => execSync(`cat ${JSON.stringify(resolve(dir, "src", f))}`, { encoding: "utf8" })).join("");
}

export function attempt(task: string, tier: (typeof TIERS)[number], repeat: number, root: string): Attempt {
  const dir = stage(task, root);
  const started = Date.now();
  const row: Attempt = {
    task,
    corpus: root === HARD ? "hard" : "easy",
    tier: tier.label,
    repeat,
    passed: false,
    untouched: true,
    ms: 0,
  };
  try {
    if (nodeTest(dir)) {
      row.error = "the task already passes; the corpus drifted";
      return row;
    }
    const before = sourceOf(dir);
    try {
      execFileSync(
        "claude",
        [
          "-p",
          PROMPT,
          "--model",
          tier.model,
          "--permission-mode",
          "acceptEdits",
          "--allowedTools",
          "Read",
          "Edit",
          "Write",
        ],
        { cwd: dir, stdio: "ignore", timeout: 300_000 },
      );
    } catch (err) {
      // A non-zero CLI exit is not automatically a failed fix: the agent may
      // have edited correctly and then exceeded a turn limit. The tests decide.
      row.error = String(err).slice(0, 160);
    }
    row.untouched = sourceOf(dir) === before;
    row.passed = nodeTest(dir);
    return row;
  } finally {
    row.ms = Date.now() - started;
    rmSync(dir, { recursive: true, force: true });
  }
}

function flush(record: LabelRecord): void {
  mkdirSync(RECORDS, { recursive: true });
  writeFileSync(
    resolve(RECORDS, "labels.json"),
    `{\n"prompt": ${JSON.stringify(record.prompt)},\n"tiers": ${JSON.stringify(record.tiers)},\n` +
      `"attempts": [\n${record.attempts.map((a) => JSON.stringify(a)).join(",\n")}\n]\n}\n`,
  );
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (name: string, dflt: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const want = arg("tiers", TIERS.map((t) => t.label).join(",")).split(",");
  const tiers = TIERS.filter((t) => want.includes(t.label));
  const repeats = Number(arg("repeats", "1"));
  const only = arg("tasks", "");
  const root = arg("corpus", "easy") === "hard" ? HARD : EASY;
  /**
   * Skip a dearer tier on a task a cheaper one already fixed.
   *
   * Sound, not merely thrifty: `cheapest_sufficient` is the LOWEST rung that
   * worked, so once haiku passes, what sonnet and opus would do cannot change
   * the label. It halves a run that is otherwise an hour of `claude -p`.
   */
  const skipPassed = !argv.includes("--no-skip-passed");
  const tasks = readdirSync(root)
    .filter((t) => !t.startsWith(".") && t !== "index.json")
    .filter((t) => !only || only.split(",").includes(t))
    .sort();

  const prior = (() => {
    try {
      return JSON.parse(execSync(`cat ${JSON.stringify(resolve(RECORDS, "labels.json"))}`, { encoding: "utf8" })) as LabelRecord;
    } catch {
      return null;
    }
  })();
  const record: LabelRecord = {
    prompt: PROMPT,
    tiers: TIERS,
    attempts: prior && prior.prompt === PROMPT ? prior.attempts : [],
  };

  for (const tier of tiers) {
    for (let r = 0; r < repeats; r += 1) {
      for (const task of tasks) {
        const done = record.attempts.some((a) => a.task === task && a.tier === tier.label && a.repeat === r);
        if (done) continue;
        if (skipPassed) {
          const cheaper = TIERS.slice(0, TIERS.indexOf(tier)).map((t) => t.label);
          if (record.attempts.some((a) => a.task === task && cheaper.includes(a.tier) && a.passed)) continue;
        }
        const row = attempt(task, tier, r, root);
        record.attempts.push(row);
        flush(record);
        console.log(
          `  ${tier.label.padEnd(7)} ${task.padEnd(12)} ${row.passed ? "PASS" : "fail"}` +
            `${row.untouched ? " untouched" : ""} ${(row.ms / 1000).toFixed(0)}s${row.error ? ` ${row.error}` : ""}`,
        );
      }
      const mine = record.attempts.filter((a) => a.tier === tier.label && a.repeat === r);
      console.log(
        `  -> ${tier.label} repeat ${r}: ${mine.filter((a) => a.passed).length}/${mine.length} fixed\n`,
      );
    }
  }
  console.log(`  ${record.attempts.length} attempts -> records/labels.json`);
}

if (process.argv[1]?.endsWith("label.ts")) main();
