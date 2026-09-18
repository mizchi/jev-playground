/**
 * Ad-hoc rules: the selector is code, the predicate is a sentence.
 *
 * `jev/quality` asks a fixed question set about every function. This is the
 * other half: a rule that does not exist yet, written as one line of English
 * (or Japanese) in the ESLint config, with only the node selector written as
 * code.
 *
 *   {
 *     id: "fetch-timeout",
 *     selector: "CallExpression[callee.name='fetch']",
 *     rule: "fetch は必ずタイムアウト (AbortSignal.timeout など) を渡すこと",
 *   }
 *
 * The division of labour is the point:
 *
 *   selector    WHICH nodes get judged -- cheap, exact, and no model involved.
 *               ESLint's own esquery does the matching, so anything you can
 *               write in a real rule works here unchanged.
 *   rule        WHETHER a matched node is a violation -- the part that needs
 *               judgment, and the part you cannot express in a selector.
 *
 * A selector alone is the reason half of a team's conventions never become
 * lint rules: `CallExpression[callee.name='fetch']` is trivial, and "…without
 * a timeout, unless it is inside a retry wrapper that sets one" is a week of
 * AST work. So the selector over-matches on purpose and the sentence narrows
 * it: level 0 below is the model saying "your selector caught something this
 * rule does not even apply to".
 *
 * Every matched node gets a `score`, not a `noul`, for two reasons. A score
 * comes back with a confidence (a noul does not -- docs/00), so an uncertain
 * verdict can be routed to a human instead of being dropped; and a rule is
 * rarely binary, so "arguably breaks it" deserves to be a different lint
 * message from "clearly breaks it".
 */
import { createHash } from "node:crypto";
import {
  MAX_REQUEST_TOKENS,
  MAX_STATE_TOKENS,
  SCHEMA,
  estimateTokens,
} from "./judge.mjs";

/**
 * How many matches go in one request.
 *
 * This is a self-imposed cap, not a server limit. The measured ceilings are on
 * TOKENS -- 64Ki for a request and 32Ki for the state (docs/00) -- and a
 * question count of 1220 goes through fine. `planRuleBatches` enforces both,
 * and on real code the token ceiling is what bites first: a score question
 * repeats its four level descriptions, so 256 of them is already ~50K tokens.
 *
 * The cap is still worth having. It bounds the blast radius of one bad request
 * and it bounds how much work a `max_tokens_exceeded` retry has to redo.
 */
export const DEFAULT_BATCH_SIZE = 256;

/**
 * The scale. Ordered by how much the node breaks the rule, with level 0 as
 * the escape hatch for a selector that matched something irrelevant.
 *
 * The levels never mention what the rule IS -- that arrives per question as
 * the `rule` field -- so one scale serves every rule anyone writes.
 */
export const RULE_LEVELS = [
  "The rule does not apply to this code at all: the selector matched something the rule was not written about.",
  "The rule applies and this code satisfies it: it already does what the rule asks for.",
  "The rule applies and this code arguably breaks it: a reviewer could raise it, and could reasonably let it go.",
  "The rule applies and this code clearly breaks it: a reviewer would ask for a change.",
];

export const RULE_LEVEL_NAMES = ["not-applicable", "satisfied", "arguable", "violation"];

/** Defaults for the ad-hoc gate. Per-rule `at` overrides `reportAt`. */
export const DEFAULT_RULE_THRESHOLDS = {
  /**
   * Report at 2.0 -- "arguably breaks it" and up.
   *
   * Deliberately higher than `jev/quality`'s 1.5, and for a different reason:
   * there, 1.5 sits between two levels of a reviewer-action scale. Here 2.0 is
   * a level boundary, because level 1 means the code SATISFIES the rule, and
   * reporting a satisfied node is not a false positive you can tune away --
   * it is the rule firing backwards.
   */
  reportAt: 2,
  /** Under this confidence a report is worded as a question, not a verdict. */
  unsureBelow: 0.5,
};

/**
 * Inline the matched node's source when it is small enough to be worth
 * repeating. Above this the question names it by line range instead and lets
 * the model find it in the state, which holds the whole file.
 *
 * A selector can match anything from `x + 1` to a 200-line class, and the
 * line range alone is a weak subject for the small end of that: the file in
 * the state is the context, but the question should still say what it is
 * about without the model having to count lines.
 */
