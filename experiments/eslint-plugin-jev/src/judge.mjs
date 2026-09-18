/**
 * What we ask about a function, and what we do with the answer.
 *
 * Two questions per function, from two findings in this repo:
 *
 * - The verdict is a `score`, not a `choice`. Reviewer action is an ORDERED
 *   conclusion, and docs/01 section 3 measured that asking an ordered thing as
 *   a `choice` costs real accuracy (19/24 -> 23/24 on the question shape
 *   alone) because adjacent levels split the probability mass and come back
 *   as low confidence you cannot threshold.
 * - Alongside it, one atomic `noul`. docs/18 measured that taking the
 *   CONSERVATIVE side of an overall score and an atomic signal beat either
 *   alone (94.4% against 90.3% and 61.1%) -- and the signal that matters for
 *   a linter is "does this misbehave", which is not the same axis as "how
 *   hard would a reviewer push back".
 *
 * Both questions about all functions in a file go in ONE request
 * (docs/00 speculative fan-out).
 */
import { createHash } from "node:crypto";

/**
 * Bumped whenever the questions, the levels or the state shape change.
 * It is part of the cache key, so a rubric edit invalidates every verdict
 * rather than mixing two rubrics in one report.
 */
export const SCHEMA = "jev-quality-2";

/**
 * The rubric is ONE axis: how hard a reviewer pushes back. docs/01 section 5
 * found a rubric answers the axis you wrote and nothing else, and that mixing
 * axes into "badness" stops it being monotone -- so these are not severities
 * of different kinds of problem, they are strengths of one reaction.
 */
export const LEVELS = [
  "Approve as is: nothing here a reviewer would raise.",
  "Approve with a comment: worth mentioning, not worth holding the change for.",
  "Request changes: a real problem a reviewer would want fixed before merge.",
  "Block: this looks incorrect, not merely improvable.",
];

export const LEVEL_NAMES = ["approve", "comment", "request-changes", "block"];

/** The atomic signal, deliberately about behaviour rather than taste. */
const BUG_CRITERIA = {
  true: "For some input this function will realistically receive, it does the wrong thing: a wrong result, an unhandled failure, a lost update, or a crash.",
  false: "It does what its name and shape say it does for the inputs it will realistically receive, even if the code could be written better.",
};

/**
 * Where a report starts. These live in code, not in the question text
 * (docs/01 section 3), and they are rule options so retuning the gate never
 * touches a question -- which is also what makes the cache reusable across
 * threshold changes: the verdict is stored, the decision is recomputed.
 */
export const DEFAULT_THRESHOLDS = {
  /** Report when the reviewer-action score reaches this (0..3). */
  reportAt: 1.5,
  /** Report separately when the atomic "misbehaves" noul reaches this. */
  bugAt: 0.7,
  /**
   * Confidence changes WHICH message fires, not WHETHER one fires.
   *
   * The first version of this gate required `confidence >= 0.5` before a
   * score could report anything, and docs/21 measured what that cost: 62.5%
   * balanced against 73.7% for the same score threshold with no confidence
   * requirement. Reviewer confidence here sits at 0.54-0.57 for everything,
   * clean and broken alike, so gating on it mostly discards correct verdicts
   * -- `applyDiscount` scores 2.41 at confidence 0.41.
   *
   * So confidence is used the way docs/07 found it works: as a ROUTING
   * signal. Under this, the finding is still reported, but as `jev/unsure` --
   * a question for a human rather than a verdict.
   */
  unsureBelow: 0.5,
};

/** Content-addressed cache key. See the limitation note in README. */
export function keyOf(unit) {
  return createHash("sha256").update(`${SCHEMA}\n${unit.text}`).digest("hex").slice(0, 20);
}

/** Stable question names. `q` = the score, `b` = the atomic noul. */
export function scoreKey(i) {
  return `q${String(i).padStart(3, "0")}`;
}
export function bugKey(i) {
  return `b${String(i).padStart(3, "0")}`;
}

export const ARMS = ["located", "inlined", "solo", "isolated"];

export const ARM_BLURB = {
  located: "file state, question names the function + lines, ALL functions in one request",
  inlined: "file state, question also carries the function's own text, one request per file",
  solo: "file state, same question as `located`, but ONE function per request",
  isolated: "one function per request, and the state is that function alone -- no file",
};

/**
 * The two things an arm varies, kept apart so the comparison means something.
 *
 * `located` vs `solo` differ ONLY in batch size -- same state, same question
 * text -- so their difference is the cost of batching and nothing else.
 * `solo` vs `isolated` differ ONLY in whether the file is in the state, so
 * their difference is the value of surrounding context. Conflating the two
 * into one comparison was the first version of this experiment and it could
 * not tell "batching bleeds" from "context helps".
 */
export function armShape(arm) {
  switch (arm) {
    case "inlined":
      return { state: "file", subject: "inlined", batch: "file" };
    case "solo":
      return { state: "file", subject: "located", batch: "one" };
    case "isolated":
      return { state: "function", subject: "bare", batch: "one" };
    default:
      return { state: "file", subject: "located", batch: "file" };
  }
}

