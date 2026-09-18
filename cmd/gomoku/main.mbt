///|
/// Gomoku (five-in-a-row) Jev vs Jev: two TypeSafe AI Jev players decide every
/// move through the Jev API. Each move is one `system_one` call whose choice
/// question lists every candidate cell with a short per-cell evaluation
/// (win/block hints and line-run info computed in code). If the API fails or
/// returns something unusable, a built-in fallback decides the move.
struct Options {
  games : Int
  board_size : Int
  player1 : String
  player2 : String
  api_key : String
  base_url : String
  verbose : Bool
  log_path : String?
}

///|
struct MoveInfo {
  row : Int
  col : Int
  name : String
  confidence : Double
  fallback : Bool
  input_tokens : Int
  output_tokens : Int
}

///|
async fn main {
  let matches = @argparse.parse(
    @argparse.Command(
      "gomoku",
      about="Play Gomoku with two Jev players (TypeSafe AI System One model).",
      flags=[
        @argparse.FlagArg(
          "verbose",
          long="verbose",
          about="Print the board after every move.",
        ),
      ],
      options=[
        @argparse.OptionArg(
          "api-key",
          long="api-key",
          about="API key (defaults to TYPESAFEAI_API_KEY).",
        ),
        @argparse.OptionArg(
          "base-url",
          long="base-url",
          about="API base URL (default https://api.typesafe.ai).",
        ),
        @argparse.OptionArg(
          "games",
          long="games",
          default_values=["1"],
          about="Number of games to play.",
        ),
        @argparse.OptionArg(
          "board",
          long="board",
          default_values=["15"],
          about="Board size N (N x N).",
        ),
        @argparse.OptionArg(
          "player1",
          long="player1",
          default_values=["jev-latest"],
          about="Model for X (first player).",
        ),
        @argparse.OptionArg(
          "player2",
          long="player2",
          default_values=["jev-latest"],
          about="Model for O (second player).",
        ),
        @argparse.OptionArg(
          "log-path",
          long="log-path",
          about="Write a JSONL move log (for GIF animation).",
        ),
      ],
    ),
  ) catch {
    msg => raise @lib.ApiError::InvalidResponse("usage: \{msg}")
  }
  let api_key = resolve_api_key(matches)
  if api_key.is_empty() {
    @stdio.stderr.write(
      "gomoku: no API key; set TYPESAFEAI_API_KEY or pass --api-key\n",
    )
    @sys.exit(1)
    return
  }
  let opts : Options = {
    games: int_option(matches, "games", 1),
    board_size: int_option(matches, "board", 15),
    player1: opt_value(matches, "player1").unwrap_or("jev-latest"),
    player2: opt_value(matches, "player2").unwrap_or("jev-latest"),
    api_key,
    base_url: opt_value(matches, "base-url").unwrap_or(
      "https://api.typesafe.ai",
    ),
    verbose: matches.flags.get("verbose").unwrap_or(false),
    log_path: opt_value(matches, "log-path"),
  }
  let client = if opts.base_url == "https://api.typesafe.ai" {
    @lib.Client::new(opts.api_key)
  } else {
    @lib.Client::with_base_url(opts.api_key, opts.base_url)
  }
  for g in 0..<opts.games {
    play_game(opts, client, g) catch {
      @lib.ApiError::Http(code, reason, body) => {
        @stdio.stderr.write("gomoku: HTTP \{code} \{reason}: \{clamp(body)}\n")
        @sys.exit(1)
      }
      @lib.ApiError::InvalidResponse(msg) => {
        @stdio.stderr.write("gomoku: \{msg}\n")
        @sys.exit(1)
      }
      _ => {
        @stdio.stderr.write("gomoku: unexpected error\n")
        @sys.exit(1)
      }
    }
  }
}

