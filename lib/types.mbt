///|
/// Errors surfaced by the TypeSafe AI client.
pub(all) suberror ApiError {
  /// Non-2xx HTTP response: (status code, reason phrase, response body).
  Http(Int, String, String)
  /// The server answered 2xx but the body was not the expected shape.
  InvalidResponse(String)
  /// The request breaks a documented server limit; caught before sending.
  InvalidRequest(String)
} derive(Debug)

///|
/// Largest number of choices a single `Choice` question may carry. Past this
/// the server answers `400 {"detail":"Too many choices. Must have at most 255
/// choices."}`. The limit is absent from the OpenAPI schema; it was found by
/// probing the live API, so treat it as observed rather than promised.
pub let max_choices : Int = 255

///|
/// A typed question to ask about the `state`. Mirrors the three TypeSafe
/// primitives: `Noul` (yes/no), `Choice` (pick one), `Score` (ordered
/// rubric). Constructor fields are positional:
///
/// - `Noul(instructions, true_criteria, false_criteria)`
/// - `Choice(instructions, choice-name -> description Map)`
/// - `Score(instructions, ordered score levels)`
///
/// Instructions and every description are `Json`, not `String`: the schema
/// admits a string, an object or an array in all of those positions, and Jev
/// reads a structured description as readily as prose. A `Json::Null`
/// description in `Choice` means "interpret this choice by its name alone",
/// which is also the cheapest form — there are no description tokens to bill.
/// `Question::noul`/`choice`/`choice_of`/`score` cover the common all-strings
/// case.
pub(all) enum Question {
  Noul(Json?, Json?, Json?)
  Choice(Json?, Map[String, Json])
  Score(Json?, Array[Json])
}

///|
/// A yes/no question, answered with the probability that it is true.
/// `true_desc`/`false_desc` sharpen the boundary between the two answers.
pub fn Question::noul(
  instructions : String,
  true_desc? : String,
  false_desc? : String,
) -> Question {
  Noul(
    Some(Json::string(instructions)),
    true_desc.map(Json::string),
    false_desc.map(Json::string),
  )
}

///|
/// A one-of-N question over named choices with prose descriptions.
pub fn Question::choice(
  criteria : Map[String, String],
  instructions? : String,
) -> Question {
  let m : Map[String, Json] = Map([])
  for name, desc in criteria {
    m[name] = Json::string(desc)
  }
  Choice(instructions.map(Json::string), m)
}

///|
/// A one-of-N question whose choices are read by name alone. Use it when the
/// names already say what they mean: it sends no description tokens, so it is
/// the cheapest way to offer many choices.
pub fn Question::choice_of(
  names : Array[String],
  instructions? : String,
) -> Question {
  let m : Map[String, Json] = Map([])
  for name in names {
    m[name] = Json::null()
  }
  Choice(instructions.map(Json::string), m)
}

///|
/// A rubric question. Each level's position is its score, counting from zero.
pub fn Question::score(
  levels : Array[String],
  instructions? : String,
) -> Question {
  Score(instructions.map(Json::string), levels.map(Json::string))
}

///|
/// Reject what the server would reject anyway, with a message that names the
/// offending question instead of an opaque 400.
pub fn Question::validate(self : Question, name : String) -> Unit raise {
  match self {
    Choice(_, criteria) => {
      let n = criteria.length()
      if n == 0 {
        raise ApiError::InvalidRequest(
          "question '\{name}': a choice question needs at least one choice",
        )
      }
      if n > max_choices {
        raise ApiError::InvalidRequest(
          "question '\{name}': \{n} choices exceeds the server limit of \{max_choices}",
        )
      }
    }
    Score(_, levels) =>
      if levels.is_empty() {
        raise ApiError::InvalidRequest(
          "question '\{name}': a score question needs at least one level",
        )
      }
    Noul(_, _, _) => ()
  }
}

///|
/// A typed answer, keyed by question name in `SystemOneResponse.answers`.
pub(all) enum Answer {
  NoulAnswer(Double)
  ChoiceAnswer(String, Double, Map[String, Double])
  ScoreAnswer(Double, Double, Map[String, String], Map[String, Double])
}

///|
pub(all) struct SystemOneRequest {
  /// Content all questions refer to: any JSON value (string, object, array).
  state : Json
  /// Model name or alias, e.g. "jev-latest".
  model : String
  /// Named questions; each answer in the response uses the same name.
  questions : Map[String, Question]
}

///|
pub(all) struct SystemOneResponse {
  model : String
  answers : Map[String, Answer]
  input_tokens : Int
  output_tokens : Int
}

///|
pub(all) struct Model {
  name : String
  description : String
  release_date : String
}

///|
fn json_object(json : Json, what : String) -> Map[String, Json] raise {
  guard json is Json::Object(fields) else {
    raise ApiError::InvalidResponse(
      "\{what}: expected JSON object, got \{json.stringify()}",
    )
  }
  let m : Map[String, Json] = Map([])
  for (k, v) in fields {
    m[k] = v
  }
  m
}

