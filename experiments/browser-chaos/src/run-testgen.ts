/**
 * From a sentence to a test suite, graded by mutation.
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/run-testgen.ts [--verbose]
 *
 * One natural-language goal goes in. The explorer walks the app until it
 * reaches the goal, the run is turned into two Playwright specs, and both
 * are then run against the clean app and against five deliberate
 * mutations (`?bug=`, see check-bugs.ts).
 *
 * The grade is the only thing that matters. "It generated a test" is not
 * a result: a spec that replays the clicks and checks the final URL is
 * trivially generatable and passes against an app whose Place-order
 * button has stopped recording the order. So:
 *
 *   caught     failed on a mutation that IS a bug         (want: all)
 *   missed     passed on a mutation that IS a bug         (want: none)
 *   brittle    failed on a mutation that breaks nothing   (want: none)
 *   false pos  failed on the clean app                    (want: none)
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, type Page } from "playwright";
import { Jev } from "../../shared/jev.js";
import { runPolicy } from "./confidence-bench.js";
import {
  candidateAssertions,
  emitAssertedSpec,
  emitReplaySpec,
  judgeAssertions,
  type Assertion,
  type RecordedStep,
} from "./testgen.js";
// @ts-expect-error - plain .mjs helper
import { serve } from "./serve.mjs";

/**
 * The original goal names a route: "work through every checkout step"
 * describes the 3-step path and not the express page. On `?routes=1`
 * that turns a board with four routes into a goal with one, so
 * `--neutral-goal` drops exactly that clause and changes nothing else.
 *
 * Reporting "the route did not vary" without varying this would be the
 * same error this report was corrected for: concluding about a factor
 * that was never moved.
 */
const NEUTRAL_GOAL = process.argv.includes("--neutral-goal");
const GOAL = NEUTRAL_GOAL
  ? "Buy a Widget: put one in the cart and place the order."
  : "Buy a Widget: put one in the cart, work through every checkout step, and place the order.";
const VERBOSE = process.argv.includes("--verbose");
const OUT_ROOT = join(import.meta.dirname, "..", "generated");

/**
 * `--repeat N` regenerates from scratch N times and grades each.
 *
 * With one trial this measures two artifacts, not two methods: docs/04
 * put the spread of agent-written artifacts at 10/24-23/24 for one
 * prompt, so a single generation cannot tell "post-conditions catch the
 * order bug" from "this generation happened to". Default stays 1 so the
 * original single-trial invocation reproduces.
 */
