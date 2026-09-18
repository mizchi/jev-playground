///|
/// The referee: owns the authoritative game, and never talks to Jev.
///
/// It listens on TCP, accepts one connection per team, and each tick sends
/// each team only its own observation and its own legal moves, waits for both
/// replies, applies them, and steps. Fog of war is enforced by the wire: a
/// player process is handed nothing about the other side beyond what its
/// observation already reveals.
///
/// The two teams' turns are sent and awaited concurrently, so the two player
/// processes run their Jev calls in parallel and a tick costs about one
/// request's latency rather than two.
///
///   moon run --target native cmd/moba_referee -- --port 8971 --games 2
struct Opts {
  port : Int
  games : Int
  max_ticks : Int
  verbose : Bool
  comp_a : Array[String]
  comp_b : Array[String]
  /// If non-empty, each game g is written to `<replay>.gN.jsonl`.
  replay : String
}

///|
async fn main {
  let cmd = @argparse.Command(
    "moba_referee",
    about="Authoritative MOBA referee: owns the game, serves two team clients over TCP.",
    flags=[
      @argparse.FlagArg("verbose", long="verbose", about="Print every tick."),
    ],
    options=[
      @argparse.OptionArg(
        "port",
        long="port",
        default_values=["8971"],
        about="TCP port to listen on (127.0.0.1).",
      ),
      @argparse.OptionArg(
        "games",
        long="games",
        default_values=["1"],
        about="How many games to referee before closing.",
      ),
      @argparse.OptionArg(
        "max-ticks",
        long="max-ticks",
        default_values=["60"],
        about="Tick cap; the tie breaks on structure damage.",
      ),
      @argparse.OptionArg(
        "a-comp",
        long="a-comp",
        about="Team A composition, comma-separated top,jungle,bot. Default classic×3.",
      ),
      @argparse.OptionArg(
        "b-comp",
        long="b-comp",
        about="Team B composition, comma-separated top,jungle,bot. Default classic×3.",
      ),
      @argparse.OptionArg(
        "replay",
        long="replay",
        about="Write each game g to <replay>.gN.jsonl for cmd/moba_replay.",
      ),
    ],
  )
  let matches = @argparse.parse(cmd) catch {
    msg => {
      @stdio.stderr.write("moba_referee: usage: \{msg}\n")
      @sys.exit(1)
      return
    }
  }
  let opts : Opts = {
    port: int_opt(matches, "port", 8971),
    games: int_opt(matches, "games", 1),
    max_ticks: int_opt(matches, "max-ticks", 60),
    verbose: matches.flags.get("verbose").unwrap_or(false),
    comp_a: split_comp(str_opt(matches, "a-comp")),
    comp_b: split_comp(str_opt(matches, "b-comp")),
    replay: str_opt(matches, "replay").unwrap_or(""),
  }
  serve(opts) catch {
    err => {
      @stdio.stderr.write("moba_referee: \{err}\n")
      @sys.exit(1)
    }
  }
}

///|
/// One connected team: the socket plus which side it plays.
struct Client {
  conn : @socket.Tcp
  team : Int
}

///|
async fn serve(opts : Opts) -> Unit {
  let server = @socket.TcpServer(
    @socket.Addr::parse("127.0.0.1:\{opts.port}"),
    reuse_addr=true,
  )
  @stdio.stdout.write("referee: listening on 127.0.0.1:\{opts.port}\n")
  // Accept exactly two teams. Each sends `{"type":"hello","team":"A"|"B"}`.
  let clients : Array[Client] = []
  while clients.length() < 2 {
    let (conn, _addr) = server.accept()
    let hello = read_line(conn)
    let team = parse_hello(hello)
    clients.push({ conn, team, })
    @stdio.stdout.write("referee: team \{team_name(team)} connected\n")
  }
  let client_a = find_client(clients, @game.TEAM_A)
  let client_b = find_client(clients, @game.TEAM_B)

  let mut a_wins = 0
  let mut b_wins = 0
  let mut draws = 0
  for gi in 0..<opts.games {
    let result = play_game(opts, client_a, client_b, gi)
    match result {
      1 => a_wins += 1
      2 => b_wins += 1
      _ => draws += 1
    }
  }
  // Tell both players there is no more work, and close.
  let bye = Json({ "type": Json("bye") }).stringify() + "\n"
  client_a.conn.write(bye)
  client_b.conn.write(bye)
  @stdio.stdout.write(
    "referee: done — A \{a_wins} — \{b_wins} B\{if draws > 0 { " (\{draws} draw)" } else { "" }}\n",
  )
  server.close()
}

