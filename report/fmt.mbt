///|
/// Fixed-width formatting and answer accessors shared by the experiment CLIs
/// under `cmd/`. Everything here exists so the reports in `docs/` can be
/// re-measured by running a command, rather than trusted.

///|
/// Fixed-point formatting, so columns line up in a terminal.
pub fn fixed(v : Double, places : Int) -> String {
  let mut scale = 1
  for _ in 0..<places {
    scale *= 10
  }
  let neg = v < 0.0
  let mag = if neg { -v } else { v }
  let scaled = (mag * scale.to_double() + 0.5).to_int()
  let whole = scaled / scale
  let frac = scaled % scale
  let mut digits = "\{frac}"
  while digits.length() < places {
    digits = "0" + digits
  }
  "\{if neg { "-" } else { "" }}\{whole}.\{digits}"
}

///|
pub fn d1(v : Double) -> String {
  fixed(v, 1)
}

///|
pub fn d2(v : Double) -> String {
  fixed(v, 2)
}

///|
pub fn d3(v : Double) -> String {
  fixed(v, 3)
}

///|
pub fn pad(s : String, width : Int) -> String {
  if s.length() >= width {
    s
  } else {
    s + " ".repeat(width - s.length())
  }
}

///|
pub fn pad_left(s : String, width : Int) -> String {
  if s.length() >= width {
    s
  } else {
    " ".repeat(width - s.length()) + s
  }
}

///|
pub fn clip(s : String, limit : Int) -> String {
  if s.length() <= limit {
    s
  } else {
    s[:limit].to_owned() + "…"
  }
}

///|
pub fn header(title : String, subtitle : String) -> Unit {
  println("")
  println("=".repeat(92))
  println("  \{title} — \{subtitle}")
  println("=".repeat(92))
}

///|
pub fn rule(width : Int) -> Unit {
  println("-".repeat(width))
}

// -------------------------------------------------------- answer accessors

///|
/// The probability of a noul answer, or 0 when the question is missing or
/// came back as another shape.
pub fn noul_at(r : @lib.SystemOneResponse, name : String) -> Double {
  match r.answers.get(name) {
    Some(@lib.Answer::NoulAnswer(p)) => p
    _ => 0.0
  }
}

///|
/// The winning choice and its confidence.
pub fn choice_at(r : @lib.SystemOneResponse, name : String) -> (String, Double) {
  match r.answers.get(name) {
    Some(@lib.Answer::ChoiceAnswer(c, conf, _)) => (c, conf)
    _ => ("?", 0.0)
  }
}

///|
/// The expected score and its confidence.
pub fn score_at(r : @lib.SystemOneResponse, name : String) -> (Double, Double) {
  match r.answers.get(name) {
    Some(@lib.Answer::ScoreAnswer(s, conf, _, _)) => (s, conf)
    _ => (0.0, 0.0)
  }
}

///|
/// Per-choice probabilities, so a decision can be read against what it
/// nearly was.
pub fn probs_at(
  r : @lib.SystemOneResponse,
  name : String,
) -> Map[String, Double] {
  match r.answers.get(name) {
    Some(@lib.Answer::ChoiceAnswer(_, _, p)) => p
    Some(@lib.Answer::ScoreAnswer(_, _, _, p)) => p
    _ => Map([])
  }
}

///|
/// The `n` likeliest entries other than `winner`, formatted for one line.
pub fn top_others(
  probs : Map[String, Double],
  winner : String,
  n : Int,
) -> String {
  let rest = []
  for name, p in probs {
    if name != winner {
      rest.push((name, p))
    }
  }
  rest.sort_by((a, b) => if a.1 > b.1 { -1 } else if a.1 < b.1 { 1 } else { 0 })
  let parts = []
  for i in 0..<n {
    if i >= rest.length() || rest[i].1 < 0.005 {
      break
    }
    parts.push("\{rest[i].0}=\{d2(rest[i].1)}")
  }
  parts.join(", ")
}

///|
/// The comparable part of an answer: a probability, an expected score, or a
/// choice name. Used to check whether an answer moves when a question is
/// asked alongside others rather than alone.
pub fn render_answer(a : @lib.Answer) -> String {
  match a {
    @lib.Answer::NoulAnswer(p) => d2(p)
    @lib.Answer::ScoreAnswer(s, _, _, _) => d2(s)
    @lib.Answer::ChoiceAnswer(c, _, _) => c
  }
}

///|
/// The numeric part of an answer, when it has one. `Choice` answers are
/// categorical, so they compare by equality instead.
pub fn numeric_answer(a : @lib.Answer) -> Double? {
  match a {
    @lib.Answer::NoulAnswer(p) => Some(p)
    @lib.Answer::ScoreAnswer(s, _, _, _) => Some(s)
    @lib.Answer::ChoiceAnswer(_, _, _) => None
  }
}

///|
/// Probabilities in descending order, formatted for one line.
pub fn probs_line(probs : Map[String, Double]) -> String {
  let items = []
  for name, p in probs {
    items.push((name, p))
  }
  items.sort_by((a, b) => if a.1 > b.1 { -1 } else if a.1 < b.1 { 1 } else { 0 })
  let parts = []
  for it in items {
    parts.push("\{it.0}=\{d2(it.1)}")
  }
  parts.join(" ")
}

///|
pub fn d0(v : Double) -> String {
  fixed(v, 0)
}
