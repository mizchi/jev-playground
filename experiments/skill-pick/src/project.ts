/**
 * Reading a REAL directory into the same shape the synthetic projects have.
 *
 * docs/29's honest limit was that its fourteen projects were written by me.
 * The CLI closes half of that: it points at a directory on disk and builds
 * the project facts from what is actually there. The `request` is still a
 * person's sentence, because it has to be -- it is the thing a file tree
 * cannot say (docs/29 §5's `ask` class is 30 of the 135 positives).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Project } from "../../skill-select/src/projects.js";

const SKIP = new Set([
  ".git", "node_modules", "_build", ".mooncakes", "target", "dist", "build",
  ".next", ".venv", "__pycache__", ".pytest_cache", "vendor", ".turbo",
]);

/**
 * The paths that carry a signal, not every path.
 *
 * A file tree is the wrong size to hand over whole -- this repository has
 * 9,315 lines of its own code and several thousand files under
 * `node_modules`. What a selector needs is the SHAPE: manifests and configs
 * at the top, directory names below them, and a few representative leaves.
 */
export function surveyFiles(root: string, opts: { maxDepth?: number; maxFiles?: number } = {}): string[] {
  const maxDepth = opts.maxDepth ?? 3;
  const maxFiles = opts.maxFiles ?? 120;
  const out: string[] = [];
  const walk = (dir: string, prefix: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry)) continue;
      if (out.length >= maxFiles) return;
      const path = resolve(dir, entry);
      let s;
      try {
        s = statSync(path);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        out.push(`${prefix}${entry}/`);
        if (depth < maxDepth) walk(path, `${prefix}${entry}/`, depth + 1);
      } else {
        out.push(`${prefix}${entry}`);
      }
    }
  };
  walk(root, "", 0);
  return out;
}

/** The `CLAUDE.md` lines that are actually rules, not prose. */
export function claudeMdLines(root: string, max = 20): string[] {
  for (const name of ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md"]) {
    let text: string;
    try {
      text = readFileSync(resolve(root, name), "utf8");
    } catch {
      continue;
    }
    const lines = text
      .split("\n")
      .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
      .filter((l) => l.length > 0 && l.length < 160 && !l.startsWith("#") && !l.startsWith("```"));
    return lines.slice(0, max);
  }
  return [];
}

export function readProject(root: string, intent: string): Project {
  return {
    id: basename(resolve(root)),
    blurb: `read from ${resolve(root)}`,
    // A real directory has no declared sections, so it has no label. The CLI
    // produces a proposal; only the synthetic projects can be scored.
    signals: [],
    asked: [],
    files: surveyFiles(root),
    claudeMd: claudeMdLines(root),
    intent,
  };
}
