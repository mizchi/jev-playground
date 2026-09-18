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
export const SCHEMA = "jev-quality-3";

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
 * Concrete criteria: eight named things that make code wrong, each asked as
 * its own noul.
 *
 * These exist because of what docs/21 measured. The vague question ("how hard
 * would a reviewer push back") missed six of twelve bugs, and every miss was
 * the same kind of thing -- a specific library call not behaving the way the
 * surrounding code assumed. docs/01 section 5 says a rubric answers the axis
 * you wrote and nothing else, so the obvious question is whether those six
 * were invisible or merely unasked.
 *
 * **These criteria were written by looking at the corpus's defect classes.**
 * That is deliberate and it is a fitted rubric, not a general one: it measures
 * the CEILING (if you name the class, can Jev find it?), not generalisation.
 *
 * The hole that enumerating classes leaves is measured two ways, because the
 * first way was not enough. `ranges.js` and `pool.js` hold five bugs in
 * classes absent from this list -- but they all turned out to be visible from
 * the function's own text, so the generic question caught 15/15 of them and
 * the hole looked shallow. `access.js` adds five that are absent from this
 * list AND need outside knowledge, and `run-loo.mjs` drops each criterion
 * from the request in turn to see whether its own class survives without it.
 *
 * `covers` is documentation of the intent, never sent.
 */
export const ATOMS = [
  {
    name: "api_default",
    covers: "a library call's default is not what the code assumes",
    statement:
      "This function depends on a library or built-in behaving in a way it does not behave with the arguments given.",
    criteria: {
      true: "It calls a built-in or library function and relies on behaviour that call does not have: a comparator, flag, mode, or argument it never passed, or a default that differs from what the surrounding code assumes.",
      false: "Every library and built-in call it makes behaves, with the arguments actually given, the way the surrounding code needs.",
    },
  },
  {
    name: "unhandled_async",
    covers: "a promise whose rejection or value escapes",
    statement: "This function lets asynchronous work escape unhandled.",
    criteria: {
      true: "A promise is returned, ignored or stored somewhere its rejection will not be caught, or its value is used before it resolves.",
      false: "Every asynchronous call is awaited or has its failure handled where the surrounding code expects, or the function is not asynchronous.",
    },
  },
  {
    name: "boundary",
    covers: "the edge of the input range",
    statement: "This function gets an edge of its input range wrong.",
    criteria: {
      true: "Empty input, the first or the last element, an index one past the end, or a zero or negative size gives a wrong result or an error the caller does not expect.",
      false: "The edges of its input range are handled, or cannot occur given how it is called.",
    },
  },
  {
    name: "swallows_failure",
    covers: "a failure the caller needed to know about",
    statement: "This function hides a failure from its caller.",
    criteria: {
      true: "An error or a failed operation is discarded so the caller cannot tell it happened, and the caller needs to know.",
      false: "Failures propagate, or are absorbed deliberately in a way the function's name and shape announce.",
    },
  },
  {
    name: "name_mismatch",
    covers: "the name promises something the body does not do",
    statement:
      "This function does something materially different from what its name promises.",
    criteria: {
      true: "Someone who read only the name and the parameters would be wrong about what it does, what it returns, or what guarantee it provides.",
      false: "The name and parameters describe what the body actually does.",
    },
  },
  {
    name: "lost_update",
    covers: "read-modify-write across a suspension point",
    statement: "Concurrent calls to this function can lose each other's writes.",
    criteria: {
      true: "It reads shared state and writes it back with a suspension point in between, so two overlapping calls both read the old value and one write is lost.",
      false: "It does not read-modify-write shared state, cannot be called concurrently, or the update is atomic.",
    },
  },
  {
    name: "unescaped_composition",
    covers: "caller text spliced into something that gets parsed",
    statement: "This function builds a structured string out of unescaped parts.",
    criteria: {
      true: "Caller-supplied text is concatenated into something that will later be parsed -- a URL, query string, path, shell command, SQL statement or markup -- without being escaped or encoded.",
      false: "Anything interpolated into a structured string is escaped, encoded, or known to be safe by construction.",
    },
  },
  {
    name: "unit_or_arithmetic",
    covers: "wrong operation or wrong scale",
    statement: "This function gets an arithmetic operation or a unit wrong.",
    criteria: {
      true: "A percentage, currency amount, time unit, index or ratio is computed with the wrong operation or at the wrong scale for what the parameters mean.",
      false: "Its arithmetic and its units are consistent with what its parameters mean.",
    },
  },
];

export const ATOM_NAMES = ATOMS.map((a) => a.name);

/**
 * A checklist of the same eight things, as one paragraph in the score
 * question's instructions rather than as eight separate questions.
 *
 * This arm exists to separate two explanations of any improvement: "it helps
 * to say what counts as a problem" from "it helps to ask about each one
 * separately". Same information, one question instead of nine.
 */
const CHECKLIST = ATOMS.map((a) => `${a.name}: ${a.criteria.true}`);

/** Question sets. `arm` varies the state; `rubric` varies what we ask. */
export const RUBRICS = ["vague", "checklist", "atoms", "full"];

export const RUBRIC_BLURB = {
  vague: "the docs/21 pair: reviewer-action score + one generic `misbehaves` noul",
  checklist: "the same pair, but the score question lists the eight criteria",
  atoms: "eight named criteria as eight nouls, and nothing else",
  full: "score + generic noul + the eight named criteria, all in one request",
};

export function rubricShape(rubric) {
  switch (rubric) {
    case "checklist":
      return { score: true, generic: true, checklist: true, atoms: false };
    case "atoms":
      return { score: false, generic: false, checklist: false, atoms: true };
    case "full":
      return { score: true, generic: true, checklist: false, atoms: true };
    default:
      return { score: true, generic: true, checklist: false, atoms: false };
  }
}

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
   * Fallback cutoff for a named criterion with no entry in `criterionAt`.
   * docs/22 is why you do not want to rely on it.
   */
  atomAt: 0.8,
  /**
   * One cutoff PER criterion, because they are not on the same scale.
   *
   * docs/22 measured this and it was the whole finding. `unit_or_arithmetic`
   * answers 0.94 on its own class; `api_default` answers 0.20 on its own
   * class while still ranking it above clean code at AUC 0.80. One global
   * 0.80 caught 13 of 36 named-class judgments; these cutoffs catch 24, at
   * the same zero false positives -- including two of the six bugs docs/21
   * missed entirely.
   *
   * **These numbers are fitted, and they have already been refitted once.**
   * docs/22 set them to the highest clean answer plus 0.01 on a 68-function
   * corpus, which put four of them exactly on the false-positive boundary --
   * and the ten functions added for the addendum promptly crossed it
   * (`unescaped_composition` fired on every template literal). Raising those
   * four by one notch removed all ten false positives and cost NOTHING in
   * own-class recall, which is what these values are.
   *
   * Expect to do it again. The margin is still thin (`api_default` sits at
   * 0.25 against a worst clean answer of 0.24), so on your code some of them
   * will fire where they should not. The transferable part is the method, not
   * the numbers: fit on the clean class, then leave a notch. docs/04's rule
   * holds -- the questions are design, the thresholds are data.
   */
  criterionAt: {
    api_default: 0.25,
    unhandled_async: 0.57,
    boundary: 0.58,
    swallows_failure: 0.38,
    name_mismatch: 0.48,
    lost_update: 0.73,
    unescaped_composition: 0.26,
    unit_or_arithmetic: 0.28,
  },
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

/**
 * Overlay a partial threshold set on the defaults.
 *
 * `criterionAt` is merged per key, not replaced. A shallow spread would make
 * `criterionAt: { unescaped_composition: 1.01 }` -- the obvious way to mute
 * one noisy criterion -- silently drop the other seven cutoffs onto the 0.8
 * `atomAt` fallback, which reports almost nothing. A config change that turns
 * one criterion off must not turn seven others down.
 */
export function withThresholds(thresholds = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  t.criterionAt = { ...DEFAULT_THRESHOLDS.criterionAt, ...(thresholds.criterionAt ?? {}) };
  return t;
}

/**
 * Content-addressed cache key. See the limitation note in README.
 *
 * The rubric is part of the key, not just the file header: two rubrics answer
 * different questions about the same function, so they must be able to live
 * in one cache without one silently standing in for the other.
 */
export function keyOf(unit, rubric = "vague") {
  return createHash("sha256")
    .update(`${SCHEMA}\n${rubric}\n${unit.text}`)
    .digest("hex")
    .slice(0, 20);
}

/** Stable question names. `q` = the score, `b` = the atomic noul. */
export function scoreKey(i) {
  return `q${String(i).padStart(3, "0")}`;
}
export function bugKey(i) {
  return `b${String(i).padStart(3, "0")}`;
}
/** `a3-007` = atom index 3, function 7. Opaque: the atom's NAME must not
 *  leak into the answer map, or a reader of the request learns the taxonomy
 *  twice and the keys stop being comparable across rubrics. */
export function atomKey(atomIndex, i) {
  return `a${atomIndex}-${String(i).padStart(3, "0")}`;
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

/**
 * `omit` drops named criteria from the REQUEST, not from the analysis.
 *
 * That distinction is the measurement in docs/22's addendum: to find out what
 * enumerating classes costs on a class you forgot, you have to actually not
 * ask about it. Dropping it from the scoring afterwards would leave the
 * question in the request, where it can still steer the other answers.
 *
 * The atom INDEX stays stable (`a3-007` is always the fourth criterion), so
 * omitting one shifts nothing and `verdictFrom` simply finds that name absent.
 */
export function questionsFor(units, arm, rubric = "vague", omit = []) {
  const questions = {};
  const dropped = new Set(omit);
  const shape = armShape(arm);
  const want = rubricShape(rubric);
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

    if (want.score) {
      questions[scoreKey(i)] = {
        type: "score",
        instructions: {
          task: "You are reviewing this function in a pull request. How hard would you push back?",
          ...(want.checklist ? { things_that_count_as_a_problem: CHECKLIST } : {}),
          ...subject,
        },
        criteria: LEVELS,
      };
    }
    if (want.generic) {
      questions[bugKey(i)] = {
        type: "noul",
        instructions: {
          statement:
            "This function does the wrong thing for some input it will realistically receive.",
          ...subject,
        },
        // Nested, because the server silently drops top-level true/false
        // (docs/00-api-notes.md).
        criteria: BUG_CRITERIA,
      };
    }
    if (want.atoms) {
      ATOMS.forEach((atom, a) => {
        if (dropped.has(atom.name)) return;
        questions[atomKey(a, i)] = {
          type: "noul",
          instructions: { statement: atom.statement, ...subject },
          criteria: atom.criteria,
        };
      });
    }
  });
  return questions;
}

