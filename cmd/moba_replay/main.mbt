///|
/// A terminal replay player for MOBA games recorded by `cmd/moba --replay` or
/// the referee. It reads the JSON-lines file — meta header, one frame per tick,
/// a result — and renders the board, HP bars and kill feed tick by tick.
///
/// The file is self-contained (the meta line carries the roster), so this
/// player never imports the game package; a later Web player can read exactly
/// the same file. TUI first, as asked; Web later.
///
///   moon run --target native cmd/moba_replay -- --file game.jsonl        # step with Enter
///   moon run --target native cmd/moba_replay -- --file game.jsonl --auto  # auto-play

///|
let c_cyan : String = "\u{1b}[36m"

///|
let c_magenta : String = "\u{1b}[35m"

///|
let c_green : String = "\u{1b}[32m"

///|
let c_yellow : String = "\u{1b}[33m"

///|
let c_red : String = "\u{1b}[31m"

///|
let c_dim : String = "\u{1b}[2m"

///|
let c_reset : String = "\u{1b}[0m"

///|
let clear_screen : String = "\u{1b}[2J\u{1b}[H"

// ------------------------------------------------------------------- records

///|
struct ChampInfo {
  team : String
  role : String
  kind : String
  deals : String
  frontline : Bool
  max_hp : Int
}

///|
struct ChampState {
  hp : Int
  at : String
  gold : Int
  alive : Bool
  respawn : Int
  kills : Int
  deaths : Int
}

///|
struct StructState {
  at : String
  kind : String
  hp : Int
}

///|
struct Frame {
  tick : Int
  champs : Map[Int, ChampState]
  structs : Array[StructState]
  event : String
}

///|
struct Meta {
  a_policy : String
  b_policy : String
  comp_a : Array[String]
  comp_b : Array[String]
  champs : Map[Int, ChampInfo]
  order : Array[Int]
}

// ------------------------------------------------------------------- parsing

///|
fn field(j : Json, k : String) -> Json? {
  match j {
    Json::Object(f) => f.get(k)
    _ => None
  }
}

///|
fn as_int(j : Json?) -> Int {
  match j {
    Some(Json::Number(n, ..)) => n.to_int()
    _ => 0
  }
}

///|
fn as_str(j : Json?) -> String {
  match j {
    Some(Json::String(s)) => s
    _ => ""
  }
}

///|
fn as_bool(j : Json?) -> Bool {
  match j {
    Some(Json::True) => true
    _ => false
  }
}

///|
fn as_arr(j : Json?) -> Array[Json] {
  match j {
    Some(Json::Array(a)) => a
    _ => []
  }
}

///|
fn as_strs(j : Json?) -> Array[String] {
  let out = []
  for x in as_arr(j) {
    match x {
      Json::String(s) => out.push(s)
      _ => ()
    }
  }
  out
}

///|
fn parse_meta(j : Json) -> Meta {
  let champs : Map[Int, ChampInfo] = Map([])
  let order = []
  for cj in as_arr(field(j, "champions")) {
    let id = as_int(field(cj, "id"))
    champs[id] = {
      team: as_str(field(cj, "team")),
      role: as_str(field(cj, "role")),
      kind: as_str(field(cj, "kind")),
      deals: as_str(field(cj, "deals")),
      frontline: as_bool(field(cj, "frontline")),
      max_hp: as_int(field(cj, "max_hp")),
    }
    order.push(id)
  }
  {
    a_policy: as_str(field(j, "a_policy")),
    b_policy: as_str(field(j, "b_policy")),
    comp_a: as_strs(field(j, "comp_a")),
    comp_b: as_strs(field(j, "comp_b")),
    champs,
    order,
  }
}

///|
fn parse_frame(j : Json) -> Frame {
  let champs : Map[Int, ChampState] = Map([])
  for cj in as_arr(field(j, "champs")) {
    let id = as_int(field(cj, "id"))
    champs[id] = {
      hp: as_int(field(cj, "hp")),
      at: as_str(field(cj, "at")),
      gold: as_int(field(cj, "gold")),
      alive: as_bool(field(cj, "alive")),
      respawn: as_int(field(cj, "respawn")),
      kills: as_int(field(cj, "kills")),
      deaths: as_int(field(cj, "deaths")),
    }
  }
  let structs = []
  for sj in as_arr(field(j, "structures")) {
    structs.push({
      at: as_str(field(sj, "at")),
      kind: as_str(field(sj, "kind")),
      hp: as_int(field(sj, "hp")),
    })
  }
  {
    tick: as_int(field(j, "tick")),
    champs,
    structs,
    event: as_str(field(j, "event")),
  }
}

