/**
 * A five-service app that can be broken in sixteen ways, emitting
 * OTLP-shaped spans and log records.
 *
 * Why simulate rather than replay a real trace dump: the label. docs/23 §12
 * is the standing lesson here -- a rule-written label measures the rule, so
 * the labels that matter are MEASURED. This simulator gives two kinds:
 *
 *   cause          by construction (the fault that was injected, or none)
 *   user impact    measured (the fraction of edge requests that failed or
 *                  broke the 1s SLO), computed from the same spans the
 *                  triage sees -- never asserted by hand per scenario
 *
 * Everything is seeded, so a window is a pure function of (scenario, seed):
 * the same scenario produces byte-identical telemetry on every run, which is
 * what lets the record in `records/` stand in for the simulator.
 */

/** xorshift32: small, seeded, and identical across runs. */
export class Rng {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    let x = this.#state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.#state = x >>> 0;
    return this.#state / 0x100000000;
  }

  /** Log-normal-ish latency: a median with a long tail, in milliseconds. */
  latency(median: number, spread = 0.6): number {
    const u = Math.max(1e-9, this.next());
    const v = Math.max(1e-9, this.next());
    const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.max(1, median * Math.exp(spread * normal));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length) % xs.length];
  }
}

export const SERVICES = ["edge", "api", "cache", "db", "thirdparty", "worker"] as const;
export type Service = (typeof SERVICES)[number];

/** An OTLP span, flattened to the fields a triage would actually read. */
export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  service: Service;
  /** `service.version` resource attribute: what a deploy changes. */
  version: string;
  startMs: number;
  durationMs: number;
  /** OTLP status: UNSET/OK vs ERROR. */
  status: "OK" | "ERROR";
  /** `http.response.status_code` where it applies. */
  httpStatus?: number;
  attributes: Record<string, string | number | boolean>;
}

/** An OTLP log record. `severityNumber` follows the spec's 1..24 scale. */
export interface LogRecord {
  timeMs: number;
  service: Service;
  version: string;
  severityNumber: number;
  severityText: "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";
  body: string;
  traceId?: string;
  attributes: Record<string, string | number | boolean>;
}

export interface Window {
  scenario: string;
  /** Wall-clock length of the window in seconds. */
  seconds: number;
  spans: Span[];
  logs: LogRecord[];
  /** What a deploy pipeline would have posted, if anything. */
  deploys: { service: Service; version: string; atMs: number }[];
}

/**
 * What can go wrong. `cause` is the label; `page` is NOT a label -- severity
 * comes from the measured user impact in `truthFor`.
 */
export interface Scenario {
  id: string;
  /** The injected fault class, or "none". This is the cause label. */
  cause: string;
  /** Where the fault actually lives, or null when nothing is wrong. */
  service: Service | null;
  blurb: string;
  /** Requests per window, before any fault multiplies it. */
  rps?: number;
  apply: (p: Params, rng: Rng) => void;
}

/** The knobs a fault turns. Defaults are a healthy system. */
export interface Params {
  requests: number;
  /** Per-service median latency in ms. */
  latency: Record<Service, number>;
  /** Per-service error probability for a request that reaches it. */
  errorRate: Record<Service, number>;
  /** Fraction of reads served from cache. */
  cacheHit: number;
  /** A client retry on a failed edge request, as a multiplier on volume. */
  retryFactor: number;
  /** Version strings per service, and an optional canary share. */
  version: Record<Service, string>;
  canary: { service: Service; version: string; share: number; errorRate: number } | null;
  /** Extra INFO logs per request, for the noise cases. */
  chatter: number;
  /** Worker-side failures, which no user ever sees. */
  workerErrorRate: number;
  /** Auth rejections at the edge: 401s, not 5xx. */
  authRejectRate: number;
  /** thirdparty failures degrade a feature instead of failing the request. */
  thirdpartyDegrades: boolean;
  deploys: { service: Service; version: string; atMs: number }[];
}