///|
fn get_string(
  m : Map[String, Json],
  key : String,
  what : String,
) -> String raise {
  match m.get(key) {
    Some(Json::String(s)) => s
    Some(other) =>
      raise ApiError::InvalidResponse(
        "\{what}.\{key}: expected string, got \{other.stringify()}",
      )
    None => raise ApiError::InvalidResponse("\{what}.\{key}: missing")
  }
}

///|
fn get_double(
  m : Map[String, Json],
  key : String,
  what : String,
) -> Double raise {
  match m.get(key) {
    Some(Json::Number(v, ..)) => v
    Some(other) =>
      raise ApiError::InvalidResponse(
        "\{what}.\{key}: expected number, got \{other.stringify()}",
      )
    None => raise ApiError::InvalidResponse("\{what}.\{key}: missing")
  }
}

///|
fn get_string_map(
  m : Map[String, Json],
  key : String,
  what : String,
) -> Map[String, String] raise {
  let inner = match m.get(key) {
    Some(Json::Object(fields)) => fields
    Some(other) =>
      raise ApiError::InvalidResponse(
        "\{what}.\{key}: expected object, got \{other.stringify()}",
      )
    None => raise ApiError::InvalidResponse("\{what}.\{key}: missing")
  }
  let out : Map[String, String] = Map([])
  for (k, v) in inner {
    match v {
      Json::String(s) => out[k] = s
      _ =>
        raise ApiError::InvalidResponse(
          "\{what}.\{key}.\{k}: expected string, got \{v.stringify()}",
        )
    }
  }
  out
}

///|
fn get_double_map(
  m : Map[String, Json],
  key : String,
  what : String,
) -> Map[String, Double] raise {
  let inner = match m.get(key) {
    Some(Json::Object(fields)) => fields
    Some(other) =>
      raise ApiError::InvalidResponse(
        "\{what}.\{key}: expected object, got \{other.stringify()}",
      )
    None => raise ApiError::InvalidResponse("\{what}.\{key}: missing")
  }
  let out : Map[String, Double] = Map([])
  for (k, v) in inner {
    match v {
      Json::Number(n, ..) => out[k] = n
      _ =>
        raise ApiError::InvalidResponse(
          "\{what}.\{key}.\{k}: expected number, got \{v.stringify()}",
        )
    }
  }
  out
}

///|
fn opt_json(v : Json?) -> Json {
  match v {
    Some(j) => j
    None => Json::null()
  }
}

///|
pub fn Question::to_json(self : Question) -> Json {
  match self {
    Noul(instructions, true_desc, false_desc) => {
      let obj : Map[String, Json] = Map([])
      obj["type"] = Json("noul")
      obj["instructions"] = opt_json(instructions)
      // The yes/no descriptions belong in a nested `criteria` object
      // (`NoulCriteria`). Sent as top-level "true"/"false" keys the server
      // accepts the request and silently ignores them, so the question loses
      // its boundary without any error to show why.
      if !(true_desc is None && false_desc is None) {
        obj["criteria"] = Json({
          "true": opt_json(true_desc),
          "false": opt_json(false_desc),
        })
      }
      Json(obj)
    }
    Choice(instructions, criteria) =>
      Json({
        "type": Json("choice"),
        "instructions": opt_json(instructions),
        "criteria": Json(criteria),
      })
    Score(instructions, criteria) =>
      Json({
        "type": Json("score"),
        "instructions": opt_json(instructions),
        "criteria": Json(criteria),
      })
  }
}

///|
pub fn Question::from_json(json : Json) -> Question raise {
  let m = json_object(json, "question")
  match m.get("type") {
    Some(Json::String("noul")) => {
      // Read the nested `criteria` the schema defines, and fall back to
      // top-level "true"/"false" so question files written against the old
      // shape keep working.
      let nested = match m.get("criteria") {
        None | Some(Json::Null) => Map([])
        Some(obj) => json_object(obj, "question.criteria")
      }
      let pick = key => match get_json_opt(nested, key) {
        Some(j) => Some(j)
        None => get_json_opt(m, key)
      }
      Noul(get_json_opt(m, "instructions"), pick("true"), pick("false"))
    }
    Some(Json::String("choice")) =>
      Choice(get_json_opt(m, "instructions"), match m.get("criteria") {
        Some(Json::Object(fields)) => {
          let out : Map[String, Json] = Map([])
          for k, v in fields {
            out[k] = v
          }
          out
        }
        Some(other) =>
          raise ApiError::InvalidResponse(
            "question.criteria: expected object, got \{other.stringify()}",
          )
        None => raise ApiError::InvalidResponse("question.criteria: missing")
      })
    Some(Json::String("score")) =>
      Score(get_json_opt(m, "instructions"), match m.get("criteria") {
        Some(Json::Array(items)) => items
        Some(other) =>
          raise ApiError::InvalidResponse(
            "question.criteria: expected array, got \{other.stringify()}",
          )
        None => raise ApiError::InvalidResponse("question.criteria: missing")
      })
    Some(other) =>
      raise ApiError::InvalidResponse(
        "question.type: unknown \{other.stringify()}",
      )
    None => raise ApiError::InvalidResponse("question.type: missing")
  }
}

