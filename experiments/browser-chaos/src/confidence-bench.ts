/**
 * What should a browser driver do on the steps it is unsure about?
 *
 * docs/05 measured Jev against a weighted-random walk and found the depth
 * it was after, but it also left a loose thread: during the runs that
 * looped, "the confidence was 0.40-0.47 — the model was correctly
 * reporting that it was unsure. The signal was there; what wasn't using it
 * was my code."
 *
 * So this harness uses it. Four policies, one shared step loop, and the
 * same collection pass feeding all of them — the arms differ only in what
 * they are told and what they are offered, never in what was measured:
 *
 *   baseline        act on every pick, however unsure
 *   random          below the threshold, pick uniformly instead (breadth)
 *   probe-retry     below the threshold, attach the geometry and re-ask
 *   probe-prune     never offer a control the geometry says is unclickable
 *
 * `probe-prune` is the interesting one, because docs/05 §2 argues for it
 * on other grounds: "a choice you do not want repeated should be removed
 * in code, not resisted by the model." If that generalises, the cheapest
 * arm — one call per step, same as baseline — should also be the best,
 * and `probe-retry` pays for a second call to buy less.
 *
 * Every arm is told what the browser reported about the previous action,
 * error text included. That matters for fairness: Playwright's own
 * actionability check names the element that intercepted a blocked click,
 * so a text-only arm is not blind to an overlay — it just learns about it
 * one wasted step later than the geometry does.
 */
import type { Page } from "playwright";
import { Jev, choice, noul, type Question } from "../../shared/jev.js";
import { notableFacts, probe, type ProbedCandidate } from "./probes.js";

export type FallbackMode = "none" | "random" | "probe-retry" | "probe-prune";

export interface Policy {
  name: string;
  /** Confidence below which the fallback fires. 0 disables it. */
  minConfidence: number;
  mode: FallbackMode;
}

export const POLICIES: Policy[] = [
  { name: "baseline", minConfidence: 0, mode: "none" },
  { name: "random", minConfidence: 0.7, mode: "random" },
  { name: "probe-retry", minConfidence: 0.7, mode: "probe-retry" },
  { name: "probe-prune", minConfidence: 0, mode: "probe-prune" },
];

/** One step, as it happened. The row the calibration question is asked of. */
export interface StepLog {
  step: number;
  hash: string;
  offered: number;
  picked: string;
  confidence: number;
  /** Fired the policy's fallback on this step. */
  fellBack: boolean;
  /** Confidence of the second answer, when the policy re-asked. */
  retryConfidence?: number;
  /** The action changed the screen fingerprint. */
  hadEffect: boolean;
  /** The action moved the checkout flow one state deeper than before. */
  advanced: boolean;
  /** Playwright's complaint, when the click or fill did not go through. */
  error?: string;
  /** The geometry said this pick was unclickable, whether or not we used it. */
  wasBlocked: boolean;
}

export interface RunResult {
  states: string[];
  picks: string[];
  reachedGoal: boolean;
  wastedSteps: number;
  log: StepLog[];
}

/** Type-aware fill values, as in spa-bench. */
function fillValue(description: string): string {
  if (description.includes("email")) return "test@example.com";
  if (description.includes("address") || description.includes("Address")) return "1 Example Street";
  return "test input";
}

/**
 * Perform the action and report what the browser said about it. The error
 * is kept rather than swallowed: on a blocked click Playwright names the
 * element that intercepted it, which is the most useful sentence available
 * and costs nothing to pass on.
 */
