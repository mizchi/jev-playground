///|
/// A thin MoonBit wrapper that makes a Jev judgment something you can `match`
/// on directly:
///
/// ```moonbit
/// let jev = @jevdsl.session(client, state)
///
/// match jev.noul("家に牛乳がない") {
///   (true, c) if c > 0.5 => buy_milk()
///   (true, _) => ask_the_user()
///   (false, _) => ()
/// }
///
/// match jev.choice("100円で買うもの", ["プリン", "ビール"]) {
///   (pick, c) if c > 0.6 => buy(pick)
///   (_, _) => ()
/// }
///
/// match jev.score("どれくらい急ぎか", ["待てる", "今日", "今すぐ"]) {
///   (s, c) if s >= 1.5 && c > 0.5 => escalate()
///   (s, _) if s >= 0.5 => queue()
///   (_, _) => ignore()
/// }
/// ```
///
/// Every judgment is `(result, confidence)`, so the shape of the `match` is the
/// same whichever of the three you asked. `lib` stays the raw client; this
/// package only changes the call site.
///
/// TWO THINGS TO KNOW BEFORE USING IT.
///
/// 1. Each `jev.noul(...)` is ONE REQUEST. That is the wrong default if you
///    have several judgments about the same state: docs/00 measured bundling
///    at 21x faster and 8x cheaper with the answers unmoved, because the state
///    is sent once and another question costs only its own wording. Use
///    `Session::ask` for that — it keeps the same `(result, confidence)`
///    accessors. The one-at-a-time form is for when there really is one
///    decision, or when a later question depends on an earlier answer.
///
/// 2. `confidence` for a noul is derived, because the API does not return one.
///    A noul answer is a single probability, and what "confident" means there
///    is distance from a coin flip: `|p - 0.5| * 2`, so p=0.9 and p=0.1 are
///    both 0.80 confident and p=0.5 is 0. `choice` and `score` use the
///    confidence the server sends. Use `probability` when you want the raw p.

///|
/// A client, a state and a model, bound together so a call site only has to
/// name the question.
pub struct Session {
  client : @lib.Client
  /// The content every judgment refers to. Mutable because a decision loop
  /// re-binds it each turn; the counters below keep accumulating across that.
  mut state : Json
  model : String
  mut requests : Int
  mut input_tokens : Int
}

///|
/// Bind a client and a state. `state` is any JSON — docs/01 found that
/// putting the context the decision needs in a structured state was the
/// single biggest lever, so this takes `Json` rather than a string.
pub fn session(
  client : @lib.Client,
  state : Json,
  model? : String,
) -> Session {
  {
    client,
    state,
    model: model.unwrap_or("jev-latest"),
    requests: 0,
    input_tokens: 0,
  }
}

///|
/// Re-point the session at a new state, keeping the counters.
pub fn Session::set_state(self : Session, state : Json) -> Unit {
  self.state = state
}

///|
/// Requests issued and input tokens spent, for reporting what a run cost.
/// Output tokens are free (docs/README), so they are not tracked.
pub fn Session::spent(self : Session) -> (Int, Int) {
  (self.requests, self.input_tokens)
}

///|
/// How far a probability is from a coin flip, in 0..1.
///
/// The API returns no confidence for a noul — the answer is one probability —
/// so "how sure" has to be derived, and distance from the fence is the only
/// reading that makes `confidence > 0.5` mean the same thing it means for a
/// `choice` or a `score`.
pub fn noul_confidence(p : Double) -> Double {
  (p - 0.5).abs() * 2.0
}

///|
const DEFAULT_FENCE : Double = 0.5

// ----------------------------------------------------------- one at a time

///|
/// Ask one yes/no question. Returns `(is it true, how far from a coin flip)`.
///
/// `at` moves the fence the Bool is decided at (default 0.5); it does not
/// change the confidence, which is always distance from 0.5. Thresholds belong
/// on this side of the wire, not in the question — docs/01 section 3.
pub async fn Session::noul(
  self : Session,
  question : String,
  true_desc? : String,
  false_desc? : String,
  at? : Double,
) -> (Bool, Double) raise {
  let p = self.probability(question, true_desc?, false_desc?)
  (p >= at.unwrap_or(DEFAULT_FENCE), noul_confidence(p))
}

///|
/// The raw probability of a yes/no question, for when the pair is not enough.
pub async fn Session::probability(
  self : Session,
  question : String,
  true_desc? : String,
  false_desc? : String,
) -> Double raise {
  let questions : Map[String, @lib.Question] = Map([])
  questions["q"] = @lib.Question::noul(question, true_desc?, false_desc?)
  self.ask(questions).probability("q")
}

