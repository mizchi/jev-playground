/**
 * Speculative fan-out: is a target chosen without knowing the operation
 * as good as one chosen after it?
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/run-fanout.ts [--steps 14] [--seeds 3] [--verbose]
 *
 * The mechanism is browser-use/jev-ultrafast's: split the action space
 * into one target head per operation, and ask the operation head and
 * every target head in the SAME request. Read only the head the chosen
 * operation names; throw the rest away. Two decisions, one round trip.
 *
 * Three arms, on `?select=1` — a checkout whose last step is gated on a
 * dropdown, so SELECT is load-bearing and skipping it cannot reach the
 * goal:
 *
 *   flat        one `pick` over every candidate, operation implied by the
 *               element's type. What this repo does today. On a dropdown
 *               it names the element and leaves the option to the caller.
 *   fanout      `operation` + every `<op>_target`, one request. The
 *               target heads answer speculatively: they are told "assume
 *               the operation is X", not which one won.
 *   sequential  the same two decisions in two requests, the second one
 *               knowing the first. Costs a round trip, buys a target
 *               chosen under a decided operation.
 *
 * `sequential` is the arm that makes this an experiment rather than a
 * demo. `fanout` is only worth having if it matches `sequential`'s
 * decisions at `flat`'s round-trip count; if it is worse, the round trip
 * was paid for with accuracy, which no README states either way.
 *
 * Reported per arm: goal reached, steps to the goal, wasted steps (the
 * action changed nothing), requests, and tokens. Plus the number that
 * only the typed arms can move — how often the dropdown was set to the
 * value the goal asked for rather than whatever came first.
 */
import { chromium, type Page } from "playwright";
import { Jev } from "../../shared/jev.js";
import { decide, defaultOption, type Decision, type FanoutState, type OptionMemo, type Strategy } from "./fanout.js";
import { fillValue } from "./confidence-bench.js";
import { probe, type ProbedCandidate } from "./probes.js";
// @ts-expect-error - plain .mjs helper, shared with the other runners.
import { serve } from "./serve.mjs";

const STRATEGIES: Strategy[] = ["flat", "flat-memo", "fanout", "sequential"];

/**
 * Express, not standard — named in the goal so a SELECT target can be
 * graded. "Set the dropdown" is satisfied by either option; "choose
 * express" is satisfied by one, which is what makes the option-level
 * target measurable rather than decorative.
 */
const WANTED_SHIPPING = "express";

const GOAL =
  "Buy the Widget and complete the checkout to the order confirmation. " +
  "Choose express shipping — next-day — when a shipping method is offered.";

const GOAL_STATE = "#/confirm";

const SCREEN_TEXT = `(() => {
  const body = (document.body.innerText || "").trim().replace(/\\n{3,}/g, "\\n\\n");
  const fields = Array.from(document.querySelectorAll("input, textarea, select"))
    .map((el) => (el.id || "field") + ": " + (el.value ? '"' + el.value + '"' : "(empty)"))
    .join("; ");
  return (body + (fields ? "\\nfields -> " + fields : "")).slice(0, 1200);
})()`;

/** Same fingerprint as the other runners: anything a user could notice. */
const SIGNATURE = `(() => {
  const fields = Array.from(document.querySelectorAll("input, textarea, select"))
    .map((el) => (el.id || "") + "=" + (el.value || "")).join(",");
  return location.hash + "|" + (document.getElementById("view") || {}).innerHTML + "|" + fields;
})()`;

async function evalString(page: Page, source: string): Promise<string> {
  return (await page.evaluate(source)) as string;
}

export interface ArmResult {
  strategy: Strategy;
  seed: number;
  reachedGoal: boolean;
  /** Steps taken, whether or not the goal was reached. */
  steps: number;
  /** Actions that changed nothing on screen. */
  wasted: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  /** The value the dropdown ended on, if it was ever set. */
  shipping?: string;
  /** Operation the arm chose, per step, for the trace. */
  operations: string[];
  /** Stopped because the arm said DONE or BLOCKED. */
  stoppedBy?: "DONE" | "BLOCKED";
  /** A validateChoice rejection, which is a result and not a crash. */
  invalid: number;
}

