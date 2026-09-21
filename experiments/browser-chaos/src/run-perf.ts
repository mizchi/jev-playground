/**
 * Performance work, closed as a loop: measure, diagnose, fix, measure again.
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/run-perf.ts [--repeat 3] [--verbose]
 *
 * The flow is scripted, not explored — the question here is about reading
 * numbers, and a picker that chose a different path each run would make
 * the numbers incomparable. `?perf=1` attaches one problem to each of four
 * steps, each with a different signature (see app/index.html), and the
 * fourth is deliberately not worth fixing.
 *
 * Two diagnosticians on the same measurements:
 *
 *   budget   the step over a wall-clock threshold. What a perf budget is.
 *   jev      given the per-subsystem split, which step to fix and which
 *            subsystem is at fault
 *
 * Then the loop closes: whatever was named gets its fix applied
 * (`?fixed=`) and the flow is measured again. **A wrong diagnosis shows up
 * as a number that did not move** — which is the only reason to trust any
 * of this. Naming a culprit is cheap; naming one whose removal helps is
 * the claim.
 */
import { existsSync } from "node:fs";
import { chromium, type Page } from "playwright";
import { Jev, choice } from "../../shared/jev.js";
import { FAST_3G, PerfMeter, formatCost, type StepCost } from "./perf.js";
// @ts-expect-error - plain .mjs helper
import { serve } from "./serve.mjs";

const VERBOSE = process.argv.includes("--verbose");
function numArg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number.parseInt(process.argv[i + 1] ?? "", 10);
  return Number.isFinite(v) ? v : fallback;
}
const REPEAT = numArg("repeat", 3);

/**
 * What is wrong with each step, by construction. The grader, not a hint:
 * nothing below is shown to either diagnostician.
 */
const TRUTH: Record<string, { subsystem: "cpu" | "render" | "network" | "none"; worthFixing: boolean }> = {
  "click Add Widget to cart": { subsystem: "cpu", worthFixing: true },
  "click Proceed to checkout": { subsystem: "render", worthFixing: true },
  "click Continue to delivery": { subsystem: "network", worthFixing: true },
  "click Send feedback": { subsystem: "cpu", worthFixing: false },
  "goto /": { subsystem: "none", worthFixing: false },
  "click Products": { subsystem: "none", worthFixing: false },
  "click Cart": { subsystem: "none", worthFixing: false },
  "fill email": { subsystem: "none", worthFixing: false },
  "fill address": { subsystem: "none", worthFixing: false },
  "click Continue to payment": { subsystem: "none", worthFixing: false },
  "click Place order": { subsystem: "none", worthFixing: false },
  "click FAQ": { subsystem: "none", worthFixing: false },
};

/** Which `?fixed=` token removes the problem on each step. */
const FIX_TOKEN: Record<string, string> = {
  "click Add Widget to cart": "add",
  "click Proceed to checkout": "checkout",
  "click Continue to delivery": "next1",
  "click Send feedback": "feedback",
};

/**
 * The scripted flow. Every step is one user action, measured on its own,
 * which is the unit lightbringer reports on.
 */
async function measureFlow(page: Page, meter: PerfMeter, base: string): Promise<StepCost[]> {
  const out: StepCost[] = [];
  const step = async (label: string, act: () => Promise<void>) => {
    await meter.begin();
    const t0 = Date.now();
    await act();
    // Wait for the work, not for a magic number: in flight first, then a
    // short quiet period so a deferred task lands in an observer entry.
    await meter.settle(page);
    out.push(await meter.end(label, Date.now() - t0));
  };
  const hop = async (hash: string) => {
    await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
  };

  await step("goto /", async () => {
    await page.goto(base, { waitUntil: "domcontentloaded" });
  });
  await step("click Products", () => hop("#/products"));
  await step("click Add Widget to cart", () => page.locator("#add").click({ timeout: 5000 }));
  await step("click Cart", () => hop("#/cart"));
  await step("click Proceed to checkout", () => page.locator("#checkout").click({ timeout: 5000 }));
  await step("fill email", () => page.locator("#email").fill("test@example.com", { timeout: 5000 }));
  await step("click Continue to delivery", () => page.locator("#next1").click({ timeout: 5000 }));
  await step("fill address", () => page.locator("#address").fill("1 Example Street", { timeout: 5000 }));
  await step("click Continue to payment", () => page.locator("#next2").click({ timeout: 5000 }));
  await step("click Place order", () => page.locator("#place").click({ timeout: 5000 }));
  await step("click FAQ", () => hop("#/faq"));
  await step("click Send feedback", async () => {
    await page.getByRole("button", { name: "Send feedback" }).click({ timeout: 5000 });
  });
  return out;
}