export const INLINE_LIMIT = 600;

/** Stable question name. Same padding as `judge.mjs`, different letter. */
export function ruleKey(i) {
  return `r${String(i).padStart(3, "0")}`;
}

/**
 * Normalize and validate the rules from the ESLint config.
 *
 * Returns `{rules, errors}` and never throws: a malformed entry is dropped
 * with a reason rather than taking the lint run down. `id` defaults to the
 * selector, so the common case needs only two fields.
 */
export function normalizeRules(list) {
  const rules = [];
  const errors = [];
  const seen = new Set();
  if (!Array.isArray(list)) {
    if (list !== undefined) errors.push("`rules` must be an array");
    return { rules, errors };
  }
  list.forEach((raw, i) => {
    const where = `rules[${i}]`;
    if (!raw || typeof raw !== "object") {
      errors.push(`${where} is not an object`);
      return;
    }
    const selector = typeof raw.selector === "string" ? raw.selector.trim() : "";
    const rule = typeof raw.rule === "string" ? raw.rule.trim() : "";
    if (selector === "") {
      errors.push(`${where} has no \`selector\``);
      return;
    }
    if (rule === "") {
      errors.push(`${where} (${selector}) has no \`rule\` text`);
      return;
    }
    const id = typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id.trim() : selector;
    if (seen.has(id)) {
      errors.push(`${where} duplicates the id \`${id}\``);
      return;
    }
    seen.add(id);
    rules.push({
      id,
      selector,
      rule,
      // A per-rule cutoff, because one config holds rules of very different
      // sharpness: "never use `==`" is not "prefer a named constant".
      at: typeof raw.at === "number" ? raw.at : null,
      // Optional extra text for the model only -- never shown in the lint
      // message. This is where an exception belongs ("unless it is a test").
      note: typeof raw.note === "string" && raw.note.trim() !== "" ? raw.note.trim() : null,
    });
  });
  return { rules, errors };
}

/**
 * Content-addressed cache key for one matched node under one rule.
 *
 * The rule TEXT is in the key, not just its id: editing the sentence is
 * editing the question, and a verdict for the old wording must not answer for
 * the new one. Same argument as the rubric in `keyOf`.
 *
 * What is NOT in the key is the rest of the file, which is the same
 * limitation `jev/quality` has: the state carries the file, so in principle a
 * distant edit could change the answer, and the cache will not notice. The
 * alternative -- keying on the whole file -- invalidates every verdict in a
 * file on every keystroke, which is not a cache.
 */
export function ruleMatchKey(rule, nodeText) {
  return createHash("sha256")
    .update(`${SCHEMA}\nrule\n${rule.id}\n${rule.rule}\n${rule.note ?? ""}\n${nodeText}`)
    .digest("hex")
    .slice(0, 20);
}

/**
 * Which DRAFT of a rule a verdict came from.
 *
 * Stored on the cache entry, and the reason is the authoring loop: rewriting a
 * sentence produces new keys, so the old verdicts stay in the cache under the
 * same rule id. The plugin never reads them (it looks up by key), but anything
 * that reports on the cache by rule id would silently average two drafts
 * together and show you a spread that belongs to neither.
 */
export function ruleTextHash(rule) {
  return createHash("sha256")
    .update(`${rule.rule}\n${rule.note ?? ""}`)
    .digest("hex")
    .slice(0, 8);
}

/**
 * The state: the file, plus a map of what each question is about.
 *
 * Same shape as `judge.mjs`'s file arm, which docs/21 measured as the one
 * worth using. The per-match index lets a question say "match r003" and have
 * the state agree.
 */
export function stateForRules(file, source, matches) {
  return {
    language: "JavaScript",
    reviewing: "a source file, against project-specific rules",
    file,
    matches: matches.map((m, i) => ({
      id: ruleKey(i),
      rule: m.rule.id,
      node: m.nodeType,
      lines: m.line === m.endLine ? `${m.line}` : `${m.line}-${m.endLine}`,
    })),
    source,
  };
}

/**
 * One score question per matched node.
 *
 * The rule sentence goes in verbatim. It is the user's text and this is the
 * one place it is used, so nothing here tries to rewrite it into a schema --
 * docs/04's line holds: the question is design, the threshold is data.
 */
