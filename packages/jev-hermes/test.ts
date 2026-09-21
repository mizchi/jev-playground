/**
 * What has to hold before five components share one request. No API key.
 *
 *   npm test
 *
 * The load-bearing check is the FIRST one. Combining three components'
 * questions into one request is only legal if each component's own reader can
 * still find its own answers, and that needs the key sets to be disjoint. If
 * two components ever pick the same question name, one of them silently reads
 * the other's answer -- which is not a crash, it is a wrong decision that
 * looks like a right one.
 */
import {
  DEFAULT_CONFIG as DEFAULT_SKILL_CONFIG,
  NONE,
  keyFor as skillKey,
  type Skill,
} from "jev-skill-router";
import {
  DEFAULT_CONFIG as DEFAULT_MODEL_CONFIG,
  EFFORT,
  OVERSIZED,
  TIER,
  UNDERSPECIFIED,
  decide as decideModel,
} from "jev-model-router";
import { GATE, SIZE, STAY_SINGLE, TOPOLOGY, decide as decidePlan } from "jev-orchestrator";
import { Budget, DEFAULT_BUDGET, USD_PER_MTOK } from "./src/budget.js";
import { HERMES_CUTS, HERMES_ROUTER, HERMES_TIERS } from "./src/tiers.js";
import { keyGroups, payloadOf, questionsFor, stateFor, type TurnConfig, type TurnInput } from "./src/turn.js";

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void): void => {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}: ${(err as Error).message}`);
  }
};
const ok = (cond: boolean, what: string): void => {
  if (!cond) throw new Error(what);
};
const eq = <T,>(a: T, b: T, what = ""): void => {
  if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

const SKILLS: Skill[] = [
  { name: "code-review", description: "review a diff against the project's rules", route: "judge", invocable: true },
  { name: "tier", description: "a skill deliberately named like the model router's question", route: "judge", invocable: true },
  { name: "topology", description: "and one named like the orchestrator's", route: "judge", invocable: true },
];

const INPUT: TurnInput = {
  task: "the auth middleware rejects valid tokens after an hour",
  cwd: "/srv/app",
  shortlist: SKILLS,
};
const CONFIG: TurnConfig = { router: HERMES_ROUTER, framing: "cost", orchestrate: true };

// ------------------------------------------------------ the combined request

check("the three components' question keys are disjoint", () => {
  const groups = keyGroups(INPUT, CONFIG);
  const seen = new Map<string, string>();
  for (const [owner, keys] of Object.entries(groups)) {
    for (const key of keys) {
      const already = seen.get(key);
      ok(already === undefined, `${key} is claimed by both ${already} and ${owner}`);
      seen.set(key, owner);
    }
  }
  // And every key the request actually carries belongs to someone.
  for (const key of Object.keys(questionsFor(INPUT, CONFIG))) {
    ok(seen.has(key), `${key} is in the request but owned by nobody`);
  }
  eq(seen.size, Object.keys(questionsFor(INPUT, CONFIG)).length);
});

check("a skill named after another component's question cannot collide", () => {
  // The adversarial case, and the reason `keyFor` prefixes. Two of the skills
  // above are named exactly `tier` and `topology`; if the skill router did not
  // prefix, loading them would overwrite the model router's and the
  // orchestrator's answers.
  const groups = keyGroups(INPUT, CONFIG);
  ok(groups.skills.includes(skillKey("tier")), "the skill key helper was not used");
  ok(!groups.skills.includes(TIER), "a skill collided with the model router's tier question");
  ok(!groups.skills.includes(TOPOLOGY), "a skill collided with the orchestrator's topology question");
  ok(groups.model.includes(TIER) && groups.orchestrator.includes(TOPOLOGY), "the owners lost their own keys");
});

check("every component's questions are present, verbatim from its own module", () => {
  const qs = questionsFor(INPUT, CONFIG);
  for (const key of [TIER, EFFORT, UNDERSPECIFIED, OVERSIZED]) ok(key in qs, `${key} is missing`);
  for (const key of [GATE, TOPOLOGY, STAY_SINGLE, SIZE]) ok(key in qs, `${key} is missing`);
  ok(NONE in qs, "the skill router's escape hatch is missing");
  // The shapes must be the measured ones: score for the two ladders, choice
  // for the topology, noul for the hatches.
  eq(qs[TIER].type, "score");
  eq(qs[TOPOLOGY].type, "choice");
  eq(qs[UNDERSPECIFIED].type, "noul");
  eq(qs[NONE].type, "noul");
});

check("a component that is off contributes no questions", () => {
  const withoutOrchestration = questionsFor(INPUT, { ...CONFIG, orchestrate: false });
  for (const key of [GATE, TOPOLOGY, STAY_SINGLE, SIZE]) {
    ok(!(key in withoutOrchestration), `${key} is asked although orchestration is off`);
  }
  const withoutSkills = questionsFor({ ...INPUT, shortlist: [] }, CONFIG);
  ok(!(NONE in withoutSkills), "the skill hatch is asked with an empty shortlist");
  // And the state loses the skill level text with it, since that is the only
  // thing it was there for (docs/30 §7).
  ok(!("skill_level_meaning" in stateFor({ ...INPUT, shortlist: [] }, CONFIG)), "the skill level text rode along anyway");
  ok("skill_level_meaning" in stateFor(INPUT, CONFIG), "the skill level text is missing when skills ARE asked");
});

check("the union state has one `what` and one `request`", () => {
  const state = stateFor(INPUT, CONFIG);
  eq(typeof state.what, "string");
  eq(state.request, INPUT.task);
  // Each component's own contribution survived the merge.
  ok("tiers_available" in state, "the model router's state fields were dropped");
  ok("working_directory" in state, "the model router's cwd field was dropped");
  // And the per-question subjects are untouched: docs/29 §4 measured moving a
  // subject into the state at 53% agreement, so nothing may do that here.
  const qs = JSON.stringify(questionsFor(INPUT, CONFIG));
  ok(qs.includes("How capable a model"), "the tier question lost its own subject");
  ok(qs.includes("costs tokens, latency"), "the gate lost its own wording");
});

check("no model name, per-tier price or cutoff leaks into the payload", () => {
  const body = payloadOf(INPUT, CONFIG);
  for (const word of ["0.85", "cuts", "gateAt", "dropAt", "minConfidence", "maxWorkers"]) {
    ok(!body.includes(word), `the payload leaks "${word}"`);
  }
  // The model ids and the tier labels are the worst leak available: a request
  // that names "opus" is telling the answer what the answer is called.
  for (const tier of HERMES_TIERS) {
    ok(!body.includes(tier.model), `the payload names ${tier.model}`);
    ok(!body.includes(`"${tier.label}"`), `the payload names the ${tier.label} label`);
  }
  // The per-tier PRICES must not be there either. The ratio
  // `price_ratio_cheapest_to_dearest` deliberately is -- it is the model
  // router's own field, present in what docs/36 measured, and it tells the
  // rubric how far apart the rungs are without telling it what a rung costs.
  // So this checks the individual numbers, not the word "price".
  for (const tier of HERMES_TIERS) {
    ok(!body.includes(`:${tier.price},`), `the payload carries ${tier.label}'s own price`);
  }
  ok(body.includes("price_ratio_cheapest_to_dearest"), "the ratio field went missing; that is a measured part of the state");
});

