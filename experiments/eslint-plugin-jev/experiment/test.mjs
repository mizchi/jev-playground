#!/usr/bin/env node
/**
 * Everything that can be tested without an API key.
 *
 *   node experiment/test.mjs                 # both suites
 *   node experiment/test.mjs --failsafe      # only the failure paths
 *   node experiment/test.mjs --unit          # only the logic
 *
 * The fail-safe suite is the one that matters. docs/18 settled the posture
 * for a judgment layer inside somebody's tooling, and it applies verbatim to
 * a lint rule: every failure path must end in NO FINDING, and none of them
 * may take the lint run down. A rule that throws breaks an editor for every
 * file; a rule that invents a finding because it could not read its cache is
 * worse than a rule that says nothing.
 */
import { ESLint, Linter } from "eslint";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../src/index.mjs";
import { resetCacheMemo } from "../src/cache.mjs";
import { collectUnits } from "../src/functions.mjs";
import {
  DEFAULT_THRESHOLDS,
  MAX_REQUEST_TOKENS,
  SCHEMA,
  decide,
  estimateTokens,
  keyOf,
  questionsFor,
  stateFor,
} from "../src/judge.mjs";
import { planBatches } from "../src/warm.mjs";

const only = process.argv.includes("--failsafe")
  ? "failsafe"
  : process.argv.includes("--unit")
    ? "unit"
    : "both";

let passed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "jev-quality-"));

/** Lint one snippet with one set of rule options, and never let it throw. */
async function lint(code, options, { filename = "sample.js" } = {}) {
  resetCacheMemo();
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: {
      files: ["**/*.js"],
      languageOptions: { ecmaVersion: "latest", sourceType: "module" },
      plugins: { jev: plugin },
      rules: { "jev/quality": ["warn", options] },
    },
  });
  try {
    const results = await eslint.lintText(code, { filePath: filename });
    return { threw: null, messages: results[0]?.messages ?? [] };
  } catch (err) {
    return { threw: err, messages: [] };
  }
}

const SUBJECT = `export function applyDiscount(price, percentOff) {
  if (percentOff <= 0) return price;
  return price - percentOff;
}
`;

/**
 * ESLint's own SourceCode for a snippet, so the units under test are the ones
 * the rule would see. A second extractor here would let a cache-key bug pass.
 */
function sourceCodeOf(code) {
  let captured = null;
  new Linter().verify(
    code,
    {
      plugins: {
        probe: {
          rules: {
            grab: {
              create: (context) => ({
                "Program:exit"() {
                  captured = context.sourceCode;
                },
              }),
            },
          },
        },
      },
      languageOptions: { ecmaVersion: "latest", sourceType: "module" },
      rules: { "probe/grab": "error" },
    },
    { filename: "sample.js" },
  );
  return captured;
}

// ------------------------------------------------------------------ failsafe

