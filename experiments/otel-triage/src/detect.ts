/**
 * Detection, in code. Nothing here asks Jev anything.
 *
 * This is the division docs/23 §5 measured -- what rules can compute, rules
 * compute, for free and without being wrong about it. An error ratio, a p95,
 * a volume multiple against a baseline: an alerting config has done this for
 * twenty years and there is nothing for a judgment to add.
 *
 * What is left over is the part this experiment is about: which of these
 * numbers is an incident, what kind, and whether anyone should be woken up.
 */
import type { LogRecord, Service, Span, Window } from "./telemetry.js";
import { SERVICES } from "./telemetry.js";

export interface ServiceMetrics {
  service: Service;
  requests: number;
  errors: number;
  errorRatio: number;
  p50: number;
  p95: number;
  p99: number;
  logs: { debug: number; info: number; warn: number; error: number; fatal: number };
  versions: Record<string, number>;
  /** Cache only: the hit ratio, which is a cause rather than a symptom. */
  cacheHitRatio?: number;
}

export interface WindowMetrics {
  scenario: string;
  seconds: number;
  /** Edge requests: the only ones a user waited for. */
  userRequests: number;
  /**
   * Share of user-facing requests over the 1s SLO.
   *
   * Deliberately NOT in any arm's state: the arms show p50/p95/p99, which is
   * what a dashboard shows. This is here for the `rules+slo` baseline, and
   * the asymmetry is the finding rather than a flaw -- when the label is
   * arithmetic on a measured quantity, the arithmetic wins by computing it.
   */
  sloBreachRatio: number;
  services: ServiceMetrics[];
  /** Normalised log bodies, most frequent first. */
  topErrors: { body: string; count: number; services: Service[] }[];
  deploys: Window["deploys"];
  logVolume: number;
}

