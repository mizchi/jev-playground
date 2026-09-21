/**
 * What is an action cache actually worth?
 *
 *   TYPESAFEAI_API_KEY=… npx tsx src/run-cache.ts [--runs 1] [--steps 16] [--verbose]
 *
 * stagehand caches the observe→action mapping keyed on state, with a
 * threshold before a key is served and a `replay_failed` miss for a hit
 * that could not be applied. docs/62 §1 listed it as the last untried
 * transfer candidate.
 *
 * The hypothesis to beat is deflationary, and it should be stated first
 * so the result cannot be dressed up. docs/61 found Jev's decisions
 * stable across runs — same picks, same token counts, on identical
 * prompts. So on a deterministic board an exact-key cache **cannot**
 * change the answer. It can only change the bill, and only across runs,
 * because within one run of a flow every step is a fresh state and an
 * exact key never repeats.
 *
 * Which leaves two questions that are actually open:
 *
 *   1. **Granularity.** An exact key is always right and almost never
 *      hits. A loose key (route + which fields are empty) hits often —
 *      and can hit on a page that has changed underneath it.
 *   2. **What a stale hit does.** Recorded on one board, replayed on a
 *      mutated one, does the cache serve an action that no longer
 *      applies, and does the run still arrive? This is docs/59's
 *      mutation grading pointed at the cache: a cache is only trustworthy
 *      if it *fails* when the page changes.
 *
 * Passes, in order:
 *
 *   record       no cache, full cost. Populates it.
 *   replay-same  the same board. Upper bound on the saving.
 *   replay-moved the same flow with the filler moved, which changes the
 *                screen text and the candidate order but not the flow.
 *   replay-bug   `?bug=order` — the app still walks but stops recording
 *                the order. The cache should not care, and the point is
 *                that it cannot notice.
 */
import { chromium, type Page } from "playwright";
import { Jev } from "../../shared/jev.js";
import { ActionCache, type Granularity, type StateKeyParts } from "./action-cache.js";
import { blocked, fillValue } from "./confidence-bench.js";
import { decide, defaultOption, isScroll, type FanoutState } from "./fanout.js";
import { notableFacts, probe, type ProbedCandidate } from "./probes.js";
// @ts-expect-error - plain .mjs helper, shared with the other runners.
import { serve } from "./serve.mjs";

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

const FIELDS = `(() => Array.from(document.querySelectorAll("input, textarea, select"))
  .map((el) => (el.id || "") + "=" + (el.value || "")).join(","))()`;

const SIGNATURE = `(() => {
  const fields = Array.from(document.querySelectorAll("input, textarea, select"))
    .map((el) => (el.id || "") + "=" + (el.value || "")).join(",");
  return location.hash + "|" + (document.body.innerText || "") + "|" + fields;
})()`;

async function evalString(page: Page, source: string): Promise<string> {
  try {
    return (await page.evaluate(source)) as string;
  } catch {
    return "";
  }
}

