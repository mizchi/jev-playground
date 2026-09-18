/**
 * The cookbook's pipeline, reproduced:
 * https://docs.typesafe.ai/cookbooks/skill_suggestion
 *
 * Two stages, two Jev requests per user message.
 *
 *   Stage 1 (rank_wide)  one choice over EVERY skill, keyed by name, described
 *                        by the same truncated text the agent sees, plus three
 *                        noul gates deciding whether any skill is wanted.
 *   Stage 2 (rerank)     one choice over the top 3 only, this time with the
 *                        full description and an excerpt of SKILL.md, plus one
 *                        noul per candidate asking whether it does the thing.
 *
 * The question wordings and thresholds are the cookbook's. Two things about
 * the design are worth noticing against docs/00:
 *
 * - The stage-1 choice has no "none of these" option, so it always names a
 *   skill. What stops a confident wrong suggestion is the separate noul gate
 *   — which is exactly the "scope gate in the same request" fix from
 *   docs/00-api-notes.md, arrived at independently.
 * - 182 skills (68 here) sits under the 255-choice ceiling, so the whole
 *   roster fits in one question. A roster past 255 would need pre-filtering.
 */
import { Jev, choice, noul, type Question } from "../../shared/jev.js";
import type { SkillEntry } from "./roster.js";

/** Mean of the three gate scores must clear this for anything to be suggested. */
export const GATE_THRESHOLD = 0.3;
/** The best candidate's own "does it fit" score must clear this. */
export const FITS_THRESHOLD = 0.3;
export const SHORTLIST = 3;
export const EXCERPT_CHARS = 700;

export interface Trace {
  gate: { acts: number; procedure: number; generalist: number; mean: number };
  ranked: { name: string; p: number }[];
  shortlist: string[];
  winner?: string;
  fits?: Record<string, number>;
  bestFits?: number;
  stoppedAt?: "gate" | "fits";
  jevCalls: number;
}

/** Stage 1: rank every skill, and decide whether a skill is wanted at all. */
async function rankWide(
  jev: Jev,
  roster: SkillEntry[],
  request: string,
): Promise<{ ranked: { name: string; p: number }[]; gate: Trace["gate"] }> {
  const criteria: Record<string, string> = {};
  for (const s of roster) criteria[s.name] = s.index_desc;
  const questions: Record<string, Question> = {
    skill: {
      type: "choice",
      instructions:
        "Which of these skills, if any, is the right one to load to help with the user's latest request?",
      criteria,
    },
    acts_on_world: {
      type: "noul",
      instructions:
        "Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?",
    },
    needs_procedure: {
      type: "noul",
      instructions:
        "Would a careful expert answering this consult a specific documented procedure or set of commands, rather than general understanding?",
    },
    generalist_suffices: {
      type: "noul",
      instructions:
        "Could a knowledgeable generalist fully satisfy this request in prose, with no tools or access?",
    },
  };
  const res = await jev.ask({ request, recent_context: "" }, questions);
  const a = res.answers.skill;
  const probs = a?.type === "choice" ? a.probabilities : {};
  const ranked = Object.entries(probs)
    .map(([name, p]) => ({ name, p }))
    .sort((x, y) => y.p - x.p);
  const acts = noul(res.answers.acts_on_world);
  const procedure = noul(res.answers.needs_procedure);
  const generalist = noul(res.answers.generalist_suffices);
  // The third question argues AGAINST needing a skill, so it is inverted
  // before being averaged in.
  const mean = (acts + procedure + (1 - generalist)) / 3;
  return { ranked, gate: { acts, procedure, generalist, mean } };
}

/** Stage 2: look properly at the shortlist. */
async function rerank(
  jev: Jev,
  roster: SkillEntry[],
  request: string,
  names: string[],
): Promise<{ winner: string; fits: Record<string, number> }> {
  const byName = new Map(roster.map((s) => [s.name, s]));
  const criteria: Record<string, string> = {};
  const questions: Record<string, Question> = {};
  for (const name of names) {
    const s = byName.get(name);
    if (!s) continue;
    criteria[name] = `${s.description}\n\n${s.body.slice(0, EXCERPT_CHARS)}`;
    questions[`fits_${name}`] = {
      type: "noul",
      instructions: `Does ${name} do the specific thing the user's request asks for? It is described as: ${s.description}`,
    };
  }
  questions.skill = {
    type: "choice",
    instructions:
      "Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name.",
    criteria,
  };
  const res = await jev.ask({ request, recent_context: "" }, questions);
  const fits: Record<string, number> = {};
  for (const name of names) fits[name] = noul(res.answers[`fits_${name}`]);
  return { winner: choice(res.answers.skill).choice, fits };
}

/**
 * At most one skill name, or none. Returns the trace too, because the whole
 * point of the exercise is seeing where it stops.
 */
export async function suggest(
  jev: Jev,
  roster: SkillEntry[],
  request: string,
): Promise<{ names: string[]; trace: Trace }> {
  const { ranked, gate } = await rankWide(jev, roster, request);
  if (gate.mean < GATE_THRESHOLD) {
    return {
      names: [],
      trace: { gate, ranked: ranked.slice(0, 5), shortlist: [], stoppedAt: "gate", jevCalls: 1 },
    };
  }
  const shortlist = ranked.slice(0, SHORTLIST).map((r) => r.name);
  const { winner, fits } = await rerank(jev, roster, request, shortlist);
  const bestFits = Math.max(...Object.values(fits));
  if (bestFits < FITS_THRESHOLD) {
    return {
      names: [],
      trace: {
        gate,
        ranked: ranked.slice(0, 5),
        shortlist,
        fits,
        bestFits,
        stoppedAt: "fits",
        jevCalls: 2,
      },
    };
  }
  return {
    names: [winner],
    trace: { gate, ranked: ranked.slice(0, 5), shortlist, winner, fits, bestFits, jevCalls: 2 },
  };
}

/** The block the cookbook appends to the system prompt after the roster. */
export function suggestionBlock(names: string[]): string {
  if (names.length === 0) {
    return "<skill_relevance>\nNo skill in the roster appears relevant to this request.\n</skill_relevance>";
  }
  return (
    "<skill_relevance>\n" +
    `Relevant to the current request: ${names[0]}. Ignore this if it does not fit ` +
    "what the user actually asked for.\n" +
    "</skill_relevance>"
  );
}
