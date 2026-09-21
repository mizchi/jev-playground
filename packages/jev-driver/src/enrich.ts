/**
 * The two facts the crawler collects and does not carry: what a field
 * holds, and what a dropdown offers.
 *
 * Both are needed by the action space and neither is on a
 * `DriverCandidate`. `CLEAR` has to know a field is not already empty,
 * and `SELECT` offers `index:option` pairs, so the options have to come
 * from somewhere. They come from the page, one candidate at a time.
 *
 * Per candidate rather than one `page.evaluate` over the whole list,
 * because a crawler selector is a **Playwright** selector and can carry
 * `:has-text()`, which `document.querySelector` cannot run. A locator
 * can. The cost is one evaluate per field, and only fields are visited:
 * a page of twenty links enriches nothing.
 */
import type { Candidate, CandidateExtras, Enriched } from "./candidate.js";

/** Just enough of Playwright's `Page` to resolve one selector. */
export interface PageLike {
  locator(selector: string): {
    first(): {
      evaluate<R, A>(
        fn: (el: Element, arg: A) => R,
        arg?: A,
        options?: { timeout?: number },
      ): Promise<R>;
    };
  };
}

const EMPTY: CandidateExtras = { options: [], currentValue: "" };

/**
 * Which candidates are worth a round trip. `interactive` is in because
 * that is where a `<select>` would land: the crawler classifies it as a
 * control rather than a fill target, since `fill()` refuses it.
 */
function needsExtras(c: Candidate): boolean {
  return c.type === "input" || c.type === "interactive";
}

export interface EnrichResult<C extends Candidate = Candidate> {
  candidates: (C & CandidateExtras)[];
  /**
   * Candidates whose extras could not be read. Reported, not swallowed:
   * the first version of this file caught every failure and returned
   * "no options, no value", so a broken read looked exactly like an
   * empty field — the action space quietly lost its CLEAR and SELECT
   * heads and the run still produced a table. docs/59 §3.3 is the same
   * shape (a broken control returned a number rather than an error), and
   * this is the count that makes it visible.
   */
  failed: number;
}

/**
 * Add the extras, counting what could not be read.
 *
 * A field that fails to resolve degrades to "no options, no value",
 * which removes it from the CLEAR and SELECT heads and leaves it in
 * TYPE_TEXT. That is the safe direction — the operations that need the
 * extra fact are the ones that lose it — but it is only safe if somebody
 * is counting, hence `failed`.
 */
export async function enrich<C extends Candidate>(
  page: PageLike,
  candidates: readonly C[],
  selectorOf: (c: C) => string | undefined,
  /**
   * Per-candidate ceiling. Not optional in practice: a crawler selector
   * can be a `:has-text()` form that resolves to nothing, and Playwright
   * waits 30 s for it by default. Leaving it out made a three-step crawl
   * run past two minutes -- the enrichment, not the model, was the whole
   * wall clock.
   */
  timeoutMs = 500,
): Promise<EnrichResult<C>> {
  const out: (C & CandidateExtras)[] = [];
  let failed = 0;
  for (const c of candidates) {
    const selector = needsExtras(c) ? selectorOf(c) : undefined;
    if (selector === undefined) {
      out.push({ ...c, ...EMPTY });
      continue;
    }
    try {
      // An anonymous arrow with no free variables, so Playwright can
      // serialise it and esbuild has no name to wrap. The `__name`
      // helper that breaks `page.evaluate` under tsx is injected for
      // *named* functions; this one has nothing to name.
      const extras = await page
        .locator(selector)
        .first()
        .evaluate((el: Element): CandidateExtras => {
          const node = el as HTMLInputElement & {
            options?: ArrayLike<HTMLOptionElement>;
          };
          const currentValue = typeof node.value === "string" ? node.value : "";
          if (el.tagName.toLowerCase() !== "select" || !node.options) {
            return { options: [], currentValue };
          }
          const options: { value: string; label: string }[] = [];
          for (let i = 0; i < node.options.length; i += 1) {
            const o = node.options[i]!;
            // A placeholder is not a value. Offering it back as a SELECT
            // target sets the dropdown to nothing and reads as progress.
            if (o.value === "") continue;
            options.push({
              value: o.value,
              label: (o.label || o.textContent || o.value).trim(),
            });
          }
          return { options, currentValue };
        }, undefined, { timeout: timeoutMs });
      out.push({
        ...c,
        options: Array.isArray(extras?.options) ? extras.options : [],
        currentValue: typeof extras?.currentValue === "string" ? extras.currentValue : "",
      });
    } catch {
      failed += 1;
      out.push({ ...c, ...EMPTY });
    }
  }
  return { candidates: out, failed };
}
