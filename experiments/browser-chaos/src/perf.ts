/**
 * Per-step resource measurement, the minimum subset of what lightbringer
 * does.
 *
 * [lightbringer](https://github.com/mizchi/lightbringer) measures what a
 * Playwright scenario costs **at each step**, not just at load, and splits
 * it into network / CPU / render so that "the only way to move a number is
 * to change the implementation, not how the test waits." That split is the
 * part worth borrowing: a step that is 300ms slower is not actionable, and
 * a step that is 300ms slower *because the main thread was busy for 200 of
 * them* is.
 *
 * Three techniques taken from `src/browser.ts` and `src/session.ts` there:
 *
 * - **`PerformanceObserver` into a page-global store, installed as an init
 *   script** so it is running before any app code. `longtask` and
 *   `long-animation-frame` with `buffered: true`.
 * - **`takeRecords()` on flush.** The observer callback is a task of its
 *   own, so entries from the work that just finished are still pending
 *   when the harness reads the store. Without draining, a step's own long
 *   task lands on the *next* step -- which is worse than missing it,
 *   because it accuses the wrong step.
 * - **CDP `Performance.getMetrics` for the render counters.**
 *   `LayoutCount` / `RecalcStyleCount` and their durations are cumulative,
 *   so a per-step figure is a difference of two readings.
 *
 * Not borrowed (out of scope here): web-vitals attribution, LoAF
 * breakdown, the trace-based GPU and paint drilldown, memory gauges,
 * median gating. lightbringer has all of it; this file needs four numbers
 * per step.
 */
import type { CDPSession, Page } from "playwright";

export interface ThrottleOptions {
  /** Emulated link. Omit for "as fast as loopback", which is a lie. */
  network?: { latencyMs: number; downKbps: number; upKbps: number };
  /** CPU slowdown multiplier, as in Lighthouse. 1 or absent disables. */
  cpuThrottling?: number;
}

/** Roughly Chrome DevTools' "Fast 3G". */
export const FAST_3G: ThrottleOptions["network"] = {
  latencyMs: 150,
  downKbps: 1600,
  upKbps: 750,
};

/** What one step cost. */
export interface StepCost {
  label: string;
  /** Wall clock from just before the action to settled. */
  wallMs: number;
  /** Total time in `longtask` entries attributable to this step. */
  blockingMs: number;
  longTasks: number;
  /** Forced layouts and style recalcs during the step. */
  layoutCount: number;
  recalcStyleCount: number;
  layoutMs: number;
  /** Bytes over the wire during the step, and how many requests. */
  transferredKb: number;
  requests: number;
}

/** Installed before any app script runs, so nothing is missed. */
const INSTALL = `(() => {
  const store = { longTasks: [], loaf: [] };
  window.__perf = store;
  const drainLong = (entries) => {
    for (const e of entries) store.longTasks.push({ start: e.startTime, duration: e.duration });
  };
  const drainLoaf = (entries) => {
    for (const e of entries) store.loaf.push({ start: e.startTime, duration: e.duration });
  };
  const observers = [];
  const observe = (drain, init) => {
    try {
      const obs = new PerformanceObserver((list) => drain(list.getEntries()));
      obs.observe(init);
      observers.push([obs, drain]);
    } catch { /* entry type unsupported */ }
  };
  observe(drainLong, { type: "longtask", buffered: true });
  observe(drainLoaf, { type: "long-animation-frame", buffered: true });
  // The important half: the observer callback is its own task, so the
  // entry for the work that just ran is still queued when we read.
  store.flush = () => {
    for (const [obs, drain] of observers) {
      const pending = obs.takeRecords();
      if (pending.length > 0) drain(pending);
    }
  };
})()`;

const READ = `(() => {
  const s = window.__perf;
  if (!s) return { longTasks: [], loaf: [] };
  if (s.flush) s.flush();
  return { longTasks: s.longTasks.slice(), loaf: s.loaf.slice() };
})()`;

interface LongTask {
  start: number;
  duration: number;
}

export class PerfMeter {
  private lastMetrics = new Map<string, number>();
  private seenLongTasks = 0;
  private bytes = 0;
  private requests = 0;
  private outstanding = 0;

  private constructor(
    private readonly page: Page,
    private readonly cdp: CDPSession,
  ) {}

