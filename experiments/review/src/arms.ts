/**
 * Four reviews of the same diffs, differing only in what they are shown.
 *
 *   blind        the diff alone. The "fast review" extreme.
 *   diff         the diff plus the file it is against and the tests beside it.
 *   metrics      the same, plus the mechanical metric block.
 *   onlymetrics  the diff plus the metrics, with the file and the tests taken
 *                away -- so the metrics' own contribution is visible rather
 *                than inferred from the gap between two arms that both hold
 *                everything else.
 *
 * The shape is docs/29 §4's: one request per (task, arm), the task-level
 * material in the STATE and one question per diff, because a question's
 * answer does not move with the request's width. Eighteen diffs times three
 * questions is 54 questions in a request, well under what docs/30 §1
 * measured as the ceiling.
 *
 * The no-judgment control is not an arm: it is a logistic fit over the same
 * metrics, cross-validated by task, and it lives in `run.ts` because it
 * makes no requests (docs/25's `logisticFit`).
 */
import type { Question } from "../../shared/jev.js";
import { metricsBlock, type Metrics } from "./metrics.js";
import type { GreenTask } from "./subjects.js";

export const ARMS = ["blind", "diff", "metrics", "onlymetrics"] as const;
export type ArmName = (typeof ARMS)[number];

export const ARM_BLURB: Record<ArmName, string> = {
  blind: "the diff alone",
  diff: "the diff, the file it changes, and the tests",
  metrics: "all of that plus the mechanical metrics",
  onlymetrics: "the diff plus the metrics, with the file and the tests removed",
};

export const SAFE = "safe";
export const RISK = "risk";
export const REACHED = "reached";

/** Which questions carry a label. `REACHED` is checked against the coverage. */
export const KINDS = [SAFE, RISK, REACHED] as const;
export type Kind = (typeof KINDS)[number];

export function keyFor(kind: Kind, id: string): string {
  return `${kind}_${id.replace(/[^\w]/g, "_")}`;
}

/** The state: what is true of the whole task, for the arms that get it. */
export function stateFor(arm: ArmName, task: GreenTask): Record<string, unknown> {
  const head = {
    what: "one-line changes to a JavaScript module whose test suite currently passes",
    file: task.path,
  };
  if (arm === "blind" || arm === "onlymetrics") return head;
  return {
    ...head,
    source_before_the_changes: task.green,
    tests: task.tests.map((t) => ({ file: t.path, source: t.text })),
  };
}

export interface Asked {
  id: string;
  line: number;
  before: string;
  after: string;
  metrics: Metrics;
}

/**
 * Three questions per diff, and only the first two are about the label.
 *
 * `SAFE` is scored against the runner's exit code. `RISK` is the same
 * decision as a level, to see whether an ordered answer separates better
 * than a yes/no. `REACHED` has a mechanical answer too -- the coverage count
 * is in the truth -- so it doubles as a check on whether the judgment can
 * work out a thing the `metrics` arm is handed outright.
 */
export function questionsFor(arm: ArmName, asked: readonly Asked[]): Record<string, Question> {
  const out: Record<string, Question> = {};
  for (const a of asked) {
    const change: Record<string, unknown> = { line: a.line, from: a.before.trim(), to: a.after.trim() };
    if (arm === "metrics" || arm === "onlymetrics") change.measured = metricsBlock(a.metrics);
    out[keyFor(SAFE, a.id)] = {
      type: "noul",
      instructions: {
        task:
          "The suite passes before this change. Would it still pass with this change applied, " +
          "and nothing else changed?",
        change,
      },
      criteria: { true: "Every test still passes.", false: "At least one test fails." },
    };
    out[keyFor(RISK, a.id)] = {
      type: "score",
      instructions: { task: "How much does this change risk breaking what the tests check?", change },
      criteria: [
        "None. It cannot change what any test observes.",
        "Slight. It changes behaviour only in a case the tests do not reach.",
        "Real. It changes behaviour the tests check, but the check might still hold.",
        "It breaks a test.",
      ],
    };
    out[keyFor(REACHED, a.id)] = {
      type: "noul",
      instructions: { task: "Do the tests execute the line this change touches?", change },
      criteria: { true: "Yes, the tests run that line.", false: "No, the tests never reach it." },
    };
  }
  return out;
}

/** Everything one request sends, as text, for the leak test. */
export function payloadOf(arm: ArmName, task: GreenTask, asked: readonly Asked[]): string {
  return JSON.stringify([stateFor(arm, task), questionsFor(arm, asked)]);
}
