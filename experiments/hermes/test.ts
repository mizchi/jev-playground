/**
 * What has to hold before the combine record is trusted. No API key.
 *
 *   npm test
 *
 * The record is a comparison of two ways of ASKING, so it needs no labels --
 * but that makes two other things load-bearing instead: the turns have to
 * differ (or every row reads as agreement, which is docs/36 §5.2's trap), and
 * the two ways have to be asking the same questions (or the comparison is
 * between two different things).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  keyGroups,
  questionsFor,
  stateFor,
  type TurnConfig,
} from "../../packages/jev-hermes/src/turn.js";
import { HERMES_ROUTER } from "../../packages/jev-hermes/src/tiers.js";
import { TURNS } from "./src/requests.js";
import { WAYS, type Record_ } from "./src/run.js";

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

const CONFIG: TurnConfig = { router: HERMES_ROUTER, framing: "cost", orchestrate: true };
const PATH = resolve(import.meta.dirname, "records/combine.json");
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

check("the turns are distinct and each says why it is in the set", () => {
  eq(new Set(TURNS.map((t) => t.id)).size, TURNS.length, "two turns share an id: ");
  eq(new Set(TURNS.map((t) => t.text)).size, TURNS.length, "two turns are the same request: ");
  for (const t of TURNS) ok(t.why.length > 10, `${t.id} does not say why it is here`);
  ok(TURNS.length >= 6, `only ${TURNS.length} turns`);
});

check("no turn names a tier, a pattern or an answer", () => {
  // docs/36 §5's discipline: the request must not carry the answer. Here the
  // answer would be a model name or one of the eight pattern names.
  for (const t of TURNS) {
    const text = t.text.toLowerCase();
    for (const word of ["sonnet", "opus", "haiku", "fanout", "sequential", "supervisor", "agents", "underspecified"]) {
      ok(!text.includes(word), `${t.id} names "${word}"`);
    }
  }
});

check("both ways ask the same questions of the same turn", () => {
  // If they did not, the comparison would be between two different things and
  // every number in the report would be meaningless.
  const groups = keyGroups({ task: TURNS[0].text }, CONFIG);
  const combined = new Set(Object.keys(questionsFor({ task: TURNS[0].text }, CONFIG)));
  // The separate path calls each component's own `questionsFor`, so the union
  // of the owners' keys is exactly what it asks.
  const separate = new Set(Object.values(groups).flat());
  eq(combined.size, separate.size, "the two ways ask a different number of questions: ");
  for (const key of separate) ok(combined.has(key), `${key} is asked separately but not combined`);
  for (const key of combined) ok(separate.has(key), `${key} is asked combined but not separately`);
});

check("the combined state is a union, not a replacement", () => {
  // The risk the whole experiment exists for: a union that dropped one
  // component's state fields would be testing a mutilated version of it.
  const state = stateFor({ task: TURNS[0].text, cwd: "/srv/app" }, CONFIG);
  for (const key of ["request", "working_directory", "tiers_available", "price_ratio_cheapest_to_dearest"]) {
    ok(key in state, `the union lost ${key}`);
  }
  eq(state.request, TURNS[0].text);
});

// ------------------------------------------------------------ the record

check("the record, if present, is complete and balanced", () => {
  if (!existsSync(PATH)) return;
  const record = JSON.parse(readFileSync(PATH, "utf8")) as Record_;
  const repeats = new Set(record.draws.map((d) => d.repeat)).size;
  const turns = new Set(record.draws.map((d) => d.turn));
  ok(repeats >= 2, `${repeats} repeats is not enough to estimate the draw spread`);
  for (const turn of turns) {
    for (const way of WAYS) {
      const mine = record.draws.filter((d) => d.turn === turn && d.way === way);
      eq(mine.length, repeats, `${turn}/${way} has ${mine.length} draws against ${repeats} repeats: `);
    }
  }
  // An unbalanced record would make the two ways' means incomparable.
  for (const way of WAYS) {
    eq(record.draws.filter((d) => d.way === way).length, turns.size * repeats, `${way}: `);
  }
});

check("the record's answers cover every question both ways", () => {
  if (!existsSync(PATH)) return;
  const record = JSON.parse(readFileSync(PATH, "utf8")) as Record_;
  const expected = Object.keys(questionsFor({ task: TURNS[0].text }, CONFIG));
  for (const draw of record.draws) {
    if (draw.error) continue;
    for (const key of expected) {
      // The topology is a `choice`, so it lands in `topology` and
      // `topology__confidence` rather than as a bare number.
      if (key === "topology") {
        ok(draw.topology !== null, `${draw.turn}/${draw.way} recorded no topology`);
        continue;
      }
      ok(Number.isFinite(draw.answers[key]), `${draw.turn}/${draw.way} is missing ${key}`);
    }
  }
});

check("the recorded turns really do differ in their answers", () => {
  if (!existsSync(PATH)) return;
  const record = JSON.parse(readFileSync(PATH, "utf8")) as Record_;
  // docs/36 §5.2's trap, checked against the data rather than assumed from the
  // wording: there, `plain`'s across-task spread came in BELOW its draw noise
  // and no arm's accuracy meant anything. If these turns did not separate, the
  // whole report would be measuring one request eight times.
  const turns = [...new Set(record.draws.map((d) => d.turn))];
  for (const key of ["tier", "underspecified", "big_enough"]) {
    const per = turns.map((t) => mean(record.draws.filter((d) => d.turn === t).map((d) => d.answers[key]).filter(Number.isFinite)));
    const spread = Math.max(...per) - Math.min(...per);
    ok(spread > 0.3, `${key} spans only ${spread.toFixed(3)} across the turns; they do not separate`);
  }
});

check("the record stores raw answers, so it can be re-read at other cutoffs", () => {
  if (!existsSync(PATH)) return;
  const record = JSON.parse(readFileSync(PATH, "utf8")) as Record_;
  // docs/19 §4. A record of DECISIONS could not answer "would a cutoff at
  // 0.85 have changed this?", which is the question the report ended up
  // needing and the reason a number in jev-hermes moved.
  const draw = record.draws.find((d) => !d.error);
  ok(draw !== undefined, "the record has no usable draws");
  if (!draw) return;
  for (const key of Object.keys(draw.answers)) {
    const value = draw.answers[key];
    ok(value >= 0 && value <= 3, `${key} is ${value}, which is not a raw answer`);
  }
  // And the choice's whole distribution, not just its top label.
  const probabilities = Object.keys(draw.answers).filter((k) => k.startsWith("topology__p_"));
  eq(probabilities.length, 8, "the topology distribution was not recorded in full: ");
  ok(record.config.cuts !== undefined, "the record does not say which cuts produced it");
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
