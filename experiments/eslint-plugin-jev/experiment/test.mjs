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
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../src/index.mjs";
import { resetCacheMemo } from "../src/cache.mjs";
import { collectUnits } from "../src/functions.mjs";
import {
  ATOM_NAMES,
  DEFAULT_THRESHOLDS,
  MAX_REQUEST_TOKENS,
  RUBRICS,
  SCHEMA,
  atomKey,
  bugKey,
  decide,
  estimateTokens,
  firedAtom,
  keyOf,
  questionsFor,
  scoreKey,
  stateFor,
  verdictFrom,
  withThresholds,
} from "../src/judge.mjs";
import { parseArgs, planBatches } from "../src/warm.mjs";
import {
  DEFAULT_RULE_THRESHOLDS,
  INLINE_LIMIT,
  RULE_LEVELS,
  decideRule,
  normalizeRules,
  planRuleBatches,
  questionsForRules,
  ruleKey,
  ruleMatchKey,
  ruleTextHash,
  stateForRules,
  verdictForRule,
} from "../src/rules.mjs";

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

/**
 * A stand-in for the API that records every Authorization header and answers
 * 500, so a blocking child reaches the wire and still fails into silence.
 *
 * It runs in its own process: the rule under test blocks this one on
 * `execFileSync`, so a server on this event loop would never answer.
 */
