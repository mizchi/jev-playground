///|
/// A runnable demo of the `jevdsl` wrapper: the same fridge decision as
/// `examples/milk.jev`, written as ordinary MoonBit that you `match` on.
///
///   moon run --target native cmd/jevdsl --              # one request per judgment
///   moon run --target native cmd/jevdsl -- --bundled    # all of them in one
///
/// The point of the demo is the call sites, not the decision. `--bundled` runs
/// the identical logic through `Session::ask` so the two costs are visible
/// side by side.

///|
struct Opts {
  api_key : String
  base_url : String
  model : String
  bundled : Bool
}

///|
/// The fridge and the wallet. docs/01 found that putting the context the
/// decision needs into a structured state was the single biggest lever, so
/// this is JSON rather than a sentence.
fn kitchen_state() -> Json {
  let fridge : Array[Json] = [
    Json::string("卵"), Json::string("ビール"), Json::string("マヨネーズ"),
  ]
  let m : Map[String, Json] = Map([])
  m["fridge"] = Json::array(fridge)
  m["wallet_yen"] = Json::number(100.0)
  m["wife_mood"] = Json::string("ふつう")
  m["day"] = Json::string("金曜日")
  Json::object(m)
}

///|
let snacks : Array[String] = ["プリン", "ビール", "うまい棒"]

///|
let urgency_levels : Array[String] = [
  "今日でなくてよい", "今日のうちに", "今すぐ",
]

///|
/// One request per judgment. Reads the best, costs the most.
async fn one_at_a_time(jev : @dsl.Session) -> Unit raise {
  println("  one request per judgment")
  println("")

  // A noul is (verdict, confidence), and the confidence is distance from a
  // coin flip — so this guard means "sure it is missing", not "probably".
  match jev.noul("家に牛乳がない") {
    (true, c) if c > 0.5 => println("  牛乳を買う            (missing, confident \{@report.d2(c)})")
    (true, c) => println("  牛乳は確認してから    (missing, but only \{@report.d2(c)} sure)")
    (false, c) => println("  牛乳はある            (present, \{@report.d2(c)} sure)")
  }

  // A choice is (pick, confidence). The options are read by name alone: the
  // cheapest form (docs/00), and docs/17 measured 90% from names alone.
  match jev.choice("100円余ったときに買うもの", snacks) {
    (pick, c) if c > 0.5 => println("  \{pick} を買う          (confident \{@report.d2(c)})")
    (pick, c) => println("  \{pick} は迷っている     (\{@report.d2(c)})")
  }

  // A score is (score, confidence). Ordered conclusions go here and not in a
  // choice — docs/01 section 3 measured 19/24 against 23/24 on that alone.
  match jev.score("買い物に行く急ぎ度", urgency_levels) {
    (s, c) if s >= 1.5 && c > 0.5 => println("  今すぐ出る            (\{@report.d2(s)}/2, \{@report.d2(c)})")
    (s, _) if s >= 0.5 => println("  今日のうちに          (\{@report.d2(s)}/2)")
    (s, _) => println("  今日でなくてよい      (\{@report.d2(s)}/2)")
  }
}

///|
/// The same three judgments in ONE request. docs/00 measured bundling at 21x
/// faster and 8x cheaper with the answers unmoved, because the state crosses
/// the wire once and another question costs only its own wording.
async fn bundled(jev : @dsl.Session) -> Unit raise {
  println("  all three in one request")
  println("")
  let questions : Map[String, @lib.Question] = Map([])
  questions["milk"] = @lib.Question::noul("家に牛乳がない")
  questions["snack"] = @lib.Question::choice_of(
    snacks,
    instructions="100円余ったときに買うもの",
  )
  questions["urgency"] = @lib.Question::score(
    urgency_levels,
    instructions="買い物に行く急ぎ度",
  )
  let answers = jev.ask(questions)

  // Identical match shapes — only where the answers came from changed.
  match answers.noul("milk") {
    (true, c) if c > 0.5 => println("  牛乳を買う            (missing, confident \{@report.d2(c)})")
    (true, c) => println("  牛乳は確認してから    (missing, but only \{@report.d2(c)} sure)")
    (false, c) => println("  牛乳はある            (present, \{@report.d2(c)} sure)")
  }
  match answers.choice("snack") {
    (pick, c) if c > 0.5 => println("  \{pick} を買う          (confident \{@report.d2(c)})")
    (pick, c) => println("  \{pick} は迷っている     (\{@report.d2(c)})")
  }
  match answers.score("urgency") {
    (s, c) if s >= 1.5 && c > 0.5 => println("  今すぐ出る            (\{@report.d2(s)}/2, \{@report.d2(c)})")
    (s, _) if s >= 0.5 => println("  今日のうちに          (\{@report.d2(s)}/2)")
    (s, _) => println("  今日でなくてよい      (\{@report.d2(s)}/2)")
  }
}

///|
async fn run(opts : Opts) -> Unit raise {
  let client = if opts.base_url == "https://api.typesafe.ai" {
    @lib.Client::new(opts.api_key)
  } else {
    @lib.Client::with_base_url(opts.api_key, opts.base_url)
  }
  let jev = @dsl.session(client, kitchen_state(), model=opts.model)
  @report.header("JEVDSL", "judgments you can match on")
  println("")
  if opts.bundled {
    bundled(jev)
  } else {
    one_at_a_time(jev)
  }
  let (requests, tokens) = jev.spent()
  println("")
  println(
    "  \{requests} request(s) · \{tokens} input tokens · $\{@report.fixed(tokens.to_double() / 1000000.0 * 0.042, 5)}",
  )
}

// ----------------------------------------------------------------- plumbing

///|
async fn main {
  let cmd = @argparse.Command(
    "jevdsl",
    about="Demo of the jevdsl wrapper: Jev judgments you can `match` on.",
    flags=[
      @argparse.FlagArg(
        "bundled",
        long="bundled",
        action=SetTrue,
        about="Ask all three judgments in one request instead of three.",
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
    ],
  )
  let matches = @argparse.parse(cmd) catch {
    msg => {
      @stdio.stderr.write("jevdsl: \{msg}\n")
      @sys.exit(2)
      return
    }
  }
  let api_key = match opt_value(matches, "api-key") {
    Some(k) if !k.is_empty() => k
    _ =>
      match @env.get_env_var("TYPESAFEAI_API_KEY") {
        Some(k) => k
        _ => ""
      }
  }
  if api_key.is_empty() {
    @stdio.stderr.write("jevdsl: no API key. Set TYPESAFEAI_API_KEY.\n")
    @sys.exit(1)
    return
  }
  let opts = {
    api_key,
    base_url: opt_value(matches, "base-url").unwrap_or(
      "https://api.typesafe.ai",
    ),
    model: opt_value(matches, "model").unwrap_or("jev-latest"),
    bundled: matches.flags.get("bundled").unwrap_or(false),
  }
  run(opts) catch {
    @lib.ApiError::Http(code, reason, body) => {
      @stdio.stderr.write(
        "jevdsl: HTTP \{code} \{reason}: \{@report.clip(body, 300)}\n",
      )
      @sys.exit(1)
    }
    @lib.ApiError::InvalidResponse(msg) | @lib.ApiError::InvalidRequest(msg) => {
      @stdio.stderr.write("jevdsl: \{msg}\n")
      @sys.exit(1)
    }
    _ => {
      @stdio.stderr.write("jevdsl: unexpected error\n")
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
