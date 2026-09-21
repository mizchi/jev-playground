/**
 * Coverage-guided exploration: does naming the code that has not run help?
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/run-coverage.ts [--steps 18] [--seeds 3] [--verbose]
 *
 * The board is the same shop with `?branches=1`, which makes four of the
 * decoy buttons real. Each is a named function that changes internal state
 * and the status line but **never the hash** — so novelty measured over
 * URLs, which is what chaosbringer's crawler and both pickers in docs/05
 * use, cannot see them at all. V8 function coverage can.
 *
 * Three arms:
 *
 *   blind     states_seen only, as in docs/05
 *   listed    plus `code_not_yet_executed: ["applyPromoCode", ...]` — the
 *             obvious way to pass coverage, as a list in the state
 *   mapped    the same names, resolved in code to the control that would
 *             call them, and attached to THAT candidate
 *   listed-camel  the exact names `in-goal` uses, still as a list in
 *             the state -- isolates placement from selectivity
 *   in-goal   those names folded into the GOAL SENTENCE instead of
 *             sat beside it as data
 *
 * `listed` and `mapped` send the same facts. The only difference is
 * whether the join from code to control was done by the caller or left
 * for the model, which is the question worth asking.
 *
 * The goal is exploration rather than checkout, so the metric is how many
 * of the four branches ran inside the budget — and, as a control, whether
 * the hint costs anything in states reached.
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { Jev } from "../../shared/jev.js";
import { runPolicy, type RunResult } from "./confidence-bench.js";
import { matchUncovered } from "./code-map.js";
import { FunctionCoverage } from "./coverage.js";
// @ts-expect-error - plain .mjs helper, shared with run-spa.ts
import { serve } from "./serve.mjs";

/**
 * The same names, but stated as what the run is FOR rather than as a
 * fact beside the goal. docs/58 §5: a feasibility fact belongs on the
 * candidate, a desirability fact has to out-argue the goal — so put it
 * in the goal.
 */
function camelOnly(uncovered: ReadonlySet<string>): string[] {
  // camelCase separates handlers from the rest of the uncovered set on
  // this fixture: the routes are keys like `#/danger` and the helpers are
  // `save`, `go`, `update`. A convenience of the fixture, not a law.
  return [...uncovered].filter((n) => /[a-z][A-Z]/.test(n)).sort();
}

function goalWithUncovered(uncovered: ReadonlySet<string>): string {
  const names = camelOnly(uncovered);
  if (names.length === 0) return GOAL;
  return (
    `${GOAL} Specifically, this app has behaviour that has never run yet. ` +
    `Its own function names for it are: ${names.join(", ")}. ` +
    `Find the control on some screen whose label matches one of those names and use it.`
  );
}

/**
 * `goal-fact`: the names in the goal sentence with the LAST sentence of
 * `goalWithUncovered` removed — so the goal carries the fact but never
 * says to act on it.
 *
 * Together with `state-instr` this fills in the off-diagonal of a 2x2
 * that §4 only ran the diagonal of. `listed-camel` is (state, no
 * instruction) and `in-goal` is (goal, instruction), so those two differ
 * in *both* factors at once and cannot separate them. §5 explains the
 * gap by competition with the goal, which is a claim about the
 * instruction; the obvious rival is that the goal sentence is simply
 * read more carefully than a state array, which is a claim about place.
 */
function goalFactOnly(uncovered: ReadonlySet<string>): string {
  const names = camelOnly(uncovered);
  if (names.length === 0) return GOAL;
  return (
    `${GOAL} Specifically, this app has behaviour that has never run yet. ` +
    `Its own function names for it are: ${names.join(", ")}.`
  );
}

/**
 * `state-instr`: the instruction in the goal, the names left in the
 * state. The model has to do the join itself, which is the same join
 * `mapped` does in code.
 */
// A function, not a const: `GOAL` is declared below these helpers, so a
// top-level template literal reading it hits the temporal dead zone.
function goalInstrOnly(): string {
  return (
    `${GOAL} Some of this app's behaviour has never run yet; the state field ` +
    `\`code_not_yet_executed\` lists its own function names for it. Find the ` +
    `control on some screen whose label matches one of those names and use it.`
  );
}

