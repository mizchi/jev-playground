/**
 * A per-step loop over a SPA, so the two pickers can be compared fairly.
 *
 * Why this exists rather than just `chaos({ driver })`: chaosbringer's
 * `performDriverActions(page, url, targets)` maps `targets` into candidates
 * ONCE, before the step loop. On a SPA that mutates the DOM without
 * navigating, every step after the first is choosing from a stale list — the
 * "Add to cart" button that only exists on #/products is never a candidate.
 * That applies to `weightedRandomDriver` and `aiDriver` equally; it is not a
 * Jev problem. See docs/05-browser-chaos.md.
 *
 * So this loop re-discovers candidates every step and hands the same list to
 * whichever picker is under test. Candidate extraction and action execution
 * are shared; the only difference between arms is which index gets picked.
 */
import type { Page } from "playwright";
import { Jev, choice, noul, type Question } from "../../shared/jev.js";

export interface Candidate {
  index: number;
  selector: string;
  description: string;
  type: "click" | "input";
}

/** A deterministic RNG, so the random arm is reproducible per seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Every control the page currently offers, described the way chaosbringer
 * describes them (role plus accessible name) so the picker sees the same
 * kind of text it would see through the real driver interface.
 */
/**
 * Passed to `page.evaluate` as source text on purpose: tsx compiles with
 * esbuild's `keepNames`, which injects a `__name` helper into any function it
 * transforms. That helper does not exist in the page, so a normal closure
 * fails with `__name is not defined`. A string is handed to the page as-is.
 */
const COLLECT_CANDIDATES = `(() => {
  const out = [];
  const nodes = document.querySelectorAll("a[href], button, input, textarea, select");
  let n = 0;
  for (const el of Array.from(nodes)) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    n += 1;
    const tag = el.tagName.toLowerCase();
    const isField = tag === "input" || tag === "textarea" || tag === "select";
    const id = el.id;
    const selector = id ? "#" + id : tag + ":nth-of-type(" + n + ")";
    const labelEl = id ? document.querySelector('label[for="' + id + '"]') : null;
    const name = (el.getAttribute("aria-label") || el.innerText || (labelEl ? labelEl.textContent : "")
      || el.placeholder || id || "").trim().slice(0, 60);
    const role = tag === "a" ? "link" : isField ? ((el.type || tag) + " field") : "button";
    const href = tag === "a" ? el.getAttribute("href") : null;
    out.push({
      selector: selector,
      description: role + ' "' + name + '"' + (href ? " -> " + href : ""),
      type: isField ? "input" : "click",
    });
  }
  return out;
})()`;

export async function candidates(page: Page): Promise<Candidate[]> {
  const raw = (await page.evaluate(COLLECT_CANDIDATES)) as {
    selector: string;
    description: string;
    type: "click" | "input";
  }[];
  return raw.map((r, index) => ({ ...r, index }));
}

/** Type-aware fill values, mirroring what the crawler would type. */
function fillValue(description: string): string {
  if (description.includes("email")) return "test@example.com";
  if (description.includes("address") || description.includes("Address")) return "1 Example Street";
  return "test input";
}

export async function perform(page: Page, c: Candidate): Promise<boolean> {
  try {
    const el = page.locator(c.selector).first();
    if (c.type === "input") {
      await el.fill(fillValue(c.description), { timeout: 1500 });
    } else {
      await el.click({ timeout: 1500 });
    }
    await page.waitForTimeout(60);
    return true;
  } catch {
    return false;
  }
}

/**
 * What the picker is told about the previous step. `noEffect` is the piece
 * that matters most in practice: without it a picker re-picks the control
 * that just did nothing, forever. See docs/05-browser-chaos.md.
 */
export interface StepFeedback {
  lastAction?: string;
  /** The previous action left the URL and the visible text unchanged. */
  lastActionHadNoEffect?: boolean;
  /** How many actions in a row have changed nothing. */
  consecutiveNoEffect: number;
}

export type Picker = (
  page: Page,
  cands: Candidate[],
  ctx: {
    url: string;
    step: number;
    seen: string[];
    recent: string[];
    feedback: StepFeedback;
    /** Fingerprint of the current screen; changes when anything visible does. */
    signature: string;
    /** Descriptions already tried on THIS screen that changed nothing. */
    inert: string[];
    /** What the screen currently says, including any progress indicator. */
    screenText: string;
  },
) => Promise<number>;

/**
 * A cheap fingerprint of what the user can see, used only to tell "that did
 * something" from "that did nothing".
 */
const PAGE_SIGNATURE = `(() => {
  const main = document.getElementById("view");
  const status = document.getElementById("status");
  // Field values are part of the state: typing into an input changes nothing
  // in the rendered text, and a signature that misses it marks a perfectly
  // effective action as inert.
  const fields = Array.from(document.querySelectorAll("input, textarea, select"))
    .map((el) => (el.id || "") + "=" + (el.value || ""))
    .join(",");
  return location.hash + "|" + (main ? main.innerText : "") + "|"
    + (status ? status.innerText : "") + "|" + fields;
})()`;

/** The visible copy of the current screen, for the picker's state. */
const SCREEN_TEXT = `(() => {
  const main = document.getElementById("view");
  const status = document.getElementById("status");
  const fields = Array.from(document.querySelectorAll("input, textarea, select"))
    .map((el) => (el.id || "field") + ": " + (el.value ? '"' + el.value + '"' : "(empty)"))
    .join("; ");
  return ((main ? main.innerText : "") + "\n" + (status ? status.innerText : "")
    + (fields ? "\nfields -> " + fields : "")).trim().slice(0, 900);
})()`;