/** Pull one function's verdict out of a response. */
export function verdictFrom(answers, i, rubric = "vague") {
  const want = rubricShape(rubric);
  const s = answers[scoreKey(i)];
  const b = answers[bugKey(i)];
  const hasScore = s && s.type === "score";
  let atoms = null;
  if (want.atoms) {
    atoms = {};
    ATOMS.forEach((atom, a) => {
      const ans = answers[atomKey(a, i)];
      if (ans && ans.type === "noul") atoms[atom.name] = ans.noul;
    });
    if (Object.keys(atoms).length === 0) atoms = null;
  }
  // A rubric with no score still produces a verdict; one with no usable answer
  // at all does not, because a defaulted score is an invented verdict.
  if (!hasScore && !atoms) return null;
  return {
    score: hasScore ? s.score : null,
    confidence: hasScore ? s.confidence : null,
    bug: b && b.type === "noul" ? b.noul : null,
    atoms,
  };
}

/**
 * The highest-firing named criterion, or null.
 *
 * Taking the max and not the mean is docs/08: averaging several nouls dilutes
 * the one that carries the signal, and here it would also throw away the one
 * thing the atoms buy that the vague rubric cannot -- a name to put in the
 * message.
 */
export function topAtom(verdict) {
  if (!verdict?.atoms) return null;
  let best = null;
  for (const [name, p] of Object.entries(verdict.atoms)) {
    if (typeof p !== "number") continue;
    if (best === null || p > best.p) best = { name, p };
  }
  return best;
}

