/**
 * The two stages, and the reason there have to be two.
 *
 * 461 entries is 60,358 tokens of name and description. A fan-out asks one
 * question per entry and each question carries its own criteria, so the
 * request is about 270 tokens per entry (docs/29 measured 20,019 for 74) --
 * roughly 124,000 tokens against a 65,536-token ceiling. §1 sends it anyway
 * and records the 400.
 *
 * So: a cheap STAGE 1 cuts the roster to something that fits, and STAGE 2 is
 * docs/29's fan-out over the survivors. The only thing that matters about
 * stage 1 is RECALL -- a skill it drops can never come back -- and the only
 * thing that matters about its cost is that it be much less than stage 2's.
 */
import type { Question } from "../../shared/jev.js";
import type { Project } from "../../skill-select/src/projects.js";
import { projectText } from "../../skill-select/src/projects.js";
import { expand, tokens } from "../../skill-select/src/rules.js";
import type { Candidate } from "./corpus.js";

// ------------------------------------------------------------------- stage one

export const PREFILTERS = ["overlap", "tfidf", "firstline", "random", "none"] as const;
export type Prefilter = (typeof PREFILTERS)[number];

export const PREFILTER_BLURB: Record<Prefilter, string> = {
  overlap: "IDF-weighted token overlap over the whole description",
  tfidf: "the same, but the project side is weighted by how rare each token is",
  firstline: "overlap against the description's first sentence only",
  random: "a seeded shuffle -- the control that says what k alone buys",
  none: "no prefilter; the whole roster goes to stage 2 (and does not fit)",
};

const STOP = new Set([
  "the", "and", "for", "when", "use", "with", "this", "that", "from", "into", "not", "are", "its",
  "you", "your", "via", "per", "any", "all", "out", "one", "two", "how", "what", "who", "why",
  "skill", "skills", "project", "repo", "repository", "user", "reference", "guide", "covers",
  "using", "used", "usage", "adding", "add", "setting", "set", "sets", "review", "reviewing",
  "code", "file", "files", "run", "runs", "running", "new", "only", "also", "than", "then",
  "agent", "expert", "senior", "specialist", "mastery", "focus", "emphasis", "comprehensive",
]);

const bagOf = (text: string): Set<string> => {
  const out = new Set<string>();
  for (const t of tokens(text)) for (const e of expand(t)) if (!STOP.has(e)) out.add(e);
  return out;
};