  /**
   * Must be called before the page navigates: the init script has to be
   * registered while the document is still empty, and `Network.enable`
   * before the first request.
   */
  static async attach(page: Page, cdp: CDPSession, opts: ThrottleOptions = {}): Promise<PerfMeter> {
    const meter = new PerfMeter(page, cdp);
    await page.addInitScript(INSTALL);
    await cdp.send("Performance.enable");
    await cdp.send("Network.enable");
    // Throttling, the other thing lightbringer does with CDP. Without it
    // a measurement over loopback says a 300KB download is free, which is
    // true of the harness and of nobody's users — and it makes a
    // network-bound step unrankable against a CPU-bound one.
    if (opts.network) {
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: opts.network.latencyMs,
        downloadThroughput: (opts.network.downKbps * 1024) / 8,
        uploadThroughput: (opts.network.upKbps * 1024) / 8,
      });
    }
    if (opts.cpuThrottling && opts.cpuThrottling > 1) {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: opts.cpuThrottling });
    }
    cdp.on("Network.requestWillBeSent", () => {
      meter.requests += 1;
      meter.outstanding += 1;
    });
    const settled = () => {
      meter.outstanding = Math.max(0, meter.outstanding - 1);
    };
    cdp.on("Network.loadingFailed", settled);
    // `dataReceived` rather than `loadingFinished`. The latter's
    // `encodedDataLength` came back 0 for a 300KB `fetch()` here, which
    // reads as "the network was free" — the most misleading number this
    // file could produce, since it turns a network-bound step into a
    // mystery. `dataReceived` fires per chunk and carries the real
    // encoded length.
    cdp.on("Network.dataReceived", (e) => {
      const d = e as { encodedDataLength?: number; dataLength?: number };
      meter.bytes += d.encodedDataLength || d.dataLength || 0;
    });
    cdp.on("Network.loadingFinished", (e) => {
      // Kept as a floor: a response served entirely from cache emits no
      // `dataReceived`, and some transfers only report here.
      const len = (e as { encodedDataLength?: number }).encodedDataLength ?? 0;
      if (len > 0 && meter.bytes === 0) meter.bytes += len;
      settled();
    });
    return meter;
  }

  /** Zero the per-step counters. Call immediately before the action. */
  async begin(): Promise<void> {
    this.lastMetrics = await this.metrics();
    const { longTasks } = (await this.read()) as { longTasks: LongTask[] };
    this.seenLongTasks = longTasks.length;
    this.bytes = 0;
    this.requests = 0;
    // Zeroed per step, not carried. `requestWillBeSent` can outnumber
    // the events that complete a request -- a stalled transfer, a
    // request the page abandons -- and a count that leaks once makes
    // every later step wait out the cap and report the cap as its cost.
    // That is a measurement bug that reads as a uniformly slow app.
    this.outstanding = 0;
  }

  /**
   * Wait until nothing is in flight, then a little longer.
   *
   * A fixed settle is not enough and the reason is the point of the
   * exercise: the app's click handler is `async` and Playwright's
   * `click()` does not await it, so a step whose cost is a 300KB fetch
   * finishes its *click* in 20ms. Read the counters there and the
   * network column says 0KB -- the step looks free, and the one
   * subsystem that was at fault is the one that reports nothing. This is
   * lightbringer's own framing: the only thing that should move a number
   * is the implementation, not how the test waits.
   */
  async settle(page: Page, quietMs = 150, capMs = 4000): Promise<void> {
    const deadline = Date.now() + capMs;
    while (this.outstanding > 0 && Date.now() < deadline) {
      await page.waitForTimeout(25);
    }
    await page.waitForTimeout(quietMs);
  }

  /** Read the counters back. Call once the step has settled. */
  async end(label: string, wallMs: number): Promise<StepCost> {
    const now = await this.metrics();
    const { longTasks } = (await this.read()) as { longTasks: LongTask[] };
    const fresh = longTasks.slice(this.seenLongTasks);
    const delta = (key: string) => (now.get(key) ?? 0) - (this.lastMetrics.get(key) ?? 0);
    return {
      label,
      wallMs,
      blockingMs: Math.round(fresh.reduce((n, t) => n + t.duration, 0)),
      longTasks: fresh.length,
      layoutCount: Math.round(delta("LayoutCount")),
      recalcStyleCount: Math.round(delta("RecalcStyleCount")),
      layoutMs: Math.round(delta("LayoutDuration") * 1000),
      transferredKb: Math.round(this.bytes / 1024),
      requests: this.requests,
    };
  }

  private async metrics(): Promise<Map<string, number>> {
    const res = (await this.cdp.send("Performance.getMetrics")) as {
      metrics: ReadonlyArray<{ name: string; value: number }>;
    };
    return new Map(res.metrics.map((m) => [m.name, m.value]));
  }

  private async read(): Promise<unknown> {
    try {
      return await this.page.evaluate(READ);
    } catch {
      return { longTasks: [], loaf: [] };
    }
  }
}

/**
 * The one line a human would read per step. Deliberately the same shape
 * as lightbringer's report rows, because the point of the split is that
 * it names the subsystem.
 */
export function formatCost(c: StepCost): string {
  return (
    `${c.label.padEnd(26)} ${String(c.wallMs).padStart(5)}ms  ` +
    `cpu block=${String(c.blockingMs).padStart(4)}ms tasks=${c.longTasks}  ` +
    `render layout=${String(c.layoutCount).padStart(4)}/${String(c.layoutMs).padStart(3)}ms ` +
    `style=${String(c.recalcStyleCount).padStart(4)}  ` +
    `net ${String(c.transferredKb).padStart(4)}KB/${c.requests}req`
  );
}
