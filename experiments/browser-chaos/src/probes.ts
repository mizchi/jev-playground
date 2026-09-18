/**
 * Deterministic facts about the screen, collected alongside the candidates.
 *
 * docs/05 landed on "put the judgement material in the state" — screen text
 * and form values were what turned a wandering crawl into a completed order.
 * This file is the next layer of the same idea: the facts a *description*
 * structurally cannot carry.
 *
 * `button "Continue to delivery"` reads identically whether the button is
 * live, greyed out, scrolled off-screen, or sitting underneath a consent
 * banner that will eat the click. A picker told only the description has to
 * guess, and — this is the point — it reports a low confidence while
 * guessing. The facts below are the cheapest thing that can answer it,
 * because the browser already knows all of them.
 *
 * The probes are modelled on vlmkit's key-free integrity gates (`check
 * integrity` finds overflow and collisions by measuring geometry rather than
 * by asking a model) and run in-page here: vlmkit needs Node 24 and this
 * environment is on 22, and an in-page probe is what a driver would embed
 * anyway. No model, no screenshot, no API key — one `page.evaluate`.
 *
 * Collected in the SAME pass as the candidates so a fact can never describe
 * a different element than the description next to it. The arms of the
 * benchmark differ in what they *send*, never in what was measured.
 */
import type { Page } from "playwright";

export interface CandidateFacts {
  /** Interactable per the DOM: not `disabled`, not `aria-disabled`. */
  enabled: boolean;
  /** The bounding box intersects the viewport. */
  inViewport: boolean;
  /**
   * What `elementFromPoint` returns at the candidate's centre, when that is
   * not the candidate itself or one of its children — i.e. the thing that
   * will actually receive the click. The single most useful fact here: a
   * click on a covered control silently does nothing, and nothing in the
   * page text says why.
   */
  coveredBy?: string;
  /** `pointer-events: none`, or an opacity low enough to read as inert. */
  inert: boolean;
}

export interface ProbedCandidate {
  index: number;
  selector: string;
  description: string;
  type: "click" | "input";
  facts: CandidateFacts;
}

export interface ScreenFacts {
  /** Fields on screen with no value, named as the picker sees them. */
  emptyFields: string[];
  /**
   * Text of anything painted over the page on a fixed/sticky layer — a
   * banner, a modal, a toast. Present regardless of whether it covers a
   * candidate, because "there is a dialog open" changes what the right
   * action is even when the geometry happens to miss.
   */
  overlays: string[];
}

export interface Probe {
  candidates: ProbedCandidate[];
  screen: ScreenFacts;
}

/**
 * Handed to `page.evaluate` as source text, not as a closure: tsx compiles
 * with esbuild's `keepNames`, which injects a `__name` helper that does not
 * exist in the page. Same reason as `spa-bench.ts`.
 */
const PROBE = `(() => {
  const nodes = document.querySelectorAll("a[href], button, input, textarea, select");
  const out = [];
  const empty = [];
  let n = 0;
  for (const el of Array.from(nodes)) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    n += 1;
    const tag = el.tagName.toLowerCase();
    const isField = tag === "input" || tag === "textarea" || tag === "select";
    const id = el.id;
    const selector = id ? "#" + id : tag + ":nth-of-type(" + n + ")";
    const labelEl = id ? document.querySelector('label[for="' + id + '"]') : null;
    const name = (el.getAttribute("aria-label") || el.innerText || (labelEl ? labelEl.textContent : "")
      || el.placeholder || id || "").trim().slice(0, 60);
    const role = tag === "a" ? "link" : isField ? ((el.type || tag) + " field") : "button";
    const href = tag === "a" ? el.getAttribute("href") : null;
    const description = role + ' "' + name + '"' + (href ? " -> " + href : "");

    const cs = getComputedStyle(el);
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const inViewport = r.bottom > 0 && r.right > 0
      && r.top < innerHeight && r.left < innerWidth;

    // Who actually gets the click. Only meaningful for a point inside the
    // viewport — elementFromPoint returns null outside it, which is not the
    // same thing as "covered".
    let coveredBy;
    if (inViewport) {
      const hit = document.elementFromPoint(cx, cy);
      if (hit && hit !== el && !el.contains(hit)) {
        // Text first, then the selector — an invisible backdrop has no
        // text at all, and "DIV" tells a reader nothing it can act on,
        // where "<div id=tip-backdrop>" names the thing to get rid of.
        const text = (hit.innerText || hit.getAttribute("aria-label") || "").trim();
        const ident = hit.tagName.toLowerCase()
          + (hit.id ? "#" + hit.id : "")
          + (!hit.id && hit.className && typeof hit.className === "string"
              ? "." + hit.className.trim().split(/\\s+/).join(".") : "");
        coveredBy = (text ? text.replace(/\\s+/g, " ").slice(0, 60) + " <" + ident + ">" : "<" + ident + ">");
      }
    }

    out.push({
      selector: selector,
      description: description,
      type: isField ? "input" : "click",
      facts: {
        enabled: !el.disabled && el.getAttribute("aria-disabled") !== "true",
        inViewport: inViewport,
        inert: cs.pointerEvents === "none" || Number(cs.opacity) < 0.4,
        coveredBy: coveredBy,
      },
    });
    if (isField && !el.value) empty.push(description);
  }

  // Anything on its own painted layer, big enough to matter.
  const overlays = [];
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 1000) continue;
    const t = (el.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 120);
    if (t) overlays.push(t);
  }

  return { candidates: out, screen: { emptyFields: empty, overlays: overlays } };
})()`;

export async function probe(page: Page): Promise<Probe> {
  const raw = (await page.evaluate(PROBE)) as {
    candidates: Omit<ProbedCandidate, "index">[];
    screen: ScreenFacts;
  };
  return {
    candidates: raw.candidates.map((c, index) => ({ ...c, index })),
    screen: raw.screen,
  };
}

/**
 * The facts worth spending tokens on: only what is not the boring default.
 * A list that says "enabled, in viewport, not covered" fifteen times is
 * fifteen lines of nothing, and the whole argument for sending facts is
 * that they carry information the description does not.
 */
export function notableFacts(c: ProbedCandidate): string | null {
  const notes: string[] = [];
  if (!c.facts.enabled) notes.push("disabled");
  if (c.facts.inert) notes.push("does not receive pointer events");
  if (!c.facts.inViewport) notes.push("scrolled out of view");
  if (c.facts.coveredBy) notes.push(`covered by "${c.facts.coveredBy}" — a click here hits that instead`);
  return notes.length > 0 ? notes.join("; ") : null;
}
