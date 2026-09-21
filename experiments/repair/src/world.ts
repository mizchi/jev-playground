/**
 * The tasks, and the label.
 *
 * Twelve small JavaScript files with a planted bug and a real `node:test`
 * suite beside each one. The label is the test runner's exit code, which is
 * the best kind this repository has -- docs/23 §12 replaced a rule-written
 * label with an exit code and the numbers moved; here there was never a
 * rule-written one to replace.
 *
 * A candidate is applied into a fresh copy of the task under the system
 * temporary directory and `node --test` is run there, so nothing in the
 * repository is edited and two candidates can never see each other's writes.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export interface Task {
  id: string;
  /** The buggy file's path inside the task, e.g. `src/clamp.js`. */
  path: string;
  source: string;
  /** Every test file's text, which is what the judgment gets to read. */
  tests: { path: string; text: string }[];
  /** One line saying what the bug is. NOT shown to any arm. */
  blurb: string;
  dir: string;
}

const ROOT = resolve(import.meta.dirname, "../tasks");

export function loadTasks(root = ROOT): Task[] {
  return readdirSync(root)
    .filter((id) => !id.startsWith("."))
    .sort()
    .map((id) => {
      const dir = resolve(root, id);
      const srcFiles = readdirSync(resolve(dir, "src"));
      if (srcFiles.length !== 1) throw new Error(`${id} should have exactly one source file`);
      const path = `src/${srcFiles[0]}`;
      return {
        id,
        path,
        source: readFileSync(resolve(dir, path), "utf8"),
        tests: readdirSync(resolve(dir, "test")).map((f) => ({
          path: `test/${f}`,
          text: readFileSync(resolve(dir, "test", f), "utf8"),
        })),
        blurb: readFileSync(resolve(dir, "blurb.txt"), "utf8").trim(),
        dir,
      };
    });
}

export interface RunResult {
  pass: boolean;
  /** The failure output, trimmed. Empty when it passed. */
  output: string;
  ms: number;
}

/**
 * Apply a candidate into a scratch copy and run the suite.
 *
 * Synchronous on purpose: the whole point of the deterministic half is that
 * it is reproducible, and a pool of concurrent `node --test` processes
 * writing into per-candidate temp directories is reproducible but much
 * harder to reason about when a number looks wrong.
 */
export function runWith(task: Task, text: string | null): RunResult {
  const scratch = mkdtempSync(resolve(tmpdir(), `jev-repair-${task.id}-`));
  try {
    cpSync(task.dir, scratch, { recursive: true });
    if (text !== null) writeFileSync(resolve(scratch, task.path), text);
    const started = Date.now();
    try {
      execFileSync(process.execPath, ["--test"], {
        cwd: scratch,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20_000,
      });
      return { pass: true, output: "", ms: Date.now() - started };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      return { pass: false, output: failureOf(`${e.stdout ?? ""}\n${e.stderr ?? ""}`), ms: Date.now() - started };
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The part of `node --test` output worth putting in a state.
 *
 * The full output is 40 lines of TAP for a two-test file, most of it counts
 * and stack frames. What a reader needs is the failing test's name and the
 * assertion -- docs/27 §5 measured that sending everything costs more and
 * does worse.
 */
export function failureOf(raw: string): string {
  const lines = raw.split("\n");
  const keep: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^not ok \d+ -/.test(l.trim())) keep.push(l.trim().replace(/^not ok \d+ - /, "failing test: "));
    if (/^\s*(code|expected|actual|operator|message):/.test(l)) keep.push(l.trim());
    if (/error: |Error: /.test(l) && keep.length < 12) keep.push(l.trim());
  }
  const out = keep.filter((l, i) => keep.indexOf(l) === i).slice(0, 12);
  return out.length > 0 ? out.join("\n") : lines.filter((l) => l.trim()).slice(0, 8).join("\n");
}

/** Which candidates actually turn the suite green. The ground truth. */
export function fixesOf(task: Task, texts: readonly string[]): boolean[] {
  return texts.map((t) => runWith(task, t).pass);
}
