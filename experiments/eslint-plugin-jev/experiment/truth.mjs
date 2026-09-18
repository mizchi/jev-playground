#!/usr/bin/env node
/**
 * Check the labels without spending a single Jev call.
 *
 *   node experiment/truth.mjs
 *
 * Three things, all of which would silently ruin the measurement:
 *
 * 1. Every extracted unit has a label and every label has a unit. A renamed
 *    function would otherwise quietly drop out of the scoring.
 * 2. Every `bug` probe FAILS on the corpus code, and every other probe
 *    PASSES. That is what makes a `bug` label a fact about the code rather
 *    than an opinion about it: the probe runs the function.
 * 3. Both classes are present, so an accuracy number means something.
 */
import { collectFiles } from "../src/warm.mjs";
import { CLASSES, LABELS, counts, labelKey, labelOf } from "./labels.mjs";

const units = await collectFiles(["experiment/corpus/*.js"]);
const seen = new Set(units.map(labelKey));
const problems = [];

for (const unit of units) {
  if (!labelOf(unit)) problems.push(`no label for ${labelKey(unit)}`);
}
for (const key of Object.keys(LABELS)) {
  if (!seen.has(key)) problems.push(`label ${key} matches no extracted function`);
}

const byClass = counts();
console.log(
  `${units.length} functions in ${new Set(units.map((u) => u.file)).size} files: ` +
    CLASSES.map((c) => `${byClass[c]} ${c}`).join(", "),
);
console.log("");

let probed = 0;
const reviewOnly = Object.fromEntries(CLASSES.map((c) => [c, 0]));
console.log("PROBES (a `bug` probe must FAIL on this code; everything else must PASS)");
for (const unit of units) {
  const entry = labelOf(unit);
  if (!entry) continue;
  if (!entry.probe) {
    reviewOnly[entry.label] += 1;
    continue;
  }
  probed += 1;
  let passed;
  try {
    passed = (await entry.probe()) === true;
  } catch (err) {
    passed = false;
    if (entry.label !== "bug") {
      problems.push(`${labelKey(unit)}: probe threw: ${String(err).slice(0, 120)}`);
    }
  }
  const wantPass = entry.label !== "bug";
  const ok = passed === wantPass;
  if (!ok) {
    problems.push(
      `${labelKey(unit)} is labelled ${entry.label} but its probe ${passed ? "passes" : "fails"}`,
    );
  }
  console.log(
    `  ${ok ? "ok  " : "BAD "} ${passed ? "pass" : "FAIL"}  ${labelKey(unit).padEnd(34)} ` +
      `${entry.label.padEnd(9)} ${entry.note.slice(0, 74)}`,
  );
}
const unprobed = Object.values(reviewOnly).reduce((a, b) => a + b, 0);
console.log(
  `  -> ${probed} labels proved by execution (every one of the ${byClass.bug} bugs), ` +
    `${unprobed} on review only`,
);
console.log(
  `     review-only: ` +
    CLASSES.filter((c) => reviewOnly[c] > 0)
      .map((c) => `${reviewOnly[c]} ${c}`)
      .join(", ") +
    ` -- `.concat("`clean` cannot be probed: you cannot execute the absence of a defect"),
);

console.log("");
const bugs = units.filter((u) => labelOf(u)?.label === "bug").length;
const ok = units.filter((u) => ["clean", "nearmiss"].includes(labelOf(u)?.label)).length;
console.log(`HEADLINE SET  ${bugs} bug vs ${ok} ok (clean+nearmiss)`);
console.log(
  `  always-"ok" baseline: ${((100 * ok) / (bugs + ok)).toFixed(1)}%  ` +
    `-- so read balanced accuracy and AUC, not accuracy`,
);
if (bugs === 0 || ok === 0) problems.push("one of the two classes is empty");

console.log("");
if (problems.length > 0) {
  for (const p of problems) console.log(`PROBLEM: ${p}`);
  console.log(`${problems.length} problem(s)`);
  process.exit(1);
}
console.log("labels check out");