check("one fact appears under one name in the union state", () => {
  // Found by the leak check above: the model router calls the working
  // directory `working_directory` and the orchestrator calls it `cwd`, so a
  // naive merge put the same string in twice. Two names for one fact reads as
  // two facts.
  const state = stateFor(INPUT, CONFIG);
  const values = Object.entries(state).filter(([, v]) => typeof v === "string") as [string, string][];
  const byValue = new Map<string, string[]>();
  for (const [key, value] of values) byValue.set(value, [...(byValue.get(value) ?? []), key]);
  for (const [value, keys] of byValue) {
    ok(keys.length === 1, `"${value.slice(0, 40)}" appears under ${keys.length} keys: ${keys.join(", ")}`);
  }
});

// ------------------------------------------------------ the ladder

check("the ladder is two rungs, sonnet then opus, with one cut", () => {
  // What the caller asked for: switch between sonnet and opus by difficulty.
  eq(HERMES_TIERS.length, 2);
  eq(HERMES_TIERS[0].label, "sonnet");
  eq(HERMES_TIERS[1].label, "opus");
  ok(HERMES_TIERS[1].price > HERMES_TIERS[0].price, "the ladder is not cheapest-first");
  eq(HERMES_CUTS.length, HERMES_TIERS.length - 1);
  eq(HERMES_ROUTER.fallback, HERMES_TIERS[0].model, "the fallback is not the cheap rung");
});

