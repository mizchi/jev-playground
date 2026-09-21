/**
 * Action-cache semantics, without an API key.
 *
 *   npx tsx src/check-cache.ts
 *
 * The cache's value is entirely in when it *refuses* to serve. A cache
 * that always hits is a recording, and a cache that hits on a page which
 * has changed is worse than no cache at all — so these are mostly tests
 * that a miss happens for the right reason.
 */
import { ActionCache, cacheKey, type StateKeyParts } from "./action-cache.js";

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const state = (over: Partial<StateKeyParts> = {}): StateKeyParts => ({
  route: "#/checkout-1",
  screen: "Checkout — step 1 of 3\nEmail address\nContinue to delivery",
  fields: "email=,address=",
  ...over,
});

const OFFERED = new Set(['button "Continue to delivery"', 'email field "Email address"']);

console.log("key granularity");

check("an exact key changes when anything on the page does", () => {
  const a = cacheKey(state(), "exact");
  assert(a !== cacheKey(state({ screen: state().screen + "\nSave 10%" }), "exact"), "screen ignored");
  assert(a !== cacheKey(state({ fields: "email=a@b.co,address=" }), "exact"), "field value ignored");
  assert(a !== cacheKey(state({ route: "#/checkout-2" }), "exact"), "route ignored");
});

check("a loose key ignores what was typed but not whether anything was", () => {
  const empty = cacheKey(state(), "loose");
  const typed = cacheKey(state({ fields: "email=a@b.co,address=" }), "loose");
  const other = cacheKey(state({ fields: "email=z@y.co,address=" }), "loose");
  assert(empty !== typed, "empty and filled collapsed to one key");
  assert(typed === other, "two different emails produced different keys");
});

check("a loose key ignores the screen text entirely", () => {
  // This is the whole hazard: the page can be rearranged, or carry
  // different content, and the key will not notice.
  assert(
    cacheKey(state(), "loose") === cacheKey(state({ screen: "something else completely" }), "loose"),
    "loose key reacted to the screen",
  );
});

console.log("\nserving and refusing");

check("a cold key misses as not_found", () => {
  const c = new ActionCache({ granularity: "exact" });
  const out = c.lookup(state(), OFFERED);
  assert(!out.hit, "hit an empty cache");
  assert(out.reason === "not_found", `reason was ${out.reason}`);
});

check("a stored decision is served back", () => {
  const c = new ActionCache({ granularity: "exact" });
  c.store(state(), { operation: "CLICK", target: 'button "Continue to delivery"' });
  const out = c.lookup(state(), OFFERED);
  assert(out.hit, `missed: ${out.reason}`);
  assert(out.decision?.operation === "CLICK", "lost the operation");
  assert(out.decision?.target === 'button "Continue to delivery"', "lost the target");
  assert(c.hits === 1, "did not count the hit");
});

check("a target that is no longer offered is replay_failed, not a click", () => {
  // The case this harness makes unavoidable: selectors are re-stamped
  // every probe, so a cache keyed on anything positional would act on
  // whatever now holds that index. Storing the description makes the
  // failure visible instead.
  const c = new ActionCache({ granularity: "exact" });
  c.store(state(), { operation: "CLICK", target: 'button "Next step"' });
  const out = c.lookup(state(), OFFERED);
  assert(!out.hit, "served a target that is not on the page");
  assert(out.reason === "replay_failed", `reason was ${out.reason}`);
});

check("a targetless operation always replays", () => {
  // DONE / BLOCKED / a scroll have nothing to re-resolve, so an empty
  // candidate list must not turn them into replay_failed.
  const c = new ActionCache({ granularity: "exact" });
  c.store(state(), { operation: "DONE" });
  assert(c.lookup(state(), new Set()).hit, "refused a targetless decision");
});

check("the threshold delays a hit and then allows it", () => {
  const c = new ActionCache({ granularity: "exact", minSeen: 3 });
  c.store(state(), { operation: "CLICK", target: 'button "Continue to delivery"' });
  assert(c.lookup(state(), OFFERED).reason === "threshold", "served below the threshold");
  assert(c.lookup(state(), OFFERED).reason === "threshold", "served below the threshold");
  assert(c.lookup(state(), OFFERED).hit, "never served at the threshold");
});

check("a miss on an unseen key does not create one", () => {
  // Otherwise the threshold counts lookups of keys that were never
  // stored, and a cache warms itself on its own misses.
  const c = new ActionCache({ granularity: "exact" });
  c.lookup(state(), OFFERED);
  c.lookup(state(), OFFERED);
  assert(c.size === 0, `cache grew to ${c.size} on misses alone`);
});

console.log("\na key that does not cover the state");

check("two different states sharing a truncated prefix collide", () => {
  // The bug that cost 14 steps before it was noticed. The first version
  // keyed on the 1200-character screen slice sent to the model; on
  // `#/products` the only thing that changes when you add to the cart is
  // a count rendered *after* that window. Route the same, fields the
  // same, visible prefix the same — so the cache served "Add Widget to
  // cart" over and over, and `wasted` read 0 the whole time because each
  // click genuinely did change the page.
  const long = "x".repeat(1200);
  const a = state({ route: "#/products", fields: "", screen: `${long}cart=1` });
  const b = state({ route: "#/products", fields: "", screen: `${long}cart=2` });
  const truncate = (p: StateKeyParts) => ({ ...p, screen: p.screen.slice(0, 1200) });

  assert(
    cacheKey(truncate(a), "exact") === cacheKey(truncate(b), "exact"),
    "the truncated key did not collide, so this test no longer covers the bug",
  );
  assert(cacheKey(a, "exact") !== cacheKey(b, "exact"), "the untruncated key still collides");

  // And what the collision does: a hit for a state that has moved on.
  const c = new ActionCache({ granularity: "exact" });
  const offered = new Set(['button "Add Widget to cart"']);
  c.store(truncate(a), { operation: "CLICK", target: 'button "Add Widget to cart"' });
  assert(c.lookup(truncate(b), offered).hit, "precondition: the truncated key should hit");
  assert(!c.lookup(b, offered).hit, "the full key served a stale action");
});

console.log("\nrecord and replay across sessions");

check("a dumped cache reloads and serves", () => {
  const a = new ActionCache({ granularity: "loose" });
  a.store(state(), { operation: "SELECT", target: 'select field "Shipping"', option: "express" });
  const b = new ActionCache({ granularity: "loose" });
  b.load(a.dump());
  const out = b.lookup(state(), new Set(['select field "Shipping"']));
  assert(out.hit, `missed after load: ${out.reason}`);
  assert(out.decision?.option === "express", "lost the option across the dump");
});

check("loading resets the threshold count", () => {
  // The threshold asks "how often has this come up for the session doing
  // the serving", not "how often did the recording session see it" —
  // otherwise a recorded key is served on its first sight, which is the
  // thing the threshold exists to prevent.
  const a = new ActionCache({ granularity: "exact" });
  a.store(state(), { operation: "CLICK", target: 'button "Continue to delivery"' });
  a.lookup(state(), OFFERED);
  a.lookup(state(), OFFERED);
  const b = new ActionCache({ granularity: "exact", minSeen: 2 });
  b.load(a.dump());
  assert(b.lookup(state(), OFFERED).reason === "threshold", "inherited the recorder's hit count");
  assert(b.lookup(state(), OFFERED).hit, "never served on the second sight");
});

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
