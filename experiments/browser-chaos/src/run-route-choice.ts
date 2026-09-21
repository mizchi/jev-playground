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

/**
 * `--decompose`: why does `express-first` make the 3-step path MORE
 * likely (0.690 -> 0.888)? (docs/27 §4.8)
 *
 * Because "express-first" is not one factor. `data-probe-idx` is stamped
 * in document order, so `?exfirst=1` moves two things at once:
 *
 *   numbering    express takes the lower index, so it also comes first
 *                in the criteria map the model is sent
 *   screen text  `#view` innerText lists Express before Proceed
 *
 * §4.7 called that "position" and it is really both. This loads BOTH
 * page variants, then sends the candidate map from one and the screen
 * text from the other — a 2x2 that separates them.
 *
 * The cost, stated because it is real: in the two mixed arms the
 * candidate map and the screen text disagree about the order, which is
 * a page no browser would produce. That is what decomposing costs here;
 * the endpoints are the genuine pages.
 */
const DECOMPOSE = process.argv.includes("--decompose");

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

/**
 * `--label-position`: the 2x2 of label x position, scored BY LABEL.
 *
 * §4.8's decomposition shows both channels of "express-first" push the
 * same way, but not what the push attaches to. If rendering second is
 * worth about +0.14 to whatever sits there, then the string "Proceed to
 * checkout" should gain when it is second — on either button. If instead
 * the effect follows the route, swapping the labels should reverse it.
 *
 * Four real pages, no mixing, and the mass is read by label rather than
 * by id, which is the only way to see which the effect tracks.
 */
const LABEL_POSITION = process.argv.includes("--label-position");

async function labelPosition(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  url: string,
): Promise<void> {
  const jev = new Jev();
  console.log("");
  console.log("=".repeat(100));
  console.log(`  LABEL x POSITION — scored by label, ${REPEAT} repeats per cell`);
  console.log("=".repeat(100));

  const cells: { name: string; query: string }[] = [
    { name: "P first,  E second", query: "" },
    { name: "E first,  P second", query: "&exfirst=1" },
    { name: "swap: E first,  P second", query: "&exswap=1" },
    { name: "swap: P first,  E second", query: "&exswap=1&exfirst=1" },
  ];
  const PROCEED = "Proceed to checkout";
  const EXPRESS = "Express checkout";

  const rows: { name: string; pP: number[]; pE: number[]; picked: string[]; order: string }[] = [];
  for (const cell of cells) {
    const pP: number[] = [];
    const pE: number[] = [];
    const picked: string[] = [];
    let order = "";
    for (let r = 0; r < REPEAT; r += 1) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await toCart(page, `${url}?routes=1${cell.query}`);
      const p = await probe(page);
      const criteria: Record<string, string> = {};
      // index -> the label actually rendered on that element.
      const labels = new Map<string, string>();
      for (const c of p.candidates) {
        const note = notableFacts(c);
        criteria[String(c.index)] = note ? `${c.description}  [${note}]` : c.description;
        labels.set(String(c.index), c.locator.name);
      }
      order = p.candidates
        .filter((c) => [PROCEED, EXPRESS].includes(c.locator.name))
        .map((c) => (c.locator.name === PROCEED ? "P" : "E"))
        .join(">");
      const res = await jev.ask(
        {
          goal: GOAL,
          current_url: "#/cart",
          screen: (await page.locator("#view").innerText()).slice(0, 1200),
          step: 2,
          states_seen: ["#/home", "#/products", "#/cart"],
          recent_actions: ['click button "Add Widget to cart"'],
          last_action: 'click button "Add Widget to cart"',
          last_action_changed_the_page: true,
          actions_with_no_effect_in_a_row: 0,
        },
        { pick: { type: "choice", instructions: PICK_SHIPPED, criteria } },
      );
      const a = res.answers["pick"];
      if (!a || a.type !== "choice") throw new Error("expected a choice answer");
      picked.push(labels.get(a.choice) === PROCEED ? "P" : labels.get(a.choice) === EXPRESS ? "E" : "?");
      const massForLabel = (want: string) => {
        let sum = 0;
        for (const [k, v] of Object.entries(a.probabilities)) {
          if (labels.get(k) === want) sum += v;
        }
        return sum;
      };
      pP.push(massForLabel(PROCEED));
      pE.push(massForLabel(EXPRESS));
      await ctx.close();
    }
    rows.push({ name: cell.name, pP, pE, picked, order });
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  console.log("");
  const w = Math.max(24, ...rows.map((r) => r.name.length));
  console.log(`  ${"cell".padEnd(w)}  order  picked      p("Proceed")  p("Express")`);
  console.log(`  ${"-".repeat(w)}  -----  ----------  ------------  ------------`);
  for (const r of rows) {
    const uniq = [...new Set(r.picked)];
    console.log(
      `  ${r.name.padEnd(w)}  ${r.order.padEnd(5)}  ` +
        `${(uniq.length === 1 ? `${uniq[0]} ${r.picked.length}/${r.picked.length}` : r.picked.join(",")).padEnd(10)}  ` +
        `${mean(r.pP).toFixed(3).padStart(12)}  ${mean(r.pE).toFixed(3).padStart(12)}`,
    );
  }
  console.log("");
  const p1 = mean(rows[0]!.pP), p2 = mean(rows[1]!.pP);
  const p3 = mean(rows[2]!.pP), p4 = mean(rows[3]!.pP);
  console.log(`  "Proceed" first -> second, normal labels:  ${p1.toFixed(3)} -> ${p2.toFixed(3)}  (${(p2 - p1 >= 0 ? "+" : "") + (p2 - p1).toFixed(3)})`);
  console.log(`  "Proceed" second -> first, swapped labels: ${p3.toFixed(3)} -> ${p4.toFixed(3)}  (${(p4 - p3 >= 0 ? "+" : "") + (p4 - p3).toFixed(3)})`);
  console.log("");
  console.log(
    `  cost: ${jev.calls} calls, ${jev.inputTokens} input tokens, ` +
      `$${((jev.inputTokens / 1e6) * 0.042).toFixed(5)}`,
  );
  console.log("");
}

