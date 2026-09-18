/**
 * What has to hold before a request is spent.
 *
 *   npm test      # no API key
 *
 * The load-bearing ones: the corpus's two labels agree (a scenario whose
 * topology is `single` must be one the gate keeps single, and the reverse),
 * the four scenarios built to discriminate really do discriminate, and no
 * scenario's text or any question hands over the gate -- not the numbering,
 * not the boolean, not the pattern names.
 */
import {
  ARMS,
  BIG_ENOUGH,
  DECISION,
  DECISION_PLAIN,
  DIFFERENT,
  INDEPENDENT,
  STAY_SINGLE,
  THREE,
  TOPOLOGY,
  payloadOf,
  questions,
  stateFor,
} from "./src/arms.js";
import { ruleVerdict } from "./src/rules.js";
import {
  CONDITION_KEYS,
  PATTERNS,
  PATTERN_USE,
  SCENARIOS,
  goMulti,
  goMultiWithThree,
} from "./src/scenarios.js";

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

// ------------------------------------------------------------------ the corpus

check("the two labels agree on every scenario", () => {
  for (const s of SCENARIOS) {
    eq(s.topology === "single", !goMulti(s.conditions), `${s.id} (${s.topology})`);
  }
});

check("the gate is the skill's boolean and nothing softer", () => {
  const c = (i: boolean, d: boolean, t: boolean, b: boolean) => ({
    independent: i,
    different: d,
    three: t,
    bigEnough: b,
  });
  eq(goMulti(c(true, false, false, true)), true, "(1) and (4)");
  eq(goMulti(c(false, true, false, true)), true, "(2) and (4)");
  eq(goMulti(c(true, true, true, false)), false, "(4) is a conjunct");
  eq(goMulti(c(false, false, true, true)), false, "(3) is not a reason");
  eq(goMulti(c(false, false, false, true)), false, "size alone is not a reason");
  // And the wrong reading differs on exactly one input pattern.
  eq(goMultiWithThree(c(false, false, true, true)), true, "the wrong reading admits (3)");
  eq(goMultiWithThree(c(false, false, true, false)), false, "it still needs (4)");
});

check("the discriminating scenarios really discriminate", () => {
  const disagree = SCENARIOS.filter((s) => goMulti(s.conditions) !== goMultiWithThree(s.conditions));
  ok(disagree.length >= 4, `only ${disagree.length} scenarios separate the two readings`);
  for (const s of disagree) {
    eq(s.topology, "single", `${s.id} should be a stay-single`);
    eq(s.conditions.three, true, `${s.id} should have condition 3`);
    eq(s.conditions.independent, false, `${s.id} should not have condition 1`);
    eq(s.conditions.different, false, `${s.id} should not have condition 2`);
    eq(s.conditions.bigEnough, true, `${s.id} should have condition 4`);
  }
});

check("every condition is exercised in both directions", () => {
  for (const key of CONDITION_KEYS) {
    const t = SCENARIOS.filter((s) => s.conditions[key]).length;
    ok(t >= 4, `${key} is true in only ${t} scenarios`);
    ok(SCENARIOS.length - t >= 4, `${key} is false in only ${SCENARIOS.length - t} scenarios`);
  }
});

check("every pattern in the skill's table has a scenario", () => {
  for (const p of PATTERNS) {
    ok(
      SCENARIOS.some((s) => s.topology === p),
      `no scenario for ${p}`,
    );
    ok(PATTERN_USE[p].length > 20, `${p} has no criteria text`);
  }
  ok(SCENARIOS.filter((s) => s.topology === "single").length >= 10, "too few stay-singles");
});

check("every row of the skill's Common mistakes table is in the corpus", () => {
  const traps = SCENARIOS.filter((s) => s.trap).map((s) => s.trap!);
  eq(new Set(traps).size, traps.length, "a trap is used twice");
  ok(traps.length >= 7, `only ${traps.length} traps`);
});

check("scenario ids are unique", () => {
  const ids = SCENARIOS.map((s) => s.id);
  eq(new Set(ids).size, ids.length, "duplicate scenario id");
});

// ------------------------------------------------------------------- the input

check("no scenario's text hands over the gate", () => {
  for (const s of SCENARIOS) {
    const text = s.text;
    ok(!/condition\s*[1-4]/i.test(text), `${s.id} names a condition number`);
    ok(!/\(1\)|\(2\)|\(3\)|\(4\)/.test(text), `${s.id} names a numbered condition`);
    ok(!/stay[- ]single|go multi/i.test(text), `${s.id} names the decision`);
    for (const p of PATTERNS) {
      const word = p.replace("_", " ");
      ok(!text.toLowerCase().includes(word), `${s.id} names the pattern ${p}`);
    }
    ok(!/fan-out|fan out|supervisor|blackboard|dynamic dag/i.test(text), `${s.id} names a pattern`);
  }
});

