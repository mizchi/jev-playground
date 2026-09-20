/**
 * What goes in the state, and what gets asked.
 *
 * The arms are the experiment. An observability window does not fit in a
 * request -- `log_flood` alone is thirteen thousand log records -- so
 * something has to decide what the triage sees, and that decision is the same
 * one docs/23 §4 measured for diffs (paths against hunks) and docs/21 §6 for
 * code (function against file):
 *
 *   aggregate   the numbers a dashboard shows: per-service error ratio, p50/
 *               p95/p99, log counts by severity, version mix, top error bodies
 *   noalert     the same, minus the list of alerts that fired -- because
 *               "these thresholds tripped" is the detector's OPINION, and
 *               docs/08 measured what happens when a suggestion arrives as a
 *               decision instead of as advice
 *   nostrings   the same, minus the error log BODIES. A runbook's cause
 *               matching is a regex over those strings, so this arm asks
 *               which half of the state the class actually comes from --
 *               docs/16's "rule id or description?" in another domain
 *   sample      no aggregates at all, just raw OTLP records chosen by a rule
 *               that puts the loudest ones first -- which is what every log
 *               viewer does when you filter by severity
 *   uniform     the same COUNT of records, sampled uniformly, so the arm
 *               above can be read as "the sampling rule" rather than "raw
 *               records"
 *   both        aggregate plus the sample
 *   raw         as much of the window as the state ceiling allows, in arrival
 *               order, which is what "just send the logs" means in practice
 *
 * The questions are identical in every arm, so the only thing moving is what
 * the model can see.
 */
import type { Question } from "../../shared/jev.js";
import type { Alert, WindowMetrics } from "./detect.js";
import { CAUSES, SERVICES, type LogRecord, type Span, type Window } from "./telemetry.js";

export const ARMS = ["aggregate", "noalert", "nostrings", "sample", "uniform", "both", "raw"] as const;
export type ArmName = (typeof ARMS)[number];

export const ARM_BLURB: Record<ArmName, string> = {
  aggregate: "the dashboard's numbers, no raw records",
  noalert: "the same numbers with the alert list removed",
  nostrings: "the same numbers with the error log bodies removed",
  sample: "raw OTLP records only, chosen by a rule (loudest first)",
  uniform: "the same number of raw records, sampled uniformly",
  both: "aggregate plus the sample",
  raw: "the window in arrival order, truncated at the state ceiling",
};

/**
 * The state ceiling, in characters.
 *
 * docs/00 measured the ceiling in TOKENS (32Ki for the state), and the first
 * version of this arm converted at four characters a token -- which is right
 * for prose and wrong for JSON full of hex ids and punctuation. The server
 * answered `max_tokens_exceeded` on every window. 2.4 is the conservative
 * number that holds here, and `askFitting` in run.ts halves and retries
 * rather than trusting it.
 */
export const STATE_CHAR_BUDGET = Math.floor(32768 * 2.4) - 6000;

/**
 * The sample: what an on-call engineer would actually open.
 *
 * Deterministic and biased on purpose -- the loudest logs, the slowest spans,
 * the failed spans, then a stride through the rest so the quiet majority is
 * represented at all. A uniform sample of `log_flood` is 20 lines of
 * "handling request", which is exactly the arm that should lose if the
 * sampling rule matters.
 */
export function uniformSampleOf(w: Window, logs = 24, spans = 14): { logs: LogRecord[]; spans: Span[] } {
  const stride = Math.max(1, Math.floor(w.logs.length / logs));
  const spanStride = Math.max(1, Math.floor(w.spans.length / spans));
  return {
    logs: w.logs.filter((_, i) => i % stride === 0).slice(0, logs).sort((a, b) => a.timeMs - b.timeMs),
    spans: w.spans.filter((_, i) => i % spanStride === 0).slice(0, spans).sort((a, b) => a.startMs - b.startMs),
  };
}