///|
/// Ask a one-of-N question. Returns `(the chosen name, the server's
/// confidence)`.
///
/// With no `describe`, the options are read by name alone: the cheapest form
/// (docs/00) and the one docs/17 measured at 90% on a 53-item roster from
/// names alone. Pass `describe` when a name does not say what it means.
///
/// `choice` always returns one of the options, so if "none of these" is a
/// possible answer you need a separate noul to ask it — docs/17 section 3
/// measured that as strictly better than adding a "none" option.
pub async fn Session::choice(
  self : Session,
  question : String,
  options : Array[String],
  describe? : Map[String, String],
) -> (String, Double) raise {
  let q = match describe {
    Some(map) => @lib.Question::choice(map, instructions=question)
    None => @lib.Question::choice_of(options, instructions=question)
  }
  let questions : Map[String, @lib.Question] = Map([])
  questions["q"] = q
  self.ask(questions).choice("q")
}

///|
/// Ask an ordered question. Returns `(the score, the server's confidence)`,
/// where the score runs 0..levels-1 in the order given.
///
/// Use this and not `choice` whenever the answers have an order: docs/01
/// section 3 measured the same three-way decision at 19/24 as a `choice` and
/// 23/24 as a `score`, because a `choice` turns "which of two neighbours" into
/// low confidence and leaves nothing to threshold.
pub async fn Session::score(
  self : Session,
  question : String,
  levels : Array[String],
) -> (Double, Double) raise {
  let questions : Map[String, @lib.Question] = Map([])
  questions["q"] = @lib.Question::score(levels, instructions=question)
  self.ask(questions).score("q")
}

// ------------------------------------------------------------- all at once

///|
/// The answers to one bundled request, with the same accessors as the
/// one-at-a-time calls.
pub struct Answers {
  answers : Map[String, @lib.Answer]
}

///|
/// Send every question in one request and keep the answers by name.
///
/// This is the form to reach for when there is more than one judgment about
/// the same state: the state crosses the wire once, so each extra question
/// costs only its own wording (docs/00).
pub async fn Session::ask(
  self : Session,
  questions : Map[String, @lib.Question],
) -> Answers raise {
  let resp = self.client.system_one({
    state: self.state,
    model: self.model,
    questions,
  })
  self.requests = self.requests + 1
  self.input_tokens = self.input_tokens + resp.input_tokens
  { answers: resp.answers }
}

///|
/// Wrap answers you already have — from a `lib` call made directly, or from a
/// recorded response — so the accessors below can read them.
pub fn Answers::of(answers : Map[String, @lib.Answer]) -> Answers {
  { answers, }
}

///|
fn Answers::get(self : Answers, name : String) -> @lib.Answer raise {
  match self.answers.get(name) {
    Some(a) => a
    None =>
      raise @lib.ApiError::InvalidResponse("no answer named '\{name}' came back")
  }
}

///|
/// `(is it true at the fence, how far from a coin flip)`.
pub fn Answers::noul(
  self : Answers,
  name : String,
  at? : Double,
) -> (Bool, Double) raise {
  let p = self.probability(name)
  (p >= at.unwrap_or(DEFAULT_FENCE), noul_confidence(p))
}

///|
/// The raw probability of a noul answer.
pub fn Answers::probability(self : Answers, name : String) -> Double raise {
  match self.get(name) {
    @lib.Answer::NoulAnswer(p) => p
    other =>
      raise @lib.ApiError::InvalidResponse(
        "'\{name}' answered as \{shape_of(other)}, not a noul",
      )
  }
}

///|
/// `(the chosen name, the server's confidence)`.
pub fn Answers::choice(self : Answers, name : String) -> (String, Double) raise {
  match self.get(name) {
    @lib.Answer::ChoiceAnswer(pick, conf, _) => (pick, conf)
    other =>
      raise @lib.ApiError::InvalidResponse(
        "'\{name}' answered as \{shape_of(other)}, not a choice",
      )
  }
}

///|
/// `(the score, the server's confidence)`.
pub fn Answers::score(self : Answers, name : String) -> (Double, Double) raise {
  match self.get(name) {
    @lib.Answer::ScoreAnswer(s, conf, _, _) => (s, conf)
    other =>
      raise @lib.ApiError::InvalidResponse(
        "'\{name}' answered as \{shape_of(other)}, not a score",
      )
  }
}

///|
/// Every option's probability, for a choice. Useful when the top pick is not
/// the whole answer — docs/17 used the ordering to measure top-3 accuracy.
pub fn Answers::choice_probabilities(
  self : Answers,
  name : String,
) -> Map[String, Double] raise {
  match self.get(name) {
    @lib.Answer::ChoiceAnswer(_, _, probs) => probs
    other =>
      raise @lib.ApiError::InvalidResponse(
        "'\{name}' answered as \{shape_of(other)}, not a choice",
      )
  }
}

///|
fn shape_of(a : @lib.Answer) -> String {
  match a {
    @lib.Answer::NoulAnswer(_) => "a noul"
    @lib.Answer::ChoiceAnswer(_, _, _) => "a choice"
    @lib.Answer::ScoreAnswer(_, _, _, _) => "a score"
  }
}