/**
 * `--long-list`: does §4.8's ordering effect survive a long list, and
 * does it depend on how far apart the two contenders are? (docs/27 §4.9)
 *
 * §4.8 measured an ADJACENT pair holding 100% of the mass among 16
 * candidates. Two things could break at scale: the effect could be
 * local to adjacency, and 44 filler controls could take enough mass
 * that the two-way contest stops being one. Both are reported.
 *
 * Part 1 uses real pages only. `?wide=40` appends 40 filler controls and
 * `&fillerpos=before` prepends them, which puts the two contenders at
 * slots 0-1 or 40-41 of 46 — an absolute-position control that needs no
 * new flag. Crossed with `?exfirst=1` for their internal order.
 *
 * Part 2 varies the SEPARATION, which no page can do, so it reorders the
 * criteria map and says so: that measures the map channel alone, which
 * §4.8 put at about half the total effect.
 */
const LONG_LIST = process.argv.includes("--long-list");

/** Mass on each label, plus whatever the rest of the list took. */
function massByLabel(
  probabilities: Record<string, number>,
  labels: Map<string, string>,
  wanted: string[],
): { on: number[]; other: number } {
  const on = wanted.map(() => 0);
  let total = 0;
  for (const [k, v] of Object.entries(probabilities)) {
    total += v;
    const i = wanted.indexOf(labels.get(k) ?? "");
    if (i >= 0) on[i] += v;
  }
  return { on, other: Math.max(0, total - on.reduce((a, b) => a + b, 0)) };
}

const PROCEED_LABEL = "Proceed to checkout";
const EXPRESS_LABEL = "Express checkout";