///|
fn resolve_api_key(matches : @argparse.Matches) -> String {
  match opt_value(matches, "api-key") {
    Some(k) if !k.is_empty() => k
    _ =>
      match @env.get_env_var("TYPESAFEAI_API_KEY") {
        Some(k) if !k.is_empty() => k
        _ => ""
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

///|
fn int_option(matches : @argparse.Matches, key : String, dflt : Int) -> Int {
  match opt_value(matches, key) {
    Some(t) => @string.from_str(t) catch { _ => dflt }
    None => dflt
  }
}

///|
async fn play_game(opts : Options, client : @lib.Client, game_no : Int) -> Unit {
  let board = @game.Board::new(opts.board_size)
  let history : Array[String] = []
  let mut winner = 0
  let mut turn = @game.STONE_X
  let mut total_in = 0
  let mut total_out = 0
  let mut fallbacks = 0
  let mut moves = 0
  let mut sum_ms = 0
  let start_ms = @env.now()
  let log_lines : Array[String] = []
  log_lines.push(
    Json({
      "type": Json("game"),
      "board_size": Json(opts.board_size),
      "player1": Json(opts.player1),
      "player2": Json(opts.player2),
    }).stringify(),
  )
  println(
    "=== game \{game_no + 1}: X=jev(\{opts.player1}) vs O=jev(\{opts.player2}) on \{opts.board_size}x\{opts.board_size} ===",
  )
  while !board.is_full() && winner == 0 {
    let stone = turn
    let model = if stone == @game.STONE_X { opts.player1 } else { opts.player2 }
    let t0 = @env.now()
    let info = pick_move(client, board, stone, model, history)
    let elapsed_ms = (@env.now() - t0).to_int()
    sum_ms += elapsed_ms
    board.place(info.row, info.col, stone)
    let mark = if stone == @game.STONE_X { "X" } else { "O" }
    history.push("\{mark}\{info.name}")
    if info.fallback {
      fallbacks += 1
    }
    total_in += info.input_tokens
    total_out += info.output_tokens
    moves += 1
    println(
      "move \{moves}: \{mark} plays \{info.name} (\{elapsed_ms} ms, confidence \{(info.confidence * 100.0).to_int()}%)\{if info.fallback { " [fallback]" } else { "" }}",
    )
    log_lines.push(
      Json({
        "type": Json("move"),
        "move": Json(moves),
        "stone": Json(mark),
        "cell": Json(info.name),
        "elapsed_ms": Json(elapsed_ms),
        "confidence": Json(info.confidence),
        "fallback": Json(info.fallback),
        "win": Json(board.has_won(info.row, info.col, stone)),
        "input_tokens": Json(info.input_tokens),
        "output_tokens": Json(info.output_tokens),
      }).stringify(),
    )
    if opts.verbose {
      println(board.render())
      println("")
    }
    if board.has_won(info.row, info.col, stone) {
      winner = stone
    }
    turn = if stone == @game.STONE_X { @game.STONE_O } else { @game.STONE_X }
  }
  let total_ms = (@env.now() - start_ms).to_int()
  println("")
  println(board.render())
  let result = if winner == @game.STONE_X {
    "X (jev \{opts.player1}) wins"
  } else if winner == @game.STONE_O {
    "O (jev \{opts.player2}) wins"
  } else {
    "draw"
  }
  println(
    "result: \{result} in \{moves} moves; input tokens \{total_in}, output \{total_out}; fallback moves \{fallbacks}",
  )
  println(
    "game took \{format_ms(total_ms)} (sum of per-move decision time \{format_ms(sum_ms)})",
  )
  log_lines.push(
    Json({
      "type": Json("result"),
      "winner": Json(
        if winner == @game.STONE_X {
          "X"
        } else if winner == @game.STONE_O {
          "O"
        } else {
          "draw"
        },
      ),
      "moves": Json(moves),
      "total_ms": Json(total_ms),
      "decision_ms": Json(sum_ms),
    }).stringify(),
  )
  match opts.log_path {
    Some(p) => @fs.write_file(p, log_lines.join("\n") + "\n")
    None => ()
  }
  println("")
}

///|
async fn pick_move(
  client : @lib.Client,
  board : @game.Board,
  stone : Int,
  model : String,
  history : Array[String],
) -> MoveInfo {
  let cands = board.candidates()
  let criteria : Map[String, String] = Map([])
  for (r, c) in cands {
    let name = @game.cell_name(r, c)
    criteria[name] = describe_candidate(board, r, c, stone)
  }
  let state = Json({
    "game": Json("gomoku"),
    "board_size": Json(board.size),
    "you_play": Json(if stone == @game.STONE_X { "X" } else { "O" }),
    "rules": Json(
      "Place your stone on an empty cell. Five of your stones in a row (horizontal, vertical, or diagonal) wins.",
    ),
    "notation": Json(
      "Cell names use column letter + row number, e.g. h8. Line-run hints like '3o' mean 3 stones with an open end ('c' = closed); 'WINS' completes five, 'BLOCK' prevents the opponent's five.",
    ),
    "board": Json(board.render()),
    "moves_played": Json(history.length()),
    "recent_moves": Json(history),
  })
  let qs : Map[String, @lib.Question] = Map([])
  qs["move"] = @lib.Question::choice(
    criteria,
    instructions="Which empty cell should you play? Choose the single best move for this position.",
  )
  let req : @lib.SystemOneRequest = { state, model, questions: qs, }
  let fallback = default_move(board, stone)
  let fb : MoveInfo = {
    row: fallback.0,
    col: fallback.1,
    name: @game.cell_name(fallback.0, fallback.1),
    confidence: 0.0,
    fallback: true,
    input_tokens: 0,
    output_tokens: 0,
  }
  let resp = client.system_one(req) catch { _ => return fb }
  match resp.answers.get("move") {
    Some(@lib.Answer::ChoiceAnswer(choice, conf, _)) =>
      match @game.parse_cell(choice) {
        Some((r, c)) if board.stone_at(r, c) == 0 =>
          {
            row: r,
            col: c,
            name: choice,
            confidence: conf,
            fallback: false,
            input_tokens: resp.input_tokens,
            output_tokens: resp.output_tokens,
          }
        _ => fb
      }
    _ => fb
  }
}

///|
/// Win > block > nearest to center. Used when Jev cannot answer.
fn default_move(board : @game.Board, stone : Int) -> (Int, Int) {
  let opp = @game.STONE_X + @game.STONE_O - stone
  let cands = board.candidates()
  for (r, c) in cands {
    if board.line_of_stone(r, c, stone) >= 4 {
      return (r, c)
    }
  }
  for (r, c) in cands {
    if board.line_of_stone(r, c, opp) >= 4 {
      return (r, c)
    }
  }
  let mid = board.size / 2
  let mut best = cands[0]
  let mut best_d = (cands[0].0 - mid).abs() + (cands[0].1 - mid).abs()
  for (r, c) in cands {
    let d = (r - mid).abs() + (c - mid).abs()
    if d < best_d {
      best_d = d
      best = (r, c)
    }
  }
  best
}

///|
/// Short per-cell evaluation for the Jev choice question.
fn describe_candidate(
  board : @game.Board,
  r : Int,
  c : Int,
  stone : Int,
) -> String {
  let opp = @game.STONE_X + @game.STONE_O - stone
  let (my_run, my_open) = board.line_info(r, c, stone)
  let (op_run, op_open) = board.line_info(r, c, opp)
  if my_run >= 4 {
    "WINS: playing here completes five in a row"
  } else if op_run >= 4 {
    "BLOCK: prevents the opponent from completing five"
  } else {
    "your best line \{my_run}\{if my_open { "o" } else { "c" }}, opponent's best line \{op_run}\{if op_open { "o" } else { "c" }}"
  }
}

///|
fn clamp(s : String) -> String {
  let limit = 400
  if s.length() <= limit {
    s
  } else {
    s[:limit].to_owned() + "…"
  }
}

///|
fn format_ms(ms : Int) -> String {
  if ms < 1000 {
    "\{ms} ms"
  } else {
    "\{ms / 1000}.\{ms % 1000 / 100}s"
  }
}
