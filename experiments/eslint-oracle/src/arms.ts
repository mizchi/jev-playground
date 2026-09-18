/**
 * The three things we are willing to tell Jev about a rule.
 *
 * Only `instructions` differs between arms. The question KEYS are opaque
 * (`q00`..`q11`) in every arm, because naming a question `eqeqeq` would hand
 * the rule id to the description-only arm through the back door -- the answer
 * map is echoed in the request. The state is identical across arms too, down
 * to the filename, which is why it is `sample.js` and not the snippet id
 * (`eqeqeq_null_idiom.js` would give away both the rule and the trick).
 */
import type { Question } from "../../shared/jev.js";
import { RULE_SPECS, type RuleSpec } from "./rules.js";
import type { Snippet } from "./corpus.js";

export type ArmName = "name" | "desc" | "both" | "spec";

export const ARMS: ArmName[] = ["name", "desc", "both", "spec"];

export const ARM_BLURB: Record<ArmName, string> = {
  name: "rule id only                  (does it just know ESLint?)",
  desc: "rule description only         (the criteria, implementation hidden)",
  both: "rule id + description         (what a real gate would send)",
  spec: "+ published default options    (every carve-out ESLint publishes as metadata)",
};

/** Stable opaque key for the rule at index i. */
export function keyFor(i: number): string {
  return `q${String(i).padStart(2, "0")}`;
}

function ruleFields(arm: ArmName, spec: RuleSpec): Record<string, unknown> {
  switch (arm) {
    case "name":
      return { rule: spec.id };
    case "desc":
      return { rule: spec.description };
    case "both":
      return { rule: spec.id, rule_description: spec.description };
    case "spec":
      // Still not the implementation -- `meta.defaultOptions` and the schema
      // vocabulary are what ESLint publishes about a rule's configuration.
      // Some carve-outs are expressible here (`except-parens`), and some are
      // hardcoded in create() and so cannot be (no-empty's comment
      // tolerance). That asymmetry is the measurement.
      return {
        rule: spec.id,
        rule_description: spec.description,
        default_options: spec.defaultOptions ?? "none published",
        configurable_options: spec.options,
      };
  }
}

export function questionsFor(arm: ArmName): Record<string, Question> {
  const questions: Record<string, Question> = {};
  RULE_SPECS.forEach((spec, i) => {
    questions[keyFor(i)] = {
      type: "noul",
      instructions: {
        question: "Would ESLint report a problem for this rule on the code in the state?",
        ...ruleFields(arm, spec),
      },
      // Nested, because the server silently ignores top-level true/false keys
      // (docs/00-api-notes.md).
      criteria: {
        true: "ESLint reports one or more problems for this rule on this code.",
        false: "ESLint reports no problem for this rule on this code.",
      },
    };
  });
  return questions;
}

export function stateFor(snippet: Snippet): unknown {
  return {
    linter: "ESLint",
    language: "JavaScript",
    module_system: "ES module",
    ecma_version: "latest",
    file: "sample.js",
    code: snippet.code,
  };
}
