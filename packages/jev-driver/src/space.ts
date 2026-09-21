/**
 * The typed, per-operation action space, and reading the answer back.
 *
 * Ported from `experiments/browser-chaos/src/fanout.ts`, which is the
 * version docs/61 measured. One request carries the `operation` question
 * and a target question for **every** operation; the answer's operation
 * names the one target head that is read, and the rest are thrown away.
 * Measured there: the executed head was identical to what a sequential
 * asker chose — not the same argmax, the same distribution (12/12 at
 * TV 0.000 in production, 21/21 at mean 0.003 adversarially) — with half
 * the requests and 53% less model wall clock.
 *
 * Two constraints decide the shape, and both come from what Jev is:
 *
 *  - **Jev answers `choice`, so it cannot write a string.** A target
 *    cannot carry a model-authored value. Where a value is needed it is
 *    either read off the page (a `<select>`'s own options, offered as
 *    `index:option` pairs) or supplied by code (the text to type). This
 *    is why `CLEAR` has to be an operation rather than a flag on a text
 *    target the way browser-use has it: there is no field on a target a
 *    choice could set.
 *  - **No model output becomes a selector.** Every target key resolves
 *    through this module back to a candidate the crawler collected. The
 *    mapping from answer to element stays on this side.
 */
import type { Question } from "@jev-playground/jev-core";
import { isDropdown, isObstructed, type Enriched } from "./candidate.js";

export type Operation = "CLICK" | "TYPE_TEXT" | "CLEAR" | "SELECT" | "DONE";

/** Operations that name a target. `DONE` does not. */
export const TARGETED: readonly Operation[] = ["CLICK", "TYPE_TEXT", "CLEAR", "SELECT"];

/**
 * What executing one target key means.
 *
 * Generic in the candidate so a caller that has more on it than the
 * model does — the driver holds the selector — gets it back out of the
 * decision without a cast.
 */
export interface TargetEntry<C extends Enriched = Enriched> {
  candidate: C;
  /** For a SELECT target, the option value to set. */
  option?: string;
}

export interface ActionSpace<C extends Enriched = Enriched> {
  /** Operation -> target key -> what it resolves to. */
  heads: Map<Operation, Map<string, TargetEntry<C>>>;
  /** Operations with a non-empty head, plus DONE. */
  offered: Operation[];
}

const OPERATION_CRITERIA: Record<Operation, string> = {
  CLICK: "Click a link, button or control.",
  TYPE_TEXT: "Put text into an editable field.",
  CLEAR:
    "Empty a field that currently holds a value. For when nothing should be in it — replacing the text leaves a different value behind, which is not the same as removing it.",
  SELECT: "Set a dropdown to one of the values it offers.",
  DONE: "The goal is reached, or nothing on this page can advance it.",
};

/**
 * Build the heads. A target only ever appears under an operation that
 * can actually be performed on it, so a chosen (operation, target) pair
 * is executable by construction — there is no "the model picked CLICK on
 * a text field" case to validate away afterwards.
 */
export function actionSpace<C extends Enriched>(candidates: readonly C[]): ActionSpace<C> {
  const heads = new Map<Operation, Map<string, TargetEntry<C>>>();
  const put = (op: Operation, key: string, entry: TargetEntry<C>) => {
    const head = heads.get(op) ?? new Map<string, TargetEntry<C>>();
    head.set(key, entry);
    heads.set(op, head);
  };

  for (const c of candidates) {
    if (c.type === "scroll") continue;
    const key = String(c.index);
    if (c.type === "input") {
      put("TYPE_TEXT", key, { candidate: c });
      // Only a field with something in it can be emptied. Offering
      // CLEAR on an empty field is an action with no end state.
      if (c.currentValue !== "") put("CLEAR", key, { candidate: c });
      continue;
    }
    if (isDropdown(c)) {
      for (const o of c.options) {
        // The pair is the execution unit: "this dropdown, that value".
        // An element-only target leaves the value to the caller's guess,
        // which docs/62 §1 found no shipped implementation does.
        if (o.value === c.currentValue) continue;
        put("SELECT", `${key}:${o.value}`, { candidate: c, option: o.value });
      }
      continue;
    }
    put("CLICK", key, { candidate: c });
  }

  const offered = (TARGETED.filter((op) => (heads.get(op)?.size ?? 0) > 0) as Operation[]).concat([
    "DONE",
  ]);
  return { heads, offered };
}

/**
 * The questions for one step: the operation, every non-empty target
 * head, and `stuck`.
 *
 * `stuck` is asked separately because **a `choice` always names
 * something** (docs/00): without a way to say "none of these", a
 * dead-end page produces a confident click on a decoy. `DONE` in the
 * operation head covers the same ground from the other side; they
 * disagree usefully, and the caller sees both.
 */
