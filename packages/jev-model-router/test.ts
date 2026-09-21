/**
 * What has to hold before a request is spent.
 *
 *   npm test      # no API key, no network, no Pi
 *
 * The load-bearing ones: the decision function is total (no input makes it
 * throw or return nothing), every fallback goes UP the ladder rather than
 * down, the question set asks the shapes docs/01 measured as correct, the
 * task is in the state exactly once, and a fitted ladder beats always-cheap
 * and always-dear on samples where it should.
 */
import { fitLadder, fixedRungCost, rungFor, type LadderSample } from "@jev-playground/jev-core";
import {
  DEFAULT_CONFIG,
  DEFAULT_TIERS,
  EFFORT,
  OVERSIZED,
  TIER,
  UNDERSPECIFIED,
  decide,
  detectOverride,
  payloadOf,
  questionsFor,
  route,
  stateFor,
  validateConfig,
  type Judgment,
  type RouterConfig,
} from "./src/route.js";

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void | Promise<void>): void => {
  const done = (err?: unknown): void => {
    if (err) {
      fail += 1;
      console.log(`  FAIL ${name}: ${(err as Error).message}`);
    } else {
      pass += 1;
      console.log(`  ok   ${name}`);
    }
  };
  try {
    const out = fn();
    if (out instanceof Promise) {
      pending.push(out.then(() => done()).catch(done));
      return;
    }
    done();
  } catch (err) {
    done(err);
  }
};
const pending: Promise<void>[] = [];
const ok = (cond: boolean, what: string): void => {
  if (!cond) throw new Error(what);
};
const eq = <T,>(a: T, b: T, what = ""): void => {
  if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

const CONFIG = DEFAULT_CONFIG;
const ALL = DEFAULT_TIERS.map((t) => t.model);
const HAIKU = ALL[0];
const SONNET = ALL[1];
const OPUS = ALL[2];

function judgment(over: Partial<Judgment> = {}): Judgment {
  return {
    tier: 0,
    tierConfidence: 0.9,
    effort: 0,
    effortConfidence: 0.9,
    underspecified: 0.02,
    oversized: 0.02,
    ...over,
  };
}

// ------------------------------------------------------------- the question set

check("the tier question is a score over the ladder, not a choice", () => {
  const qs = questionsFor(CONFIG);
  // docs/01 §3: the same decision as a choice got 14/24, as a score 23/24.
  // A regression here would be silent, so it is asserted rather than trusted.
  eq(qs[TIER].type, "score", "the tier question must be a score");
  const criteria = (qs[TIER] as { criteria: unknown[] }).criteria;
  eq(criteria.length, CONFIG.tiers.length, "one rubric level per tier");
  eq(JSON.stringify(criteria), JSON.stringify(CONFIG.tiers.map((t) => t.says)), "the rubric is the tiers' own text");
  eq(qs[EFFORT].type, "score", "effort is ordered too");
  eq(qs[UNDERSPECIFIED].type, "noul");
  eq(qs[OVERSIZED].type, "noul");
});

check("the escape hatches are separate nouls and not rungs on the ladder", () => {
  const qs = questionsFor(CONFIG);
  const rubric = JSON.stringify((qs[TIER] as { criteria: unknown[] }).criteria).toLowerCase();
  // docs/17 §3: an out-of-scope option inside the choice caught 16/18 and
  // dragged answerable-but-hard cases into it; as its own noul, 18/18.
  ok(!rubric.includes("vague") && !rubric.includes("unclear"), "the ladder offers an escape rung");
  ok(!rubric.includes("too large") && !rubric.includes("does not fit"), "the ladder offers an overflow rung");
  eq(Object.keys(qs).length, 4, "four questions, one request");
});

check("the task is in the state once and the rubric is not", () => {
  const input = { task: "fix the failing auth test", recent: ["earlier: it passed yesterday"] };
  const state = stateFor(input, CONFIG);
  eq(state.request, input.task);
  const body = JSON.stringify(state);
  eq(body.split("fix the failing auth test").length - 1, 1, "the task appears more than once in the state");
  // docs/30 §7: shared text belongs in the state, per-question text does not.
  for (const tier of CONFIG.tiers) ok(!body.includes(tier.says), "the state repeats the rubric");
  // A judgment that can see the price of its own answer is being asked two
  // things at once, so the per-tier prices stay out.
  ok(!/"price"/.test(body), "the state carries per-tier prices");
});

check("the whole request stays inside the byte budget for a long task", () => {
  const long = "refactor the scheduler. ".repeat(400);
  const bytes = new TextEncoder().encode(payloadOf({ task: long }, CONFIG)).length;
  ok(bytes < 28_000, `a 9,600-character task produced a ${bytes}-byte request`);
});

// ------------------------------------------------------------- the policy

check("decide is total: no input throws, and every path names a model", () => {
  const inputs: Parameters<typeof decide>[0][] = [
    { config: CONFIG, judgment: null, current: SONNET },
    { config: CONFIG, judgment: judgment({ tier: Number.NaN }), current: SONNET },
    { config: CONFIG, judgment: judgment(), current: "a model that does not exist" },
    { config: CONFIG, judgment: judgment({ tier: 99 }), current: SONNET },
    { config: CONFIG, judgment: judgment({ tier: -99 }), current: SONNET },
    { config: CONFIG, judgment: judgment(), current: SONNET, available: [] },
    { config: CONFIG, judgment: judgment(), current: SONNET, available: ["nothing-runnable"] },
  ];
  for (const i of inputs) {
    const d = decide(i);
    ok(ALL.includes(d.model), `${JSON.stringify(i.judgment)} produced ${d.model}`);
    ok(d.reason.length > 0, "a decision with no reason");
    ok(d.rung >= 0 && d.rung < CONFIG.tiers.length, `rung ${d.rung} out of range`);
  }
});

check("judgment unavailable falls back, and the fallback is the configured one", () => {
  const d = decide({ config: CONFIG, judgment: null, current: HAIKU });
  eq(d.model, CONFIG.fallback);
  ok(d.reason.startsWith("unavailable"), d.reason);
});

check("both escape hatches send work UP, never down", () => {
  for (const key of ["underspecified", "oversized"] as const) {
    const d = decide({ config: CONFIG, judgment: judgment({ tier: 0, [key]: 0.95 }), current: HAIKU });
    eq(d.model, OPUS, `${key} did not escalate`);
    eq(d.reason.split("/")[0], key);
  }
  // And a confident easy task is still allowed to be cheap.
  eq(decide({ config: CONFIG, judgment: judgment({ tier: 0 }), current: OPUS }).model, HAIKU);
});

check("a low-confidence answer cannot move work down the ladder", () => {
  const low = judgment({ tier: 0, tierConfidence: 0.2 });
  eq(decide({ config: CONFIG, judgment: low, current: OPUS }).model, OPUS, "a low-confidence downgrade went through");
  eq(decide({ config: CONFIG, judgment: low, current: OPUS }).reason.split("/")[0], "low-confidence-no-downgrade");
  // Upward is fine at low confidence: being too strong costs money, being too
  // weak costs the turn as well.
  eq(decide({ config: CONFIG, judgment: judgment({ tier: 2, tierConfidence: 0.2 }), current: HAIKU }).model, OPUS);
});

check("a downgrade is refused once the conversation is big", () => {
  const easy = judgment({ tier: 0 });
  eq(decide({ config: CONFIG, judgment: easy, current: OPUS, contextTokens: 5_000 }).model, HAIKU);
  const held = decide({ config: CONFIG, judgment: easy, current: OPUS, contextTokens: 200_000 });
  eq(held.model, OPUS);
  eq(held.reason.split("/")[0], "downgrade-not-worth-cache-rebuild");
});

check("an unavailable rung clamps upward, and only downward as a last resort", () => {
  const easy = judgment({ tier: 0 });
  // Haiku chosen but not installed: step up rather than fail the work.
  eq(decide({ config: CONFIG, judgment: easy, current: SONNET, available: [SONNET, OPUS] }).model, SONNET);
  // Opus chosen but only haiku runs: nothing above, so step down and say so.
  const down = decide({ config: CONFIG, judgment: judgment({ tier: 2 }), current: HAIKU, available: [HAIKU] });
  eq(down.model, HAIKU);
  ok(down.reason.includes("unavailable"), down.reason);
});

check("an explicit tier in the request outranks judgment", () => {
  eq(detectOverride(CONFIG, "use opus for this one"), OPUS);
  eq(detectOverride(CONFIG, "switch to haiku"), HAIKU);
  eq(detectOverride(CONFIG, "the haikus in this file need formatting"), null, "a bare mention is not an override");
  eq(detectOverride(CONFIG, "fix the test"), null);
  const d = decide({ config: CONFIG, judgment: judgment({ tier: 0 }), current: HAIKU, override: OPUS });
  eq(d.model, OPUS);
  eq(d.reason.split("/")[0], "override");
});

check("effort is read from its own score and rounds inside the level list", () => {
  eq(decide({ config: CONFIG, judgment: judgment({ effort: 0 }), current: SONNET }).effort, "low");
  eq(decide({ config: CONFIG, judgment: judgment({ effort: 1.4 }), current: SONNET }).effort, "medium");
  eq(decide({ config: CONFIG, judgment: judgment({ effort: 9 }), current: SONNET }).effort, "high");
  eq(decide({ config: CONFIG, judgment: judgment({ effort: Number.NaN }), current: SONNET }).effort, null);
  const noEffort: RouterConfig = { ...CONFIG, effort: null };
  eq(decide({ config: noEffort, judgment: judgment(), current: SONNET }).effort, null);
  ok(!(EFFORT in questionsFor(noEffort)), "effort was asked with no levels configured");
});

check("a fitted ladder is used when present and rounding when not", () => {
  const fitted: RouterConfig = { ...CONFIG, cuts: [0.4, 0.6] };
  // 0.5 rounds to rung 0, but sits above the first fitted cut, so the two
  // paths disagree -- which is the whole reason cuts are worth fitting.
  eq(decide({ config: CONFIG, judgment: judgment({ tier: 0.5 }), current: SONNET }).rung, 1, "Math.round(0.5) is 1");
  eq(decide({ config: fitted, judgment: judgment({ tier: 0.5 }), current: SONNET }).rung, 1);
  eq(decide({ config: fitted, judgment: judgment({ tier: 0.3 }), current: SONNET }).rung, 0);
  eq(decide({ config: fitted, judgment: judgment({ tier: 0.7 }), current: SONNET }).rung, 2);
  eq(decide({ config: CONFIG, judgment: judgment({ tier: 0.7 }), current: SONNET }).reason.split("/")[0], "rounded");
  eq(decide({ config: fitted, judgment: judgment({ tier: 0.7 }), current: SONNET }).reason.split("/")[0], "fitted");
});

check("a bad configuration is refused rather than silently repaired", () => {
  const bad: [Partial<RouterConfig>, string][] = [
    [{ tiers: [DEFAULT_TIERS[0]] }, "one tier"],
    [{ fallback: "not-a-model" }, "unknown fallback"],
    [{ cuts: [1] }, "wrong number of cuts"],
    [{ cuts: [2, 1] }, "descending cuts"],
    [{ tiers: [DEFAULT_TIERS[0], { ...DEFAULT_TIERS[1], label: DEFAULT_TIERS[0].label }] }, "duplicate labels"],
  ];
  for (const [over, why] of bad) {
    let threw = false;
    try {
      validateConfig({ ...CONFIG, ...over });
    } catch {
      threw = true;
    }
    ok(threw, `${why} was accepted`);
  }
  validateConfig(CONFIG);
  validateConfig({ ...CONFIG, cuts: [0.5, 1.5] });
});

// ------------------------------------------------------------- the cost ladder

check("the fitted ladder beats both fixed strategies when the score separates", () => {
  // Easy tasks score low and the cheap rung suffices; hard tasks score high
  // and it does not. A ladder that reads the score should beat both constants.
  const samples: LadderSample[] = [];
  for (let i = 0; i < 20; i += 1) samples.push({ score: 0.1 + i * 0.01, cheapest: 0, group: `easy${i}` });
  for (let i = 0; i < 20; i += 1) samples.push({ score: 1.6 + i * 0.01, cheapest: 2, group: `hard${i}` });
  const rungs = DEFAULT_TIERS.map((t) => ({ name: t.label, price: t.price }));
  const cost = { failurePenalty: 50 };
  const fit = fitLadder(samples, rungs, cost);
  ok(fit.fitted, fit.why);
  const cheap = fixedRungCost(0, samples, rungs, cost);
  const dear = fixedRungCost(2, samples, rungs, cost);
  ok(fit.cost < cheap, `fitted ${fit.cost} should beat always-cheap ${cheap}`);
  ok(fit.cost < dear, `fitted ${fit.cost} should beat always-dear ${dear}`);
  // With the penalty this high, always-cheap must be the worse constant.
  ok(cheap > dear, `always-cheap ${cheap} should cost more than always-dear ${dear} at penalty 50`);
});

check("the penalty decides the answer, which is why it has no default", () => {
  const samples: LadderSample[] = [
    { score: 0.2, cheapest: 0, group: "a" },
    { score: 0.3, cheapest: 2, group: "b" },
  ];
  const rungs = DEFAULT_TIERS.map((t) => ({ name: t.label, price: t.price }));
  // A cheap failure: take the risk. An expensive one: do not.
  const lenient = fitLadder(samples, rungs, { failurePenalty: 1 });
  const strict = fitLadder(samples, rungs, { failurePenalty: 1000 });
  eq(rungFor(0.3, lenient.cuts), 0, "a trivial penalty should still route cheap");
  eq(rungFor(0.3, strict.cuts), 2, "a large penalty should route dear");
});

check("a sample no rung could serve cannot punish a cutoff", () => {
  const rungs = DEFAULT_TIERS.map((t) => ({ name: t.label, price: t.price }));
  const cost = { failurePenalty: 100 };
  const withImpossible: LadderSample[] = [
    { score: 0.1, cheapest: 0, group: "a" },
    { score: 0.2, cheapest: null, group: "b" },
  ];
  const fit = fitLadder(withImpossible, rungs, cost);
  // The impossible task adds the price of whatever rung it lands on and no
  // penalty, so it cannot drag the cutoff upward.
  eq(rungFor(0.2, fit.cuts), 0, "an unservable task pushed the cutoff up");
});

// ------------------------------------------------------------- the failure path

check("route never throws and returns the fallback when there is no key", async () => {
  const saved = { a: process.env.TYPESAFE_API_KEY, b: process.env.TYPESAFEAI_API_KEY };
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFEAI_API_KEY;
  try {
    const result = await route({ task: "fix the test" });
    eq(result.decision.model, CONFIG.fallback);
    eq(result.judgment, null);
    ok((result.error ?? "").includes("no API key"), result.error ?? "no error reported");
  } finally {
    if (saved.a !== undefined) process.env.TYPESAFE_API_KEY = saved.a;
    if (saved.b !== undefined) process.env.TYPESAFEAI_API_KEY = saved.b;
  }
});

check("an override short-circuits before any request is made", async () => {
  const saved = { a: process.env.TYPESAFE_API_KEY, b: process.env.TYPESAFEAI_API_KEY };
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFEAI_API_KEY;
  try {
    const result = await route({ task: "use opus for this" });
    eq(result.decision.model, OPUS);
    // No key, and yet no error: nothing was asked.
    eq(result.error, undefined);
  } finally {
    if (saved.a !== undefined) process.env.TYPESAFE_API_KEY = saved.a;
    if (saved.b !== undefined) process.env.TYPESAFEAI_API_KEY = saved.b;
  }
});

await Promise.all(pending);
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