async function captureAuthServer() {
  const log = join(tmp, `auth-${Math.random().toString(36).slice(2)}.log`);
  const script = `
    const { createServer } = require("node:http");
    const { appendFileSync } = require("node:fs");
    createServer((req, res) => {
      appendFileSync(process.argv[1], (req.headers.authorization ?? "") + "\\n");
      res.statusCode = 500;
      res.end("{}");
    }).listen(0, "127.0.0.1", function () { process.stdout.write(String(this.address().port) + "\\n"); });
  `;
  const child = spawn(process.execPath, ["-e", script, log], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => {
    child.stdout.once("data", (d) => resolve(Number.parseInt(String(d), 10)));
  });
  const savedKey = process.env.TYPESAFEAI_API_KEY;
  const savedUrl = process.env.TYPESAFEAI_BASE_URL;
  delete process.env.TYPESAFEAI_API_KEY;
  process.env.TYPESAFEAI_BASE_URL = `http://127.0.0.1:${port}`;
  return {
    seen() {
      return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    },
    async close() {
      if (savedKey !== undefined) process.env.TYPESAFEAI_API_KEY = savedKey;
      if (savedUrl === undefined) delete process.env.TYPESAFEAI_BASE_URL;
      else process.env.TYPESAFEAI_BASE_URL = savedUrl;
      child.kill();
    },
  };
}

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

  // The `apiKey` option must reach the child process and the wire, without
  // any environment variable: a config-supplied key is how CI without a
  // shell environment (or a monorepo with several keys) uses `onMiss: "ask"`.
  {
    const api = await captureAuthServer();
    try {
      const { threw, messages } = await lint(SUBJECT, {
        cache: join(tmp, "ask-apikey-quality.json"),
        onMiss: "ask",
        apiKey: "from-the-option",
        timeout: 15_000,
      });
      check(
        "`apiKey` option reaches the wire for jev/quality with no env var",
        threw === null && messages.length === 0 && api.seen().includes("Bearer from-the-option"),
        threw ? `threw ${threw.message}` : `saw ${JSON.stringify(api.seen())}`,
      );
    } finally {
      await api.close();
    }
  }

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
  console.log("THE WARM PASS  (flags the rule and the pass must agree on, plus the key)");
  check("`--api-key` is parsed", parseArgs(["--api-key", "k-1"]).apiKey === "k-1");
  check("`--api-key` defaults to undefined", parseArgs([]).apiKey === undefined);

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
  console.log("NAMED CRITERIA  (docs/22: the eight criteria and their per-criterion cutoffs)");
  check(
    "every criterion has a cutoff, and every cutoff names a criterion",
    ATOM_NAMES.every((n) => typeof t.criterionAt[n] === "number") &&
      Object.keys(t.criterionAt).every((n) => ATOM_NAMES.includes(n)),
    `${ATOM_NAMES.length} criteria, ${Object.keys(t.criterionAt).length} cutoffs`,
  );
  // Read the cutoffs from the map rather than hardcoding them: docs/22's
  // addendum retuned four of them, and a test that pins the number fails on
  // the retune instead of checking the behaviour.
  const cutOf = (name) => t.criterionAt[name];
  const lowest = ATOM_NAMES.reduce((a, b) => (cutOf(a) <= cutOf(b) ? a : b));
  const highest = ATOM_NAMES.reduce((a, b) => (cutOf(a) >= cutOf(b) ? a : b));
  const atomTable = [
    // [atoms, expected messageId, why]
    [{ [lowest]: cutOf(lowest) + 0.01 }, "criterion", `just over ${lowest}'s cutoff`],
    [{ [lowest]: cutOf(lowest) - 0.01 }, null, "just under it"],
    // The whole point of a per-criterion cutoff: one probability fires for the
    // lowest-cutoff criterion and is silence for the highest, and a single
    // global number cannot do that.
    [
      { [lowest]: (cutOf(lowest) + cutOf(highest)) / 2 },
      "criterion",
      `the midpoint is over ${lowest}'s cutoff`,
    ],
    [
      { [highest]: (cutOf(lowest) + cutOf(highest)) / 2 },
      null,
      `the same number is under ${highest}'s`,
    ],
    [{ mystery_criterion: 0.85 }, "criterion", "an unknown name falls back to atomAt"],
    [{ mystery_criterion: 0.75 }, null, "and is silent under it"],
  ];
  for (const [atoms, expected, why] of atomTable) {
    const got = decide({ score: null, confidence: null, bug: 0.1, atoms }, t)?.messageId ?? null;
    check(`${why} -> ${expected ?? "silent"}`, got === expected, `got ${got ?? "silent"}`);
  }
  {
    // `lowest` at twice its cutoff beats `highest` barely over its own, even
    // though the raw number is smaller.
    const atoms = { [lowest]: cutOf(lowest) * 2, [highest]: cutOf(highest) + 0.01 };
    check(
      "the criterion with the biggest margin over its own cutoff wins, not the biggest number",
      firedAtom({ atoms }, t)?.name === lowest,
      `${JSON.stringify(atoms)} -> ${JSON.stringify(firedAtom({ atoms }, t))}`,
    );
  }
  check(
    "a named criterion outranks the score and the generic noul",
    decide({ score: 2.9, confidence: 0.9, bug: 0.95, atoms: { boundary: 0.6 } }, t)?.messageId ===
      "criterion",
  );
  check(
    "an atoms-only verdict still decides (that rubric has no score)",
    decide({ score: null, confidence: null, bug: null, atoms: { boundary: 0.9 } }, t)
      ?.messageId === "criterion",
  );
  check(
    "a verdict with neither a score nor a criterion is silent",
    decide({ score: null, confidence: null, bug: null, atoms: null }, t) === null,
  );
  // docs/22's addendum raised four cutoffs off the false-positive boundary.
  // The regression this guards is putting one back on it.
  check(
    "no cutoff sits below 0.25 (docs/22's addendum raised the boundary-hugging four)",
    Object.values(t.criterionAt).every((c) => c >= 0.25),
    JSON.stringify(t.criterionAt),
  );
  {
    // Overriding ONE cutoff must not drop the other seven onto `atomAt`. A
    // shallow spread did exactly that, and the damage is invisible: muting the
    // noisy criterion quietly stops seven others reporting.
    const muted = withThresholds({ criterionAt: { unescaped_composition: 1.01 } });
    check(
      "overriding one cutoff keeps the other seven",
      ATOM_NAMES.every((n) => muted.criterionAt[n] === (n === "unescaped_composition" ? 1.01 : t.criterionAt[n])),
      JSON.stringify(muted.criterionAt),
    );
    const other = ATOM_NAMES.find((n) => n !== "unescaped_composition");
    check(
      "a criterion left alone still fires just over its own cutoff",
      decide(
        { score: null, confidence: null, bug: 0.1, atoms: { [other]: cutOf(other) + 0.01 } },
        { criterionAt: { unescaped_composition: 1.01 } },
      )?.messageId === "criterion",
      `${other} at ${(cutOf(other) + 0.01).toFixed(2)}`,
    );
    check(
      "and the muted one cannot fire at any probability",
      firedAtom({ atoms: { unescaped_composition: 1 } }, muted) === null,
    );
  }

  console.log("");
  console.log("RUBRICS");
  const oneUnit = [
    { name: "f", line: 1, endLine: 4, text: "function f(a) {\n  return a;\n}" },
  ];
  const counts = Object.fromEntries(
    RUBRICS.map((r) => [r, Object.keys(questionsFor(oneUnit, "located", r)).length]),
  );
  check(
    "question count per function: vague 2, checklist 2, atoms 8, full 10",
    counts.vague === 2 && counts.checklist === 2 && counts.atoms === 8 && counts.full === 10,
    JSON.stringify(counts),
  );
  check(
    "the checklist rubric puts the criteria in the score question, not in new questions",
    JSON.stringify(questionsFor(oneUnit, "located", "checklist")).includes("api_default") &&
      !JSON.stringify(questionsFor(oneUnit, "located", "vague")).includes("api_default"),
  );
  check(
    "omit drops a criterion from the REQUEST and shifts no index",
    (() => {
      const full = Object.keys(questionsFor(oneUnit, "located", "full"));
      const less = Object.keys(questionsFor(oneUnit, "located", "full", [ATOM_NAMES[0]]));
      const gone = full.filter((k) => !less.includes(k));
      // a0-000 is the first criterion; a1..a7 must keep their own numbers, or
      // verdictFrom would read the answers back under the wrong names.
      return (
        gone.length === 1 &&
        gone[0] === "a0-000" &&
        less.filter((k) => /^a\d-/.test(k)).join(",") ===
          "a1-000,a2-000,a3-000,a4-000,a5-000,a6-000,a7-000"
      );
    })(),
  );
  check(
    "criterion NAMES never cross the wire as question keys",
    Object.keys(questionsFor(oneUnit, "located", "full")).every(
      (k) => !ATOM_NAMES.some((n) => k.includes(n)),
    ),
    Object.keys(questionsFor(oneUnit, "located", "full")).join(","),
  );
  check(
    "the rubric is part of the cache key, so two rubrics can share one cache",
    keyOf(oneUnit[0], "vague") !== keyOf(oneUnit[0], "full"),
  );
  const answers = {
    [scoreKey(0)]: { type: "score", score: 2, confidence: 0.8 },
    [bugKey(0)]: { type: "noul", noul: 0.4 },
    [atomKey(0, 0)]: { type: "noul", noul: 0.33 },
  };
  check(
    "verdictFrom reads the atoms back under the right names",
    verdictFrom(answers, 0, "full")?.atoms?.[ATOM_NAMES[0]] === 0.33,
    JSON.stringify(verdictFrom(answers, 0, "full")),
  );
  check(
    "and ignores them when the rubric did not ask for them",
    verdictFrom(answers, 0, "vague")?.atoms === null,
  );

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