// ----------------------------------------------------------------- rendering

///|
/// Team letter + lane initial: At, Aj, Ab, Bt, Bj, Bb.
fn tag_of(info : ChampInfo) -> String {
  let r = match info.role {
    "jungle" => "j"
    "top" => "t"
    "bot" => "b"
    _ => "?"
  }
  info.team + r
}

///|
/// Left-justify to width with spaces.
fn pad(s : String, width : Int) -> String {
  let mut out = s
  while out.length() < width {
    out = out + " "
  }
  out
}

///|
/// A 10-cell coloured HP bar.
fn hp_bar(hp : Int, max : Int) -> String {
  let frac = if max <= 0 { 0.0 } else { hp.to_double() / max.to_double() }
  let mut filled = (frac * 10.0).to_int()
  if filled < 0 {
    filled = 0
  }
  if filled > 10 {
    filled = 10
  }
  let col = if frac > 0.6 {
    c_green
  } else if frac > 0.3 {
    c_yellow
  } else {
    c_red
  }
  let b = StringBuilder()
  b.write_string(col)
  for i in 0..<10 {
    b.write_string(if i < filled { "█" } else { "░" })
  }
  b.write_string(c_reset)
  b.to_string()
}

///|
/// The board: three graph rows, each node showing its structure and the living
/// champions standing on it. Plain text so column widths stay exact.
fn render_board(m : Meta, f : Frame) -> String {
  let cells = [
    (0, 1, "a_top"),
    (0, 2, "m_top"),
    (0, 3, "b_top"),
    (1, 0, "a_base"),
    (1, 1, "a_jg"),
    (1, 2, "m_jg"),
    (1, 3, "b_jg"),
    (1, 4, "b_base"),
    (2, 1, "a_bot"),
    (2, 2, "m_bot"),
    (2, 3, "b_bot"),
  ]
  let w = 15
  fn name_at(r : Int, c : Int) -> String {
    for cell in cells {
      let (rr, cc, nm) = cell
      if rr == r && cc == c {
        return nm
      }
    }
    ""
  }

  fn struct_str(nm : String) -> String {
    for s in f.structs {
      if s.at == nm && s.hp > 0 {
        let k = if s.kind == "base" { "base" } else { "twr" }
        return " \{k}\{s.hp}"
      }
    }
    ""
  }

  fn occ(nm : String) -> String {
    let tags = []
    for id in m.order {
      let info = m.champs.get(id).unwrap()
      match f.champs.get(id) {
        Some(st) => if st.alive && st.at == nm { tags.push(tag_of(info)) }
        None => ()
      }
    }
    tags.join(" ")
  }

  let out = StringBuilder()
  for r in 0..<3 {
    let l1 = StringBuilder()
    let l2 = StringBuilder()
    for c in 0..<5 {
      let nm = name_at(r, c)
      let top = if nm == "" { "" } else { nm + struct_str(nm) }
      let bot = if nm == "" { "" } else { occ(nm) }
      l1.write_string(pad(top, w))
      l2.write_string(pad(bot, w))
    }
    out.write_string(l1.to_string())
    out.write_string("\n")
    out.write_string(l2.to_string())
    out.write_string("\n\n")
  }
  out.to_string()
}

///|
/// The champion table: HP bar, position, gold, K/D, and a frontline marker.
fn render_table(m : Meta, f : Frame) -> String {
  let out = StringBuilder()
  for id in m.order {
    let info = m.champs.get(id).unwrap()
    let col = if info.team == "A" { c_cyan } else { c_magenta }
    let tag = tag_of(info)
    let kind = pad(info.kind, 9)
    let fl = if info.frontline { " \{c_dim}(wall)\{c_reset}" } else { "" }
    match f.champs.get(id) {
      Some(st) =>
        if st.alive {
          let bar = hp_bar(st.hp, info.max_hp)
          let hpn = pad("\{st.hp}/\{info.max_hp}", 8)
          out.write_string(
            "  \{col}\{tag}\{c_reset} \{kind} \{pad(st.at, 7)} \{bar} \{hpn} \{info.deals} g=\{pad(st.gold.to_string(), 4)} k/d \{st.kills}/\{st.deaths}\{fl}\n",
          )
        } else {
          out.write_string(
            "  \{col}\{tag}\{c_reset} \{kind} \{c_dim}dead — respawn in \{st.respawn}\{c_reset}\n",
          )
        }
      None => ()
    }
  }
  out.to_string()
}