export function questionsForRules(matches) {
  const questions = {};
  matches.forEach((m, i) => {
    const subject =
      m.text.length <= INLINE_LIMIT
        ? { node: m.nodeType, lines: `${m.line}-${m.endLine}`, code: m.text }
        : { node: m.nodeType, lines: `${m.line}-${m.endLine}` };
    questions[ruleKey(i)] = {
      type: "score",
      instructions: {
        task: "A project has this rule. Judge only the code identified below, against only this rule -- other problems in it are not your concern here.",
        rule: m.rule.rule,
        ...(m.rule.note ? { also: m.rule.note } : {}),
        matched_because: `it matched the selector \`${m.rule.selector}\``,
        ...subject,
      },
      criteria: RULE_LEVELS,
    };
  });
  return questions;
}

/** `{score, confidence}` for match `i`, or null if the answer is unusable. */
export function verdictForRule(answers, i) {
  const a = answers?.[ruleKey(i)];
  if (!a || a.type !== "score" || typeof a.score !== "number") return null;
  return {
    score: a.score,
    confidence: typeof a.confidence === "number" ? a.confidence : null,
  };
}

/**
 * The gate. Returns null when the match should not be reported.
 *
 * Confidence picks the message, it does not decide whether one fires --
 * docs/21 measured that gating on confidence costs recall for nothing.
 */
export function decideRule(verdict, rule, thresholds = {}) {
  if (!verdict || typeof verdict.score !== "number") return null;
  const t = { ...DEFAULT_RULE_THRESHOLDS, ...thresholds };
  const at = typeof rule?.at === "number" ? rule.at : t.reportAt;
  if (verdict.score < at) return null;
  const confidence = verdict.confidence;
  const unsure = typeof confidence === "number" && confidence < t.unsureBelow;
  return {
    messageId: unsure ? "ruleUnsure" : "rule",
    level: ruleLevelName(verdict.score),
    data: {
      rule: rule.id,
      text: rule.rule,
      score: verdict.score.toFixed(2),
      confidence: typeof confidence === "number" ? confidence.toFixed(2) : "n/a",
      at: at.toFixed(2),
      unsureBelow: t.unsureBelow.toFixed(2),
    },
  };
}

/** Nearest level name, for the message. */
export function ruleLevelName(score) {
  const i = Math.max(0, Math.min(RULE_LEVEL_NAMES.length - 1, Math.round(score)));
  return RULE_LEVEL_NAMES[i];
}

/**
 * Group matches into requests: one file each, capped by `batchSize` AND by
 * both token ceilings.
 *
 * Guarantees, which is what the test asserts rather than a capacity number:
 * every match lands in exactly one batch, no batch is empty, no batch is over
 * `batchSize`, and no batch's estimated tokens exceed the request ceiling. A
 * file whose SOURCE alone is over the state ceiling cannot be batched at all,
 * so its matches are asked one at a time with the node as the state -- the
 * same fallback `planBatches` uses.
 */
export function planRuleBatches(matches, batchSize = DEFAULT_BATCH_SIZE) {
  const cap = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : DEFAULT_BATCH_SIZE;
  const byFile = new Map();
  for (const m of matches) {
    if (!byFile.has(m.file)) byFile.set(m.file, []);
    byFile.get(m.file).push(m);
  }
  const batches = [];
  for (const [file, group] of byFile) {
    const source = group[0].fileSource ?? "";
    const stateTokens = estimateTokens(stateForRules(file, source, group));
    if (stateTokens > MAX_STATE_TOKENS) {
      for (const m of group) {
        batches.push({ file, source: m.text, matches: [m], oversize: true });
      }
      continue;
    }
    let current = [];
    let tokens = stateTokens;
    for (const m of group) {
      const cost = estimateTokens(questionsForRules([m]));
      const full = current.length >= cap || (current.length > 0 && tokens + cost > MAX_REQUEST_TOKENS);
      if (full) {
        batches.push({ file, source, matches: current });
        current = [];
        tokens = stateTokens;
      }
      current.push(m);
      tokens += cost;
    }
    if (current.length > 0) batches.push({ file, source, matches: current });
  }
  return batches;
}
