/**
 * One request per turn, for every judgment a turn needs.
 *
 * Three of the five components fire at the same moment and read the same
 * subject -- the request the user just made:
 *
 *   the model router    which tier, and how much deliberation
 *   the skill router    which skills to load
 *   the orchestrator    whether to split the work, and into what shape
 *
 * Run as three extensions they make three requests, each carrying its own
 * copy of the state. Run through here they make one. For a resident agent
 * that is the difference between three round trips per turn and one, and
 * docs/29 §4 is the reason to expect it to be free: 74 questions in one
 * request against the same 74 asked one at a time gave 99.8% of answers
 * within 0.25 and 97% level agreement, for 296,845 input tokens instead of
 * 718,128.
 *
 * WHAT IS NOT MEASURED, AND WHERE THE RISK IS. docs/29 §4's fan-out was many
 * questions of ONE KIND over ONE STATE. This is three different states
 * unioned. The same report measured the neighbouring move as expensive:
 * pushing a question's own SUBJECT into the state dropped agreement to 53%.
 * Nothing here moves a subject -- every question keeps its own instructions
 * verbatim, and all three were already asking about the same request -- but
 * the union itself has not been measured.
 *
 * So it is a setting, defaulting on because that is the whole economy of the
 * thing, and `jev-hermes --compare` asks a turn both ways and reports how far
 * the answers moved. Run it before trusting the saving.
 *
 * The one property this file does guarantee: EACH COMPONENT'S OWN READER IS
 * USED UNCHANGED. The question keys of the three are disjoint, so the merged
 * answer map can be handed to `jev-model-router`'s `judgmentOf`, to the skill
 * router's key lookups, and to `jev-orchestrator`'s `judgmentOf`, exactly as
 * if each had made its own request. No measured code path is rewritten here;
 * a test asserts the disjointness that makes that legal.
 */
import { Jev, type Question, type SystemOneResponse } from "@jev-playground/jev-core";
import {
  questionsFor as modelQuestions,
  stateFor as modelState,
  type RouteInput,
  type RouterConfig,
} from "jev-model-router";
import {
  questionsFor as orchestratorQuestions,
  stateFor as orchestratorState,
  type Framing,
} from "jev-orchestrator";
import {
  LEVELS as SKILL_LEVELS,
  NONE,
  keyFor as skillKey,
  questionsFor as skillQuestions,
  stateFor as skillState,
  type Skill,
} from "jev-skill-router";

export interface TurnInput extends RouteInput {
  /** The skills that survived the free prefilter. Empty asks nothing of them. */
  shortlist?: readonly Skill[];
  files?: string[];
}

export interface TurnConfig {
  router: RouterConfig;
  framing: Framing;
  /** Ask the orchestration gate at all. Off for a host that cannot split. */
  orchestrate: boolean;
}

/**
 * The union state.
 *
 * Flat, one `what`, one `request`. Each component's own `stateFor` is called
 * and merged rather than reimplemented, so a change to any of them arrives
 * here automatically; the only keys written by hand are the two that would
 * otherwise collide.
 *
 * `what` is the collision that matters. The three components each phrase it
 * for their own question, and one sentence has to cover all three. The
 * per-question `instructions` are untouched, which is where docs/29 §4 says
 * the subject belongs.
 */
export function stateFor(input: TurnInput, config: TurnConfig): Record<string, unknown> {
  const model = modelState(input, config.router);
  const work = config.orchestrate ? orchestratorState({ request: input.task, cwd: input.cwd, files: input.files }) : {};
  const { what: _modelWhat, ...modelRest } = model as { what: unknown } & Record<string, unknown>;
  // `cwd` goes too, not just `what` and `request`: the model router already
  // carries the working directory as `working_directory`, and one fact under
  // two names in one state is worse than a wasted field -- it reads as two
  // facts. Dropping the orchestrator's copy keeps the union a union.
  const { what: _workWhat, request: _workRequest, cwd: _workCwd, ...workRest } = work as {
    what?: unknown;
    request?: unknown;
    cwd?: unknown;
  } & Record<string, unknown>;
  return {
    what:
      "one turn of a coding agent: the request below, and what it implies about how much model it " +
      "needs, which skills it calls for, and whether it is work for more than one agent. Judge the " +
      "request, not the agent.",
    ...modelRest,
    ...workRest,
    ...(input.files && input.files.length > 0 ? { files: input.files } : {}),
    // The skill questions carry four-word criteria and lean on the state for
    // what those words mean (docs/30 §7: 251 tokens per question became 118).
    // Included only when a skill is actually being asked about.
    ...(input.shortlist && input.shortlist.length > 0 ? { skill_level_meaning: SKILL_LEVELS } : {}),
  };
}

