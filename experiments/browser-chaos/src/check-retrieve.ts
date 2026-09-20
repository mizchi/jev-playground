/**
 * Does narrowing the candidate list keep the right answer? No API key.
 *
 *   npx tsx src/check-retrieve.ts [--wide 200]
 *
 * Retrieval trades prompt size for recall, and the trade is only worth
 * making if the correct control survives it. The checkout flow's correct
 * action at every step is known by construction, so this walks the flow
 * with no model at all, ranks every candidate against the goal at each
 * step, and reports where the right one landed.
 *
 * A rank of `k` or worse means retrieval removed the answer from the
 * question. That is unrecoverable downstream — it is not a wasted step or
 * an extra call, it is a decision the model was never allowed to make.
 */
import { chromium, type Page } from "playwright";
import { probe, type ProbedCandidate } from "./probes.js";
import { MAX_CHOICES, rankOf, retrieve } from "./retrieve.js";
// @ts-expect-error - plain .mjs helper, shared with the other runners.
import { serve } from "./serve.mjs";

const GOAL =
  "Buy the Widget and complete the checkout to the order confirmation. " +
  "Choose express shipping — next-day — when a shipping method is offered.";

/** The scripted happy path: what the correct candidate looks like at each step. */
const FLOW: { want: RegExp; label: string }[] = [
  { want: /^link "Products"/, label: "open Products" },
  { want: /^button "Add Widget to cart"/, label: "add to cart" },
  { want: /^link "Cart"/, label: "open Cart" },
  { want: /^button "Proceed to checkout"/, label: "start checkout" },
  { want: /field "Email address"/, label: "fill email" },
  { want: /^button "Continue to delivery"/, label: "continue 1" },
  { want: /field "Delivery address"/, label: "fill address" },
  { want: /^button "Continue to payment"/, label: "continue 2" },
  { want: /field "Shipping method"/, label: "set shipping" },
  { want: /^button "Place order"/, label: "place order" },
];