// ------------------------------------------------------- ad-hoc rules (jev/rule)

/** Lint one snippet with `jev/rule`, and never let it throw. */
async function lintRule(code, options, { filename = "sample.js" } = {}) {
  resetCacheMemo();
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: {
      files: ["**/*.js"],
      languageOptions: { ecmaVersion: "latest", sourceType: "module" },
      plugins: { jev: plugin },
      rules: { "jev/rule": ["warn", options] },
    },
  });
  try {
    const results = await eslint.lintText(code, { filePath: filename });
    return { threw: null, messages: results[0]?.messages ?? [] };
  } catch (err) {
    return { threw: err, messages: [] };
  }
}

const SORTED = `export function median(xs) {
  const s = xs.slice().sort();
  return s[Math.floor(s.length / 2)];
}
`;

const SORT_RULE = {
  id: "sort-comparator",
  selector: "CallExpression[callee.property.name='sort']",
  rule: "数値の配列を sort するときは比較関数を渡すこと。",
};

/** A cache file holding one ad-hoc verdict for the `.sort()` call above. */
function ruleCacheWith(verdict, rule = SORT_RULE, nodeText = "xs.slice().sort()") {
  const p = join(tmp, `rule-${Math.random().toString(36).slice(2)}.json`);
  const { rules: normal } = normalizeRules([rule]);
  writeFileSync(
    p,
    JSON.stringify({
      schema: SCHEMA,
      entries: { [ruleMatchKey(normal[0], nodeText)]: { kind: "rule", ...verdict } },
    }),
  );
  return p;
}