/** Median per step across runs, so one noisy sample cannot pick the culprit. */
function medianCosts(runs: StepCost[][]): StepCost[] {
  const mid = (ns: number[]) => {
    const s = [...ns].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? 0;
  };
  return (runs[0] ?? []).map((_, i) => {
    const row = runs.map((r) => r[i]!).filter(Boolean);
    return {
      label: row[0]!.label,
      wallMs: mid(row.map((r) => r.wallMs)),
      blockingMs: mid(row.map((r) => r.blockingMs)),
      longTasks: mid(row.map((r) => r.longTasks)),
      layoutCount: mid(row.map((r) => r.layoutCount)),
      recalcStyleCount: mid(row.map((r) => r.recalcStyleCount)),
      layoutMs: mid(row.map((r) => r.layoutMs)),
      transferredKb: mid(row.map((r) => r.transferredKb)),
      requests: mid(row.map((r) => r.requests)),
    };
  });
}

/** What a perf budget does: flag the slowest step over a threshold. */
function budgetVerdict(costs: StepCost[], thresholdMs: number): { step: string; subsystem: string } | null {
  const over = costs.filter((c) => c.wallMs > thresholdMs).sort((a, b) => b.wallMs - a.wallMs);
  const worst = over[0];
  // A wall-clock budget has nothing to say about which subsystem: that is
  // the whole gap the split is for.
  return worst ? { step: worst.label, subsystem: "(a budget cannot say)" } : null;
}

/**
 * The same two questions, but the second one is asked on its own, with
 * only the chosen step's numbers in the state.
 *
 * This is docs/58's finding turning up in a new place. Asking "which step,
 * and what is wrong with it" in one request leaves a join to the model:
 * the subsystem question says "for the step you chose", and the numbers
 * for that step are somewhere in an array of twelve. Doing the join in
 * code costs one extra call and nothing else.
 */
async function jevVerdictTwoCalls(
  jev: Jev,
  costs: StepCost[],
): Promise<{ step: string; subsystem: string; confidence: number }> {
  const first = await jev.ask(stepState(costs), { step: stepQuestion(costs) });
  const picked = choice(first.answers.step);
  const c = costs.find((x) => x.label === picked.choice) ?? costs[0]!;
  const second = await jev.ask(
    {
      goal: "Decide what has to change to make this one step faster.",
      // One step, spelled out. Nothing to look up.
      step: c.label,
      wall_ms: c.wallMs,
      main_thread_blocked_ms: c.blockingMs,
      long_tasks: c.longTasks,
      forced_layouts: c.layoutCount,
      layout_ms: c.layoutMs,
      style_recalcs: c.recalcStyleCount,
      transferred_kb: c.transferredKb,
      requests: c.requests,
      notes: SHARED_NOTES,
    },
    { subsystem: subsystemQuestion() },
  );
  return {
    step: picked.choice,
    subsystem: choice(second.answers.subsystem).choice,
    confidence: picked.confidence,
  };
}

/**
 * The notes are part of the experiment, not decoration.
 *
 * The first version of the second line read "Main-thread blocking is time
 * the user cannot interact. Transfer is bytes on the wire, during which
 * the main thread is free." Every clause of that is true, and together
 * they say the wrong thing: they read as *network time does not count*.
 * It cost the run its answer -- a 414ms CPU step was picked over a
 * 1840ms network one, and the verification measured the difference at
 * 188ms against 1661ms. docs/23 §12.4 hit the same thing from the other
 * side: the edit that moved the numbers was one line of prose.
 */
