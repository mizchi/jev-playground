/**
 * The standalone skill router: catalogue in, a short list of skills out.
 *
 * Four stages, and only one of them costs anything:
 *
 *   1. split      the catalogue's own routing. Free. docs/29 §5.
 *   2. prescore   IDF-weighted lexical overlap. Free. docs/30 §3.
 *   3. ask        one request, one `score` per survivor plus one escape noul.
 *   4. policy     a cutoff and a cap, applied in code.
 *
 * It does not read a skill's file, execute anything, or grant permission to
 * act. A host that wants the instructions loads them itself, which is also
 * why `Skill.path` is carried through untouched.
 */
import { Jev, noulOf, scoreOf } from "@jev-playground/jev-core";
import {
  keepTop,
  prescore,
  split,
  type Context,
  type Prefilter,
  type Prescore,
  type Skill,
} from "./catalog.js";
import { NONE, keyFor, questionsFor, stateFor } from "./questions.js";

export interface SkillRouterConfig {
  /** How many skills survive the prefilter and get a question. */
  shortlist: number;
  /**
   * The most skills to load, however many clear the cutoff.
   *
   * There is a cap because precision falls as the cap rises: docs/30 §5
   * measured P@12 dropping from 0.25 to 0.19 as k grew, over the same
   * answers. Loading everything that scores well is how a context window
   * fills with things nobody asked for.
   *
   * docs/29 §8's grid reproduces it on this pipeline -- at `loadAt` 2.5 the
   * cap takes precision 0.844 -> 0.750 -> 0.778 and recall 0.252 -> 0.280 ->
   * 0.327 as it goes 3 -> 5 -> 10. And at a cap of 1 every cutoff in the grid
   * gives the same answer, because then the cap alone decides.
   */
  maxLoad: number;
  /**
   * A skill is loaded at or above this level. The levels are 0..3, so 2.5
   * sits between "fits, but unasked" and "needed now".
   *
   * FITTED, and it came back where it started. docs/29 §8 ran the shipped
   * `selectFrom` over a (cutoff, cap) grid on 1,008 judged pairs from 14
   * projects, folds cut along projects. At the shipped cap of 3, 2.5 gives
   * the best precision of the grid (0.844); 2.0 gives 0.771 and 1.5 gives
   * 0.750.
   *
   * The reason to keep reading: fitting this cutoff ON ITS OWN moves it to
   * 1.39 and is STRICTLY WORSE through the pipeline -- identical recall
   * (0.252) and precision 0.844 -> 0.750. The cap is already binding, so a
   * lower cutoff cannot admit more wanted skills, only more unwanted ones
   * into the same three places. Its held-out balanced accuracy nonetheless
   * says 1.39 beats 2.50, cross-validated and everything. `maxLoad` and this
   * number have to be fitted together or not at all.
   */
  loadAt: number;
  /**
   * Above this, the escape noul suppresses every load.
   *
   * NOT fitted, and docs/29 §8 says why in a way worth keeping: of its 14
   * projects exactly ONE (`bare-repo`, a repository where nothing is decided
   * yet) is a context no judged skill is for. One positive cannot place a
   * cutoff -- and the free substitute, "no skill cleared `loadAt`", picks out
   * that same project at no extra question.
   *
   * So on the only corpus available the hatch buys nothing over reading the
   * scores. It stays because docs/17 §3 measured the SHAPE (a hatch belongs
   * in its own question: 18/18 against 16/18 as an extra level), and because
   * a catalogue with more contexts nothing is for would need it. The default
   * is deliberately timid.
   */
  noneAt: number;
  prefilter: Prefilter;
  timeoutMs: number;
}

export const DEFAULT_SKILL_CONFIG: SkillRouterConfig = {
  shortlist: 60,
  maxLoad: 3,
  loadAt: 2.5,
  noneAt: 0.8,
  prefilter: "overlap",
  timeoutMs: 10_000,
};

export interface Pick {
  skill: Skill;
  /** The `score` answer, continuous over the four levels. */
  level: number;
  confidence: number;
  /** Why it is in the result: the catalogue, or judgment. */
  why: "always" | "judged";
}

export interface SkillDecision {
  load: Pick[];
  /** Asked about and not loaded, strongest first. Useful for a `/why` command. */
  considered: Pick[];
  /** Never asked about: dropped by the prefilter or by the catalogue. */
  droppedBy: { prefilter: string[]; catalogue: string[]; blocked: string[] };
  /** The escape hatch's answer. NaN when judgment was not reached. */
  noneApply: number;
  reason: string;
  error?: string;
  ms: number;
  usage?: { input: number; output: number };
}

