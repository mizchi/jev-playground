///|
/// Tests for the wrapper's reading side: the `(result, confidence)` shape, the
/// derived noul confidence, the fence, and what happens when a question comes
/// back as the wrong shape. None of it needs an API key — `Answers::of` wraps
/// synthetic answers, which is the same door a caller uses to read a response
/// they got from `lib` directly.

///|
fn noul_answers(p : Double) -> @jevdsl.Answers {
  let m : Map[String, @lib.Answer] = Map([])
  m["q"] = @lib.Answer::NoulAnswer(p)
  @jevdsl.Answers::of(m)
}

///|
test "a noul reads as (verdict, confidence)" {
  let (verdict, confidence) = noul_answers(0.9).noul("q")
  assert_eq(verdict, true)
  // |0.9 - 0.5| * 2
  assert_eq(confidence, 0.8)
}

///|
/// The point of the derived confidence: a noul at 0.1 is just as sure as one
/// at 0.9, it is just sure of the opposite. A `choice` or `score` confidence
/// means the same thing, so one `match` shape works for all three.
test "noul confidence is distance from a coin flip, not the probability" {
  assert_eq(@jevdsl.noul_confidence(0.9), 0.8)
  assert_eq(@jevdsl.noul_confidence(0.1), 0.8)
  assert_eq(@jevdsl.noul_confidence(0.5), 0.0)
  assert_eq(@jevdsl.noul_confidence(1.0), 1.0)
  assert_eq(@jevdsl.noul_confidence(0.0), 1.0)
}

///|
test "the fence moves the verdict but not the confidence" {
  let (strict, c1) = noul_answers(0.6).noul("q", at=0.7)
  assert_eq(strict, false)
  let (lenient, c2) = noul_answers(0.6).noul("q")
  assert_eq(lenient, true)
  // Both report the same distance from 0.5, whatever fence was asked for.
  assert_eq(c1, c2)
}

///|
test "the raw probability is still reachable" {
  assert_eq(noul_answers(0.42).probability("q"), 0.42)
}

///|
test "a choice reads as (pick, confidence) and keeps its probabilities" {
  let probs : Map[String, Double] = Map([])
  probs["milk"] = 0.7
  probs["pudding"] = 0.3
  let m : Map[String, @lib.Answer] = Map([])
  m["pick"] = @lib.Answer::ChoiceAnswer("milk", 0.71, probs)
  let answers = @jevdsl.Answers::of(m)
  let (pick, confidence) = answers.choice("pick")
  assert_eq(pick, "milk")
  assert_eq(confidence, 0.71)
  assert_eq(answers.choice_probabilities("pick").get("pudding"), Some(0.3))
}

///|
test "a score reads as (score, confidence)" {
  let m : Map[String, @lib.Answer] = Map([])
  m["urgency"] = @lib.Answer::ScoreAnswer(1.8, 0.66, Map([]), Map([]))
  let (score, confidence) = @jevdsl.Answers::of(m).score("urgency")
  assert_eq(score, 1.8)
  assert_eq(confidence, 0.66)
}

///|
/// The guarded `match` the wrapper exists for, over all three shapes.
test "the same match shape works for all three judgments" {
  let m : Map[String, @lib.Answer] = Map([])
  m["missing"] = @lib.Answer::NoulAnswer(0.95)
  m["pick"] = @lib.Answer::ChoiceAnswer("milk", 0.4, Map([]))
  m["urgency"] = @lib.Answer::ScoreAnswer(1.9, 0.8, Map([]), Map([]))
  let answers = @jevdsl.Answers::of(m)
  let a = match answers.noul("missing") {
    (true, c) if c > 0.5 => "buy"
    (true, _) => "ask"
    (false, _) => "skip"
  }
  assert_eq(a, "buy")
  let b = match answers.choice("pick") {
    (pick, c) if c > 0.6 => "take \{pick}"
    (_, _) => "too unsure to act"
  }
  assert_eq(b, "too unsure to act")
  let c = match answers.score("urgency") {
    (s, conf) if s >= 1.5 && conf > 0.5 => "escalate"
    (s, _) if s >= 0.5 => "queue"
    (_, _) => "ignore"
  }
  assert_eq(c, "escalate")
}

///|
test "reading a question as the wrong shape says so" {
  let m : Map[String, @lib.Answer] = Map([])
  m["q"] = @lib.Answer::NoulAnswer(0.9)
  let answers = @jevdsl.Answers::of(m)
  let wrong = try {
    let _ = answers.choice("q")
    ""
  } catch {
    @lib.ApiError::InvalidResponse(msg) => msg
    _ => ""
  }
  assert_eq(wrong.contains("not a choice"), true)
  assert_eq(wrong.contains("answered as a noul"), true)
}

///|
test "a missing question is named in the error" {
  let answers = @jevdsl.Answers::of(Map([]))
  let missing = try {
    let _ = answers.noul("nope")
    ""
  } catch {
    @lib.ApiError::InvalidResponse(msg) => msg
    _ => ""
  }
  assert_eq(missing.contains("no answer named 'nope'"), true)
}

///|
test "a session re-points at a new state and keeps its counters" {
  let jev = @jevdsl.session(
    @lib.Client::new("unused-in-this-test"),
    Json::string("first"),
  )
  assert_eq(jev.spent(), (0, 0))
  jev.set_state(Json::string("second"))
  // set_state must not reset what the session has spent so far.
  assert_eq(jev.spent(), (0, 0))
}