const percentile = (xs: number[], q: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/** Strip the parts of a log body that differ per occurrence. */
export function normaliseBody(body: string): string {
  return body
    .replace(/0x[0-9a-f]+/gi, "0xHEX")
    .replace(/\b[0-9a-f]{8,}\b/gi, "ID")
    .replace(/\b\d+(\.\d+)?(ms|s|MB|GB)?\b/g, "N")
    .slice(0, 90);
}

export function metricsFor(w: Window): WindowMetrics {
  const byService = new Map<Service, Span[]>();
  for (const s of w.spans) {
    const at = byService.get(s.service);
    if (at) at.push(s);
    else byService.set(s.service, [s]);
  }
  const logsByService = new Map<Service, LogRecord[]>();
  for (const l of w.logs) {
    const at = logsByService.get(l.service);
    if (at) at.push(l);
    else logsByService.set(l.service, [l]);
  }

  const services: ServiceMetrics[] = [];
  for (const service of SERVICES) {
    const spans = byService.get(service) ?? [];
    if (spans.length === 0) continue;
    const durations = spans.map((s) => s.durationMs);
    const logs = logsByService.get(service) ?? [];
    const versions: Record<string, number> = {};
    for (const s of spans) versions[s.version] = (versions[s.version] ?? 0) + 1;
    const errors = spans.filter((s) => s.status === "ERROR").length;
    services.push({
      service,
      requests: spans.length,
      errors,
      errorRatio: errors / spans.length,
      p50: Math.round(percentile(durations, 0.5)),
      p95: Math.round(percentile(durations, 0.95)),
      p99: Math.round(percentile(durations, 0.99)),
      logs: {
        debug: logs.filter((l) => l.severityNumber < 9).length,
        info: logs.filter((l) => l.severityNumber >= 9 && l.severityNumber < 13).length,
        warn: logs.filter((l) => l.severityNumber >= 13 && l.severityNumber < 17).length,
        error: logs.filter((l) => l.severityNumber >= 17 && l.severityNumber < 21).length,
        fatal: logs.filter((l) => l.severityNumber >= 21).length,
      },
      versions,
      ...(service === "cache"
        ? { cacheHitRatio: spans.filter((s) => s.attributes["cache.hit"] === true).length / spans.length }
        : {}),
    });
  }

  const counts = new Map<string, { count: number; services: Set<Service> }>();
  for (const l of w.logs) {
    if (l.severityNumber < 13) continue;
    const key = normaliseBody(l.body);
    const at = counts.get(key) ?? { count: 0, services: new Set<Service>() };
    at.count += 1;
    at.services.add(l.service);
    counts.set(key, at);
  }
  const topErrors = [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 6)
    .map(([body, v]) => ({ body, count: v.count, services: [...v.services] }));

  const userFacing = w.spans.filter((s) => s.service === "edge" && s.parentSpanId === null);
  return {
    scenario: w.scenario,
    seconds: w.seconds,
    userRequests: userFacing.length,
    sloBreachRatio:
      userFacing.length === 0 ? 0 : userFacing.filter((s) => s.durationMs > 1000).length / userFacing.length,
    services,
    topErrors,
    deploys: w.deploys,
    logVolume: w.logs.length,
  };
}

export interface Alert {
  service: Service;
  kind: "error_rate" | "latency" | "error_logs" | "traffic";
  value: number;
  baseline: number;
  ratio: number;
  text: string;
}

/**
 * The thresholds an alerting config would hold. Every one of them is a number
 * somebody typed, which is the honest state of every alerting config in
 * production -- and the reason the triage downstream has work to do.
 */
export const RULES = {
  /** An error ratio must be this many times the baseline AND this large. */
  errorRatioFactor: 3,
  errorRatioFloor: 0.01,
  latencyFactor: 3,
  logErrorFactor: 5,
  trafficFactor: 2.5,
};

export function detect(metrics: WindowMetrics, baseline: WindowMetrics): Alert[] {
  const out: Alert[] = [];
  const baseOf = (s: Service) => baseline.services.find((x) => x.service === s);
  for (const m of metrics.services) {
    const b = baseOf(m.service);
    if (!b) continue;
    const ratio = m.errorRatio / Math.max(1e-6, b.errorRatio);
    if (ratio >= RULES.errorRatioFactor && m.errorRatio >= RULES.errorRatioFloor) {
      out.push({
        service: m.service,
        kind: "error_rate",
        value: Number(m.errorRatio.toFixed(4)),
        baseline: Number(b.errorRatio.toFixed(4)),
        ratio: Number(ratio.toFixed(1)),
        text: `${m.service} error ratio ${(m.errorRatio * 100).toFixed(1)}% against a ${(b.errorRatio * 100).toFixed(1)}% baseline`,
      });
    }
    if (m.p95 >= b.p95 * RULES.latencyFactor) {
      out.push({
        service: m.service,
        kind: "latency",
        value: m.p95,
        baseline: b.p95,
        ratio: Number((m.p95 / Math.max(1, b.p95)).toFixed(1)),
        text: `${m.service} p95 ${m.p95}ms against a ${b.p95}ms baseline`,
      });
    }
    const logErrors = m.logs.error + m.logs.fatal;
    const baseLogErrors = b.logs.error + b.logs.fatal;
    if (logErrors >= Math.max(10, baseLogErrors * RULES.logErrorFactor)) {
      out.push({
        service: m.service,
        kind: "error_logs",
        value: logErrors,
        baseline: baseLogErrors,
        ratio: Number((logErrors / Math.max(1, baseLogErrors)).toFixed(1)),
        text: `${m.service} logged ${logErrors} errors against a baseline of ${baseLogErrors}`,
      });
    }
    if (m.requests >= b.requests * RULES.trafficFactor) {
      out.push({
        service: m.service,
        kind: "traffic",
        value: m.requests,
        baseline: b.requests,
        ratio: Number((m.requests / Math.max(1, b.requests)).toFixed(1)),
        text: `${m.service} handled ${m.requests} spans against a baseline of ${b.requests}`,
      });
    }
  }
  return out;
}

export type Severity = "noise" | "ticket" | "page";

/**
 * Triage in rules alone: the baseline docs/07 insists on.
 *
 * Severity is arithmetic on what the detector already measured -- the same
 * shape as the label -- so this arm is expected to be strong there, and that
 * IS the finding: the ordered part of the answer does not need a judgment.
 * Cause is a runbook's string match, which is how it is actually done.
 */
export function rulesTriage(
  metrics: WindowMetrics,
  alerts: Alert[],
  /** With the SLO breach ratio, the rule can compute the label's own formula. */
  useSlo = false,
): { severity: Severity; cause: string } {
  const edge = metrics.services.find((s) => s.service === "edge");
  const impact = useSlo
    ? Math.max(edge ? edge.errorRatio : 0, metrics.sloBreachRatio)
    : edge
      ? edge.errorRatio
      : 0;
  const slow = edge ? edge.p95 > 1000 : false;
  const severity: Severity = impact > 0.05 || (slow && impact > 0.01) ? "page" : impact > 0.005 || slow ? "ticket" : "noise";

  // The runbook: first match wins, which is the failure mode of runbooks.
  const body = metrics.topErrors[0]?.body ?? "";
  const cause =
    /connection slots|pool/i.test(body)
      ? "saturation"
      : /timeout/i.test(body)
        ? "dependency_latency"
        : /certificate/i.test(body)
          ? "upstream_outage"
          : /unavailable|provider/i.test(body)
            ? "upstream_outage"
            : /signature|token|auth/i.test(body)
              ? "config_error"
              : /ENOSPC|space left/i.test(body)
                ? "capacity"
                : alerts.some((a) => a.kind === "traffic")
                  ? "retry_amplification"
                  : metrics.deploys.length > 0
                    ? "bad_release"
                    : alerts.length === 0
                      ? "none"
                      : "saturation";
  return { severity, cause };
}