///|
/// Run one game to completion, returning the winning team (0 for a draw).
async fn play_game(
  opts : Opts,
  client_a : Client,
  client_b : Client,
  index : Int,
) -> Int {
  let g = @game.Game::with_comps(opts.comp_a, opts.comp_b)
  let mem_a = @game.Memory::new()
  let mem_b = @game.Memory::new()
  let replay = [
    g
    .replay_meta("jev", "jev", opts.comp_a, opts.comp_b, opts.max_ticks)
    .stringify(),
    g.replay_frame().stringify(),
  ]
  if opts.verbose {
    @stdio.stdout.write("referee: --- game \{index + 1} ---\n")
  }
  // Wall time across ticks, to check the concurrency claim: with both teams
  // deciding in parallel, ms/tick should track a single Jev request, not two.
  let wall0 = @env.now()
  while g.winner == 0 && g.tick < opts.max_ticks {
    mem_a.observe(g, @game.TEAM_A)
    mem_b.observe(g, @game.TEAM_B)
    let turn_a = g.turn_message(@game.TEAM_A, mem_a).stringify() + "\n"
    let turn_b = g.turn_message(@game.TEAM_B, mem_b).stringify() + "\n"

    // Both exchanges run concurrently, so the two player processes think in
    // parallel. Each returns champion-id -> chosen action string.
    let replies : Map[Int, Map[Int, String]] = Map([])
    @async.with_task_group(group => {
      group.spawn_bg(() => {
        replies.set(@game.TEAM_A, exchange(client_a.conn, turn_a))
      })
      group.spawn_bg(() => {
        replies.set(@game.TEAM_B, exchange(client_b.conn, turn_b))
      })
    })

    // Resolve each team's strings back into actions against the live state.
    let actions : Map[Int, @game.Action] = Map([])
    for team_reply in [replies.get(@game.TEAM_A), replies.get(@game.TEAM_B)] {
      match team_reply {
        Some(chosen) =>
          for entry in chosen {
            let (id, s) = entry
            let c = g.champs[id]
            match g.legal_action_map(c).get(s) {
              Some(a) => actions[id] = a
              // A player naming a move it was not offered: hold, and note it.
              None =>
                if opts.verbose {
                  @stdio.stdout.write(
                    "referee: \{c.name} sent illegal '\{s}', holding\n",
                  )
                }
            }
          }
        None => ()
      }
    }
    g.step(actions)
    replay.push(g.replay_frame().stringify())
    if opts.verbose && g.log.length() > 0 {
      let last = g.log[g.log.length() - 1]
      if last.has_prefix("t\{g.tick}:") {
        @stdio.stdout.write("  \{last}\n")
      }
    }
  }
  let a_hp = g.structure_hp(@game.TEAM_A)
  let b_hp = g.structure_hp(@game.TEAM_B)
  let winner = if g.winner != 0 {
    g.winner
  } else if b_hp < a_hp {
    @game.TEAM_A
  } else if a_hp < b_hp {
    @game.TEAM_B
  } else {
    0
  }
  // Tell both teams the game is over, so they stop waiting on a turn.
  let over = Json({
      "type": Json("over"),
      "tick": Json(g.tick),
      "winner": Json(
        match winner {
          1 => "A"
          2 => "B"
          _ => "draw"
        },
      ),
      "reason": Json(g.over_reason()),
      "a_structure_hp": Json(a_hp),
      "b_structure_hp": Json(b_hp),
    }).stringify() +
    "\n"
  client_a.conn.write(over)
  client_b.conn.write(over)
  let wlabel = match winner {
    1 => "A"
    2 => "B"
    _ => "draw"
  }
  let wall = (@env.now() - wall0).to_int()
  let per_tick = if g.tick > 0 { wall / g.tick } else { 0 }
  @stdio.stdout.write(
    "referee: game \{index + 1}: \{wlabel} after \{g.tick} ticks (structures A=\{a_hp} B=\{b_hp}); \{per_tick} ms/tick wall\n",
  )
  if opts.replay != "" {
    replay.push(g.replay_result(winner).stringify())
    let path = "\{opts.replay}.g\{index + 1}.jsonl"
    @fs.write_file(path, replay.join("\n") + "\n")
    @stdio.stdout.write("referee: replay written to \{path}\n")
  }
  winner
}

