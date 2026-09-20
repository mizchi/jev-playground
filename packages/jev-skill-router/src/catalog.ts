/**
 * A skill catalogue, and the lexical prefilter that has to come before
 * judgment can see it.
 *
 * The prefilter is not an optimisation, it is the only way the request fits.
 * docs/30 §1 measured it: 461 real skills are 60,358 tokens of name and
 * description, and a fan-out that asks one question per skill costs about 270
 * tokens per skill against a 65,536-token request ceiling -- roughly 124,000
 * tokens, which the server refuses. So something free has to cut the roster
 * first, and the only property of that thing that matters is RECALL, because
 * a skill it drops can never come back.
 *
 * Measured recall ceilings at k=60 over 461 skills (docs/30 §3):
 *
 *   overlap    85%   IDF-weighted token overlap over the whole description
 *   firstline  67%   the same against the first sentence only
 *   random     22%   the control that says what k alone buys
 *
 * `overlap` is the default because of that table, not because it sounds
 * reasonable. The 15% it drops is the router's hard ceiling and is stated in
 * the README rather than discovered later.
 */

export interface Skill {
  name: string;
  description: string;
  /**
   * How the skill should be decided, when the catalogue itself says.
   *
   * docs/29 §5 measured this: routing by the catalogue's own tier before
   * asking reached 0.70 average precision against 0.53 for asking about
   * everything. A catalogue that marks a skill "always load" has already made
   * the decision, and spending a question on it is spending a question to
   * rediscover the answer.
   */
  route?: "always" | "never" | "judge";
  /** Where the instructions live, for a host that wants to load them. */
  path?: string;
  /** Hosts mark some skills as not model-invocable. Those are never loaded. */
  invocable?: boolean;
}

export interface Context {
  /** What the user asked for. The strongest signal there is. */
  request: string;
  /** Files in play, if the host knows them. */
  files?: string[];
  /** Project notes the host already loads, e.g. CLAUDE.md or AGENTS.md. */
  notes?: string;
  /** Earlier turns, oldest first. */
  recent?: string[];
}

export function contextText(ctx: Context): string {
  return [ctx.request, ...(ctx.recent ?? []), ...(ctx.files ?? []), ctx.notes ?? ""].join("\n");
}

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9]*(?:[.\-/][a-z0-9]+)*/g) ?? []).filter((t) => t.length > 1);
}

/** Split an identifier into its parts too, so `wrangler.toml` matches `wrangler`. */
export function expand(token: string): string[] {
  const parts = token.split(/[.\-/]/).filter((p) => p.length > 1);
  return parts.length > 1 ? [token, ...parts] : [token];
}

/**
 * Words that carry no signal in a skill catalogue.
 *
 * Ported verbatim from docs/29/30's `rules.ts` rather than rewritten, because
 * the recall figures above were measured with exactly this list. A shorter or
 * longer list is a different prefilter and would need its own numbers.
 */
const STOP = new Set([
  "the", "and", "for", "when", "use", "with", "this", "that", "from", "into", "not", "are", "its",
  "you", "your", "via", "per", "any", "all", "out", "one", "two", "how", "what", "who", "why",
  "skill", "skills", "project", "repo", "repository", "user", "reference", "guide", "covers",
  "using", "used", "usage", "adding", "add", "setting", "set", "sets", "review", "reviewing",
  "code", "file", "files", "run", "runs", "running", "new", "only", "also", "than", "then",
  "agent", "expert", "senior", "specialist", "mastery", "focus", "emphasis", "comprehensive",
]);

function bagOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokens(text)) for (const e of expand(t)) if (!STOP.has(e)) out.add(e);
  return out;
}

export interface Prescore {
  name: string;
  score: number;
  /** The tokens that carried it, strongest first. Shown by the CLI. */
  hits: string[];
}

export const PREFILTERS = ["overlap", "firstline", "none"] as const;
export type Prefilter = (typeof PREFILTERS)[number];

/** Every skill's prefilter score against one context. Free: no request. */
export function prescore(skills: readonly Skill[], ctx: Context, filter: Prefilter = "overlap"): Prescore[] {
  if (filter === "none") return skills.map((s) => ({ name: s.name, score: 1, hits: [] }));
  const firstSentence = (text: string): string => text.split(/(?<=[.。])\s/)[0] ?? text;
  const bags = skills.map((s) =>
    bagOf(`${s.name} ${filter === "firstline" ? firstSentence(s.description) : s.description}`),
  );
  const docFreq = new Map<string, number>();
  for (const bag of bags) for (const t of bag) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  const n = Math.max(1, skills.length);
  const contextBag = bagOf(contextText(ctx));
  return skills.map((s, i) => {
    const hits: { token: string; weight: number }[] = [];
    for (const t of bags[i]) {
      if (!contextBag.has(t)) continue;
      hits.push({ token: t, weight: Math.log(n / (docFreq.get(t) ?? n)) });
    }
    hits.sort((a, b) => b.weight - a.weight);
    return {
      name: s.name,
      score: hits.reduce((sum, h) => sum + h.weight, 0),
      hits: hits.slice(0, 4).map((h) => h.token),
    };
  });
}

/**
 * The top k, with ties broken by name.
 *
 * By NAME and not by catalogue order, so a caller who happens to list the
 * right skill first does not get credit the prefilter did not earn. The
 * evaluation in `experiments/router` relies on that: docs/30's metrics break
 * ties against the thing being measured for the same reason.
 */
export function keepTop(skills: readonly Skill[], scores: readonly Prescore[], k: number): Skill[] {
  const byName = new Map(scores.map((s) => [s.name, s.score]));
  const sorted = [...skills].sort(
    (a, b) => (byName.get(b.name) ?? 0) - (byName.get(a.name) ?? 0) || a.name.localeCompare(b.name),
  );
  return sorted.slice(0, Math.max(0, k));
}

export interface Split {
  /** The catalogue already decided: load, no question asked. */
  always: Skill[];
  /** The catalogue already decided: never. */
  never: Skill[];
  /** Everything a question could be spent on, before the prefilter. */
  judge: Skill[];
  /** Dropped because the host says the model may not invoke them. */
  blocked: Skill[];
}

/** Sort the catalogue by who decides. docs/29 §5's routing, before any request. */
export function split(skills: readonly Skill[]): Split {
  const out: Split = { always: [], never: [], judge: [], blocked: [] };
  for (const s of skills) {
    if (s.invocable === false) out.blocked.push(s);
    else if (s.route === "always") out.always.push(s);
    else if (s.route === "never") out.never.push(s);
    else out.judge.push(s);
  }
  return out;
}
