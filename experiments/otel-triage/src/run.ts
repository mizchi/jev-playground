/**
 * docs/27 -- anomaly triage over OTLP-shaped telemetry.
 *
 *   npx tsx src/run.ts --replay            # re-derive every table, no API key
 *   npx tsx src/run.ts --repeat 3          # ask Jev (16 windows x 4 arms)
 *   npx tsx src/run.ts --arm aggregate --repeat 1
 *
 * Detection is in code (`detect.ts`) and so is severity-by-arithmetic
 * (`rulesTriage`), because docs/23 §5 measured what happens when rules are
 * moved into the prompt: it costs more and does worse. What is left for the
 * judgment is the part a runbook does badly -- what kind of problem this is,
 * where it lives, and whether it is worth waking someone up for.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Jev, choice, noul, score } from "../../shared/jev.js";
import { advise, mean, sd, type Sample } from "../../shared/thresholds.js";
import {
  ARM_BLURB,
  ARMS,
  CAUSE,
  DEPLOY_RELATED,
  NO_INCIDENT,
  OURS,
  ROOT,
  SELF_HEALING,
  SEVERITY,
  USER_VISIBLE,
  questions,
  stateFor,
  type ArmName,
} from "./arms.js";
import { detect, metricsFor, rulesTriage, type Alert, type Severity, type WindowMetrics } from "./detect.js";
import { SCENARIOS, generate, truthFor, type Truth } from "./telemetry.js";

const HERE = import.meta.dirname;
const RECORD = resolve(HERE, "../records/triage.json");

const ARGS = process.argv.slice(2);
const flag = (n: string) => ARGS.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = ARGS.indexOf(`--${n}`);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d;
};

/** Where a score becomes a decision. Level boundaries, not fitted numbers. */
const SEVERITY_AT = { ticket: 0.5, page: 1.5 };

interface Row {
  scenario: string;
  arm: ArmName;
  repeat: number;
  severity: number;
  severityConfidence: number;
  cause: string;
  causeConfidence: number;
  root: string;
  rootConfidence: number;
  noIncident: number;
  userVisible: number;
  deployRelated: number;
  selfHealing: number;
  ours: number;
  ms: number;
  inputTokens: number;
  dropped: number;
}

const pad = (s: string, n: number) => s.padEnd(n);
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

const severityOf = (s: number): Severity =>
  s >= SEVERITY_AT.page ? "page" : s >= SEVERITY_AT.ticket ? "ticket" : "noise";

/** Everything the deterministic half computes, for every window. */
function prepare(): {
  truth: Map<string, Truth>;
  metrics: Map<string, WindowMetrics>;
  alerts: Map<string, Alert[]>;
  windows: Map<string, ReturnType<typeof generate>>;
} {
  const windows = new Map<string, ReturnType<typeof generate>>();
  const metrics = new Map<string, WindowMetrics>();
  const truth = new Map<string, Truth>();
  for (const s of SCENARIOS) {
    const w = generate(s);
    windows.set(s.id, w);
    metrics.set(s.id, metricsFor(w));
    truth.set(s.id, truthFor(w));
  }
  // The baseline is the quiet window, which is what a detector has: the
  // previous period. Nothing here is fitted on the scenario it scores.
  const baseline = metrics.get("quiet")!;
  const alerts = new Map<string, Alert[]>();
  for (const s of SCENARIOS) alerts.set(s.id, detect(metrics.get(s.id)!, baseline));
  return { truth, metrics, alerts, windows };
}

/**
 * Ask, and if the state is over the ceiling, drop half the records and ask
 * again. docs/00's advice for `max_tokens_exceeded` is to halve the work; the
 * `raw` arm is the one place in this repository where that actually happens,
 * because a real telemetry window does not fit and pretending otherwise is
 * the thing being measured.
 */