const SHARED_NOTES = [
  "Wall time includes a ~150ms quiet period the harness waits after every step, so a step with no work still shows some.",
  "The user waits out a step's whole wall time. It makes no difference to them whether the browser spent it computing or waiting for bytes.",
  "The subsystem columns say WHAT to change, not whether it is worth changing. Decide that from the time.",
  "Work that happens after the interaction has already finished does not make the user wait, even though it is real work.",
  "A large count is not a large cost: check the milliseconds next to it.",
];

function stepState(costs: StepCost[]) {
  return {
    goal: "Make this user flow faster. Pick the one step where a change to the implementation would win the most real waiting time for the user.",
    steps: costs.map((c) => ({
      step: c.label,
      wall_ms: c.wallMs,
      main_thread_blocked_ms: c.blockingMs,
      long_tasks: c.longTasks,
      forced_layouts: c.layoutCount,
      layout_ms: c.layoutMs,
      style_recalcs: c.recalcStyleCount,
      transferred_kb: c.transferredKb,
      requests: c.requests,
    })),
    notes: SHARED_NOTES,
  };
}

function stepQuestion(costs: StepCost[]) {
  const criteria: Record<string, string> = {};
  for (const c of costs) {
    criteria[c.label] =
      `${c.wallMs}ms wall; main thread blocked ${c.blockingMs}ms in ${c.longTasks} long task(s); ` +
      `${c.layoutCount} forced layouts costing ${c.layoutMs}ms; ${c.recalcStyleCount} style recalcs; ` +
      `${c.transferredKb}KB over ${c.requests} request(s)`;
  }
  return {
    type: "choice" as const,
    instructions:
      "Which step should be optimised first? Judge by how much of its cost the user actually waits for, not by wall time alone.",
    criteria,
  };
}

function subsystemQuestion() {
  return {
    type: "choice" as const,
    instructions: "What has to change to make this step faster?",
    criteria: {
      cpu: "Synchronous work occupying the main thread — break it up or move it off",
      render: "Layout and style work — the code is forcing reflow, batch the reads and writes",
      network: "Bytes and round trips — the request is the cost, the main thread is idle",
      none: "Nothing here is worth changing",
    },
  };
}

/** Both questions in one request, leaving the join to the model. */
async function jevVerdict(
  jev: Jev,
  costs: StepCost[],
): Promise<{ step: string; subsystem: string; confidence: number }> {
  const res = await jev.ask(stepState(costs), {
    step: stepQuestion(costs),
    // Note what this cannot say: which step's numbers to read. That is
    // the join.
    subsystem: {
      ...subsystemQuestion(),
      instructions: "For the step you chose, what has to change?",
    },
  });
  const step = choice(res.answers.step);
  return {
    step: step.choice,
    subsystem: choice(res.answers.subsystem).choice,
    confidence: step.confidence,
  };
}

function totalWall(costs: StepCost[]): number {
  return costs.reduce((n, c) => n + c.wallMs, 0);
}
/** The harness's own quiet period, subtracted so it does not flatter a step. */
const SETTLE_MS = 150;

function userWait(costs: StepCost[]): number {
  // What the user actually waits for: the step's wall time less the
  // harness's quiet period. A crude but honest proxy, and the same
  // subtraction for every step.
  return costs.reduce((n, c) => n + Math.max(0, c.wallMs - SETTLE_MS), 0);
}

