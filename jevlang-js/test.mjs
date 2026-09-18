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

const pending = [];

/** Accepts sync or async bodies; async ones are awaited before the summary. */
function check(name, fn) {
  const record = (err) => {
    if (err) {
      fail += 1;
      console.log(`  FAIL ${name}: ${err.message}`);
    } else {
      pass += 1;
      console.log(`  ok   ${name}`);
    }
  };
  try {
    const out = fn();
    if (out && typeof out.then === "function") {
      pending.push(out.then(() => record(null), record));
    } else {
      record(null);
    }
  } catch (err) {
    record(err);
  }
}

async function throwsAsync(fn, match) {
  try {
    await fn();
  } catch (err) {
    if (match && !err.message.includes(match)) {
      throw new Error(`wrong error: ${err.message}`);
    }
    return;
  }
  throw new Error("expected a throw");
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
  eq(formatNumber(1.0), "1.00");
  eq(formatNumber(0.0), "0.00");
  eq(formatNumber(1.5), "1.50");
  eq(formatNumber(0.97), "0.97");
  eq(formatNumber(0.055), "0.06");
  eq(formatNumber(2.0), "2.00");
  eq(formatNumber(-1.25), "-1.25");
  eq(formatNumber(3.0), "3.00");
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

// `flagged()` is what lets a reason string say WHICH predicate fired. It
// takes bare names so the names survive into the output, and renders only the
// ones at or above `threshold flag`.
check("flagged renders the judgments above the flag threshold", async () => {
  const p = parse(
    `threshold flag = 0.6\nlet a = 0.9\nlet b = 0.5\nlet c = 0.7\nsay(flagged(a, b, c))`,
  );
  eq(p.thresholds.flag, 0.6, "flag threshold");
  const result = await new Interpreter(p).run();
  eq(result.output, ["a 0.90, c 0.70"]);
});

check("flagged renders nothing when no predicate fires", async () => {
  const result = await new Interpreter(parse(`let a = 0.1\nsay(flagged(a))`)).run();
  eq(result.output, [""]);
});

check("flagged rejects a value that is not a judgment", async () => {
  await throwsAsync(
    () => new Interpreter(parse(`let a = "text"\nsay(flagged(a))`)).run(),
    "flagged() needs judgments",
  );
});

// Reading a `threshold` declaration back means a cutoff the language uses and
// a cutoff a message mentions cannot drift apart.
check("threshold_of reads the declarations back", async () => {
  // Interpolation takes a bare identifier, so a read has to be bound first.
  const src = [
    "threshold noul = 0.6",
    "threshold gate = 0.4",
    "threshold flag = 0.7",
    "let n = threshold_of(noul)",
    "let g = threshold_of(gate)",
    "let f = threshold_of(flag)",
    'say("noul ${n} gate ${g} flag ${f}")',
  ].join("\n");
  const result = await new Interpreter(parse(src)).run();
  eq(result.output, ["noul 0.60 gate 0.40 flag 0.70"]);
});

check("threshold_of defaults to 0.5 when nothing is declared", async () => {
  const src = ["let f = threshold_of(flag)", 'say("${f}")'].join("\n");
  const result = await new Interpreter(parse(src)).run();
  eq(result.output, ["0.50"]);
});

check("threshold_of rejects an unknown name at parse time", () => {
  throws(() => parse("let x = threshold_of(nope)"), "unknown threshold");
});

// A let-bound number works in a comparison and in interpolation, which is what
// lets a policy name its own cutoffs once and use them in both the rule and
// the reason string. No judgments, so no requests.
check("a let-bound number serves as both a cutoff and a message value", async () => {
  const src = [
    "let deny_at = 1.5",
    "let value = 1.9",
    'if value >= deny_at { say("deny at ${deny_at}") }',
  ].join("\n");
  const p = parse(src);
  eq(p.judgmentCount, 0, "judgment count");
  const result = await new Interpreter(p).run();
  eq(result.output, ["deny at 1.50"]);
  eq(result.requests, 0, "requests");
});

// The gate exists because `choice` always returns one of its options. A plain
// string subject has no closed world to escape, so matching on one must not
// ask a question about nothing — and that makes `match` usable as an ordinary
// string switch.
check("a match over a plain string grows no gate judgment", async () => {
  const p = parse(`let s = "x"\nlet y = match s { "x" => say("hit") else => say("miss") }`);
  eq(p.judgmentCount, 0, "judgment count");
  const result = await new Interpreter(p).run();
  eq(result.output, ["hit"]);
  eq(result.requests, 0, "requests");
});

check("a match over a choice still grows a gate judgment", () => {
  const p = parse(
    `let y = match choice("どれ", ["a", "b"]) { "a" => say("a") else => say("none") }`,
  );
  eq(p.judgmentCount, 2, "judgment count");
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

await Promise.all(pending);
console.log("");
console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
