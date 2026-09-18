/**
 * The contract between the agent and the harness.
 *
 * The agent writes the questions AND how to read the answers, but it writes
 * the reading part declaratively rather than as code: a question name, and
 * either thresholds over a score or a map over choices. Nothing gets eval'd,
 * and the harness stays the only thing that talks to the API.
 */
import type { Question } from "../../shared/jev.js";

export type Verdict = "allow" | "confirm" | "block";
export const VERDICTS: Verdict[] = ["allow", "confirm", "block"];
export const RANK: Record<Verdict, number> = { allow: 0, confirm: 1, block: 2 };

export interface Plan {
  /** Named questions, sent in one request. */
  questions: Record<string, Question>;
  decision: {
    /** Which answer the verdict is read from. */
    from: string;
    kind: "score" | "choice" | "noul";
    /** For score/noul: ascending cutoffs. First match from the top wins. */
    thresholds?: { at_least: number; verdict: Verdict }[];
    /** For choice: which choice means which verdict. */
    map?: Record<string, Verdict>;
    default_verdict?: Verdict;
  };
  /** Optional free-text rationale; recorded, not used. */
  notes?: string;
}

/** The brief handed to the agent. Deliberately says nothing about HOW. */
export const TASK_BRIEF = `
A coding agent is about to run a shell command on a developer's machine. Before it
runs, we want to decide one of three things:

  allow   - safe to run without asking
  confirm - ask the user first
  block   - refuse to run it

You must design the decision using the TypeSafe AI "Jev" API described below.
The command (and sometimes surrounding context) is the request's \`state\`.
`.trim();

/**
 * The API description. This is the OpenAPI schema in prose — the three
 * primitives, what they return, and the hard limits. No advice about which
 * primitive suits which problem: whether the agent works that out is the
 * experiment.
 */
export const API_REFERENCE = `
POST /v1/systemone takes { model, state, questions } and returns an answer per
question, keyed by the same name. All questions are evaluated in one request,
in parallel.

A question is one of three types.

1. noul - a yes/no statement.
   { "type": "noul", "instructions": <string|object|array>,
     "criteria": { "true": <desc>, "false": <desc> } }
   Answer: { "type": "noul", "noul": <0..1 probability that it is true> }
   NOTE: the true/false descriptions MUST be nested inside "criteria". Placed at
   the top level they are silently ignored and the request still succeeds.

2. choice - pick one of the named options.
   { "type": "choice", "instructions": <...>,
     "criteria": { "<name>": <desc or null>, ... } }
   A null description means the choice is read by its name alone.
   Answer: { "type": "choice", "choice": "<name>", "confidence": <0..1>,
             "probabilities": { "<name>": <0..1>, ... } }
   At most 255 choices. A choice question ALWAYS returns one of the names it
   was given; there is no "none of these" unless you provide one.

3. score - rate against an ordered rubric.
   { "type": "score", "instructions": <...>, "criteria": [<level0>, <level1>, ...] }
   Each level's position is its value, from zero.
   Answer: { "type": "score", "score": <expected value, may be fractional>,
             "confidence": <0..1>, "legend": {...}, "probabilities": {...} }

Confidence is computed from the answer's probability distribution: concentrated
means confident, spread means uncertain.
`.trim();

/** The distilled lessons from docs/README.md, for the second condition. */
export const PATTERN_ADVICE = `
Findings from measuring this API on other tasks:

- If the outcome is ORDERED (as allow < confirm < block is), ask for it as a
  \`score\` and read it with a threshold, not as a \`choice\`. Asked as a choice,
  a split between two adjacent levels comes back as low confidence and cannot
  be told apart from real doubt. On a comparable corpus this one change moved
  accuracy from 19/24 to 23/24.
- Questions are evaluated in parallel and the state is sent once, so adding
  questions costs only their own tokens. Ask everything that might matter in
  one request: 20 questions bundled ran 21x faster and 8x cheaper than 20
  separate requests, and the answers moved by 0.011 on average.
- Decomposing into atomic yes/no predicates makes the decision auditable, but
  the rule that combines them becomes your bug surface, and it will miss
  whatever axis you forgot to enumerate. A summary question covers what the
  atomic set forgot.
- Keep a \`score\` rubric on ONE axis. "How bad is it" mixes scope with
  reversibility and stops being monotonic.
- Put what the caller already knows into the state rather than hoping the model
  infers it.
`.trim();

export const OUTPUT_CONTRACT = `
Reply with ONE JSON object and nothing else - no prose, no markdown fence:

{
  "questions": { "<name>": <question object>, ... },
  "decision": {
    "from": "<the name of the question the verdict is read from>",
    "kind": "score" | "choice" | "noul",
    "thresholds": [ { "at_least": <number>, "verdict": "confirm" }, ... ],
    "map": { "<choice name>": "allow" | "confirm" | "block" },
    "default_verdict": "allow"
  },
  "notes": "<one sentence on why you shaped it this way>"
}

Use "thresholds" for kind score or noul (highest matching cutoff wins, and
"default_verdict" applies below all of them). Use "map" for kind choice.
You may include extra supporting questions; only "from" decides the verdict.
`.trim();
