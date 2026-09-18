/**
 * The spend ledger. The one thing none of the five components can do alone.
 *
 * "Resident" is the whole premise: this agent is meant to sit running, not to
 * be started for a task and stopped. That changes what a cost is. A component
 * measured at $0.000032 per decision (docs/18's gate) is free for an
 * afternoon and is not obviously free for a month of an agent that never
 * stops, because the number that matters is decisions per day and nobody
 * knows it in advance.
 *
 * So the ledger is here, it is shared by all five, and it has a ceiling. What
 * happens at the ceiling is the part worth being careful about: EVERY
 * COMPONENT'S NO-JUDGMENT PATH IS ITS SAFE PATH, by construction, so the
 * ceiling can simply stop asking.
 *
 *   the model router    stays on the current model
 *   the skill router    loads the catalogue's own "always" set and nothing else
 *   the guard rail      emits no verdict; the host's own permission rules apply
 *   the compactor       defers; the host's own summarising compaction runs
 *   the orchestrator    one agent
 *
 * That list is not a coincidence and it is not luck -- each of the five was
 * built so that its failure path is what the host would have done without it.
 * Stated here because it is the property that makes a hard ceiling safe, and
 * a future component that does not have it must not be added to this ledger.
 */

export type Component = "turn" | "guard" | "compact";

export interface BudgetConfig {
  /**
   * Input tokens per day, across all components. Null means no ceiling.
   *
   * 24,000,000 is $1.008 at $0.042/MTok. It is a round number chosen to be
   * generous rather than a measurement: at the ~900 input tokens a combined
   * turn request costs, it is about 26,000 turns, and a guard decision is
   * smaller again. A resident agent that reaches it is either much busier
   * than expected or looping, and both are worth finding out about.
   */
  dailyInputTokens: number | null;
  /** Requests per minute, across all components. Null means no limit. */
  perMinute: number | null;
}

export const DEFAULT_BUDGET: BudgetConfig = { dailyInputTokens: 24_000_000, perMinute: 120 };

/** Input price per million tokens. Output is free (docs/00). */
export const USD_PER_MTOK = 0.042;

interface Row {
  requests: number;
  inputTokens: number;
  failures: number;
  totalMs: number;
}

const empty = (): Row => ({ requests: 0, inputTokens: 0, failures: 0, totalMs: 0 });

export class Budget {
  #config: BudgetConfig;
  #rows = new Map<Component, Row>();
  /** Start of the current day window, and the tokens spent in it. */
  #dayStart: number;
  #dayTokens = 0;
  /** Request timestamps inside the last minute, for the rate limit. */
  #recent: number[] = [];
  #now: () => number;
  /** Times the ceiling turned judgment off. Reported, never silent. */
  stops = 0;

  constructor(config: Partial<BudgetConfig> = {}, now: () => number = Date.now) {
    this.#config = { ...DEFAULT_BUDGET, ...config };
    this.#now = now;
    this.#dayStart = now();
  }

  #roll(): void {
    const now = this.#now();
    if (now - this.#dayStart >= 86_400_000) {
      this.#dayStart = now;
      this.#dayTokens = 0;
    }
    this.#recent = this.#recent.filter((t) => now - t < 60_000);
  }

  /**
   * May a component ask right now?
   *
   * Returns a reason when not, because a component that silently stops
   * asking is indistinguishable from one that is broken -- and the whole
   * point of the safe-path property above is that stopping is a decision
   * somebody should be able to see.
   */
  allows(): { ok: true } | { ok: false; why: string } {
    this.#roll();
    const { dailyInputTokens, perMinute } = this.#config;
    if (dailyInputTokens !== null && this.#dayTokens >= dailyInputTokens) {
      return {
        ok: false,
        why: `the daily ceiling of ${dailyInputTokens.toLocaleString()} input tokens is spent ($${this.usd().toFixed(2)})`,
      };
    }
    if (perMinute !== null && this.#recent.length >= perMinute) {
      return { ok: false, why: `${perMinute} requests in the last minute` };
    }
    return { ok: true };
  }

  /** Record one request, whether it succeeded or not. */
  spent(component: Component, inputTokens: number, ms: number, failed = false): void {
    this.#roll();
    const row = this.#rows.get(component) ?? empty();
    row.requests += 1;
    row.inputTokens += inputTokens;
    row.totalMs += ms;
    if (failed) row.failures += 1;
    this.#rows.set(component, row);
    this.#dayTokens += inputTokens;
    this.#recent.push(this.#now());
  }

  /** Called when the ceiling refused a request, so the count is reportable. */
  stopped(): void {
    this.stops += 1;
  }

  totals(): Row & { usd: number } {
    const all = [...this.#rows.values()].reduce(
      (sum, r) => ({
        requests: sum.requests + r.requests,
        inputTokens: sum.inputTokens + r.inputTokens,
        failures: sum.failures + r.failures,
        totalMs: sum.totalMs + r.totalMs,
      }),
      empty(),
    );
    return { ...all, usd: (all.inputTokens / 1e6) * USD_PER_MTOK };
  }

  usd(): number {
    return (this.#dayTokens / 1e6) * USD_PER_MTOK;
  }

  byComponent(): { component: Component; row: Row; usd: number }[] {
    return [...this.#rows.entries()].map(([component, row]) => ({
      component,
      row: { ...row },
      usd: (row.inputTokens / 1e6) * USD_PER_MTOK,
    }));
  }

  /**
   * What a day at the current rate would cost.
   *
   * Extrapolated from the window so far, and useless in the first minute --
   * which is why it returns null until there is an hour to extrapolate from.
   * A projection off four requests is a number that looks like evidence.
   */
  projectedDailyUsd(): number | null {
    this.#roll();
    const elapsed = this.#now() - this.#dayStart;
    if (elapsed < 3_600_000) return null;
    return (this.#dayTokens / elapsed) * 86_400_000 * (USD_PER_MTOK / 1e6);
  }

  line(): string {
    const t = this.totals();
    const projected = this.projectedDailyUsd();
    return (
      `${t.requests} requests, ${t.inputTokens.toLocaleString()} input tokens, $${t.usd.toFixed(4)}` +
      (t.failures > 0 ? `, ${t.failures} failed` : "") +
      (this.stops > 0 ? `, ${this.stops} refused by the ceiling` : "") +
      (projected !== null ? ` (about $${projected.toFixed(2)}/day at this rate)` : "")
    );
  }
}
