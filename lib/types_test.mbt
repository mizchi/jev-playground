///|
test "question json round trip" {
  let qs = [
    Question::Noul(
      Some("Is this message spam?"),
      Some("Unsolicited advertising"),
      Some("A legitimate conversation"),
    ),
    Question::Choice(Some("What is the tone?"), {
      "angry": "An upset or hostile message",
      "calm": "A neutral or polite message",
    }),
    Question::Score(Some("How urgent is this?"), [
      "Can wait", "This week", "Today",
    ]),
  ]
  for q in qs {
    let back = Question::from_json(q.to_json())
    assert_eq(back.to_json().stringify(), q.to_json().stringify())
  }
}

///|
/// The round trip above is symmetric, so it passes whatever shape `to_json`
/// invents. These pin the wire shape to the schema instead: `NoulQuestion`
/// carries its yes/no descriptions in a nested `criteria` object, and the
/// server silently ignores top-level "true"/"false" keys — an unreadable
/// failure, because the request still succeeds with the criteria missing.
test "noul question nests its criteria" {
  let j = Question::noul(
    "This message is spam.",
    true_desc="Unsolicited advertising",
    false_desc="A legitimate conversation",
  )
    .to_json()
    .stringify()
  assert_true(j.contains("\"criteria\":{"))
  assert_true(j.contains("\"true\":\"Unsolicited advertising\""))
  assert_true(j.contains("\"false\":\"A legitimate conversation\""))
  // And not at the top level, where they would be dropped.
  let m = match @json.parse(j) {
    Json::Object(fields) => fields
    _ => { fail("question should be a JSON object"); panic() }
  }
  assert_true(m.get("true") is None)
  assert_true(m.get("false") is None)
  assert_true(m.get("criteria") is Some(Json::Object(_)))
}

///|
test "noul question omits criteria when it has none" {
  let j = Question::noul("This message is spam.").to_json().stringify()
  assert_true(j.contains("\"instructions\":\"This message is spam.\""))
  assert_false(j.contains("criteria"))
}

///|
/// The schema allows a string, an object or an array for `instructions` and
/// for every criteria description, and a null description means "read this
/// choice by its name alone".
test "questions carry structured instructions and name-only choices" {
  let structured = Question::Noul(
    Some(
      Json({
        "task": Json("Detect business email compromise"),
        "signals": Json([Json("urgency"), Json("secrecy")]),
      }),
    ),
    None,
    None,
  )
  let j = structured.to_json().stringify()
  assert_true(j.contains("\"task\":\"Detect business email compromise\""))
  let back = Question::from_json(structured.to_json())
  assert_eq(back.to_json().stringify(), j)
  let names = Question::choice_of(["billing", "technical"], instructions="Route it.")
  let nj = names.to_json().stringify()
  assert_true(nj.contains("\"billing\":null"))
  assert_true(nj.contains("\"technical\":null"))
}

///|
/// Question files written against the older top-level shape still parse.
test "noul question accepts the legacy top-level criteria" {
  let text =
    #|{"type":"noul","instructions":"Spam?","true":"Ads","false":"Real"}
  let j = Question::from_json(@json.parse(text)).to_json().stringify()
  assert_true(j.contains("\"criteria\":{"))
  assert_true(j.contains("\"true\":\"Ads\""))
}

///|
/// `max_choices` is an observed server limit, so catch it before the request.
test "choice questions are validated against the server limits" {
  let names = Array::makei(max_choices + 1, i => "opt_\{i}")
  let too_many : SystemOneRequest = {
    state: Json("pick one"),
    model: "jev-latest",
    questions: { "pick": Question::choice_of(names) },
  }
  try too_many.validate() catch {
    ApiError::InvalidRequest(msg) => assert_true(msg.contains("256"))
    e => fail("unexpected error: \{e}")
  } noraise {
    _ => fail("256 choices should be rejected before sending")
  }
  let ok : SystemOneRequest = {
    state: Json("pick one"),
    model: "jev-latest",
    questions: { "pick": Question::choice_of(names[:max_choices].to_owned()) },
  }
  ok.validate()
  let empty : SystemOneRequest = {
    state: Json("pick one"),
    model: "jev-latest",
    questions: {},
  }
  try empty.validate() catch {
    ApiError::InvalidRequest(_) => ()
    e => fail("unexpected error: \{e}")
  } noraise {
    _ => fail("a request with no questions should be rejected")
  }
}

///|
test "answer json round trip" {
  let ans = [
    Answer::NoulAnswer(0.98),
    Answer::ChoiceAnswer("angry", 0.92, {
      "angry": 0.8,
      "calm": 0.1,
      "excited": 0.1,
    }),
    Answer::ScoreAnswer(
      1.7,
      0.68,
      { "0": "Can wait", "1": "This week", "2": "Today" },
      { "0": 0.1, "1": 0.1, "2": 0.8 },
    ),
  ]
  for a in ans {
    let back = Answer::from_json(a.to_json())
    assert_eq(back.to_json().stringify(), a.to_json().stringify())
  }
}

///|
test "parse full response" {
  let sample =
    #|{
    #|  "model": "jev-latest",
    #|  "answers": {
    #|    "tone": {
    #|      "type": "choice",
    #|      "choice": "frustrated",
    #|      "confidence": 0.82,
    #|      "probabilities": {"frustrated": 0.8, "neutral": 0.15, "polite": 0.05}
    #|    },
    #|    "needs_refund": {"type": "noul", "noul": 0.95},
    #|    "urgency": {
    #|      "type": "score",
    #|      "score": 1.7,
    #|      "confidence": 0.7,
    #|      "legend": {"0": "Can wait", "1": "This week", "2": "Today"},
    #|      "probabilities": {"0": 0.1, "1": 0.1, "2": 0.8}
    #|    }
    #|  },
    #|  "usage": {"input_tokens": 412, "output_tokens": 9}
    #|}
  let resp = SystemOneResponse::from_json(@json.parse(sample))
  assert_eq(resp.model, "jev-latest")
  assert_eq(resp.input_tokens, 412)
  assert_eq(resp.output_tokens, 9)
  assert_eq(resp.answers.length(), 3)
  match resp.answers.get("needs_refund") {
    Some(Answer::NoulAnswer(prob)) => assert_true(prob > 0.9)
    _ => fail("needs_refund should be a noul answer")
  }
  match resp.answers.get("tone") {
    Some(Answer::ChoiceAnswer(choice, _, _)) => assert_eq(choice, "frustrated")
    _ => fail("tone should be a choice answer")
  }
}

///|
test "request json shape" {
  let req : SystemOneRequest = {
    state: Json("I was charged twice. Please help."),
    model: "jev-latest",
    questions: { "billing": Question::Noul(None, None, None) },
  }
  let j = req.to_json().stringify()
  assert_true(j.contains("\"model\":\"jev-latest\""))
  assert_true(j.contains("\"type\":\"noul\""))
}