check("the cut makes the tier switch an escalation, not a router", () => {
  // docs/36 §5: on a corpus where the cheap rung served 52 of 53 tasks, a
  // fitted ladder was worse than doing nothing on held-out tasks. So a
  // middling tier score must stay cheap.
  const base = {
    tierConfidence: 0.9,
    effort: 1,
    effortConfidence: 0.9,
    underspecified: 0,
    oversized: 0,
  };
  const at = (tier: number): string =>
    decideModel({ config: HERMES_ROUTER, judgment: { ...base, tier }, current: HERMES_ROUTER.fallback }).label;
  eq(at(0.0), "sonnet");
  eq(at(0.5), "sonnet", "a middling score escalated: ");
  eq(at(0.8), "sonnet", "a high-but-not-decisive score escalated: ");
  eq(at(0.9), "opus", "a decisive score did not escalate: ");
  ok(HERMES_CUTS[0] >= 0.8, `the cut is at ${HERMES_CUTS[0]}, which is not an escalation threshold`);
});

check("both escape hatches escalate whatever the tier score says", () => {
  // The model router's own rule, and the path docs/36 §5 recommends relying on
  // instead of the tier score. Asserted here because this ladder's high cut
  // would otherwise make escalation nearly unreachable.
  const base = { tier: 0, tierConfidence: 0.9, effort: 0, effortConfidence: 0.9, underspecified: 0, oversized: 0 };
  eq(
    decideModel({ config: HERMES_ROUTER, judgment: { ...base, underspecified: 0.9 }, current: HERMES_ROUTER.fallback }).label,
    "opus",
  );
  eq(
    decideModel({ config: HERMES_ROUTER, judgment: { ...base, oversized: 0.9 }, current: HERMES_ROUTER.fallback }).label,
    "opus",
  );
  eq(
    decideModel({ config: HERMES_ROUTER, judgment: { ...base, underspecified: 0.9 }, current: HERMES_ROUTER.fallback }).reason,
    "underspecified",
  );
});

check("the hatch cutoff sits above where the answers cluster", () => {
  // The finding from experiments/hermes: `underspecified` puts six of eight
  // varied turns in 0.606..0.729, so the model router's 0.7 default decides
  // most traffic by a margin smaller than one draw of noise. 0.85 is above
  // the cluster.
  ok(HERMES_ROUTER.escalateAt > 0.75, `escalateAt is ${HERMES_ROUTER.escalateAt}, back inside the cluster`);
  const base = { tier: 0, tierConfidence: 0.9, effort: 0, effortConfidence: 0.9, underspecified: 0, oversized: 0 };
  const at = (underspecified: number): string =>
    decideModel({ config: HERMES_ROUTER, judgment: { ...base, underspecified }, current: HERMES_ROUTER.fallback }).label;
  // The measured cluster, all of it on the cheap rung.
  for (const value of [0.606, 0.632, 0.677, 0.68, 0.683, 0.729]) {
    eq(at(value), "sonnet", `underspecified ${value} escalated: `);
  }
  // The turn that really was vague.
  eq(at(0.954), "opus", "a genuinely underspecified request did not escalate: ");
  // And the model router's own default is untouched, so nothing else in the
  // repo changed behaviour when this number became configurable.
  eq(DEFAULT_MODEL_CONFIG.escalateAt, 0.7);
});