async function perform(page: Page, c: ProbedCandidate): Promise<{ ok: boolean; error?: string }> {
  try {
    const el = page.locator(c.selector).first();
    if (c.type === "input") await el.fill(fillValue(c.description), { timeout: 1500 });
    else await el.click({ timeout: 1500 });
    await page.waitForTimeout(60);
    return { ok: true };
  } catch (err) {
    // Playwright's message is a wall of ANSI-coloured retry logs. The first
    // line and any "intercepts pointer events" clause are the whole
    // content, and the clause is the good part: it names the element that
    // took the click, which is exactly what the geometry probe reports.
    // eslint-disable-next-line no-control-regex
    const raw = (err instanceof Error ? err.message : String(err)).replace(/\[\d+m/g, "");
    // Anchored at the opening tag, not at `<[^>]+>`: the interceptor is
    // logged as `<div id="tip-backdrop"></div> intercepts …`, and the lazy
    // form matches the closing tag, throwing away the id — the only part
    // that tells the reader which element to get rid of.
    const intercept = raw.match(/<[a-zA-Z][^\n]*?intercepts pointer events/);
    const first = raw.split("\n")[0]?.replace(/^locator\.\w+: /, "") ?? raw;
    return { ok: false, error: intercept ? `${first} — ${intercept[0]}` : first.slice(0, 160) };
  }
}

/**
 * The whole visible page, not just `#view`. docs/05's harness read `#view`
 * and `#status`, which is enough for an app that renders everything into
 * one element — and would have hidden a fixed overlay from every arm. Here
 * the text arms get the overlay's copy too, so what separates the probe
 * arms is only the part text genuinely cannot express: which of these
 * controls will receive a click.
 */
const SCREEN_TEXT = `(() => {
  const body = (document.body.innerText || "").trim().replace(/\\n{3,}/g, "\\n\\n");
  const fields = Array.from(document.querySelectorAll("input, textarea, select"))
    .map((el) => (el.id || "field") + ": " + (el.value ? '"' + el.value + '"' : "(empty)"))
    .join("; ");
  return (body + (fields ? "\\nfields -> " + fields : "")).slice(0, 1200);
})()`;

/** Changes whenever anything the user could notice changes, field values included. */
const SIGNATURE = `(() => {
  const fields = Array.from(document.querySelectorAll("input, textarea, select"))
    .map((el) => (el.id || "") + "=" + (el.value || "")).join(",");
  const overlay = Array.from(document.querySelectorAll("*"))
    .filter((el) => { const cs = getComputedStyle(el); return cs.position === "fixed" && !el.hidden; })
    .length;
  return location.hash + "|" + (document.body.innerText || "") + "|" + fields + "|" + overlay;
})()`;

async function evalString(page: Page, src: string): Promise<string> {
  try {
    return (await page.evaluate(src)) as string;
  } catch {
    return "";
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** True when the geometry says a click on this candidate goes elsewhere. */
function blocked(c: ProbedCandidate): boolean {
  return !c.facts.enabled || c.facts.inert || c.facts.coveredBy !== undefined;
}

/**
 * A note to attach to one candidate, or `null` for "nothing worth the
 * tokens". docs/25 attaches the geometry this way and docs/26 the
 * never-executed code; both are the same move — put the fact next to the
 * choice it bears on, rather than in a list somewhere else in the state.
 */
export type Annotate = (c: ProbedCandidate) => string | null;

const NO_NOTES: Annotate = () => null;

interface AskContext {
  goal: string;
  hash: string;
  step: number;
  seen: string[];
  recent: string[];
  screenText: string;
  lastAction?: string;
  lastHadEffect?: boolean;
  lastError?: string;
  noEffectStreak: number;
  inert: string[];
  /**
   * Anything the caller wants in the state on top of the above, merged in
   * as-is. docs/26 uses it for the never-executed function names; it is
   * deliberately opaque here so a new hint does not need a new field.
   */
  extra?: Record<string, unknown>;
}

/**
 * One request, three questions. Identical across arms except for
 * `withFacts`, which appends the geometry to each candidate's criteria —
 * the smallest possible difference between "told" and "not told".
 */
async function ask(
  jev: Jev,
  offered: ProbedCandidate[],
  ctx: AskContext,
  annotate: Annotate,
): Promise<{ index: number; confidence: number; undo: number }> {
  const criteria: Record<string, string> = {};
  for (const c of offered) {
    const note = annotate(c);
    criteria[String(c.index)] = note ? `${c.description}  [${note}]` : c.description;
  }
  const questions: Record<string, Question> = {
    pick: {
      type: "choice",
      instructions:
        "Which control moves furthest toward the goal? Prefer opening a state not in states_seen, and prefer advancing a multi-step flow over restarting it. If the last action changed nothing, the step is gated on something you have not done yet — fill a required field, or clear whatever is in the way, instead of pressing the same button again.",
      criteria,
    },
    undo: {
      type: "noul",
      instructions:
        "The control you chose would undo progress already made — emptying a cart, deleting an account, going back a step.",
    },
    dead_end: {
      type: "noul",
      instructions: "Nothing on this screen advances the goal.",
      criteria: {
        true: "This screen is a dead end; the crawl should navigate away",
        false: "At least one control here makes progress",
      },
    },
  };
  const state = {
    ...ctx.extra,
    goal: ctx.goal,
    current_url: ctx.hash,
    screen: ctx.screenText,
    step: ctx.step,
    states_seen: ctx.seen,
    recent_actions: ctx.recent.slice(-6),
    last_action: ctx.lastAction,
    last_action_changed_the_page: ctx.lastHadEffect,
    // Playwright's own words when the action did not go through.
    last_action_error: ctx.lastError,
    actions_with_no_effect_in_a_row: ctx.noEffectStreak,
    controls_already_tried_here_with_no_effect: ctx.inert,
    candidates: offered.map((c) => {
      const note = annotate(c);
      return note
        ? { index: c.index, description: c.description, state: note }
        : { index: c.index, description: c.description };
    }),
  };
  const res = await jev.ask(state, questions);
  const picked = choice(res.answers.pick);
  return {
    index: Number.parseInt(picked.choice, 10),
    confidence: picked.confidence,
    undo: noul(res.answers.undo),
  };
}

export interface RunOptions {
  page: Page;
  baseUrl: string;
  steps: number;
  policy: Policy;
  jev: Jev;
  /**
   * What the run is for. A supplier when the goal itself depends on what
   * has happened — docs/26's `in-goal` arm rewrites it each step from the
   * coverage so far. Resolved after `extraState`, so a supplier can read
   * whatever that just refreshed.
   */
  goal: string | (() => string);
  goalState: string;
  /** Checkout states in order, for the depth metric. */
  flow: string[];
  seed: number;
  trace?: (line: string) => void;
  /**
   * Called before each step; whatever it returns is merged into the
   * state. Return `{}` for the arm that should not see the hint — the two
   * arms then differ by one key and nothing else.
   */
  extraState?: () => Promise<Record<string, unknown>>;
  /** Called after each action, for callers that keep their own tallies. */
  afterStep?: (log: StepLog) => Promise<void> | void;
  /** Stop early when this returns true (default: on reaching goalState). */
  done?: (seen: ReadonlySet<string>) => boolean;
  /**
   * Skip the initial `goto`, because the caller has already loaded the
   * page and needs the document kept. docs/26 needs this: a
   * cross-document navigation restarts V8 coverage, and the function
   * inventory has to be taken before anything else runs scripts.
   */
  alreadyLoaded?: boolean;
  /**
   * Overrides what gets attached to each candidate. Defaults to the
   * geometry for the probe policies and to nothing otherwise.
   */
  annotate?: Annotate;
}

export async function runPolicy(opts: RunOptions): Promise<RunResult> {
  const { page, baseUrl, steps, policy, jev, goal, goalState, flow, seed, trace } = opts;
  const { extraState, afterStep, done } = opts;
  const rnd = mulberry32(seed);
  if (!opts.alreadyLoaded) await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

  const hashOf = (u: string) => (u.includes("#") ? u.slice(u.indexOf("#")) : "#/home");
  const seen = new Set<string>([hashOf(page.url())]);
  const picks: string[] = [];
  const log: StepLog[] = [];
  let wasted = 0;
  let lastAction: string | undefined;
  let lastHadEffect: boolean | undefined;
  let lastError: string | undefined;
  let noEffectStreak = 0;
  // Per-screen memory of controls that changed nothing, cleared when the
  // screen does. docs/05 §3: the fingerprint has to include field values or
  // a perfectly good "fill the email" gets recorded as inert.
  let inertFor = "";
  let inert = new Set<string>();

  const depthOf = () => {
    let d = 0;
    for (let i = 0; i < flow.length; i += 1) if (seen.has(flow[i]!)) d = i + 1;
    return d;
  };

  for (let step = 0; step < steps; step += 1) {
    const { candidates } = await probe(page);
    if (candidates.length === 0) break;
    const before = await evalString(page, SIGNATURE);
    if (before !== inertFor) {
      inertFor = before;
      inert = new Set<string>();
    }
    const hash = hashOf(page.url());
    const depthBefore = depthOf();

    // Order matters: the goal supplier may read state that `extraState`
    // has just refreshed.
    const extra = extraState ? await extraState() : undefined;
    const ctx: AskContext = {
      goal: typeof goal === "function" ? goal() : goal,
      hash,
      step,
      seen: [...seen],
      recent: picks,
      screenText: await evalString(page, SCREEN_TEXT),
      lastAction,
      lastHadEffect,
      lastError,
      noEffectStreak,
      inert: [...inert],
      extra,
    };

    // What the policy is willing to offer. Only `probe-prune` narrows it,
    // and never to nothing: a screen whose every control is blocked still
    // has to be leavable.
    const notInert = candidates.filter((c) => !inert.has(c.description));
    let offered = notInert.length >= 2 ? notInert : candidates;
    if (policy.mode === "probe-prune") {
      const live = offered.filter((c) => !blocked(c));
      if (live.length >= 1) offered = live;
    }

    // What this arm attaches to each candidate on the first ask. The
    // pruning arm sends the geometry it used to prune, so its advantage
    // is not "a shorter list" plus "a secret"; the retry arm sends
    // nothing until it escalates.
    const annotate: Annotate =
      opts.annotate ?? (policy.mode === "probe-prune" ? notableFacts : NO_NOTES);
    let answer = await ask(jev, offered, ctx, annotate);
    let fellBack = false;
    let retryConfidence: number | undefined;

    const lowConfidence = policy.minConfidence > 0 && answer.confidence < policy.minConfidence;
    if (lowConfidence && policy.mode === "random") {
      fellBack = true;
      const alt = offered[Math.floor(rnd() * offered.length)]!;
      answer = { index: alt.index, confidence: answer.confidence, undo: 0 };
    } else if (lowConfidence && policy.mode === "probe-retry") {
      fellBack = true;
      const second = await ask(jev, offered, ctx, notableFacts);
      retryConfidence = second.confidence;
      answer = second;
    }

    let chosen = offered.find((c) => c.index === answer.index) ?? offered[0]!;
    // Stand down from a pick that throws progress away, when there is
    // somewhere else to go. Same guard in every arm.
    if (answer.undo > 0.7 && offered.length > 1) {
      const alt = offered.find((c) => c.index !== chosen.index);
      if (alt) chosen = alt;
    }

    const wasBlocked = blocked(chosen);
    picks.push(chosen.description);
    const outcome = await perform(page, chosen);
    const after = await evalString(page, SIGNATURE);
    const hadEffect = before !== after;
    if (!hadEffect) {
      wasted += 1;
      inert.add(chosen.description);
    }
    seen.add(hashOf(page.url()));

    const row: StepLog = {
      step,
      hash,
      offered: offered.length,
      picked: chosen.description,
      confidence: answer.confidence,
      fellBack,
      retryConfidence,
      hadEffect,
      advanced: depthOf() > depthBefore,
      error: outcome.error,
      wasBlocked,
    };
    log.push(row);
    await afterStep?.(row);
    trace?.(
      `${hash} step=${step} n=${offered.length} pick=@${answer.confidence.toFixed(2)}` +
        `${fellBack ? `->${policy.mode}${retryConfidence !== undefined ? `@${retryConfidence.toFixed(2)}` : ""}` : ""} ` +
        `${hadEffect ? "ok " : "NOOP"} ${wasBlocked ? "[blocked] " : ""}-> ${chosen.description}` +
        `${outcome.error ? `  !! ${outcome.error.slice(0, 70)}` : ""}`,
    );

    lastAction = chosen.description;
    lastHadEffect = hadEffect;
    lastError = outcome.error;
    noEffectStreak = hadEffect ? 0 : noEffectStreak + 1;
    if (done ? done(seen) : seen.has(goalState)) break;
  }

  return { states: [...seen], picks, reachedGoal: seen.has(goalState), wastedSteps: wasted, log };
}
