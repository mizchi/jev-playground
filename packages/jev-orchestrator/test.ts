/**
 * What has to hold before this advises on splitting work. No API key.
 *
 *   npm test
 *
 * Most of this is about NOT re-introducing what docs/31 measured as harmful:
 * the fourth condition must stay out of the question and in the code, the
 * bold "condition 3 is not a reason to spawn" must have no way in, and both
 * wordings of the gate must be the strings that were measured rather than
 * paraphrases of them.
 */
import {
  DEFAULT_ORCHESTRATOR_CONFIG,
  DEFAULT_PLAN_CONFIG,
  GATE,
  GATE_AT,
  gateAtFor,
  PATTERNS,
  SIZE,
  STAY_SINGLE,
  TOPOLOGY,
  brief,
  decide,
  payloadOf,
  plan,
  questionsFor,
  stateFor,
  type Judgment,
  type Pattern,
} from "./src/plan.js";
import { Jev } from "@jev-playground/jev-core";

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve()
    .then(fn)
    .then(() => {
      pass += 1;
      console.log(`  ok   ${name}`);
    })
    .catch((err: Error) => {
      fail += 1;
      console.log(`  FAIL ${name}: ${err.message}`);
    });
const ok = (cond: boolean, what: string): void => {
  if (!cond) throw new Error(what);
};
const eq = <T,>(a: T, b: T, what = ""): void => {
  if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

function judgment(over: Partial<Judgment> = {}): Judgment {
  const probabilities = Object.fromEntries(PATTERNS.map((p) => [p, p === "fanout" ? 0.7 : 0.04]));
  return {
    gate: 0.9,
    topology: "fanout",
    topologyConfidence: 0.8,
    probabilities,
    staySingle: 0.1,
    size: 0.9,
    ...over,
  };
}

const tests: Promise<void>[] = [];

// -------------------------------------------------- the question

tests.push(
  check("the gate is one question, not four composed", () => {
    // docs/31 §2: composing the documented `(1 or 2) and 4` scored 30/38 and
    // asking directly scored 30/38. Four questions is four more ways to be
    // wrong for no measured gain.
    const qs = questionsFor("cost");
    eq(qs[GATE].type, "noul");
    // The conditions must NOT be present as separate questions.
    for (const name of ["independent_parts", "different_vantage", "checkable_artifacts"]) {
      ok(!(name in qs), `${name} is asked; the composed form was measured as no better`);
    }
  }),
);

tests.push(
  check("condition 3 has no way into the decision", () => {
    // The skill's own bold line: "3 is not a reason to spawn". docs/31
    // measured that including it loses 4/4 on the cases built to test it.
    // Asking directly is what keeps it out, so what is checked is that no
    // question mentions a mechanical check at all.
    const body = payloadOf({ request: "whatever" }, "cost").toLowerCase();
    for (const word of ["linter", "schema", "mechanical", "re-derivation", "checkable"]) {
      ok(!body.includes(word), `the payload asks about condition 3 ("${word}")`);
    }
  }),
);

tests.push(
  check("both gate wordings are the strings docs/31 measured", () => {
    // A paraphrase would make the 22/38 and 30/38 numbers describe something
    // other than this code. The distinguishing clause of each is asserted
    // rather than the whole string, so ordinary edits elsewhere are free.
    const cost = JSON.stringify(questionsFor("cost")[GATE]);
    const plainly = JSON.stringify(questionsFor("plain")[GATE]);
    ok(cost.includes("costs tokens, latency"), "the strict wording lost its cost sentence");
    ok(cost.includes("mistake propagating"), "the strict wording lost the propagation clause");
    ok(!plainly.includes("costs"), "the permissive wording has acquired a cost sentence");
    ok(plainly.includes("better done by more than one worker"), "the permissive wording changed");
  }),
);

tests.push(
  check("the topology choice carries all eight patterns", () => {
    // 22/22 with zero pattern confusions was measured over ALL EIGHT. Removing
    // an option a host cannot run would change the question, so the policy
    // substitutes afterwards instead (see the next check).
    const qs = questionsFor("cost");
    eq(qs[TOPOLOGY].type, "choice");
    const criteria = (qs[TOPOLOGY] as { criteria: Record<string, unknown> }).criteria;
    eq(Object.keys(criteria).length, 8);
    for (const p of PATTERNS) ok(p in criteria, `${p} is missing from the criteria`);
    // Even though two of them are unavailable by default.
    for (const p of DEFAULT_ORCHESTRATOR_CONFIG.unavailable) ok(p in criteria, `${p} was removed from the question`);
  }),
);

tests.push(
  check("the state carries the request and nothing about the answer", () => {
    const body = JSON.stringify(stateFor({ request: "split the migration", cwd: "/tmp" }));
    for (const word of ["fanout", "sequential", "workers", "gateAt", "single"]) {
      ok(!body.includes(word), `the state leaks "${word}"`);
    }
  }),
);

// -------------------------------------------------- the policy

tests.push(
  check("no judgment means one worker, and that is a rule not an accident", () => {
    const p = decide(null);
    eq(p.shape, "single");
    eq(p.workers, 1);
    eq(p.split, false);
    eq(p.agreement, "unknown");
    // A NaN gate is the same case: a missing answer must not read as a fired gate.
    eq(decide(judgment({ gate: Number.NaN })).shape, "single");
  }),
);

tests.push(
  check("the size floor vetoes a fired gate, and says why", () => {
    // The cost lives in code. docs/31 §2 is the reason: naming the cost in
    // the PROMPT moved the gate 21 points and skewed every error one way.
    // A veto applied to an answer cannot change the answer.
    const p = decide(judgment({ size: 0.2 }));
    eq(p.shape, "single");
    eq(p.split, false);
    ok(p.reason.includes("fixed cost does not shrink"), `the reason does not explain the veto: ${p.reason}`);
    // And it is a floor, not a gate: raise the size and it splits.
    eq(decide(judgment({ size: 0.9 })).split, true);
  }),
);

tests.push(
  check("an unavailable pattern is substituted from the same answer", () => {
    // A `choice` returns every option's probability, so the runner-up costs
    // no second request.
    const probabilities = Object.fromEntries(PATTERNS.map((p) => [p, p === "evolution" ? 0.8 : p === "fanout" ? 0.15 : 0.01]));
    const p = decide(judgment({ topology: "evolution", probabilities }));
    eq(p.shape, "fanout");
    eq(p.substituted?.from, "evolution");
    eq(p.substituted?.to, "fanout");
    ok(p.reason.includes("cannot run"), `the reason does not say why: ${p.reason}`);
  }),
);

tests.push(
  check("a host that can run nothing falls back to one worker", () => {
    const p = decide(judgment(), { ...DEFAULT_ORCHESTRATOR_CONFIG, unavailable: [...PATTERNS] });
    eq(p.shape, "single");
    eq(p.split, false);
    eq(p.substituted?.to, "single");
  }),
);

tests.push(
  check("a sequential pattern never asks for parallel workers", () => {
    // `sequential` and `handoff` are pipelines: three workers on a pipeline
    // is three workers waiting.
    for (const shape of ["sequential", "handoff"] as Pattern[]) {
      const probabilities = Object.fromEntries(PATTERNS.map((p) => [p, p === shape ? 0.9 : 0.01]));
      const p = decide(judgment({ topology: shape, probabilities, size: 1 }), {
        ...DEFAULT_ORCHESTRATOR_CONFIG,
        maxWorkers: 8,
        unavailable: [],
      });
      eq(p.workers, 2, `${shape}: `);
    }
    // A parallel shape does scale with size, up to the cap.
    eq(decide(judgment({ size: 0.9 }), { ...DEFAULT_ORCHESTRATOR_CONFIG, maxWorkers: 5 }).workers, 5);
    eq(decide(judgment({ size: 0.6 }), { ...DEFAULT_ORCHESTRATOR_CONFIG, maxWorkers: 5 }).workers, 2);
  }),
);

tests.push(
  check("the inverted framing is recorded but cannot veto", () => {
    // docs/31 §2b measured `stay_single` as the loosest reading of all on the
    // skill's own traps (3/7 against the gate's 6/7). Letting it override
    // would replace the strictest signal with the weakest.
    const p = decide(judgment({ staySingle: 0.99 }));
    eq(p.split, true, "the inverted framing vetoed a fired gate: ");
    eq(p.agreement, "disagree");
    ok(p.reason.includes("disagrees"), "the disagreement is not surfaced");
    eq(decide(judgment({ staySingle: 0.1 })).agreement, "agree");
    eq(decide(judgment({ staySingle: Number.NaN })).agreement, "unknown");
  }),
);

tests.push(
  check("the two framings do not share a cutoff", () => {
    // The finding from docs/31 §8: the wordings answer on different scales
    // (cost named tops out at 0.78 with means 0.208/0.406; cost unnamed reaches
    // 0.95 with means 0.320/0.665). Read at a shared 0.5 the compressed one
    // merely LOOKS strict. One number for both is the bug this asserts against.
    ok(GATE_AT.cost !== GATE_AT.plain, "both framings were given the same cutoff");
    ok(GATE_AT.plain > GATE_AT.cost, "the wider-scaled wording did not get the higher cutoff");
    // The specific measured pair, so a drift shows up as a failure rather than
    // as a quietly different policy.
    eq(GATE_AT.cost, 0.5);
    eq(GATE_AT.plain, 0.73);
  }),
);

tests.push(
  check("a pinned cutoff wins over the framing's fitted one", () => {
    eq(gateAtFor("cost", null), GATE_AT.cost);
    eq(gateAtFor("plain", undefined), GATE_AT.plain);
    eq(gateAtFor("plain", 0.5), 0.5, "a caller's explicit cutoff was overridden: ");
    // Zero is a real cutoff, not a missing one.
    eq(gateAtFor("cost", 0), 0);
  }),
);

tests.push(
  check("the same gate answer decides differently under the two framings", () => {
    // The consequence, spelled out. 0.60 is above `cost`'s 0.50 and below
    // `plain`'s 0.73, so it splits under one wording and not the other --
    // which is the whole reason the cutoff cannot be shared.
    const at = (framing: "cost" | "plain"): ReturnType<typeof decide> =>
      decide(judgment({ gate: 0.6 }), {
        ...DEFAULT_ORCHESTRATOR_CONFIG,
        gateAt: gateAtFor(framing, null),
        unavailable: [],
      });
    eq(at("cost").split, true, "the strict wording did not fire at 0.60: ");
    eq(at("plain").split, false, "the permissive wording fired at 0.60: ");
  }),
);

tests.push(
  check("an unresolved cutoff falls back to the default framing's, not to a bare 0.5", () => {
    // docs/31 §8 measured `plain` at 0.5 as the WORST of nine configurations
    // (held-out loss 1.167 against 0.579 for doing nothing), so a bare 0.5 is
    // not a safe default for a framing nobody named. It happens to coincide
    // with `cost`'s fitted number, which is why this asserts the SOURCE.
    const p = decide(judgment({ gate: 0.6 }), { ...DEFAULT_ORCHESTRATOR_CONFIG, gateAt: null, unavailable: [] });
    eq(p.split, true, "a null cutoff did not resolve to the cost framing's: ");
    const below = decide(judgment({ gate: 0.4 }), { ...DEFAULT_ORCHESTRATOR_CONFIG, gateAt: null });
    eq(below.split, false);
    ok(below.reason.includes(String(GATE_AT.cost)), `the reason does not name the cutoff used: ${below.reason}`);
  }),
);

tests.push(
  check("the default framing is the strict one", () => {
    // The choice for a resident agent, and the one thing in this package a
    // reader is most likely to want justified: the expensive error for a
    // cheap always-on agent is the unnecessary fan-out.
    eq(DEFAULT_PLAN_CONFIG.framing, "cost");
  }),
);

// -------------------------------------------------- the brief

tests.push(
  check("the brief names a shape and does not invent the steps", () => {
    // 22/22 was about naming which of eight patterns fits. Nothing measured
    // says Jev can decompose work, so the brief must not read as if it had.
    const single = brief({ plan: decide(judgment({ gate: 0.1 })), judgment: null, ms: 1 });
    ok(single.includes("one agent"), single);
    const split = brief({ plan: decide(judgment()), judgment: null, ms: 1 });
    ok(split.includes("fanout"), split);
    ok(split.includes("shape, not the steps"), "the brief does not disclaim the decomposition");
    ok(!/worker 1|first worker|then the second/i.test(split), "the brief invented a division of labour");
  }),
);

tests.push(
  check("a dead endpoint plans one worker and reports the failure", async () => {
    const dead = new Jev({ apiKey: "x", baseUrl: "http://127.0.0.1:1", retries: 0, timeoutMs: 200 });
    const result = await plan({ request: "port everything to v2" }, { jev: dead });
    eq(result.plan.shape, "single");
    eq(result.plan.split, false);
    ok(Boolean(result.error), "the failure was not reported");
    eq(result.judgment, null);
  }),
);

tests.push(
  check("the four questions ride one request", () => {
    // docs/29 §4: a question's answer does not move with the request's width,
    // so the topology is known before the gate has been read -- which is what
    // lets the audit line say what the alternative would have been.
    const qs = questionsFor("cost");
    eq(Object.keys(qs).length, 4);
    for (const key of [GATE, TOPOLOGY, STAY_SINGLE, SIZE]) ok(key in qs, `${key} is missing`);
  }),
);

await Promise.all(tests);
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