if (only !== "unit") {
  console.log("");
  console.log("FAIL-SAFE  (every one of these must end in NO FINDING and must not throw)");

  const cases = [
    ["no cache file at all", { cache: join(tmp, "absent.json") }],
    [
      "cache is not JSON",
      {
        cache: (() => {
          const p = join(tmp, "garbage.json");
          writeFileSync(p, "{not json at all");
          return p;
        })(),
      },
    ],
    [
      "cache is JSON but not ours",
      {
        cache: (() => {
          const p = join(tmp, "alien.json");
          writeFileSync(p, JSON.stringify({ hello: "world" }));
          return p;
        })(),
      },
    ],
    [
      "cache written by an older schema",
      {
        cache: (() => {
          const p = join(tmp, "old.json");
          writeFileSync(
            p,
            JSON.stringify({ schema: "jev-quality-0", entries: { deadbeef: { score: 3, confidence: 1 } } }),
          );
          return p;
        })(),
      },
    ],
    [
      "entry has no score (must not default to 0 or to 3)",
      {
        cache: (() => {
          const p = join(tmp, "partial.json");
          const key = keyOf({ text: SUBJECT.trim().replace(/^export /, "") });
          writeFileSync(
            p,
            JSON.stringify({ schema: SCHEMA, entries: { [key]: { confidence: 0.9, bug: 0.99 } } }),
          );
          return p;
        })(),
      },
    ],
    ["cache path is a directory", { cache: tmp }],
  ];

  for (const [name, options] of cases) {
    const { threw, messages } = await lint(SUBJECT, { ...options, onMiss: "silent" });
    check(name, threw === null && messages.length === 0, threw ? `threw ${threw.message}` : `${messages.length} finding(s)`);
  }

  // The blocking arm: the child must fail into silence, not into a verdict.
  const noKey = process.env.TYPESAFEAI_API_KEY;
  const baseUrl = process.env.TYPESAFEAI_BASE_URL;
  delete process.env.TYPESAFEAI_API_KEY;
  {
    const { threw, messages } = await lint(SUBJECT, {
      cache: join(tmp, "ask-nokey.json"),
      onMiss: "ask",
      timeout: 10_000,
    });
    check(
      'onMiss "ask" with no API key',
      threw === null && messages.length === 0,
      threw ? `threw ${threw.message}` : `${messages.length} finding(s)`,
    );
  }
  if (noKey !== undefined) process.env.TYPESAFEAI_API_KEY = noKey;
  // Unroutable base URL: exercises the network-failure path without spending.
  process.env.TYPESAFEAI_BASE_URL = "http://127.0.0.1:1";
  {
    const { threw, messages } = await lint(SUBJECT, {
      cache: join(tmp, "ask-refused.json"),
      onMiss: "ask",
      timeout: 15_000,
    });
    check(
      'onMiss "ask" when the API is unreachable',
      threw === null && messages.length === 0,
      threw ? `threw ${threw.message}` : `${messages.length} finding(s)`,
    );
  }
  {
    const { threw, messages } = await lint(SUBJECT, {
      cache: join(tmp, "ask-timeout.json"),
      onMiss: "ask",
      timeout: 100,
    });
    check(
      'onMiss "ask" killed by its own timeout',
      threw === null && messages.length === 0,
      threw ? `threw ${threw.message}` : `${messages.length} finding(s)`,
    );
  }
  if (baseUrl === undefined) delete process.env.TYPESAFEAI_BASE_URL;
  else process.env.TYPESAFEAI_BASE_URL = baseUrl;

  // `onMiss: "report"` is the ONE case that is allowed to speak on a miss,
  // and it must say "no verdict" rather than pretend to have one.
  {
    const { threw, messages } = await lint(SUBJECT, {
      cache: join(tmp, "absent2.json"),
      onMiss: "report",
    });
    check(
      'onMiss "report" says missing, not a verdict',
      threw === null && messages.length === 1 && messages[0].messageId === "missing",
      threw ? `threw ${threw.message}` : JSON.stringify(messages.map((m) => m.messageId)),
    );
  }

  // A file with no functions long enough to judge must be free.
  {
    const { threw, messages } = await lint("export const x = 1;\nexport const f = (a) => a;\n", {
      cache: join(tmp, "absent3.json"),
      onMiss: "report",
    });
    check(
      "a file with nothing to judge reports nothing",
      threw === null && messages.length === 0,
      threw ? `threw ${threw.message}` : `${messages.length} finding(s)`,
    );
  }

  // And a cached verdict really does come back out, so the suite above is not
  // passing because the rule is inert.
  {
    const p = join(tmp, "hit.json");
    // The key comes from the unit the RULE would extract, not from a
    // hand-built string: that is the one way to be sure the warm pass and the
    // rule agree, and it is the bug this check exists to catch.
    const [unit] = collectUnits(sourceCodeOf(SUBJECT), "sample.js");
    writeFileSync(
      p,
      JSON.stringify({
        schema: SCHEMA,
        entries: { [keyOf(unit)]: { score: 2.4, confidence: 0.8, bug: 0.9 } },
      }),
    );
    const { threw, messages } = await lint(SUBJECT, { cache: p, onMiss: "silent" });
    check(
      "a cached verdict does produce a finding (the suite is not inert)",
      threw === null && messages.length === 1 && messages[0].messageId === "bug",
      threw ? `threw ${threw.message}` : JSON.stringify(messages.map((m) => m.messageId)),
    );
  }
}

// ---------------------------------------------------------------------- unit

