/**
 * Benchmark: does asking Jev which candidate to click beat a weighted random
 * walk, on an app whose interesting state is many correct clicks deep?
 *
 * Both arms run the same crawl, the same seeds and the same step budget, and
 * both are wrapped in `recordingDriver` so coverage is measured identically.
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/run.ts [--steps 30] [--seeds 3]
 *
 * Reported per arm: distinct app states reached, whether the gated flow was
 * completed (#/confirm), and for the Jev arm what it cost.
 */
import { chaos, weightedRandomDriver } from "chaosbringer";
import { Jev } from "../../shared/jev.js";
import { jevDriver, recordingDriver } from "./jev-driver.js";
import { serve } from "./serve.mjs";
import { existsSync } from "node:fs";

const GOAL_STATE = "#/confirm";
/** The states the app can be in; the denominator for coverage. */
const ALL_STATES = [
  "#/home", "#/products", "#/cart", "#/checkout-1", "#/checkout-2",
  "#/checkout-3", "#/confirm", "#/settings", "#/about", "#/help",
  "#/faq", "#/blog", "#/contact", "#/danger",
];

/**
 * This sandbox ships a pinned Chromium that need not match the installed
 * Playwright's expected build, so point `chromium.launch()` at it when it is
 * there. Everywhere else, Playwright's own resolution is correct.
 */
function launchOptions(): { executablePath?: string; args: string[] } {
  const pinned = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  const args = ["--no-sandbox"];
  return existsSync(pinned) ? { executablePath: pinned, args } : { args };
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number.parseInt(process.argv[i + 1] ?? "", 10);
  return Number.isFinite(v) ? v : fallback;
}

const STEPS = arg("steps", 30);
const SEEDS = arg("seeds", 3);
const VERBOSE = process.argv.includes("--verbose");

interface ArmResult {
  seed: number;
  states: string[];
  reachedGoal: boolean;
  steps: number;
  errors: number;
}

function statesFrom(urls: string[]): string[] {
  const seen = new Set<string>();
  for (const u of urls) {
    const i = u.indexOf("#");
    seen.add(i === -1 ? "#/home" : u.slice(i));
  }
  return [...seen].filter((s) => ALL_STATES.includes(s));
}

async function runArm(
  label: string,
  baseUrl: string,
  seed: number,
  makeDriver: () => ReturnType<typeof weightedRandomDriver>,
): Promise<ArmResult> {
  const sink = { urls: [] as string[], picks: [] as string[] };
  const driver = recordingDriver(makeDriver(), sink);
  const { report } = await chaos({
    baseUrl,
    seed,
    // One tab, many actions: the app is a SPA, and its progress lives in
    // sessionStorage, which a fresh tab would not carry.
    maxPages: 1,
    maxActionsPerPage: STEPS,
    headless: true,
    launchOptions: launchOptions(),
    driver,
    driverGoal: "Complete the checkout flow and reach the order confirmation.",
  });
  // The recorded URL is the one seen BEFORE each action, so the state the
  // last action opened needs the page's own log too.
  const states = statesFrom(sink.urls);
  const visitedByApp = report.pages[0]?.url ?? "";
  if (visitedByApp.includes("#")) {
    const s = visitedByApp.slice(visitedByApp.indexOf("#"));
    if (ALL_STATES.includes(s) && !states.includes(s)) states.push(s);
  }
  if (VERBOSE) {
    console.log(`  [${label} seed=${seed}] picks:`);
    for (const p of sink.picks) console.log(`      ${p}`);
  }
  return {
    seed,
    states,
    reachedGoal: states.includes(GOAL_STATE),
    steps: sink.picks.length,
    errors: report.totalErrors,
  };
}

function summarise(label: string, rows: ArmResult[]) {
  const cov = rows.map((r) => r.states.length);
  const mean = cov.reduce((a, b) => a + b, 0) / (cov.length || 1);
  const goals = rows.filter((r) => r.reachedGoal).length;
  console.log(
    `  ${label.padEnd(18)} states ${mean.toFixed(1)}/${ALL_STATES.length} ` +
      `(${cov.join(", ")})   reached ${GOAL_STATE}: ${goals}/${rows.length}`,
  );
  const deep = ["#/cart", "#/checkout-1", "#/checkout-2", "#/checkout-3", "#/confirm"];
  const depth = rows.map((r) => {
    let d = 0;
    for (let i = 0; i < deep.length; i += 1) if (r.states.includes(deep[i])) d = i + 1;
    return d;
  });
  console.log(
    `  ${"".padEnd(18)} deepest flow step reached: ${depth.join(", ")} ` +
      `(of ${deep.length}: cart -> checkout 1,2,3 -> confirm)`,
  );
}

async function main() {
  const { server, url } = await serve(0);
  console.log("=".repeat(96));
  console.log(`  BROWSER CHAOS — ${STEPS} steps x ${SEEDS} seeds, target ${url}`);
  console.log("=".repeat(96));
  console.log("");

  try {
    const randomRows: ArmResult[] = [];
    for (let s = 0; s < SEEDS; s += 1) {
      randomRows.push(await runArm("random", url, 100 + s, () => weightedRandomDriver()));
    }

    const jev = new Jev();
    const jevRows: ArmResult[] = [];
    for (let s = 0; s < SEEDS; s += 1) {
      jevRows.push(
        await runArm("jev", url, 100 + s, () =>
          jevDriver({
            jev,
            goal:
              "Complete the shop's checkout flow: get an item into the cart, work through the checkout steps, and place the order. Also visit states not seen yet.",
            onDecision: VERBOSE ? (l) => console.log(`      ${l}`) : undefined,
          }),
        ),
      );
    }

    console.log("");
    summarise("weighted-random", randomRows);
    console.log("");
    summarise("jev", jevRows);
    console.log("");
    console.log(
      `  jev cost: ${jev.calls} calls, ${jev.inputTokens} input tokens, ` +
        `${(jev.totalMs / Math.max(jev.calls, 1)).toFixed(0)} ms/call, ` +
        `$${((jev.inputTokens / 1e6) * 0.042).toFixed(5)} total`,
    );
    console.log(
      `  (no screenshot is captured, so there is nothing to sample or budget:`,
    );
    console.log(`   one call per step is the whole cost)`);
    console.log("");
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