/** A seeded shuffle, so the control is reproducible. */
function seededOrder(n: number, seed: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  let state = seed || 1;
  for (let i = n - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const j = state % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

export interface Prescore {
  name: string;
  score: number;
  hits: string[];
}

/** The prefilter's score for every candidate. Free: no request. */
export function prescore(
  filter: Prefilter,
  cands: readonly Candidate[],
  project: Project,
  seed = 1,
): Prescore[] {
  if (filter === "none") return cands.map((c) => ({ name: c.name, score: 1, hits: [] }));
  if (filter === "random") {
    const order = seededOrder(cands.length, seed);
    return cands.map((c, i) => ({ name: c.name, score: cands.length - order[i], hits: [] }));
  }
  const firstSentence = (text: string) => text.split(/(?<=[.。])\s/)[0] ?? text;
  const bags = cands.map((c) =>
    bagOf(`${c.name} ${filter === "firstline" ? firstSentence(c.description) : c.description}`),
  );
  const docFreq = new Map<string, number>();
  for (const bag of bags) for (const t of bag) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  const n = cands.length;
  const projectBag = bagOf(projectText(project));
  return cands.map((c, i) => {
    const hits: { token: string; weight: number }[] = [];
    for (const t of bags[i]) {
      if (!projectBag.has(t)) continue;
      const df = docFreq.get(t) ?? n;
      // `tfidf` also discounts a token that half the roster uses on the
      // PROJECT side, which matters here: `wshobson/agents` describes 183
      // skills with the same dozen words.
      const weight = filter === "tfidf" ? Math.log(n / df) ** 2 : Math.log(n / df);
      hits.push({ token: t, weight });
    }
    hits.sort((a, b) => b.weight - a.weight);
    return {
      name: c.name,
      score: hits.reduce((sum, h) => sum + h.weight, 0),
      hits: hits.slice(0, 4).map((h) => h.token),
    };
  });
}

/**
 * Keep the top k.
 *
 * Ties break AGAINST the prefilter (a catalogued row after a distractor of
 * the same score), so a filter that gives half the roster zero cannot score
 * on its sort order -- the same rule `skill-select/src/metrics.ts` uses.
 */
export function keepTop(
  scores: readonly Prescore[],
  cands: readonly Candidate[],
  k: number,
): Candidate[] {
  const labelOf = new Map(cands.map((c) => [c.name, c.label]));
  const sorted = [...scores].sort(
    (a, b) =>
      b.score - a.score ||
      Number(labelOf.get(a.name) === "want") - Number(labelOf.get(b.name) === "want"),
  );
  const keep = new Set(sorted.slice(0, k).map((s) => s.name));
  return cands.filter((c) => keep.has(c.name));
}

// ------------------------------------------------------------------- stage two

/**
 * docs/29's winning shape: the project in the state, one score question per
 * survivor, the whole batch in one request.
 *
 * The question is `fanout`'s -- "what does this project need now" -- because
 * docs/29 §5 measured that altitude as the better one for the rows a request
 * text decides, and a tool's input is a request.
 */
export const LEVELS = [
  "This project has no use for it. Nothing in the files or the request is about what it does.",
  "Adjacent, or superseded by something else. Worth naming in passing; not worth installing now.",
  "It fits an activity this project could want, but the request does not ask for that activity.",
  "This project needs it now: the files or the request are about what it does.",
];

/**
 * The same four levels in four words.
 *
 * §1 measured 251 tokens per question against 131 tokens of description, so
 * roughly half of a fan-out request is the criteria text repeated once per
 * question. That is the only part of the payload that is IDENTICAL across
 * questions, which makes it the obvious thing to shrink -- and whether
 * shrinking it changes the answers is a measurement, not a guess (§8).
 */
export const TERSE_LEVELS = ["no use", "adjacent only", "fits, but unasked", "needed now"];

const ASK =
  "An agent working in the repository below can load this skill. Its whole cost is context: " +
  "loading it spends tokens in every conversation, so it should be loaded when the project's " +
  "work is what the skill is about. How strongly does this project call for it?";

export function keyFor(name: string): string {
  return `q_${name.replace(/[^\w]/g, "_")}`;
}

export function questionsFor(group: readonly Candidate[], terse = false): Record<string, Question> {
  const out: Record<string, Question> = {};
  for (const c of group) {
    out[keyFor(c.name)] = {
      type: "score",
      // In the terse form the task sentence moves to the state as well, so
      // what is left in each question is the skill and four words.
      instructions: terse ? { skill: c.name, skill_description: c.description } : { task: ASK, skill: c.name, skill_description: c.description },
      criteria: terse ? TERSE_LEVELS : LEVELS,
    };
  }
  return out;
}

export function stateFor(project: Project, terse = false): Record<string, unknown> {
  const base = {
    what: "a repository an agent is about to work in",
    files: project.files,
    claude_md: project.claudeMd,
    request: project.intent,
  };
  // The task sentence is the same for every question, so in the terse form it
  // is paid for once here instead of n times in the questions.
  return terse ? { ...base, task: ASK, level_meaning: LEVELS } : base;
}

/**
 * Split a survivor list into requests that fit.
 *
 * `perRequest` is a count rather than a token budget on purpose: docs/29 §4
 * measured that width costs no quality, so the only reason to split is the
 * ceiling, and a count is what the caller can reason about. `askFitting` in
 * `run.ts` halves and retries when the estimate is wrong, the way docs/27
 * had to.
 */
export function chunk<T>(items: readonly T[], perRequest: number): T[][] {
  if (!Number.isFinite(perRequest) || perRequest <= 0) return [[...items]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += perRequest) out.push(items.slice(i, i + perRequest));
  return out;
}