///|
fn render_screen(m : Meta, f : Frame, idx : Int, total : Int) -> String {
  let out = StringBuilder()
  out.write_string(
    "  \{c_cyan}A\{c_reset} \{m.a_policy} [\{m.comp_a.join("/")}]   vs   \{c_magenta}B\{c_reset} \{m.b_policy} [\{m.comp_b.join("/")}]\n",
  )
  out.write_string("  tick \{f.tick}   frame \{idx + 1}/\{total}\n\n")
  out.write_string(render_board(m, f))
  out.write_string(render_table(m, f))
  if f.event != "" {
    out.write_string("\n  \{c_yellow}» \{f.event}\{c_reset}\n")
  }
  out.to_string()
}

// ------------------------------------------------------------------ playback

///|
fn split_lines(s : String) -> Array[String] {
  let out = []
  let cur = StringBuilder()
  for ch in s {
    if ch == '\n' {
      out.push(cur.to_string())
      cur.reset()
    } else if ch != '\r' {
      cur.write_char(ch)
    }
  }
  out.push(cur.to_string())
  out
}

///|
struct Opts {
  file : String
  auto : Bool
  ms : Int
  from : Int
  no_clear : Bool
}

///|
async fn play(opts : Opts) -> Unit {
  let text = @fs.read_file(opts.file).text()
  let mut meta : Meta? = None
  let frames = []
  let mut result = ""
  for line in split_lines(text) {
    if line == "" {
      continue
    }
    let j = @json.parse(line) catch { _ => continue }
    match as_str(field(j, "type")) {
      "meta" => meta = Some(parse_meta(j))
      "frame" => frames.push(parse_frame(j))
      "result" =>
        result = "winner \{as_str(field(j, "winner"))} after \{as_int(field(j, "ticks"))} ticks — \{as_str(field(j, "reason"))}"
      _ => ()
    }
  }
  let m = match meta {
    Some(x) => x
    None => {
      @stdio.stderr.write("moba_replay: no meta line in \{opts.file}\n")
      return
    }
  }
  let total = frames.length()
  for i in 0..<total {
    let f = frames[i]
    if f.tick < opts.from {
      continue
    }
    if !opts.no_clear {
      @stdio.stdout.write(clear_screen)
    }
    @stdio.stdout.write(render_screen(m, f, i, total))
    if opts.auto {
      if opts.ms > 0 {
        @async.Timer(opts.ms).wait()
      }
    } else {
      @stdio.stdout.write("  \{c_dim}[enter] next   [q] quit\{c_reset}\n")
      match @stdio.stdin.read_until("\n") {
        Some(s) => if s.has_prefix("q") { break }
        None => break
      }
    }
  }
  @stdio.stdout.write("\n  \{c_green}result: \{result}\{c_reset}\n\n")
}

///|
async fn main {
  let cmd = @argparse.Command(
    "moba_replay",
    about="Replay a recorded MOBA game in the terminal.",
    flags=[
      @argparse.FlagArg(
        "auto",
        long="auto",
        about="Auto-advance instead of waiting for Enter.",
      ),
      @argparse.FlagArg(
        "no-clear",
        long="no-clear",
        about="Do not clear the screen between frames (scroll instead).",
      ),
    ],
    options=[
      @argparse.OptionArg(
        "file",
        long="file",
        about="Replay file (JSON lines).",
      ),
      @argparse.OptionArg(
        "ms",
        long="ms",
        default_values=["800"],
        about="Milliseconds between frames in --auto mode.",
      ),
      @argparse.OptionArg(
        "from",
        long="from",
        default_values=["0"],
        about="Start rendering at this tick.",
      ),
    ],
  )
  let matches = @argparse.parse(cmd) catch {
    msg => {
      @stdio.stderr.write("moba_replay: usage: \{msg}\n")
      @sys.exit(1)
      return
    }
  }
  let file = match opt(matches, "file") {
    Some(f) if !f.is_empty() => f
    _ => {
      @stdio.stderr.write("moba_replay: --file is required\n")
      @sys.exit(1)
      return
    }
  }
  let opts : Opts = {
    file,
    auto: matches.flags.get("auto").unwrap_or(false),
    ms: int_opt(matches, "ms", 800),
    from: int_opt(matches, "from", 0),
    no_clear: matches.flags.get("no-clear").unwrap_or(false),
  }
  play(opts) catch {
    err => {
      @stdio.stderr.write("moba_replay: \{err}\n")
      @sys.exit(1)
    }
  }
}

///|
fn opt(matches : @argparse.Matches, key : String) -> String? {
  match matches.values.get(key) {
    Some(arr) if arr.length() > 0 => Some(arr[0])
    _ => None
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