if (only !== "unit") {
  console.log("");
  console.log("AD-HOC FAIL-SAFE  (a sentence-shaped rule must fail into silence too)");

  const adHocCases = [
    ["no `rules` option at all", {}],
    ["an empty rules array", { rules: [] }],
    ["a selector that matches nothing", { rules: [{ selector: "WithStatement", rule: "x" }] }],
    ["a cold cache", { rules: [SORT_RULE], cache: join(tmp, "absent-rules.json") }],
    [
      "an entry with no score (must not default)",
      { rules: [SORT_RULE], cache: ruleCacheWith({ confidence: 0.99 }) },
    ],
    [
      "an entry for a DIFFERENT draft of the sentence",
      {
        rules: [SORT_RULE],
        cache: ruleCacheWith({ score: 3, confidence: 1 }, { ...SORT_RULE, rule: "別の文" }),
      },
    ],
    ["cache path is a directory", { rules: [SORT_RULE], cache: tmp }],
  ];
  for (const [name, options] of adHocCases) {
    const { threw, messages } = await lintRule(SORTED, { ...options, onMiss: "silent" });
    check(
      name,
      threw === null && messages.length === 0,
      threw ? `threw ${threw.message}` : `${messages.length} finding(s)`,
    );
  }

  {
    const api = await captureAuthServer();
    try {
      const { threw, messages } = await lintRule(SORTED, {
        rules: [SORT_RULE],
        cache: join(tmp, "ask-apikey-rule.json"),
        onMiss: "ask",
        apiKey: "from-the-option",
        timeout: 15_000,
      });
      check(
        "`apiKey` option reaches the wire for jev/rule with no env var",
        threw === null && messages.length === 0 && api.seen().includes("Bearer from-the-option"),
        threw ? `threw ${threw.message}` : `saw ${JSON.stringify(api.seen())}`,
      );
    } finally {
      await api.close();
    }
  }

  // A malformed entry is the one case that SHOULD say something: a rule that
  // never fires because its config was dropped looks exactly like a rule that
  // found nothing.
  {
    const { threw, messages } = await lintRule(SORTED, {
      rules: [{ selector: "CallExpression", rule: "" }],
      onMiss: "silent",
    });
    check(
      "a rule with no sentence is reported as a config problem, not silence",
      threw === null && messages.length === 1 && messages[0].messageId === "ruleConfig",
      threw ? `threw ${threw.message}` : JSON.stringify(messages.map((m) => m.messageId)),
    );
  }
  {
    // A user selector of `Program:exit` is legal -- it means "on leaving the
    // file" -- and must not displace the rule's own exit hook, nor be
    // displaced by it.
    const { threw, messages } = await lintRule(SORTED, {
      rules: [{ selector: "Program:exit", rule: "なにか" }],
      cache: join(tmp, "absent-program.json"),
      onMiss: "report",
    });
    check(
      "a `Program:exit` selector coexists with the rule's own exit hook",
      threw === null && messages.length === 1 && messages[0].messageId === "ruleMissing",
      threw ? `threw ${threw.message}` : JSON.stringify(messages.map((m) => m.messageId)),
    );
  }
  {
    // An unparseable selector throws mid-traversal, which would take the whole
    // lint run down -- the one thing this plugin promises not to do.
    const { threw, messages } = await lintRule(SORTED, {
      rules: [
        { id: "broken", selector: "CallExpression[[[", rule: "なにか" },
        { id: "fine", selector: "CallExpression[callee.property.name='sort']", rule: "ほか" },
      ],
      cache: join(tmp, "absent-badsel.json"),
      onMiss: "report",
    });
    check(
      "an unparseable selector is a config message, not a crashed lint run",
      threw === null &&
        messages.some((m) => m.messageId === "ruleConfig" && m.message.includes("broken")),
      threw ? `threw ${threw.message}` : JSON.stringify(messages.map((m) => m.messageId)),
    );
    check(
      "and the rules around it still run",
      messages.some((m) => m.messageId === "ruleMissing" && m.message.includes("fine")),
      JSON.stringify(messages.map((m) => m.message.slice(0, 50))),
    );
  }
}