///|
fn get_json_opt(m : Map[String, Json], key : String) -> Json? {
  match m.get(key) {
    None | Some(Json::Null) => None
    Some(v) => Some(v)
  }
}

///|
pub fn Answer::to_json(self : Answer) -> Json {
  match self {
    NoulAnswer(prob) =>
      Json({ "type": Json("noul"), "noul": Json::number(prob) })
    ChoiceAnswer(choice, confidence, probabilities) =>
      Json({
        "type": Json("choice"),
        "choice": Json(choice),
        "confidence": Json::number(confidence),
        "probabilities": Json(probabilities),
      })
    ScoreAnswer(score, confidence, legend, probabilities) =>
      Json({
        "type": Json("score"),
        "score": Json::number(score),
        "confidence": Json::number(confidence),
        "legend": Json(legend),
        "probabilities": Json(probabilities),
      })
  }
}

///|
pub fn Answer::from_json(json : Json) -> Answer raise {
  let m = json_object(json, "answer")
  let why = "answer"
  match m.get("type") {
    Some(Json::String("noul")) => NoulAnswer(get_double(m, "noul", why))
    Some(Json::String("choice")) =>
      ChoiceAnswer(
        get_string(m, "choice", why),
        get_double(m, "confidence", why),
        get_double_map(m, "probabilities", why),
      )
    Some(Json::String("score")) =>
      ScoreAnswer(
        get_double(m, "score", why),
        get_double(m, "confidence", why),
        get_string_map(m, "legend", why),
        get_double_map(m, "probabilities", why),
      )
    Some(other) =>
      raise ApiError::InvalidResponse(
        "answer.type: unknown \{other.stringify()}",
      )
    None => raise ApiError::InvalidResponse("answer.type: missing")
  }
}

///|
/// Check every question against the server's limits before spending a
/// round-trip on a request that cannot succeed.
pub fn SystemOneRequest::validate(self : SystemOneRequest) -> Unit raise {
  if self.questions.is_empty() {
    raise ApiError::InvalidRequest("request needs at least one question")
  }
  for name, q in self.questions {
    q.validate(name)
  }
}

///|
pub fn SystemOneRequest::to_json(self : SystemOneRequest) -> Json {
  let qs : Map[String, Json] = Map([])
  for (name, q) in self.questions.to_array() {
    qs[name] = q.to_json()
  }
  Json({ "model": Json(self.model), "state": self.state, "questions": Json(qs) })
}

///|
pub fn SystemOneResponse::from_json(json : Json) -> SystemOneResponse raise {
  let m = json_object(json, "response")
  let usage = match m.get("usage") {
    Some(obj) => json_object(obj, "response.usage")
    None => raise ApiError::InvalidResponse("response.usage: missing")
  }
  let answers = match m.get("answers") {
    Some(Json::Object(fields)) => fields
    Some(other) =>
      raise ApiError::InvalidResponse(
        "response.answers: expected object, got \{other.stringify()}",
      )
    None => raise ApiError::InvalidResponse("response.answers: missing")
  }
  let parsed : Map[String, Answer] = Map([])
  for (name, a) in answers {
    parsed[name] = Answer::from_json(a)
  }
  {
    model: get_string(m, "model", "response"),
    answers: parsed,
    input_tokens: match usage.get("input_tokens") {
      Some(Json::Number(n, ..)) => n.to_int()
      _ =>
        raise ApiError::InvalidResponse(
          "response.usage.input_tokens: expected integer",
        )
    },
    output_tokens: match usage.get("output_tokens") {
      Some(Json::Number(n, ..)) => n.to_int()
      _ =>
        raise ApiError::InvalidResponse(
          "response.usage.output_tokens: expected integer",
        )
    },
  }
}

///|
pub fn SystemOneResponse::to_json(self : SystemOneResponse) -> Json {
  let ans : Map[String, Json] = Map([])
  for (name, a) in self.answers.to_array() {
    ans[name] = a.to_json()
  }
  Json({
    "model": Json(self.model),
    "answers": Json(ans),
    "usage": Json({
      "input_tokens": Json::number(
        self.input_tokens.to_double(),
        repr="\{self.input_tokens}",
      ),
      "output_tokens": Json::number(
        self.output_tokens.to_double(),
        repr="\{self.output_tokens}",
      ),
    }),
  })
}

///|
pub fn Model::from_json(json : Json) -> Model raise {
  let m = json_object(json, "model")
  {
    name: get_string(m, "name", "model"),
    description: get_string(m, "description", "model"),
    release_date: get_string(m, "release_date", "model"),
  }
}

///|
pub fn Model::to_json(self : Model) -> Json {
  Json({
    "name": Json(self.name),
    "description": Json(self.description),
    "release_date": Json(self.release_date),
  })
}
