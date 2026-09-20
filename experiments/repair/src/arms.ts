/**
 * The orderings, and what each one costs.
 *
 * Everything deterministic is already done by the time an arm runs: the
 * candidates exist, the baseline failure is captured, and the test runner is
 * waiting. All an arm does is put the candidates in an order. The metric is
 * then mechanical -- how many test runs until the suite goes green.
 *
 *   generation   the generator's own order. No judgment, no requests.
 *   random       a seeded shuffle. The control that says what the order is
 *                worth at all.
 *   overlap      free: candidates whose changed line shares an identifier
 *                with the failing assertion first.
 *   score        one `score` question per candidate, one request (docs/29 §4
 *                established that width is free), ordered by the level.
 *   choice       ONE `choice` over every candidate. The answer's
 *                `probabilities` map is a full ordering from a single
 *                question, which is the cheapest arm that uses a judgment.
 *   noul         one `noul` per candidate, for the shape comparison.
 */
import type { Question } from "../../shared/jev.js";
import type { Candidate } from "./mutate.js";
import type { Task } from "./world.js";

export const ARMS = ["score", "choice", "noul"] as const;
export type ArmName = (typeof ARMS)[number];

export const FREE = ["generation", "random", "overlap"] as const;
export type FreeName = (typeof FREE)[number];

export const ARM_BLURB: Record<ArmName | FreeName, string> = {
  generation: "the generator's own order; no judgment",
  random: "a seeded shuffle",
  overlap: "identifiers shared with the failing assertion, first",
  score: "one score question per candidate, in one request",
  choice: "one choice over every candidate; its probabilities are the order",
  noul: "one noul per candidate, in one request",
};

export const FIX = "is_the_fix";
export const PICK = "which_edit";

/**
 * The state: the broken file, its tests, and what the runner said.
 *
 * Not the blurb. `world.ts` reads a one-line description of each planted bug
 * out of the task directory and nothing ever puts it in a request -- it is
 * there so a person reading the corpus knows what the answer is.
 */
export function stateFor(task: Task, baseline: string): Record<string, unknown> {
  return {
    what: "a JavaScript module whose test suite is failing",
    file: task.path,
    source: task.source,
    tests: task.tests.map((t) => ({ file: t.path, source: t.text })),
    test_output: baseline,
  };
}

const ASK =
  "One line of the module below has a bug that makes the suite fail. This is a candidate " +
  "edit to one line. Would applying it, and nothing else, make every test pass?";

export function questionsFor(arm: ArmName, cands: readonly Candidate[]): Record<string, Question> {
  if (arm === "choice") {
    return {
      [PICK]: {
        type: "choice",
        instructions:
          "One line of the module below has a bug that makes the suite fail. Each option is a " +
          "candidate edit to one line, written as the line before and the line after. Which one " +
          "makes every test pass?",
        criteria: Object.fromEntries(
          cands.map((c) => [keyFor(c), { line: c.line, from: c.before.trim(), to: c.after.trim() }]),
        ),
      },
    };
  }
  const out: Record<string, Question> = {};
  for (const c of cands) {
    const edit = { line: c.line, from: c.before.trim(), to: c.after.trim() };
    out[keyFor(c)] =
      arm === "noul"
        ? {
            type: "noul",
            instructions: { task: ASK, edit },
            criteria: {
              true: "Yes: this edit alone makes the suite pass.",
              false: "No: the suite still fails, or this edit breaks something else.",
            },
          }
        : {
            type: "score",
            instructions: { task: ASK, edit },
            criteria: [
              "No. This line is not where the bug is, or the edit makes things worse.",
              "The right line, but the wrong edit to it.",
              "Plausible: it could be the fix, but something else is more likely.",
              "Yes: this is the fix.",
            ],
          };
  }
  return out;
}

/** Question keys have to be identifiers, and candidate ids contain a colon. */
export function keyFor(c: Candidate): string {
  return `c${c.id.replace(/[^\w]/g, "_")}`;
}

/** Everything one request sends, as text, for the leak test. */
export function payloadOf(arm: ArmName, task: Task, baseline: string, cands: readonly Candidate[]): string {
  return JSON.stringify([stateFor(task, baseline), questionsFor(arm, cands)]);
}
