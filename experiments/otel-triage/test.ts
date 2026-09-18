/**
 * Everything that has to hold before a request is spent.
 *
 *   npm test      # no API key
 *
 * Two of these carry the report rather than the code. The state is checked
 * for the label -- a scenario id, a cause name, the word "injected" -- because
 * every number in docs/27 depends on the triage not having been told the
 * answer, and that is a property of the payload rather than a promise. And the
 * noul criteria are checked to be NESTED, which is docs/00's silent footgun:
 * top-level `true`/`false` keys are dropped by the server with a 200.
 */
import { ARMS, questions, sampleOf, uniformSampleOf, fitToBudget, stateFor, STATE_CHAR_BUDGET } from "./src/arms.js";
import { detect, metricsFor, normaliseBody, rulesTriage } from "./src/detect.js";
import { CAUSES, SCENARIOS, SERVICES, generate, truthFor } from "./src/telemetry.js";

let pass = 0;
let fail = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

function ok(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

function eq<T>(actual: T, expected: T, what = ""): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}${what ? ": " : ""}${a} !== ${b}`);
}

const windows = new Map(SCENARIOS.map((s) => [s.id, generate(s)]));
const metrics = new Map([...windows].map(([id, w]) => [id, metricsFor(w)]));
const baseline = metrics.get("quiet")!;

// ---------------------------------------------------------------- simulator

check("a window is a pure function of (scenario, seed)", () => {
  for (const s of SCENARIOS.slice(0, 4)) {
    eq(JSON.stringify(generate(s, 11)), JSON.stringify(generate(s, 11)), s.id);
  }
  ok(
    JSON.stringify(generate(SCENARIOS[0], 11)) !== JSON.stringify(generate(SCENARIOS[0], 12)),
    "a different seed gives a different window",
  );
});

check("every scenario declares a cause the choice can express", () => {
  for (const s of SCENARIOS) {
    ok(s.cause === "none" || (CAUSES as readonly string[]).includes(s.cause), `${s.id}: ${s.cause}`);
    ok(s.service === null || (SERVICES as readonly string[]).includes(s.service), `${s.id}: ${s.service}`);
    ok((s.cause === "none") === (s.service === null), `${s.id}: cause and service disagree about whether anything is wrong`);
  }
});

check("the labels are measured, not asserted", () => {
  // The scenario says WHAT was injected; how much it hurt is counted off the
  // spans. So a real outage that degrades gracefully has to come out as noise.
  const t = truthFor(windows.get("thirdparty_outage")!);
  eq(t.cause, "upstream_outage", "cause by construction");
  ok(t.userImpact < 0.01, `a degrading outage barely touches users: ${t.userImpact}`);
  eq(t.severity, "noise", "so the measured severity is noise");
  const page = truthFor(windows.get("cpu_throttle")!);
  eq(page.errorRatio < 0.01, true, "no errors at all");
  eq(page.severity, "page", "but three quarters of requests miss the SLO");
});

check("healthy scenarios really are healthy", () => {
  for (const s of SCENARIOS.filter((x) => x.cause === "none")) {
    const t = truthFor(windows.get(s.id)!);
    ok(t.userImpact <= 0.005, `${s.id} impact ${t.userImpact}`);
    eq(t.severity, "noise", s.id);
  }
});

// ---------------------------------------------------------------- detector

check("the baseline window produces no alerts", () => {
  eq(detect(baseline, baseline).length, 0, "quiet against itself");
});

check("the detector catches every injected fault", () => {
  for (const s of SCENARIOS.filter((x) => x.cause !== "none")) {
    ok(detect(metrics.get(s.id)!, baseline).length > 0, `${s.id} went undetected`);
  }
});

check("the detector also fires on healthy windows -- which is why triage exists", () => {
  const noisy = SCENARIOS.filter((x) => x.cause === "none" && detect(metrics.get(x.id)!, baseline).length > 0);
  ok(noisy.length >= 4, `only ${noisy.length} healthy windows tripped a threshold`);
});

check("normalising a log body removes what differs per occurrence", () => {
  // The unit goes with the number: "5000ms" is one token to strip, not two.
  eq(normaliseBody("upstream timeout after 5000ms"), "upstream timeout after N");
  eq(
    normaliseBody("trace 9f8e7d6c5b4a3f2e failed"),
    normaliseBody("trace 1a2b3c4d5e6f7a8b failed"),
    "two ids collapse to one body",
  );
});

check("the rules baseline needs the SLO ratio to see a latency-only outage", () => {
  const m = metrics.get("cpu_throttle")!;
  const a = detect(m, baseline);
  eq(rulesTriage(m, a, false).severity, "ticket", "error ratio alone");
  eq(rulesTriage(m, a, true).severity, "page", "with the SLO breach ratio");
});

// ---------------------------------------------------------------- the state

check("no arm's state contains the label", () => {
  // Scenario ids, cause names and the shape of a fault description must not
  // travel. `upstream_outage` and friends appear in the QUESTION (they are the
  // menu), so only the state is inspected here.
  const banned = [
    ...SCENARIOS.map((s) => s.id),
    ...CAUSES,
    "injected",
    "userImpact",
    // The rules baseline computes this and no arm may see it (§2's asymmetry).
    "sloBreachRatio",
  ];
  for (const s of SCENARIOS) {
    for (const arm of ARMS) {
      const { state } = stateFor(arm, windows.get(s.id)!, metrics.get(s.id)!, detect(metrics.get(s.id)!, baseline));
      const sent = JSON.stringify(state);
      for (const word of banned) {
        ok(!sent.includes(word), `${arm}/${s.id} leaked ${word}`);
      }
    }
  }
});

check("the raw arm stays under the state ceiling and says what it dropped", () => {
  for (const s of SCENARIOS) {
    const { state, dropped } = stateFor("raw", windows.get(s.id)!, metrics.get(s.id)!, []);
    const size = JSON.stringify(state).length;
    ok(size <= STATE_CHAR_BUDGET, `${s.id} state is ${size} characters`);
    const w = windows.get(s.id)!;
    const total = w.logs.length + w.spans.length;
    const kept = (state.records as unknown[]).length;
    eq(kept + dropped, total, `${s.id}: kept + dropped should be everything`);
  }
});

check("fitToBudget keeps a prefix and never exceeds the budget", () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ i, pad: "x".repeat(50) }));
  const { kept, dropped } = fitToBudget(items, 1000);
  ok(JSON.stringify(kept).length <= 1000, `${JSON.stringify(kept).length} characters`);
  eq(kept.length + dropped, items.length, "accounted for");
  eq(kept[0].i, 0, "a prefix, not a sample");
});

check("the biased sample and the uniform one are the same size", () => {
  for (const s of ["log_flood", "db_slow", "quiet"]) {
    const w = windows.get(s)!;
    const a = sampleOf(w);
    const b = uniformSampleOf(w);
    eq(a.logs.length, b.logs.length, `${s} logs`);
    eq(a.spans.length, b.spans.length, `${s} spans`);
  }
  // And the biased one is actually biased, or the arm proves nothing.
  const flood = windows.get("log_flood")!;
  const loud = sampleOf(flood).logs.filter((l) => l.severityNumber >= 13).length;
  const even = uniformSampleOf(flood).logs.filter((l) => l.severityNumber >= 13).length;
  ok(loud > even, `loudest-first should surface more warnings: ${loud} vs ${even}`);
});

// ---------------------------------------------------------------- questions

check("the noul criteria are nested, not top-level", () => {
  for (const [name, q] of Object.entries(questions())) {
    if (q.type !== "noul") continue;
    const raw = q as unknown as Record<string, unknown>;
    ok(raw.criteria !== undefined, `${name} has no criteria`);
    ok(raw.true === undefined && raw.false === undefined, `${name} puts true/false at the top level`);
  }
});

check("the shapes match the question", () => {
  const qs = questions();
  eq(qs.severity.type, "score", "an ordered answer is a score");
  eq((qs.severity as { criteria: unknown[] }).criteria.length, 3, "three rungs");
  eq(qs.cause.type, "choice", "a class is a choice");
  eq(Object.keys((qs.cause as { criteria: Record<string, unknown> }).criteria).length, CAUSES.length, "every cause");
  eq(qs.root_service.type, "choice", "a service is a choice");
  eq(Object.keys((qs.root_service as { criteria: Record<string, unknown> }).criteria).length, SERVICES.length, "every service");
  eq(qs.no_incident.type, "noul", "the escape hatch is its own question, not an option");
  ok(
    !Object.keys((qs.cause as { criteria: Record<string, unknown> }).criteria).some((k) => /none|nothing|n\/a/i.test(k)),
    "and it is not mixed into the choice (docs/17 §3)",
  );
});

check("one request carries every question", () => {
  eq(Object.keys(questions()).length, 8, "eight questions");
});

console.log("");
console.log(`  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
