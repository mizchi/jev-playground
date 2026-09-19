/**
 * The experiment docs/29 §8 said it had not run: try to break the
 * speculation.
 *
 *   TYPESAFEAI_API_KEY=… npx tsx src/run-adversarial.ts \
 *     --fixture hostile|twin|slots|slots-hard [--runs 2] [--steps 10] [--verbose]
 *
 * The boards and their trap graders live in `adversarial-fixtures.ts`,
 * which `check-fanout.ts` tests without a browser.
 *
 * docs/29 compared `fanout` against `sequential` on outcomes and found
 * them identical. That is weak evidence for two reasons, and this fixes
 * both:
 *
 *   1. **It only ever read the winning head.** The losing heads were
 *      answered and discarded unmeasured — and on the next step a loser
 *      becomes the winner, so their quality matters just as much. Here
 *      every head of every fan-out is compared against the same head
 *      asked alone with the operation given as a decided fact.
 *
 *   2. **The board was easy.** On the docs/29 fixture the operation was
 *      obvious at almost every step, so there was little for speculation
 *      to get wrong. `hostile` contests it: a required empty field beside
 *      an optional empty one, a shipping dropdown beside a gift-wrap
 *      dropdown, and a gated Place order beside two buttons that are
 *      busywork. Every head has a trap that is attractive on its own
 *      terms. `twin` adds a near-duplicate of the working button that
 *      passes the same gate, so it is invisible to "goal reached".
 *
 *      `slots` and `slots-hard` attack the other side. They offer
 *      buttons and nothing else, so the operation is CLICK by
 *      construction and the whole contest sits inside one head — and the
 *      discriminator is page state that the GOAL never mentions, so
 *      neither the criteria nor the goal carry the answer.
 *
 * Two more controls, neither of which docs/29 ran:
 *
 *   - **Operation perturbation.** The operation head is also asked with
 *     nothing else in the request. Fan-out puts four questions in one
 *     request and the model sees all of them; if their presence moves the
 *     operation distribution, "identical decisions" was a property of the
 *     board and not of the shape.
 *   - **Trap rate per head, speculative vs conditioned.** Agreement is
 *     not enough: two heads can agree and both be wrong. What matters is
 *     whether speculating makes a head reach for a trap more often.
 *
 * Five requests per step, so this is deliberately expensive. The run
 * itself is a real `fanout` run — the fan-out answer is what executes, and
 * the conditioned asks are observations beside it.
 */
import { chromium, type Page } from "playwright";
import { Jev } from "../../shared/jev.js";
import {
  actionSpace,
  askFanoutAllHeads,
  askOperationAlone,
  askTargetConditioned,
  defaultOption,
  totalVariation,
  type FanoutState,
  type HeadAnswer,
  type Operation,
} from "./fanout.js";
import { FIXTURES, type Fixture } from "./adversarial-fixtures.js";
import { fillValue } from "./confidence-bench.js";
import { probe, type ProbedCandidate } from "./probes.js";
// @ts-expect-error - plain .mjs helper, shared with the other runners.
import { serve } from "./serve.mjs";

const TARGETED: Operation[] = ["CLICK", "TYPE_TEXT", "SELECT"];

const SCREEN_TEXT = `(() => {
  const body = (document.body.innerText || "").trim().replace(/\\n{3,}/g, "\\n\\n");
  const fields = Array.from(document.querySelectorAll("input, textarea, select"))
    .map((el) => (el.id || "field") + ": " + (el.value ? '"' + el.value + '"' : "(empty)"))
    .join("; ");
  return (body + (fields ? "\\nfields -> " + fields : "")).slice(0, 1200);
})()`;

const SIGNATURE = `(() => {
  const fields = Array.from(document.querySelectorAll("input, textarea, select"))
    .map((el) => (el.id || "") + "=" + (el.value || "")).join(",");
  return location.hash + "|" + (document.getElementById("view") || {}).innerHTML + "|" + fields;
})()`;

/** Type-aware, and it has to know the recipient the goal named. */
function valueFor(description: string): string {
  if (/recipient/i.test(description)) return "Ada Lovelace";
  return fillValue(description);
}

