/**
 * Minimal Jev client — the TypeScript twin of `lib/` in this repo.
 *
 * Only the bits this experiment needs: `POST /v1/systemone` with named
 * questions, and the three answer shapes. The noul criteria are nested under
 * `criteria` because the server silently ignores top-level `true`/`false`
 * keys (see docs/00-api-notes.md).
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

export class JevError extends Error {}

export interface JevOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Retries for 429/5xx and network errors. Default 5. */
  retries?: number;
}

export class Jev {
  readonly model: string;
  #apiKey: string;
  #baseUrl: string;
  /** Totals across the run, so an experiment can report what it spent. */
  inputTokens = 0;
  outputTokens = 0;
  calls = 0;
  totalMs = 0;
  /** Calls that needed at least one retry, so a run can report the weather. */
  retriedCalls = 0;
  readonly retries: number;

  constructor(opts: JevOptions = {}) {
    const key = opts.apiKey ?? process.env.TYPESAFEAI_API_KEY ?? "";
    if (!key) throw new JevError("no API key; set TYPESAFEAI_API_KEY");
    this.#apiKey = key;
    this.#baseUrl = opts.baseUrl ?? "https://api.typesafe.ai";
    this.model = opts.model ?? "jev-latest";
    this.retries = opts.retries ?? 5;
  }

  async ask(
    state: unknown,
    questions: Record<string, Question>,
  ): Promise<SystemOneResponse> {
    const names = Object.keys(questions);
    if (names.length === 0) throw new JevError("need at least one question");
    for (const name of names) {
      const q = questions[name];
      if (q.type === "choice") {
        const n = Object.keys(q.criteria).length;
        if (n === 0) throw new JevError(`question '${name}': no choices`);
        if (n > MAX_CHOICES) {
          throw new JevError(
            `question '${name}': ${n} choices exceeds the server limit of ${MAX_CHOICES}`,
          );
        }
      }
    }
    const started = Date.now();
    const body = JSON.stringify({ model: this.model, state, questions });
    // Retry the transient statuses. A long collection run WILL meet a 529
    // eventually, and losing an hour of positions to one overloaded response
    // is not a result about anything.
    let lastError = "";
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      let res: Response;
      try {
        res = await fetch(`${this.#baseUrl}/v1/systemone`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
            "content-type": "application/json",
          },
          body,
        });
      } catch (err) {
        lastError = `network: ${String(err).slice(0, 200)}`;
        await this.#backoff(attempt);
        continue;
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
      // 4xx other than rate limiting is our bug; retrying it just wastes time.
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt === this.retries) break;
      this.retriedCalls += 1;
      await this.#backoff(attempt, res.headers.get("retry-after"));
    }
    throw new JevError(lastError);
  }

  /** Exponential backoff with jitter, honouring Retry-After when present. */
  async #backoff(attempt: number, retryAfter?: string | null): Promise<void> {
    const hinted = retryAfter ? Number.parseFloat(retryAfter) * 1000 : NaN;
    const wait = Number.isFinite(hinted)
      ? hinted
      : Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + Math.random());
    await new Promise((r) => setTimeout(r, wait));
  }
}

export function noul(a: Answer | undefined): number {
  return a?.type === "noul" ? a.noul : 0;
}

export function choice(a: Answer | undefined): { choice: string; confidence: number } {
  return a?.type === "choice" ? { choice: a.choice, confidence: a.confidence } : { choice: "", confidence: 0 };
}

export function score(a: Answer | undefined): { score: number; confidence: number } {
  return a?.type === "score" ? { score: a.score, confidence: a.confidence } : { score: 0, confidence: 0 };
}
