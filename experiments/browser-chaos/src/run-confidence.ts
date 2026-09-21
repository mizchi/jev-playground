/**
 * Low-confidence fallback policies, measured.
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/run-confidence.ts \
 *     [--steps 22] [--seeds 3] [--policies baseline,random,...] \
 *     [--scenario clean|overlay|both] [--verbose]
 *
 * Two scenarios on the same app:
 *
 *   clean    the gated shop from docs/05. Every gate is stated in the page
 *            text, so this asks whether confidence is worth reading at all.
 *   overlay  `?overlay=1` arms a transparent full-screen backdrop left
 *            behind by a styled-away tip card. Nothing renders, nothing is
 *            logged, the text is unchanged — but every click lands on the
 *            backdrop. This asks what a policy does when the reason it is
 *            stuck is not expressible in text.
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { Jev } from "../../shared/jev.js";
import { POLICIES, runPolicy, type Policy, type RunResult, type StepLog } from "./confidence-bench.js";
// @ts-expect-error - plain .mjs helper, shared with run-spa.ts
import { serve } from "./serve.mjs";

const GOAL_STATE = "#/confirm";
const FLOW = ["#/cart", "#/checkout-1", "#/checkout-2", "#/checkout-3", "#/confirm"];
const ALL_STATES = [
  "#/home", "#/products", "#/cart", "#/checkout-1", "#/checkout-2",
  "#/checkout-3", "#/confirm", "#/settings", "#/about", "#/help",
  "#/faq", "#/blog", "#/contact", "#/danger",
];
const GOAL =
  "Buy something: get an item into the cart, work through every checkout step, and place the order. Do not empty the cart or delete the account.";

function numArg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number.parseInt(process.argv[i + 1] ?? "", 10);
  return Number.isFinite(v) ? v : fallback;
}
function strArg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const STEPS = numArg("steps", 22);
const SEEDS = numArg("seeds", 3);
const VERBOSE = process.argv.includes("--verbose");
const WANTED = strArg("policies", "").trim();
const SCENARIO = strArg("scenario", "both");

const policies: Policy[] = WANTED
  ? WANTED.split(",").map((n) => {
      const p = POLICIES.find((x) => x.name === n.trim());
      if (!p) throw new Error(`unknown policy '${n}'; have ${POLICIES.map((x) => x.name).join(", ")}`);
      return p;
    })
  : POLICIES;

function depth(states: string[]): number {
  let d = 0;
  for (let i = 0; i < FLOW.length; i += 1) if (states.includes(FLOW[i]!)) d = i + 1;
  return d;
}

interface ArmSummary {
  policy: string;
  rows: RunResult[];
  calls: number;
  inputTokens: number;
}

function summarise(arms: ArmSummary[]) {
  const head = ["policy", "depth", "ordered", "steps used", "wasted", "calls", "tokens"];
  const rows = arms.map((a) => {
    const depths = a.rows.map((r) => depth(r.states));
    const meanDepth = depths.reduce((x, y) => x + y, 0) / (depths.length || 1);
    const ordered = a.rows.filter((r) => r.reachedGoal).length;
    const used = a.rows.map((r) => r.log.length);
    const wasted = a.rows.map((r) => r.wastedSteps);
    const sum = (ns: number[]) => ns.reduce((x, y) => x + y, 0);
    return [
      a.policy,
      `${meanDepth.toFixed(1)}/${FLOW.length} (${depths.join(",")})`,
      `${ordered}/${a.rows.length}`,
      `${(sum(used) / used.length).toFixed(1)} (${used.join(",")})`,
      `${(sum(wasted) / wasted.length).toFixed(1)} (${wasted.join(",")})`,
      String(a.calls),
      String(a.inputTokens),
    ];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => "  " + cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  console.log(line(head));
  console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
}

/**
 * The question the fallback idea rests on: does a low confidence actually
 * mark the steps that go nowhere? Pooled over every step of every arm,
 * because it is a property of the signal, not of a policy.
 */