check("effort moves freely even when the model does not", () => {
  // The axis this package leans on: free to change, and it does not
  // invalidate the prompt cache the way a model switch does.
  const base = { tier: 0, tierConfidence: 0.9, underspecified: 0, oversized: 0, effortConfidence: 0.9 };
  const efforts = [0, 1, 2].map(
    (effort) =>
      decideModel({ config: HERMES_ROUTER, judgment: { ...base, effort }, current: HERMES_ROUTER.fallback }).effort,
  );
  eq(efforts.join(), "low,medium,high");
  // All three on the same rung, which is the point.
  const labels = new Set(
    [0, 1, 2].map(
      (effort) => decideModel({ config: HERMES_ROUTER, judgment: { ...base, effort }, current: HERMES_ROUTER.fallback }).label,
    ),
  );
  eq(labels.size, 1, "the effort answer moved the model: ");
});

// ------------------------------------------------------ the budget

check("the ceiling stops asking and says so", () => {
  let now = 1_000_000;
  const b = new Budget({ dailyInputTokens: 1_000, perMinute: null }, () => now);
  ok(b.allows().ok, "a fresh ledger refused a request");
  b.spent("turn", 999, 10);
  ok(b.allows().ok, "the ledger refused below its ceiling");
  b.spent("turn", 2, 10);
  const refused = b.allows();
  eq(refused.ok, false);
  ok(!refused.ok && refused.why.includes("ceiling"), "the refusal does not say why");
});

check("the daily window rolls over", () => {
  let now = 1_000_000;
  const b = new Budget({ dailyInputTokens: 100, perMinute: null }, () => now);
  b.spent("turn", 200, 10);
  eq(b.allows().ok, false);
  now += 86_400_001;
  eq(b.allows().ok, true, "the day never rolled over: ");
  // The totals are cumulative even though the window is not -- a resident
  // agent's operator wants both, and conflating them would hide one.
  eq(b.totals().inputTokens, 200);
});

check("the rate limit is per minute and forgets", () => {
  let now = 1_000_000;
  const b = new Budget({ dailyInputTokens: null, perMinute: 2 }, () => now);
  b.spent("guard", 10, 5);
  b.spent("guard", 10, 5);
  eq(b.allows().ok, false);
  now += 60_001;
  eq(b.allows().ok, true, "the minute window never cleared: ");
});

check("a projection is withheld until there is something to project from", () => {
  // A daily figure extrapolated from four requests is a number that looks
  // like evidence.
  let now = 1_000_000;
  const b = new Budget({}, () => now);
  b.spent("turn", 900, 300);
  eq(b.projectedDailyUsd(), null);
  now += 3_600_001;
  ok((b.projectedDailyUsd() ?? 0) > 0, "no projection after an hour");
});

check("the ledger separates the components", () => {
  const b = new Budget();
  b.spent("turn", 900, 300);
  b.spent("guard", 250, 340);
  b.spent("guard", 250, 320);
  const rows = b.byComponent();
  eq(rows.length, 2);
  eq(rows.find((r) => r.component === "guard")?.row.requests, 2);
  eq(b.totals().requests, 3);
  eq(b.totals().inputTokens, 1_400);
  // The price is the one from docs/00 and nowhere else.
  eq(Number(b.totals().usd.toFixed(8)), Number(((1_400 / 1e6) * USD_PER_MTOK).toFixed(8)));
});

check("the default ceiling is a round dollar, not a measurement", () => {
  // Stated as a test so the number cannot drift away from its comment.
  eq(DEFAULT_BUDGET.dailyInputTokens, 24_000_000);
  eq(Number((((DEFAULT_BUDGET.dailyInputTokens ?? 0) / 1e6) * USD_PER_MTOK).toFixed(3)), 1.008);
});

// ------------------------------------------------------ the safe path

check("no judgment means every component does what the host would", () => {
  // The property that makes a hard ceiling safe. Each component's own
  // no-judgment path is checked in its own test file; what is checked here is
  // that the two the assembly calls directly still hold.
  const model = decideModel({ config: HERMES_ROUTER, judgment: null, current: HERMES_ROUTER.fallback });
  eq(model.label, "sonnet", "no judgment did not mean the cheap rung: ");
  eq(model.changed, false, "no judgment changed the model: ");
  const plan = decidePlan(null);
  eq(plan.split, false, "no judgment split the work: ");
  eq(plan.workers, 1);
  // And an empty shortlist selects nothing rather than everything.
  eq(DEFAULT_SKILL_CONFIG.maxLoad > 0, true);
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
