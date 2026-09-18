///|
/// jevlang, MoonBit implementation. The JS twin is `jevlang-js/`.
///
///   moon run --target native cmd/jevlang -- examples/milk.jev
///   moon run --target native cmd/jevlang -- examples/milk.jev --lazy
///   moon run --target native cmd/jevlang -- examples/milk.jev --record t.json
///   moon run --target native cmd/jevlang -- examples/milk.jev --replay t.json --json
///
/// `--replay` makes no API calls, which is what lets
/// `scripts/jevlang-conformance.sh` diff this implementation against the JS
/// one on identical answers.

///|
struct Opts {
  file : String
  api_key : String
  base_url : String
  model : String
  lazy_mode : Bool
  json_out : Bool
  quiet : Bool
  record : String
  replay : String
  state_file : String
}

///|
/// A transcript: the state it was recorded against, plus every answer.
/// Deliberately a LIST rather than an object keyed by a composite string, so
/// it survives two different JSON writers and stays readable.
fn transcript_to_json(
  state : Json,
  entries : Array[@lang.Recorded],
) -> Json {
  let answers : Array[Json] = []
  for e in entries {
    let m : Map[String, Json] = Map([])
    m["kind"] = Json::string(e.kind)
    m["question"] = Json::string(e.question)
    m["options"] = Json::array(e.options.map(o => Json::string(o)))
    m["answer"] = e.answer.to_json()
    answers.push(Json::object(m))
  }
  let top : Map[String, Json] = Map([])
  top["state"] = state
  top["answers"] = Json::array(answers)
  Json::object(top)
}

///|
fn transcript_from_json(json : Json) -> Array[@lang.Recorded] raise {
  let entries : Array[@lang.Recorded] = []
  let obj = match json {
    Json::Object(m) => m
    _ => raise @lang.Runtime("transcript: expected a JSON object")
  }
  let items = match obj.get("answers") {
    Some(Json::Array(items)) => items
    _ => raise @lang.Runtime("transcript: missing 'answers' array")
  }
  for item in items {
    let m = match item {
      Json::Object(m) => m
      _ => raise @lang.Runtime("transcript: an entry is not an object")
    }
    let kind = match m.get("kind") {
      Some(Json::String(s)) => s
      _ => raise @lang.Runtime("transcript: an entry has no 'kind'")
    }
    let question = match m.get("question") {
      Some(Json::String(s)) => s
      _ => raise @lang.Runtime("transcript: an entry has no 'question'")
    }
    let options : Array[String] = []
    match m.get("options") {
      Some(Json::Array(items)) =>
        for o in items {
          match o {
            Json::String(s) => options.push(s)
            _ => ()
          }
        }
      _ => ()
    }
    let answer = match m.get("answer") {
      Some(a) => @lib.Answer::from_json(a)
      None => raise @lang.Runtime("transcript: an entry has no 'answer'")
    }
    entries.push({ kind, question, options, answer })
  }
  entries
}

///|
/// The machine-readable result. Only the parts both implementations must
/// agree on, in a fixed order, so a byte diff is meaningful.
fn result_to_json(result : @lang.RunResult) -> Json {
  let effects : Array[Json] = []
  for e in result.effects {
    let m : Map[String, Json] = Map([])
    m["name"] = Json::string(e.0)
    m["args"] = Json::array(e.1.map(a => Json::string(a)))
    effects.push(Json::object(m))
  }
  let bindings : Array[Json] = []
  for b in result.bindings {
    bindings.push(Json::array([Json::string(b.0), Json::string(b.1)]))
  }
  let judgments : Array[Json] = []
  for t in result.trace {
    let m : Map[String, Json] = Map([])
    m["kind"] = Json::string(t.kind)
    m["question"] = Json::string(t.question)
    judgments.push(Json::object(m))
  }
  let top : Map[String, Json] = Map([])
  top["effects"] = Json::array(effects)
  top["output"] = Json::array(result.output.map(o => Json::string(o)))
  top["bindings"] = Json::array(bindings)
  top["judgments"] = Json::array(judgments)
  Json::object(top)
}

///|
fn render_answer(a : @lib.Answer) -> String {
  match a {
    @lib.Answer::NoulAnswer(p) => @report.d2(p)
    @lib.Answer::ChoiceAnswer(c, conf, _) => "\{c} @\{@report.d2(conf)}"
    @lib.Answer::ScoreAnswer(s, conf, _, _) =>
      "\{@report.d2(s)} @\{@report.d2(conf)}"
  }
}

