/**
 * Seven ways to ask the same 74 questions.
 *
 * The axis this experiment is actually about is FAN-OUT WIDTH. One project is
 * one state; every candidate skill is one question against it. Nothing in the
 * repo has asked 74 questions of a single state before -- docs/27 asked 8 --
 * and "the catalog does not fit in context" is exactly the situation where
 * you would want to.
 *
 *   fanout     one request, one question per skill; the skill rides in the
 *              question's `instructions`, and the question asks what the
 *              project NEEDS
 *   applies    the same fan-out, asking instead whether the skill is ABOUT
 *              this project's stack -- the altitude the catalog proposes at
 *   batch10    `applies`, split into requests of ten, so the state is paid
 *              for eight times and each request is narrow
 *   solo       `applies`, one question per request: width 1, skill still in
 *              the question
 *   single     width 1 as well, but with the skill moved into the STATE, so
 *              the pair `solo`/`single` separates width from placement
 *   usewhen    `applies`, but the question carries the catalog's curated
 *              "Use when" prose instead of the skill's own description
 *   noul       `applies`, but a yes/no instead of the four-level score
 *
 * `usewhen` is the one that prices the catalog: the curation is a human's
 * work, and the difference between the two arms is what that work buys.
 */
import type { Question } from "../../shared/jev.js";
import type { Candidate, Project } from "./projects.js";
import { projectText } from "./projects.js";

export const ARMS = ["fanout", "applies", "batch10", "solo", "single", "usewhen", "noul"] as const;
export type ArmName = (typeof ARMS)[number];

export const ARM_BLURB: Record<ArmName, string> = {
  fanout: "one request per project, one score question per skill",
  applies: "fan-out, asking whether the skill APPLIES rather than is needed",
  batch10: "the `applies` questions in requests of ten",
  solo: "one request per skill, the skill still in the question",
  single: "one request per skill, the skill in the state",
  usewhen: "`applies`, but with the catalog's curated prose",
  noul: "`applies`, but a yes/no instead of a score",
};

/** How many questions each arm puts in one request. Infinity = all of them. */
export const WIDTH: Record<ArmName, number> = {
  fanout: Infinity,
  applies: Infinity,
  batch10: 10,
  solo: 1,
  single: 1,
  usewhen: Infinity,
  noul: Infinity,
};

/**
 * The four levels, which are the catalog's tier policy read against ONE
 * project rather than in general.
 *
 * Level 2 exists because the catalog's T2 is a real category -- a skill that
 * is right for an activity nobody has asked for yet. Collapsing it into
 * "no" would make every T2 row look like a mistake instead of a policy.
 */
export const LEVELS = [
  "This project has no use for it. Nothing in the files or the request is about what it does.",
  "Adjacent, or superseded by something else. Worth naming in passing; not worth installing now.",
  "It fits an activity this project could want, but the request does not ask for that activity.",
  "This project needs it now: the files or the request are about what it does.",
];

export const LEVEL_NAMES = ["no", "mention", "on_request", "want"] as const;

export const NEEDED = "needed";

/**
 * Two altitudes for the same question, and the difference between them is
 * docs/29's main finding.
 *
 * `NEEDED` asks what the immediate task calls for. That is the reading a
 * skill's own `description:` is written for -- "Use when the user asks to
 * deploy" -- and it is NOT what the catalog's proposal is. The catalog
 * proposes a section's whole row set the moment the section's signals show
 * up, and expects the user to subtract; `APPLIES` asks at that altitude.
 */
const NEEDED_AT =
  "An agent working in the repository below can load this skill. Its whole cost is context: " +
  "loading it spends tokens in every conversation, so it should be loaded when the project's " +
  "work is what the skill is about. How strongly does this project call for it?";

const APPLIES_AT =
  "Someone is stocking the repository below with the skills it should have available, before " +
  "any particular task. The list is a starting point they will trim, so a skill belongs on it " +
  "when this project's stack and process are the ones the skill is about -- not only when it " +
  "is needed for the request at hand. Does this skill belong on the list for this repository?";