export function questionsFor(space: ActionSpace<Enriched>): Record<string, Question> {
  const criteria: Record<string, string> = {};
  for (const op of space.offered) criteria[op] = OPERATION_CRITERIA[op];

  const questions: Record<string, Question> = {
    operation: {
      type: "choice",
      // A question about the answer's shape, not an order to the model.
      // docs/58 measured the cost of instructing: marking a fact as
      // relevant is what gets it read, and telling the model how to act
      // narrowed what it reached (14.0/14 states down to 10.0/14).
      instructions: "Which kind of action does the goal need next on this page?",
      criteria,
    },
    stuck: {
      type: "noul",
      instructions: "This page cannot advance the goal.",
      criteria: {
        true: "Nothing on this page moves the goal forward",
        false: "At least one candidate here makes progress",
      },
    },
  };

  for (const op of space.offered) {
    if (op === "DONE") continue;
    const head = space.heads.get(op);
    if (!head || head.size === 0) continue;
    const targetCriteria: Record<string, string> = {};
    for (const [key, entry] of head) {
      targetCriteria[key] = describeTarget(op, entry);
    }
    questions[`${op}_target`] = {
      type: "choice",
      // Conditioned on the operation, not told which one won — that is
      // the speculation docs/61 measured as free.
      instructions: `If the action is ${op}, which one?`,
      criteria: targetCriteria,
    };
  }
  return questions;
}

function describeTarget(op: Operation, entry: TargetEntry<Enriched>): string {
  const c = entry.candidate;
  const base = `${c.description}`;
  if (op === "SELECT" && entry.option !== undefined) {
    const label = c.options.find((o) => o.value === entry.option)?.label ?? entry.option;
    return `${base} -> set to "${label}"`;
  }
  if (op === "CLEAR") return `${base} (currently "${c.currentValue}")`;
  if (op === "TYPE_TEXT" && c.currentValue) return `${base} (currently "${c.currentValue}")`;
  return base;
}

export interface Decision<C extends Enriched = Enriched> {
  operation: Operation;
  /** Absent for DONE. */
  target?: TargetEntry<C>;
  /** The key the target head returned, for the trace. */
  targetKey?: string;
  operationConfidence: number;
  targetConfidence: number;
  stuck: number;
  /** Heads answered but not read. Their cost is the fan-out's wager. */
  unusedHeads: string[];
}

interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

function asChoice(a: unknown): ChoiceAnswer | null {
  if (typeof a !== "object" || a === null) return null;
  const c = a as Partial<ChoiceAnswer>;
  if (c.type !== "choice" || typeof c.choice !== "string") return null;
  return {
    type: "choice",
    choice: c.choice,
    confidence: typeof c.confidence === "number" ? c.confidence : Number.NaN,
    probabilities: c.probabilities ?? {},
  };
}

function asNoul(a: unknown): number {
  if (typeof a !== "object" || a === null) return Number.NaN;
  const n = a as { type?: string; noul?: unknown };
  return n.type === "noul" && typeof n.noul === "number" ? n.noul : Number.NaN;
}

/**
 * Read the one head the operation names.
 *
 * Returns `null` rather than guessing when the answer does not resolve:
 * a driver that cannot read its own answer has to stand down so the
 * composite behind it can act, and a salvaged pick would be the
 * crawler's least auditable step.
 */
export function readDecision<C extends Enriched>(
  space: ActionSpace<C>,
  answers: Record<string, unknown>,
): Decision<C> | null {
  const op = asChoice(answers.operation);
  if (!op) return null;
  const operation = op.choice as Operation;
  if (!space.offered.includes(operation)) return null;

  const unusedHeads = Object.keys(answers).filter(
    (k) => k.endsWith("_target") && k !== `${operation}_target`,
  );
  const stuck = asNoul(answers.stuck);

  if (operation === "DONE") {
    return {
      operation,
      operationConfidence: op.confidence,
      targetConfidence: Number.NaN,
      stuck,
      unusedHeads,
    };
  }

  const head = space.heads.get(operation);
  const answer = asChoice(answers[`${operation}_target`]);
  if (!head || !answer) return null;
  const target = head.get(answer.choice);
  // The key has to be one this module put in the head. Anything else is
  // an answer to a question that was not asked.
  if (!target) return null;

  return {
    operation,
    target,
    targetKey: answer.choice,
    operationConfidence: op.confidence,
    targetConfidence: answer.confidence,
    stuck,
    unusedHeads,
  };
}
