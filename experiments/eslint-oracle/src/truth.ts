/**
 * Print the ground truth without spending a single Jev call.
 *
 *   npx tsx src/truth.ts
 *
 * Worth having on its own: the near-miss snippets exist because a default
 * option decides them, and the only authority on which way a default goes is
 * the installed linter. This is how the numbers in the write-up were checked.
 */
import { CORPUS } from "./corpus.js";
import { groundTruth, assertDiscriminable } from "./lint.js";
import { RULE_IDS, RULE_SPECS, RULE_GROUPS } from "./rules.js";
import { ESLint } from "eslint";

const truth = await groundTruth();
assertDiscriminable(truth);

console.log(`ESLint ${ESLint.version}  ${RULE_IDS.length} rules  ${CORPUS.length} snippets`);
console.log("");
console.log("RULES (the description is all Jev gets)");
for (const spec of RULE_SPECS) {
  console.log(`  ${spec.id.padEnd(24)} [${RULE_GROUPS[spec.id]}] ${spec.description}`);
}

console.log("");
console.log("TARGETED PAIRS (snippet x its own rule)");
let pos = 0;
for (const s of CORPUS) {
  const v = truth.get(s.id)!;
  const fails = v.fails[s.target];
  if (fails) pos += 1;
  const msg = v.messages[s.target][0] ?? "";
  console.log(
    `  ${fails ? "FAIL" : "pass"}  ${s.id.padEnd(30)} ${s.kind.padEnd(9)} ${msg.slice(0, 70)}`,
  );
}
console.log(`  -> ${pos}/${CORPUS.length} targeted pairs are violations`);

console.log("");
console.log("FULL MATRIX");
const pairs = CORPUS.length * RULE_IDS.length;
let matrixPos = 0;
for (const s of CORPUS) {
  const v = truth.get(s.id)!;
  const hits = RULE_IDS.filter((id) => v.fails[id]);
  matrixPos += hits.length;
  if (hits.length > 1) console.log(`  ${s.id.padEnd(30)} trips ${hits.join(", ")}`);
}
console.log(`  ${matrixPos}/${pairs} pairs are violations ` +
  `(${((100 * matrixPos) / pairs).toFixed(1)}% positive)`);
const failingFiles = CORPUS.filter((s) => !truth.get(s.id)!.passes).length;
console.log(`  file level: ${failingFiles}/${CORPUS.length} files fail the rule set`);