async function runArm(
  strategy: Strategy,
  page: Page,
  baseUrl: string,
  steps: number,
  jev: Jev,
  trace?: (line: string) => void,
): Promise<ArmResult> {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  // A fresh arm must not inherit the previous arm's progress.
  await page.evaluate(() => {
    try {
      sessionStorage.clear();
    } catch {}
  });
  await page.reload({ waitUntil: "domcontentloaded" });

  const startIn = jev.inputTokens;
  const startOut = jev.outputTokens;
  const startMs = jev.totalMs;

  const hashOf = (u: string) => (u.includes("#") ? u.slice(u.indexOf("#")) : "#/home");
  const seen = new Set<string>([hashOf(page.url())]);
  const recent: string[] = [];
  const operations: string[] = [];
  let wasted = 0;
  let requests = 0;
  let invalid = 0;
  let taken = 0;
  let stoppedBy: "DONE" | "BLOCKED" | undefined;
  let lastAction: string | undefined;
  let lastHadEffect: boolean | undefined;
  let lastError: string | undefined;
  let noEffectStreak = 0;
  let inertFor = "";
  let inert = new Set<string>();
  // One memory per run, not per step: the point of `flat-memo` is that it
  // remembers across steps which options it has already set.
  const memo: OptionMemo = new Map();

  for (let step = 0; step < steps; step += 1) {
    const { candidates } = await probe(page);
    if (candidates.length === 0) break;
    const before = await evalString(page, SIGNATURE);
    if (before !== inertFor) {
      inertFor = before;
      inert = new Set<string>();
    }

    const state: FanoutState = {
      goal: GOAL,
      current_url: hashOf(page.url()),
      screen: await evalString(page, SCREEN_TEXT),
      step,
      states_seen: [...seen],
      recent_actions: recent.slice(-6),
      last_action: lastAction,
      last_action_changed_the_page: lastHadEffect,
      last_action_error: lastError,
      actions_with_no_effect_in_a_row: noEffectStreak,
      controls_already_tried_here_with_no_effect: [...inert],
    };

    // Every arm gets the same candidate list. Only the shape of the
    // question differs, which is the whole comparison.
    let decision: Decision;
    try {
      decision = await decide(strategy, jev, candidates, state, memo);
    } catch (err) {
      // A rejected answer is a measurement, not a crash: it means the
      // arm produced something that could not be executed. Count it and
      // stop, rather than retrying into a different arm's step budget.
      invalid += 1;
      trace?.(`  step=${step} INVALID ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
    requests += decision.requests;
    taken = step + 1;
    operations.push(decision.operation);

    if (decision.operation === "DONE" || decision.operation === "BLOCKED") {
      stoppedBy = decision.operation;
      trace?.(`  step=${step} ${decision.operation} @${decision.confidence.toFixed(2)}`);
      break;
    }

    const entry = decision.entry!;
    const c: ProbedCandidate = entry.option !== undefined
      ? { ...entry.candidate, chosenOption: entry.option }
      : entry.candidate;
    const outcome = await act(page, c);
    const after = await evalString(page, SIGNATURE);
    const hadEffect = before !== after;
    if (!hadEffect) {
      wasted += 1;
      inert.add(c.description);
    }
    seen.add(hashOf(page.url()));
    recent.push(`${decision.operation} ${c.description}${entry.option ? ` = ${entry.option}` : ""}`);

    trace?.(
      `  step=${step} ${decision.operation}@${decision.confidence.toFixed(2)}` +
        `${decision.targetConfidence !== undefined ? `/t${decision.targetConfidence.toFixed(2)}` : ""} ` +
        `${hadEffect ? "ok  " : "NOOP"} ${c.description}${entry.option ? ` = ${entry.option}` : ""}` +
        `${outcome.error ? `  !! ${outcome.error.slice(0, 60)}` : ""}`,
    );

    lastAction = c.description;
    lastHadEffect = hadEffect;
    lastError = outcome.error;
    noEffectStreak = hadEffect ? 0 : noEffectStreak + 1;
    if (seen.has(GOAL_STATE)) break;
  }

  const shipping = await page.evaluate(() => {
    try {
      return JSON.parse(sessionStorage.getItem("chaos-target-progress") || "{}").shipping || undefined;
    } catch {
      return undefined;
    }
  });

  return {
    strategy,
    seed: 0,
    reachedGoal: seen.has(GOAL_STATE),
    steps: taken,
    wasted,
    requests,
    inputTokens: jev.inputTokens - startIn,
    outputTokens: jev.outputTokens - startOut,
    ms: jev.totalMs - startMs,
    shipping: shipping as string | undefined,
    operations,
    stoppedBy,
    invalid,
  };
}

async function act(page: Page, c: ProbedCandidate): Promise<{ ok: boolean; error?: string }> {
  try {
    const el = page.locator(c.selector).first();
    if (c.type === "select") {
      const value = c.chosenOption ?? defaultOption(c);
      if (value === undefined) return { ok: false, error: "no selectable option" };
      await el.selectOption(value, { timeout: 1500 });
    } else if (c.type === "input") {
      await el.fill(fillValue(c.description), { timeout: 1500 });
    } else {
      await el.click({ timeout: 1500 });
    }
    await page.waitForTimeout(60);
    return { ok: true };
  } catch (err) {
    const raw = (err instanceof Error ? err.message : String(err)).replace(
      new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, "g"),
      "",
    );
    return { ok: false, error: raw.split("\n")[0]?.replace(/^locator\.\w+: /, "") ?? raw };
  }
}

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const n = Number.parseInt(process.argv[i + 1] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

async function main(): Promise<void> {
  const steps = arg("steps", 14);
  const seeds = arg("seeds", 3);
  const verbose = process.argv.includes("--verbose");
  const jev = new Jev();
  const srv = await serve();
  // `--select many` puts six options on the dropdown instead of two, which
  // is where the flat arm's option-walk stops being a one-step tax.
  const mode = flag("select", "1");
  const base = `${typeof srv === "string" ? srv : srv.url}?select=${mode}`;
  const browser = await chromium.launch();
  const rows: ArmResult[] = [];

  try {
    for (let seed = 0; seed < seeds; seed += 1) {
      for (const strategy of STRATEGIES) {
        // A fresh context per arm: sessionStorage is the app's progress,
        // and an arm that inherited it would start mid-checkout.
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        if (verbose) console.log(`\n${strategy} seed=${seed}`);
        const res = await runArm(strategy, page, base, steps, jev, verbose ? (l) => console.log(l) : undefined);
        rows.push({ ...res, seed });
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\nselect=${mode}, ${steps} step budget, ${seeds} run(s) per arm`);
  console.log("\narm          runs  goal  steps  wasted  reqs  in_tok  out_tok    ms  express");
  for (const strategy of STRATEGIES) {
    const mine = rows.filter((r) => r.strategy === strategy);
    const n = mine.length;
    const goal = mine.filter((r) => r.reachedGoal).length;
    const express = mine.filter((r) => r.shipping === WANTED_SHIPPING).length;
    const avg = (f: (r: ArmResult) => number) => (mine.reduce((a, r) => a + f(r), 0) / n).toFixed(1);
    console.log(
      `${strategy.padEnd(12)} ${String(n).padStart(4)}  ${String(goal).padStart(4)}  ` +
        `${avg((r) => r.steps).padStart(5)}  ${avg((r) => r.wasted).padStart(6)}  ` +
        `${avg((r) => r.requests).padStart(4)}  ${avg((r) => r.inputTokens).padStart(6)}  ` +
        `${avg((r) => r.outputTokens).padStart(7)}  ${avg((r) => r.ms).padStart(4)}  ` +
        `${String(express).padStart(7)}`,
    );
  }

  const invalid = rows.filter((r) => r.invalid > 0);
  if (invalid.length > 0) {
    console.log(`\nrejected answers: ${invalid.map((r) => `${r.strategy}/seed${r.seed}`).join(", ")}`);
  }
  const stopped = rows.filter((r) => r.stoppedBy);
  if (stopped.length > 0) {
    console.log(`stopped early: ${stopped.map((r) => `${r.strategy}/seed${r.seed}=${r.stoppedBy}`).join(", ")}`);
  }
  console.log(`\ntotal: ${jev.calls} calls, ${jev.inputTokens} in, ${jev.outputTokens} out`);
  console.log(JSON.stringify(rows));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