function goalFor(arm: string, uncovered: ReadonlySet<string>): string {
  if (arm === "in-goal") return goalWithUncovered(uncovered);
  if (arm === "goal-fact") return goalFactOnly(uncovered);
  if (arm === "state-instr") return goalInstrOnly();
  return GOAL;
}

const ALL_ARMS = [
  "blind", "listed", "listed-camel", "mapped", "in-goal",
  "goal-fact", "state-instr",
] as const;

/** `--arms listed-camel,in-goal,...` to re-run a subset. */
function selectedArms(): readonly string[] {
  const i = process.argv.indexOf("--arms");
  if (i === -1) return ALL_ARMS;
  const want = new Set((process.argv[i + 1] ?? "").split(",").filter(Boolean));
  const picked = ALL_ARMS.filter((a) => want.has(a));
  if (picked.length === 0) {
    console.error(`no arm matched; expected some of ${ALL_ARMS.join(", ")}`);
    process.exit(1);
  }
  return picked;
}

/** The four functions `?branches=1` wires up. */
const BRANCHES = ["applyPromoCode", "compareSelected", "subscribeToNewsletter", "addGiftWrap"];
const ALL_STATES = [
  "#/home", "#/products", "#/cart", "#/checkout-1", "#/checkout-2",
  "#/checkout-3", "#/confirm", "#/settings", "#/about", "#/help",
  "#/faq", "#/blog", "#/contact", "#/danger",
];
const GOAL =
  "Explore this app as thoroughly as you can: reach states you have not seen, and exercise behaviour you have not exercised yet. Do not delete the account.";

function numArg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number.parseInt(process.argv[i + 1] ?? "", 10);
  return Number.isFinite(v) ? v : fallback;
}

const STEPS = numArg("steps", 18);
const SEEDS = numArg("seeds", 3);
const VERBOSE = process.argv.includes("--verbose");

interface ArmRow {
  arm: string;
  rows: RunResult[];
  /** Which of BRANCHES executed, per seed. */
  hit: string[][];
  /** How many candidate annotations actually fired, per seed. */
  notes: number[];
  calls: number;
  tokens: number;
}

