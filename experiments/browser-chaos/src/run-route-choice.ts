/**
 * Why does the choice collapse onto one route? (docs/27 §4.7)
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/run-route-choice.ts [--repeat 3] [--verbose]
 *
 * §4.6 gave the goal four routes and got 5/5 the same one. `--neutral-goal`
 * ruled out the goal sentence. That left three explanations, and this
 * measures them one at a time on the ONE decision that picks the route:
 * the cart screen, where "Proceed to checkout" and "Express checkout" sit
 * side by side.
 *
 * A whole 7-step run per condition would be wasteful and would also mix
 * the route decision with six others, so this drives to the cart state
 * deterministically by id, probes, and asks the single `pick` question —
 * reading the full distribution rather than just the argmax, because
 * "0.51 vs 0.49, tie broken by argmax" and "0.95 vs 0.02" are completely
 * different explanations of the same 5/5.
 *
 * The conditions:
 *
 *   base            as shipped
 *   no-multistep    the picker's instruction with "prefer advancing a
 *                   multi-step flow over restarting it" REMOVED. That
 *                   clause predates this board — it was written to stop
 *                   the crawl restarting checkout — and it names the
 *                   3-step path. §4.6's --neutral-goal could not touch
 *                   it, because it lives in the question, not the goal.
 *   express-first   `?exfirst=1`: express rendered first. Position moves,
 *                   wording stays.
 *   labels-swapped  `?exswap=1`: the two labels exchanged. Wording moves,
 *                   position stays.
 *   express-only    "Proceed to checkout" withheld from the offer. A
 *                   capability control: if express is never chosen even
 *                   when it is the only way on, the preference is not a
 *                   preference.
 *
 * One request per condition per repeat. There is no browser work between
 * repeats, so this is cheap.
 */
import { existsSync } from "node:fs";
import { chromium, type Page } from "playwright";
import { Jev, type Question } from "../../shared/jev.js";
import { probe, notableFacts, type ProbedCandidate } from "./probes.js";
// @ts-expect-error - plain .mjs helper
import { serve } from "./serve.mjs";

const GOAL =
  "Buy a Widget: put one in the cart, work through every checkout step, and place the order.";

/** The instruction `confidence-bench.ts` ships, verbatim. */
const PICK_SHIPPED =
  "Which control moves furthest toward the goal? Prefer opening a state not in states_seen, and prefer advancing a multi-step flow over restarting it. If the last action changed nothing, the step is gated on something you have not done yet — fill a required field, or clear whatever is in the way, instead of pressing the same button again.";

/** The same, with the clause that names a route taken out. */
const PICK_NO_MULTISTEP =
  "Which control moves furthest toward the goal? Prefer opening a state not in states_seen. If the last action changed nothing, the step is gated on something you have not done yet — fill a required field, or clear whatever is in the way, instead of pressing the same button again.";

interface Condition {
  name: string;
  /** Query string appended to the board. */
  query: string;
  instructions: string;
  /** Candidate ids to withhold from the offer. */
  withhold?: string[];
}

const CONDITIONS: Condition[] = [
  { name: "base", query: "", instructions: PICK_SHIPPED },
  { name: "no-multistep", query: "", instructions: PICK_NO_MULTISTEP },
  { name: "express-first", query: "&exfirst=1", instructions: PICK_SHIPPED },
  { name: "labels-swapped", query: "&exswap=1", instructions: PICK_SHIPPED },
  { name: "express-only", query: "", instructions: PICK_SHIPPED, withhold: ["checkout"] },
];

