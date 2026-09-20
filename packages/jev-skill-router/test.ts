/**
 * What has to hold before a request is spent.
 *
 *   npm test      # no API key, no network, no Pi
 *
 * The load-bearing ones: a skill the host marked non-invocable can never be
 * loaded, the escape hatch cannot be smuggled into the score question, the
 * cap is applied after the cutoff and not instead of it, the prefilter's
 * recall is what the README claims on a catalogue this test builds, and every
 * failure path still honours the catalogue's own decisions.
 */
import {
  DEFAULT_SKILL_CONFIG,
  LEVELS,
  NONE,
  PREFILTERS,
  TERSE_LEVELS,
  keepTop,
  keyFor,
  payloadOf,
  prescore,
  questionsFor,
  route,
  selectFrom,
  split,
  stateFor,
  type Pick,
  type Skill,
} from "./src/route.js";

let pass = 0;
let fail = 0;
const pending: Promise<void>[] = [];
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
const ok = (cond: boolean, what: string): void => {
  if (!cond) throw new Error(what);
};
const eq = <T,>(a: T, b: T, what = ""): void => {
  if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

const CATALOGUE: Skill[] = [
  { name: "pdf-extraction", description: "Extract tables and text from supplied PDF files, with page references." },
  { name: "csv-cleaning", description: "Clean malformed and duplicate rows in supplied CSV files." },
  { name: "cloudflare-workers", description: "Deploy and configure Cloudflare Workers, wrangler.toml and KV bindings." },
  { name: "dockerfile-repair", description: "Fix multi-stage Dockerfile builds that fail to produce an image." },
  { name: "house-style", description: "The repository's own prose and commit-message conventions.", route: "always" },
  { name: "legacy-deploy", description: "The retired deploy script. Kept for reference only.", route: "never" },
  { name: "prod-credentials", description: "Rotate production credentials.", invocable: false },
];

const CTX = { request: "Repair the multi-stage Dockerfile so the image builds." };

// ------------------------------------------------------------- the catalogue

check("the catalogue's own routing happens before any question", () => {
  const parts = split(CATALOGUE);
  eq(parts.always.map((s) => s.name).join(), "house-style");
  eq(parts.never.map((s) => s.name).join(), "legacy-deploy");
  eq(parts.blocked.map((s) => s.name).join(), "prod-credentials");
  eq(parts.judge.length, 4, "only the undecided skills should reach judgment");
  ok(!parts.judge.some((s) => s.route === "always" || s.route === "never"), "a decided skill reached judgment");
});

check("a non-invocable skill is unreachable, not merely unranked", () => {
  // The host said the model may not pull this in. The filter is in `split`,
  // before the prefilter and before the policy, so no cutoff or cap can undo
  // it and no bug downstream can either.
  const parts = split(CATALOGUE);
  ok(!parts.judge.some((s) => s.name === "prod-credentials"), "a blocked skill reached judgment");
  const body = payloadOf(CTX, parts.judge);
  ok(!body.includes("prod-credentials"), "a blocked skill's name was sent");
  ok(!body.includes("Rotate production credentials"), "a blocked skill's description was sent");
  // And even if one slipped into the picks, it is not "always" so it needs the
  // cutoff; assert the cutoff cannot pass it without a level.
  const sneak: Pick = {
    skill: CATALOGUE.find((s) => s.name === "prod-credentials")!,
    level: 3,
    confidence: 1,
    why: "judged",
  };
  const out = selectFrom([sneak], 0.01, { ...DEFAULT_SKILL_CONFIG, maxLoad: 0 });
  eq(out.load.length, 0, "maxLoad 0 still loaded a judged skill");
});

check("the prefilter finds the right skill and its recall ceiling is real", () => {
  const parts = split(CATALOGUE);
  const scores = prescore(parts.judge, CTX);
  const top = keepTop(parts.judge, scores, 1);
  eq(top[0].name, "dockerfile-repair", "the prefilter missed the obvious match");
  // A skill the prefilter drops can never come back. That is the ceiling the
  // README states, and it is a property of the stage, so it is asserted.
  const narrow = keepTop(parts.judge, scores, 1);
  ok(!narrow.some((s) => s.name === "csv-cleaning"), "k=1 kept more than one skill");
  const body = payloadOf(CTX, narrow);
  ok(!body.includes("csv-cleaning"), "a dropped skill still reached the request");
});

check("every prefilter is total and none reorders by catalogue position", () => {
  const parts = split(CATALOGUE);
  for (const filter of PREFILTERS) {
    const scores = prescore(parts.judge, CTX, filter);
    eq(scores.length, parts.judge.length, filter);
    for (const s of scores) ok(Number.isFinite(s.score), `${filter} produced a non-finite score for ${s.name}`);
  }
  // `none` gives every skill the same score, so the tie-break decides; it must
  // be the name and not the input order, or a caller listing the right skill
  // first gets credit the prefilter did not earn.
  const flat = prescore(parts.judge, CTX, "none");
  const kept = keepTop([...parts.judge].reverse(), flat, 2).map((s) => s.name);
  eq(kept.join(), "cloudflare-workers,csv-cleaning", "the tie-break is not by name");
});

check("an empty context does not crash the prefilter", () => {
  const scores = prescore(split(CATALOGUE).judge, { request: "" });
  for (const s of scores) eq(s.score, 0, `${s.name} scored on an empty request`);
});

// ------------------------------------------------------------- the questions

check("each skill gets an ordered score, four words wide", () => {
  const shortlist = split(CATALOGUE).judge;
  const qs = questionsFor(shortlist);
  for (const s of shortlist) {
    const q = qs[keyFor(s.name)];
    // docs/29 §2 measured the noul form at 0.44-0.54 AP against 0.56 for the
    // score form that names when it applies. The shape is the finding.
    eq(q.type, "score", s.name);
    eq(JSON.stringify((q as { criteria: unknown[] }).criteria), JSON.stringify(TERSE_LEVELS), s.name);
  }
  eq(Object.keys(qs).length, shortlist.length + 1, "one question per skill plus the escape hatch");
});

check("the escape hatch is its own noul and not a level on the ladder", () => {
  const qs = questionsFor(split(CATALOGUE).judge);
  eq(qs[NONE].type, "noul");
  // docs/17 §3: as a level it caught 16/18 and pulled real cases into it.
  for (const level of TERSE_LEVELS) ok(!/none|no skill|other/i.test(level), `"${level}" is an escape level`);
});

check("the level text is in the state once and not in any question", () => {
  const shortlist = split(CATALOGUE).judge;
  const state = JSON.stringify(stateFor(CTX));
  const questions = JSON.stringify(questionsFor(shortlist));
  // docs/30 §7: this move took a question from 251 tokens to 118 and doubled
  // how many fit a request, with answers unchanged.
  for (const level of LEVELS) {
    ok(state.includes(level), "the full level text is missing from the state");
    ok(!questions.includes(level), "the full level text is repeated in a question");
  }
  eq(state.split("An agent working in the context below").length - 1, 1, "the task sentence is not paid once");
  ok(!questions.includes("An agent working in the context below"), "the task sentence is in the questions");
});

check("a 60-skill shortlist stays inside the byte budget", () => {
  const many: Skill[] = Array.from({ length: 60 }, (_, i) => ({
    name: `skill-number-${i}`,
    description: `A reasonably wordy description of what skill number ${i} does, about as long as a real one gets in a public catalogue.`,
  }));
  const bytes = new TextEncoder().encode(payloadOf(CTX, many)).length;
  ok(bytes < 28_000, `60 skills produced a ${bytes}-byte request`);
});

// ------------------------------------------------------------- the policy

const picks = (levels: Record<string, number>, why: Pick["why"] = "judged"): Pick[] =>
  Object.entries(levels).map(([name, level]) => ({
    skill: { name, description: name },
    level,
    confidence: 0.9,
    why,
  }));

check("the cutoff decides, and the cap only trims what cleared it", () => {
  const config = { ...DEFAULT_SKILL_CONFIG, loadAt: 2.5, maxLoad: 2 };
  // One clear winner: load one, not `maxLoad`. Ranking-and-taking-k would
  // load two here, including one nobody asked for.
  const one = selectFrom(picks({ a: 2.9, b: 1.2, c: 0.1 }), 0.05, config);
  eq(one.load.map((p) => p.skill.name).join(), "a");
  eq(one.reason, "judged");
  // Three clear the cutoff and the cap trims to two, strongest first.
  const many = selectFrom(picks({ a: 2.9, b: 2.8, c: 2.6, d: 0.2 }), 0.05, config);
  eq(many.load.map((p) => p.skill.name).join(), "a,b");
  eq(many.reason, "capped");
  ok(many.considered.some((p) => p.skill.name === "c"), "a skill that cleared the cutoff vanished from the record");
  // Nothing clears it: load nothing and say which case this was.
  const none = selectFrom(picks({ a: 1.1, b: 0.4 }), 0.05, config);
  eq(none.load.length, 0);
  eq(none.reason, "nothing-over-cutoff");
});

check("the escape hatch suppresses judged loads but not the catalogue's own", () => {
  const config = { ...DEFAULT_SKILL_CONFIG, noneAt: 0.8 };
  const mixed = [...picks({ judged: 2.9 }), ...picks({ policy: 3 }, "always")];
  const fired = selectFrom(mixed, 0.95, config);
  eq(fired.load.map((p) => p.skill.name).join(), "policy", "the escape hatch dropped a policy skill");
  eq(fired.reason, "none-apply");
  // Below the threshold it changes nothing.
  const quiet = selectFrom(mixed, 0.1, config);
  eq(quiet.load.length, 2);
});

check("a missing escape answer does not silently suppress everything", () => {
  // NaN means "not answered". Treating that as "the hatch fired" would make
  // every partial response load nothing, which is the failure mode that looks
  // like the router working.
  const out = selectFrom(picks({ a: 2.9 }), Number.NaN, DEFAULT_SKILL_CONFIG);
  eq(out.load.map((p) => p.skill.name).join(), "a");
});

// ------------------------------------------------------------- the failure path

check("route falls back to the catalogue's decisions with no key", async () => {
  const saved = { a: process.env.TYPESAFE_API_KEY, b: process.env.TYPESAFEAI_API_KEY };
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFEAI_API_KEY;
  try {
    const decision = await route(CTX, CATALOGUE);
    eq(decision.reason, "unavailable");
    // The catalogue said "always" for this one, and no outage changes that.
    eq(decision.load.map((p) => p.skill.name).join(), "house-style");
    ok((decision.error ?? "").includes("no API key"), decision.error ?? "no error reported");
    eq(decision.droppedBy.blocked.join(), "prod-credentials");
  } finally {
    if (saved.a !== undefined) process.env.TYPESAFE_API_KEY = saved.a;
    if (saved.b !== undefined) process.env.TYPESAFEAI_API_KEY = saved.b;
  }
});

check("a catalogue with nothing judgeable asks nothing", async () => {
  const decision = await route(CTX, [CATALOGUE[4], CATALOGUE[5], CATALOGUE[6]]);
  eq(decision.reason, "nothing-to-ask");
  eq(decision.load.map((p) => p.skill.name).join(), "house-style");
  eq(decision.error, undefined, "asking nothing is not an error");
});

await Promise.all(pending);
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