function calibration(all: StepLog[]) {
  const buckets: [string, (c: number) => boolean][] = [
    ["< 0.55", (c) => c < 0.55],
    ["0.55-0.70", (c) => c >= 0.55 && c < 0.7],
    ["0.70-0.85", (c) => c >= 0.7 && c < 0.85],
    [">= 0.85", (c) => c >= 0.85],
  ];
  console.log("  confidence   steps   no effect   advanced the flow");
  console.log("  ----------   -----   ---------   -----------------");
  for (const [label, test] of buckets) {
    const rows = all.filter((r) => test(r.confidence));
    if (rows.length === 0) {
      console.log(`  ${label.padEnd(10)}   ${String(0).padStart(5)}   ${"-".padStart(9)}   ${"-".padStart(17)}`);
      continue;
    }
    const noEffect = rows.filter((r) => !r.hadEffect).length;
    const advanced = rows.filter((r) => r.advanced).length;
    const pct = (n: number) => `${((n / rows.length) * 100).toFixed(0)}%`;
    console.log(
      `  ${label.padEnd(10)}   ${String(rows.length).padStart(5)}   ` +
        `${`${pct(noEffect)} (${noEffect})`.padStart(9)}   ${`${pct(advanced)} (${advanced})`.padStart(17)}`,
    );
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

  const scenarios: { name: string; url: string }[] = [];
  if (SCENARIO === "clean" || SCENARIO === "both") scenarios.push({ name: "clean", url });
  if (SCENARIO === "overlay" || SCENARIO === "both") {
    scenarios.push({ name: "overlay (invisible backdrop)", url: `${url}?overlay=1` });
  }

  const everyStep: StepLog[] = [];
  try {
    for (const scenario of scenarios) {
      console.log("");
      console.log("=".repeat(100));
      console.log(`  ${scenario.name} — ${STEPS} steps max x ${SEEDS} seeds, goal ${GOAL_STATE} is ${FLOW.length} gated states deep`);
      console.log("=".repeat(100));
      console.log("");

      const arms: ArmSummary[] = [];
      for (const policy of policies) {
        const jev = new Jev();
        const rows: RunResult[] = [];
        for (let s = 0; s < SEEDS; s += 1) {
          if (VERBOSE) console.log(`  [${policy.name} seed ${s}]`);
          const ctx = await browser.newContext();
          const page = await ctx.newPage();
          rows.push(
            await runPolicy({
              page,
              baseUrl: scenario.url,
              steps: STEPS,
              policy,
              jev,
              goal: GOAL,
              goalState: GOAL_STATE,
              flow: FLOW,
              seed: 1000 + s,
              trace: VERBOSE ? (l) => console.log(`      ${l}`) : undefined,
            }),
          );
          await ctx.close();
        }
        for (const r of rows) everyStep.push(...r.log);
        arms.push({ policy: policy.name, rows, calls: jev.calls, inputTokens: jev.inputTokens });
      }

      console.log("");
      summarise(arms);
      console.log("");
      const reach = arms.flatMap((a) => a.rows.flatMap((r) => r.states));
      console.log(
        `  distinct app states touched across all arms: ` +
          `${new Set(reach.filter((s) => ALL_STATES.includes(s))).size}/${ALL_STATES.length}`,
      );
    }

    console.log("");
    console.log("=".repeat(100));
    console.log("  CALIBRATION — is the confidence worth reading? (pooled over every step of every arm)");
    console.log("=".repeat(100));
    console.log("");
    calibration(everyStep);
    console.log("");
    const blockedRows = everyStep.filter((r) => r.wasBlocked);
    if (blockedRows.length > 0) {
      const noEffect = blockedRows.filter((r) => !r.hadEffect).length;
      console.log(
        `  picks the geometry called unclickable: ${blockedRows.length}, ` +
          `of which ${noEffect} changed nothing (${((noEffect / blockedRows.length) * 100).toFixed(0)}%)`,
      );
      const confs = blockedRows.map((r) => r.confidence);
      console.log(
        `  their confidences: ${confs.map((c) => c.toFixed(2)).join(", ")} ` +
          `(min ${Math.min(...confs).toFixed(2)})`,
      );
      console.log("");
    }

    // The mechanism behind the calibration table: what kind of step is the
    // model unsure about? If the low-confidence picks turn out to be
    // correct-but-unrewarding actions, a confidence threshold is standing
    // down on exactly the steps that needed taking.
    const unsure = everyStep.filter((r) => r.confidence < 0.85);
    if (unsure.length > 0) {
      console.log("  every pick below 0.85, and what came of it:");
      const seenPick = new Map<string, { n: number; conf: number[]; ok: number }>();
      for (const r of unsure) {
        const k = r.picked;
        const e = seenPick.get(k) ?? { n: 0, conf: [], ok: 0 };
        e.n += 1;
        e.conf.push(r.confidence);
        if (r.hadEffect) e.ok += 1;
        seenPick.set(k, e);
      }
      for (const [pick, e] of [...seenPick.entries()].sort((a, b) => b[1].n - a[1].n)) {
        console.log(
          `    ${String(e.n).padStart(2)}x  conf ${e.conf.map((c) => c.toFixed(2)).join("/")}  ` +
            `${e.ok}/${e.n} had an effect  —  ${pick}`,
        );
      }
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