const baseParams = (): Params => ({
  requests: 600,
  latency: { edge: 8, api: 45, cache: 3, db: 18, thirdparty: 120, worker: 200 },
  errorRate: { edge: 0.001, api: 0.002, cache: 0.0005, db: 0.001, thirdparty: 0.01, worker: 0.01 },
  cacheHit: 0.8,
  retryFactor: 1,
  version: {
    edge: "2.14.0",
    api: "5.2.1",
    cache: "7.0.4",
    db: "14.9",
    thirdparty: "n/a",
    worker: "5.2.1",
  },
  canary: null,
  chatter: 0.4,
  workerErrorRate: 0.01,
  authRejectRate: 0.004,
  thirdpartyDegrades: true,
  deploys: [],
});

/**
 * The sixteen windows.
 *
 * Ten have a fault, six do not, and the six are the point: `log_flood`,
 * `traffic_spike`, `batch_window`, `canary_1pct`, `cache_cold` and
 * `deploy_clean` all LOOK like something on a dashboard. docs/21 called this
 * class `nearmiss` and docs/26 found that a corpus without it is what makes a
 * rule fire on healthy code.
 */
export const SCENARIOS: Scenario[] = [
  {
    id: "db_slow",
    service: "db",
    cause: "dependency_latency",
    blurb: "the database's p50 goes from 18ms to 400ms and api starts timing out",
    apply: (p) => {
      p.latency.db = 400;
      p.latency.api = 520;
      p.errorRate.api = 0.28;
    },
  },
  {
    id: "bad_deploy",
    service: "api",
    cause: "bad_release",
    blurb: "api 5.3.0 ships with a null-pointer path on one endpoint",
    apply: (p) => {
      p.version.api = "5.3.0";
      p.errorRate.api = 0.22;
      p.deploys.push({ service: "api", version: "5.3.0", atMs: 40_000 });
    },
  },
  {
    id: "pool_exhausted",
    service: "db",
    cause: "saturation",
    blurb: "the db connection pool runs out under normal traffic",
    apply: (p) => {
      p.errorRate.db = 0.2;
      p.latency.db = 95;
      p.latency.api = 150;
    },
  },
  {
    id: "retry_storm",
    service: "edge",
    cause: "retry_amplification",
    blurb: "a client library retries three times on 5xx and triples the load",
    apply: (p) => {
      p.errorRate.api = 0.09;
      p.retryFactor = 3;
      p.cacheHit = 0.55;
      p.latency.api = 230;
    },
  },
  {
    id: "cpu_throttle",
    service: "api",
    cause: "saturation",
    blurb: "api is CPU-throttled: three times slower, no errors at all",
    apply: (p) => {
      p.latency.api = 1400;
      p.latency.edge = 24;
    },
  },
  {
    id: "thirdparty_outage",
    service: "thirdparty",
    cause: "upstream_outage",
    blurb: "the payment provider is down; the feature degrades and users see a banner",
    apply: (p) => {
      p.errorRate.thirdparty = 1;
      p.latency.thirdparty = 2000;
      p.thirdpartyDegrades = true;
    },
  },
  {
    id: "expired_cert",
    service: "thirdparty",
    cause: "upstream_outage",
    blurb: "the provider's certificate expired: TLS errors that DO fail the request",
    apply: (p) => {
      p.errorRate.thirdparty = 1;
      p.thirdpartyDegrades = false;
      p.errorRate.api = 0.16;
    },
  },
  {
    id: "auth_misconfig",
    service: "edge",
    cause: "config_error",
    blurb: "a rotated key rejects a third of logins with 401 -- no 5xx anywhere",
    apply: (p) => {
      p.authRejectRate = 0.33;
    },
  },
  {
    id: "worker_disk_full",
    service: "worker",
    cause: "capacity",
    blurb: "the batch worker's disk is full; nothing user-facing touches it",
    apply: (p) => {
      p.workerErrorRate = 0.9;
    },
  },
  {
    id: "cache_stampede",
    service: "cache",
    cause: "saturation",
    blurb: "a hot key expires and every request goes to the database at once",
    apply: (p) => {
      p.cacheHit = 0.05;
      p.latency.db = 210;
      p.latency.api = 260;
      p.errorRate.api = 0.06;
    },
  },

  // ---------------------------------------------------------------- healthy
  {
    id: "traffic_spike",
    service: null,
    cause: "none",
    blurb: "a campaign triples traffic and the system holds",
    apply: (p) => {
      p.requests = 1800;
      p.latency.api = 70;
      p.latency.db = 26;
    },
  },
  {
    id: "log_flood",
    service: null,
    cause: "none",
    blurb: "a debug flag ships and log volume goes up fifty times. Nothing is wrong",
    apply: (p) => {
      p.chatter = 22;
      p.deploys.push({ service: "api", version: "5.2.2", atMs: 25_000 });
      p.version.api = "5.2.2";
    },
  },
  {
    id: "batch_window",
    service: null,
    cause: "none",
    blurb: "the nightly job logs its expected 'will retry' warnings",
    apply: (p) => {
      p.workerErrorRate = 0.25;
    },
  },
  {
    id: "canary_1pct",
    service: null,
    cause: "none",
    blurb: "a canary takes 5% of traffic and errors on 1% of it, as designed",
    apply: (p) => {
      p.canary = { service: "api", version: "5.3.0-rc1", share: 0.05, errorRate: 0.01 };
      p.deploys.push({ service: "api", version: "5.3.0-rc1", atMs: 30_000 });
    },
  },
  {
    id: "cache_cold",
    service: null,
    cause: "none",
    blurb: "cache restarted, so the hit rate is low and latency is up for a minute",
    apply: (p) => {
      p.cacheHit = 0.25;
      p.latency.api = 95;
    },
  },
  {
    id: "quiet",
    service: null,
    cause: "none",
    blurb: "an ordinary five minutes",
    apply: () => {},
  },
];

