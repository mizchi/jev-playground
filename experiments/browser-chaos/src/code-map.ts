/**
 * Joining a function name to the control that would call it.
 *
 * The naive way to hand coverage to a picker is a list in the state:
 * `code_not_yet_executed: ["applyPromoCode", ...]`. That reads like
 * guidance to a human, but the choice the picker is actually making is
 * over controls, and nothing connects the two — the join is left as an
 * exercise. docs/58 measures what that costs.
 *
 * This does the join in code instead, by name. It works on the fixture
 * because its handlers are named after their buttons, which is common but
 * not guaranteed; the general mechanism is runtime attribution (click,
 * diff the coverage, remember which control produced which functions),
 * which is what chaosbringer's `targetNovelty` already does. Either way
 * the join is computed rather than inferred, which is the whole point.
 */

/** `applyPromoCode` -> ["apply", "promo", "code"] */
export function words(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
}

/**
 * A note for this candidate, or `null` when no uncovered function looks
 * like it. Requires every word of the function name to appear in the
 * label, so `addGiftWrap` matches `button "Add gift wrap"` and not
 * `button "Add Widget to cart"`.
 *
 * Two words minimum, which is not arbitrary tuning. The uncovered set is
 * mostly not handlers: the fixture's routes are keys like `#/danger` and
 * its helpers are `save`, `update`, `go`. On one word those match by
 * coincidence — `#/danger` lands on `link "Account" -> #/danger`, `save`
 * on `button "Save cart for later"` — and annotate half the list with
 * claims that are true but not about the control. A one-word overlap
 * between an identifier and a label is not evidence that one calls the
 * other, and a note that fires everywhere carries nothing.
 */
export function matchUncovered(
  description: string,
  uncovered: ReadonlySet<string>,
): string | null {
  const label = new Set(words(description));
  for (const fn of uncovered) {
    const w = words(fn);
    if (w.length >= 2 && w.every((x) => label.has(x))) return `never executed: ${fn}()`;
  }
  return null;
}
