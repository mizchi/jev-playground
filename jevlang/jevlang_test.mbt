///|
/// Tests for the language itself: lexing, parsing, the hoisting analysis and
/// number formatting. All of it runs without an API key, because none of it
/// asks Jev anything — the parts that do are covered by
/// `scripts/jevlang-conformance.sh`, which replays recorded transcripts
/// through both implementations.

///|
let milk_program : String =
  #|state {
  #|  fridge: ["卵", "ビール"],
  #|  wallet_yen: 100,
  #|}
  #|
  #|threshold noul = 0.6
  #|threshold gate = 0.4
  #|
  #|if noul("家に牛乳がない") {
  #|  buy("牛乳")
  #|}
  #|
  #|let result = match choice("100円で買うもの", ["プリン", "ビール"]) {
  #|  "プリン" => buy("プリン")
  #|  "ビール" => buy("ビール")
  #|  else => buy("牛乳")
  #|}
  #|
  #|let praised = score("${result} で褒められる確率", ["ない", "ある"])
  #|

///|
test "parses the state block, thresholds and body" {
  let program = @jevlang.parse(milk_program)
  assert_eq(program.noul_threshold, 0.6)
  assert_eq(program.gate_threshold, 0.4)
  // noul + choice + gate + score
  assert_eq(program.judgment_count, 4)
  assert_eq(program.body.length(), 3)
}

///|
test "the state block becomes the JSON that goes on the wire" {
  let program = @jevlang.parse(milk_program)
  let json = program.state.to_json()
  match json {
    Json::Object(m) => {
      assert_eq(m.length(), 2)
      match m.get("wallet_yen") {
        Some(Json::Number(v, ..)) => assert_eq(v, 100.0)
        _ => fail("wallet_yen should be a number")
      }
      match m.get("fridge") {
        Some(Json::Array(items)) => assert_eq(items.length(), 2)
        _ => fail("fridge should be an array")
      }
    }
    _ => fail("the state should be an object")
  }
}

///|
/// The whole cost model: a question whose text is already known can ride the
/// one batched request; one that interpolates a variable cannot.
test "hoisting separates known questions from ones needing a runtime value" {
  let program = @jevlang.parse(milk_program)
  let (hoistable, lazy_count) = program.request_plan()
  // noul, choice and the match's gate are all known up front.
  assert_eq(hoistable, 3)
  // `score("${result} ...")` has to wait for `result`.
  assert_eq(lazy_count, 1)
}

///|
test "a program with no interpolation hoists everything" {
  let src =
    #|if noul("牛乳がない") {
    #|  buy("牛乳")
    #|}
    #|if noul("卵がない") {
    #|  buy("卵")
    #|}
  let program = @jevlang.parse(src)
  let (hoistable, lazy_count) = program.request_plan()
  assert_eq(hoistable, 2)
  assert_eq(lazy_count, 0)
}

///|
/// A `match` without an `else` arm asks no gate question, so it costs one
/// judgment rather than two.
test "the gate question exists only when there is an else arm" {
  let with_else_src =
    #|let x = match choice("どれ", ["a", "b"]) {
    #|  "a" => say("a")
    #|  else => say("none")
    #|}
  let with_else = @jevlang.parse(with_else_src)
  assert_eq(with_else.judgment_count, 2)
  let without_else_src =
    #|let x = match choice("どれ", ["a", "b"]) {
    #|  "a" => say("a")
    #|  "b" => say("b")
    #|}
  let without_else = @jevlang.parse(without_else_src)
  assert_eq(without_else.judgment_count, 1)
}

///|
test "lexing handles comments, escapes and non-ASCII identifiers" {
  let src =
    #|# a comment
    #|牛乳を買う("a\nb")
  let tokens = @jevlang.lex(src)
  // ident ( str ) eof
  assert_eq(tokens.length(), 5)
  match tokens[0].tok {
    TIdent(name) => assert_eq(name, "牛乳を買う")
    _ => fail("the first token should be an identifier")
  }
  match tokens[2].tok {
    TStr(parts) => {
      assert_eq(parts.length(), 1)
      match parts[0] {
        Lit(s) => assert_eq(s, "a\nb")
        Interp(_) => fail("no interpolation here")
      }
    }
    _ => fail("the third token should be a string")
  }
}

///|
test "interpolation is parsed into parts" {
  let tokens = @jevlang.lex("\"買った ${result} の評価\"")
  match tokens[0].tok {
    TStr(parts) => {
      assert_eq(parts.length(), 3)
      match parts[1] {
        Interp(name) => assert_eq(name, "result")
        Lit(_) => fail("the middle part should be an interpolation")
      }
    }
    _ => fail("expected a string token")
  }
}