/**
 * The criterion that actually fired, judged against its OWN cutoff.
 *
 * Not the same thing as `topAtom`: the raw maximum picks whichever criterion
 * happens to answer on the highest scale, and docs/22 measured that the
 * scales differ by a factor of five. Ranking by how far each answer is over
 * its own cutoff is what makes "the criterion with the strongest case" mean
 * something.
 */
export function firedAtom(verdict, thresholds = {}) {
  if (!verdict?.atoms) return null;
  const t = withThresholds(thresholds);
  const cutoffs = t.criterionAt;
  let best = null;
  for (const [name, p] of Object.entries(verdict.atoms)) {
    if (typeof p !== "number") continue;
    const cutoff = cutoffs[name] ?? t.atomAt;
    if (p < cutoff) continue;
    const margin = p / cutoff;
    if (best === null || margin > best.margin) best = { name, p, cutoff, margin };
  }
  return best;
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
  const t = withThresholds(thresholds);
  if (!verdict) return null;
  const { score, confidence, bug } = verdict;

  // A named criterion outranks both the generic noul and the score, because
  // it is the only one of the three that can say WHAT is wrong -- and a lint
  // message that names the defect is worth more than one that reports 1.94/3.
  const atom = firedAtom(verdict, t);
  if (atom) {
    return {
      messageId: "criterion",
      level: "block",
      data: {
        ...fmt(verdict, t),
        criterion: atom.name,
        criterionP: atom.p.toFixed(2),
        criterionAt: atom.cutoff.toFixed(2),
      },
    };
  }
  if (bug !== null && bug >= t.bugAt) {
    return { messageId: "bug", level: "block", data: fmt(verdict, t) };
  }
  if (score !== null && score >= t.reportAt) {
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
    score: verdict.score === null ? "n/a" : verdict.score.toFixed(2),
    confidence: verdict.confidence === null ? "n/a" : verdict.confidence.toFixed(2),
    reportAt: t.reportAt.toFixed(2),
    unsureBelow: t.unsureBelow.toFixed(2),
    atomAt: t.atomAt.toFixed(2),
    bug,
    level: verdict.score === null ? "n/a" : levelName(verdict.score),
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
