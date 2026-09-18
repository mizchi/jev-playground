///|
/// A player: one process, one team, one Jev client.
///
/// It connects to the referee, receives only its own team's observation and
/// legal moves each tick, asks Jev what its champions should do, and replies.
/// It has no access to the game state or to the other team — the referee is
/// the only thing it talks to, and the other side's information never reaches
/// it. This is the same team logic as the single-process `cmd/moba`, split out
/// so the two sides genuinely run apart.
///
///   moon run --target native cmd/moba_player -- --team A --port 8971
struct Opts {
  team : String
  port : Int
  model : String
  api_key : String
  base_url : String
  verbose : Bool
}

///|
async fn main {
  let cmd = @argparse.Command(
    "moba_player",
    about="One MOBA team, driven by Jev in its own process. Talks only to the referee.",
    flags=[
      @argparse.FlagArg("verbose", long="verbose", about="Print every decision."),
    ],
    options=[
      @argparse.OptionArg("team", long="team", default_values=["A"], about="Which side: A or B."),
      @argparse.OptionArg("port", long="port", default_values=["8971"], about="Referee TCP port."),
      @argparse.OptionArg(
        "model",
        long="model",
        default_values=["jev-latest"],
        about="Jev model or alias.",
      ),
      @argparse.OptionArg("api-key", long="api-key", about="API key (defaults to TYPESAFEAI_API_KEY)."),
      @argparse.OptionArg("base-url", long="base-url", about="API base URL."),
    ],
  )
  let matches = @argparse.parse(cmd) catch {
    msg => {
      @stdio.stderr.write("moba_player: usage: \{msg}\n")
      @sys.exit(1)
      return
    }
  }
  let api_key = match opt(matches, "api-key") {
    Some(k) if !k.is_empty() => k
    _ =>
      match @env.get_env_var("TYPESAFEAI_API_KEY") {
        Some(k) if !k.is_empty() => k
        _ => ""
      }
  }
  if api_key.is_empty() {
    @stdio.stderr.write("moba_player: no API key; set TYPESAFEAI_API_KEY or pass --api-key\n")
    @sys.exit(1)
    return
  }
  let opts : Opts = {
    team: opt(matches, "team").unwrap_or("A"),
    port: match opt(matches, "port") {
      Some(s) => @string.from_str(s) catch { _ => 8971 }
      None => 8971
    },
    model: opt(matches, "model").unwrap_or("jev-latest"),
    api_key,
    base_url: opt(matches, "base-url").unwrap_or("https://api.typesafe.ai"),
    verbose: matches.flags.get("verbose").unwrap_or(false),
  }
  play(opts) catch {
    err => {
      @stdio.stderr.write("moba_player[\{opts.team}]: \{err}\n")
      @sys.exit(1)
    }
  }
}

///|
struct Stats {
  mut requests : Int
  mut input_tokens : Int
  mut decisions : Int
  mut api_ms : Int
  mut fallback_ticks : Int
}

///|
async fn play(opts : Opts) -> Unit raise {
  let client = if opts.base_url == "https://api.typesafe.ai" {
    @lib.Client::new(opts.api_key)
  } else {
    @lib.Client::with_base_url(opts.api_key, opts.base_url)
  }
  let conn = @socket.Tcp::connect(@socket.Addr::parse("127.0.0.1:\{opts.port}"))
  // Handshake: announce which side we play.
  conn.write(Json({ "type": Json("hello"), "team": Json(opts.team) }).stringify() + "\n")
  @stdio.stdout.write("player \{opts.team}: connected to referee on \{opts.port}\n")
  let stats : Stats = {
    requests: 0,
    input_tokens: 0,
    decisions: 0,
    api_ms: 0,
    fallback_ticks: 0,
  }
  // Serve turns until the referee says goodbye.
  while true {
    let line = match conn.read_until("\n") {
      Some(s) => s
      None => break
    }
    if line.length() < 2 {
      continue
    }
    let msg = @json.parse(line)
    match message_type(msg) {
      "turn" => {
        let reply = handle_turn(client, opts, msg, stats)
        conn.write(reply + "\n")
      }
      "over" => {
        if opts.verbose {
          @stdio.stdout.write("player \{opts.team}: game over — \{describe_over(msg)}\n")
        }
      }
      "bye" => break
      other => @stdio.stderr.write("player \{opts.team}: unknown message '\{other}'\n")
    }
  }
  let per = if stats.requests > 0 {
    stats.api_ms / stats.requests
  } else {
    0
  }
  @stdio.stdout.write(
    "player \{opts.team}: done — \{stats.requests} requests, \{stats.decisions} decisions, " +
    "\{stats.input_tokens} input tokens, \{per} ms/request" +
    (if stats.fallback_ticks > 0 { ", \{stats.fallback_ticks} fallback ticks" } else { "" }) +
    "\n",
  )
}