export function sampleOf(w: Window, logs = 24, spans = 14): { logs: LogRecord[]; spans: Span[] } {
  const bySeverity = [...w.logs].sort((a, b) => b.severityNumber - a.severityNumber || a.timeMs - b.timeMs);
  const loud = bySeverity.filter((l) => l.severityNumber >= 13).slice(0, Math.ceil(logs * 0.75));
  const quiet = w.logs.filter((l) => l.severityNumber < 13);
  const stride = Math.max(1, Math.floor(quiet.length / Math.max(1, logs - loud.length)));
  const rest = quiet.filter((_, i) => i % stride === 0).slice(0, logs - loud.length);

  const slowest = [...w.spans].sort((a, b) => b.durationMs - a.durationMs).slice(0, Math.ceil(spans / 3));
  const failed = w.spans.filter((s) => s.status === "ERROR" && !slowest.includes(s)).slice(0, Math.ceil(spans / 3));
  const taken = new Set([...slowest, ...failed]);
  const others = w.spans.filter((s) => !taken.has(s));
  const spanStride = Math.max(1, Math.floor(others.length / Math.max(1, spans - taken.size)));
  const filler = others.filter((_, i) => i % spanStride === 0).slice(0, spans - taken.size);

  return {
    logs: [...loud, ...rest].sort((a, b) => a.timeMs - b.timeMs),
    spans: [...slowest, ...failed, ...filler].sort((a, b) => a.startMs - b.startMs),
  };
}

/** Truncate a record list so the serialised state stays under the ceiling. */
export function fitToBudget<T>(items: T[], budget: number): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  let used = 0;
  for (const item of items) {
    const cost = JSON.stringify(item).length + 1;
    if (used + cost > budget) break;
    kept.push(item);
    used += cost;
  }
  return { kept, dropped: items.length - kept.length };
}

export interface StateResult {
  state: Record<string, unknown>;
  /** How many records the ceiling cut, for the `raw` arm's honesty. */
  dropped: number;
}

export function stateFor(
  arm: ArmName,
  w: Window,
  metrics: WindowMetrics,
  alerts: Alert[],
): StateResult {
  // Every arm gets the alert that woke us and the deploys, because that is
  // what an incident channel contains before anybody looks at anything.
  const head = {
    observing: "one five-minute window of OpenTelemetry data from a six-service web application",
    window_seconds: w.seconds,
    services: SERVICES,
    topology: "edge -> api -> {cache, db, thirdparty}; worker runs batch jobs nothing user-facing waits on",
    slo: "a user-facing request is good when it returns under 1000ms and not a 5xx",
    alerts_that_fired: alerts.map((a) => a.text),
    deploys_in_window: w.deploys,
  };

  if (arm === "aggregate") {
    return { state: { ...head, metrics: forState(metrics) }, dropped: 0 };
  }
  if (arm === "nostrings") {
    return {
      state: {
        ...head,
        metrics: forState({ ...metrics, topErrors: [] }),
        note: "error log bodies are withheld; the per-severity counts are not",
      },
      dropped: 0,
    };
  }
  if (arm === "noalert") {
    // Same window, same numbers, no verdict from the detector.
    const { alerts_that_fired, ...rest } = head;
    return { state: { ...rest, metrics: forState(metrics) }, dropped: 0 };
  }
  if (arm === "sample" || arm === "uniform") {
    const s = arm === "sample" ? sampleOf(w) : uniformSampleOf(w);
    return {
      state: {
        ...head,
        sampled_logs: s.logs,
        sampled_spans: s.spans,
        sampling:
          arm === "sample"
            ? "loudest logs, slowest and failed spans, then a stride through the rest"
            : "every Nth record, without regard to severity",
      },
      dropped: w.logs.length + w.spans.length - s.logs.length - s.spans.length,
    };
  }
  if (arm === "both") {
    const s = sampleOf(w);
    return {
      state: { ...head, metrics: forState(metrics), sampled_logs: s.logs, sampled_spans: s.spans },
      dropped: w.logs.length + w.spans.length - s.logs.length - s.spans.length,
    };
  }
  // raw: arrival order, nothing chosen, cut where the ceiling is.
  const interleaved = [
    ...w.logs.map((l) => ({ at: l.timeMs, record: { type: "log", ...l } })),
    ...w.spans.map((s) => ({ at: s.startMs, record: { type: "span", ...s } })),
  ]
    .sort((a, b) => a.at - b.at)
    .map((x) => x.record);
  // The head, the two wrapper keys and the commas between records all land in
  // the same budget, so leave room for them rather than discovering it in a
  // 400 from the server.
  const { kept, dropped } = fitToBudget(
    interleaved,
    STATE_CHAR_BUDGET - JSON.stringify(head).length - 600,
  );
  return { state: { ...head, records: kept, records_dropped: dropped }, dropped };
}

