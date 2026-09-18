/**
 * What Jev is shown, and the one thing the arms vary: how much of the diff.
 *
 * docs/17 varied the task table and found that repository context changed
 * nothing -- but there the state also held a sentence saying what the person
 * wanted, and the sentence had already answered the question. Here there is no
 * such sentence, so the ladder runs over the CHANGE instead:
 *
 *   paths       the file list, as `git diff --name-only` prints it
 *   stat        + status and line counts, as `git diff --stat` prints it
 *   diff        + the hunks themselves
 *   diff_graph  the hunks, and the graph facts about each task in its question
 *
 * The one line of prose per task is on in every arm. docs/17 already settled
 * that one (name-only 90.0% -> descriptions 100.0%), so re-measuring it here
 * would spend requests on a known answer; `just`'s doc comment is where it
 * comes from, which is where a real justfile keeps it anyway.
 */
import type { Question } from "../../shared/jev.js";
import type { Task, TaskGraph } from "./graph.js";
import type { Scenario } from "./scenarios.js";

export type ArmName = "paths" | "stat" | "diff" | "diff_graph";

export const ARMS: ArmName[] = ["paths", "stat", "diff", "diff_graph"];

export const ARM_BLURB: Record<ArmName, string> = {
  paths: "file paths only            (git diff --name-only)",
  stat: "paths + line counts        (git diff --stat)",
  diff: "the patch itself           (git diff)",
  diff_graph: "the patch + graph facts    (deps, inputs and cost per task)",
};

/** Answer keys for the two whole-diff judgments, kept out of the task namespace. */
export const BEHAVIOUR = "_changes_behaviour";
export const ALL_WASTE = "_all_waste";

const REPO =
  "acme, a pnpm monorepo: web/ (React app), api/ (Fastify + GraphQL + Postgres), " +
  "packages/shared (domain types and money), packages/ui (component library), " +
  "infra/ (Terraform), docs/ (VitePress), e2e/ (Playwright specs)";

/**
 * The ordered rungs of the per-task answer. `score` rather than a noul because
 * the question is how MUCH, and docs/17's largest single effect was matching
 * the answer's shape to the question's shape.
 */
export const SCORE_CRITERIA = [
  "Waste: nothing this task checks can be affected by this change.",
  "Insurance: this task covers the area the change touches, but a failure would be a surprise.",
  "Required: this change can plausibly break exactly what this task checks.",
];

export function stateFor(arm: ArmName, scenario: Scenario, intent: boolean): unknown {
  const files = scenario.files.map((f) => {
    if (arm === "paths") return f.path;
    if (arm === "stat") {
      return { path: f.path, status: f.status, added: f.added, removed: f.removed };
    }
    return { path: f.path, status: f.status, diff: f.hunk };
  });
  return {
    repo: REPO,
    // A branch name and a commit subject are what a pre-commit hook actually
    // holds. `--no-intent` drops both, which is the ablation docs/17 §8 asked
    // for: the same diff with nothing saying what it is for.
    ...(intent ? { branch: scenario.branch, commit_subject: scenario.subject } : {}),
    changed_files: files,
  };
}

function instructionsFor(arm: ArmName, task: Task, graph: TaskGraph): Record<string, unknown> {
  const base: Record<string, unknown> = {
    task: task.name,
    does: task.doc,
    question:
      `Before this change merges, how much does the task \`${task.name}\` need to run?`,
  };
  if (arm !== "diff_graph") return base;
  // The graph in the prompt rather than in the closure. Measured because it is
  // the obvious thing to try, not because it is expected to help: the closure
  // already handles prerequisites, so this is paying tokens for what the code
  // does for free.
  return {
    ...base,
    needs: graph.ordered(graph.closure([task.name])).filter((n) => n !== task.name),
    declared_inputs: task.inputs,
    costs_seconds: task.cost,
  };
}

/**
 * One request. 18 goals plus two whole-diff judgments is 20 questions, which is
 * the fan-out docs/00 measured at 21x faster and 8x cheaper than asking one at
 * a time -- and the reason a per-task score is affordable at all.
 */
export function questionsFor(arm: ArmName, graph: TaskGraph): Record<string, Question> {
  const questions: Record<string, Question> = {};
  for (const task of graph.goals()) {
    questions[task.name] = {
      type: "score",
      instructions: instructionsFor(arm, task, graph),
      criteria: SCORE_CRITERIA,
    };
  }
  // Two judgments about the diff as a whole. Output is free and one more
  // question costs only its own wording (docs/00), and these two are the ones
  // no glob can make: whether the patch can change behaviour at all, and
  // whether the right answer is to run nothing.
  questions[BEHAVIOUR] = {
    type: "noul",
    instructions: "This change can alter how the product behaves at runtime.",
    criteria: {
      true: "Executable behaviour changes: logic, types, dependencies, schema, configuration or infrastructure.",
      false:
        "Nothing executable changes. Comments, documentation, formatting, or a script only used " +
        "by developers on their own machines.",
    },
  };
  questions[ALL_WASTE] = {
    type: "noul",
    instructions: "Every check in this repository would pass on this change without being run.",
    criteria: {
      true: "No check can go red because of this change; running any of them is spending time to learn nothing.",
      false: "At least one check could plausibly fail because of this change.",
    },
  };
  return questions;
}
