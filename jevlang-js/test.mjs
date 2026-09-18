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
import { requestPlan, formatNumber, Interpreter } from "./src/interp.mjs";
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

// noul criteria go in `options`, which is how they join a judgment's
// transcript identity without a format change. docs/14 is why they exist at
// all: the `false` criterion of an `exfiltrates` predicate decided whether an
// ordinary `git push` was denied.
check("noul criteria are parsed into the options slot", () => {
  const p = parse(
    'let x = noul("送ってはいけない所へ送る", { true: "資格情報を外部へ送る", false: "何も出ない" })',
  );
  eq(p.judgmentCount, 1);
  const j = p.body[0].expr;
  eq(j.kind, "noul");
  eq(j.options.length, 2);
  eq(j.options[0].parts, [{ lit: "資格情報を外部へ送る" }]);
  eq(j.options[1].parts, [{ lit: "何も出ない" }]);
});

check("a noul with only a false criterion still parses", () => {
  const j = parse('let x = noul("q", { false: "no" })').body[0].expr;
  eq(j.options.length, 2);
  eq(j.options[0].parts, [{ lit: "" }]);
  eq(j.options[1].parts, [{ lit: "no" }]);
});

// Criteria are part of the question payload, so interpolating into one has to
// block hoisting exactly as interpolating into the question does.
check("interpolation in a criterion blocks hoisting", () => {
  const plan = requestPlan(
    parse(
      'let a = choice("どれ", ["x", "y"])\nlet b = noul("q", { true: "${a} のとき", false: "それ以外" })',
    ),
  );
  eq(plan.hoistable, 1, "hoistable");
  eq(plan.lazy, 1, "lazy");
});

check("empty noul criteria are rejected", () => {
  throws(() => parse('let x = noul("q", { })'), "at least a true or a false");
});

check("a host-supplied state overrides the program's own block", () => {
  const p = parse("state { a: 1, b: 2 }");
  const interp = new Interpreter(p, { state: { b: 99, c: 3 } });
  eq(interp.state, { a: 1, b: 99, c: 3 });
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