/** Trim the metrics to what a dashboard shows, and round it. */
function forState(m: WindowMetrics): unknown {
  return {
    user_requests: m.userRequests,
    log_volume: m.logVolume,
    per_service: m.services.map((s) => ({
      service: s.service,
      spans: s.requests,
      error_ratio: Number(s.errorRatio.toFixed(4)),
      p50_ms: s.p50,
      p95_ms: s.p95,
      p99_ms: s.p99,
      logs: s.logs,
      versions: s.versions,
      ...(s.cacheHitRatio === undefined ? {} : { cache_hit_ratio: Number(s.cacheHitRatio.toFixed(3)) }),
    })),
    top_error_logs: m.topErrors,
  };
}

export const SEVERITY = "severity";
export const CAUSE = "cause";
export const ROOT = "root_service";
export const NO_INCIDENT = "no_incident";
export const USER_VISIBLE = "user_visible";
export const DEPLOY_RELATED = "deploy_related";
export const SELF_HEALING = "self_healing";
export const OURS = "ours_to_fix";

/**
 * Eight questions, one request.
 *
 * Shapes follow docs/practice §1: the ordered answer is a `score`, the
 * mutually exclusive ones are `choice`, and the independent predicates are
 * `noul`. The escape hatch is its own question rather than an option inside
 * `cause`, which docs/17 §3 measured as 18/18 against 16/18.
 */
export function questions(): Record<string, Question> {
  return {
    [SEVERITY]: {
      type: "score",
      instructions: "How should this window be triaged right now?",
      criteria: [
        "Nothing to do: this is normal operation or harmless noise.",
        "Worth a ticket: something is wrong but no user is being hurt right now.",
        "Page someone: users are being hurt and it will not fix itself.",
      ],
    },
    [CAUSE]: {
      type: "choice",
      instructions: "If something is wrong here, what kind of problem is it?",
      criteria: {
        dependency_latency: "A downstream dependency got slow and callers are timing out.",
        bad_release: "A newly deployed version is failing where the previous one did not.",
        saturation: "A resource is exhausted: connections, CPU, memory, a cache that stopped absorbing load.",
        retry_amplification: "Clients retrying failures are multiplying the load.",
        upstream_outage: "A third party outside this system is failing.",
        config_error: "A setting, credential or key is wrong rather than any code.",
        capacity: "Something ran out of room: disk, quota, a queue.",
      },
    },
    [ROOT]: {
      type: "choice",
      instructions: "Which service is where the problem actually lives (not where it shows up)?",
      criteria: Object.fromEntries(
        SERVICES.map((s) => [
          s,
          s === "edge"
            ? "The entry point every user request passes through."
            : s === "api"
              ? "The application handling requests."
              : s === "cache"
                ? "The read cache in front of the database."
                : s === "db"
                  ? "The database."
                  : s === "thirdparty"
                    ? "An external provider this system calls."
                    : "The batch worker, which no user-facing request waits on.",
        ]),
      ),
    },
    [NO_INCIDENT]: {
      type: "noul",
      instructions: "Nothing in this window needs anyone's attention.",
      criteria: {
        true: "Normal operation, including unusual-looking but harmless patterns.",
        false: "Something here is a real problem, whether or not users feel it yet.",
      },
    },
    [USER_VISIBLE]: {
      type: "noul",
      instructions: "Users are experiencing failures or waits they would notice.",
      criteria: { true: "Requests users made are failing or are slow.", false: "Users are getting normal service." },
    },
    [DEPLOY_RELATED]: {
      type: "noul",
      instructions: "This started with a deployment.",
      criteria: { true: "The problem tracks a version change.", false: "No version change explains it." },
    },
    [SELF_HEALING]: {
      type: "noul",
      instructions: "This will clear up on its own without anyone acting.",
      criteria: { true: "A warm-up, a burst, or a transient that passes.", false: "It needs an action to stop." },
    },
    [OURS]: {
      type: "noul",
      instructions: "The fix belongs to this team rather than to somebody else.",
      criteria: { true: "Something this team owns has to change.", false: "It is a third party's or a client's problem." },
    },
  };
}

export { CAUSES };
