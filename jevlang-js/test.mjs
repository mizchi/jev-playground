#!/usr/bin/env node
/**
 * Tests for the JS implementation of jevlang.
 *
 *   node jevlang-js/test.mjs
 *
 * These deliberately mirror `jevlang/jevlang_test.mbt` case for case: the two
 * implementations of this language have to agree, and the cheapest way to keep
 * them agreeing is to assert the same things about each. Nothing here calls
 * the API — the parts that do are covered by
 * `scripts/jevlang-conformance.sh`, which replays recorded transcripts
 * through both.
 */
import { parse } from "./src/parse.mjs";
import { requestPlan, formatNumber } from "./src/interp.mjs";
import { lex } from "./src/lex.mjs";

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}: ${err.message}`);
  }
}

function eq(actual, expected, what = "") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what} ${a} != ${b}`);
}

function throws(fn, match) {
  try {
    fn();
  } catch (err) {
    if (match && !err.message.includes(match)) {
      throw new Error(`wrong error: ${err.message}`);
    }
    return;
  }
  throw new Error("expected a throw");
}

const MILK = `state {
  fridge: ["卵", "ビール"],
  wallet_yen: 100,
}

threshold noul = 0.6
threshold gate = 0.4

if noul("家に牛乳がない") {
  buy("牛乳")
}

let result = match choice("100円で買うもの", ["プリン", "ビール"]) {
  "プリン" => buy("プリン")
  "ビール" => buy("ビール")
  else => buy("牛乳")
}

let praised = score("\${result} で褒められる確率", ["ない", "ある"])
`;

check("parses the state block, thresholds and body", () => {
  const p = parse(MILK);
  eq(p.thresholds.noul, 0.6, "noul threshold");
  eq(p.thresholds.gate, 0.4, "gate threshold");
  // noul + choice + gate + score
  eq(p.judgmentCount, 4, "judgment count");
  eq(p.body.length, 3, "statement count");
});

check("hoisting separates known questions from ones needing a runtime value", () => {
  const plan = requestPlan(parse(MILK));
  // noul, choice and the match's gate are all known up front.
  eq(plan.hoistable, 3, "hoistable");
  // score("${result} ...") has to wait for `result`.
  eq(plan.lazy, 1, "lazy");
});

check("a program with no interpolation hoists everything", () => {
  const plan = requestPlan(
    parse(`if noul("牛乳がない") { buy("牛乳") }\nif noul("卵がない") { buy("卵") }`),
  );
  eq(plan.hoistable, 2, "hoistable");
  eq(plan.lazy, 0, "lazy");
});

check("the gate question exists only when there is an else arm", () => {
  const withElse = parse(
    `let x = match choice("どれ", ["a", "b"]) { "a" => say("a") else => say("none") }`,
  );
  eq(withElse.judgmentCount, 2, "with else");
  const withoutElse = parse(
    `let x = match choice("どれ", ["a", "b"]) { "a" => say("a") "b" => say("b") }`,
  );
  eq(withoutElse.judgmentCount, 1, "without else");
});

check("lexing handles comments, escapes and non-ASCII identifiers", () => {
  const tokens = lex('# a comment\n牛乳を買う("a\\nb")');
  // ident ( str ) eof
  eq(tokens.length, 5, "token count");
  eq(tokens[0].text, "牛乳を買う", "identifier");
  eq(tokens[2].parts, [{ lit: "a\nb" }], "string parts");
});

check("interpolation is parsed into parts", () => {
  const tokens = lex('"買った ${result} の評価"');
  eq(tokens[0].parts.length, 3, "part count");
  eq(tokens[0].parts[1], { ident: "result" }, "interpolated part");
});

// The table that keeps the two implementations from diffing on formatting
// rather than on semantics. Must match jevlang_test.mbt exactly.
check("numbers format the same way in both implementations", () => {
  eq(formatNumber(1.0), "1");
  eq(formatNumber(0.0), "0");
  eq(formatNumber(1.5), "1.50");
  eq(formatNumber(0.97), "0.97");
  eq(formatNumber(0.055), "0.06");
  eq(formatNumber(2.0), "2");
  eq(formatNumber(-1.25), "-1.25");
});

check("syntax errors carry a line and a column", () => {
  throws(() => parse("let x = "), "1:");
});

check("the state block rejects interpolation", () => {
  throws(() => parse('state { a: "${x}" }'), "cannot interpolate");
});

check("a choice with no options is rejected before it reaches the API", () => {
  throws(() => parse('let x = choice("どれ", [])'), "at least one option");
});

console.log("");
console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
