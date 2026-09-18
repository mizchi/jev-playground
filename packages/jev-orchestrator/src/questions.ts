/**
 * The gate, the topology, and the one setting docs/31 measured as a dial.
 *
 * docs/31 set out to find whether a documented boolean gate is better ASKED
 * or COMPOSED, and three of its findings decide this file:
 *
 *   1. COMPOSING BUYS NOTHING. The skill writes the rule as `(1 or 2) and 4`
 *      over four named conditions. Composing those four in code got 30/38;
 *      asking the same decision as ONE noul got 30/38. So this asks one
 *      question, because the four-question version has four more ways to be
 *      wrong for no measured gain.
 *
 *   2. THE WORDING IS A 21-POINT DIAL, and it is not a single ranking. The
 *      same decision, asked with the second worker's cost stated first,
 *      scored 22/38; with the cost sentence removed, 30/38. But the per-class
 *      breakdown (docs/31 §2b) shows the two are not better and worse, they
 *      are strict and loose:
 *
 *        class                     n    cost named    cost unnamed
 *        the skill's own traps     7    6/7           4/7
 *        plainly multi             22   6/22          18/22
 *        plainly single            6    6/6           5/6
 *
 *      Naming the cost is strict: it catches the traps and refuses work that
 *      should have been split. Not naming it is permissive. So the choice
 *      belongs to whoever is paying, which is why `framing` is a setting --
 *      and why its default here is `cost`. A resident agent's expensive error
 *      is the unnecessary fan-out: every spurious worker is a full-price
 *      session, and this package exists to keep a cheap agent cheap.
 *
 *   3. CONDITION 3 IS NOT A REASON TO SPAWN, in the skill's own bold. Putting
 *      it into the rule loses 4/4 on the cases written to test exactly that.
 *      Asking directly never introduces it, which is a second reason to
 *      prefer the direct form: a rule you do not build cannot acquire a term
 *      the documentation forbids.
 *
 * The topology `choice` is the strongest single measurement in the repo:
 * 22/22, zero confusions between patterns. It rides the same request as the
 * gate because width is free (docs/29 §4), so the shape is known before
 * anyone has decided whether to use it.
 */
import type { Question } from "@jev-playground/jev-core";

export const GATE = "needs_more_than_one";
export const TOPOLOGY = "topology";
export const STAY_SINGLE = "stay_single";
export const SIZE = "big_enough";

/** The skill's eight patterns, and its own table as the criteria. */
export const PATTERNS = [
  "sequential",
  "fanout",
  "supervisor",
  "handoff",
  "blackboard",
  "debate",
  "dynamic_dag",
  "evolution",
] as const;
export type Pattern = (typeof PATTERNS)[number];

export const PATTERN_USE: Record<Pattern, string> = {
  sequential: "A clear transform pipeline: A then B then C, each step consuming the last one's output.",
  fanout: "Independent work in parallel then merged: research, a known candidate set, independent tests.",
  supervisor: "Open-ended research or development where a manager has to decompose, assign and replan.",
  handoff: "Routing where ownership moves to the next specialist, who then owns the reply.",
  blackboard: "Long-running asynchronous development around a shared task board and shared artifacts.",
  debate: "A judgment that is hard to grade, answered independently and then critiqued or voted on.",
  dynamic_dag: "Difficulty varies so widely that the roles, dependencies and parallelism must be chosen at run time.",
  evolution: "The same class of task repeats often enough to search over workflows themselves.",
};

/** Which patterns run workers at the same time. Used by the policy, not asked. */
export const PARALLEL: ReadonlySet<Pattern> = new Set<Pattern>(["fanout", "supervisor", "debate", "dynamic_dag", "blackboard"]);

export type Framing = "cost" | "plain";