async function longList(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  url: string,
): Promise<void> {
  const jev = new Jev();
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

  console.log("");
  console.log("=".repeat(100));
  console.log(`  LONG LIST — 46 candidates, ${REPEAT} repeats per cell`);
  console.log("=".repeat(100));

  // ---- Part 1: real pages, block position x internal order -----------
  const cells: { name: string; query: string }[] = [
    { name: "early block, P first", query: "&wide=40" },
    { name: "early block, E first", query: "&wide=40&exfirst=1" },
    { name: "late block,  P first", query: "&wide=40&fillerpos=before" },
    { name: "late block,  E first", query: "&wide=40&fillerpos=before&exfirst=1" },
  ];
  type Row = { name: string; pP: number[]; pE: number[]; other: number[]; picked: string[]; at: string };
  const rows: Row[] = [];

  for (const cell of cells) {
    const pP: number[] = [], pE: number[] = [], other: number[] = [], picked: string[] = [];
    let at = "";
    for (let r = 0; r < REPEAT; r += 1) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await toCart(page, `${url}?routes=1${cell.query}`);
      const p = await probe(page);
      const criteria: Record<string, string> = {};
      const labels = new Map<string, string>();
      for (const c of p.candidates) {
        const note = notableFacts(c);
        criteria[String(c.index)] = note ? `${c.description}  [${note}]` : c.description;
        labels.set(String(c.index), c.locator.name);
      }
      at = p.candidates
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => [PROCEED_LABEL, EXPRESS_LABEL].includes(c.locator.name))
        .map(({ c, i }) => `${c.locator.name === PROCEED_LABEL ? "P" : "E"}@${i}`)
        .join(" ");
      const res = await jev.ask(
        {
          goal: GOAL,
          current_url: "#/cart",
          screen: (await page.locator("#view").innerText()).slice(0, 1200),
          step: 2,
          states_seen: ["#/home", "#/products", "#/cart"],
          recent_actions: ['click button "Add Widget to cart"'],
          last_action: 'click button "Add Widget to cart"',
          last_action_changed_the_page: true,
          actions_with_no_effect_in_a_row: 0,
        },
        { pick: { type: "choice", instructions: PICK_SHIPPED, criteria } },
      );
      const a = res.answers["pick"];
      if (!a || a.type !== "choice") throw new Error("expected a choice answer");
      const m = massByLabel(a.probabilities, labels, [PROCEED_LABEL, EXPRESS_LABEL]);
      pP.push(m.on[0]!);
      pE.push(m.on[1]!);
      other.push(m.other);
      const chosen = labels.get(a.choice);
      picked.push(chosen === PROCEED_LABEL ? "P" : chosen === EXPRESS_LABEL ? "E" : "other");
      await ctx.close();
    }
    rows.push({ name: cell.name, pP, pE, other, picked, at });
  }

  console.log("");
  console.log("  Part 1 — real pages (?wide=40, ?fillerpos=before, ?exfirst=1)");
  const w = Math.max(20, ...rows.map((r) => r.name.length));
  console.log(`  ${"cell".padEnd(w)}  slots        picked      p("Proceed")  p("Express")  p(other 44)`);
  console.log(`  ${"-".repeat(w)}  -----------  ----------  ------------  ------------  -----------`);
  for (const r of rows) {
    const uniq = [...new Set(r.picked)];
    console.log(
      `  ${r.name.padEnd(w)}  ${r.at.padEnd(11)}  ` +
        `${(uniq.length === 1 ? `${uniq[0]} ${r.picked.length}/${r.picked.length}` : r.picked.join(",")).padEnd(10)}  ` +
        `${mean(r.pP).toFixed(3).padStart(12)}  ${mean(r.pE).toFixed(3).padStart(12)}  ${mean(r.other).toFixed(3).padStart(11)}`,
    );
  }
  console.log("");
  console.log(
    `  order effect, early block: ${mean(rows[0]!.pP).toFixed(3)} -> ${mean(rows[1]!.pP).toFixed(3)}` +
      `  (${(mean(rows[1]!.pP) - mean(rows[0]!.pP) >= 0 ? "+" : "") + (mean(rows[1]!.pP) - mean(rows[0]!.pP)).toFixed(3)})`,
  );
  console.log(
    `  order effect, late block:  ${mean(rows[2]!.pP).toFixed(3)} -> ${mean(rows[3]!.pP).toFixed(3)}` +
      `  (${(mean(rows[3]!.pP) - mean(rows[2]!.pP) >= 0 ? "+" : "") + (mean(rows[3]!.pP) - mean(rows[2]!.pP)).toFixed(3)})`,
  );
  console.log(
    `  block effect at P-first:   ${mean(rows[0]!.pP).toFixed(3)} -> ${mean(rows[2]!.pP).toFixed(3)}` +
      `  (${(mean(rows[2]!.pP) - mean(rows[0]!.pP) >= 0 ? "+" : "") + (mean(rows[2]!.pP) - mean(rows[0]!.pP)).toFixed(3)})`,
  );

  // ---- Part 2: separation, by reordering the criteria map -------------
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await toCart(page, `${url}?routes=1&wide=40`);
  const p = await probe(page);
  await ctx.close();

  const labels = new Map<string, string>();
  const entry = new Map<string, string>();
  for (const c of p.candidates) {
    const note = notableFacts(c);
    entry.set(String(c.index), note ? `${c.description}  [${note}]` : c.description);
    labels.set(String(c.index), c.locator.name);
  }
  const keyOf = (label: string) =>
    [...labels.entries()].find(([, v]) => v === label)?.[0] ?? "";
  const kP = keyOf(PROCEED_LABEL);
  const kE = keyOf(EXPRESS_LABEL);
  const fillers = [...entry.keys()].filter((k) => k !== kP && k !== kE);

  /** Build a map with `first` at slot 0 and `second` at slot `gap`. */
  const arrange = (first: string, second: string, gap: number): Record<string, string> => {
    const keys = [first, ...fillers];
    keys.splice(Math.min(gap, keys.length), 0, second);
    const out: Record<string, string> = {};
    for (const k of keys) out[k] = entry.get(k)!;
    return out;
  };

  const seps: { name: string; first: string; second: string; gap: number }[] = [];
  for (const gap of [1, 5, 15, 45]) {
    seps.push({ name: `P then E, gap ${gap}`, first: kP, second: kE, gap });
    seps.push({ name: `E then P, gap ${gap}`, first: kE, second: kP, gap });
  }

  const sepRows: { name: string; pP: number[]; pE: number[]; other: number[] }[] = [];
  for (const s of seps) {
    const pP: number[] = [], pE: number[] = [], other: number[] = [];
    const criteria = arrange(s.first, s.second, s.gap);
    for (let r = 0; r < REPEAT; r += 1) {
      const res = await jev.ask(
        {
          goal: GOAL,
          current_url: "#/cart",
          // Deliberately omitted: the screen text would contradict the
          // arrangement. This measures the candidate-map channel alone.
          step: 2,
          states_seen: ["#/home", "#/products", "#/cart"],
          recent_actions: ['click button "Add Widget to cart"'],
          last_action: 'click button "Add Widget to cart"',
          last_action_changed_the_page: true,
          actions_with_no_effect_in_a_row: 0,
        },
        { pick: { type: "choice", instructions: PICK_SHIPPED, criteria } },
      );
      const a = res.answers["pick"];
      if (!a || a.type !== "choice") throw new Error("expected a choice answer");
      const m = massByLabel(a.probabilities, labels, [PROCEED_LABEL, EXPRESS_LABEL]);
      pP.push(m.on[0]!);
      pE.push(m.on[1]!);
      other.push(m.other);
    }
    sepRows.push({ name: s.name, pP, pE, other });
  }

  console.log("");
  console.log("  Part 2 — separation, candidate map only (no screen text; see the note)");
  const w2 = Math.max(16, ...sepRows.map((r) => r.name.length));
  console.log(`  ${"arrangement".padEnd(w2)}  p("Proceed")  p("Express")  p(other 44)`);
  console.log(`  ${"-".repeat(w2)}  ------------  ------------  -----------`);
  for (const r of sepRows) {
    console.log(
      `  ${r.name.padEnd(w2)}  ${mean(r.pP).toFixed(3).padStart(12)}  ` +
        `${mean(r.pE).toFixed(3).padStart(12)}  ${mean(r.other).toFixed(3).padStart(11)}`,
    );
  }
  console.log("");
  for (const gap of [1, 5, 15, 45]) {
    const a = sepRows.find((r) => r.name === `P then E, gap ${gap}`)!;
    const b = sepRows.find((r) => r.name === `E then P, gap ${gap}`)!;
    const d = mean(b.pP) - mean(a.pP);
    console.log(
      `  gap ${String(gap).padStart(2)}: putting "Proceed" second is worth ` +
        `${(d >= 0 ? "+" : "") + d.toFixed(3)}  (${mean(a.pP).toFixed(3)} -> ${mean(b.pP).toFixed(3)})`,
    );
  }
  console.log("");
  console.log(
    `  cost: ${jev.calls} calls, ${jev.inputTokens} input tokens, ` +
      `$${((jev.inputTokens / 1e6) * 0.042).toFixed(5)}`,
  );
  console.log("");
}