function numArg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const n = Number.parseInt(process.argv[i + 1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const REPEAT = numArg("repeat", 1);
const execFileAsync = promisify(execFile);
/** Playwright colours its reporter output; strip it before matching. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[\\d;]*[A-Za-z]`, "g");

/**
 * Which mutations are real bugs. `label` renames two buttons and `slow`
 * delays rendering — neither breaks the app, so a spec that fails on them
 * is brittle rather than thorough. Established by check-bugs.ts, not by
 * assumption.
 */
const BASE_MUTATIONS: { bug: string; isBug: boolean; what: string }[] = [
  { bug: "cart", isBug: true, what: "add-to-cart stops adding" },
  { bug: "order", isBug: true, what: "the order is never recorded" },
  { bug: "gate", isBug: true, what: "checkout step 2 stops requiring an email" },
  { bug: "label", isBug: false, what: "the Continue buttons are renamed" },
  { bug: "slow", isBug: false, what: "every render is delayed 400ms" },
];

/**
 * `--routes` points the generator at `?routes=1`, where the goal has
 * four route families instead of one gated line (docs/59 §4.6).
 *
 * It adds one mutation, and the reason it is only added here is that it
 * is **route-specific**: `express` drops the address on the express page
 * and leaves the 3-step path alone, so whether a spec catches it depends
 * on which route that generation happened to take. `gate` is its mirror
 * — a check express never runs. Both are established by check-bugs.ts.
 */
const ROUTES = process.argv.includes("--routes");
const MUTATIONS = ROUTES
  ? [
      ...BASE_MUTATIONS,
      { bug: "express", isBug: true, what: "the express page drops the address" },
    ]
  : BASE_MUTATIONS;

const STATUS = `(() => {
  const s = document.getElementById("status");
  return s ? s.textContent.trim() : "";
})()`;
const HEADING = `(() => {
  const h = document.querySelector("#view h1");
  return h ? h.textContent.trim() : "";
})()`;

async function readState(
  page: Page,
): Promise<{ status: string; heading: string; hash: string }> {
  try {
    const u = page.url();
    return {
      status: String(await page.evaluate(STATUS)),
      heading: String(await page.evaluate(HEADING)),
      hash: u.includes("#") ? u.slice(u.indexOf("#")) : "#/home",
    };
  } catch {
    return { status: "", heading: "", hash: "#/home" };
  }
}

/**
 * Run one generated spec against one app URL; true means it passed.
 *
 * Async, and that is the whole point: the app is served from this
 * process, so a synchronous `execFileSync` blocks the event loop that
 * would answer the request. Playwright then reports
 * `net::ERR_ABORTED` and every spec "fails", clean app included — a
 * grading harness that marks everything wrong is indistinguishable from
 * a generator that produces nothing worth keeping.
 */
async function runSpec(
  file: string,
  appUrl: string,
  config: string,
): Promise<{ passed: boolean; firstFailure?: string }> {
  try {
    await execFileAsync(
      "npx",
      ["playwright", "test", "--config", config, file],
      {
        cwd: join(import.meta.dirname, ".."),
        env: { ...process.env, APP_URL: appUrl },
        timeout: 120_000,
      },
    );
    return { passed: true };
  } catch (err) {
    const out = String((err as { stdout?: string }).stdout ?? "");
    const line =
      out
        .split("\n")
        .map((l) => l.replace(ANSI, "").trim())
        .find((l) => /^Error:|expect\(|Timed out|Test timeout/.test(l)) ?? "failed";
    return { passed: false, firstFailure: line.slice(0, 120) };
  }
}

interface TrialResult {
  /** spec name -> caught / missed / brittle / falsePos */
  scores: Record<string, { caught: number; missed: number; brittle: number; falsePos: boolean }>;
  /** Which real bugs each spec caught, for reporting stability. */
  caughtBugs: Record<string, string[]>;
  keptAssertions: number;
  usefulSteps: number;
  reachedGoal: boolean;
  /** Which route family the explorer took, and the raw step ids. */
  route: string;
  stepIds: string[];
  calls: number;
  tokens: number;
}

const SEED_BASE = 7;

async function trial(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  url: string,
  exe: string,
  OUT: string,
  trialIndex: number,
): Promise<TrialResult> {
  {
    const appUrl = ROUTES ? `${url}?routes=1` : url;
    // ---- 1. explore, recording enough to write a file afterwards -------
    const jev = new Jev();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const recorded: RecordedStep[] = [];
    let pending = await readState(page);

    console.log("");
    console.log("=".repeat(100));
    console.log(`  GOAL (in words): ${GOAL}`);
    console.log("=".repeat(100));
    console.log("");

    const run = await runPolicy({
      page,
      baseUrl: appUrl,
      steps: 20,
      // The best policy from docs/57: never offer a control the geometry
      // says cannot be clicked.
      policy: { name: "probe-prune", minConfidence: 0, mode: "probe-prune" },
      jev,
      goal: GOAL,
      goalState: "#/confirm",
      // On the routes board the express page is a legitimate waypoint,
      // so the flow hint has to admit it or a picker taking that route
      // would be scored as wandering.
      flow: ROUTES
        ? ["#/cart", "#/express", "#/checkout-1", "#/checkout-2", "#/checkout-3", "#/confirm"]
        : ["#/cart", "#/checkout-1", "#/checkout-2", "#/checkout-3", "#/confirm"],
      seed: SEED_BASE + trialIndex,
      trace: VERBOSE ? (l) => console.log(`    ${l}`) : undefined,
      afterStep: async (row) => {
        const after = await readState(page);
        recorded.push({
          ...row,
          statusBefore: pending.status,
          headingBefore: pending.heading,
          statusAfter: after.status,
          headingAfter: after.heading,
          hashAfter: after.hash,
        });
        pending = after;
      },
    });
    await ctx.close();

    if (!run.reachedGoal) {
      console.log("  the explorer did not reach the goal; nothing to generate");
      process.exitCode = 1;
      // Report it as a trial rather than aborting the sweep: "the
      // explorer sometimes does not arrive" is itself a result about
      // generation stability, and swallowing it would flatter the method.
      return {
        scores: {}, caughtBugs: {}, keptAssertions: 0,
        usefulSteps: 0, reachedGoal: false,
        route: "(did not arrive)", stepIds: [],
        calls: jev.calls, tokens: jev.inputTokens,
      };
    }
    // Only the steps that did something belong in a test. A step that
    // changed nothing is exploration, not a reproduction.
    const useful = recorded.filter((s) => s.hadEffect);
    console.log(`  reached ${run.reachedGoal ? "#/confirm" : "?"} in ${recorded.length} steps` +
      ` (${useful.length} of them changed something)`);
    console.log("");
    for (const s of useful) {
      console.log(`    ${s.action.padEnd(5)} ${s.locator.id ? `#${s.locator.id}` : `${s.locator.role} "${s.locator.name}"`}`);
    }

    // ---- 2. decide what to assert -------------------------------------
    console.log("");
    console.log("  post-conditions offered by the harness, and what the model kept:");
    const kept: Assertion[][] = [];
    for (const step of useful) {
      const candidates = candidateAssertions(step);
      const keptHere = await judgeAssertions(jev, step, candidates);
      kept.push(keptHere);
      const keptSays = new Set(keptHere.map((k) => k.says));
      for (const c of candidates) {
        const k = keptHere.find((x) => x.says === c.says);
        console.log(
          `    ${keptSays.has(c.says) ? "keep" : "drop"} ${(k?.consequence ?? 0).toFixed(2)}  ` +
            `${c.says}`,
        );
      }
      if (candidates.length === 0) console.log("    (no observable change to assert)");
    }

    // ---- 3. write the specs ------------------------------------------
    mkdirSync(OUT, { recursive: true });
    const opts = { title: "places an order", goal: GOAL };
    writeFileSync(join(OUT, "replay.spec.ts"), emitReplaySpec(useful, opts));
    writeFileSync(join(OUT, "asserted.spec.ts"), emitAssertedSpec(useful, kept, opts));
    writeFileSync(
      join(OUT, "playwright.config.ts"),
      `// GENERATED. Points Playwright at the browser this environment has.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  reporter: "line",
  use: {
    launchOptions: {
      args: ["--no-sandbox"],
      ${existsSync(exe) ? `executablePath: ${JSON.stringify(exe)},` : ""}
    },
  },
});
`,
    );
    console.log("");
    console.log(`  wrote ${OUT}/replay.spec.ts and ${OUT}/asserted.spec.ts`);
    console.log(
      `  assertions kept: ${kept.reduce((n, k) => n + k.length, 0)} across ${useful.length} steps`,
    );

    // ---- 4. grade by mutation ----------------------------------------
    console.log("");
    console.log("=".repeat(100));
    console.log("  MUTATION GRADING — a spec is only worth keeping if it fails when the app does");
    console.log("=".repeat(100));
    console.log("");

    const specs = [
      { name: "replay", file: join(OUT, "replay.spec.ts") },
      { name: "asserted", file: join(OUT, "asserted.spec.ts") },
    ];
    const grid: Record<string, Record<string, boolean>> = {};
    for (const spec of specs) {
      grid[spec.name] = {};
      const cfg = join(OUT, "playwright.config.ts");
      grid[spec.name]!["(clean)"] = (await runSpec(spec.file, appUrl, cfg)).passed;
      for (const m of MUTATIONS) {
        const r = await runSpec(spec.file, `${appUrl}${appUrl.includes("?") ? "&" : "?"}bug=${m.bug}`, cfg);
        grid[spec.name]![m.bug] = r.passed;
        if (VERBOSE && !r.passed) console.log(`    ${spec.name}/${m.bug}: ${r.firstFailure}`);
      }
    }

    const cols = ["(clean)", ...MUTATIONS.map((m) => m.bug)];
    const w = Math.max(9, ...specs.map((s) => s.name.length));
    console.log(
      `  ${"spec".padEnd(w)}  ` + cols.map((c) => c.padEnd(8)).join(" ") + "  caught  missed  brittle",
    );
    console.log(`  ${"-".repeat(w)}  ` + cols.map((c) => "-".repeat(Math.max(8, c.length))).join(" "));
    for (const spec of specs) {
      const row = grid[spec.name]!;
      const caught = MUTATIONS.filter((m) => m.isBug && row[m.bug] === false).length;
      const missed = MUTATIONS.filter((m) => m.isBug && row[m.bug] === true).length;
      const brittle = MUTATIONS.filter((m) => !m.isBug && row[m.bug] === false).length;
      console.log(
        `  ${spec.name.padEnd(w)}  ` +
          cols.map((c) => (row[c] ? "pass" : "FAIL").padEnd(8)).join(" ") +
          `  ${String(caught).padStart(6)}  ${String(missed).padStart(6)}  ${String(brittle).padStart(7)}`,
      );
    }
    console.log("");
    console.log(`  real bugs: ${MUTATIONS.filter((m) => m.isBug).map((m) => m.bug).join(", ")}`);
    console.log(`  not bugs : ${MUTATIONS.filter((m) => !m.isBug).map((m) => m.bug).join(", ")}`);
    console.log("");
    console.log(
      `  cost: ${jev.calls} calls, ${jev.inputTokens} input tokens, ` +
        `$${((jev.inputTokens / 1e6) * 0.042).toFixed(5)}`,
    );
    console.log("");

    const scores: TrialResult["scores"] = {};
    const caughtBugs: TrialResult["caughtBugs"] = {};
    for (const spec of specs) {
      const row = grid[spec.name]!;
      scores[spec.name] = {
        caught: MUTATIONS.filter((m) => m.isBug && row[m.bug] === false).length,
        missed: MUTATIONS.filter((m) => m.isBug && row[m.bug] === true).length,
        brittle: MUTATIONS.filter((m) => !m.isBug && row[m.bug] === false).length,
        falsePos: row["(clean)"] === false,
      };
      caughtBugs[spec.name] = MUTATIONS.filter((m) => m.isBug && row[m.bug] === false).map((m) => m.bug);
    }
    // Name the route from what was actually clicked, not from what the
    // flow hint allowed: `buynow`/`add` is the entry and `place-express`
    // vs `place` is the checkout path.
    const ids = useful.map((s) => s.locator.id || `${s.locator.role}:${s.locator.name}`);
    const entry = ids.includes("buynow") ? "buynow" : ids.includes("add") ? "products" : "?";
    const path = ids.includes("place-express") ? "express" : ids.includes("place") ? "steps" : "?";
    return {
      scores,
      caughtBugs,
      keptAssertions: kept.reduce((n, k) => n + k.length, 0),
      usefulSteps: useful.length,
      reachedGoal: run.reachedGoal,
      route: `${entry}+${path}`,
      stepIds: ids,
      calls: jev.calls,
      tokens: jev.inputTokens,
    };
  }
}

async function main() {
  const { server, url } = (await serve(0)) as { server: { close(): void }; url: string };
  const exe = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    ...(existsSync(exe) ? { executablePath: exe } : {}),
  });

  const trials: TrialResult[] = [];
  try {
    for (let i = 0; i < REPEAT; i += 1) {
      // Each trial writes its own specs so a later one cannot be graded
      // against an earlier one's files.
      const out = REPEAT === 1 ? OUT_ROOT : join(OUT_ROOT, `trial-${i + 1}`);
      if (REPEAT > 1) {
        console.log("");
        console.log("#".repeat(100));
        console.log(`  TRIAL ${i + 1} of ${REPEAT}`);
        console.log("#".repeat(100));
      }
      trials.push(await trial(browser, url, exe, out, i));
    }
  } finally {
    await browser.close();
    server.close();
  }

  if (REPEAT === 1) return;

  // ---- 5. across trials -------------------------------------------------
  console.log("");
  console.log("=".repeat(100));
  console.log(`  ACROSS ${REPEAT} INDEPENDENT GENERATIONS — is the 1 -> 2 difference the method or the artifact?`);
  console.log("=".repeat(100));
  console.log("");
  const names = Object.keys(trials[0]!.scores);
  const w = Math.max(9, ...names.map((n) => n.length));
  console.log(`  ${"spec".padEnd(w)}  caught per trial        mean   min  max  brittle  false-pos`);
  console.log(`  ${"-".repeat(w)}  ${"-".repeat(22)}  -----  ---  ---  -------  ---------`);
  for (const n of names) {
    const c = trials.map((t) => t.scores[n]!.caught);
    const mean = c.reduce((x, y) => x + y, 0) / c.length;
    console.log(
      `  ${n.padEnd(w)}  ${c.join(", ").padEnd(22)}  ${mean.toFixed(2).padStart(5)}  ` +
        `${String(Math.min(...c)).padStart(3)}  ${String(Math.max(...c)).padStart(3)}  ` +
        `${String(trials.reduce((s, t) => s + t.scores[n]!.brittle, 0)).padStart(7)}  ` +
        `${String(trials.filter((t) => t.scores[n]!.falsePos).length).padStart(9)}`,
    );
  }
  console.log("");
  for (const n of names) {
    const sets = trials.map((t) => t.caughtBugs[n]!.join("+") || "(none)");
    console.log(`  ${n.padEnd(w)} caught: ${sets.join("  |  ")}`);
  }
  console.log("");
  const paired = trials.filter((t) => t.scores["asserted"] && t.scores["replay"]);
  const wins = paired.filter((t) => t.scores["asserted"]!.caught > t.scores["replay"]!.caught).length;
  const ties = paired.filter((t) => t.scores["asserted"]!.caught === t.scores["replay"]!.caught).length;
  console.log(
    `  asserted > replay in ${wins}/${paired.length} trials, tied in ${ties}, ` +
      `worse in ${paired.length - wins - ties}`,
  );
  console.log(
    `  steps ${trials.map((t) => t.usefulSteps).join(",")}   ` +
      `assertions kept ${trials.map((t) => t.keptAssertions).join(",")}   ` +
      `reached goal ${trials.filter((t) => t.reachedGoal).length}/${REPEAT}`,
  );
  // Path diversity is the precondition for any of this to mean
  // something: if every trial walks the same route, a stable grade says
  // nothing about the method.
  const routes = trials.map((t) => t.route);
  const distinctRoutes = new Set(routes).size;
  const distinctSeqs = new Set(trials.map((t) => t.stepIds.join(">"))).size;
  console.log("");
  console.log(`  routes taken: ${routes.join(", ")}`);
  console.log(
    `  distinct routes ${distinctRoutes}/${REPEAT}   distinct step sequences ${distinctSeqs}/${REPEAT}`,
  );
  if (distinctRoutes === 1) {
    console.log(`  NOTE: every trial took the same route, so a stable grade is the board, not the method.`);
  }
  for (const t of trials) console.log(`    ${t.route.padEnd(16)} ${t.stepIds.join(" > ")}`);
  const tok = trials.reduce((s, t) => s + t.tokens, 0);
  console.log(
    `  total: ${trials.reduce((s, t) => s + t.calls, 0)} calls, ${tok} input tokens, ` +
      `$${((tok / 1e6) * 0.042).toFixed(5)}`,
  );
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