async function main() {
  const { server, url } = (await serve(0)) as { server: { close(): void }; url: string };
  const exe = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    ...(existsSync(exe) ? { executablePath: exe } : {}),
  });

  /** One full measured pass over the flow at a given URL. */
  const measure = async (target: string): Promise<StepCost[]> => {
    const runs: StepCost[][] = [];
    for (let i = 0; i < REPEAT; i += 1) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      const meter = await PerfMeter.attach(page, cdp, { network: FAST_3G });
      runs.push(await measureFlow(page, meter, target));
      await ctx.close();
    }
    return medianCosts(runs);
  };

  try {
    console.log("");
    console.log("=".repeat(104));
    console.log(
    `  PER-STEP COST — median of ${REPEAT} runs, throttled to Fast 3G,` +
      " technique borrowed from lightbringer (see src/perf.ts)",
  );
    console.log("=".repeat(104));

    const fast = await measure(url);
    const slow = await measure(`${url}?perf=1`);

    console.log("");
    console.log("  with ?perf=1:");
    for (const c of slow) console.log(`    ${formatCost(c)}`);
    console.log("");
    console.log("  without (same flow, same harness):");
    for (const c of fast) console.log(`    ${formatCost(c)}`);
    console.log("");
    console.log(
      `  total wall ${totalWall(slow)}ms vs ${totalWall(fast)}ms; ` +
        `user waiting ${userWait(slow)}ms vs ${userWait(fast)}ms`,
    );

    // ---- diagnose ----------------------------------------------------
    const jev = new Jev();
    const budget = budgetVerdict(slow, 400);
    const oneCall = await jevVerdict(jev, slow);
    const verdict = await jevVerdictTwoCalls(jev, slow);

    console.log("");
    console.log("=".repeat(104));
    console.log("  DIAGNOSIS");
    console.log("=".repeat(104));
    console.log("");
    const grade = (v: { step: string; subsystem: string }) => {
      const t = TRUTH[v.step];
      if (!t) return "unknown step";
      return (
        `step ${t.worthFixing ? "worth fixing" : "NOT worth fixing"}, ` +
        `subsystem ${t.subsystem === v.subsystem ? "correct" : `WRONG (truth: ${t.subsystem})`}`
      );
    };
    console.log(`  budget (>400ms wall) : ${budget ? `${budget.step}  ->  ${budget.subsystem}` : "nothing flagged"}`);
    console.log(`                         ${budget ? `step ${TRUTH[budget.step]?.worthFixing ? "worth fixing" : "NOT worth fixing"}, subsystem not answered` : ""}`);
    console.log("");
    console.log(`  jev, one request     : ${oneCall.step}  ->  ${oneCall.subsystem}`);
    console.log(`                         ${grade(oneCall)}`);
    console.log("");
    console.log(
      `  jev, join in code    : ${verdict.step}  ->  ${verdict.subsystem}  ` +
        `(confidence ${verdict.confidence.toFixed(2)})`,
    );
    console.log(`                         ${grade(verdict)}`);

    // ---- close the loop ----------------------------------------------
    const token = FIX_TOKEN[verdict.step];
    console.log("");
    console.log("=".repeat(104));
    console.log("  VERIFICATION — apply the fix it named, measure again");
    console.log("=".repeat(104));
    console.log("");
    if (!token) {
      console.log(`  no fix is defined for "${verdict.step}", so there is nothing to apply`);
    } else {
      const fixed = await measure(`${url}?perf=1&fixed=${token}`);
      const before = userWait(slow);
      const after = userWait(fixed);
      console.log(`  applied ?fixed=${token}`);
      console.log(
        `  user waiting ${before}ms → ${after}ms  ` +
          `(${after < before ? "-" : "+"}${Math.abs(before - after)}ms, ` +
          `${(((before - after) / Math.max(before, 1)) * 100).toFixed(1)}%)`,
      );
      if (VERBOSE) for (const c of fixed) console.log(`    ${formatCost(c)}`);

      // And what the OTHER candidate fixes would have bought, so the
      // recommendation can be ranked rather than merely confirmed.
      console.log("");
      console.log("  what each available fix is actually worth:");
      const rows: { token: string; step: string; saved: number }[] = [];
      for (const [stepLabel, tok] of Object.entries(FIX_TOKEN)) {
        const m = tok === token ? fixed : await measure(`${url}?perf=1&fixed=${tok}`);
        rows.push({ token: tok, step: stepLabel, saved: before - userWait(m) });
      }
      rows.sort((a, b) => b.saved - a.saved);
      for (const r of rows) {
        const mark = r.token === token ? " <- chosen" : "";
        console.log(`    ${r.token.padEnd(10)} saves ${String(r.saved).padStart(5)}ms   ${r.step}${mark}`);
      }
      const best = rows[0]!;
      console.log("");
      console.log(
        best.token === token
          ? `  the chosen fix is the best available one (${best.saved}ms)`
          : `  the best available fix was ${best.token} (${best.saved}ms), not ${token}`,
      );
    }

    console.log("");
    console.log(
      `  cost: ${jev.calls} calls, ${jev.inputTokens} input tokens, ` +
        `$${((jev.inputTokens / 1e6) * 0.042).toFixed(5)}`,
    );
    console.log("");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
