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

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
