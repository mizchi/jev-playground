/**
 * Does V8 coverage actually name the fixture's branches, are they really
 * invisible to hash-based novelty, and does the inventory survive a run?
 * No model, no key.
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { FunctionCoverage } from "./coverage.js";
// @ts-expect-error - plain .mjs helper
import { serve } from "./serve.mjs";

const BRANCHES = ["applyPromoCode", "compareSelected", "subscribeToNewsletter", "addGiftWrap"];
const exe = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

async function main() {
  const { server, url } = (await serve(0)) as { server: { close(): void }; url: string };
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    ...(existsSync(exe) ? { executablePath: exe } : {}),
  });
  let failures = 0;
  const check = (ok: boolean, label: string, detail = "") => {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `  — ${detail}` : ""}`);
    if (!ok) failures += 1;
  };

  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    // Rejects "" on purpose: that is Playwright's injected utility script.
    const cov = new FunctionCoverage(cdp, (u) => u.startsWith(url));
    await cov.start();

    await page.goto(`${url}?branches=1#/cart`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(100);
    const inventory = await cov.captureInventory();
    check(inventory.size > 8 && inventory.size < 60, "the inventory is the page's own functions", `${inventory.size} named`);
    check(
      BRANCHES.every((b) => inventory.has(b)),
      "and contains all four branches",
      BRANCHES.filter((b) => inventory.has(b)).join(","),
    );

    const t0 = await cov.split();
    check(BRANCHES.every((b) => t0.uncovered.has(b)), "all four start uncovered");
    check(t0.covered.has("render"), "a function that did run is covered", "render");

    // Navigate by assigning the hash: the crawl never leaves the document,
    // and the promo button needs a non-empty cart.
    const hop = async (hash: string) => {
      await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
      await page.waitForTimeout(60);
    };
    await hop("#/products");
    await page.locator("#add").click({ timeout: 1500 });
    await hop("#/cart");

    // The claim that makes coverage worth reading: running one of these
    // changes no hash and adds no URL state, so URL novelty sees nothing.
    const hashBefore = page.url();
    const statusBefore = await page.evaluate("document.getElementById('status').textContent");
    await page.getByRole("button", { name: "Apply promo code" }).click({ timeout: 1500 });
    await page.waitForTimeout(80);

    const t1 = await cov.split();
    check(t1.covered.has("applyPromoCode"), "clicking it marks the branch covered");
    check(!t1.uncovered.has("applyPromoCode"), "and drops it from the uncovered set");
    check(
      ["compareSelected", "subscribeToNewsletter", "addGiftWrap"].every((b) => t1.uncovered.has(b)),
      "the three untouched branches are still uncovered",
      [...t1.uncovered].filter((n) => BRANCHES.includes(n)).join(","),
    );
    check(
      page.url() === hashBefore,
      "the hash did not move",
      `${hashBefore} -> ${page.url()}`,
    );
    check(
      statusBefore !== (await page.evaluate("document.getElementById('status').textContent")),
      "but the status line did",
    );
    await cov.stop();

    // Without ?branches=1 the same click must do nothing, so docs/05 is safe.
    const ctx2 = await browser.newContext();
    const p2 = await ctx2.newPage();
    await p2.goto(`${url}#/products`, { waitUntil: "domcontentloaded" });
    await p2.locator("#add").click({ timeout: 1500 });
    await p2.evaluate('location.hash = "#/cart"');
    await p2.waitForTimeout(60);
    const s1 = await p2.evaluate("document.getElementById('status').textContent");
    await p2.getByRole("button", { name: "Apply promo code" }).click({ timeout: 1500 });
    await p2.waitForTimeout(80);
    const s2 = await p2.evaluate("document.getElementById('status').textContent");
    check(s1 === s2, "without ?branches=1 the decoy is still a decoy", String(s2));
  } finally {
    await browser.close();
    server.close();
  }

  console.log("");
  console.log(failures === 0 ? "  all checks passed" : `  ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