async function askFitting(
  jev: Jev,
  state: Record<string, unknown>,
  qs: ReturnType<typeof questions>,
): Promise<{ res: Awaited<ReturnType<Jev["ask"]>>; sent: number; halvings: number }> {
  let current = state;
  for (let halvings = 0; halvings < 5; halvings += 1) {
    try {
      const res = await jev.ask(current, qs);
      const records = Array.isArray(current.records) ? current.records.length : 0;
      return { res, sent: records, halvings };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("max_tokens_exceeded") || !Array.isArray(current.records)) throw err;
      const half = current.records.slice(0, Math.floor(current.records.length / 2));
      current = { ...current, records: half, records_dropped: (current.records_dropped as number ?? 0) + (current.records.length - half.length) };
    }
  }
  throw new Error("state still over the ceiling after five halvings");
}

async function collect(jev: Jev, arm: ArmName, repeat: number, prepared: ReturnType<typeof prepare>): Promise<Row[]> {
  const rows: Row[] = [];
  const qs = questions();
  for (const s of SCENARIOS) {
    const w = prepared.windows.get(s.id)!;
    const { state, dropped: plannedDrop } = stateFor(arm, w, prepared.metrics.get(s.id)!, prepared.alerts.get(s.id)!);
    const started = Date.now();
    const { res, halvings } = await askFitting(jev, state, qs);
    const dropped = Array.isArray(state.records)
      ? (state.records_dropped as number ?? 0) + (halvings > 0 ? Math.round((state.records as unknown[]).length * (1 - 0.5 ** halvings)) : 0)
      : plannedDrop;
    const sev = score(res.answers[SEVERITY]);
    const cause = choice(res.answers[CAUSE]);
    const root = choice(res.answers[ROOT]);
    rows.push({
      scenario: s.id,
      arm,
      repeat,
      severity: sev.score,
      severityConfidence: sev.confidence,
      cause: cause.choice,
      causeConfidence: cause.confidence,
      root: root.choice,
      rootConfidence: root.confidence,
      noIncident: noul(res.answers[NO_INCIDENT]),
      userVisible: noul(res.answers[USER_VISIBLE]),
      deployRelated: noul(res.answers[DEPLOY_RELATED]),
      selfHealing: noul(res.answers[SELF_HEALING]),
      ours: noul(res.answers[OURS]),
      ms: Date.now() - started,
      inputTokens: res.usage.input_tokens,
      dropped,
    });
  }
  return rows;
}

