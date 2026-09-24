/**
 * The Jev client, with the two things a router needs that a bare client does
 * not: a size budget, and a halve-and-retry when the budget is wrong.
 *
 * Grown from `experiments/shared/jev.ts`, which is the version every report in
 * docs/ was measured with. What is added here is the part that only matters
 * once a router runs against input it did not choose:
 *
 *   - `POST /v1/systemone` has a 64Ki-token request ceiling and a separate
 *     32Ki-token ceiling on the state alone, neither in the published schema
 *     (docs/00). Tokens are not countable client-side, so the budget here is
 *     in BYTES and deliberately conservative.
 *   - When the estimate is wrong anyway, the fix that works is to split the
 *     question set and ask again (docs/tuning §3). A router cannot ask the
 *     caller to shorten their task.
 */

export type Instructions = string | Record<string, unknown> | unknown[];
export type Description = string | Record<string, unknown> | unknown[] | null;

export type Question =
  | { type: "noul"; instructions?: Instructions; criteria?: { true?: Description; false?: Description } }
  | { type: "choice"; instructions?: Instructions; criteria: Record<string, Description> }
  | { type: "score"; instructions?: Instructions; criteria: Description[] };

export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | {
      type: "score";
      score: number;
      confidence: number;
      legend: Record<string, Description>;
      probabilities: Record<string, number>;
    };

export interface SystemOneResponse {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
}

/** Observed server limit, absent from the OpenAPI schema. */
export const MAX_CHOICES = 255;

/**
 * A conservative stand-in for the 32Ki-token state ceiling.
 *
 * Bytes, not tokens, because the token count is the server's to compute and a
 * router that guesses high fails a request it could have served. 28,000 is the
 * figure `pi-jev-router` settled on for the same reason; it is a proxy, not a
 * measurement, and it is here so the number has one home.
 */
export const REQUEST_BUDGET_BYTES = 28_000;

export class JevError extends Error {}

/** Thrown when a payload cannot be made to fit by splitting. */
export class JevTooLargeError extends JevError {}

export interface JevOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Retries for 429/5xx and network errors. Default 5. */
  retries?: number;
  /** Per-request timeout. A router sits in front of a human; default 10 s. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function bytesOf(value: unknown): number {
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).length;
}

export class Jev {
  readonly model: string;
  #apiKey: string;
  #baseUrl: string;
  #fetch: typeof fetch;
  inputTokens = 0;
  outputTokens = 0;
  calls = 0;
  totalMs = 0;
  retriedCalls = 0;
  /** Requests that had to be split because the server refused the size. */
  splitCalls = 0;
  readonly retries: number;
  readonly timeoutMs: number;

  constructor(opts: JevOptions = {}) {
    const key = opts.apiKey ?? process.env.TYPESAFE_API_KEY ?? process.env.TYPESAFEAI_API_KEY ?? "";
    if (!key) throw new JevError("no API key; set TYPESAFE_API_KEY");
    this.#apiKey = key;
    this.#baseUrl = opts.baseUrl ?? "https://api.typesafe.ai";
    this.model = opts.model ?? "jev-latest";
    this.retries = opts.retries ?? 5;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  /**
   * Ask, splitting the question set if the server says the request is too big.
   *
   * Splitting is safe for the ANSWERS because a question's answer does not
   * move with the request's width -- docs/29 §4 measured 99.8% of answers
   * within 0.25 between a 74-wide request and a 1-wide one. It is not safe for
   * the STATE, which every half still carries, so a state that alone exceeds
   * the ceiling raises rather than looping.
   */
  async ask(state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> {
    const names = Object.keys(questions);
    if (names.length === 0) throw new JevError("need at least one question");
    for (const name of names) {
      const q = questions[name];
      if (q.type === "choice") {
        const n = Object.keys(q.criteria).length;
        if (n === 0) throw new JevError(`question '${name}': no choices`);
        if (n > MAX_CHOICES) {
          throw new JevError(`question '${name}': ${n} choices exceeds the server limit of ${MAX_CHOICES}`);
        }
      }
    }
    try {
      return await this.#post(state, questions);
    } catch (err) {
      if (!(err instanceof JevTooLargeError) || names.length === 1) throw err;
      this.splitCalls += 1;
      const half = Math.ceil(names.length / 2);
      const pick = (keys: string[]): Record<string, Question> =>
        Object.fromEntries(keys.map((k) => [k, questions[k]]));
      const [a, b] = await Promise.all([
        this.ask(state, pick(names.slice(0, half))),
        this.ask(state, pick(names.slice(half))),
      ]);
      return {
        model: a.model,
        answers: { ...a.answers, ...b.answers },
        usage: {
          input_tokens: a.usage.input_tokens + b.usage.input_tokens,
          output_tokens: a.usage.output_tokens + b.usage.output_tokens,
        },
      };
    }
  }

  async #post(state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> {
    const started = Date.now();
    const body = JSON.stringify({ model: this.model, state, questions });
    let lastError = "";
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      let res: Response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        res = await this.#fetch(`${this.#baseUrl}/v1/systemone`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" },
          body,
          signal: controller.signal,
        });
      } catch (err) {
        lastError = `network: ${String(err).slice(0, 200)}`;
        if (attempt > 0) this.retriedCalls += 1;
        await this.#backoff(attempt);
        continue;
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();
      if (res.ok) {
        const parsed = JSON.parse(text) as SystemOneResponse;
        this.calls += 1;
        this.totalMs += Date.now() - started;
        this.inputTokens += parsed.usage.input_tokens;
        this.outputTokens += parsed.usage.output_tokens;
        return parsed;
      }
      lastError = `HTTP ${res.status}: ${text.slice(0, 300)}`;
      // The size refusal is a 400 and is NOT retryable as sent; it is the one
      // 4xx the caller can do something about, so it gets its own type.
      if (text.includes("max_tokens_exceeded")) throw new JevTooLargeError(lastError);
      if (res.status !== 429 && res.status < 500) throw new JevError(lastError);
      if (attempt > 0) this.retriedCalls += 1;
      await this.#backoff(attempt);
    }
    throw new JevError(`gave up after ${this.retries + 1} attempts: ${lastError}`);
  }

  async #backoff(attempt: number): Promise<void> {
    const ms = Math.min(8_000, 250 * 2 ** attempt) * (0.5 + Math.random());
    await new Promise((r) => setTimeout(r, ms));
  }

  usage(): { calls: number; input: number; output: number; ms: number; usd: number } {
    return {
      calls: this.calls,
      input: this.inputTokens,
      output: this.outputTokens,
      ms: this.totalMs,
      // $0.042 per million input tokens, output free (docs/00).
      usd: (this.inputTokens / 1e6) * 0.042,
    };
  }
}