const hex = (rng: Rng, n: number): string =>
  Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rng.next() * 16)]).join("");

const severityOf = (n: number): LogRecord["severityText"] =>
  n >= 21 ? "FATAL" : n >= 17 ? "ERROR" : n >= 13 ? "WARN" : n >= 9 ? "INFO" : "DEBUG";

const log = (
  out: LogRecord[],
  timeMs: number,
  service: Service,
  version: string,
  severityNumber: number,
  body: string,
  attributes: Record<string, string | number | boolean> = {},
  traceId?: string,
): void => {
  out.push({
    timeMs,
    service,
    version,
    severityNumber,
    severityText: severityOf(severityNumber),
    body,
    traceId,
    attributes,
  });
};

/** Generate one window of telemetry for a scenario. */
export function generate(scenario: Scenario, seed = 7): Window {
  const rng = new Rng(seed);
  const p = baseParams();
  if (scenario.rps) p.requests = scenario.rps;
  scenario.apply(p, rng);

  const seconds = 300;
  const spans: Span[] = [];
  const logs: LogRecord[] = [];
  const total = Math.round(p.requests * p.retryFactor);

  for (let i = 0; i < total; i += 1) {
    const t = Math.floor(rng.next() * seconds * 1000);
    const traceId = hex(rng, 32);
    const edgeSpan = hex(rng, 16);
    const canaryHit = p.canary !== null && rng.chance(p.canary.share);
    const apiVersion = canaryHit ? p.canary!.version : p.version.api;
    const attrs: Record<string, string | number | boolean> = {
      "http.request.method": rng.pick(["GET", "GET", "GET", "POST"]),
      "url.path": rng.pick(["/checkout", "/cart", "/search", "/profile", "/feed"]),
    };

    // Auth happens at the edge and fails with 401, which is not an outage.
    if (rng.chance(p.authRejectRate)) {
      const d = rng.latency(p.latency.edge);
      spans.push({
        traceId,
        spanId: edgeSpan,
        parentSpanId: null,
        name: "GET /*",
        service: "edge",
        version: p.version.edge,
        startMs: t,
        durationMs: d,
        status: "OK",
        httpStatus: 401,
        attributes: attrs,
      });
      if (rng.chance(0.25)) {
        log(logs, t, "edge", p.version.edge, 13, "auth: token signature mismatch", { "user.tier": rng.pick(["free", "pro"]) }, traceId);
      }
      continue;
    }

    // api -> cache -> db, and sometimes thirdparty.
    let apiDuration = rng.latency(p.latency.api);
    let apiFailed = false;

    const hitCache = rng.chance(p.cacheHit);
    const cacheSpan = hex(rng, 16);
    spans.push({
      traceId,
      spanId: cacheSpan,
      parentSpanId: edgeSpan,
      name: hitCache ? "cache.get hit" : "cache.get miss",
      service: "cache",
      version: p.version.cache,
      startMs: t + 2,
      durationMs: rng.latency(p.latency.cache),
      status: rng.chance(p.errorRate.cache) ? "ERROR" : "OK",
      attributes: { "cache.hit": hitCache },
    });

    if (!hitCache) {
      const dbFailed = rng.chance(p.errorRate.db);
      const dbDuration = rng.latency(p.latency.db);
      spans.push({
        traceId,
        spanId: hex(rng, 16),
        parentSpanId: edgeSpan,
        name: "SELECT items",
        service: "db",
        version: p.version.db,
        startMs: t + 4,
        durationMs: dbDuration,
        status: dbFailed ? "ERROR" : "OK",
        attributes: { "db.system": "postgresql", ...(dbFailed ? { "db.error": "connection pool exhausted" } : {}) },
      });
      if (dbFailed) {
        apiFailed = true;
        log(logs, t + 5, "db", p.version.db, 17, "FATAL: remaining connection slots are reserved", {}, traceId);
      }
      apiDuration += dbDuration;
    }

    if (attrs["url.path"] === "/checkout") {
      const tpFailed = rng.chance(p.errorRate.thirdparty);
      spans.push({
        traceId,
        spanId: hex(rng, 16),
        parentSpanId: edgeSpan,
        name: "POST provider/authorize",
        service: "thirdparty",
        version: p.version.thirdparty,
        startMs: t + 10,
        durationMs: rng.latency(p.latency.thirdparty),
        status: tpFailed ? "ERROR" : "OK",
        attributes: {
          "peer.service": "payments.example.com",
          ...(tpFailed ? { "error.type": p.thirdpartyDegrades ? "provider_unavailable" : "tls_certificate_expired" } : {}),
        },
      });
      if (tpFailed) {
        log(
          logs,
          t + 11,
          "api",
          apiVersion,
          p.thirdpartyDegrades ? 13 : 17,
          p.thirdpartyDegrades
            ? "payments unavailable, showing the retry banner"
            : "payments: certificate verify failed (CERT_HAS_EXPIRED)",
          { "peer.service": "payments.example.com" },
          traceId,
        );
        if (!p.thirdpartyDegrades) apiFailed = true;
      }
    }

    const ownError = canaryHit ? rng.chance(p.canary!.errorRate) : rng.chance(p.errorRate.api);
    if (ownError) apiFailed = true;

    spans.push({
      traceId,
      spanId: hex(rng, 16),
      parentSpanId: edgeSpan,
      name: "handle request",
      service: "api",
      version: apiVersion,
      startMs: t + 3,
      durationMs: apiDuration,
      status: apiFailed ? "ERROR" : "OK",
      httpStatus: apiFailed ? 500 : 200,
      attributes: attrs,
    });

    const edgeDuration = apiDuration + rng.latency(p.latency.edge);
    const edgeFailed = apiFailed || rng.chance(p.errorRate.edge);
    spans.push({
      traceId,
      spanId: edgeSpan,
      parentSpanId: null,
      name: `${attrs["http.request.method"]} ${attrs["url.path"]}`,
      service: "edge",
      version: p.version.edge,
      startMs: t,
      durationMs: edgeDuration,
      status: edgeFailed ? "ERROR" : "OK",
      httpStatus: edgeFailed ? (apiDuration > 5000 ? 504 : 500) : 200,
      attributes: attrs,
    });

    if (edgeFailed) {
      log(
        logs,
        t + Math.round(edgeDuration),
        "api",
        apiVersion,
        17,
        apiDuration > 5000
          ? "upstream timeout after 5000ms"
          : rng.pick([
              "TypeError: Cannot read properties of undefined (reading 'total')",
              "unhandled rejection in handler",
              "request failed: dependency error",
            ]),
        { "url.path": attrs["url.path"], "http.response.status_code": apiDuration > 5000 ? 504 : 500 },
        traceId,
      );
    }
    for (let c = 0; c < p.chatter; c += 1) {
      if (!rng.chance(Math.min(1, p.chatter))) continue;
      log(logs, t + 1, "api", apiVersion, 9, rng.pick([
        "handling request",
        "cache lookup complete",
        "serialized response",
        "feature flags evaluated",
      ]), { "url.path": attrs["url.path"] }, traceId);
    }
  }

  // The worker runs on its own schedule and nothing user-facing waits on it.
  for (let i = 0; i < 40; i += 1) {
    const t = Math.floor(rng.next() * seconds * 1000);
    const failed = rng.chance(p.workerErrorRate);
    spans.push({
      traceId: hex(rng, 32),
      spanId: hex(rng, 16),
      parentSpanId: null,
      name: "job.export",
      service: "worker",
      version: p.version.worker,
      startMs: t,
      durationMs: rng.latency(p.latency.worker),
      status: failed ? "ERROR" : "OK",
      attributes: { "job.name": "nightly-export" },
    });
    if (failed) {
      log(logs, t, "worker", p.version.worker, 17, "ENOSPC: no space left on device, write", { "job.name": "nightly-export" });
    }
  }

  return { scenario: scenario.id, seconds, spans, logs, deploys: p.deploys };
}