function numArg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const n = Number.parseInt(process.argv[i + 1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const REPEAT = numArg("repeat", 3);
const VERBOSE = process.argv.includes("--verbose");

/**
 * Put the app in the state the route decision is made from: one item in
 * the cart, sitting on `#/cart`. By id, so the harness's own picker plays
 * no part in reaching it.
 */
async function toCart(page: Page, base: string): Promise<void> {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.evaluate(`location.hash = "#/products"`);
  await page.waitForTimeout(300);
  await page.locator("#add").click({ timeout: 4000 });
  await page.waitForTimeout(300);
  await page.evaluate(`location.hash = "#/cart"`);
  await page.waitForTimeout(400);
}

async function main(): Promise<void> {
  const { server, url } = (await serve(0)) as { server: { close(): void }; url: string };
  const exe = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    ...(existsSync(exe) ? { executablePath: exe } : {}),
  });
  const jev = new Jev();

  console.log("");
  console.log("=".repeat(100));
  console.log(`  WHY ONE ROUTE — the cart decision, ${REPEAT} repeats per condition`);
  console.log("=".repeat(100));

  type Row = {
    cond: string;
    picks: string[];
    pSteps: number[];
    pExpress: number[];
    offered: number;
    order: string;
  };
  const rows: Row[] = [];

  try {
    for (const cond of CONDITIONS) {
      const picks: string[] = [];
      const pSteps: number[] = [];
      const pExpress: number[] = [];
      let offered = 0;
      let order = "";

      for (let r = 0; r < REPEAT; r += 1) {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await toCart(page, `${url}?routes=1${cond.query}`);
        const p = await probe(page);

        // Map ids so a pick can be named regardless of index.
        const byIndex = new Map<number, ProbedCandidate>();
        for (const c of p.candidates) byIndex.set(c.index, c);
        const offer = p.candidates.filter(
          (c) => !(cond.withhold ?? []).includes(c.locator.id ?? ""),
        );
        offered = offer.length;
        order = offer
          .filter((c) => ["checkout", "express"].includes(c.locator.id ?? ""))
          .map((c) => c.locator.id)
          .join(">");

        const criteria: Record<string, string> = {};
        for (const c of offer) {
          const note = notableFacts(c);
          criteria[String(c.index)] = note ? `${c.description}  [${note}]` : c.description;
        }
        const questions: Record<string, Question> = {
          pick: { type: "choice", instructions: cond.instructions, criteria },
        };
        const state = {
          goal: GOAL,
          current_url: "#/cart",
          screen: (await page.locator("#view").innerText()).slice(0, 1200),
          step: 2,
          states_seen: ["#/home", "#/products", "#/cart"],
          recent_actions: ['click button "Add Widget to cart"'],
          last_action: 'click button "Add Widget to cart"',
          last_action_changed_the_page: true,
          actions_with_no_effect_in_a_row: 0,
        };

        const res = await jev.ask(state, questions);
        const a = res.answers["pick"];
        if (!a || a.type !== "choice") throw new Error("expected a choice answer");
        const chosen = byIndex.get(Number(a.choice));
        const id = chosen?.locator.id ?? `?${a.choice}`;
        picks.push(id);

        // Probability mass on each route, by id rather than index.
        const massFor = (wanted: string): number => {
          for (const [k, v] of Object.entries(a.probabilities)) {
            if (byIndex.get(Number(k))?.locator.id === wanted) return v;
          }
          return 0;
        };
        pSteps.push(massFor("checkout"));
        pExpress.push(massFor("express"));

        if (VERBOSE) {
          console.log(`\n  [${cond.name} r${r}] offered ${offer.length}, order ${order}`);
          const top = Object.entries(a.probabilities)
            .sort((x, y) => y[1] - x[1])
            .slice(0, 4)
            .map(([k, v]) => `${byIndex.get(Number(k))?.locator.id ?? k}=${v.toFixed(3)}`);
          console.log(`      chose ${id} @${a.confidence.toFixed(2)}   ${top.join("  ")}`);
        }
        await ctx.close();
      }
      rows.push({ cond: cond.name, picks, pSteps, pExpress, offered, order });
    }
  } finally {
    await browser.close();
    server.close();
  }

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  console.log("");
  const w = Math.max(14, ...CONDITIONS.map((c) => c.name.length));
  console.log(
    `  ${"condition".padEnd(w)}  offered  page order        picked            p(3-step)  p(express)`,
  );
  console.log(`  ${"-".repeat(w)}  -------  ---------------  ----------------  ---------  ----------`);
  for (const r of rows) {
    const uniq = [...new Set(r.picks)];
    console.log(
      `  ${r.cond.padEnd(w)}  ${String(r.offered).padStart(7)}  ${(r.order || "-").padEnd(15)}  ` +
        `${(uniq.length === 1 ? `${uniq[0]} ${r.picks.length}/${r.picks.length}` : r.picks.join(",")).padEnd(16)}  ` +
        `${mean(r.pSteps).toFixed(3).padStart(9)}  ${mean(r.pExpress).toFixed(3).padStart(10)}`,
    );
  }
  console.log("");
  console.log(
    `  cost: ${jev.calls} calls, ${jev.inputTokens} input tokens, ` +
      `$${((jev.inputTokens / 1e6) * 0.042).toFixed(5)}`,
  );
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