interface HeadComparison {
  step: number;
  op: Operation;
  /** Was this the head the operation actually named? */
  used: boolean;
  speculative: string;
  conditioned: string;
  agreed: boolean;
  /** Total variation between the two distributions over the same keys. */
  tv: number;
  specConfidence: number;
  condConfidence: number;
  specTrap: boolean;
  condTrap: boolean;
  offered: number;
}

interface StepRow {
  step: number;
  /** Operation chosen by the fan-out request (the one that executed). */
  operation: Operation;
  /** Operation chosen when the head was asked with nothing else present. */
  operationAlone: Operation;
  operationAgreed: boolean;
  operationTv: number;
  fanoutConfidence: number;
  aloneConfidence: number;
  executed: string;
  hadEffect: boolean;
  heads: HeadComparison[];
}

async function evalString(page: Page, source: string): Promise<string> {
  return (await page.evaluate(source)) as string;
}

/**
 * Land directly on checkout-3, whichever board is mounted there.
 *
 * Seeding the earlier steps rather than walking them is what makes this
 * affordable: every step spent on `#/products` is five requests that
 * measure an uncontested decision. The seed only fills in what the
 * earlier screens would have set.
 */
async function seedToBoard(page: Page, baseUrl: string): Promise<void> {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    sessionStorage.setItem(
      "chaos-target-progress",
      JSON.stringify({
        cart: 1,
        email: "ada@example.com",
        address: "1 Example Street",
        step: 0,
        ordered: false,
        shipping: "",
        recipient: "",
        promo: "",
        giftwrap: "",
      }),
    );
  });
  await page.goto(`${baseUrl}#/checkout-3`, { waitUntil: "domcontentloaded" });
  // Same path and search, so the hash change alone does not re-run the
  // app and the seed would never be read.
  await page.reload({ waitUntil: "domcontentloaded" });
}

