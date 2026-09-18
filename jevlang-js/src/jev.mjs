/**
 * The Jev client the interpreter runs on. Zero dependencies, same retry
 * posture as experiments/shared/jev.ts: a program may issue a burst of
 * requests and losing one to a 529 should not kill the run.
 */
export class JevError extends Error {}

export class Jev {
  constructor({ apiKey, baseUrl, model, retries } = {}) {
    this.apiKey = apiKey ?? process.env.TYPESAFEAI_API_KEY ?? "";
    this.baseUrl = baseUrl ?? process.env.TYPESAFEAI_BASE_URL ?? "https://api.typesafe.ai";
    this.model = model ?? "jev-latest";
    this.retries = retries ?? 4;
    this.calls = 0;
    this.inputTokens = 0;
    this.totalMs = 0;
  }

  async ask(state, questions) {
    if (!this.apiKey) throw new JevError("no API key; set TYPESAFEAI_API_KEY");
    if (Object.keys(questions).length === 0) return { answers: {} };
    const body = JSON.stringify({ model: this.model, state, questions });
    const started = Date.now();
    let last = "";
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      let res;
      try {
        res = await fetch(`${this.baseUrl}/v1/systemone`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body,
        });
      } catch (err) {
        last = `network: ${String(err).slice(0, 160)}`;
        await backoff(attempt);
        continue;
      }
      const text = await res.text();
      if (res.ok) {
        const parsed = JSON.parse(text);
        this.calls += 1;
        this.totalMs += Date.now() - started;
        this.inputTokens += parsed.usage?.input_tokens ?? 0;
        return parsed;
      }
      last = `HTTP ${res.status}: ${text.slice(0, 240)}`;
      if (!(res.status === 429 || res.status >= 500) || attempt === this.retries) break;
      await backoff(attempt, res.headers.get("retry-after"));
    }
    throw new JevError(last);
  }
}

function backoff(attempt, retryAfter) {
  const hinted = retryAfter ? Number.parseFloat(retryAfter) * 1000 : Number.NaN;
  const wait = Number.isFinite(hinted)
    ? hinted
    : Math.min(20_000, 500 * 2 ** attempt) * (0.5 + Math.random());
  return new Promise((r) => setTimeout(r, wait));
}
