/**
 * Do the `?bug=` mutations break what they claim to break? No model, no key.
 *
 * This walks the happy path by id, which is the strongest a hand-written
 * test could be, and records what each variant does. It is also the oracle
 * docs/27 measures generated tests against: a mutation that this script
 * cannot tell apart from the clean app is one no test could catch, and
 * grading a generator against it would be unfair.
 */
import { existsSync } from "node:fs";
import { chromium, type Page } from "playwright";
// @ts-expect-error - plain .mjs helper
import { serve } from "./serve.mjs";

const exe = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

interface Outcome {
  /** Where the flow ended up. */
  hash: string;
  /** The status line, which carries the app's real state. */
  status: string;
  /** Step that could not proceed, if any. */
  blockedAt?: string;
  /** Whether the two Continue buttons still carry their original labels. */
  labelsIntact: boolean;
}

async function walkHappyPath(page: Page, base: string): Promise<Outcome> {
  const hop = async (hash: string) => {
    await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
    // Generous: the `slow` variant delays every render by 400ms.
    await page.waitForTimeout(600);
  };
  const status = async () =>
    String(await page.evaluate("document.getElementById('status').textContent"));
  const clickIfPresent = async (sel: string): Promise<boolean> => {
    if ((await page.locator(sel).count()) === 0) return false;
    await page.locator(sel).click({ timeout: 2000 });
    await page.waitForTimeout(600);
    return true;
  };

  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);

  await hop("#/products");
  if (!(await clickIfPresent("#add"))) {
    return { hash: page.url(), status: await status(), blockedAt: "add", labelsIntact: true };
  }
  await hop("#/cart");
  if (!(await clickIfPresent("#checkout"))) {
    return { hash: page.url(), status: await status(), blockedAt: "checkout", labelsIntact: true };
  }
  const label1 = await page.locator("#next1").textContent();
  await page.locator("#email").fill("test@example.com", { timeout: 2000 });
  if (!(await clickIfPresent("#next1"))) {
    return { hash: page.url(), status: await status(), blockedAt: "next1", labelsIntact: true };
  }
  const label2 = await page.locator("#next2").textContent();
  await page.locator("#address").fill("1 Example Street", { timeout: 2000 });
  if (!(await clickIfPresent("#next2"))) {
    return { hash: page.url(), status: await status(), blockedAt: "next2", labelsIntact: true };
  }
  if (!(await clickIfPresent("#place"))) {
    return { hash: page.url(), status: await status(), blockedAt: "place", labelsIntact: true };
  }
  return {
    hash: page.url().slice(page.url().indexOf("#")),
    status: await status(),
    labelsIntact: (label1 ?? "").includes("Continue") && (label2 ?? "").includes("Continue"),
  };
}

/** Can the flow be finished WITHOUT filling the email? Only `gate` allows it. */
async function skipsValidation(page: Page, base: string): Promise<boolean> {
  const hop = async (hash: string) => {
    await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
    await page.waitForTimeout(600);
  };
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await hop("#/products");
  if ((await page.locator("#add").count()) > 0) {
    await page.locator("#add").click({ timeout: 2000 });
    await page.waitForTimeout(600);
  }
  // Straight to step 2 without ever touching the email field.
  await hop("#/checkout-2");
  return (await page.locator("#address").count()) > 0;
}

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
    const results = new Map<string, Outcome>();
    for (const bug of ["", "cart", "order", "gate", "label", "slow"]) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const base = bug ? `${url}?bug=${bug}` : url;
      const out = await walkHappyPath(page, base);
      results.set(bug, out);
      console.log(
        `  ${(bug || "(clean)").padEnd(8)} -> ${out.hash.padEnd(12)} ` +
          `blocked=${out.blockedAt ?? "-"} labels=${out.labelsIntact ? "intact" : "renamed"}`,
      );
      console.log(`            ${out.status}`);
      await ctx.close();
    }
    console.log("");

    const clean = results.get("")!;
    check(clean.hash === "#/confirm", "clean: the happy path reaches the confirmation");
    check(/ordered=true/.test(clean.status), "clean: and records the order", clean.status);
    check(/cart=1/.test(clean.status), "clean: and the cart filled");

    const cart = results.get("cart")!;
    check(
      cart.blockedAt === "checkout" && /cart=0/.test(cart.status),
      "cart: the flow cannot proceed past an empty cart",
      `blocked at ${cart.blockedAt}`,
    );

    const order = results.get("order")!;
    check(
      order.hash === "#/confirm" && /ordered=false/.test(order.status),
      "order: reaches the confirmation WITHOUT recording the order",
      order.status,
    );
    check(
      order.hash === clean.hash,
      "order: so the final URL alone cannot tell it from clean",
      `${order.hash} == ${clean.hash}`,
    );

    const label = results.get("label")!;
    check(
      label.hash === "#/confirm" && !label.labelsIntact,
      "label: completes the flow with the buttons renamed",
    );
    check(
      /ordered=true/.test(label.status),
      "label: nothing is actually broken",
      label.status,
    );

    const slow = results.get("slow")!;
    check(slow.hash === "#/confirm", "slow: still completes, given enough waiting");
    check(/ordered=true/.test(slow.status), "slow: nothing is actually broken");

    // `gate` is invisible to a happy path by construction — the path fills
    // the email, so the missing check never fires. It needs a test that
    // tries to skip a step.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    check(
      (await skipsValidation(page, `${url}?bug=gate`)) === true,
      "gate: step 2 can be reached with no email",
    );
    check(
      (await skipsValidation(page, url)) === false,
      "gate: which the clean app refuses",
    );
    check(
      results.get("gate")!.hash === "#/confirm" &&
        /ordered=true/.test(results.get("gate")!.status),
      "gate: and the happy path is unaffected, so only a negative test sees it",
      results.get("gate")!.status,
    );
    await ctx.close();
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