/**
 * The gate's cutoff, per framing, fitted on docs/31's 38 scenarios.
 *
 * `experiments/orchestration/src/fit.ts` (no API key; the record already
 * exists) and its write-up in docs/31 §8. The headline reason these are two
 * numbers and not one: THE TWO WORDINGS ANSWER ON DIFFERENT SCALES.
 *
 *   wording        min    max    mean(single)   mean(multi)   draw sd
 *   cost named     0.090  0.780  0.208          0.406         0.012
 *   cost unnamed   0.110  0.950  0.320          0.665         0.013
 *
 * Read at a shared 0.5, the compressed wording looks strict -- which is a
 * large part of what docs/31 §2b measured as a framing effect. On plain
 * agreement, giving each wording its own cutoff narrows the gap between them
 * from 20 points (66 vs 89 of 114) to 8 (84 vs 93).
 *
 * The values below are NOT the accuracy-maximising cutoffs. They are the ones
 * that minimise a cost-weighted loss in the regime a resident agent is in --
 * an unnecessary worker is a whole extra session, so a false positive costs
 * about ten times a false negative -- restricted to the placements whose
 * cross-validation fold cutoffs held still (docs/25 §2). At penalty 10, six
 * of the nine configurations tried came out WORSE than always-single, so this
 * is a narrow target rather than a matter of taste:
 *
 *   wording        cutoff   tp/fp/fn/tn (held out)   loss   vs always-single
 *   cost named     0.500    18/0/48/48               0.421  0.158 better
 *   cost unnamed   0.730    36/2/30/46               0.439  0.140 better
 *   cost unnamed   0.500    53/12/13/36              1.167  0.588 WORSE
 *
 * So `cost`'s shipped 0.5 was right, and it is right for a reason worth
 * knowing: on this corpus it is that wording's zero-false-positive point.
 * `plain` at the same 0.5 is the worst configuration measured.
 *
 * If errors are symmetric rather than asymmetric, these are the wrong numbers
 * -- at penalty 1, `plain` at 0.5 wins. Set `gateAt` explicitly for that.
 */
export const GATE_AT: Record<Framing, number> = { cost: 0.5, plain: 0.73 };

/** The fitted cutoff for a framing, or the caller's own if they pinned one. */
export function gateAtFor(framing: Framing, pinned: number | null | undefined): number {
  return typeof pinned === "number" ? pinned : GATE_AT[framing];
}

/**
 * The gate's two wordings, verbatim from docs/31's arms so the measured
 * numbers describe these strings and not a paraphrase of them.
 */
const GATE_TEXT: Record<Framing, { instructions: string; criteria: { true: string; false: string } }> = {
  cost: {
    instructions:
      "Running a second worker on this costs tokens, latency and a chance of one worker's " +
      "mistake propagating into the other's input. Is this work better done by more than one?",
    criteria: {
      true: "More than one worker is worth it here.",
      false: "One worker, taking as many turns as it needs, is the better way to do this.",
    },
  },
  plain: {
    instructions: "Is this work better done by more than one worker, or by one?",
    criteria: { true: "By more than one.", false: "By one." },
  },
};

export interface PlanInput {
  /** What the requester said. The only thing the gate sees. */
  request: string;
  cwd?: string;
  /** Files already in play, when the host knows them. */
  files?: string[];
}

export function stateFor(input: PlanInput): Record<string, unknown> {
  return {
    what: "someone describing a piece of work they are about to start",
    request: input.request,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.files && input.files.length > 0 ? { files: input.files } : {}),
  };
}

export function questionsFor(framing: Framing): Record<string, Question> {
  const gate = GATE_TEXT[framing];
  return {
    [GATE]: { type: "noul", instructions: gate.instructions, criteria: gate.criteria },
    [TOPOLOGY]: {
      type: "choice",
      instructions: "If this work were split across more than one worker, which shape would fit it?",
      criteria: Object.fromEntries(PATTERNS.map((p) => [p, PATTERN_USE[p]])),
    },
    // Asked, recorded, and deliberately NOT wired into the decision. docs/31
    // §2b measured this inverted framing as the LOOSEST reading of all on the
    // skill's own trap cases (3/7 against the gate's 6/7), so letting it veto
    // would replace the strictest signal with the weakest. It stays because
    // it is free and it belongs in the audit line: a gate that fires while
    // this also fires is the disagreement worth looking at.
    [STAY_SINGLE]: {
      type: "noul",
      instructions: "Setting the shapes aside: is this work one that one worker should simply do by itself?",
      criteria: { true: "Yes, none of the shapes apply; one worker is right.", false: "No, splitting it is right." },
    },
    // Size, asked as a size fact rather than as a cost judgment. The policy
    // needs a scale to pick a worker count, and asking "is this big" is a
    // different question from "is another worker worth it" -- conflating them
    // is what docs/31 §2's framing result is about.
    [SIZE]: {
      type: "noul",
      instructions:
        "How large is this piece of work? A second worker costs tokens and latency whatever the " +
        "task is, so the question is whether the task is large enough for that to be small.",
      criteria: {
        true: "Large: hours to weeks of work, or many items to get through.",
        false: "Small: minutes, a handful of lines, or a single edit.",
      },
    },
  };
}

/** Everything one request would carry, for the leak test. */
export function payloadOf(input: PlanInput, framing: Framing): string {
  return JSON.stringify({ state: stateFor(input), questions: questionsFor(framing) });
}
