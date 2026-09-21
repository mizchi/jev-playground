/**
 * The candidate shape this package decides over, and the one fact about
 * it that a description cannot carry.
 *
 * Structural, not imported from `chaosbringer`. Two reasons, and the
 * second is the load-bearing one:
 *
 *  - The published `chaosbringer@0.9.0` predates the geometry (its
 *    `#143`), so `coveredBy` / `inert` / `inViewport` are simply absent
 *    there. Every one is optional here, and absent has to mean "not
 *    measured" rather than "fine" — see `isObstructed`.
 *  - A structural type keeps this package installable against any
 *    version in the peer range. TypeScript is structural, so the
 *    `Driver` built on top still plugs into the real crawler.
 */

/** What the crawler knows about one control it could act on. */
export interface Candidate {
  /** Positional into the crawler's target list. The answer is this. */
  index: number;
  /** Role + accessible name + visible text, as the crawler computed it. */
  description: string;
  /** `"input"` is the class `fill()` accepts; the rest take a click. */
  type: "link" | "button" | "input" | "interactive" | "scroll";
  href?: string;
  inViewport?: boolean;
  /** What will receive a click aimed here, when it is not this element. */
  coveredBy?: string;
  /** `pointer-events: none`: a click aimed here passes through. */
  inert?: boolean;
}

/**
 * Does the geometry say a click aimed here lands elsewhere?
 *
 * True only on positive evidence, which is the same rule the crawler
 * uses: an off-screen candidate and an unmeasured one both come back
 * `false`, because "we do not know" and "it is fine" have to be answered
 * the same way. A false positive drops a control that works.
 *
 * On a crawler version that reports no geometry this is `false` for
 * everything, and the driver degrades to deciding without it rather
 * than refusing to run.
 */
export function isObstructed(c: Pick<Candidate, "inert" | "coveredBy">): boolean {
  return c.inert === true || c.coveredBy !== undefined;
}

/**
 * The extras a `<select>` and a filled field have that the crawler does
 * not carry, read off the page by `enrich`.
 */
export interface CandidateExtras {
  /** A dropdown's own options. Empty for everything else. */
  options: { value: string; label: string }[];
  /** What the field holds right now. `""` for a control. */
  currentValue: string;
}

export type Enriched = Candidate & CandidateExtras;

/** An enriched candidate with options is the only thing SELECT can name. */
export function isDropdown(c: Enriched): boolean {
  return c.options.length > 0;
}

/**
 * How a candidate reads in the state, geometry included.
 *
 * The obstruction is **told, not removed**. docs/62 §4 measured the two
 * as equivalent for accuracy — dropping a blocked candidate and labelling
 * it reached the same states in the same number of steps — and docs/05 §3
 * breaks the tie on recoverability: a wrong label is one the model can
 * overrule, a wrong removal closes the route at every threshold. The
 * geometry here is a hit test that can be wrong (a candidate covered at
 * its centre but clickable at its edge), so it goes in as a fact.
 */
export function describeForState(c: Enriched): Record<string, unknown> {
  const out: Record<string, unknown> = {
    index: c.index,
    what: `${c.type}: ${c.description}`,
  };
  if (c.href) out.href = c.href;
  if (c.currentValue) out.currently_holds = c.currentValue;
  if (c.options.length > 0) out.offers = c.options.map((o) => o.label);
  if (c.inert === true) {
    out.note = "clicks pass through this element (pointer-events: none)";
  } else if (c.coveredBy !== undefined) {
    out.note = `a click here is received by: ${c.coveredBy}`;
  } else if (c.inViewport === false) {
    // Not a warning. Playwright scrolls before acting, so off-screen is
    // perfectly actionable — but it is the reason no hit test ran, and
    // saying so keeps "nothing on top" apart from "not measured".
    out.note = "off screen; not hit-tested";
  }
  return out;
}
