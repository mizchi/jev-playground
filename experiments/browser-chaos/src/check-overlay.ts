/**
 * Does the fixture's bug behave as advertised, and does the probe see it?
 *
 * No model, no key — this is the sanity check that has to pass before any
 * arm is worth running. It asserts three things:
 *   1. without `?overlay=1` nothing is covered (docs/05 still reproduces)
 *   2. with it, a click on the checkout button silently fails
 *   3. the probe names the backdrop as the thing receiving that click
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { notableFacts, probe } from "./probes.js";
// @ts-expect-error - plain .mjs helper
import { serve } from "./serve.mjs";

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
    for (const overlay of [false, true]) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const target = overlay ? `${url}?overlay=1#/products` : `${url}#/products`;
      await page.goto(target, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(100);

      console.log("");
      console.log(`  ${overlay ? "with" : "without"} ?overlay=1`);
      const { candidates, screen } = await probe(page);
      const add = candidates.find((c) => c.description.includes("Add Widget to cart"));
      check(add !== undefined, "the Add-to-cart button is a candidate");
      if (!add) continue;

      if (overlay) {
        check(add.facts.coveredBy !== undefined, "geometry reports it covered", notableFacts(add) ?? "");
        check(
          (add.facts.coveredBy ?? "") === "DIV" || /dark mode|DIV/i.test(add.facts.coveredBy ?? ""),
          "the coverer is the backdrop div",
          `coveredBy=${JSON.stringify(add.facts.coveredBy)}`,
        );
        const dismiss = candidates.find((c) => c.description.includes("Dismiss tip"));
        check(dismiss !== undefined && !dismiss.facts.coveredBy, "the dismiss button is NOT covered");
        check(
          screen.overlays.some((t) => /dark mode/i.test(t)),
          "the tip text is discoverable as an overlay",
          JSON.stringify(screen.overlays),
        );

        // The claim that matters: the click does not go through.
        const before = await page.evaluate("document.getElementById('status').textContent");
        let clickError = "";
        try {
          await page.locator(add.selector).first().click({ timeout: 1200 });
        } catch (err) {
          clickError = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
        }
        const after = await page.evaluate("document.getElementById('status').textContent");
        check(before === after, "the cart did not change", `${before} -> ${after}`);
        check(clickError !== "", "Playwright refused the click", clickError.slice(0, 80));
        check(
          /intercepts pointer events/.test(clickError) ||
            /timeout/i.test(clickError),
          "and says why (interception or timeout)",
        );

        // Dismissing it unblocks the page.
        await page.locator("#tip-dismiss").click({ timeout: 1200 });
        const reprobed = await probe(page);
        const add2 = reprobed.candidates.find((c) => c.description.includes("Add Widget to cart"));
        check(add2 !== undefined && !add2.facts.coveredBy, "after dismissing, nothing is covered");
        await page.locator(add2!.selector).first().click({ timeout: 1200 });
        const after2 = await page.evaluate("document.getElementById('status').textContent");
        check(after2 !== after, "and the click now works", `${after} -> ${after2}`);
      } else {
        check(add.facts.coveredBy === undefined, "geometry reports nothing covering it");
        check(notableFacts(add) === null, "no notable facts to send", String(notableFacts(add)));
        check(screen.overlays.length === 0, "no overlays", JSON.stringify(screen.overlays));
      }
      await ctx.close();
    }
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
