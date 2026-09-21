/**
 * Do the accumulated techniques compose, or do they subsume each other?
 *
 *   TYPESAFEAI_API_KEY=… npx tsx src/run-ablation.ts [--runs 2] [--steps 16] [--verbose]
 *
 * docs/57, 26 and 29 each measured one technique against a bare baseline
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
import { decide, defaultOption, isScroll, ScrollSweep, type FanoutState, type OptionMemo } from "./fanout.js";
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
   * Offer only what is on screen. docs/62 §6.4's recommendation, which
   * the offline recall sweep could only test against a scripted correct
   * action — this is whether a driver restricted that way still arrives.
   */
  viewport?: boolean;
  /**
   * Offer SCROLL_DOWN / SCROLL_UP when there is something off screen.
   * Only meaningful with `viewport`: without narrowing there is nothing
   * the scrolls could reveal, and the flat picker has no operation head
   * to put them in.
   */
  scroll?: boolean;
  /**
   * Offer CLEAR. Without it "this field must end up empty" cannot be
   * expressed at all, because `fillValue` derives a non-empty string from
   * the description every time — see docs/62 §6.7.
   */
  clear?: boolean;
}

const ABLATION: Arm[] = [
  { name: "all", typed: true, prune: true, tell: true },
  { name: "-typed", typed: false, prune: true, tell: true },
  { name: "-prune", typed: true, prune: false, tell: true },
  { name: "-geometry", typed: true, prune: false, tell: false },
  { name: "none", typed: false, prune: false, tell: false },
];

/** `--clear`: is an explicit CLEAR the only way to empty a field? */
const CLEAR_ARMS: Arm[] = [
  { name: "no-clear", typed: true, prune: true, tell: true },
  { name: "clear", typed: true, prune: true, tell: true, clear: true },
];

