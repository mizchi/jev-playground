/**
 * Do the accumulated techniques compose, or do they subsume each other?
 *
 *   TYPESAFEAI_API_KEY=… npx tsx src/run-ablation.ts [--runs 2] [--steps 16] [--verbose]
 *
 * docs/25, 26 and 29 each measured one technique against a bare baseline
 * and each found a win. None of them was ever measured *next to* another,
 * so three separate "+N" results have been sitting in the docs with no
 * evidence that they add up — and a real reason to think they might not.
 * Geometry pruning removes the candidates a click cannot reach; the typed
 * action space removes the targets an operation cannot execute. Both are
 * "shrink the choice in code rather than argue with the model", so the
 * second one may have nothing left to remove.
 *
 * Board: `?overlay=1&select=many`, which needs both at once. The overlay
 * is a transparent full-screen backdrop left behind by a styled-away tip
 * card, so every control reads fine and every click lands on the
 * backdrop. The dropdown has six options and the goal names one, so an
 * element-only target has to walk them.
 *
 * Leave-one-out from the full stack rather than one-at-a-time onto the
 * baseline: what a technique is worth is what breaks when it is the only
 * thing missing, which is not the same number as what it adds alone.
 *
 *   all        typed action space + fan-out, geometry pruned, geometry
 *              attached to the candidates that survive
 *   -typed     flat `pick` over every candidate instead
 *   -prune     geometry still attached, but nothing removed — isolates
 *              "tell the model" from "do not offer it"
 *   -geometry  neither pruned nor attached
 *   none       flat and blind: the docs/05 shape
 */
import { chromium, type Page } from "playwright";
import { Jev } from "../../shared/jev.js";
import { blocked, fillValue } from "./confidence-bench.js";
import { decide, defaultOption, type FanoutState, type OptionMemo } from "./fanout.js";
import { notableFacts, probe, type ProbedCandidate } from "./probes.js";
// @ts-expect-error - plain .mjs helper, shared with the other runners.
import { serve } from "./serve.mjs";

interface Arm {
  name: string;
  /** Typed action space + speculative fan-out, or the flat picker. */
  typed: boolean;
  /** Drop candidates the geometry says a click cannot reach. */
  prune: boolean;
  /** Attach the geometry to the candidates that are offered. */
  tell: boolean;
  /**
   * Offer only what is on screen. docs/30 §6.4's recommendation, which
   * the offline recall sweep could only test against a scripted correct
   * action — this is whether a driver restricted that way still arrives.
   */
  viewport?: boolean;
}

const ABLATION: Arm[] = [
  { name: "all", typed: true, prune: true, tell: true },
  { name: "-typed", typed: false, prune: true, tell: true },
  { name: "-prune", typed: true, prune: false, tell: true },
  { name: "-geometry", typed: true, prune: false, tell: false },
  { name: "none", typed: false, prune: false, tell: false },
];

/** `--wide`: does the §6.4 recommendation survive a real driver? */
const WIDE_ARMS: Arm[] = [
  { name: "everything", typed: true, prune: true, tell: true },
  { name: "viewport", typed: true, prune: true, tell: true, viewport: true },
];

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

const SIGNATURE = `(() => {
  const fields = Array.from(document.querySelectorAll("input, textarea, select"))
    .map((el) => (el.id || "") + "=" + (el.value || "")).join(",");
  const overlay = Array.from(document.querySelectorAll("*"))
    .filter((el) => { const cs = getComputedStyle(el); return cs.position === "fixed" && !el.hidden; })
    .length;
  return location.hash + "|" + (document.body.innerText || "") + "|" + fields + "|" + overlay;
})()`;

async function evalString(page: Page, source: string): Promise<string> {
  try {
    return (await page.evaluate(source)) as string;
  } catch {
    return "";
  }
}