/**
 * The state for one file. `source` is the whole file exactly once, which is
 * the point: the surrounding code is what tells you whether a `catch {}` is
 * sloppy or deliberate, and paying for it once per file rather than once per
 * function is the entire reason to batch.
 */
export function stateFor(file, source, units, arm) {
  if (armShape(arm).state === "function") {
    return {
      language: "JavaScript",
      reviewing: "a single function, shown without its file",
      function: units[0].name,
      code: units[0].text,
    };
  }
  return {
    language: "JavaScript",
    reviewing: "a source file under code review",
    file,
    functions: units.map((u) => ({
      name: u.name,
      lines: `${u.line}-${u.endLine}`,
    })),
    source,
  };
}

export function questionsFor(units, arm) {
  const questions = {};
  const shape = armShape(arm);
  units.forEach((unit, i) => {
    // docs/00: instructions may be an object, and a named field is clearer
    // than a sentence with the name spliced into it.
    const subject =
      shape.subject === "bare"
        ? { subject: "the function in the state" }
        : shape.subject === "inlined"
          ? {
              function: unit.name,
              lines: `${unit.line}-${unit.endLine}`,
              code: unit.text,
            }
          : { function: unit.name, lines: `${unit.line}-${unit.endLine}` };

    questions[scoreKey(i)] = {
      type: "score",
      instructions: {
        task: "You are reviewing this function in a pull request. How hard would you push back?",
        ...subject,
      },
      criteria: LEVELS,
    };
    questions[bugKey(i)] = {
      type: "noul",
      instructions: {
        statement: "This function does the wrong thing for some input it will realistically receive.",
        ...subject,
      },
      // Nested, because the server silently drops top-level true/false
      // (docs/00-api-notes.md).
      criteria: BUG_CRITERIA,
    };
  });
  return questions;
}

/** Pull one function's verdict out of a response. */
export function verdictFrom(answers, i) {
  const s = answers[scoreKey(i)];
  const b = answers[bugKey(i)];
  if (!s || s.type !== "score") return null;
  return {
    score: s.score,
    confidence: s.confidence,
    bug: b && b.type === "noul" ? b.noul : null,
  };
}

/**
 * The gate. Returns null when the function should not be reported.
 *
 * The two signals are combined by taking the conservative side, per docs/18 --
 * but they are reported as DIFFERENT messages, because "a reviewer would push
 * back" and "this is wrong" are things a team will want to switch on
 * separately, and collapsing them would hide which signal fired.
 */
export function decide(verdict, thresholds = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  if (!verdict) return null;
  const { score, confidence, bug } = verdict;

  if (bug !== null && bug >= t.bugAt) {
    return { messageId: "bug", level: "block", data: fmt(verdict, t) };
  }
  if (score >= t.reportAt) {
    // Over the bar. Confidence decides how it is worded, not whether it
    // fires: docs/09 found boundary decisions flip on trivial input
    // differences, so an under-confident one goes to a human as a question.
    const messageId = confidence < t.unsureBelow ? "unsure" : "quality";
    return { messageId, level: levelName(score), data: fmt(verdict, t) };
  }
  return null;
}

export function levelName(score) {
  return LEVEL_NAMES[Math.min(LEVEL_NAMES.length - 1, Math.max(0, Math.round(score)))];
}

/**
 * Every number the decision used, in the message. The hook in docs/18 landed
 * on the same shape for the same reason: a probabilistic verdict you cannot
 * audit from its own output is one you cannot retune.
 */
function fmt(verdict, t) {
  const bug =
    verdict.bug === null ? "n/a" : `${verdict.bug.toFixed(2)} (fires at ${t.bugAt.toFixed(2)})`;
  return {
    score: verdict.score.toFixed(2),
    confidence: verdict.confidence.toFixed(2),
    reportAt: t.reportAt.toFixed(2),
    unsureBelow: t.unsureBelow.toFixed(2),
    bug,
    level: levelName(verdict.score),
  };
}

// ------------------------------------------------------------------ batching

/**
 * Measured server ceilings (docs/00). Neither is in the OpenAPI schema, and
 * neither is a question count: 1220 questions in one request is fine.
 *
 *   1220 questions -> 65047 tokens  OK
 *   1240 questions -> ~66100        400 max_tokens_exceeded
 *   state of 32662 tokens           OK
 *   state of ~33400 tokens          400 max_tokens_exceeded
 */
export const MAX_REQUEST_TOKENS = 65536;
export const MAX_STATE_TOKENS = 32768;

/**
 * No tokenizer here, so this is one fitted ratio. Measured: code in the state
 * runs 3.1 chars/token and this plugin's question text 3.36, so 2.5
 * over-counts both, which is the safe direction.
 *
 * What that costs: one function in this shape measured 283 input tokens (a
 * score question and a noul, and every score question repeats the four level
 * descriptions), so a request really holds about 230 functions and the
 * estimate stops at about 170. Files that large are rare enough that the
 * margin is cheaper than a tokenizer dependency inside an ESLint plugin.
 *
 * And the estimate is only a hint: `askSplitting` halves a batch the server
 * rejects with `max_tokens_exceeded`, so being wrong costs a retry, not a
 * failed run.
 */
export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(text.length / 2.5);
}