async function screenText(page: Page): Promise<string> {
  try {
    return (await page.evaluate(SCREEN_TEXT)) as string;
  } catch {
    return "";
  }
}

async function signature(page: Page): Promise<string> {
  try {
    return (await page.evaluate(PAGE_SIGNATURE)) as string;
  } catch {
    return "";
  }
}

/** The baseline: uniformly random over the live candidate list. */
export function randomPicker(seed: number): Picker {
  const rnd = mulberry32(seed);
  return async (_page, cands) => Math.floor(rnd() * cands.length);
}

/**
 * The Jev picker. One request per step carrying the live candidate list, the
 * states seen so far and the goal; three questions, since the state is only
 * sent once.
 */
export function jevPicker(jev: Jev, goal: string, trace?: (s: string) => void): Picker {
  return async (_page, cands, ctx) => {
    // Candidates that already did nothing on this exact screen are removed
    // rather than mentioned. Telling the model "that did nothing" still left
    // it re-picking the same control at low confidence; taking the option
    // away is both cheaper and reliable. Keep at least two so a screen whose
    // controls are all inert can still be left.
    const inert = new Set(ctx.inert);
    const live = cands.filter((c) => !inert.has(c.description));
    const offered = live.length >= 2 ? live : cands;
    const criteria: Record<string, string> = {};
    for (const c of offered) criteria[String(c.index)] = c.description;
    const questions: Record<string, Question> = {
      pick: {
        type: "choice",
        instructions:
          "Which control moves furthest toward the goal? Prefer opening a state not in states_seen, and prefer advancing a multi-step flow over restarting it. If the last action changed nothing, the step is gated on something you have not done yet - fill a required field on this screen instead of pressing the same button again.",
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
      goal,
      current_url: ctx.url,
      // What the screen says. Without this the picker cannot tell whether a
      // gated "Continue" will now work, so it wanders past the right control.
      screen: ctx.screenText,
      step: ctx.step,
      states_seen: ctx.seen,
      recent_actions: ctx.recent.slice(-6),
      last_action: ctx.feedback.lastAction,
      // Without this the picker happily re-picks a control that does
      // nothing: a gated "Continue" button looks right every time.
      last_action_changed_the_page: ctx.feedback.lastActionHadNoEffect === undefined
        ? undefined
        : !ctx.feedback.lastActionHadNoEffect,
      actions_with_no_effect_in_a_row: ctx.feedback.consecutiveNoEffect,
      candidates: offered.map((c) => ({ index: c.index, description: c.description })),
      controls_already_tried_here_with_no_effect: ctx.inert,
    };
    const res = await jev.ask(state, questions);
    const picked = choice(res.answers.pick);
    const index = Number.parseInt(picked.choice, 10);
    const undoP = noul(res.answers.undo);
    trace?.(
      `${ctx.url.replace(/^https?:\/\/[^/]+\//, "/")} step=${ctx.step} n=${cands.length} ` +
        `pick=${picked.choice}@${picked.confidence.toFixed(2)} undo=${undoP.toFixed(2)} ` +
        `dead=${noul(res.answers.dead_end).toFixed(2)} -> ${criteria[picked.choice] ?? "?"}`,
    );
    if (!Number.isInteger(index) || !offered.some((c) => c.index === index)) {
      return offered[0].index;
    }
    // Stand down from a pick that throws progress away, when there is
    // somewhere else to go.
    if (undoP > 0.7 && offered.length > 1) {
      const alt = offered.find((c) => c.index !== index);
      if (alt) return alt.index;
    }
    return index;
  };
}

export interface RunResult {
  states: string[];
  picks: string[];
  reachedGoal: boolean;
  /** Steps that changed neither the URL nor the visible text. */
  wastedSteps: number;
}

export async function runSteps(
  page: Page,
  baseUrl: string,
  steps: number,
  pick: Picker,
  goalState: string,
): Promise<RunResult> {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const seen = new Set<string>();
  const picks: string[] = [];
  const hashOf = (u: string) => (u.includes("#") ? u.slice(u.indexOf("#")) : "#/home");
  seen.add(hashOf(page.url()));
  const feedback: StepFeedback = { consecutiveNoEffect: 0 };
  let wasted = 0;
  // Per-screen memory of controls that changed nothing, cleared whenever the
  // screen itself changes.
  let inertFor = "";
  let inert = new Set<string>();
  for (let step = 0; step < steps; step += 1) {
    const cands = await candidates(page);
    if (cands.length === 0) break;
    const url = page.url();
    const before = await signature(page);
    if (before !== inertFor) {
      inertFor = before;
      inert = new Set<string>();
    }
    const index = await pick(page, cands, {
      url,
      step,
      seen: [...seen],
      recent: picks,
      feedback: { ...feedback },
      signature: before,
      inert: [...inert],
      screenText: await screenText(page),
    });
    const chosen = cands.find((c) => c.index === index) ?? cands[0];
    picks.push(chosen.description);
    await perform(page, chosen);
    const after = await signature(page);
    const noEffect = before === after;
    if (noEffect) {
      wasted += 1;
      inert.add(chosen.description);
    }
    feedback.lastAction = chosen.description;
    feedback.lastActionHadNoEffect = noEffect;
    feedback.consecutiveNoEffect = noEffect ? feedback.consecutiveNoEffect + 1 : 0;
    seen.add(hashOf(page.url()));
  }
  return {
    states: [...seen],
    picks,
    reachedGoal: seen.has(goalState),
    wastedSteps: wasted,
  };
}
