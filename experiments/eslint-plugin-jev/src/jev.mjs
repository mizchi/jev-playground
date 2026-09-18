/**
 * Zero-dependency Jev client, plus the batching that the plugin's cost story
 * rests on.
 *
 * Zero dependencies because this file is loaded by ESLint, and an editor that
 * lints on keystroke is the last place to add a transitive dependency tree.
 */

export class JevError extends Error {
  constructor(message, { status = 0, kind = "other" } = {}) {
    super(message);
    this.status = status;
    /** "too_big" | "auth" | "transient" | "other" -- what the caller can do. */
    this.kind = kind;
  }
}

export const DEFAULT_BASE_URL = "https://api.typesafe.ai";

export class Jev {
  constructor({ apiKey, baseUrl, model, retries, timeoutMs, onBody } = {}) {
    this.apiKey = apiKey ?? process.env.TYPESAFEAI_API_KEY ?? "";
    this.baseUrl = baseUrl ?? process.env.TYPESAFEAI_BASE_URL ?? DEFAULT_BASE_URL;
    this.model = model ?? "jev-latest";
    this.retries = retries ?? 4;
    this.timeoutMs = timeoutMs ?? 60_000;
    this.calls = 0;
    this.inputTokens = 0;
    this.totalMs = 0;
    this.retriedCalls = 0;
    this.splits = 0;
    /**
     * Called with the exact request body before it is sent. The experiment
     * passes its leak assertion here, so "the labels never cross the wire" is
     * checked against the bytes rather than against the code that built them.
     */
    this.onBody = onBody ?? null;
  }

  get spent() {
    return { calls: this.calls, inputTokens: this.inputTokens, ms: this.totalMs };
  }

  /** Dollars at the published input price; output is free. */
  get usd() {
    return (this.inputTokens / 1_000_000) * 0.042;
  }

  async ask(state, questions) {
    if (!this.apiKey) throw new JevError("no API key; set TYPESAFEAI_API_KEY", { kind: "auth" });
    const names = Object.keys(questions);
    if (names.length === 0) return { answers: {}, usage: { input_tokens: 0 } };
    const body = JSON.stringify({ model: this.model, state, questions });
    if (this.onBody) this.onBody(body);
    const started = Date.now();
    let last = new JevError("no attempt made");

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      let res;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        res = await fetch(`${this.baseUrl}/v1/systemone`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body,
          signal: ac.signal,
        });
      } catch (err) {
        last = new JevError(`network: ${String(err).slice(0, 200)}`, { kind: "transient" });
        clearTimeout(timer);
        if (attempt === this.retries) break;
        this.retriedCalls += 1;
        await backoff(attempt);
        continue;
      }
      clearTimeout(timer);
      const text = await res.text();
      if (res.ok) {
        const parsed = JSON.parse(text);
        this.calls += 1;
        this.totalMs += Date.now() - started;
        this.inputTokens += parsed.usage?.input_tokens ?? 0;
        return parsed;
      }
      // `max_tokens_exceeded` is the one 400 the caller can fix, by sending
      // less. Naming it here is what lets askBatched split instead of dying.
      const tooBig = res.status === 400 && text.includes("max_tokens_exceeded");
      last = new JevError(`HTTP ${res.status}: ${text.slice(0, 240)}`, {
        status: res.status,
        kind: tooBig ? "too_big" : res.status === 401 || res.status === 403 ? "auth" : "other",
      });
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt === this.retries) break;
      last.kind = "transient";
      this.retriedCalls += 1;
      await backoff(attempt, res.headers.get("retry-after"));
    }
    throw last;
  }

  /**
   * Ask about one state, splitting the question set if the server says the
   * request is too big.
   *
   * The plugin batches per file, and one 3000-line file with 80 functions can
   * cross the 64Ki request ceiling. Halving on the server's own 400 means the
   * token estimate in judge.mjs only has to be roughly right.
   */
  async askSplitting(state, questions) {
    const names = Object.keys(questions);
    try {
      return await this.ask(state, questions);
    } catch (err) {
      if (err.kind !== "too_big" || names.length < 2) throw err;
      this.splits += 1;
      const half = Math.ceil(names.length / 2);
      const merged = { answers: {}, usage: { input_tokens: 0 } };
      for (const part of [names.slice(0, half), names.slice(half)]) {
        const subset = Object.fromEntries(part.map((n) => [n, questions[n]]));
        const res = await this.askSplitting(state, subset);
        Object.assign(merged.answers, res.answers);
        merged.usage.input_tokens += res.usage?.input_tokens ?? 0;
      }
      return merged;
    }
  }
}

function backoff(attempt, retryAfter) {
  const hinted = retryAfter ? Number.parseFloat(retryAfter) * 1000 : Number.NaN;
  const wait = Number.isFinite(hinted)
    ? hinted
    : Math.min(20_000, 500 * 2 ** attempt) * (0.5 + Math.random());
  return new Promise((r) => setTimeout(r, wait));
}

/** Run jobs with bounded concurrency, preserving order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