/** What one page variant offers: the criteria map and the screen text. */
interface Captured {
  criteria: Record<string, string>;
  screen: string;
  /** index -> element id, for naming a pick. */
  ids: Map<string, string>;
  order: string;
}

async function capture(page: Page, base: string): Promise<Captured> {
  await toCart(page, base);
  const p = await probe(page);
  const criteria: Record<string, string> = {};
  const ids = new Map<string, string>();
  for (const c of p.candidates) {
    const note = notableFacts(c);
    criteria[String(c.index)] = note ? `${c.description}  [${note}]` : c.description;
    ids.set(String(c.index), c.locator.id ?? "");
  }
  return {
    criteria,
    screen: (await page.locator("#view").innerText()).slice(0, 1200),
    ids,
    order: p.candidates
      .filter((c) => ["checkout", "express"].includes(c.locator.id ?? ""))
      .map((c) => c.locator.id)
      .join(">"),
  };
}

async function decompose(browser: Awaited<ReturnType<typeof chromium.launch>>, url: string): Promise<void> {
  const jev = new Jev();
  console.log("");
  console.log("=".repeat(100));
  console.log(`  WHY express-first STRENGTHENS IT — numbering vs screen text, ${REPEAT} repeats`);
  console.log("=".repeat(100));

  // Capture each real page once; the criteria and screen text are
  // deterministic for a given variant, so one capture is enough.
  const grabbed: Record<"base" | "ex", Captured> = {} as never;
  for (const [key, q] of [["base", ""], ["ex", "&exfirst=1"]] as const) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    grabbed[key] = await capture(page, `${url}?routes=1${q}`);
    await ctx.close();
  }
  console.log("");
  console.log(`  captured: base candidates ${grabbed.base.order}, exfirst candidates ${grabbed.ex.order}`);
  const firstLine = (s: string) =>
    s.split("\n").map((l) => l.trim()).filter((l) => /checkout/i.test(l))[0] ?? "?";
  console.log(`  base screen first checkout-ish line:    "${firstLine(grabbed.base.screen)}"`);
  console.log(`  exfirst screen first checkout-ish line: "${firstLine(grabbed.ex.screen)}"`);

  const arms: { name: string; cands: "base" | "ex"; screen: "base" | "ex" }[] = [
    { name: "base (both base)", cands: "base", screen: "base" },
    { name: "numbering only", cands: "ex", screen: "base" },
    { name: "screen text only", cands: "base", screen: "ex" },
    { name: "exfirst (both ex)", cands: "ex", screen: "ex" },
  ];

  const rows: { name: string; picks: string[]; pS: number[]; pE: number[] }[] = [];
  for (const arm of arms) {
    const picks: string[] = [];
    const pS: number[] = [];
    const pE: number[] = [];
    const g = grabbed[arm.cands];
    for (let r = 0; r < REPEAT; r += 1) {
      const res = await jev.ask(
        {
          goal: GOAL,
          current_url: "#/cart",
          screen: grabbed[arm.screen].screen,
          step: 2,
          states_seen: ["#/home", "#/products", "#/cart"],
          recent_actions: ['click button "Add Widget to cart"'],
          last_action: 'click button "Add Widget to cart"',
          last_action_changed_the_page: true,
          actions_with_no_effect_in_a_row: 0,
        },
        { pick: { type: "choice", instructions: PICK_SHIPPED, criteria: g.criteria } },
      );
      const a = res.answers["pick"];
      if (!a || a.type !== "choice") throw new Error("expected a choice answer");
      picks.push(g.ids.get(a.choice) || `?${a.choice}`);
      const massFor = (want: string) => {
        for (const [k, v] of Object.entries(a.probabilities)) {
          if (g.ids.get(k) === want) return v;
        }
        return 0;
      };
      pS.push(massFor("checkout"));
      pE.push(massFor("express"));
      if (VERBOSE) {
        console.log(`  [${arm.name} r${r}] chose ${picks[picks.length - 1]} @${a.confidence.toFixed(2)}`);
      }
    }
    rows.push({ name: arm.name, picks, pS, pE });
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  console.log("");
  const w = Math.max(18, ...rows.map((r) => r.name.length));
  console.log(`  ${"arm".padEnd(w)}  candidates  screen text  picked            p(3-step)  p(express)`);
  console.log(`  ${"-".repeat(w)}  ----------  -----------  ----------------  ---------  ----------`);
  for (const [i, r] of rows.entries()) {
    const a = arms[i]!;
    const uniq = [...new Set(r.picks)];
    console.log(
      `  ${r.name.padEnd(w)}  ${a.cands.padEnd(10)}  ${a.screen.padEnd(11)}  ` +
        `${(uniq.length === 1 ? `${uniq[0]} ${r.picks.length}/${r.picks.length}` : r.picks.join(",")).padEnd(16)}  ` +
        `${mean(r.pS).toFixed(3).padStart(9)}  ${mean(r.pE).toFixed(3).padStart(10)}`,
    );
  }
  console.log("");
  console.log(
    `  cost: ${jev.calls} calls, ${jev.inputTokens} input tokens, ` +
      `$${((jev.inputTokens / 1e6) * 0.042).toFixed(5)}`,
  );
  console.log("");
}

async function main(): Promise<void> {
  const { server, url } = (await serve(0)) as { server: { close(): void }; url: string };
  const exe = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    ...(existsSync(exe) ? { executablePath: exe } : {}),
  });
  if (DECOMPOSE || LABEL_POSITION || LONG_LIST) {
    try {
      if (DECOMPOSE) await decompose(browser, url);
      if (LABEL_POSITION) await labelPosition(browser, url);
      if (LONG_LIST) await longList(browser, url);
    } finally {
      await browser.close();
      server.close();
    }
    return;
  }

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