async function act(page: Page, c: ProbedCandidate): Promise<{ ok: boolean; error?: string }> {
  try {
    const el = page.locator(c.selector).first();
    if (c.type === "select") {
      const value = c.chosenOption ?? defaultOption(c);
      if (value === undefined) return { ok: false, error: "no selectable option" };
      await el.selectOption(value, { timeout: 1500 });
    } else if (c.type === "input") {
      await el.fill(valueFor(c.description), { timeout: 1500 });
      // The app updates state on `change`, which fill() does not always
      // deliver on its own. Without this the typed value sits in the DOM
      // and the gate never sees it.
      await el.dispatchEvent("change");
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

async function runOnce(
  page: Page,
  baseUrl: string,
  steps: number,
  jev: Jev,
  fixture: Fixture,
  trace?: (line: string) => void,
): Promise<{ rows: StepRow[]; reachedGoal: boolean; trapsTaken: number }> {
  await seedToBoard(page, baseUrl);
  const rows: StepRow[] = [];
  const recent: string[] = [];
  const hashOf = (u: string) => (u.includes("#") ? u.slice(u.indexOf("#")) : "#/home");
  const seen = new Set<string>([hashOf(page.url())]);
  let trapsTaken = 0;
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
    const space = actionSpace(candidates);
    const state: FanoutState = {
      goal: fixture.goal,
      current_url: hashOf(page.url()),
      screen: await evalString(page, SCREEN_TEXT),
      step,
      states_seen: [...seen],
      recent_actions: recent.slice(-6),
      last_action: lastAction,
      last_action_changed_the_page: lastHadEffect,
      last_action_error: lastError,
      actions_with_no_effect_in_a_row: noEffectStreak,
      controls_already_tried_here_with_no_effect: [...inert],
    };

    // One fan-out request, every head read. This is the one that acts.
    const fan = await askFanoutAllHeads(jev, space, state);
    // The two controls, on the identical state.
    const alone = await askOperationAlone(jev, space, state);
    const conditioned = new Map<Operation, HeadAnswer>();
    for (const op of TARGETED) {
      if (!space.heads.has(op)) continue;
      const answer = await askTargetConditioned(jev, space, state, op);
      if (answer) conditioned.set(op, answer);
    }

    const operation = fan.operation.choice as Operation;
    const heads: HeadComparison[] = [];
    for (const [op, spec] of fan.heads) {
      const cond = conditioned.get(op);
      if (!cond) continue;
      const head = space.heads.get(op)!;
      const specEntry = head.get(spec.choice)!;
      const condEntry = head.get(cond.choice)!;
      heads.push({
        step,
        op,
        used: op === operation,
        speculative: spec.choice,
        conditioned: cond.choice,
        agreed: spec.choice === cond.choice,
        tv: totalVariation(spec.probabilities, cond.probabilities),
        specConfidence: spec.confidence,
        condConfidence: cond.confidence,
        specTrap: fixture.trap(op, specEntry.candidate, specEntry.option),
        condTrap: fixture.trap(op, condEntry.candidate, condEntry.option),
        offered: head.size,
      });
    }

    let executed = operation as string;
    let hadEffect = false;
    if (operation !== "DONE" && operation !== "BLOCKED") {
      const entry = space.heads.get(operation)!.get(fan.heads.get(operation)!.choice)!;
      const c: ProbedCandidate = entry.option !== undefined
        ? { ...entry.candidate, chosenOption: entry.option }
        : entry.candidate;
      if (fixture.trap(operation, entry.candidate, entry.option)) trapsTaken += 1;
      const outcome = await act(page, c);
      const after = await evalString(page, SIGNATURE);
      hadEffect = before !== after;
      if (!hadEffect) inert.add(c.description);
      seen.add(hashOf(page.url()));
      executed = `${operation} ${c.description}${entry.option ? ` = ${entry.option}` : ""}`;
      recent.push(executed);
      lastAction = c.description;
      lastHadEffect = hadEffect;
      lastError = outcome.error;
      noEffectStreak = hadEffect ? 0 : noEffectStreak + 1;
    }

    rows.push({
      step,
      operation,
      operationAlone: alone.choice as Operation,
      operationAgreed: alone.choice === operation,
      operationTv: totalVariation(fan.operation.probabilities, alone.probabilities),
      fanoutConfidence: fan.operation.confidence,
      aloneConfidence: alone.confidence,
      executed,
      hadEffect,
      heads,
    });

    trace?.(
      `  step=${step} op=${operation}@${fan.operation.confidence.toFixed(2)} ` +
        `alone=${alone.choice}@${alone.confidence.toFixed(2)}${alone.choice === operation ? "" : " <-DIFFERS"} ` +
        `tv=${totalVariation(fan.operation.probabilities, alone.probabilities).toFixed(2)} ` +
        `${hadEffect ? "ok  " : "NOOP"} ${executed}`,
    );
    for (const h of heads) {
      trace?.(
        `        ${h.used ? "*" : " "}${h.op.padEnd(10)} spec=${h.speculative}@${h.specConfidence.toFixed(2)}` +
          ` cond=${h.conditioned}@${h.condConfidence.toFixed(2)}` +
          `${h.agreed ? " agree" : " DISAGREE"} tv=${h.tv.toFixed(2)}` +
          `${h.specTrap ? " spec-trap" : ""}${h.condTrap ? " cond-trap" : ""}`,
      );
    }

    if (operation === "DONE" || operation === "BLOCKED") break;
    if (seen.has("#/confirm")) break;
  }

  const subscribed = await page.evaluate(() => {
    try {
      return JSON.parse(sessionStorage.getItem("chaos-target-progress") || "{}").subscribed === true;
    } catch {
      return false;
    }
  });
  return { rows, reachedGoal: seen.has("#/confirm"), trapsTaken, subscribed };
}

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const n = Number.parseInt(process.argv[i + 1] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function pct(n: number, d: number): string {
  return d === 0 ? "   n/a" : `${((100 * n) / d).toFixed(0).padStart(4)}%`;
}

async function main(): Promise<void> {
  const runs = arg("runs", 2);
  const steps = arg("steps", 10);
  const verbose = process.argv.includes("--verbose");
  const jev = new Jev();
  const srv = await serve();
  const mode = flag("fixture", flag("select", "hostile"));
  const fixture = FIXTURES[mode];
  if (!fixture) {
    console.error(`unknown fixture '${mode}'; expected one of ${Object.keys(FIXTURES).join(", ")}`);
    process.exit(1);
  }
  const base = `${typeof srv === "string" ? srv : srv.url}?${fixture.query}`;
  const browser = await chromium.launch();
  const all: StepRow[] = [];
  let goals = 0;
  let traps = 0;
  let subscribed = 0;

  try {
    for (let run = 0; run < runs; run += 1) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      if (verbose) console.log(`\nrun ${run}`);
      const out = await runOnce(page, base, steps, jev, fixture, verbose ? (l) => console.log(l) : undefined);
      all.push(...out.rows);
      if (out.reachedGoal) goals += 1;
      if (out.subscribed) subscribed += 1;
      traps += out.trapsTaken;
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  const heads = all.flatMap((r) => r.heads);
  console.log(`\n${runs} run(s), ${all.length} steps, ${heads.length} head comparisons`);
  console.log(`fixture=${mode}   goal reached: ${goals}/${runs}   traps executed: ${traps}` +
    (subscribed > 0 ? `   took the twin (still reaches the goal): ${subscribed}/${runs}` : ""));

  console.log("\noperation head, fan-out vs asked alone");
  const opAgreed = all.filter((r) => r.operationAgreed).length;
  const opTv = all.reduce((a, r) => a + r.operationTv, 0) / (all.length || 1);
  console.log(`  same choice     ${opAgreed}/${all.length}  ${pct(opAgreed, all.length)}`);
  console.log(`  mean TV         ${opTv.toFixed(3)}`);
  console.log(
    `  mean confidence fanout ${(all.reduce((a, r) => a + r.fanoutConfidence, 0) / (all.length || 1)).toFixed(2)}` +
      `  alone ${(all.reduce((a, r) => a + r.aloneConfidence, 0) / (all.length || 1)).toFixed(2)}`,
  );

  console.log("\ntarget heads, speculative vs conditioned");
  console.log("head        n   agree   meanTV  spec-traps  cond-traps");
  for (const op of [...TARGETED, null]) {
    const mine = op ? heads.filter((h) => h.op === op) : heads;
    if (mine.length === 0) continue;
    const agreed = mine.filter((h) => h.agreed).length;
    const tv = mine.reduce((a, h) => a + h.tv, 0) / mine.length;
    const st = mine.filter((h) => h.specTrap).length;
    const ct = mine.filter((h) => h.condTrap).length;
    console.log(
      `${(op ?? "ALL").padEnd(11)} ${String(mine.length).padStart(2)}  ` +
        `${pct(agreed, mine.length)}   ${tv.toFixed(3)}  ` +
        `${pct(st, mine.length)}       ${pct(ct, mine.length)}`,
    );
  }

  // The split that the whole question turns on: a head the operation did
  // not name was answered for nothing, and is where speculation is least
  // constrained. If disagreement concentrates there, the mechanism is
  // still sound — those answers were discarded.
  console.log("\nby whether the operation named the head");
  for (const used of [true, false]) {
    const mine = heads.filter((h) => h.used === used);
    if (mine.length === 0) continue;
    const agreed = mine.filter((h) => h.agreed).length;
    const tv = mine.reduce((a, h) => a + h.tv, 0) / mine.length;
    console.log(
      `  ${used ? "used   " : "unused "} ${String(mine.length).padStart(2)}  ` +
        `${pct(agreed, mine.length)}   TV ${tv.toFixed(3)}`,
    );
  }

  const disagreements = heads.filter((h) => !h.agreed);
  if (disagreements.length > 0) {
    console.log("\ndisagreements");
    for (const h of disagreements) {
      console.log(
        `  step=${h.step} ${h.op}${h.used ? " (USED)" : ""} ` +
          `spec=${h.speculative}@${h.specConfidence.toFixed(2)}${h.specTrap ? "[trap]" : ""} ` +
          `cond=${h.conditioned}@${h.condConfidence.toFixed(2)}${h.condTrap ? "[trap]" : ""} ` +
          `of ${h.offered} offered, TV=${h.tv.toFixed(2)}`,
      );
    }
  }

  console.log(`\ntotal: ${jev.calls} calls, ${jev.inputTokens} in, ${jev.outputTokens} out`);
  console.log(JSON.stringify(all));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