check("a trap's text does not admit to being a trap", () => {
  for (const s of SCENARIOS.filter((x) => x.trap)) {
    ok(!s.text.includes(s.trap!), `${s.id} quotes its own trap`);
    // Narrow on purpose: `debate-will-fix` says the ANSWER keeps coming out
    // wrong, which is the situation, not a confession.
    ok(!/(this|that) is (a |an )?(mistake|anti-?pattern|bad idea)/i.test(s.text), `${s.id} says it is a mistake`);
    ok(!/\b(should not|do not|never)\b/i.test(s.text), `${s.id} tells the reader the answer`);
  }
});

check("no question carries the boolean, the numbering or the label", () => {
  for (const arm of ARMS) {
    const body = payloadOf(arm, SCENARIOS[0]);
    ok(!/condition\s*[1-4]/i.test(body), `${arm} names a condition number`);
    ok(!/\bgate\b/i.test(body), `${arm} names the gate`);
    ok(!/stay[- ]single|go multi/i.test(body), `${arm} names the decision`);
    ok(!body.includes('"single"'), `${arm} leaks the single label`);
    ok(!/"(true|false)":\s*"[^"]*is (a reason|not a reason)/.test(body), `${arm} quotes the rule`);
    for (const s of SCENARIOS) if (s.trap) ok(!body.includes(s.trap), `${arm} leaks a trap name`);
  }
});

check("the atomic questions do not mention each other", () => {
  const qs = questions("all");
  const text = (key: string) => JSON.stringify(qs[key]).toLowerCase();
  // Each condition must stand on its own; a question that said "unlike the
  // parallel-parts question" would be composing in the prompt.
  ok(!text(INDEPENDENT).includes("credential"), "the (1) question mentions (2)'s subject");
  ok(!text(DIFFERENT).includes("same time"), "the (2) question mentions (1)'s subject");
  ok(!text(THREE).includes("parallel"), "the (3) question mentions (1)'s subject");
  ok(!text(BIG_ENOUGH).includes("independent"), "the (4) question mentions (1)'s subject");
});

check("the shapes match the questions", () => {
  const all = questions("all");
  eq(Object.keys(all).length, 8, "the `all` arm should ask eight questions");
  for (const key of [DECISION, DECISION_PLAIN, INDEPENDENT, DIFFERENT, THREE, BIG_ENOUGH, STAY_SINGLE]) {
    eq(all[key].type, "noul", key);
  }
  eq(all[TOPOLOGY].type, "choice");
  const topology = all[TOPOLOGY] as { criteria: Record<string, unknown> };
  eq(Object.keys(topology.criteria).length, PATTERNS.length, "the choice should hold the whole table");
  const nohatch = questions("nohatch");
  eq(Object.keys(nohatch).length, 1, "the `nohatch` arm should ask only the choice");
  ok(nohatch[STAY_SINGLE] === undefined, "the `nohatch` arm still has the escape hatch");
});

check("the state carries the request and nothing else about it", () => {
  const state = stateFor(SCENARIOS[0]);
  eq(JSON.stringify(state).includes(SCENARIOS[0].text), true, "the request is missing");
  ok(!JSON.stringify(state).includes(SCENARIOS[0].why), "the state carries the rationale");
  ok(!JSON.stringify(state).includes(SCENARIOS[0].topology), "the state carries the label");
});

// ----------------------------------------------------------------- the baseline

check("the keyword baseline is neither perfect nor useless", () => {
  let right = 0;
  for (const s of SCENARIOS) if (ruleVerdict(s).multi === goMulti(s.conditions)) right += 1;
  ok(right > SCENARIOS.length * 0.4, `the baseline gets only ${right}/${SCENARIOS.length}`);
  ok(right < SCENARIOS.length, "the keyword baseline solves the corpus, so there is nothing to measure");
});

check("the baseline falls for at least one of the skill's own traps", () => {
  // If it did not, the traps would not be testing what the skill says they
  // test -- that the words are present while the answer is single.
  const fooled = SCENARIOS.filter((s) => s.trap && ruleVerdict(s).multi !== goMulti(s.conditions));
  ok(fooled.length > 0, "no trap fools the keyword rule, so the traps are not word-shaped");
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
