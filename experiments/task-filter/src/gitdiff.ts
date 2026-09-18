/**
 * Reading a real `git diff` into the shape the filter's state expects.
 *
 * Shared by src/cli.ts (the tool) and real/observe-mutations.ts (the real-repo
 * measurement), so the diff a measurement scores is produced by exactly the
 * code the tool uses.
 */
import { execFileSync } from "node:child_process";
import type { ChangedFile } from "./scenarios.js";

/** A lockfile diff can be tens of thousands of lines; the budget is not. */
export interface DiffLimits {
  maxHunk: number;
  maxTotal: number;
}

export const DEFAULT_LIMITS: DiffLimits = { maxHunk: 4000, maxTotal: 60_000 };

export function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 << 20 });
}

/** Split a `git diff` into per-file patches, keyed by the new path. */
export function splitDiff(diff: string): Map<string, string> {
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

/**
 * The changed files in `dir`, against `base` (a revision) or the worktree.
 * `extra` is passed through to git, so a caller can ask for staged changes or a
 * specific commit range.
 */
export function changedFiles(
  dir: string,
  range: string[],
  limits: DiffLimits = DEFAULT_LIMITS,
): ChangedFile[] {
  const numstat = git(["diff", "--numstat", ...range], dir).trim();
  if (numstat === "") return [];
  const patches = splitDiff(git(["diff", "-U3", ...range], dir));
  const statuses = new Map<string, string>();
  for (const line of git(["diff", "--name-status", ...range], dir).trim().split("\n")) {
    const parts = line.split("\t");
    statuses.set(parts[parts.length - 1], parts[0]);
  }
  let budget = limits.maxTotal;
  return numstat.split("\n").map((line) => {
    const [added, removed, path] = line.split("\t");
    const code = statuses.get(path) ?? "M";
    let hunk = patches.get(path) ?? "";
    if (hunk.length > limits.maxHunk) hunk = `${hunk.slice(0, limits.maxHunk)}\n... (truncated)`;
    if (hunk.length > budget) {
      hunk = budget > 0 ? `${hunk.slice(0, budget)}\n... (truncated)` : "(omitted)";
    }
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

/** Nothing uncommitted. Every mutation run depends on this being true first. */
export function isClean(dir: string): boolean {
  return git(["status", "--porcelain"], dir).trim() === "";
}
