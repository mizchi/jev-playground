/**
 * What has to hold before this comparison is believed.
 *
 *   npm test      # no API key, no CLI
 *
 * The checks that matter are the ones that would let an UNFAIR comparison
 * look like a fair one, and the first two are here because both went wrong:
 *
 *   the arms must be scored on the same field, and on the field the package
 *   says the host acts on -- scoring `verdict` counted jev's abstentions as
 *   five wrong answers and gave 79% instead of 96%;
 *   the arms must be shown the same words, or the report measures my
 *   prompt-writing (docs/04).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CORPUS as SHELL } from "../escalation/src/shell.js";
import { SCENARIOS } from "../orchestration/src/scenarios.js";
import type { Record_ } from "./src/run.js";
import { probeOf } from "./src/compaction.js";
import { cheapestSufficient, judgmentFromText, levelsFromText, type RouterRow } from "./src/routers.js";

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

const path = resolve(import.meta.dirname, "records/versus.json");
const rows = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record_).rows : [];

check("the corpora carry their own labels, not mine", () => {
  ok(SHELL.length >= 20, `only ${SHELL.length} shell commands`);
  for (const c of SHELL) ok(["allow", "confirm", "block"].includes(c.expect), `odd label ${c.expect}`);
  ok(SCENARIOS.length >= 30, `only ${SCENARIOS.length} scenarios`);
  // The orchestration label is the SKILL's own boolean over conditions the
  // scenario declares, so it cannot be my opinion about the scenario.
  for (const s of SCENARIOS) {
    for (const k of ["independent", "different", "three", "bigEnough"] as const) {
      eq(typeof s.conditions[k], "boolean", `${s.id}.${k} is not declared: `);
    }
  }
});

check("both label classes are present, so neither task is answerable by a constant", () => {
  const verdicts = new Set(SHELL.map((c) => c.expect));
  eq(verdicts.size, 3, "the shell corpus is missing a verdict class: ");
  const splits = SCENARIOS.filter((s) => (s.conditions.independent || s.conditions.different) && s.conditions.bigEnough);
  ok(splits.length > 5 && splits.length < SCENARIOS.length - 5, `${splits.length} of ${SCENARIOS.length} are 'split'`);
});

check("every arm answered every item it has a row for, with a comparable label", () => {
  if (rows.length === 0) return;
  for (const r of rows) {
    ok(
      ["allow", "confirm", "block", "single", "split"].includes(r.answer),
      `${r.arm}/${r.item}: ${JSON.stringify(r.answer)} is not a label the corpus uses`,
    );
    eq(r.correct, r.answer === r.expect, `${r.arm}/${r.item}: 'correct' disagrees with the labels: `);
  }
});

check("the arms are compared on the same items, not on different subsets", () => {
  if (rows.length === 0) return;
  for (const task of ["guard", "orchestration"] as const) {
    const per = new Map<string, Set<string>>();
    for (const r of rows.filter((x) => x.task === task)) {
      if (!per.has(r.arm)) per.set(r.arm, new Set());
      per.get(r.arm)?.add(r.item);
    }
    const sets = [...per.entries()];
    if (sets.length < 2) continue;
    for (const [arm, items] of sets.slice(1)) {
      eq(
        [...items].sort().join("|"),
        [...sets[0][1]].sort().join("|"),
        `${task}: ${arm} and ${sets[0][0]} answered different items: `,
      );
    }
  }
});

check("jev's abstentions are recorded rather than silently scored", () => {
  // The bug this guards: an abstention counted as a wrong answer, which is
  // what produced 79% instead of 96%. The row has to say which it was.
  const guard = rows.filter((r) => r.task === "guard" && r.arm === "jev");
  if (guard.length === 0) return;
  for (const r of guard) {
    eq(typeof r.abstained, "boolean", `${r.item}: abstained was not recorded: `);
  }
  // And an abstention must resolve to a label, not to a hole.
  for (const r of guard.filter((x) => x.abstained)) {
    ok(["allow", "confirm", "block"].includes(r.answer), `${r.item}: an abstention left no action`);
  }
});

// ------------------------------------------------- the routers (docs/06 n)

check("probeOf classifies each fact shape, and an existence fact is not checkable", () => {
  // The three outcomes, because both scoring bugs on `flag-registry` were a
  // fact landing in the wrong one. A (thing, value) fact splits; an existence
  // fact reports no value; a fact with no anchor reports nothing at all.
  const value = probeOf("661 docs/31-orchestration.md");
  ok(value !== null && value.value === "661", "a value/identifier fact must split");
  eq(value?.probe, "docs/31-orchestration.md", "the identifier must be the SPECIFIC token: ");

  const exists = probeOf('registerFlag("jev-advise"');
  ok(exists !== null, "an existence fact must still yield an identifier");
  eq(exists?.value, null, "an existence fact has no value to invent: ");
  // THE BUG THIS PINS: the probe must be the flag name, never `registerFlag`.
  // A probe both facts share put a correct summary's window 400 chars away
  // from the value and scored it INVENTED.
  eq(exists?.probe, "jev-advise", "the probe must identify THIS fact, not the API: ");
  ok(probeOf('registerFlag("jev-framing"')?.probe !== exists?.probe, "two facts must not share a probe");
});

check("a correct summary of the flag transcript scores kept, not invented", () => {
  // The literal text haiku produced, which the first two scorers both got
  // wrong in opposite directions: once INVENTED, once ABSENT. It is correct.
  const summary =
    '**jev-orchestrator registers exactly 2 flags:**\n\n1. `"jev-advise"`\n   - default: "tool"\n' +
    '\n2. `"jev-framing"`\n   - default: "cost"\n\nBoth set via `pi.registerFlag()` in pi.ts.';
  for (const flag of ["jev-advise", "jev-framing"]) {
    const split = probeOf(`registerFlag("${flag}"`);
    ok(split !== null && split.value === null, `${flag}: must be an existence fact`);
    ok(summary.includes(split?.probe as string), `${flag}: a correct summary must score KEPT`);
  }
});

check("the model router's three answers parse into the shipped Judgment shape", () => {
  const j = judgmentFromText("tier: sonnet\nunderspecified: no\noversized: no");
  ok(j !== null, "three clean lines must parse");
  eq(j?.tier, 1, "sonnet is rung 1: ");
  eq(j?.underspecified, 0, "a `no` must be 0, so escalateAt cannot fire: ");
  // A yes must land ABOVE escalateAt, or the escape hatch that fires for jev
  // silently never fires for the model and the arms are not comparable.
  const esc = judgmentFromText("tier: haiku\nunderspecified: yes\noversized: no");
  ok((esc?.underspecified ?? 0) > 0.7, "a `yes` must clear escalateAt (0.7)");
  eq(judgmentFromText("I have no idea what you mean"), null, "unparseable must be null, not a guess: ");
});

check("the skill router's fan-out parse is exact about names and levels", () => {
  const names = ["cloudflare-deploy", "node-sqlite-vec", "moonbit-build"];
  const got = levelsFromText(
    "cloudflare-deploy: want\n- node-sqlite-vec: no\n3. moonbit-build: on_request\nnot-a-skill: want",
    names,
  );
  eq(got.size, 3, "every listed skill must parse and nothing else may: ");
  eq(got.get("cloudflare-deploy"), 3, "`want` is the top level: ");
  eq(got.get("node-sqlite-vec"), 0, "`no` is the bottom level: ");
  eq(got.get("moonbit-build"), 2, "`on_request` is level 2: ");
  ok(!got.has("not-a-skill"), "a name that is not a candidate must not be invented");
});

check("an unrated skill cannot load, and is not read as a `no`", () => {
  // The failure this prevents: treating a missing line as level 0 would make a
  // model that answered about 40 of 74 skills look decisive rather than
  // partial. NaN is neither over nor under the cutoff.
  const levels = levelsFromText("", ["a", "b"]);
  eq(levels.size, 0, "nothing was rated: ");
  // `eq` uses !==, and NaN !== NaN, so this has to be asserted directly.
  ok(levels.get("a") === undefined, "an unrated skill must not default to a level");
  // And the shipped cutoff must reject it: `NaN >= loadAt` is false, which is
  // what keeps an unanswered skill out of the load set.
  ok(!(Number.NaN >= 2.5), "NaN must not clear loadAt");
});

check("the routers record, if present, compares the arms on the same items", () => {
  const rp = resolve(import.meta.dirname, "records/routers.json");
  if (!existsSync(rp)) return;
  const rows = (JSON.parse(readFileSync(rp, "utf8")) as { rows: RouterRow[] }).rows;
  for (const which of ["model", "skill"] as const) {
    const mine = rows.filter((r) => r.which === which);
    if (mine.length === 0) continue;
    const arms = [...new Set(mine.map((r) => r.arm))];
    const items = (a: string): string[] => mine.filter((r) => r.arm === a).map((r) => r.item).sort();
    // An arm still in flight legitimately has fewer items. What must never
    // happen is two arms with the same COUNT over different items.
    for (const a of arms) {
      for (const b of arms) {
        if (items(a).length !== items(b).length) continue;
        eq(items(a).join(","), items(b).join(","), `${which}: ${a} and ${b} cover different items: `);
      }
    }
  }
});

check("the model router's label is recorded as the corpus measured it", () => {
  // The whole §1 rests on this: `want` must come from a real exit code, not
  // from anything in this experiment. So it must match labels.json exactly.
  const rp = resolve(import.meta.dirname, "records/routers.json");
  if (!existsSync(rp)) return;
  const rows = (JSON.parse(readFileSync(rp, "utf8")) as { rows: RouterRow[] }).rows.filter((r) => r.which === "model");
  if (rows.length === 0) return;
  const want = cheapestSufficient();
  for (const r of rows) {
    eq(r.want, want.get(r.item)?.tier, `${r.item}: the label drifted from labels.json: `);
  }
  // And the finding that shapes the whole section: the label is near-constant.
  const cheap = [...want.values()].filter((v) => v.rung === 0).length;
  ok(cheap / want.size > 0.9, `the corpus is meant to be lopsided; got ${cheap}/${want.size} at the cheapest rung`);
});


console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
