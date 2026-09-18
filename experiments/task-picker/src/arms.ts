/**
 * How much of each task we reveal, and how the "none of these" case is offered.
 *
 * The split follows the repo's two standing rules: the `choice` criteria are
 * the legal moves and nothing else (name-only, docs/00), while everything the
 * decision needs sits in the structured state (docs/01). So an arm varies the
 * TASK TABLE IN THE STATE, not the criteria -- which also means the escape
 * gate, a separate noul, sees exactly the same information as the pick.
 *
 *   names        -- task names only. The roster as a bare `package.json` key list.
 *   names_escape -- same, plus an explicit "(none of these)" choice option.
 *   descriptions -- name + one line of prose per task.
 *   commands     -- name + the real shell command (the hidden implementation).
 */
import type { Question } from "../../shared/jev.js";
import type { Scenario } from "./scenarios.js";
import type { Task } from "./roster.js";

export type ArmName = "names" | "names_escape" | "descriptions" | "commands";

export const ARMS: ArmName[] = ["names", "names_escape", "descriptions", "commands"];

export const ARM_BLURB: Record<ArmName, string> = {
  names: "task names only              (the roster as a bare key list)",
  names_escape: "names + an explicit escape   (closed world broken on purpose)",
  descriptions: "names + one-line prose       (what a good README would say)",
  commands: "names + the real command     (the implementation revealed)",
};

/** The inline "no task fits" option, offered only by the names_escape arm. */
export const ESCAPE = "(none of these)";

/** Decision for the escape case, used as a sentinel everywhere. */
export const NONE = "__none__";

export function questionsFor(arm: ArmName, tasks: Task[]): Record<string, Question> {
  const criteria: Record<string, null | string> = {};
  for (const t of tasks) criteria[t.name] = null;
  if (arm === "names_escape") {
    criteria[ESCAPE] =
      "No task in the list does what the goal asks; this needs something else";
  }
  return {
    // The legal moves, and only the legal moves: a task that is not in the
    // roster cannot be expressed (docs/02, docs/03).
    pick: {
      type: "choice",
      instructions: "Which task should be run to accomplish the goal in the state?",
      criteria,
    },
    // Asked in every arm, because output is free and one more question costs
    // only its own wording (docs/00). This is the second way of saying "none".
    applicable: {
      type: "noul",
      instructions:
        "One of the tasks in the state's task list accomplishes the goal on its own.",
      criteria: {
        true: "At least one listed task does what the goal asks.",
        false:
          "No listed task does this. Accomplishing the goal needs something other " +
          "than running one of these tasks.",
      },
    },
  };
}

export function stateFor(
  arm: ArmName,
  scenario: Scenario,
  tasks: Task[],
  withContext: boolean,
): unknown {
  const table =
    arm === "descriptions"
      ? tasks.map((t) => ({ name: t.name, description: t.description }))
      : arm === "commands"
        ? tasks.map((t) => ({ name: t.name, command: t.command }))
        : tasks.map((t) => t.name);

  const base = {
    goal: scenario.goal,
    runner: "npm scripts (package.json)",
    tasks: table,
  };
  if (!withContext) return base;
  return {
    ...base,
    cwd: "/repo",
    repo: "pnpm monorepo: apps/web, apps/api, packages/{shared,ui,cli,worker}",
    changed_files: scenario.changedFiles ?? [],
    last_command: scenario.lastCommand ?? null,
  };
}