///|
async fn run(opts : Opts) -> Unit raise {
  let source = @fs.read_file(opts.file).text()
  let program = @lang.parse(source)
  let replay = if opts.replay.is_empty() {
    None
  } else {
    Some(transcript_from_json(@json.parse(@fs.read_file(opts.replay).text())))
  }
  // In replay mode there is no client at all, so a missing answer is an error
  // rather than a silent API call. That is what makes replayed runs
  // comparable between the two implementations.
  let client = if replay is Some(_) {
    None
  } else if opts.base_url == "https://api.typesafe.ai" {
    Some(@lib.Client::new(opts.api_key))
  } else {
    Some(@lib.Client::with_base_url(opts.api_key, opts.base_url))
  }
  let injected_state = if opts.state_file.is_empty() {
    None
  } else {
    Some(@json.parse(@fs.read_file(opts.state_file).text()))
  }
  let interp = @lang.Interp::new(
    program,
    client?,
    model=opts.model,
    lazy_mode=opts.lazy_mode,
    replay?,
    injected_state?,
  )
  let result = interp.run()
  if !opts.record.is_empty() {
    let json = transcript_to_json(interp.effective_state(), interp.recorded)
    @fs.write_file(opts.record, @utf8.encode(json.stringify(indent=2)))
  }
  if opts.json_out {
    println(result_to_json(result).stringify(indent=2))
    return
  }
  if opts.quiet {
    return
  }
  println("\{opts.file}  (\{program.judgment_count} judgments in source)")
  println("")
  for t in result.trace {
    println(
      "  [\{@report.pad(t.how, 6)}] \{@report.pad(t.kind, 6)} \{@report.pad(@report.clip(t.question, 46), 48)} \{render_answer(t.answer)}",
    )
  }
  println("")
  for e in result.effects {
    let args = e.1.map(a => "\"\{a}\"").join(", ")
    println("  -> \{e.0}(\{args})")
  }
  println("")
  let mode = if opts.lazy_mode { "lazy" } else { "batched" }
  let counts = if result.batched > 0 {
    " (\{result.batched} in the batch, \{result.lazy_asked} lazy)"
  } else {
    ""
  }
  let cost = if replay is Some(_) {
    " · replayed, no API calls"
  } else {
    " · \{result.input_tokens} input tokens · $\{@report.fixed(result.input_tokens.to_double() / 1000000.0 * 0.042, 5)}"
  }
  println(
    "  \{mode}: \{result.requests} request(s) for \{result.trace.length()} judgment(s)\{counts}\{cost}",
  )
}

// ----------------------------------------------------------------- plumbing

///|
async fn main {
  let cmd = @argparse.Command(
    "jevlang",
    about="Run a .jev program: a little language whose conditions are Jev judgments.",
    positionals=[
      @argparse.PositionArg("file", about="The .jev program to run."),
    ],
    flags=[
      @argparse.FlagArg(
        "lazy",
        long="lazy",
        action=SetTrue,
        about="Ask one request per judgment instead of batching the hoistable ones.",
      ),
      @argparse.FlagArg(
        "json",
        long="json",
        action=SetTrue,
        about="Machine-readable result, for cross-implementation checks.",
      ),
      @argparse.FlagArg(
        "quiet",
        long="quiet",
        action=SetTrue,
        about="Print nothing.",
      ),
    ],
    options=[
      @argparse.OptionArg(
        "api-key",
        long="api-key",
        about="API key (defaults to TYPESAFEAI_API_KEY).",
      ),
      @argparse.OptionArg(
        "model",
        long="model",
        default_values=["jev-latest"],
        about="Model name or alias.",
      ),
      @argparse.OptionArg(
        "base-url",
        long="base-url",
        about="API base URL (default https://api.typesafe.ai).",
      ),
      @argparse.OptionArg(
        "record",
        long="record",
        about="Write a transcript of every answer to this path.",
      ),
      @argparse.OptionArg(
        "replay",
        long="replay",
        about="Read answers from this transcript; makes no API calls.",
      ),
      @argparse.OptionArg(
        "state",
        long="state",
        about="JSON file merged over the program's own state block.",
      ),
    ],
  )
  let matches = @argparse.parse(cmd) catch {
    msg => {
      @stdio.stderr.write("jevlang: \{msg}\n")
      @sys.exit(2)
      return
    }
  }
  let file = opt_value(matches, "file").unwrap_or("")
  if file.is_empty() {
    @stdio.stderr.write("jevlang: no program given\n")
    @sys.exit(2)
    return
  }
  let replay = opt_value(matches, "replay").unwrap_or("")
  let api_key = match opt_value(matches, "api-key") {
    Some(k) if !k.is_empty() => k
    _ =>
      match @env.get_env_var("TYPESAFEAI_API_KEY") {
        Some(k) => k
        _ => ""
      }
  }
  if api_key.is_empty() && replay.is_empty() {
    @stdio.stderr.write(
      "jevlang: no API key. Set TYPESAFEAI_API_KEY, or run with --replay <transcript>.\n",
    )
    @sys.exit(1)
    return
  }
  let opts = {
    file,
    api_key,
    base_url: opt_value(matches, "base-url").unwrap_or(
      "https://api.typesafe.ai",
    ),
    model: opt_value(matches, "model").unwrap_or("jev-latest"),
    lazy_mode: matches.flags.get("lazy").unwrap_or(false),
    json_out: matches.flags.get("json").unwrap_or(false),
    quiet: matches.flags.get("quiet").unwrap_or(false),
    record: opt_value(matches, "record").unwrap_or(""),
    replay,
    state_file: opt_value(matches, "state").unwrap_or(""),
  }
  run(opts) catch {
    @lang.Syntax(line, col, msg) => {
      @stdio.stderr.write("\{opts.file}:\{line}:\{col}: \{msg}\n")
      @sys.exit(1)
    }
    @lang.Runtime(msg) => {
      @stdio.stderr.write("jevlang: \{msg}\n")
      @sys.exit(1)
    }
    @lib.ApiError::Http(code, reason, body) => {
      @stdio.stderr.write(
        "jevlang: HTTP \{code} \{reason}: \{@report.clip(body, 300)}\n",
      )
      @sys.exit(1)
    }
    @lib.ApiError::InvalidResponse(msg) | @lib.ApiError::InvalidRequest(msg) => {
      @stdio.stderr.write("jevlang: \{msg}\n")
      @sys.exit(1)
    }
    _ => {
      @stdio.stderr.write("jevlang: unexpected error\n")
      @sys.exit(1)
    }
  }
}

///|
fn opt_value(matches : @argparse.Matches, key : String) -> String? {
  match matches.values.get(key) {
    Some(arr) if arr.length() > 0 => Some(arr[0])
    _ => None
  }
}