///|
/// Send a team its turn, read its reply, return champion-id -> action string.
/// Never raises: a read/parse failure (a crashed player) yields an empty map,
/// which the referee treats as every champion holding, so one side dying does
/// not take the whole game down.
async fn exchange(conn : @socket.Tcp, turn : String) -> Map[Int, String] {
  let out : Map[Int, String] = Map([])
  let line = try {
    conn.write(turn)
    conn.read_until("\n").unwrap_or("")
  } catch {
    _ => ""
  }
  if line == "" {
    return out
  }
  let json = @json.parse(line) catch { _ => return out }
  match json {
    Json::Object(fields) =>
      match fields.get("actions") {
        Some(Json::Object(acts)) =>
          for k, v in acts {
            let id : Int = @string.from_str(k) catch { _ => continue }
            match v {
              Json::String(s) => out[id] = s
              _ => ()
            }
          }
        _ => ()
      }
    _ => ()
  }
  out
}

// ----------------------------------------------------------------- plumbing

///|
async fn read_line(conn : @socket.Tcp) -> String {
  match conn.read_until("\n") {
    Some(s) => s
    None => fail("connection closed")
  }
}

///|
fn parse_hello(line : String) -> Int raise {
  let json = @json.parse(line)
  match json {
    Json::Object(fields) =>
      match fields.get("team") {
        Some(Json::String("A")) => @game.TEAM_A
        Some(Json::String("B")) => @game.TEAM_B
        _ => fail("hello without a valid team: \{line}")
      }
    _ => fail("hello was not a JSON object: \{line}")
  }
}

///|
fn find_client(clients : Array[Client], team : Int) -> Client raise {
  for c in clients {
    if c.team == team {
      return c
    }
  }
  fail("no client for team \{team_name(team)}")
}

///|
fn team_name(team : Int) -> String {
  if team == @game.TEAM_A {
    "A"
  } else {
    "B"
  }
}

///|
fn int_opt(matches : @argparse.Matches, key : String, dflt : Int) -> Int {
  match matches.values.get(key) {
    Some(arr) if arr.length() > 0 =>
      @string.from_str(arr[0]) catch {
        _ => dflt
      }
    _ => dflt
  }
}

///|
fn str_opt(matches : @argparse.Matches, key : String) -> String? {
  match matches.values.get(key) {
    Some(arr) if arr.length() > 0 => Some(arr[0])
    _ => None
  }
}

///|
/// Comma-separated composition into exactly three archetype keys; empty means
/// classic×3. Spaces are dropped (champion keys never contain them).
fn split_comp(v : String?) -> Array[String] {
  let raw = match v {
    Some(s) => s
    None => ""
  }
  let parts : Array[String] = []
  let cur = StringBuilder()
  for ch in raw {
    if ch == ',' {
      parts.push(cur.to_string())
      cur.reset()
    } else if ch != ' ' {
      cur.write_char(ch)
    }
  }
  parts.push(cur.to_string())
  let out : Array[String] = []
  for i in 0..<3 {
    if i < parts.length() && parts[i] != "" {
      out.push(parts[i])
    } else {
      out.push("classic")
    }
  }
  out
}
