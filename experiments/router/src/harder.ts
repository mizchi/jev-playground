/**
 * Harder tasks, composed mechanically, because the easy corpus saturated.
 *
 *   npx tsx src/harder.ts            # writes tasks-hard/, verifies each one
 *
 * docs/33 §1's lesson turned on me. The first thing §5 measured was the base
 * rate, and the cheapest tier fixed the twenty-one repair tasks outright --
 * so on that corpus there is nothing for a router to decide, and every arm
 * would have tied at "always route cheap". The corpus, not the router, was
 * the finding.
 *
 * So the ladder needs rungs. These are built rather than written, which
 * matters: docs/24 measured that a sentence calibrated on planted bugs does
 * not transfer to real code, and a corpus I authored to be "hard" would be a
 * corpus authored to make the router look useful. Instead:
 *
 *   1. `experiments/review` already computes a GREEN base for each repair
 *      task -- the source with its first recorded fix applied.
 *   2. Its recorded truth holds 261 one-line candidate edits against those
 *      bases, each labelled by whether `node --test` still passed. The 215
 *      that broke it are exactly a supply of verified bugs.
 *   3. Composing k of them on distinct lines gives a task with k independent
 *      bugs, and k is the difficulty axis.
 *
 * Every composed task is then verified the same way the labels are: it must
 * PARSE (some mutations are syntax errors, which no model finds hard) and it
 * must FAIL. A task that does neither is dropped rather than shipped.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadGreenTasks } from "../../review/src/subjects.js";

const REVIEW = resolve(import.meta.dirname, "../../review");
const OUT = resolve(import.meta.dirname, "../tasks-hard");

interface Subject {
  id: string;
  task: string;
  line: number;
  before: string;
  after: string;
  safe: boolean;
  metrics: { rule: string };
}

/** How many bugs each generated tier carries. */
export const BUG_COUNTS = [2, 3] as const;

export interface HardTask {
  id: string;
  from: string;
  bugs: number;
  rules: string[];
  lines: number[];
}

function breakingSubjects(): Map<string, Subject[]> {
  const truth = JSON.parse(readFileSync(resolve(REVIEW, "records/truth.json"), "utf8")) as {
    subjects: Subject[];
  };
  const byTask = new Map<string, Subject[]>();
  for (const s of truth.subjects) {
    if (s.safe) continue;
    const list = byTask.get(s.task) ?? [];
    list.push(s);
    byTask.set(s.task, list);
  }
  // Sorted by id, so which bugs a task gets is deterministic and re-derivable.
  for (const list of byTask.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  return byTask;
}

/**
 * Apply one recorded edit by line number, not by search-and-replace.
 *
 * By line because `before` can occur more than once in a file, and a
 * replace-first would then plant the bug somewhere the label was never
 * measured against.
 *
 * `review`'s recorded `line` is ONE-indexed. Read as a zero-index it lands
 * one line late, every edit's `before` fails to match, and this file
 * cheerfully produced zero tasks with no error at all -- the failure mode
 * being a verification that verifies nothing.
 */
function applyAt(source: string, line: number, before: string, after: string): string | null {
  const lines = source.split("\n");
  const i = line - 1;
  if (lines[i] !== before) return null;
  lines[i] = after;
  return lines.join("\n");
}

/**
 * Does this text parse as an ES module?
 *
 * The extension is `.mjs` and that is the whole point. `node --check` on a
 * `.js` file guesses the module type from the nearest `package.json`, and in
 * a bare temporary directory there is none -- so it guessed differently than
 * it does inside this repository, said "fine" to `xs.every((v) =>= f(v))`,
 * and a syntax error went straight into the corpus. The test caught it.
 * `.mjs` leaves nothing to guess.
 */
function parses(text: string): boolean {
  const dir = resolve(tmpdir(), `parse-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, "candidate.mjs");
    writeFileSync(file, text);
    execFileSync("node", ["--check", file], { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fails(dir: string): boolean {
  try {
    execFileSync("node", ["--test"], { cwd: dir, stdio: "ignore", timeout: 120_000 });
    return false;
  } catch {
    return true;
  }
}

function main(): void {
  const breaking = breakingSubjects();
  const made: HardTask[] = [];
  rmSync(OUT, { recursive: true, force: true });

  for (const task of loadGreenTasks()) {
    const pool = breaking.get(task.id) ?? [];
    for (const bugs of BUG_COUNTS) {
      // Distinct lines, so the bugs cannot overwrite each other and each one
      // is still the edit its label was measured on.
      const chosen: Subject[] = [];
      const usedLines = new Set<number>();
      let text = task.green;
      for (const s of pool) {
        if (chosen.length === bugs) break;
        if (usedLines.has(s.line)) continue;
        const next = applyAt(text, s.line, s.before, s.after);
        if (next === null) continue;
        if (!parses(next)) continue;
        text = next;
        usedLines.add(s.line);
        chosen.push(s);
      }
      if (chosen.length !== bugs) continue;

      const id = `${task.id}-k${bugs}`;
      const dir = resolve(OUT, id);
      mkdirSync(resolve(dir, "src"), { recursive: true });
      mkdirSync(resolve(dir, "test"), { recursive: true });
      writeFileSync(resolve(dir, task.path), text);
      for (const t of task.tests) writeFileSync(resolve(dir, t.path), t.text);
      if (!fails(dir)) {
        // Every chosen edit broke the suite on its own, so k of them together
        // failing is expected -- but two bugs can cancel, and a task that
        // passes is not a task.
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      made.push({ id, from: task.id, bugs, rules: chosen.map((c) => c.metrics.rule), lines: chosen.map((c) => c.line) });
    }
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    resolve(OUT, "index.json"),
    `{\n"source": "green bases from experiments/review, breaking edits from its recorded truth",\n` +
      `"tasks": [\n${made.map((m) => JSON.stringify(m)).join(",\n")}\n]\n}\n`,
  );
  const byK = new Map<number, number>();
  for (const m of made) byK.set(m.bugs, (byK.get(m.bugs) ?? 0) + 1);
  if (made.length === 0) {
    console.error("  no hard tasks were composed. That is a bug here, not a fact about the corpus.");
    process.exit(1);
  }
  console.log(`  ${made.length} hard tasks -> tasks-hard/`);
  for (const [k, n] of [...byK].sort()) console.log(`    ${n} tasks with ${k} bugs`);
  const rules = new Map<string, number>();
  for (const m of made) for (const r of m.rules) rules.set(r, (rules.get(r) ?? 0) + 1);
  console.log(`    mutation classes used: ${[...rules].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(", ")}`);
}

if (process.argv[1]?.endsWith("harder.ts")) main();