export interface Truth {
  scenario: string;
  /** By construction: the injected fault class, or "none". */
  cause: string;
  /** By construction: where the fault was injected, or null. */
  service: Service | null;
  /** Measured: share of edge requests that returned 5xx. */
  errorRatio: number;
  /** Measured: share of edge requests over the 1s SLO. */
  sloBreachRatio: number;
  /** Measured: share of edge requests that failed OR broke the SLO. */
  userImpact: number;
  /** Derived from the measured impact, not asserted per scenario. */
  severity: "noise" | "ticket" | "page";
}

/**
 * The label, computed from the window.
 *
 * `severity` is the only place a number was chosen by hand (5% and 0.5% of
 * user-facing requests), and it is applied to a MEASURED quantity rather than
 * to the scenario's name -- so a healthy scenario that happens to hurt users
 * gets called a page, and a scary-looking one that does not, does not.
 */
export function truthFor(w: Window, sloMs = 1000): Truth {
  const edge = w.spans.filter((s) => s.service === "edge" && s.parentSpanId === null);
  const failed = edge.filter((s) => (s.httpStatus ?? 200) >= 500).length;
  const slow = edge.filter((s) => s.durationMs > sloMs).length;
  const bad = edge.filter((s) => (s.httpStatus ?? 200) >= 500 || s.durationMs > sloMs).length;
  const n = Math.max(1, edge.length);
  const userImpact = bad / n;
  const scenario = SCENARIOS.find((s) => s.id === w.scenario)!;
  return {
    scenario: w.scenario,
    cause: scenario.cause,
    service: scenario.service,
    errorRatio: failed / n,
    sloBreachRatio: slow / n,
    userImpact,
    severity: userImpact > 0.05 ? "page" : userImpact > 0.005 ? "ticket" : "noise",
  };
}

/** Every cause class the triage may choose between. */
export const CAUSES = [
  "dependency_latency",
  "bad_release",
  "saturation",
  "retry_amplification",
  "upstream_outage",
  "config_error",
  "capacity",
] as const;