if (only !== "failsafe") {
  console.log("");
  console.log("AD-HOC RULES  (the selector is code, the sentence is the predicate)");

  {
    const { rules: ok, errors } = normalizeRules([
      { selector: "CallExpression", rule: "a" },
      { selector: "Identifier", rule: "b", id: "named" },
      { selector: "", rule: "c" },
      { selector: "Literal", rule: "" },
      { selector: "CallExpression", rule: "d" },
      "not an object",
    ]);
    check(
      "normalizeRules keeps the good entries and explains each bad one",
      ok.length === 2 && errors.length === 4,
      `${ok.length} kept, ${errors.length} errors: ${errors.join(" | ")}`,
    );
    check(
      "an id defaults to the selector, so two fields is a complete rule",
      ok[0].id === "CallExpression" && ok[1].id === "named",
      JSON.stringify(ok.map((r) => r.id)),
    );
  }

  {
    const { rules: one } = normalizeRules([SORT_RULE]);
    const { rules: reworded } = normalizeRules([{ ...SORT_RULE, rule: "別の文" }]);
    const { rules: noted } = normalizeRules([{ ...SORT_RULE, note: "例外あり" }]);
    const { rules: retuned } = normalizeRules([{ ...SORT_RULE, at: 1 }]);
    const k = (rs, text = "a.sort()") => ruleMatchKey(rs[0], text);
    check(
      "rewriting the sentence changes the key -- an old verdict cannot answer a new question",
      k(one) !== k(reworded),
    );
    check("adding a note changes the key too", k(one) !== k(noted));
    check(
      "changing only the threshold does NOT change the key -- retuning is free",
      k(one) === k(retuned),
    );
    check("a different node under the same rule is a different key", k(one) !== k(one, "b.sort()"));
    check(
      "the same node text under two rules is two keys",
      ruleMatchKey(normalizeRules([{ selector: "X", rule: "one" }]).rules[0], "a.sort()") !==
        ruleMatchKey(normalizeRules([{ selector: "X", rule: "two" }]).rules[0], "a.sort()"),
    );
    check(
      "the draft hash follows the sentence, not the id or the threshold",
      ruleTextHash(one[0]) !== ruleTextHash(reworded[0]) &&
        ruleTextHash(one[0]) === ruleTextHash(retuned[0]),
    );
  }

  {
    const plain = { id: "r", selector: "X", rule: "text", at: null, note: null };
    const t = DEFAULT_RULE_THRESHOLDS;
    const table = [
      // [score, confidence, rule, expected messageId, why]
      [3, 0.9, plain, "rule", "a clear violation"],
      [2, 0.9, plain, "rule", "exactly at the default cutoff"],
      [1.99, 0.9, plain, null, "just under it"],
      [1, 0.9, plain, null, "level 1 means the code SATISFIES the rule"],
      [0, 0.9, plain, null, "level 0 means the selector over-matched"],
      [2.5, 0.3, plain, "ruleUnsure", "over the bar but under-confident"],
      [2.5, 0.9, { ...plain, at: 2.8 }, null, "a per-rule cutoff can raise the bar"],
      [1.6, 0.9, { ...plain, at: 1.5 }, "rule", "and can lower it"],
    ];
    for (const [score, confidence, rule, expected, why] of table) {
      const got = decideRule({ score, confidence }, rule, t)?.messageId ?? null;
      check(`${why} -> ${expected ?? "silent"}`, got === expected, `got ${got ?? "silent"}`);
    }
    check("a null verdict is silent", decideRule(null, plain, t) === null);
    check(
      "a verdict with no score is silent, not defaulted",
      decideRule({ confidence: 0.9 }, plain, t) === null,
    );
    check(
      "confidence picks the message, it does not gate the report",
      decideRule({ score: 3, confidence: 0.01 }, plain, t)?.messageId === "ruleUnsure",
    );
  }

  {
    const mk = (n, file = "a.js") =>
      Array.from({ length: n }, (_, i) => ({
        rule: { id: "r", selector: "X", rule: "text", note: null },
        nodeType: "CallExpression",
        text: `call${i}()`,
        line: i + 1,
        endLine: i + 1,
        file,
        fileSource: "// tiny\n",
      }));
    const all = mk(600);
    const batches = planRuleBatches(all, 256);
    const flat = batches.flatMap((b) => b.matches);
    check(
      "no batch is over the size cap",
      batches.every((b) => b.matches.length <= 256),
      JSON.stringify(batches.map((b) => b.matches.length)),
    );
    check(
      "every match lands in exactly one batch, and no batch is empty",
      flat.length === all.length &&
        new Set(flat).size === all.length &&
        batches.every((b) => b.matches.length > 0),
    );
    check(
      "every batch fits under the request ceiling",
      batches.every(
        (b) =>
          estimateTokens(stateForRules(b.file, b.source, b.matches)) +
            estimateTokens(questionsForRules(b.matches)) <=
          MAX_REQUEST_TOKENS,
      ),
    );
    check(
      "the cap can be lowered to one match per request",
      planRuleBatches(mk(5), 1).length === 5,
    );
    check(
      "two files are never mixed into one request",
      planRuleBatches([...mk(2, "a.js"), ...mk(2, "b.js")], 256).length === 2,
    );
    const oversize = mk(2).map((m) => ({ ...m, fileSource: "x".repeat(200_000) }));
    check(
      "a file too big for the state ceiling falls back to one request per match",
      planRuleBatches(oversize, 256).every((b) => b.oversize && b.matches.length === 1),
    );
  }

  {
    // The long text goes by line reference, the short one is inlined -- and
    // either way the question must name the selector that caught it.
    const long = {
      rule: { id: "r", selector: "X", rule: "text", note: null },
      nodeType: "FunctionDeclaration",
      text: "x".repeat(INLINE_LIMIT + 1),
      line: 1,
      endLine: 40,
      file: "a.js",
    };
    const short = { ...long, text: "a.sort()", endLine: 1 };
    const qLong = questionsForRules([long])[ruleKey(0)];
    const qShort = questionsForRules([short])[ruleKey(0)];
    check(
      "a long match is named by line range; a short one is inlined",
      qLong.instructions.code === undefined && qShort.instructions.code === "a.sort()",
    );
    check(
      "the question carries the sentence and the selector that matched",
      qShort.instructions.rule === "text" &&
        qShort.instructions.matched_because.includes("X") &&
        qShort.criteria === RULE_LEVELS,
    );
    check(
      "a note reaches the model but never the lint message",
      questionsForRules([{ ...short, rule: { ...short.rule, note: "例外あり" } }])[ruleKey(0)]
        .instructions.also === "例外あり" &&
        !JSON.stringify(decideRule({ score: 3, confidence: 0.9 }, { ...short.rule, note: "例外あり" })).includes("例外あり"),
    );
    check(
      "an unusable answer is null, not a defaulted score",
      verdictForRule({ [ruleKey(0)]: { type: "noul", noul: 0.9 } }, 0) === null &&
        verdictForRule({}, 0) === null &&
        verdictForRule({ [ruleKey(0)]: { type: "score", score: 2, confidence: 0.8 } }, 0).score === 2,
    );
  }

  {
    // End to end: a warmed verdict, through the real ESLint, to a message.
    const { threw, messages } = await lintRule(SORTED, {
      rules: [SORT_RULE],
      cache: ruleCacheWith({ score: 2.9, confidence: 0.9 }),
      onMiss: "silent",
    });
    check(
      "a warmed verdict reaches the real ESLint as one message on the matched node",
      threw === null &&
        messages.length === 1 &&
        messages[0].messageId === "rule" &&
        messages[0].ruleId === "jev/rule" &&
        messages[0].line === 2 &&
        messages[0].message.includes("sort-comparator"),
      threw ? `threw ${threw.message}` : JSON.stringify(messages.map((m) => [m.messageId, m.line])),
    );
    const miss = await lintRule(SORTED, {
      rules: [SORT_RULE],
      cache: join(tmp, "absent-report.json"),
      onMiss: "report",
    });
    check(
      "`onMiss: report` names the rule that has no verdict",
      miss.threw === null &&
        miss.messages.length === 1 &&
        miss.messages[0].messageId === "ruleMissing" &&
        miss.messages[0].message.includes("sort-comparator"),
      JSON.stringify(miss.messages.map((m) => m.messageId)),
    );
    const two = await lintRule(SORTED, {
      rules: [SORT_RULE, { ...SORT_RULE, id: "second" }],
      cache: join(tmp, "absent-two.json"),
      onMiss: "report",
    });
    check(
      "two rules sharing one selector both get asked",
      two.messages.length === 2,
      JSON.stringify(two.messages.map((m) => m.message.slice(0, 40))),
    );
  }
}

console.log("");
if (failures.length > 0) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`${passed} passed`);