/**
 * Apply the cutoff and the cap. Pure, so it is testable without a key.
 *
 * The cap is applied AFTER the cutoff and not instead of it: a context that
 * genuinely wants one skill should load one, not `maxLoad` of them. Ranking
 * and then taking the top k would load three skills for every request,
 * including the ones no skill is for.
 */
export function selectFrom(
  picks: readonly Pick[],
  noneApply: number,
  config: SkillRouterConfig,
): { load: Pick[]; considered: Pick[]; reason: string } {
  const ranked = [...picks].sort((a, b) => b.level - a.level || a.skill.name.localeCompare(b.skill.name));
  const always = ranked.filter((p) => p.why === "always");
  if (Number.isFinite(noneApply) && noneApply > config.noneAt) {
    // The escape hatch fired. The catalogue's own "always" skills still load:
    // judgment was asked which of the OTHERS apply, not whether the
    // catalogue's policy was right.
    return { load: always, considered: ranked.filter((p) => p.why !== "always"), reason: "none-apply" };
  }
  const judged = ranked.filter((p) => p.why === "judged" && p.level >= config.loadAt);
  const load = [...always, ...judged.slice(0, Math.max(0, config.maxLoad))];
  const loaded = new Set(load.map((p) => p.skill.name));
  return {
    load,
    considered: ranked.filter((p) => !loaded.has(p.skill.name)),
    reason: judged.length > config.maxLoad ? "capped" : judged.length > 0 ? "judged" : "nothing-over-cutoff",
  };
}

export async function route(
  ctx: Context,
  skills: readonly Skill[],
  opts: { config?: Partial<SkillRouterConfig>; jev?: Jev } = {},
): Promise<SkillDecision> {
  const config: SkillRouterConfig = { ...DEFAULT_SKILL_CONFIG, ...opts.config };
  const started = Date.now();
  const parts = split(skills);
  const alwaysPicks: Pick[] = parts.always.map((skill) => ({
    skill,
    level: LEVEL_TOP,
    confidence: 1,
    why: "always" as const,
  }));
  const dropped = {
    prefilter: [] as string[],
    catalogue: parts.never.map((s) => s.name),
    blocked: parts.blocked.map((s) => s.name),
  };

  const scores: Prescore[] = prescore(parts.judge, ctx, config.prefilter);
  const shortlist = keepTop(parts.judge, scores, config.shortlist);
  const kept = new Set(shortlist.map((s) => s.name));
  dropped.prefilter = parts.judge.filter((s) => !kept.has(s.name)).map((s) => s.name);

  const fail = (error: string | undefined, reason: string): SkillDecision => ({
    load: alwaysPicks,
    considered: [],
    droppedBy: dropped,
    noneApply: Number.NaN,
    reason,
    ...(error ? { error } : {}),
    ms: Date.now() - started,
  });

  if (shortlist.length === 0) return fail(undefined, "nothing-to-ask");

  let jev: Jev;
  try {
    jev = opts.jev ?? new Jev({ timeoutMs: config.timeoutMs });
  } catch (err) {
    return fail(String(err), "unavailable");
  }

  try {
    const res = await jev.ask(stateFor(ctx), questionsFor(shortlist));
    const picks: Pick[] = shortlist.map((skill) => {
      const a = scoreOf(res.answers, keyFor(skill.name));
      return { skill, level: a.score, confidence: a.confidence, why: "judged" as const };
    });
    const noneApply = noulOf(res.answers, NONE);
    const chosen = selectFrom([...alwaysPicks, ...picks.filter((p) => Number.isFinite(p.level))], noneApply, config);
    return {
      ...chosen,
      droppedBy: dropped,
      noneApply,
      ms: Date.now() - started,
      usage: { input: res.usage.input_tokens, output: res.usage.output_tokens },
    };
  } catch (err) {
    // Fails to the catalogue's own decisions. A skill router that throws has
    // turned "I could not pick a skill" into "the agent cannot work".
    return fail(String(err).slice(0, 300), "unavailable");
  }
}

/** The top level's index, for the skills the catalogue already decided. */
const LEVEL_TOP = 3;

export {
  contextText,
  expand,
  keepTop,
  prescore,
  split,
  tokens,
  PREFILTERS,
  type Context,
  type Prefilter,
  type Prescore,
  type Skill,
  type Split,
} from "./catalog.js";
export { LEVELS, NONE, TERSE_LEVELS, keyFor, payloadOf, questionsFor, stateFor } from "./questions.js";
export { DEFAULT_SKILL_CONFIG as DEFAULT_CONFIG };