const APPLIES_LEVELS = [
  "No. Nothing in this repository's stack or process is what the skill is about.",
  "Barely. The same area, but a different tool, or a version this skill says it is not for.",
  "It is about an activity this repository does not do, or does not do yet.",
  "Yes. This repository's stack or process is what the skill is about.",
];

const askOf = (arm: ArmName) => (arm === "fanout" ? NEEDED_AT : APPLIES_AT);
const levelsOf = (arm: ArmName) => (arm === "fanout" ? LEVELS : APPLIES_LEVELS);

/** The question for one skill: identity in `instructions`, policy in `criteria`. */
export function scoreQuestion(arm: ArmName, name: string, blurb: string): Question {
  return {
    type: "score",
    instructions: { task: askOf(arm), skill: name, skill_description: blurb },
    criteria: levelsOf(arm),
  };
}

export function noulQuestion(arm: ArmName, name: string, blurb: string): Question {
  return {
    type: "noul",
    instructions: { task: askOf(arm), skill: name, skill_description: blurb },
    criteria: {
      true: "This repository's stack or process is what the skill is about; put it on the list.",
      false: "It is not; leave it off.",
    },
  };
}

/** Question keys are the skill names, so a request's answers self-identify. */
export function keyFor(skill: string): string {
  return skill.replace(/[^\w]/g, "_");
}

export function blurbFor(arm: ArmName, candidate: Candidate): string {
  if (arm !== "usewhen") return candidate.description;
  // Several skills have two rows; join them, because that is what the
  // catalog reader would see.
  return candidate.rows.map((r) => r.useWhen).join(" / ");
}

export function questionFor(arm: ArmName, candidate: Candidate): Question {
  const blurb = blurbFor(arm, candidate);
  return arm === "noul" ? noulQuestion(arm, candidate.skill, blurb) : scoreQuestion(arm, candidate.skill, blurb);
}

/**
 * The state.
 *
 * Only the project, except in `single` where the skill moves out of the
 * question and into the state. `solo` is the control for that move: same
 * width, skill left in the question.
 */
export function stateFor(arm: ArmName, project: Project, candidate?: Candidate): Record<string, unknown> {
  const base = {
    what: "a repository an agent is about to work in",
    files: project.files,
    claude_md: project.claudeMd,
    request: project.intent,
  };
  if (arm !== "single") return base;
  if (!candidate) throw new Error("the single arm needs a candidate in the state");
  return { ...base, skill: candidate.skill, skill_description: blurbFor(arm, candidate) };
}

/**
 * In `single` the skill is in the state, so the question must not repeat it.
 *
 * It asks at the `applies` altitude, because that is the arm it is being
 * compared against: `batch10` and `single` vary only the request width.
 */
export function singleQuestion(): Record<string, Question> {
  return {
    [NEEDED]: {
      type: "score",
      instructions: APPLIES_AT,
      criteria: APPLIES_LEVELS,
    },
  };
}

/** Split a project's candidates into the requests one arm makes. */
export function batches(arm: ArmName, candidates: Candidate[]): Candidate[][] {
  const width = WIDTH[arm];
  if (!Number.isFinite(width)) return [candidates];
  const out: Candidate[][] = [];
  for (let i = 0; i < candidates.length; i += width) out.push(candidates.slice(i, i + width));
  return out;
}

/** Everything an arm sends for one request, as text, for the leak test. */
export function payloadOf(arm: ArmName, project: Project, group: Candidate[]): string {
  if (arm === "single") {
    return JSON.stringify([stateFor(arm, project, group[0]), singleQuestion()]);
  }
  const questions: Record<string, Question> = {};
  for (const c of group) questions[keyFor(c.skill)] = questionFor(arm, c);
  return JSON.stringify([stateFor(arm, project), questions]);
}

export { projectText };
