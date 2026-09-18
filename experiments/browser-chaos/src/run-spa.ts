/**
 * Jev vs a random walk on the gated shop, with candidates re-read every step.
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/run-spa.ts [--steps 20] [--seeds 3] [--verbose]
 *
 * The goal state (#/confirm) is eight correct choices deep, past two traps
 * that reset progress, with 13-16 controls on screen at each step. A uniform
 * random walk has no realistic chance of reaching it inside the budget; the
 * question is whether Jev does, and what it costs.
 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { Jev } from "../../shared/jev.js";
import { jevPicker, randomPicker, runSteps, type RunResult } from "./spa-bench.js";
import { serve } from "./serve.mjs";

const GOAL = "#/confirm";
const FLOW = ["#/cart", "#/checkout-1", "#/checkout-2", "#/checkout-3", "#/confirm"];
const ALL_STATES = [
  "#/home", "#/products", "#/cart", "#/checkout-1", "#/checkout-2",
  "#/checkout-3", "#/confirm", "#/settings", "#/about", "#/help",
  "#/faq", "#/blog", "#/contact", "#/danger",
];

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number.parseInt(process.argv[i + 1] ?? "", 10);
  return Number.isFinite(v) ? v : fallback;
}

const STEPS = arg("steps", 20);
const SEEDS = arg("seeds", 3);
const VERBOSE = process.argv.includes("--verbose");

function depth(states: string[]): number {
  let d = 0;
  for (let i = 0; i < FLOW.length; i += 1) if (states.includes(FLOW[i])) d = i + 1;
  return d;
}

function summarise(label: string, rows: RunResult[]) {
  const cov = rows.map((r) => r.states.filter((s) => ALL_STATES.includes(s)).length);
  const mean = cov.reduce((a, b) => a + b, 0) / (cov.length || 1);
  const depths = rows.map((r) => depth(r.states));
  const goals = rows.filter((r) => r.reachedGoal).length;
  console.log(`  ${label.padEnd(16)} states ${mean.toFixed(1)}/${ALL_STATES.length} (${cov.join(", ")})`);
  const wasted = rows.map((r) => r.wastedSteps);
  console.log(`  ${"".padEnd(16)} flow depth ${depths.join(", ")} of ${FLOW.length}   order placed: ${goals}/${rows.length}   wasted steps ${wasted.join(", ")}`);
}

async function main() {
  const { server, url } = await serve(0);
  const exe = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    ...(existsSync(exe) ? { executablePath: exe } : {}),
  });
  console.log("=".repeat(96));
  console.log(`  SPA BENCH — ${STEPS} steps x ${SEEDS} seeds, goal ${GOAL} is ${FLOW.length} gated states deep`);
  console.log("=".repeat(96));
  console.log("");

  try {
    const randomRows: RunResult[] = [];
    for (let s = 0; s < SEEDS; s += 1) {
      // A fresh context per run: progress lives in sessionStorage.
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      randomRows.push(await runSteps(page, url, STEPS, randomPicker(100 + s), GOAL));
      await ctx.close();
    }

    const jev = new Jev();
    const goal =
      "Buy something: get an item into the cart, work through every checkout step, and place the order. Do not empty the cart or delete the account.";
    const jevRows: RunResult[] = [];
    for (let s = 0; s < SEEDS; s += 1) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      if (VERBOSE) console.log(`  [jev run ${s}]`);
      jevRows.push(
        await runSteps(
          page,
          url,
          STEPS,
          jevPicker(jev, goal, VERBOSE ? (l) => console.log(`      ${l}`) : undefined),
          GOAL,
        ),
      );
      await ctx.close();
    }

    console.log("");
    summarise("random", randomRows);
    console.log("");
    summarise("jev", jevRows);
    console.log("");
    console.log(
      `  jev cost: ${jev.calls} calls, ${jev.inputTokens} input tokens, ` +
        `${(jev.totalMs / Math.max(jev.calls, 1)).toFixed(0)} ms/call, ` +
        `$${((jev.inputTokens / 1e6) * 0.042).toFixed(5)} for all ${SEEDS} runs`,
    );
    console.log("");
    if (VERBOSE && jevRows[0]) {
      console.log("  first jev run, in order:");
      jevRows[0].picks.forEach((p, i) => console.log(`    ${String(i).padStart(2)}. ${p}`));
      console.log("");
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