export function questionsFor(input: TurnInput, config: TurnConfig): Record<string, Question> {
  return {
    ...modelQuestions(config.router),
    ...(input.shortlist && input.shortlist.length > 0 ? skillQuestions(input.shortlist) : {}),
    ...(config.orchestrate ? orchestratorQuestions(config.framing) : {}),
  };
}

/** The keys each component owns, for the disjointness test. */
export function keyGroups(input: TurnInput, config: TurnConfig): Record<string, string[]> {
  return {
    model: Object.keys(modelQuestions(config.router)),
    skills:
      input.shortlist && input.shortlist.length > 0
        ? [...input.shortlist.map((s) => skillKey(s.name)), NONE]
        : [],
    orchestrator: config.orchestrate ? Object.keys(orchestratorQuestions(config.framing)) : [],
  };
}

export interface TurnAnswers {
  response: SystemOneResponse | null;
  /** How many requests it took. 1 combined, up to 3 separate. */
  requests: number;
  error?: string;
  ms: number;
}

/**
 * Ask everything once. Never throws: a turn has to proceed whatever judgment
 * does, and each component's policy already has a no-judgment path.
 */
export async function askCombined(
  input: TurnInput,
  config: TurnConfig,
  opts: { jev?: Jev; timeoutMs?: number } = {},
): Promise<TurnAnswers> {
  const started = Date.now();
  let jev: Jev;
  try {
    jev = opts.jev ?? new Jev({ timeoutMs: opts.timeoutMs ?? 10_000 });
  } catch (err) {
    return { response: null, requests: 0, error: String(err), ms: Date.now() - started };
  }
  try {
    const response = await jev.ask(stateFor(input, config), questionsFor(input, config));
    return { response, requests: 1, ms: Date.now() - started };
  } catch (err) {
    return { response: null, requests: 1, error: String(err).slice(0, 300), ms: Date.now() - started };
  }
}

/**
 * Ask each component separately, exactly as it would on its own.
 *
 * This is what the combined path is being compared AGAINST, and it is here
 * rather than in the extension so both the extension and `--compare` use one
 * implementation of it. Each component's own `stateFor` is used verbatim, so
 * this is the measured configuration and the combined path is the variant.
 *
 * The three run concurrently, so the latency of the separate path is roughly
 * the slowest of the three rather than their sum -- which means the saving
 * the combined path buys is in TOKENS and requests, not in wall clock. Worth
 * being precise about: three copies of the state is the cost, and three
 * round trips in parallel is not.
 */
export async function askSeparately(
  input: TurnInput,
  config: TurnConfig,
  opts: { jev?: Jev; timeoutMs?: number } = {},
): Promise<TurnAnswers> {
  const started = Date.now();
  let jev: Jev;
  try {
    jev = opts.jev ?? new Jev({ timeoutMs: opts.timeoutMs ?? 10_000 });
  } catch (err) {
    return { response: null, requests: 0, error: String(err), ms: Date.now() - started };
  }
  const jobs: Promise<SystemOneResponse>[] = [jev.ask(modelState(input, config.router), modelQuestions(config.router))];
  if (input.shortlist && input.shortlist.length > 0) {
    jobs.push(
      jev.ask(
        skillState({ request: input.task, files: input.files, notes: input.cwd ? `working directory: ${input.cwd}` : undefined }),
        skillQuestions(input.shortlist),
      ),
    );
  }
  if (config.orchestrate) {
    jobs.push(
      jev.ask(orchestratorState({ request: input.task, cwd: input.cwd, files: input.files }), orchestratorQuestions(config.framing)),
    );
  }
  try {
    const parts = await Promise.all(jobs);
    return {
      response: {
        model: parts[0].model,
        answers: Object.assign({}, ...parts.map((p) => p.answers)) as SystemOneResponse["answers"],
        usage: {
          input_tokens: parts.reduce((s, p) => s + p.usage.input_tokens, 0),
          output_tokens: parts.reduce((s, p) => s + p.usage.output_tokens, 0),
        },
      },
      requests: parts.length,
      ms: Date.now() - started,
    };
  } catch (err) {
    return { response: null, requests: jobs.length, error: String(err).slice(0, 300), ms: Date.now() - started };
  }
}

export function askTurn(
  input: TurnInput,
  config: TurnConfig,
  opts: { jev?: Jev; timeoutMs?: number; combine?: boolean } = {},
): Promise<TurnAnswers> {
  return opts.combine === false ? askSeparately(input, config, opts) : askCombined(input, config, opts);
}

/** Everything one request would carry, for the budget and leak tests. */
export function payloadOf(input: TurnInput, config: TurnConfig): string {
  return JSON.stringify({ state: stateFor(input, config), questions: questionsFor(input, config) });
}