function analyse(rows: Row[], prepared: ReturnType<typeof prepare>): void {
  const { truth, metrics, alerts } = prepared;
  const incidents = SCENARIOS.filter((s) => s.cause !== "none");
  const healthy = SCENARIOS.filter((s) => s.cause === "none");

  console.log("");
  console.log("=".repeat(104));
  console.log("  0. THE WINDOWS, AND WHERE THE LABELS COME FROM");
  console.log("");
  console.log(
    `  ${pad("scenario", 19)}${"spans".padStart(6)}${"logs".padStart(7)}${"5xx".padStart(7)}${"over SLO".padStart(10)}` +
      `${"impact".padStart(8)}  ${pad("severity", 9)}${pad("cause (injected)", 21)}alerts`,
  );
  for (const s of SCENARIOS) {
    const t = truth.get(s.id)!;
    const m = metrics.get(s.id)!;
    console.log(
      `  ${pad(s.id, 19)}${String(m.services.reduce((a, x) => a + x.requests, 0)).padStart(6)}` +
        `${String(m.logVolume).padStart(7)}${pct(t.errorRatio).padStart(7)}${pct(t.sloBreachRatio).padStart(10)}` +
        `${pct(t.userImpact).padStart(8)}  ${pad(t.severity, 9)}${pad(t.cause, 21)}${alerts.get(s.id)!.length}`,
    );
  }
  console.log("");
  console.log("  `impact` is measured: the share of user-facing requests that 5xx'd or missed the 1s SLO.");
  console.log("  `severity` comes from it (>5% page, >0.5% ticket), so a scary-looking healthy window is");
  console.log("  labelled noise and a quiet-looking outage is not. `cause` is by construction.");
  console.log("");
  console.log("  Two rows are worth reading twice. `thirdparty_outage` is a real outage with 0.2% impact");
  console.log("  (the feature degrades), and `auth_misconfig` fails a third of logins with 401s, which an");
  console.log("  SLO of 5xx-and-latency does not count at all -- the label says noise and a human would not.");

  // ---------------------------------------------------------------- detector
  console.log("");
  console.log("-".repeat(104));
  console.log("  1. THE DETECTOR (code, no API): what fired");
  console.log("");
  let firedOnIncident = 0;
  let firedOnHealthy = 0;
  for (const s of SCENARIOS) {
    const a = alerts.get(s.id)!;
    if (s.cause !== "none" && a.length > 0) firedOnIncident += 1;
    if (s.cause === "none" && a.length > 0) firedOnHealthy += 1;
    console.log(
      `  ${pad(s.id, 19)}${String(a.length).padStart(3)}  ${a.slice(0, 2).map((x) => x.text).join("; ")}${a.length > 2 ? ` (+${a.length - 2})` : ""}`,
    );
  }
  console.log("");
  console.log(
    `  fires on ${firedOnIncident}/${incidents.length} of the injected faults and on ` +
      `${firedOnHealthy}/${healthy.length} of the healthy windows.`,
  );
  console.log("  The healthy ones it fires on are the reason a triage exists: the numbers ARE unusual.");

  // ------------------------------------------------------------ rules triage
  console.log("");
  console.log("-".repeat(104));
  console.log("  2. TRIAGE IN RULES ALONE (the baseline docs/07 insists on)");
  console.log("");
  for (const useSlo of [false, true]) {
    let ruleSeverity = 0;
    let ruleCause = 0;
    let ruleFalsePages = 0;
    let ruleMissedPages = 0;
    const missed: string[] = [];
    for (const s of SCENARIOS) {
      const t = truth.get(s.id)!;
      const r = rulesTriage(metrics.get(s.id)!, alerts.get(s.id)!, useSlo);
      if (r.severity === t.severity) ruleSeverity += 1;
      if (s.cause !== "none" && r.cause === t.cause) ruleCause += 1;
      if (r.severity === "page" && t.severity !== "page") ruleFalsePages += 1;
      if (r.severity !== "page" && t.severity === "page") {
        ruleMissedPages += 1;
        missed.push(s.id);
      }
    }
    console.log(
      `  ${pad(useSlo ? "error ratio + SLO breaches" : "error ratio only", 28)}` +
        `severity ${ruleSeverity}/${SCENARIOS.length}  false pages ${ruleFalsePages}  ` +
        `missed pages ${ruleMissedPages}${missed.length > 0 ? ` (${missed.join(", ")})` : ""}  ` +
        `cause ${ruleCause}/${incidents.length}`,
    );
  }
  console.log("");
  console.log("  The second row is the same rule with one more measured number: the share of user-facing");
  console.log("  requests over the SLO. No arm's state contains it -- the arms show p50/p95/p99, which is");
  console.log("  what a dashboard shows -- and that asymmetry IS the result: when the label is arithmetic");
  console.log("  on a measured quantity, the way to win is to compute it, not to ask about it.");
  console.log("");
  console.log("  Severity is arithmetic on the same quantity the label is derived from, so a rule gets it");
  console.log("  nearly for free. That is the point rather than a flaw in the comparison: the ORDERED part");
  console.log("  of this answer does not need a judgment (docs/23 §5).");
  console.log("");
  // The runbook's cause matching is a regex over log bodies. Take the bodies
  // away and see what is left -- the `nostrings` arm is the same question
  // asked of the judgment.
  let blindCause = 0;
  for (const s of SCENARIOS) {
    if (s.cause === "none") continue;
    const m = metrics.get(s.id)!;
    const r = rulesTriage({ ...m, topErrors: [] }, alerts.get(s.id)!, true);
    if (r.cause === s.cause) blindCause += 1;
  }
  console.log(
    `  cause with the log bodies withheld: ${blindCause}/${incidents.length} -- the runbook IS the strings.`,
  );

  if (rows.length === 0) return;

  // ------------------------------------------------------------------- arms
  console.log("");
  console.log("-".repeat(104));
  console.log("  3. TRIAGE IN JEV, BY WHAT THE STATE CONTAINED");
  console.log("");
  console.log(
    `  ${pad("arm", 11)}${"severity".padStart(10)}${"false pages".padStart(13)}${"missed".padStart(8)}` +
      `${"cause".padStart(8)}${"root svc".padStart(10)}${"no-incident".padStart(13)}${"tokens".padStart(9)}${"ms".padStart(6)}`,
  );
  const perArm = new Map<ArmName, Row[]>();
  for (const r of rows) {
    const at = perArm.get(r.arm);
    if (at) at.push(r);
    else perArm.set(r.arm, [r]);
  }
  for (const arm of ARMS) {
    const mine = perArm.get(arm);
    if (!mine || mine.length === 0) continue;
    let sev = 0;
    let falsePage = 0;
    let missedPage = 0;
    let cause = 0;
    let causeOf = 0;
    let root = 0;
    let rootOf = 0;
    let quietRight = 0;
    let quietOf = 0;
    for (const r of mine) {
      const t = truth.get(r.scenario)!;
      const decided = severityOf(r.severity);
      if (decided === t.severity) sev += 1;
      if (decided === "page" && t.severity !== "page") falsePage += 1;
      if (decided !== "page" && t.severity === "page") missedPage += 1;
      if (t.cause !== "none") {
        causeOf += 1;
        if (r.cause === t.cause) cause += 1;
        rootOf += 1;
        if (r.root === t.service) root += 1;
      } else {
        quietOf += 1;
        // The escape hatch: on a healthy window it should fire.
        if (r.noIncident >= 0.5) quietRight += 1;
      }
    }
    console.log(
      `  ${pad(arm, 11)}${`${sev}/${mine.length}`.padStart(10)}${String(falsePage).padStart(13)}${String(missedPage).padStart(8)}` +
        `${`${cause}/${causeOf}`.padStart(8)}${`${root}/${rootOf}`.padStart(10)}${`${quietRight}/${quietOf}`.padStart(13)}` +
        `${Math.round(mean(mine.map((r) => r.inputTokens))).toString().padStart(9)}${Math.round(mean(mine.map((r) => r.ms))).toString().padStart(6)}`,
    );
  }
  console.log("");
  console.log("  how often the repeats disagreed about paging the same window:");
  for (const arm of ARMS) {
    const mine = perArm.get(arm);
    if (!mine || mine.length === 0) continue;
    let split = 0;
    let windows = 0;
    for (const s of SCENARIOS) {
      const draws = mine.filter((r) => r.scenario === s.id);
      if (draws.length < 2) continue;
      windows += 1;
      const pages = draws.map((r) => severityOf(r.severity) === "page");
      if (pages.some((p) => p) && pages.some((p) => !p)) split += 1;
    }
    if (windows > 0) console.log(`    ${pad(arm, 11)}${split}/${windows} windows`);
  }
  console.log("");
  console.log("  `severity` counts exact matches of noise/ticket/page; the two columns after it are the");
  console.log("  operational numbers (a false page wakes somebody, a missed page does not wake anybody).");
  console.log("  `no-incident` is the escape-hatch noul firing on the six healthy windows (docs/17 §3).");
  console.log(`  ${ARMS.map((a) => `${a}: ${ARM_BLURB[a]}`).join("\n  ")}`);

  const dropped = rows.filter((r) => r.arm === "raw" && r.dropped > 0);
  if (dropped.length > 0) {
    const worst = dropped.reduce((a, b) => (a.dropped > b.dropped ? a : b));
    console.log("");
    console.log(
      `  the raw arm hit the state ceiling on ${new Set(dropped.map((r) => r.scenario)).size} of the ${SCENARIOS.length} windows; ` +
        `worst case ${worst.scenario} dropped ${worst.dropped} records`,
    );
  }

  // ------------------------------------------------------------- composites
  //
  // docs/18's rule: ask the atomic predicates and the overall question, then
  // take the conservative side. Here there is a third source -- the
  // arithmetic -- so the interesting composite is the division of labour:
  // severity from rules, class from the judgment.
  console.log("");
  console.log("-".repeat(104));
  console.log("  3b. THE SAME ANSWERS, COMBINED WITH THE ARITHMETIC");
  console.log("");
  console.log(
    `  ${pad("pipeline", 34)}${"severity".padStart(10)}${"false pages".padStart(13)}${"missed".padStart(8)}${"cause".padStart(8)}`,
  );
  const scoreRule = (
    label: string,
    decide: (r: Row) => Severity,
    causeOf: (r: Row) => string,
    subset: Row[],
  ): void => {
    let sev = 0;
    let falsePage = 0;
    let missed = 0;
    let cause = 0;
    let causeN = 0;
    for (const r of subset) {
      const t = truth.get(r.scenario)!;
      const d = decide(r);
      if (d === t.severity) sev += 1;
      if (d === "page" && t.severity !== "page") falsePage += 1;
      if (d !== "page" && t.severity === "page") missed += 1;
      if (t.cause !== "none") {
        causeN += 1;
        if (causeOf(r) === t.cause) cause += 1;
      }
    }
    console.log(
      `  ${pad(label, 34)}${`${sev}/${subset.length}`.padStart(10)}${String(falsePage).padStart(13)}` +
        `${String(missed).padStart(8)}${`${cause}/${causeN}`.padStart(8)}`,
    );
  };
  const rulesFor = (r: Row) => rulesTriage(metrics.get(r.scenario)!, alerts.get(r.scenario)!);
  for (const arm of ARMS) {
    const mine = perArm.get(arm);
    if (!mine || mine.length === 0) continue;
    scoreRule(`${arm}: jev alone`, (r) => severityOf(r.severity), (r) => r.cause, mine);
    scoreRule(
      `${arm}: jev, page needs user_visible`,
      (r) => {
        const d = severityOf(r.severity);
        return d === "page" && r.userVisible < 0.5 ? "ticket" : d;
      },
      (r) => r.cause,
      mine,
    );
    scoreRule(
      `${arm}: rules severity + jev cause`,
      (r) => rulesFor(r).severity,
      (r) => r.cause,
      mine,
    );
    scoreRule(
      `${arm}: conservative (max of both)`,
      (r) => {
        const order = { noise: 0, ticket: 1, page: 2 } as const;
        const a = severityOf(r.severity);
        const b = rulesFor(r).severity;
        return order[a] >= order[b] ? a : b;
      },
      (r) => r.cause,
      mine,
    );
  }
  console.log("");
  console.log("  `rules severity + jev cause` is the division of labour docs/23 §5 argues for: the ordered");
  console.log("  answer is arithmetic on measured numbers, and the class is the part a runbook gets wrong.");

  // -------------------------------------------------------------- per window
  const best = ARMS.filter((a) => perArm.has(a));
  console.log("");
  console.log("-".repeat(104));
  console.log("  4. PER WINDOW (severity decided / cause chosen, one column per arm)");
  console.log("");
  console.log(`  ${pad("scenario", 19)}${pad("label", 9)}${best.map((a) => pad(a, 22)).join("")}`);
  for (const s of SCENARIOS) {
    const t = truth.get(s.id)!;
    const cells = best.map((arm) => {
      const mine = rows.filter((r) => r.arm === arm && r.scenario === s.id);
      if (mine.length === 0) return pad("-", 22);
      const decided = mine.map((r) => severityOf(r.severity));
      const sev = decided.every((d) => d === decided[0]) ? decided[0] : `${decided[0]}?`;
      const causes = [...new Set(mine.map((r) => r.cause))];
      const mark = sev === t.severity ? " " : "*";
      return pad(`${mark}${sev}/${causes.join("|").slice(0, 14)}`, 22);
    });
    console.log(`  ${pad(s.id, 19)}${pad(t.severity, 9)}${cells.join("")}`);
  }
  console.log("");
  console.log("  `*` marks a severity that does not match the label. A `?` means the repeats disagreed.");

  // ------------------------------------------------------------ the atomics
  console.log("");
  console.log("-".repeat(104));
  console.log("  5. THE ATOMIC PREDICATES, AGAINST THE MEASURED IMPACT");
  console.log("");
  for (const arm of best) {
    const mine = perArm.get(arm)!;
    const samples: Sample[] = mine.map((r) => ({
      value: r.userVisible,
      positive: truth.get(r.scenario)!.userImpact > 0.005,
      group: r.scenario,
    }));
    const a = advise(samples, { range: 1 });
    const visible = mine.filter((r) => truth.get(r.scenario)!.userImpact > 0.005);
    const quiet = mine.filter((r) => truth.get(r.scenario)!.userImpact <= 0.005);
    console.log(
      `  ${pad(arm, 11)}p(user_visible): hurting users ${mean(visible.map((r) => r.userVisible)).toFixed(3)} ` +
        `vs not ${mean(quiet.map((r) => r.userVisible)).toFixed(3)}   ` +
        `AUC ${a.separation.auc.toFixed(2)}  gap ${a.separation.gap.toFixed(2)}  ${a.verdict}`,
    );
  }
  console.log("");
  console.log("  The label here is measured (impact over 0.5%), so this is the one predicate that can be");
  console.log("  scored like docs/25's questions -- `advise` reads the same way it does on a code corpus.");
  for (const arm of best) {
    const mine = perArm.get(arm)!;
    const deployed = mine.filter((r) => ["bad_deploy", "canary_1pct", "log_flood"].includes(r.scenario));
    const notDeployed = mine.filter((r) => !["bad_deploy", "canary_1pct", "log_flood"].includes(r.scenario));
    console.log(
      `  ${pad(arm, 11)}p(deploy_related): windows with a deploy ${mean(deployed.map((r) => r.deployRelated)).toFixed(3)} ` +
        `vs without ${mean(notDeployed.map((r) => r.deployRelated)).toFixed(3)}`,
    );
  }

  // ------------------------------------------------------------------- cost
  const totalTokens = rows.reduce((a, r) => a + r.inputTokens, 0);
  console.log("");
  console.log("-".repeat(104));
  console.log(
    `  ${rows.length} judgments over ${new Set(rows.map((r) => r.scenario)).size} windows and ` +
      `${new Set(rows.map((r) => r.arm)).size} arms: ${totalTokens} input tokens, ` +
      `$${((totalTokens / 1e6) * 0.042).toFixed(4)}, ` +
      `median ${Math.round(mean(rows.map((r) => r.ms)))} ms per window (sd ${Math.round(sd(rows.map((r) => r.ms)))})`,
  );
  console.log("");
}