const KS = [5, 10, 20, 40, 80, MAX_CHOICES];

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const n = Number.parseInt(process.argv[i + 1] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Perform the correct action, so the next step is reached without a model. */
async function advance(page: Page, c: ProbedCandidate): Promise<void> {
  const el = page.locator(c.selector).first();
  if (c.type === "select") await el.selectOption("express", { timeout: 2000 });
  else if (c.type === "input") {
    await el.fill(/Email/.test(c.description) ? "a@b.co" : "1 Example Street", { timeout: 2000 });
    await el.dispatchEvent("change");
  } else await el.click({ timeout: 2000 });
  await page.waitForTimeout(80);
}

interface Row {
  step: number;
  label: string;
  offered: number;
  rank: number;
  score: number;
  /** Position in plain document order, for the do-nothing baseline. */
  docRank: number;
  /** Candidates whose box overlaps the viewport. */
  inViewport: number;
  /** Was the correct one among them? */
  correctInViewport: boolean;
  /** What outranked the correct candidate, worst first. */
  above: string[];
}

/**
 * The second query a practitioner reaches for: the goal plus what is on
 * screen right now. On checkout-1 the screen says "Continue to delivery",
 * so the button that advances the flow finally shares vocabulary with the
 * query. The catch is that the filler is on the same screen, so its terms
 * enter the query too — which is the thing worth measuring rather than
 * arguing about.
 */
const SCREEN_TEXT = `(document.getElementById("view") || {}).innerText || ""`;

async function main(): Promise<void> {
  const wide = arg("wide", 200);
  const mode = process.argv.includes("--goal-plus-screen") ? "goal+screen" : "goal";
  const srv = await serve();
  const base = `${typeof srv === "string" ? srv : srv.url}?select=many&wide=${wide}`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const rows: Row[] = [];
  let failures = 0;

  try {
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      try {
        sessionStorage.clear();
      } catch {}
    });
    await page.reload({ waitUntil: "domcontentloaded" });

    for (const [step, want] of FLOW.entries()) {
      const { candidates } = await probe(page);
      const screen = mode === "goal+screen" ? ((await page.evaluate(SCREEN_TEXT)) as string) : "";
      const { ranked } = retrieve(candidates, `${GOAL} ${screen}`, { k: MAX_CHOICES });
      const rank = rankOf(ranked, (c) => want.want.test(c.description));
      const correct = candidates.find((c) => want.want.test(c.description));
      if (!correct) {
        console.log(`  FAIL  step ${step} (${want.label}): no candidate matches ${want.want}`);
        failures += 1;
        break;
      }
      rows.push({
        step,
        label: want.label,
        offered: candidates.length,
        rank,
        score: ranked[rank]!.score,
        docRank: candidates.findIndex((c) => want.want.test(c.description)),
        inViewport: candidates.filter((c) => c.facts.inViewport).length,
        correctInViewport: correct.facts.inViewport,
        above: ranked.slice(0, rank).map((r) => r.candidate.description).reverse().slice(0, 3),
      });
      await advance(page, correct);
    }
  } finally {
    await browser.close();
  }

  console.log(`wide=${wide}, query = ${mode}\n`);
  console.log("step  what             offered  rank  score  what outranked it");
  for (const r of rows) {
    console.log(
      `${String(r.step).padStart(4)}  ${r.label.padEnd(15)} ${String(r.offered).padStart(7)}  ` +
        `${String(r.rank).padStart(4)}  ${r.score.toFixed(2).padStart(5)}  ` +
        `${r.above.length > 0 ? r.above[0]!.slice(0, 46) : "—"}`,
    );
  }

  console.log("\nrecall@k over the 10 flow steps");
  for (const k of KS) {
    const hit = rows.filter((r) => r.rank < k).length;
    const miss = rows.filter((r) => r.rank >= k);
    console.log(
      `  k=${String(k).padStart(3)}  ${hit}/${rows.length}` +
        (miss.length > 0 ? `   misses: ${miss.map((m) => m.label).join(", ")}` : "   (complete)"),
    );
  }

  // The control that keeps this honest: narrow by doing nothing clever at
  // all, just keep the first k candidates in document order. If the dumb
  // baseline beats the scorer, the scorer is worse than useless.
  //
  // CAVEAT, and it is the whole caveat: this fixture APPENDS its filler,
  // so document order puts every real control first. A real page
  // interleaves them, and there this baseline would be no better than
  // random. It is here to bound the scorer, not to be a recommendation.
  console.log("\nrecall@k for plain document-order truncation (fixture appends its filler — see the note)");
  for (const k of KS) {
    const hit = rows.filter((r) => r.docRank < k).length;
    console.log(`  k=${String(k).padStart(3)}  ${hit}/${rows.length}`);
  }

  // The narrowing that is not textual at all: what a user can actually
  // see. jev-ultrafast offers SCROLL_UP / SCROLL_DOWN as first-class
  // operations, which only makes sense if the offered set is the viewport
  // rather than the document — so this measures whether the correct
  // control is on screen when it is needed.
  const inView = rows.filter((r) => r.correctInViewport).length;
  const viewportSizes = rows.map((r) => r.inViewport);
  console.log(
    `\nviewport narrowing: the correct control was on screen ${inView}/${rows.length} steps; ` +
      `viewport held ${Math.min(...viewportSizes)}-${Math.max(...viewportSizes)} of ` +
      `${rows[0]!.offered} candidates`,
  );

  const worst = rows.reduce((a, b) => (b.rank > a.rank ? b : a), rows[0]!);
  console.log(`\nworst rank: ${worst.rank} (${worst.label}), so any k <= ${worst.rank} loses a step`);

  const zero = rows.filter((r) => r.score === 0);
  if (zero.length > 0) {
    console.log(
      `\n${zero.length}/${rows.length} correct candidates score ZERO against the goal ` +
        `(${zero.map((z) => z.label).join(", ")}) — for those, rank is document order and ` +
        `retrieval is doing nothing but truncating.`,
    );
  }

  // The contract that actually has to hold: a wide page must be narrowed
  // to something, because `Jev.ask` throws above the server's cap.
  const overCap = rows.filter((r) => r.offered > MAX_CHOICES);
  console.log(
    overCap.length > 0
      ? `\n${overCap.length}/${rows.length} steps exceed the ${MAX_CHOICES}-choice cap, ` +
          `so narrowing is mandatory there whether or not it helps.`
      : `\nno step exceeds the ${MAX_CHOICES}-choice cap at wide=${wide}.`,
  );

  console.log(failures === 0 ? "\nwalked the whole flow" : `\n${failures} step(s) unreachable`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