interface PassResult {
  pass: string;
  granularity: Granularity;
  reachedGoal: boolean;
  /** Did the ORDER actually get recorded, not just the URL reached? */
  ordered: boolean;
  steps: number;
  /** Steps served from the cache. */
  served: number;
  wasted: number;
  requests: number;
  inputTokens: number;
  misses: string;
  shipping?: string;
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

async function runPass(
  name: string,
  page: Page,
  baseUrl: string,
  steps: number,
  jev: Jev,
  cache: ActionCache | null,
  granularity: Granularity,
  trace?: (line: string) => void,
): Promise<PassResult> {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    try {
      sessionStorage.clear();
    } catch {}
  });
  await page.reload({ waitUntil: "domcontentloaded" });

  const startIn = jev.inputTokens;
  const hashOf = (u: string) => (u.includes("#") ? u.slice(u.indexOf("#")) : "#/home");
  const seen = new Set<string>([hashOf(page.url())]);
  const recent: string[] = [];
  let wasted = 0;
  let requests = 0;
  let served = 0;
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

    const notInert = candidates.filter((c) => !inert.has(c.description));
    let offered = notInert.length >= 2 ? notInert : candidates;
    const live = offered.filter((c) => !blocked(c));
    if (live.length >= 1) offered = live;

    const shown = offered.map((c) => {
      const note = notableFacts(c);
      return note ? { ...c, description: `${c.description}  [${note}]` } : c;
    });

    // The key's `screen` is the full SIGNATURE, not the 1200-char slice
    // sent to the model.
    //
    // The first version used the slice, and the cache looped for 14
    // steps: on `#/products` the thing that changes when you add to the
    // cart is the count in `#status`, which sits after `#view` and falls
    // outside the slice. Route unchanged, fields unchanged, visible
    // prefix unchanged — so the key said "same state" and the cache
    // served "Add Widget to cart" over and over, at zero cost, with
    // `wasted` reading 0 the whole way because each click really did
    // change the page.
    //
    // That is the cache's entire risk in one line: a key that does not
    // cover the state that matters serves a stale action confidently, and
    // nothing downstream can tell.
    const parts: StateKeyParts = {
      route: hashOf(page.url()),
      screen: before,
      fields: await evalString(page, FIELDS),
    };

    // The cache is consulted against the descriptions actually on offer,
    // so a stored target that no longer exists is a `replay_failed`
    // rather than a click on whatever now carries that index.
    const available = new Set(shown.map((c) => c.description));
    const found = cache?.lookup(parts, available);

    let operation: string;
    let chosen: ProbedCandidate | undefined;
    let option: string | undefined;

    if (found?.hit && found.decision) {
      served += 1;
      operation = found.decision.operation;
      option = found.decision.option;
      chosen = shown.find((c) => c.description === found.decision!.target);
      trace?.(`  step=${step} CACHE ${operation} ${found.decision.target ?? ""}`);
    } else {
      const state: FanoutState = {
        goal: GOAL,
        current_url: parts.route,
        screen: parts.screen,
        step,
        states_seen: [...seen],
        recent_actions: recent.slice(-6),
        last_action: lastAction,
        last_action_changed_the_page: lastHadEffect,
        last_action_error: lastError,
        actions_with_no_effect_in_a_row: noEffectStreak,
        controls_already_tried_here_with_no_effect: [...inert],
      };
      const beforeAsk = jev.inputTokens;
      let decision;
      try {
        decision = await decide("fanout", jev, shown, state, undefined);
      } catch (err) {
        trace?.(`  step=${step} INVALID ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
      requests += decision.requests;
      operation = decision.operation;
      if (decision.entry) {
        chosen = shown.find((c) => c.index === decision.entry!.candidate.index);
        option = decision.entry.option;
      }
      // What one un-served step costs, so the saving can be reported from
      // measurement rather than from an estimate.
      cache?.credit(0);
      cache?.store(parts, { operation: operation as never, target: chosen?.description, option });
      void beforeAsk;
      trace?.(
        `  step=${step} ${operation}@${decision.confidence.toFixed(2)} ` +
          `${found?.reason ? `(miss: ${found.reason})` : ""} ${chosen?.description ?? ""}`,
      );
    }

    taken = step + 1;
    if (operation === "DONE" || operation === "BLOCKED") break;
    if (isScroll(operation as never)) continue;
    if (!chosen) {
      // A cache hit whose target vanished should have been a
      // replay_failed; reaching here means something else went wrong.
      trace?.(`  step=${step} no target resolved for ${operation}`);
      break;
    }

    const real = offered.find((c) => c.index === chosen!.index) ?? chosen;
    const outcome = await act(page, option !== undefined ? { ...real, chosenOption: option } : real);
    const after = await evalString(page, SIGNATURE);
    const hadEffect = before !== after;
    if (!hadEffect) {
      wasted += 1;
      inert.add(real.description);
    }
    seen.add(hashOf(page.url()));
    recent.push(`${operation} ${real.description}${option ? ` = ${option}` : ""}`);
    lastAction = real.description;
    lastHadEffect = hadEffect;
    lastError = outcome.error;
    noEffectStreak = hadEffect ? 0 : noEffectStreak + 1;
    if (seen.has(GOAL_STATE)) break;
  }

  const stored = await page.evaluate(() => {
    try {
      return JSON.parse(sessionStorage.getItem("chaos-target-progress") || "{}");
    } catch {
      return {};
    }
  });

  return {
    pass: name,
    granularity,
    reachedGoal: seen.has(GOAL_STATE),
    // The URL is not the outcome. `?bug=order` reaches #/confirm without
    // recording anything, which is docs/59's whole point.
    ordered: (stored as { ordered?: boolean }).ordered === true,
    steps: taken,
    served,
    wasted,
    requests,
    inputTokens: jev.inputTokens - startIn,
    misses: cache ? cache.missReport() : "—",
    shipping: (stored as { shipping?: string }).shipping || undefined,
  };
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const n = Number.parseInt(process.argv[i + 1] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

async function main(): Promise<void> {
  const steps = arg("steps", 16);
  const verbose = process.argv.includes("--verbose");
  const jev = new Jev();
  const srv = await serve();
  const root = typeof srv === "string" ? srv : srv.url;
  const browser = await chromium.launch();
  const rows: PassResult[] = [];

  const BOARDS = {
    same: `${root}?select=many&wide=60`,
    // Same flow, filler moved: the screen text and the candidate order
    // change, the route and the field shape do not.
    moved: `${root}?select=many&wide=60&fillerpos=before`,
    // Same page, broken app: reaches #/confirm without recording.
    bug: `${root}?select=many&wide=60&bug=order`,
  };

  try {
    for (const granularity of ["exact", "loose"] as Granularity[]) {
      const cache = new ActionCache({ granularity });
      const fresh = async () => {
        const ctx = await browser.newContext();
        return { ctx, page: await ctx.newPage() };
      };

      // 1. Record at full cost.
      let { ctx, page } = await fresh();
      if (verbose) console.log(`\n[${granularity}] record`);
      rows.push(await runPass("record", page, BOARDS.same, steps, jev, cache, granularity, verbose ? console.log : undefined));
      await ctx.close();

      for (const [name, url] of [["replay-same", BOARDS.same], ["replay-moved", BOARDS.moved], ["replay-bug", BOARDS.bug]] as const) {
        ({ ctx, page } = await fresh());
        if (verbose) console.log(`\n[${granularity}] ${name}`);
        rows.push(await runPass(name, page, url, steps, jev, cache, granularity, verbose ? console.log : undefined));
        await ctx.close();
      }
      console.log(`\n[${granularity}] cache holds ${cache.size} keys`);
    }
  } finally {
    await browser.close();
  }

  console.log("\nkey     pass          goal  ordered  steps  served  wasted  reqs  in_tok  misses");
  for (const r of rows) {
    console.log(
      `${r.granularity.padEnd(7)} ${r.pass.padEnd(13)} ${r.reachedGoal ? " yes" : "  no"}  ` +
        `${r.ordered ? "    yes" : "     no"}  ${String(r.steps).padStart(5)}  ` +
        `${String(r.served).padStart(6)}  ${String(r.wasted).padStart(6)}  ` +
        `${String(r.requests).padStart(4)}  ${String(r.inputTokens).padStart(6)}  ${r.misses}`,
    );
  }
  console.log(`\ntotal: ${jev.calls} calls, ${jev.inputTokens} in, ${jev.outputTokens} out`);
  console.log(JSON.stringify(rows));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
