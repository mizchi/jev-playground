/**
 * The mechanical metrics, all of them computed and none of them judged.
 *
 * This is the half of a review that arithmetic can do, and the question
 * docs/33 asks is whether handing it over helps the other half. docs/27 §3
 * measured the extreme version of this -- severity from an SLO ratio beat
 * every judgment arm 16/16 -- and docs/23 §5 says rules belong in code. So
 * the metrics go in code and the request either sees them or does not.
 *
 * Every one is cheap and every one is real:
 *
 *   lineHits        how many times the tests execute the changed line, from
 *                   `node --test --experimental-test-coverage`'s LCOV. Zero
 *                   means the tests never reach it.
 *   fileBranches    the file's branch coverage, same run.
 *   rule            which mutation rule produced the edit. A classification
 *                   of the DIFF, not of the code.
 *   testOverlap     identifiers the changed line shares with the test names.
 *   depth           the changed line's indent depth, in levels.
 *   fnLines         how long the enclosing function is.
 *   duplicatePairs  what `similarity-ts` says about the file (docs/33 §5:
 *                   on this corpus it says nothing, and the reason is
 *                   measurable).
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { GreenTask, Subject } from "./subjects.js";

export interface Coverage {
  /** 1-based line -> execution count. Absent lines were not instrumented. */
  hits: Map<number, number>;
  branchesFound: number;
  branchesHit: number;
}

/** Parse the LCOV a `node --test` coverage run emits for one source file. */
export function parseLcov(raw: string, sourceSuffix: string): Coverage {
  const hits = new Map<number, number>();
  let branchesFound = 0;
  let branchesHit = 0;
  let inFile = false;
  for (const line of raw.split("\n")) {
    if (line.startsWith("SF:")) {
      inFile = line.slice(3).trim().endsWith(sourceSuffix);
      continue;
    }
    if (!inFile) continue;
    if (line.startsWith("DA:")) {
      const [at, count] = line.slice(3).split(",");
      hits.set(Number(at), Number(count));
    } else if (line.startsWith("BRF:")) branchesFound = Number(line.slice(4));
    else if (line.startsWith("BRH:")) branchesHit = Number(line.slice(4));
  }
  return { hits, branchesFound, branchesHit };
}

/** Coverage of a task's GREEN baseline: one process per task, not per diff. */
export function coverageOf(task: GreenTask): Coverage {
  const scratch = mkdtempSync(resolve(tmpdir(), `jev-review-${task.id}-`));
  try {
    cpSync(task.dir, scratch, { recursive: true });
    writeFileSync(resolve(scratch, task.path), task.green);
    let raw = "";
    try {
      raw = execFileSync(
        process.execPath,
        ["--test", "--experimental-test-coverage", "--test-reporter=lcov"],
        { cwd: scratch, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
      );
    } catch (err) {
      raw = (err as { stdout?: string }).stdout ?? "";
    }
    return parseLcov(raw, task.path.replace(/^src\//, "src/"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** What `similarity-ts` reports for a file, or null when it is not installed. */
export function duplicatePairsOf(dir: string, bin: string): number | null {
  try {
    const out = execFileSync(bin, ["src", "--threshold", "0.5", "--min-lines", "1"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    const m = /Found (\d+) duplicate pairs/.exec(out);
    return m ? Number(m[1]) : 0;
  } catch {
    return null;
  }
}

export interface Metrics {
  lineHits: number;
  fileBranchCoverage: number;
  rule: string;
  testOverlap: number;
  depth: number;
  fnLines: number;
  duplicatePairs: number | null;
}

const WORDS = (text: string): string[] =>
  (text.match(/[A-Za-z_$][\w$]*/g) ?? []).filter((w) => w.length > 2);

/** How long the function containing a line is, by brace depth. */
export function enclosingFunctionLines(text: string, line: number): number {
  const lines = text.split("\n");
  let start = -1;
  for (let i = line - 1; i >= 0; i -= 1) {
    if (/\b(function|=>)\b/.test(lines[i]) && /\{\s*$/.test(lines[i])) {
      start = i;
      break;
    }
    if (/^export (async )?function |^function /.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return lines.length;
  let depth = 0;
  for (let i = start; i < lines.length; i += 1) {
    depth += (lines[i].match(/\{/g) ?? []).length - (lines[i].match(/\}/g) ?? []).length;
    if (i > start && depth <= 0) return i - start + 1;
  }
  return lines.length - start;
}

export function metricsOf(
  subject: Subject,
  task: GreenTask,
  coverage: Coverage,
  duplicatePairs: number | null,
): Metrics {
  const testWords = new Set(task.tests.flatMap((t) => WORDS(t.text)));
  const lineWords = new Set(WORDS(subject.candidate.before));
  let overlap = 0;
  for (const w of lineWords) if (testWords.has(w)) overlap += 1;
  const indent = subject.candidate.before.length - subject.candidate.before.trimStart().length;
  return {
    lineHits: coverage.hits.get(subject.candidate.line) ?? 0,
    fileBranchCoverage:
      coverage.branchesFound === 0 ? 1 : coverage.branchesHit / coverage.branchesFound,
    rule: subject.candidate.rule,
    testOverlap: overlap,
    depth: Math.floor(indent / 2),
    fnLines: enclosingFunctionLines(task.green, subject.candidate.line),
    duplicatePairs,
  };
}

/** The metric block, as the request would carry it. */
export function metricsBlock(m: Metrics): Record<string, unknown> {
  return {
    times_the_tests_execute_this_line: m.lineHits,
    branch_coverage_of_the_file: Number(m.fileBranchCoverage.toFixed(2)),
    what_the_edit_did: m.rule,
    identifiers_shared_with_the_test_names: m.testOverlap,
    nesting_depth_of_the_line: m.depth,
    lines_in_the_enclosing_function: m.fnLines,
    near_duplicate_functions_in_the_file: m.duplicatePairs,
  };
}