async function main(): Promise<void> {
  const prepared = prepare();
  if (flag("replay")) {
    if (!existsSync(RECORD)) throw new Error(`no ${RECORD}; run without --replay first`);
    analyse(JSON.parse(readFileSync(RECORD, "utf8")) as Row[], prepared);
    return;
  }
  const repeats = Number(opt("repeat", "3"));
  const only = opt("arm", "");
  const arms = only ? [only as ArmName] : [...ARMS];
  const jev = new Jev();
  const rows: Row[] = [];
  console.log(`  ${SCENARIOS.length} windows x ${arms.length} arm(s) x ${repeats} repeat(s)`);
  for (const arm of arms) {
    for (let r = 0; r < repeats; r += 1) {
      const got = await collect(jev, arm, r, prepared);
      rows.push(...got);
      console.log(`    ${arm} run ${r + 1}: ${got.length} windows, ${Math.round(mean(got.map((x) => x.inputTokens)))} tokens each`);
    }
  }
  const previous = existsSync(RECORD) && !flag("fresh") ? (JSON.parse(readFileSync(RECORD, "utf8")) as Row[]) : [];
  const kept = previous.filter((p) => !arms.includes(p.arm));
  writeFileSync(RECORD, JSON.stringify([...kept, ...rows], null, 2) + "\n");
  analyse([...kept, ...rows], prepared);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
