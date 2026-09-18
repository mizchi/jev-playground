/** The name join, on the labels the fixture actually renders. No key. */
import { matchUncovered } from "./code-map.js";

// The real uncovered set is mostly not handlers: routes and helpers too.
const UNCOVERED = new Set([
  "applyPromoCode", "compareSelected", "subscribeToNewsletter", "addGiftWrap",
  "#/danger", "#/confirm", "save", "update", "go", "routes.<computed>",
]);
const CASES: [string, string | null][] = [
  ['button "Apply promo code"', "never executed: applyPromoCode()"],
  ['button "Compare selected"', "never executed: compareSelected()"],
  ['button "Subscribe to newsletter"', "never executed: subscribeToNewsletter()"],
  ['button "Add gift wrap"', "never executed: addGiftWrap()"],
  // Must not fire: shares "add" but not the rest.
  ['button "Add Widget to cart"', null],
  ['button "Take the tour"', null],
  ['link "Cart" -> #/cart', null],
  // One-word coincidences that must NOT fire: true statements about the
  // wrong thing, and they would annotate half the list.
  ['link "Account" -> #/danger', null],
  ['button "Save cart for later"', null],
];

let bad = 0;
for (const [description, want] of CASES) {
  const got = matchUncovered(description, UNCOVERED);
  const ok = got === want;
  if (!ok) bad += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${description.padEnd(36)} -> ${got ?? "null"}`);
}
console.log("");
console.log(bad === 0 ? "  all checks passed" : `  ${bad} check(s) failed`);
process.exit(bad === 0 ? 0 : 1);