if (only !== "failsafe") {
  console.log("");
  console.log("THE GATE  (docs/21 retuned these numbers; the table is what it settled on)");
  const t = DEFAULT_THRESHOLDS;
  const table = [
    // score, confidence, bug, expected
    [0.0, 0.9, 0.1, null],
    [1.49, 0.9, 0.1, null],
    [1.5, 0.9, 0.1, "quality"],
    [2.9, 0.9, 0.1, "quality"],
    // Under-confident is still reported -- as a question. This row is the
    // whole point of the retune: it used to be `null`.
    [1.5, 0.49, 0.1, "unsure"],
    [2.4, 0.1, 0.1, "unsure"],
    // The atomic noul outranks both, because "this is wrong" is not a
    // weaker version of "a reviewer would comment".
    [0.0, 0.1, 0.7, "bug"],
    [0.0, 0.9, 0.69, null],
    [1.6, 0.2, 0.95, "bug"],
    // A verdict with no noul at all (an answer that came back malformed)
    // must still work off the score alone.
    [1.8, 0.8, null, "quality"],
  ];
  for (const [score, confidence, bug, expected] of table) {
    const got = decide({ score, confidence, bug }, t)?.messageId ?? null;
    check(
      `score ${score.toFixed(2)} conf ${confidence.toFixed(2)} bug ${bug === null ? "n/a" : bug.toFixed(2)} -> ${expected ?? "silent"}`,
      got === expected,
      `got ${got ?? "silent"}`,
    );
  }
  check("a null verdict is silent", decide(null, t) === null);

  console.log("");
  console.log("THE UNIT OF JUDGMENT");
  const source = `
export function outer(a) {
  const inner = function (b) {
    return b * 2;
  };
  return inner(a);
}
const arrow = (x) => {
  const y = x + 1;
  return y;
};
items.map((v) => {
  return v.id;
});
export class Cart {
  total() {
    let n = 0;
    return n;
  }
  static of(xs) {
    return new Cart(xs);
  }
}
const tiny = (a) => a;
`;
  const sourceCode = sourceCodeOf(source);
  const units = collectUnits(sourceCode, "s.js");
  const names = units.map((u) => u.name);
  check(
    "outermost functions only (the nested function expression is not its own unit)",
    !names.includes("inner"),
    names.join(", "),
  );
  check("a named declaration is found", names.includes("outer"), names.join(", "));
  check("a variable-assigned arrow is found", names.includes("arrow"), names.join(", "));
  check(
    "class methods are named Class#method",
    names.includes("Cart#total") && names.includes("static Cart#of"),
    names.join(", "),
  );
  check(
    "an inline callback is skipped by default",
    !names.some((n) => n.startsWith("<anonymous>")),
    names.join(", "),
  );
  check(
    "a one-line arrow is under minLines",
    !names.includes("tiny"),
    names.join(", "),
  );
  check(
    "includeCallbacks brings the callback back",
    collectUnits(sourceCode, "s.js", { includeCallbacks: true }).length > units.length,
  );

  console.log("");
  console.log("CACHE KEY");
  check(
    "same text, same key",
    keyOf({ text: "function a() { return 1; }" }) === keyOf({ text: "function a() { return 1; }" }),
  );
  check(
    "one character changes the key",
    keyOf({ text: "function a() { return 1; }" }) !== keyOf({ text: "function a() { return 2; }" }),
  );
  check(
    "the key is 20 hex characters",
    /^[0-9a-f]{20}$/.test(keyOf({ text: "function a() {}" })),
  );

  console.log("");
  console.log("BATCHING");
  const many = Array.from({ length: 400 }, (_, i) => ({
    file: "big.js",
    fileSource: "// tiny\n",
    name: `f${i}`,
    line: i + 1,
    endLine: i + 3,
    text: `function f${i}(a) {\n  return a + ${i};\n}`,
  }));
  const cost = (batch) =>
    estimateTokens(stateFor(batch.file, batch.source, batch.units, batch.arm)) +
    estimateTokens(questionsFor(batch.units, batch.arm));

  // Well past 256: the point is that the question COUNT is not the limit.
  // docs/21 measured 1220 questions in one request. What bounds a batch here
  // is the 64Ki token ceiling and this rubric's measured 283 tokens per
  // function (two questions, and every score question repeats the four level
  // descriptions) -- about 230 functions really, ~170 after the estimate's
  // 1.34x safety margin. Either way, nowhere near 256 being a rule.
  const oneFile = planBatches(many.slice(0, 150), "located");
  check(
    "150 functions of one file go in ONE request (no 256-question limit)",
    oneFile.length === 1,
    `${oneFile.length} batch(es)`,
  );
  const batched = planBatches(many, "located");
  check(
    "400 functions split rather than being sent over the ceiling",
    batched.length > 1,
    `${batched.length} batch(es)`,
  );
  check(
    "every planned batch fits under the ceiling",
    batched.every((b) => cost(b) <= MAX_REQUEST_TOKENS),
    batched.map(cost).join(", "),
  );
  check(
    "no batch is empty, and every function lands in exactly one",
    batched.every((b) => b.units.length > 0) &&
      batched.reduce((n, b) => n + b.units.length, 0) === many.length,
  );
  const huge = Array.from({ length: 2 }, (_, i) => ({
    file: "huge.js",
    fileSource: "x".repeat(200_000),
    name: `g${i}`,
    line: 1,
    endLine: 4,
    text: `function g${i}() {\n  return ${i};\n}`,
  }));
  const split = planBatches(huge, "located");
  check(
    "a file too big for the state ceiling falls back to per-function requests",
    split.length === 2 && split.every((b) => b.arm === "isolated" && b.oversize),
    JSON.stringify(split.map((b) => b.arm)),
  );
  check(
    "solo keeps the file in the state; isolated does not",
    planBatches(many.slice(0, 2), "solo")[0].source === "// tiny\n" &&
      planBatches(many.slice(0, 2), "isolated")[0].source.startsWith("function f0"),
  );
  check(
    "the token estimate over-counts real code (the safe direction)",
    estimateTokens("export function step(a, b) { return a + b; }\n".repeat(2300)) > 32_530,
  );
}

console.log("");
if (failures.length > 0) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`${passed} passed`);
