/**
 * V8 function coverage, split into "has run" and "has never run".
 *
 * chaosbringer's `@mizchi/playwright-v8-coverage` gives the covered set —
 * `coverageSignature` drops every function whose ranges are all zero,
 * because the crawler only ever needs the delta. For coverage *guidance*
 * the complement is the useful half: the name of a function that has not
 * run yet is a hint about where to go, and nothing in the covered set
 * carries it.
 *
 * Getting that complement is not as simple as reading the zero-count
 * functions out of each snapshot, which is what I tried first.
 *
 * **`takePreciseCoverage` is only briefly complete.** V8 compiles
 * functions lazily and drops the metadata for ones nobody calls, so the
 * zero-count entries thin out as the page runs. Measured on the fixture's
 * inline script: the first snapshot after load lists all 15 functions,
 * 11 of them uncovered; after a couple of hash hops and one Playwright
 * click, the same script reports its covered functions and **none** of the
 * uncovered ones. Nothing went stale — they simply stop being mentioned,
 * which reads identically to "everything is covered now".
 *
 * So the inventory is taken once, from the first snapshot after load,
 * and `uncovered` is computed as `inventory − everCovered`, where
 * `everCovered` is the union of every take so far. That union is not
 * belt-and-braces; it is required, because of the second surprise:
 *
 * **`takePreciseCoverage` resets its counters on every take.** Each call
 * reports what ran *since the previous call*, and omits a script that ran
 * nothing at all. Measured by counting `render` calls across takes: 1,
 * then 2 after two more renders, then 1 after one more — cumulative would
 * have read 1, 3, 4, and two consecutive takes with no activity between
 * them report the script the first time and not at all the second.
 *
 * `@mizchi/playwright-v8-coverage` documents the opposite ("Counters
 * accumulate across `take()` calls — diff against a previous snapshot to
 * get per-action deltas"), which is what sent me down this path. Its own
 * crawler is unaffected: it unions each take into a run-long
 * `globalCoverage` and scores novelty against that, so the per-interval
 * reading gives the same answer. Anything that treats a single `take()`
 * as the whole picture does not.
 *
 * Two smaller things the first attempt got wrong, both worth stating
 * because they silently produce plausible output:
 *
 * - **Playwright's injected utility script reports `url: ""`.** A filter
 *   that admits the empty URL pulls in ~700 of Playwright's own function
 *   names and buries the page's dozen.
 * - **Names, not offsets.** Anonymous functions are dropped rather than
 *   reported by offset: an unreadable hint costs tokens and cannot be
 *   acted on. This is why the fixture's branches are declared functions
 *   while the rest of it uses arrows — `applyPromoCode` is a hint.
 */
import type { CDPSession } from "playwright";

interface V8Function {
  functionName: string;
  ranges: ReadonlyArray<{ startOffset: number; endOffset: number; count: number }>;
}
interface V8Script {
  scriptId: string;
  url: string;
  functions: ReadonlyArray<V8Function>;
}

export interface CoverageSplit {
  /** Named functions that have executed at least once, ever. */
  covered: Set<string>;
  /** Inventory minus covered: named functions nobody has reached yet. */
  uncovered: Set<string>;
}

export class FunctionCoverage {
  private started = false;
  /** Every named function seen in the first snapshot after load. */
  private inventory: Set<string> | null = null;
  /** Union of every covered set observed, since snapshots thin out. */
  private everCovered = new Set<string>();

  /**
   * @param originFilter which script URLs belong to the app under test.
   *   Must reject the empty URL — that is Playwright's own injected script.
   */
  constructor(
    private readonly cdp: CDPSession,
    private readonly originFilter: (url: string) => boolean,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    await this.cdp.send("Profiler.enable");
    await this.cdp.send("Profiler.startPreciseCoverage", {
      callCount: true,
      detailed: true,
      allowTriggeredUpdates: false,
    });
    this.started = true;
  }

  /**
   * Take the inventory. Call once, right after the page has loaded and
   * before anything else has run scripts in it; later is too late.
   */
  async captureInventory(): Promise<Set<string>> {
    const { named, covered } = await this.snapshot();
    this.inventory = named;
    // This snapshot's covered half is the only record of what ran during
    // load, and the next take will not repeat it.
    for (const name of covered) this.everCovered.add(name);
    return named;
  }

  async split(): Promise<CoverageSplit> {
    const { covered } = await this.snapshot();
    for (const name of covered) this.everCovered.add(name);
    const uncovered = new Set<string>();
    for (const name of this.inventory ?? []) {
      if (!this.everCovered.has(name)) uncovered.add(name);
    }
    return { covered: new Set(this.everCovered), uncovered };
  }

  private async snapshot(): Promise<{ named: Set<string>; covered: Set<string> }> {
    const named = new Set<string>();
    const covered = new Set<string>();
    if (!this.started) return { named, covered };
    const res = (await this.cdp.send("Profiler.takePreciseCoverage")) as {
      result: ReadonlyArray<V8Script>;
    };
    for (const script of res.result) {
      if (!this.originFilter(script.url)) continue;
      for (const fn of script.functions) {
        if (!fn.functionName) continue;
        named.add(fn.functionName);
        if (fn.ranges.some((r) => r.count > 0)) covered.add(fn.functionName);
      }
    }
    return { named, covered };
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    try {
      await this.cdp.send("Profiler.stopPreciseCoverage");
    } finally {
      this.started = false;
    }
  }
}