///|
/// Both implementations render numbers through this, so a conformance diff
/// means a semantic difference rather than a formatting one.
test "numbers format the same way in both implementations" {
  assert_eq(@jevlang.format_number(1.0), "1.00")
  assert_eq(@jevlang.format_number(0.0), "0.00")
  assert_eq(@jevlang.format_number(1.5), "1.50")
  assert_eq(@jevlang.format_number(0.97), "0.97")
  assert_eq(@jevlang.format_number(0.055), "0.06")
  assert_eq(@jevlang.format_number(2.0), "2.00")
  assert_eq(@jevlang.format_number(-1.25), "-1.25")
  assert_eq(@jevlang.format_number(3.0), "3.00")
}

///|
/// noul criteria go in `options`, which is how they join a judgment's
/// transcript identity without a format change. docs/18 is why they exist at
/// all: the `false` criterion of an `exfiltrates` predicate decided whether
/// an ordinary `git push` was denied.
test "noul criteria are parsed into the options slot" {
  let src =
    #|let x = noul("送ってはいけない所へ送る", {
    #|  true: "資格情報を外部へ送る",
    #|  false: "何も出ない",
    #|})
  let program = @jevlang.parse(src)
  assert_eq(program.judgment_count, 1)
  match program.body[0] {
    SLet(_, EJudge(j)) => {
      assert_eq(j.kind, "noul")
      assert_eq(j.options.length(), 2)
      assert_eq(@jevlang.str_lit_text(j.options[0].parts), "資格情報を外部へ送る")
      assert_eq(@jevlang.str_lit_text(j.options[1].parts), "何も出ない")
    }
    _ => fail("expected a let bound to a noul")
  }
}

///|
test "a noul with only a false criterion still parses" {
  let program = @jevlang.parse(
    ("let x = noul(\"q\", { false: \"no\" })" : String),
  )
  match program.body[0] {
    SLet(_, EJudge(j)) => {
      assert_eq(j.options.length(), 2)
      assert_eq(@jevlang.str_lit_text(j.options[0].parts), "")
      assert_eq(@jevlang.str_lit_text(j.options[1].parts), "no")
    }
    _ => fail("expected a let bound to a noul")
  }
}

///|
/// Criteria are part of the question payload, so interpolating into one has
/// to block hoisting exactly as interpolating into the question does.
test "interpolation in a criterion blocks hoisting" {
  let src =
    #|let a = choice("どれ", ["x", "y"])
    #|let b = noul("q", { true: "${a} のとき", false: "それ以外" })
  let program = @jevlang.parse(src)
  let (hoistable, lazy_count) = program.request_plan()
  assert_eq(hoistable, 1)
  assert_eq(lazy_count, 1)
}

///|
test "empty noul criteria are rejected" {
  let failed = try {
    let _ = @jevlang.parse("let x = noul(\"q\", { })")
    false
  } catch {
    @jevlang.Syntax(_, _, _) => true
    _ => false
  }
  assert_true(failed)
}

///|
/// `flagged()` is what lets a reason string say WHICH predicate fired. It
/// takes bare names so the names survive into the output, and renders only
/// the ones at or above `threshold flag`.
async test "flagged renders the judgments above the flag threshold" {
  let src =
    #|threshold flag = 0.6
    #|let a = 0.9
    #|let b = 0.5
    #|let c = 0.7
    #|say(flagged(a, b, c))
  let program = @jevlang.parse(src)
  assert_eq(program.flag_threshold, 0.6)
  let interp = @jevlang.Interp::new(program)
  let result = interp.run()
  assert_eq(result.output.length(), 1)
  assert_eq(result.output[0], "a 0.90, c 0.70")
}

///|
async test "flagged renders nothing when no predicate fires" {
  let src =
    #|let a = 0.1
    #|say(flagged(a))
  let interp = @jevlang.Interp::new(@jevlang.parse(src))
  let result = interp.run()
  assert_eq(result.output[0], "")
}

///|
async test "flagged rejects a value that is not a judgment" {
  let src =
    #|let a = "text"
    #|say(flagged(a))
  let interp = @jevlang.Interp::new(@jevlang.parse(src))
  let failed = try {
    let _ = interp.run()
    false
  } catch {
    @jevlang.Runtime(msg) => msg.contains("flagged() needs judgments")
    _ => false
  }
  assert_true(failed)
}

///|
/// Reading a `threshold` declaration back means a cutoff the language uses
/// and a cutoff a message mentions cannot drift apart.
async test "threshold_of reads the declarations back" {
  // Interpolation takes a bare identifier, so a read has to be bound first.
  let src =
    #|threshold noul = 0.6
    #|threshold gate = 0.4
    #|threshold flag = 0.7
    #|let n = threshold_of(noul)
    #|let g = threshold_of(gate)
    #|let f = threshold_of(flag)
    #|say("noul ${n} gate ${g} flag ${f}")
  let interp = @jevlang.Interp::new(@jevlang.parse(src))
  let result = interp.run()
  assert_eq(result.output[0], "noul 0.60 gate 0.40 flag 0.70")
}

