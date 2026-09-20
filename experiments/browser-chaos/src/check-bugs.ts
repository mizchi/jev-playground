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

/**
 * `?routes=1`: walk to `ordered=true` by one of the four route families
 * and report the end state.
 *
 * The point of the board is that these are genuinely different paths, so
 * the walker takes each one explicitly rather than letting a picker
 * choose. `entry` is how the item gets into the cart and `path` is how
 * checkout is done; `order` flips which express field is filled first,
 * which should not change the outcome at all.
 */
async function walkRoute(
  page: Page,
  base: string,
  entry: "products" | "buynow",
  path: "steps" | "express",
  order: "email-first" | "address-first" = "email-first",
): Promise<Outcome> {
  const hop = async (hash: string) => {
    await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
    await page.waitForTimeout(600);
  };
  const status = async () =>
    String(await page.evaluate("document.getElementById('status').textContent"));
  const click = async (sel: string): Promise<boolean> => {
    if ((await page.locator(sel).count()) === 0) return false;
    await page.locator(sel).click({ timeout: 2000 });
    await page.waitForTimeout(600);
    return true;
  };
  const blocked = async (at: string): Promise<Outcome> => ({
    hash: page.url(), status: await status(), blockedAt: at, labelsIntact: true,
  });

  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);

  if (entry === "products") {
    await hop("#/products");
    if (!(await click("#add"))) return blocked("add");
    await hop("#/cart");
  } else {
    await hop("#/home");
    // `#buynow` navigates by itself; that is the point of it.
    if (!(await click("#buynow"))) return blocked("buynow");
  }

  if (path === "steps") {
    if (!(await click("#checkout"))) return blocked("checkout");
    await page.locator("#email").fill("test@example.com", { timeout: 2000 });
    if (!(await click("#next1"))) return blocked("next1");
    await page.locator("#address").fill("1 Example Street", { timeout: 2000 });
    if (!(await click("#next2"))) return blocked("next2");
    if (!(await click("#place"))) return blocked("place");
  } else {
    if (!(await click("#express"))) return blocked("express");
    const fillEmail = () => page.locator("#email-x").fill("test@example.com", { timeout: 2000 });
    const fillAddress = () => page.locator("#address-x").fill("1 Example Street", { timeout: 2000 });
    if (order === "email-first") { await fillEmail(); await fillAddress(); }
    else { await fillAddress(); await fillEmail(); }
    if (!(await click("#place-express"))) return blocked("place-express");
  }
  return {
    hash: page.url().slice(page.url().indexOf("#")),
    status: await status(),
    labelsIntact: true,
  };
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

    // ---- every mutation has to paint the LANDING screen ---------------
    //
    // The gap that hid a real defect for two reports. Every walker here
    // reaches its first control through a hash hop, and a hashchange
    // rendered a second time, which papered over `?bug=slow` never
    // painting at all: `#view` stayed empty forever. It only surfaced
    // once a generated spec started from the landing screen (the
    // `buynow` route), and then it read as brittleness in the spec
    // rather than as a broken fixture.
    console.log("");
    console.log("  every mutation paints the landing screen (no hash hop first)");
    for (const bug of ["", "cart", "order", "gate", "label", "slow", "express"]) {
      const c = await browser.newContext();
      const p = await c.newPage();
      const q = [bug ? `bug=${bug}` : "", "routes=1"].filter(Boolean).join("&");
      await p.goto(`${url}?${q}`, { waitUntil: "domcontentloaded" });
      // Generously past the 400ms `slow` delay.
      await p.waitForTimeout(1500);
      const painted = Number(
        await p.evaluate("document.getElementById('view').innerHTML.length"),
      );
      const h1 = String(
        await p.evaluate("(document.querySelector('#view h1')||{}).textContent || ''"),
      );
      check(painted > 0 && h1.length > 0, `${bug || "clean"}: landing screen painted`, `#view=${painted} h1="${h1}"`);
      await c.close();
    }

    // ---- ?routes=1: four route families, and a route-specific bug ------
    console.log("");
    console.log("  ?routes=1 — more than one path to the goal (docs/27 §4.6)");
    const ROUTES = `${url}?routes=1`;
    const families: [("products" | "buynow"), ("steps" | "express")][] = [
      ["products", "steps"], ["products", "express"],
      ["buynow", "steps"], ["buynow", "express"],
    ];
    for (const [entry, path] of families) {
      const c = await browser.newContext();
      const p = await c.newPage();
      const out = await walkRoute(p, ROUTES, entry, path);
      check(
        out.hash === "#/confirm" && /ordered=true/.test(out.status) &&
          /cart=1/.test(out.status) && /address=set/.test(out.status),
        `${entry} + ${path}: reaches the goal with the same end state`,
        out.blockedAt ? `blocked at ${out.blockedAt}` : out.status,
      );
      await c.close();
    }
    // Field order on the express page must not matter.
    for (const order of ["email-first", "address-first"] as const) {
      const c = await browser.newContext();
      const p = await c.newPage();
      const out = await walkRoute(p, ROUTES, "products", "express", order);
      check(
        out.hash === "#/confirm" && /email=set address=set ordered=true/.test(out.status),
        `express, ${order}: same end state either way`,
        out.blockedAt ? `blocked at ${out.blockedAt}` : out.status,
      );
      await c.close();
    }
    // The whole point: `?bug=express` is visible from one path and not
    // the other, with a POSITIVE test — it drops a recording rather than
    // removing a guard, so it is catchable at all (unlike `gate`).
    // A context per walk: the app persists state in sessionStorage, so
    // two walks sharing a page start the second one with the first one's
    // cart. The assertions below are about the address, but a reader
    // seeing `cart=2` cannot tell that, and the next assertion added
    // here would silently inherit it.
    const freshWalk = async (
      target: string,
      entry: "products" | "buynow",
      path: "steps" | "express",
    ): Promise<Outcome> => {
      const c = await browser.newContext();
      const p = await c.newPage();
      try {
        return await walkRoute(p, target, entry, path);
      } finally {
        await c.close();
      }
    };
    {
      const viaExpress = await freshWalk(`${url}?routes=1&bug=express`, "products", "express");
      check(
        /cart=1/.test(viaExpress.status) && /address=empty/.test(viaExpress.status) &&
          /ordered=true/.test(viaExpress.status),
        "bug=express: via express, the address is dropped while the order still completes",
        viaExpress.status,
      );
      const viaSteps = await freshWalk(`${url}?routes=1&bug=express`, "products", "steps");
      check(
        /cart=1/.test(viaSteps.status) && /address=set/.test(viaSteps.status) &&
          /ordered=true/.test(viaSteps.status),
        "bug=express: via the 3-step path, the SAME bug is invisible",
        viaSteps.status,
      );
      // And the mirror: `gate` lives on a check express never runs.
      const gateExpress = await freshWalk(`${url}?routes=1&bug=gate`, "products", "express");
      check(
        gateExpress.hash === "#/confirm" && /cart=1/.test(gateExpress.status) &&
          /ordered=true/.test(gateExpress.status),
        "bug=gate: express completes too, having never run the weakened check",
        gateExpress.status,
      );
    }
    // Both cart entries must respect `?bug=cart`, or the bug would be
    // catchable from one route only for an uninteresting reason.
    for (const entry of ["products", "buynow"] as const) {
      const c = await browser.newContext();
      const p = await c.newPage();
      const out = await walkRoute(p, `${url}?routes=1&bug=cart`, entry, "steps");
      check(
        /cart=0/.test(out.status) && out.hash !== "#/confirm",
        `bug=cart: blocks the ${entry} entry too`,
        out.blockedAt ? `blocked at ${out.blockedAt}` : out.status,
      );
      await c.close();
    }
    // The flag is off by default, so every earlier measurement stands.
    {
      const c = await browser.newContext();
      const p = await c.newPage();
      await p.goto(url, { waitUntil: "domcontentloaded" });
      await p.waitForTimeout(400);
      await p.evaluate(`location.hash = "#/cart"`);
      await p.waitForTimeout(400);
      const n = await p.locator("#express").count();
      await p.evaluate(`location.hash = "#/home"`);
      await p.waitForTimeout(400);
      const b = await p.locator("#buynow").count();
      check(n === 0 && b === 0, "routes is off by default: neither new control exists");
      await c.close();
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