interface ArmResult {
  arm: string;
  run: number;
  reachedGoal: boolean;
  steps: number;
  /** Actions that changed nothing on screen. */
  wasted: number;
  /** Steps whose chosen candidate the geometry said was unreachable. */
  blockedPicks: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  shipping?: string;
  /** A rejected answer, which is a result rather than a crash. */
  invalid: number;
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

async function runArm(
  arm: Arm,
  page: Page,
  baseUrl: string,
  steps: number,
  jev: Jev,
  trace?: (line: string) => void,
): Promise<Omit<ArmResult, "run">> {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
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
  const memo: OptionMemo = new Map();
  let wasted = 0;
  let blockedPicks = 0;
  let requests = 0;
  let invalid = 0;
  let taken = 0;
  let lastAction: string | undefined;
  let lastHadEffect: boolean | undefined;
  let lastError: string | undefined;
  let noEffectStreak = 0;
  let inertFor = "";
  let inert = new Set<string>();

  for (let step = 0; step < steps; step += 1) {
    const { candidates } = await probe(page);
    if (candidates.length === 0) break;
    const before = await evalString(page, SIGNATURE);
    if (before !== inertFor) {
      inertFor = before;
      inert = new Set<string>();
    }

    // What this arm is willing to offer. Never narrowed to nothing: a
    // screen whose every control is blocked still has to be leavable.
    const notInert = candidates.filter((c) => !inert.has(c.description));
    let offered = notInert.length >= 2 ? notInert : candidates;
    if (arm.viewport) {
      // Spatial, not lexical. Never narrowed to nothing: a screen with
      // nothing on it still has to be leavable.
      const onScreen = offered.filter((c) => c.facts.inViewport);
      if (onScreen.length >= 1) offered = onScreen;
    }
    if (arm.prune) {
      const live = offered.filter((c) => !blocked(c));
      if (live.length >= 1) offered = live;
    }

    // The geometry, as a note on the candidate it bears on. Attached only
    // to what is offered, so `-prune` and `all` differ by what was
    // removed and not by what was said about it.
    const shown: ProbedCandidate[] = arm.tell
      ? offered.map((c) => {
          const note = notableFacts(c);
          return note ? { ...c, description: `${c.description}  [${note}]` } : c;
        })
      : offered;

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

    let decision;
    try {
      decision = await decide(arm.typed ? "fanout" : "flat-memo", jev, shown, state, memo);
    } catch (err) {
      invalid += 1;
      trace?.(`  step=${step} INVALID ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
    requests += decision.requests;
    taken = step + 1;

    if (decision.operation === "DONE" || decision.operation === "BLOCKED") {
      trace?.(`  step=${step} ${decision.operation}@${decision.confidence.toFixed(2)}`);
      break;
    }

    // The note was only ever for the prompt; act on the real candidate.
    const entry = decision.entry!;
    const real = offered.find((c) => c.index === entry.candidate.index) ?? entry.candidate;
    const target: ProbedCandidate = entry.option !== undefined
      ? { ...real, chosenOption: entry.option }
      : real;
    if (blocked(real)) blockedPicks += 1;

    const outcome = await act(page, target);
    const after = await evalString(page, SIGNATURE);
    const hadEffect = before !== after;
    if (!hadEffect) {
      wasted += 1;
      inert.add(real.description);
    }
    seen.add(hashOf(page.url()));
    recent.push(`${decision.operation} ${real.description}${entry.option ? ` = ${entry.option}` : ""}`);

    trace?.(
      `  step=${step} ${decision.operation}@${decision.confidence.toFixed(2)} n=${offered.length} ` +
        `${hadEffect ? "ok  " : "NOOP"} ${blocked(real) ? "[blocked] " : ""}` +
        `${real.description}${entry.option ? ` = ${entry.option}` : ""}` +
        `${outcome.error ? `  !! ${outcome.error.slice(0, 55)}` : ""}`,
    );

    lastAction = real.description;
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
    arm: arm.name,
    reachedGoal: seen.has(GOAL_STATE),
    steps: taken,
    wasted,
    blockedPicks,
    requests,
    inputTokens: jev.inputTokens - startIn,
    outputTokens: jev.outputTokens - startOut,
    ms: jev.totalMs - startMs,
    shipping: shipping as string | undefined,
    invalid,
  };
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const n = Number.parseInt(process.argv[i + 1] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

async function main(): Promise<void> {
  const runs = arg("runs", 2);
  const steps = arg("steps", 16);
  const verbose = process.argv.includes("--verbose");
  const jev = new Jev();
  const srv = await serve();
  // `--wide` swaps the board and the arms: docs/30 §3 is the overlay
  // ablation, §6.4 is the retrieval question, and they need different
  // pages to be about anything.
  const wide = process.argv.includes("--wide");
  const arms = wide ? WIDE_ARMS : ABLATION;
  const query = wide ? "select=many&wide=200" : "overlay=1&select=many";
  const base = `${typeof srv === "string" ? srv : srv.url}?${query}`;
  const browser = await chromium.launch();
  const rows: ArmResult[] = [];

  try {
    for (let run = 0; run < runs; run += 1) {
      for (const arm of arms) {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        if (verbose) console.log(`\n${arm.name} run=${run}`);
        const out = await runArm(arm, page, base, steps, jev, verbose ? (l) => console.log(l) : undefined);
        rows.push({ ...out, run });
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${query}, ${steps} step budget, ${runs} run(s) per arm`);
  console.log("\narm         goal  steps  wasted  blocked  reqs  in_tok  out_tok    ms  express");
  for (const arm of arms) {
    const mine = rows.filter((r) => r.arm === arm.name);
    const n = mine.length;
    const avg = (f: (r: ArmResult) => number) => (mine.reduce((a, r) => a + f(r), 0) / n).toFixed(1);
    console.log(
      `${arm.name.padEnd(11)} ${String(mine.filter((r) => r.reachedGoal).length)}/${n}  ` +
        `${avg((r) => r.steps).padStart(5)}  ${avg((r) => r.wasted).padStart(6)}  ` +
        `${avg((r) => r.blockedPicks).padStart(7)}  ${avg((r) => r.requests).padStart(4)}  ` +
        `${avg((r) => r.inputTokens).padStart(6)}  ${avg((r) => r.outputTokens).padStart(7)}  ` +
        `${avg((r) => r.ms).padStart(4)}  ` +
        `${String(mine.filter((r) => r.shipping === "express").length)}/${n}`,
    );
  }

  const invalid = rows.filter((r) => r.invalid > 0);
  if (invalid.length > 0) {
    console.log(`\nrejected answers: ${invalid.map((r) => `${r.arm}/run${r.run}`).join(", ")}`);
  }
  console.log(`\ntotal: ${jev.calls} calls, ${jev.inputTokens} in, ${jev.outputTokens} out`);
  console.log(JSON.stringify(rows));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