/** `--wide`: does the §6.4 recommendation survive a real driver? */
const WIDE_ARMS: Arm[] = [
  { name: "everything", typed: true, prune: true, tell: true },
  { name: "viewport", typed: true, prune: true, tell: true, viewport: true },
  { name: "viewport+scroll", typed: true, prune: true, tell: true, viewport: true, scroll: true },
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
  /** Steps spent moving the view rather than acting. */
  scrolls: number;
  /**
   * Every step's confidence, so narrowing can be checked against the
   * threshold side and not only against goal/steps/tokens.
   *
   * docs/59 §4.10 measured that offering fewer candidates than the page
   * describes costs confidence, which is exactly what `viewport` does —
   * and docs/57 and §3.2 both route on confidence, so "accuracy
   * unchanged" does not settle it. §6.4's original table had no such
   * column, which is why the side effect went unnoticed.
   */
  confidences: number[];
  /** What the discount field ended on. `""` is the goal under ?clear=1. */
  discount: string;
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
  const sweep = new ScrollSweep();
  let wasted = 0;
  let blockedPicks = 0;
  let scrolls = 0;
  let requests = 0;
  let invalid = 0;
  let taken = 0;
  const confidences: number[] = [];
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
    // What the viewport narrowing is giving up, measured before it does.
    // A candidate off screen is above or below depending on its box top,
    // which `inViewport` alone cannot say.
    const below = offered.filter((c) => !c.facts.inViewport && c.facts.viewportTop >= 0).length;
    const above = offered.filter((c) => !c.facts.inViewport && c.facts.viewportTop < 0).length;
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

    if (arm.scroll) {
      const pos = (await page.evaluate(
        "JSON.stringify([Math.round(scrollY), Math.round(document.documentElement.scrollHeight - innerHeight - scrollY)])",
      )) as string;
      const [scrollY, remaining] = JSON.parse(pos) as [number, number];
      // The screen key is the route plus its rendered HTML, so a
      // re-render on the same route restarts the sweep — the page may
      // have grown or shrunk under it.
      sweep.observe(before, scrollY, remaining > 4);
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
      // Only told to an arm that is actually hiding things. Without this
      // a SCROLL_DOWN in the operation list is a guess: a narrowed
      // candidate list looks complete from the inside.
      ...(arm.scroll ? { controls_below_the_view: below } : {}),
    };

    let decision;
    try {
      decision = await decide(
        arm.typed ? "fanout" : "flat-memo",
        jev,
        // The no-clear arm must not see the CLEAR head at all. Presenting
        // it and refusing to execute would measure something else.
        arm.clear ? shown : shown.map((c) => (c.type === "input" ? { ...c, currentValue: "" } : c)),
        state,
        memo,
        // One direction only, and only while there is unswept page. See
        // `ScrollSweep` for why offering both oscillates.
        arm.scroll ? { canScrollDown: sweep.canScrollDown && below > 0 } : undefined,
      );
    } catch (err) {
      invalid += 1;
      trace?.(`  step=${step} INVALID ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
    requests += decision.requests;
    taken = step + 1;
    // Recorded before the DONE/BLOCKED break, so a terminal decision
    // counts: it is a decision the driver made on the offered set.
    confidences.push(decision.confidence);

    if (decision.operation === "DONE" || decision.operation === "BLOCKED") {
      trace?.(`  step=${step} ${decision.operation}@${decision.confidence.toFixed(2)}`);
      break;
    }

    if (decision.operation === "CLEAR") {
      const entry = decision.entry!;
      const real = offered.find((c) => c.index === entry.candidate.index) ?? entry.candidate;
      const el = page.locator(real.selector).first();
      try {
        await el.fill("", { timeout: 1500 });
        await el.dispatchEvent("change");
      } catch {}
      await page.waitForTimeout(60);
      const after = await evalString(page, SIGNATURE);
      const had = after !== before;
      if (!had) {
        wasted += 1;
        inert.add(real.description);
      }
      recent.push(`CLEAR ${real.description}`);
      lastAction = `CLEAR ${real.description}`;
      lastHadEffect = had;
      lastError = undefined;
      noEffectStreak = had ? 0 : noEffectStreak + 1;
      trace?.(`  step=${step} CLEAR@${decision.confidence.toFixed(2)} ${had ? "ok  " : "NOOP"} ${real.description}`);
      continue;
    }

    if (isScroll(decision.operation)) {
      // One viewport, less a little overlap, so a control straddling the
      // fold is not skipped over. A scroll is a real step: it costs a
      // request and a budget slot like anything else.
      const dir = decision.operation === "SCROLL_DOWN" ? 1 : -1;
      await page.evaluate(
        `window.scrollBy(0, ${dir} * Math.round(window.innerHeight * 0.8))`,
      );
      await page.waitForTimeout(60);
      scrolls += 1;
      const after = await evalString(page, SIGNATURE);
      // Scrolling does not change the page, only the view, so the
      // no-op detector must not count it as a wasted step.
      recent.push(decision.operation);
      lastAction = decision.operation;
      lastHadEffect = true;
      lastError = undefined;
      trace?.(
        `  step=${step} ${decision.operation}@${decision.confidence.toFixed(2)} ` +
          `n=${offered.length} below=${below} above=${above}` +
          `${after === before ? "" : "  (page also changed)"}`,
      );
      continue;
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

  const discount = await page.evaluate(() => {
    try {
      return JSON.parse(sessionStorage.getItem("chaos-target-progress") || "{}").discount ?? "";
    } catch {
      return "";
    }
  });
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
    discount: discount as string,
    invalid,
    scrolls,
    confidences,
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
  // `--wide` swaps the board and the arms: docs/62 §3 is the overlay
  // ablation, §6.4 is the retrieval question, and they need different
  // pages to be about anything.
  const wide = process.argv.includes("--wide");
  // `--before` prepends the filler so the flow sits below the fold. That
  // is the only arrangement where viewport narrowing has to give
  // something up, and therefore the only one where SCROLL is testable.
  const before = process.argv.includes("--before");
  const clearMode = process.argv.includes("--clear");
  const arms = clearMode ? CLEAR_ARMS : wide ? WIDE_ARMS : ABLATION;
  const query = clearMode
    ? "select=many&clear=1"
    : wide
      ? `select=many&wide=200${before ? "&fillerpos=before" : ""}`
      : "overlay=1&select=many";
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

  const meanOf = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const minOf = (xs: number[]) => (xs.length ? Math.min(...xs) : 0);

  console.log(`\n${query}, ${steps} step budget, ${runs} run(s) per arm`);
  console.log("\narm              goal  steps  scroll  wasted  blocked  reqs  in_tok  out_tok    ms  conf  min  express");
  for (const arm of arms) {
    const mine = rows.filter((r) => r.arm === arm.name);
    const n = mine.length;
    const avg = (f: (r: ArmResult) => number) => (mine.reduce((a, r) => a + f(r), 0) / n).toFixed(1);
    console.log(
      `${arm.name.padEnd(16)} ${String(mine.filter((r) => r.reachedGoal).length)}/${n}  ` +
        `${avg((r) => r.steps).padStart(5)}  ${avg((r) => r.scrolls).padStart(6)}  ` +
        `${avg((r) => r.wasted).padStart(6)}  ` +
        `${avg((r) => r.blockedPicks).padStart(7)}  ${avg((r) => r.requests).padStart(4)}  ` +
        `${avg((r) => r.inputTokens).padStart(6)}  ${avg((r) => r.outputTokens).padStart(7)}  ` +
        `${avg((r) => r.ms).padStart(4)}  ` +
        // Mean over every decision in the arm, and the single lowest,
        // because a routing threshold cares about the tail.
        `${meanOf(mine.flatMap((r) => r.confidences)).toFixed(2).padStart(4)}  ` +
        `${minOf(mine.flatMap((r) => r.confidences)).toFixed(2).padStart(3)}  ` +
        `${String(mine.filter((r) => r.shipping === "express").length)}/${n}` +
        (clearMode ? `  discount=${[...new Set(mine.map((r) => r.discount || "(empty)"))].join("/")}` : ""),
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