async function main() {
  const { server, url } = (await serve(0)) as { server: { close(): void }; url: string };
  const exe = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    ...(existsSync(exe) ? { executablePath: exe } : {}),
  });
  const target = `${url}?branches=1`;

  console.log("");
  console.log("=".repeat(100));
  console.log(`  COVERAGE GUIDANCE — ${STEPS} steps x ${SEEDS} seeds, 4 branches reachable without a hash change`);
  console.log("=".repeat(100));

  const arms: ArmRow[] = [];
  try {
    for (const arm of selectedArms()) {
      const jev = new Jev();
      const rows: RunResult[] = [];
      const hit: string[][] = [];
      const notes: number[] = [];
      for (let s = 0; s < SEEDS; s += 1) {
        if (VERBOSE) console.log(`\n  [${arm} seed ${s}]`);
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const cdp = await ctx.newCDPSession(page);
        // Rejecting the empty URL is load-bearing: that is Playwright's
        // own injected utility script, ~700 function names deep.
        const cov = new FunctionCoverage(cdp, (u) => u.startsWith(url));
        await cov.start();
        // The inventory has to be taken before anything else runs scripts
        // in the page — see coverage.ts. `runPolicy` does its one `goto`
        // first, so prime the page here and let it navigate by hash.
        await page.goto(target, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(120);
        await cov.captureInventory();
        // Refreshed by extraState each step; annotate() reads it.
        let lastUncovered: ReadonlySet<string> = new Set<string>();
        // A ~10-token note is invisible in the total, so count the fires
        // rather than inferring them from the token delta.
        let fired = 0;

        const result = await runPolicy({
          page,
          baseUrl: target,
          steps: STEPS,
          policy: { name: arm, minConfidence: 0, mode: "none" },
          jev,
          goal:
            arm === "in-goal" || arm === "goal-fact"
              ? () => goalFor(arm, lastUncovered)
              : goalFor(arm, new Set<string>()),
          goalState: "#/confirm",
          flow: ["#/cart", "#/checkout-1", "#/checkout-2", "#/checkout-3", "#/confirm"],
          seed: 2000 + s,
          alreadyLoaded: true,
          trace: VERBOSE ? (l) => console.log(`      ${l}`) : undefined,
          // `listed` puts the names in the state; `mapped` puts each name
          // on the candidate that would call it. Both refresh the set
          // before every step, so neither is working from stale coverage.
          extraState:
            arm === "blind"
              ? undefined
              : async () => {
                  const { uncovered } = await cov.split();
                  lastUncovered = uncovered;
                  if (arm === "listed") {
                    return { code_not_yet_executed: [...uncovered].sort() };
                  }
                  if (arm === "listed-camel" || arm === "state-instr") {
                    // The same names `in-goal` names, in the same order,
                    // still as data beside the goal. This is the arm that
                    // separates WHERE the fact sits from WHICH facts.
                    // `state-instr` sends the identical field and differs
                    // only in that its goal says to act on it.
                    return { code_not_yet_executed: camelOnly(uncovered) };
                  }
                  return {};
                },
          annotate:
            arm === "mapped"
              ? (c) => {
                  const note = matchUncovered(c.description, lastUncovered);
                  if (note) fired += 1;
                  return note;
                }
              : undefined,
          // Exploration, not checkout: run the whole budget.
          done: () => false,
        });

        const { covered } = await cov.split();
        hit.push(BRANCHES.filter((b) => covered.has(b)));
        notes.push(fired);
        await cov.stop();
        rows.push(result);
        await ctx.close();
      }
      arms.push({ arm, rows, hit, notes, calls: jev.calls, tokens: jev.inputTokens });
    }

    console.log("");
    const head = ["arm", "branches run", "which", "states", "wasted", "calls", "tokens"];
    const body = arms.map((a) => {
      const counts = a.hit.map((h) => h.length);
      const mean = counts.reduce((x, y) => x + y, 0) / (counts.length || 1);
      const states = a.rows.map((r) => r.states.filter((s) => ALL_STATES.includes(s)).length);
      const meanStates = states.reduce((x, y) => x + y, 0) / (states.length || 1);
      const wasted = a.rows.map((r) => r.wastedSteps);
      return [
        a.arm,
        `${mean.toFixed(2)}/4 (${counts.join(",")})`,
        [...new Set(a.hit.flat())].sort().join(" ") || "-",
        `${meanStates.toFixed(1)}/${ALL_STATES.length} (${states.join(",")})`,
        `${(wasted.reduce((x, y) => x + y, 0) / wasted.length).toFixed(1)} (${wasted.join(",")})`,
        String(a.calls),
        String(a.tokens),
      ];
    });
    const w = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
    const line = (c: string[]) => "  " + c.map((x, i) => x.padEnd(w[i]!)).join("  ");
    console.log(line(head));
    console.log("  " + w.map((x) => "-".repeat(x)).join("  "));
    for (const r of body) console.log(line(r));
    console.log("");

    // `--arms` can exclude blind, so there may be no baseline to
    // compare tokens against; print the absolute number in that case
    // rather than crashing after the table has already been printed.
    const blind = arms.find((a) => a.arm === "blind");
    const perSeed = (a: ArmRow) => a.hit.map((h) => h.length).reduce((x, y) => x + y, 0);
    for (const a of arms) {
      console.log(
        `  ${a.arm.padEnd(13)} branches ${perSeed(a)}/${SEEDS * 4}` +
          (!blind
            ? `   tokens ${a.tokens}   annotations fired ${a.notes.reduce((x, y) => x + y, 0)}`
            : a === blind
              ? ""
              : `   tokens vs blind ${(((a.tokens - blind.tokens) / blind.tokens) * 100).toFixed(1)}%` +
                `   annotations fired ${a.notes.reduce((x, y) => x + y, 0)}`),
      );
    }
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
