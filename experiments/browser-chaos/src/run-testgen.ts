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

const GOAL =
  "Buy a Widget: put one in the cart, work through every checkout step, and place the order.";
const VERBOSE = process.argv.includes("--verbose");
const OUT = join(import.meta.dirname, "..", "generated");
const execFileAsync = promisify(execFile);
/** Playwright colours its reporter output; strip it before matching. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[\\d;]*[A-Za-z]`, "g");

/**
 * Which mutations are real bugs. `label` renames two buttons and `slow`
 * delays rendering — neither breaks the app, so a spec that fails on them
 * is brittle rather than thorough. Established by check-bugs.ts, not by
 * assumption.
 */
const MUTATIONS: { bug: string; isBug: boolean; what: string }[] = [
  { bug: "cart", isBug: true, what: "add-to-cart stops adding" },
  { bug: "order", isBug: true, what: "the order is never recorded" },
  { bug: "gate", isBug: true, what: "checkout step 2 stops requiring an email" },
  { bug: "label", isBug: false, what: "the Continue buttons are renamed" },
  { bug: "slow", isBug: false, what: "every render is delayed 400ms" },
];

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
): Promise<{ passed: boolean; firstFailure?: string }> {
  try {
    await execFileAsync(
      "npx",
      ["playwright", "test", "--config", join(OUT, "playwright.config.ts"), file],
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

async function main() {
  const { server, url } = (await serve(0)) as { server: { close(): void }; url: string };
  const exe = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    ...(existsSync(exe) ? { executablePath: exe } : {}),
  });

  try {
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
      baseUrl: url,
      steps: 20,
      // The best policy from docs/25: never offer a control the geometry
      // says cannot be clicked.
      policy: { name: "probe-prune", minConfidence: 0, mode: "probe-prune" },
      jev,
      goal: GOAL,
      goalState: "#/confirm",
      flow: ["#/cart", "#/checkout-1", "#/checkout-2", "#/checkout-3", "#/confirm"],
      seed: 7,
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
      return;
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
      grid[spec.name]!["(clean)"] = (await runSpec(spec.file, url)).passed;
      for (const m of MUTATIONS) {
        const r = await runSpec(spec.file, `${url}?bug=${m.bug}`);
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
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
