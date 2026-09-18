/**
 * The free baseline: lexical overlap between the skill's description and the
 * project's text.
 *
 * This is what a selector can do without spending anything, and the repo's
 * standing rule (docs/07, docs/23 §5, docs/27 §3) is that the judgment has to
 * beat it. The scoring is IDF-weighted token overlap plus a bonus for a
 * filename the description names outright, because "the description mentions
 * `wrangler.toml` and the repo has one" is the strongest cheap signal there is.
 *
 * It is also, deliberately, the thing that gets `justfile` wrong: the skill
 * named `justfile` matches a repo with a `justfile` perfectly, and the
 * catalog's answer is `mention`, not `want` (docs/29 §1).
 */
import type { Candidate, Project } from "./projects.js";
import { projectText } from "./projects.js";

/** Lowercase alphanumeric runs, keeping dots and dashes inside identifiers. */
export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9]*(?:[.\-/][a-z0-9]+)*/g) ?? []).filter((t) => t.length > 1);
}

/** Split an identifier into its parts too, so `wrangler.toml` matches `wrangler`. */
export function expand(token: string): string[] {
  const parts = token.split(/[.\-/]/).filter((p) => p.length > 1);
  return parts.length > 1 ? [token, ...parts] : [token];
}

const STOP = new Set([
  "the", "and", "for", "when", "use", "with", "this", "that", "from", "into", "not", "are", "its",
  "you", "your", "via", "per", "any", "all", "out", "one", "two", "how", "what", "who", "why",
  "skill", "skills", "project", "repo", "repository", "user", "reference", "guide", "covers",
  "using", "used", "usage", "adding", "add", "setting", "set", "sets", "review", "reviewing",
  "code", "file", "files", "run", "runs", "running", "new", "only", "also", "than", "then",
]);

export interface RuleScore {
  skill: string;
  /** IDF-weighted overlap, 0 when nothing matches. */
  score: number;
  /** The tokens that carried it, strongest first. */
  hits: string[];
}

/**
 * Score every candidate against one project.
 *
 * IDF is computed over the candidate descriptions themselves, so a token
 * every skill uses ("skill", "covers") is worth nothing and `wrangler` is
 * worth a lot. That makes the baseline as strong as a few lines can be --
 * which is the point of a baseline.
 */
export function ruleScores(candidates: Candidate[], project: Project): RuleScore[] {
  const docFreq = new Map<string, number>();
  const bags = candidates.map((c) => {
    const bag = new Set<string>();
    for (const t of tokens(`${c.skill} ${c.description}`)) for (const e of expand(t)) if (!STOP.has(e)) bag.add(e);
    for (const t of bag) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    return bag;
  });
  const projectBag = new Set<string>();
  for (const t of tokens(projectText(project))) for (const e of expand(t)) if (!STOP.has(e)) projectBag.add(e);
  const n = candidates.length;
  return candidates.map((c, i) => {
    const hits: { token: string; weight: number }[] = [];
    for (const t of bags[i]) {
      if (!projectBag.has(t)) continue;
      const df = docFreq.get(t) ?? n;
      hits.push({ token: t, weight: Math.log(n / df) });
    }
    hits.sort((a, b) => b.weight - a.weight);
    return {
      skill: c.skill,
      score: hits.reduce((sum, h) => sum + h.weight, 0),
      hits: hits.slice(0, 4).map((h) => h.token),
    };
  });
}