///|
async test "threshold_of defaults to 0.5 when nothing is declared" {
  let src =
    #|let f = threshold_of(flag)
    #|say("${f}")
  let interp = @jevlang.Interp::new(@jevlang.parse(src))
  assert_eq(interp.run().output[0], "0.50")
}

///|
test "threshold_of rejects an unknown name at parse time" {
  let failed = try {
    let _ = @jevlang.parse("say(flagged())")
    false
  } catch {
    @jevlang.Syntax(_, _, _) => true
    _ => false
  }
  assert_true(failed)
  let failed2 = try {
    let _ = @jevlang.parse(("let x = threshold_of(nope)" : String))
    false
  } catch {
    @jevlang.Syntax(_, _, msg) => msg.contains("unknown threshold")
    _ => false
  }
  assert_true(failed2)
}

///|
/// A let-bound number works in a comparison and in interpolation, which is
/// what lets a policy name its own cutoffs once and use them in both the
/// rule and the reason string. No judgments, so no requests.
async test "a let-bound number serves as both a cutoff and a message value" {
  let src =
    #|let deny_at = 1.5
    #|let value = 1.9
    #|if value >= deny_at {
    #|  say("deny at ${deny_at}")
    #|}
  let program = @jevlang.parse(src)
  assert_eq(program.judgment_count, 0)
  let interp = @jevlang.Interp::new(program)
  let result = interp.run()
  assert_eq(result.output[0], "deny at 1.50")
  assert_eq(result.requests, 0)
}

///|
/// The gate exists because `choice` always returns one of its options. A
/// plain string subject has no closed world to escape, so matching on one
/// must not ask a question about nothing — and that makes `match` usable as
/// an ordinary string switch.
async test "a match over a plain string grows no gate judgment" {
  let src =
    #|let s = "x"
    #|let y = match s {
    #|  "x" => say("hit")
    #|  else => say("miss")
    #|}
  let program = @jevlang.parse(src)
  assert_eq(program.judgment_count, 0)
  let interp = @jevlang.Interp::new(program)
  let result = interp.run()
  assert_eq(result.output[0], "hit")
  assert_eq(result.requests, 0)
}

///|
test "a match over a choice still grows a gate judgment" {
  let src =
    #|let y = match choice("どれ", ["a", "b"]) {
    #|  "a" => say("a")
    #|  else => say("none")
    #|}
  assert_eq(@jevlang.parse(src).judgment_count, 2)
}

///|
test "a host-supplied state overrides the program's own block" {
  let program = @jevlang.parse("state { a: 1, b: 2 }")
  let over : Map[String, Json] = Map([])
  over["b"] = Json::number(99.0)
  over["c"] = Json::number(3.0)
  let interp = @jevlang.Interp::new(program, injected_state=Json::object(over))
  match interp.effective_state() {
    Json::Object(m) => {
      assert_eq(m.length(), 3)
      match m.get("a") {
        Some(Json::Number(v, ..)) => assert_eq(v, 1.0)
        _ => fail("a should survive")
      }
      match m.get("b") {
        Some(Json::Number(v, ..)) => assert_eq(v, 99.0)
        _ => fail("b should be overridden")
      }
    }
    _ => fail("expected an object")
  }
}

///|
test "the gate question text is fixed, because a transcript depends on it" {
  assert_eq(
    @jevlang.gate_question(["a", "b"]),
    "次の選択肢のうち少なくとも 1 つが実際に当てはまる: a / b",
  )
}

///|
test "syntax errors carry a line and a column" {
  let failed = try {
    let _ = @jevlang.parse("let x = ")
    false
  } catch {
    @jevlang.Syntax(line, _, _) => {
      assert_eq(line, 1)
      true
    }
    _ => false
  }
  assert_true(failed)
}

///|
test "the state block rejects interpolation" {
  let failed = try {
    let _ = @jevlang.parse("state { a: \"${x}\" }")
    false
  } catch {
    @jevlang.Syntax(_, _, _) => true
    _ => false
  }
  assert_true(failed)
}

///|
test "a choice with no options is rejected before it reaches the API" {
  let failed = try {
    let _ = @jevlang.parse("let x = choice(\"どれ\", [])")
    false
  } catch {
    @jevlang.Syntax(_, _, msg) => msg.contains("at least one option")
    _ => false
  }
  assert_true(failed)
}
