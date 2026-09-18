/**
 * The corpus: real diffs against a green repository, labelled by the runner.
 *
 * docs/32 asked "does this edit make the suite pass". This asks the reverse,
 * which is what a review is: "does this edit keep the suite passing". The
 * machinery is the same and it is reused rather than rebuilt --
 * `experiments/repair` holds twenty-one small modules with real `node:test`
 * suites beside them, and its candidate generator produces one-line edits.
 *
 * So the subject set is built like this:
 *
 *   1. take each `repair` task and apply a RECORDED FIX, so the suite is green
 *   2. generate every one-line candidate edit against that green file
 *   3. run the suite: the edits that keep it green are `safe`, the rest are not
 *
 * The label is `node --test`'s exit code, again. Nothing is hand-written, and
 * "safe" here means exactly one thing -- the tests still pass -- which is
 * narrower than what a reviewer means and docs/33 says so in its limits.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { candidates, type Candidate } from "../../repair/src/mutate.js";
import type { TaskTruth } from "../../repair/src/record.js";
import { loadTasks, type Task } from "../../repair/src/world.js";

const REPAIR = resolve(import.meta.dirname, "../../repair");

export interface Subject {
  id: string;
  task: string;
  /** The green file this diff is against. */
  base: string;
  /** The file with the diff applied. */
  text: string;
  candidate: Candidate;
}

export interface GreenTask extends Task {
  /** The task's source with a recorded fix applied: the green baseline. */
  green: string;
}

/**
 * The green baseline for each task, and the subjects against it.
 *
 * Tasks with no recorded fix cannot be made green by one edit, so they are
 * skipped -- there is no green base to review a diff against.
 */
export function loadGreenTasks(): GreenTask[] {
  const truths = JSON.parse(readFileSync(resolve(REPAIR, "records/truth.json"), "utf8")) as TaskTruth[];
  const byTask = new Map(truths.map((t) => [t.task, t]));
  const out: GreenTask[] = [];
  for (const task of loadTasks(resolve(REPAIR, "tasks"))) {
    const truth = byTask.get(task.id);
    if (!truth || truth.fixes.length === 0) continue;
    const cs = candidates(task.source);
    // The FIRST recorded fix, so the base is deterministic.
    const fix = cs.find((c) => c.id === truth.fixes[0]);
    if (!fix) continue;
    out.push({ ...task, green: fix.text });
  }
  return out;
}

export function subjectsOf(task: GreenTask): Subject[] {
  return candidates(task.green).map((c) => ({
    id: `${task.id}/${c.id}`,
    task: task.id,
    base: task.green,
    text: c.text,
    candidate: c,
  }));
}

/** A one-line unified diff, which is what a reviewer would see. */
export function diffOf(subject: Subject): string {
  return [
    `--- a/${subject.task}`,
    `+++ b/${subject.task}`,
    `@@ -${subject.candidate.line},1 +${subject.candidate.line},1 @@`,
    `-${subject.candidate.before}`,
    `+${subject.candidate.after}`,
  ].join("\n");
}