///|
/// Build the Jev request from this tick's turn message, and return the actions
/// reply as a JSON line. One choice per living champion over exactly its legal
/// moves, plus the two team-level reads from docs/02.
async fn handle_turn(
  client : @lib.Client,
  opts : Opts,
  msg : Json,
  stats : Stats,
) -> String {
  let tick = json_int(field(msg, "tick"))
  let champions = json_array(field(msg, "champions"))
  let actions_out : Map[String, Json] = Map([])
  if champions.is_empty() {
    // Nothing alive to move this tick.
    return reply_line(tick, actions_out)
  }
  let qs : Map[String, @lib.Question] = Map([])
  // champion id -> its legal action strings, to validate the answer.
  let legal : Map[Int, Array[String]] = Map([])
  for cj in champions {
    let id = json_int(field(cj, "id"))
    let name = json_str(field(cj, "name"))
    let role = json_str(field(cj, "role"))
    let hp = json_int(field(cj, "hp"))
    let criteria : Map[String, String] = Map([])
    let keys = []
    match field(cj, "actions") {
      Some(Json::Object(acts)) =>
        for k, v in acts {
          match v {
            Json::String(s) => {
              criteria[k] = s
              keys.push(k)
            }
            _ => ()
          }
        }
      _ => ()
    }
    if criteria.is_empty() {
      continue
    }
    legal[id] = keys
    qs["champ_\{id}"] = @lib.Question::choice(
      criteria,
      instructions="What should \{name} (the \{role} laner, hp \{hp}) do this tick? Win the game: take towers and then the base. Do not feed kills, and do not walk alone into places you cannot see.",
    )
  }
  if qs.is_empty() {
    return reply_line(tick, actions_out)
  }
  qs["danger"] = @lib.Question::score(
    ["Safe, keep pushing", "Trade carefully", "Back off and regroup", "Our base is about to fall"],
    instructions="How much danger is our team in right now?",
  )
  let nodes = []
  for n in json_array(field(msg, "all_nodes")) {
    match n {
      Json::String(s) => nodes.push(s)
      _ => ()
    }
  }
  qs["enemy_probably_at"] = @lib.Question::choice_of(
    nodes,
    instructions="The enemies you cannot see right now — which node are they most likely grouped at?",
  )
  let state = field(msg, "observation").unwrap_or(Json::null())
  let t0 = @env.now()
  let resp = client.system_one({ state, model: opts.model, questions: qs }) catch {
    _ => {
      // A player that cannot reach Jev holds everything this tick, and says so.
      stats.fallback_ticks += 1
      return reply_line(tick, actions_out)
    }
  }
  stats.api_ms += (@env.now() - t0).to_int()
  stats.requests += 1
  stats.input_tokens += resp.input_tokens
  for entry in legal {
    let (id, keys) = entry
    let (choice, conf) = @report.choice_at(resp, "champ_\{id}")
    if keys.contains(choice) {
      actions_out["\{id}"] = Json(choice)
      stats.decisions += 1
      if opts.verbose {
        @stdio.stdout.write("  \{opts.team} champ \{id}: \{choice} (\{@report.d2(conf)})\n")
      }
    }
  }
  if opts.verbose {
    let (danger, _) = @report.score_at(resp, "danger")
    let (guess, _) = @report.choice_at(resp, "enemy_probably_at")
    @stdio.stdout.write(
      "  \{opts.team} [read] danger=\{@report.d2(danger)}/3 unseen-at=\{guess} (\{resp.input_tokens} tok)\n",
    )
  }
  reply_line(tick, actions_out)
}

// ----------------------------------------------------------------- plumbing

///|
fn reply_line(tick : Int, actions : Map[String, Json]) -> String {
  Json({
    "type": Json("actions"),
    "tick": Json(tick),
    "actions": Json(actions),
  }).stringify()
}

///|
fn message_type(msg : Json) -> String {
  match field(msg, "type") {
    Some(Json::String(s)) => s
    _ => "?"
  }
}

///|
fn describe_over(msg : Json) -> String {
  let w = json_str(field(msg, "winner"))
  let r = json_str(field(msg, "reason"))
  "winner \{w}; \{r}"
}

///|
fn field(j : Json, key : String) -> Json? {
  match j {
    Json::Object(fields) => fields.get(key)
    _ => None
  }
}

///|
fn json_int(j : Json?) -> Int {
  match j {
    Some(Json::Number(n, ..)) => n.to_int()
    _ => 0
  }
}

///|
fn json_str(j : Json?) -> String {
  match j {
    Some(Json::String(s)) => s
    _ => ""
  }
}

///|
fn json_array(j : Json?) -> Array[Json] {
  match j {
    Some(Json::Array(items)) => items
    _ => []
  }
}

///|
fn opt(matches : @argparse.Matches, key : String) -> String? {
  match matches.values.get(key) {
    Some(arr) if arr.length() > 0 => Some(arr[0])
    _ => None
  }
}
