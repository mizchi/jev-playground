///|
/// A headless 3v3 MOBA where Jev plays a whole team, under fog of war.
///
/// The shape of the problem is what makes it interesting here. Team vision is
/// shared, so at any tick there is exactly ONE observation per team — and
/// three champions who each need a decision from it. That is the fan-out
/// pattern with nothing contrived about it: one request carries the state once
/// and asks three independent `choice` questions, one per champion, plus a
/// couple of team-level reads. Three champions therefore cost one round trip,
/// which is what keeps the whole team inside a ~2 decisions/second budget.
///
///   moon run --target native cmd/moba -- --a jev --b scripted --games 3
struct Opts {
  api_key : String
  base_url : String
  model : String
  team_a : String
  team_b : String
  /// Archetype per lane for each side (top/jungle/bot); empty means classic×3.
  comp_a : Array[String]
  comp_b : Array[String]
  games : Int
  max_ticks : Int
  verbose : Bool
  /// Round-robin the named comps against each other, scripted, and print a
  /// win table. Ignores --a/--b/--games.
  tournament : Bool
  /// Round-robin the named comps as pure teamfights (composition only).
  arena : Bool
  /// Ask Jev to draft a composition from the raw archetype stats, and compare
  /// its ranking to the empirical arena. Needs an API key.
  draft : Bool
  /// Comeback scenario: can a WRONG draft played with correct actions (Jev)
  /// recover against a RIGHT draft played with poor actions (scripted)? Needs
  /// an API key.
  comeback : Bool
  /// --comeback: the wrong-draft and right-draft comp names.
  comeback_bad : String
  comeback_good : String
  /// --comeback: the "poor actions" baseline policy (scripted or smart).
  comeback_baseline : String
  /// Boundary sweep: same comp both sides, Jev handicapped, find where the
  /// recovery fails. Needs an API key.
  boundary : Bool
  /// Per-team stat handicap in percent (100 = full). Scales attack and HP.
  hcap_a : Int
  hcap_b : Int
  /// If non-empty, write the last game's replay to this file as JSON lines.
  replay : String
}

///|
/// Per-run counters, so the report can say what a game cost.
struct Stats {
  mut requests : Int
  mut input_tokens : Int
  mut decisions : Int
  mut api_ms : Int
  /// Picks that named something outside the legal list. Should stay 0: the
  /// choices ARE the legal moves, so an illegal action is unrepresentable.
  mut illegal : Int
  /// Ticks where the API failed and the scripted fallback was used.
  mut fallback_ticks : Int
}

///|
fn Stats::new() -> Stats {
  {
    requests: 0,
    input_tokens: 0,
    decisions: 0,
    api_ms: 0,
    illegal: 0,
    fallback_ticks: 0,
  }
}

// -------------------------------------------------------------- jev a team

///|
/// One request decides the whole team's tick.
///
/// `questions` carries one `choice` per living champion over exactly that
/// champion's legal actions, so whatever comes back is a legal move. Two
/// team-level questions ride along for free (the state is already paid for):
/// a `score` for how much danger the team is in — ordered, so it is a score
/// and not a choice, per docs/01 — and a `choice` guessing where the enemies
/// that are NOT visible have gone, which is the fog-of-war read a human
/// makes constantly.
async fn jev_team_actions(
  client : @lib.Client,
  model : String,
  g : @game.Game,
  team : Int,
  mem : @game.Memory,
  stats : Stats,
  verbose : Bool,
) -> Map[Int, @game.Action] {
  let out : Map[Int, @game.Action] = Map([])
  let legal_by_champ : Map[Int, Array[@game.Action]] = Map([])
  let qs : Map[String, @lib.Question] = Map([])
  for c in g.champs {
    if c.team != team || !c.alive() {
      continue
    }
    let legal = g.legal_actions(c)
    if legal.is_empty() {
      continue
    }
    legal_by_champ[c.id] = legal
    let criteria : Map[String, String] = Map([])
    for a in legal {
      criteria[a.to_string()] = g.describe_action(c, a)
    }
    qs["champ_\{c.id}"] = @lib.Question::choice(
      criteria,
      instructions="What should \{c.name} (the \{c.role} laner, hp \{c.hp}) do this tick? Win the game: take towers and then the base. Do not feed kills, and do not walk alone into places you cannot see.",
    )
  }
  if qs.is_empty() {
    return out
  }
  // Team-level reads, riding along on a state that is already being sent.
  qs["danger"] = @lib.Question::score(
    [
      "Safe, keep pushing", "Trade carefully", "Back off and regroup", "Our base is about to fall",
    ],
    instructions="How much danger is our team in right now?",
  )
  let unseen = []
  for i in 0..<@game.N_NODES {
    unseen.push(@game.node_names[i])
  }
  qs["enemy_probably_at"] = @lib.Question::choice_of(
    unseen,
    instructions="The enemies you cannot see right now — which node are they most likely grouped at?",
  )

  let state = g.observation(team, mem)
  let t0 = @env.now()
  let resp = client.system_one({ state, model, questions: qs, }) catch {
    _ => {
      // The game must keep moving; fall back to the scripted policy and say so.
      stats.fallback_ticks += 1
      for c in g.champs {
        if c.team == team && c.alive() {
          out[c.id] = @game.scripted_action(g, c)
        }
      }
      return out
    }
  }
  stats.api_ms += (@env.now() - t0).to_int()
  stats.requests += 1
  stats.input_tokens += resp.input_tokens

  for entry in legal_by_champ {
    let (id, legal) = entry
    let (choice, conf) = @report.choice_at(resp, "champ_\{id}")
    let mut picked : @game.Action? = None
    for a in legal {
      if a.to_string() == choice {
        picked = Some(a)
      }
    }
    match picked {
      Some(a) => {
        out[id] = a
        stats.decisions += 1
        if verbose {
          println(
            "    \{g.champs[id].name}: \{a.to_string()} (conf \{@report.d2(conf)})",
          )
        }
      }
      None => {
        // Cannot happen while the criteria are the legal moves; counted so
        // the claim is measured rather than asserted.
        stats.illegal += 1
        out[id] = @game.scripted_action(g, g.champs[id])
      }
    }
  }
  if verbose {
    let (danger, dconf) = @report.score_at(resp, "danger")
    let (guess, gconf) = @report.choice_at(resp, "enemy_probably_at")
    println(
      "    [team read] danger=\{@report.d2(danger)}/3@\{@report.d2(dconf)}  unseen enemies probably at \{guess}@\{@report.d2(gconf)}  (\{resp.input_tokens} tok)",
    )
  }
  out
}

// ------------------------------------------------------------------ one game

///|
struct GameResult {
  winner : Int
  ticks : Int
  a_structure_hp : Int
  b_structure_hp : Int
  /// The game as JSON lines (meta, frames, result), for the replay player.
  replay : Array[String]
}

///|
async fn play_game(
  opts : Opts,
  client : @lib.Client,
  stats : Stats,
  index : Int,
) -> GameResult {
  let g = @game.Game::with_handicap(
    opts.comp_a,
    opts.comp_b,
    opts.hcap_a,
    opts.hcap_b,
  )
  let mem_a = @game.Memory::new()
  let mem_b = @game.Memory::new()
  let replay = [
    g
    .replay_meta(
      opts.team_a,
      opts.team_b,
      opts.comp_a,
      opts.comp_b,
      opts.max_ticks,
    )
    .stringify(),
    g.replay_frame().stringify(), // tick 0, the opening state
  ]
  if opts.verbose {
    println("")
    println("--- game \{index + 1}: A=\{opts.team_a} vs B=\{opts.team_b} ---")
  }
  while g.winner == 0 && g.tick < opts.max_ticks {
    mem_a.observe(g, @game.TEAM_A)
    mem_b.observe(g, @game.TEAM_B)
    let actions : Map[Int, @game.Action] = Map([])
    for pair in [(@game.TEAM_A, opts.team_a), (@game.TEAM_B, opts.team_b)] {
      let (team, kind) = pair
      let mem = if team == @game.TEAM_A { mem_a } else { mem_b }
      if kind == "jev" {
        if opts.verbose {
          println(
            "  tick \{g.tick + 1} team \{if team == @game.TEAM_A { "A" } else { "B" }}:",
          )
        }
        let chosen = jev_team_actions(
          client,
          opts.model,
          g,
          team,
          mem,
          stats,
          opts.verbose,
        )
        for e in chosen {
          actions[e.0] = e.1
        }
      } else {
        for c in g.champs {
          if c.team == team && c.alive() {
            actions[c.id] = if kind == "smart" {
              @game.smart_action(g, c)
            } else {
              @game.scripted_action(g, c)
            }
          }
        }
      }
    }
    g.step(actions)
    replay.push(g.replay_frame().stringify())
    if opts.verbose && g.log.length() > 0 {
      let last = g.log[g.log.length() - 1]
      if last.has_prefix("t\{g.tick}:") {
        println("  \{last}")
      }
    }
  }
  if opts.verbose {
    println(g.render())
  }
  // A game that runs out of ticks goes to whoever did more structural damage.
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
  replay.push(g.replay_result(winner).stringify())
  { winner, ticks: g.tick, a_structure_hp: a_hp, b_structure_hp: b_hp, replay, }
}

///|
/// A scripted-only game with the given comps, run to completion. No client, no
/// API — this is the free path the tournament uses to measure composition
/// against composition with the policy held fixed.
fn play_scripted(
  comp_a : Array[String],
  comp_b : Array[String],
  max_ticks : Int,
) -> Int {
  let g = @game.Game::with_comps(comp_a, comp_b)
  while g.winner == 0 && g.tick < max_ticks {
    let actions : Map[Int, @game.Action] = Map([])
    for c in g.champs {
      if c.alive() {
        actions[c.id] = @game.scripted_action(g, c)
      }
    }
    g.step(actions)
  }
  let a_hp = g.structure_hp(@game.TEAM_A)
  let b_hp = g.structure_hp(@game.TEAM_B)
  if g.winner != 0 {
    g.winner
  } else if b_hp < a_hp {
    @game.TEAM_A
  } else if a_hp < b_hp {
    @game.TEAM_B
  } else {
    0
  }
}

///|
/// A pure 3v3 teamfight: both comps stacked on one node, everyone focus-fires
/// the softest enemy (so the frontline guard is in play) and nobody retreats.
/// This isolates composition from map macro — no lanes, no farming, no towers,
/// just "which five-stat team wins the fight". Returns the winning team, or 0
/// if neither side is wiped inside the cap.
fn arena_fight(
  comp_a : Array[String],
  comp_b : Array[String],
  max_ticks : Int,
) -> Int {
  let g = @game.Game::with_comps(comp_a, comp_b)
  let arena = 9 // m_jg: central, no tower, no base heal
  g.place_all(arena)
  let mut result = 0
  for _t in 0..<max_ticks {
    let a_in = g.champs_at(arena, @game.TEAM_A).length()
    let b_in = g.champs_at(arena, @game.TEAM_B).length()
    if a_in == 0 && b_in == 0 {
      result = 0
      break
    }
    if b_in == 0 {
      result = @game.TEAM_A
      break
    }
    if a_in == 0 {
      result = @game.TEAM_B
      break
    }
    let actions : Map[Int, @game.Action] = Map([])
    for c in g.champs {
      if !c.alive() || c.node != arena {
        continue
      }
      let enemy = if c.team == @game.TEAM_A {
        @game.TEAM_B
      } else {
        @game.TEAM_A
      }
      let foes = g.champs_at(arena, enemy)
      if foes.is_empty() {
        continue
      }
      let mut soft = foes[0]
      for f in foes {
        if f.hp < soft.hp {
          soft = f
        }
      }
      actions[c.id] = AttackChamp(soft.id)
    }
    g.step(actions)
  }
  result
}

///|
/// The arena round-robin: every comp vs every other in a pure teamfight, both
/// sides. This is the clean answer to "does correct synergy win a fight?" —
/// composition is the only variable, the policy is identical.
fn run_arena(max_ticks : Int) -> Unit {
  let comps = @game.tournament_comps
  let n = comps.length()
  @report.header(
    "MOBA synergy — teamfight arena", "3v3 to the death on one node, focus fire + peel, composition is the only variable",
  )
  let wins = Array::make(n, 0)
  let losses = Array::make(n, 0)
  let draws = Array::make(n, 0)
  let mut games = 0
  for i in 0..<n {
    for j in 0..<n {
      if i == j {
        continue
      }
      let w = arena_fight(comps[i].picks, comps[j].picks, max_ticks)
      games += 1
      if w == @game.TEAM_A {
        wins[i] += 1
        losses[j] += 1
      } else if w == @game.TEAM_B {
        wins[j] += 1
        losses[i] += 1
      } else {
        draws[i] += 1
        draws[j] += 1
      }
    }
  }
  println("  \{games} teamfights over \{n} comps\n")
  let order = []
  for i in 0..<n {
    order.push(i)
  }
  order.sort_by((a, b) => wins[b] - wins[a])
  println("  rank  comp          frontline  damage   W-L-D    picks")
  let mut rank = 1
  for idx in order {
    let c = comps[idx]
    let fl = if c.has_frontline() { "yes" } else { "no " }
    let dm = if c.mixed_damage() { "AD+AP" } else { "mono " }
    let wld = "\{wins[idx]}-\{losses[idx]}-\{draws[idx]}"
    println(
      "   \{rank}    \{pad(c.name, 12)}  \{fl}        \{dm}    \{pad(wld, 7)}  \{c.picks.join(", ")}",
    )
    rank += 1
  }
  println("")
}

///|
/// Round-robin every named comp against every other, scripted, on both sides
/// (so side has no say), and print a win table. The question this answers:
/// does the "correct synergy" (a durable frontline and both damage types)
/// actually win, with the policy identical on both sides?
fn run_tournament(max_ticks : Int) -> Unit {
  let comps = @game.tournament_comps
  let n = comps.length()
  @report.header(
    "MOBA synergy tournament", "scripted vs scripted, each ordered pair once",
  )
  // wins[i] = games comp i won; also track draws so nothing is hidden.
  let wins = Array::make(n, 0)
  let losses = Array::make(n, 0)
  let draws = Array::make(n, 0)
  let mut games = 0
  for i in 0..<n {
    for j in 0..<n {
      if i == j {
        continue
      }
      let w = play_scripted(comps[i].picks, comps[j].picks, max_ticks)
      games += 1
      if w == @game.TEAM_A {
        wins[i] += 1
        losses[j] += 1
      } else if w == @game.TEAM_B {
        wins[j] += 1
        losses[i] += 1
      } else {
        draws[i] += 1
        draws[j] += 1
      }
    }
  }
  println("  \{games} games over \{n} comps\n")
  // Print sorted by wins, descending. Simple selection sort on an index array.
  let order = []
  for i in 0..<n {
    order.push(i)
  }
  order.sort_by((a, b) => wins[b] - wins[a])
  println("  rank  comp          frontline  damage   W-L-D   picks")
  let mut rank = 1
  for idx in order {
    let c = comps[idx]
    let fl = if c.has_frontline() { "yes" } else { "no " }
    let dm = if c.mixed_damage() { "AD+AP" } else { "mono " }
    let wld = "\{wins[idx]}-\{losses[idx]}-\{draws[idx]}"
    let name = pad(c.name, 12)
    let picks = c.picks.join(", ")
    println(
      "   \{rank}    \{name}  \{fl}        \{dm}    \{pad(wld, 7)} \{picks}",
    )
    rank += 1
  }
  println("")
}

///|
/// One boundary cell: same comp both sides, the Jev team handicapped to `pct`
/// percent stats, the baseline team at full. Jev plays the handicapped side on
/// both sides for `n` games each (cancels side effect). Returns the Jev team's
/// record (wins, losses, draws).
async fn boundary_cell(
  base : Opts,
  client : @lib.Client,
  stats : Stats,
  comp : Array[String],
  baseline : String,
  pct : Int,
  n : Int,
) -> (Int, Int, Int) {
  let mut wins = 0
  let mut losses = 0
  let mut draws = 0
  for side in [0, 1] {
    for i in 0..<n {
      // The handicapped Jev team is on `side`; the full baseline is the other.
      let o = if side == 0 {
        cell_opts(base, "jev", comp, baseline, comp, pct, 100, "")
      } else {
        cell_opts(base, baseline, comp, "jev", comp, 100, pct, "")
      }
      let r = play_game(o, client, stats, i)
      let jev_team = if side == 0 { @game.TEAM_A } else { @game.TEAM_B }
      if r.winner == 0 {
        draws += 1
      } else if r.winner == jev_team {
        wins += 1
      } else {
        losses += 1
      }
    }
  }
  (wins, losses, draws)
}

///|
/// The boundary sweep. Both teams draft the SAME comp, so the only differences
/// are the Jev team's stat handicap and that Jev pilots it while the baseline
/// bot pilots the full-stat mirror. Sweeping the handicap down finds where
/// Jev's action edge can no longer buy back the deficit — the point at which a
/// draft/economy gap becomes unrecoverable. A weak baseline (scripted) gives
/// the largest recoverable deficit; a stronger one (smart) shrinks it.
async fn run_boundary(opts : Opts, client : @lib.Client) -> Unit {
  let comp = opts.comp_a
  let baseline = opts.comeback_baseline
  let n = if opts.games < 2 { 4 } else { opts.games }
  let pcts = [100, 80, 60, 40, 25]
  @report.header(
    "MOBA boundary — how large a deficit can correct actions buy back",
    "same comp [\{comp.join("/")}] both sides; Jev(handicapped) vs \{baseline}(full)",
  )
  let stats = Stats::new()
  println("  Jev pilots the handicapped side (both sides, \{n} games each)\n")
  println("  handicap   Jev(bad) W-L-D   →")
  let mut crossed = false
  for pct in pcts {
    let (w, l, d) = boundary_cell(opts, client, stats, comp, baseline, pct, n)
    let verdict = if w > l {
      "recovers"
    } else if l > w {
      "cannot"
    } else {
      "even"
    }
    let mark = if w <= l && !crossed {
      crossed = true
      "  <- boundary"
    } else {
      ""
    }
    println(
      "   \{pad("\{pct}%", 9)} \{pad("\{w}-\{l}-\{d}", 8)}      \{verdict}\{mark}",
    )
  }
  println("")
  println(
    "  Jev's action edge (vs \{baseline}) buys back a deficit down to the boundary above.",
  )
  if stats.requests > 0 {
    println(
      "  \{stats.requests} Jev requests, \{stats.input_tokens} input tokens (~$\{@report.fixed(stats.input_tokens.to_double() / 1000000.0 * 0.042, 4)})",
    )
  }
  println("")
}

///|
/// A named composition's champion picks, or classic×3 if the name is unknown.
fn comp_by_name(name : String) -> Array[String] {
  for c in @game.tournament_comps {
    if c.name == name {
      return c.picks
    }
  }
  ["classic", "classic", "classic"]
}

///|
/// A per-cell Opts: same account/model, but the policies and comps of one
/// matchup, and never a nested special mode.
fn cell_opts(
  base : Opts,
  team_a : String,
  comp_a : Array[String],
  team_b : String,
  comp_b : Array[String],
  hcap_a : Int,
  hcap_b : Int,
  replay : String,
) -> Opts {
  {
    api_key: base.api_key,
    base_url: base.base_url,
    model: base.model,
    team_a,
    team_b,
    comp_a,
    comp_b,
    games: 1,
    max_ticks: base.max_ticks,
    verbose: false,
    tournament: false,
    arena: false,
    draft: false,
    comeback: false,
    comeback_bad: base.comeback_bad,
    comeback_good: base.comeback_good,
    comeback_baseline: base.comeback_baseline,
    boundary: false,
    hcap_a,
    hcap_b,
    replay,
  }
}

///|
/// One comeback cell: the BAD comp is run on both sides (to cancel any side
/// effect) for `n` games each, against the GOOD comp. Returns the BAD comp's
/// record (wins, losses, draws) from its own perspective. If `record` is set,
/// the first game the BAD comp WINS is written there — a real comeback to watch.
async fn comeback_cell(
  base : Opts,
  client : @lib.Client,
  stats : Stats,
  bad : Array[String],
  good : Array[String],
  bad_policy : String,
  good_policy : String,
  n : Int,
  record : String,
) -> (Int, Int, Int) {
  let mut wins = 0
  let mut losses = 0
  let mut draws = 0
  let mut recorded = false
  for side in [0, 1] {
    for i in 0..<n {
      let o = if side == 0 {
        cell_opts(base, bad_policy, bad, good_policy, good, 100, 100, "")
      } else {
        cell_opts(base, good_policy, good, bad_policy, bad, 100, 100, "")
      }
      let r = play_game(o, client, stats, i)
      let bad_team = if side == 0 { @game.TEAM_A } else { @game.TEAM_B }
      if r.winner == 0 {
        draws += 1
      } else if r.winner == bad_team {
        wins += 1
        if record != "" && !recorded && side == 0 {
          @fs.write_file(record, r.replay.join("\n") + "\n")
          recorded = true
        }
      } else {
        losses += 1
      }
    }
  }
  (wins, losses, draws)
}

///|
/// The comeback scenario. A "wrong grand strategy" is a bad draft (glass_ad:
/// three squishy carries, no frontline, one damage type). Correct actions are
/// Jev; poor actions are the scripted bot. Three cells, all with the SAME two
/// comps, differing only in who plays well:
///
///   1. equal play  (scripted vs scripted) — is the draft gap real at all?
///   2. the scenario (BAD+Jev vs GOOD+scripted) — do correct actions recover it?
///   3. the ceiling  (BAD+Jev vs GOOD+Jev) — does the draft reassert when both
///      sides play well?
///
/// If (1) says GOOD wins, (2) says BAD recovers, and (3) says GOOD wins again,
/// the reading is clean: a wrong draft is recoverable against a weaker player,
/// not against an equal one — correct actions buy back a modest draft deficit.
async fn run_comeback(opts : Opts, client : @lib.Client) -> Unit {
  let bad_name = opts.comeback_bad
  let good_name = opts.comeback_good
  let base_policy = opts.comeback_baseline
  let bad = comp_by_name(bad_name)
  let good = comp_by_name(good_name)
  let n = if opts.games < 2 { 4 } else { opts.games }
  @report.header(
    "MOBA comeback — a wrong draft, recovered by correct actions",
    "BAD=\{bad_name} [\{bad.join("/")}]  vs  GOOD=\{good_name} [\{good.join("/")}]",
  )
  let stats = Stats::new()
  println(
    "  correct actions = Jev, poor actions = \{base_policy}; BAD plays both sides\n",
  )

  // 1. Equal play: baseline vs baseline (both bots are deterministic, so 1
  //    game per side is enough).
  let (e_w, e_l, e_d) = comeback_cell(
    opts, client, stats, bad, good, base_policy, base_policy, 1, "",
  )
  // 2. The scenario: BAD played by Jev, GOOD played by the baseline bot.
  let (s_w, s_l, s_d) = comeback_cell(
    opts,
    client,
    stats,
    bad,
    good,
    "jev",
    base_policy,
    n,
    opts.replay,
  )
  // 3. The ceiling: both sides played by Jev.
  let (c_w, c_l, c_d) = comeback_cell(
    opts, client, stats, bad, good, "jev", "jev", n, "",
  )
  fn verdict(w : Int, l : Int) -> String {
    if w > l {
      "BAD recovers"
    } else if l > w {
      "GOOD wins"
    } else {
      "even"
    }
  }

  let bl = base_policy
  println(
    "  cell                                          BAD(\{bad_name}) W-L-D   →",
  )
  println(
    "   1. equal play  \{pad(bl, 8)} vs \{pad(bl, 8)}         \{pad("\{e_w}-\{e_l}-\{e_d}", 7)} \{verdict(e_w, e_l)}",
  )
  println(
    "   2. scenario    BAD+Jev  vs GOOD+\{pad(bl, 8)}     \{pad("\{s_w}-\{s_l}-\{s_d}", 7)} \{verdict(s_w, s_l)}",
  )
  println(
    "   3. ceiling     BAD+Jev  vs GOOD+Jev           \{pad("\{c_w}-\{c_l}-\{c_d}", 7)} \{verdict(c_w, c_l)}",
  )
  println("")
  if e_l > e_w && s_w > s_l {
    println(
      "  → the draft gap is real (cell 1), but correct actions buy it back (cell 2).",
    )
  }
  if c_l >= c_w && s_w > s_l {
    println(
      "  → and it only holds against a weaker player: with both sides on Jev, the draft wins again (cell 3).",
    )
  }
  if opts.replay != "" {
    println("  a recovered game (BAD+Jev won) is at \{opts.replay}")
  }
  if stats.requests > 0 {
    println(
      "  \{stats.requests} Jev requests, \{stats.input_tokens} input tokens (~$\{@report.fixed(stats.input_tokens.to_double() / 1000000.0 * 0.042, 4)})",
    )
  }
  println("")
}

///|
/// Ask Jev to rank the compositions from the raw archetype stats and the bare
/// mechanics — without being told that a frontline or mixed damage is good —
/// then set its ranking beside the empirical arena. The question this answers:
/// can Jev *choose* the correct synergy, not just play it? The state gives only
/// stats and rules; Jev has to infer that a body which soaks hits and a damage
/// type that dodges the enemy's resist are worth having.
async fn run_draft(
  client : @lib.Client,
  model : String,
  max_ticks : Int,
) -> Unit {
  let comps = @game.tournament_comps
  let n = comps.length()
  @report.header(
    "MOBA draft", "Jev ranks the comps from raw stats; set beside the teamfight arena",
  )
  // Empirical arena, for the comparison column.
  let wins = Array::make(n, 0)
  let losses = Array::make(n, 0)
  for i in 0..<n {
    for j in 0..<n {
      if i == j {
        continue
      }
      let w = arena_fight(comps[i].picks, comps[j].picks, max_ticks)
      if w == @game.TEAM_A {
        wins[i] += 1
        losses[j] += 1
      } else if w == @game.TEAM_B {
        wins[j] += 1
        losses[i] += 1
      }
    }
  }
  // State: stats and mechanics only. Nothing says which trait is good.
  let roster_keys = [
    "classic", "marksman", "mage", "assassin", "bruiser", "tank", "support",
  ]
  fn stat_json(key : String) -> Json {
    let kd = @game.kind_of(key)
    Json({
      "champion": Json(key),
      "deals": Json(kd.dmg_type_name()),
      "attack": Json(kd.attack),
      "max_hp": Json(kd.max_hp),
      "armor": Json(kd.armor),
      "magic_resist": Json(kd.mr),
      "frontline": Json(kd.frontline),
    })
  }

  let roster = []
  for k in roster_keys {
    roster.push(stat_json(k))
  }
  let cands = []
  for c in comps {
    let picks = []
    for p in c.picks {
      picks.push(stat_json(p))
    }
    cands.push(Json({ "name": Json(c.name), "picks": Json(picks) }))
  }
  let state = Json({
    "game": Json("Draft a team of three champions for a 3v3 teamfight."),
    "damage_rule": Json(
      "Each tick a champion deals its attack to one enemy. Damage dealt = attack * 100 / (100 + resist), where resist is the target's armor when the attacker deals physical and its magic_resist when the attacker deals magic. Armor does nothing against magic; magic_resist does nothing against physical.",
    ),
    "frontline_rule": Json(
      "While a frontline champion is alive with its team, enemy hits aimed at its non-frontline allies land on the frontline champion instead.",
    ),
    "win_rule": Json(
      "A champion at 0 hp is out of the fight. The team left standing wins.",
    ),
    "roster": Json(roster),
    "candidates": Json(cands),
  })
  let qs : Map[String, @lib.Question] = Map([])
  let rubric = [
    "Loses most 3v3 fights", "About even", "Wins most 3v3 fights", "Dominates almost every fight",
  ]
  for c in comps {
    qs["score_\{c.name}"] = @lib.Question::score(
      rubric,
      instructions="Composition '\{c.name}' = \{c.picks.join(" + ")}. In a 3v3 teamfight under the rules and rosters in the state, how does it fare?",
    )
  }
  let names = []
  for c in comps {
    names.push(c.name)
  }
  qs["draft"] = @lib.Question::choice_of(
    names,
    instructions="You are drafting for a 3v3 teamfight. Which of these compositions gives the best chance to win the fight?",
  )
  let resp = client.system_one({ state, model, questions: qs, }) catch {
    e => {
      println("  draft request failed: \{e}")
      return
    }
  }
  let jscore = Array::make(n, 0.0)
  for i in 0..<n {
    let (v, _) = @report.score_at(resp, "score_\{comps[i].name}")
    jscore[i] = v
  }
  let (pick, pconf) = @report.choice_at(resp, "draft")
  // Rank by Jev score and by arena wins.
  let jorder = []
  let aorder = []
  for i in 0..<n {
    jorder.push(i)
    aorder.push(i)
  }
  jorder.sort_by((a, b) => {
    if jscore[b] > jscore[a] {
      1
    } else if jscore[b] < jscore[a] {
      -1
    } else {
      0
    }
  })
  aorder.sort_by((a, b) => wins[b] - wins[a])
  let jev_rank = Array::make(n, 0)
  let arena_rank = Array::make(n, 0)
  for r in 0..<n {
    jev_rank[jorder[r]] = r + 1
    arena_rank[aorder[r]] = r + 1
  }
  println("  comp          Jev score  Jev#   arena W-L  arena#")
  for i in 0..<n {
    let idx = aorder[i]
    let c = comps[idx]
    println(
      "   \{pad(c.name, 12)}  \{pad(@report.d2(jscore[idx]), 9)} \{pad(jev_rank[idx].to_string(), 5)}  \{pad("\{wins[idx]}-\{losses[idx]}", 9)} \{arena_rank[idx]}",
    )
  }
  println("")
  let arena_best = comps[aorder[0]].name
  println("  Jev would draft: \{pick} (conf \{@report.d2(pconf)})")
  println("  arena-strongest: \{arena_best}")
  if pick == arena_best {
    println("  → Jev drafted the empirically strongest comp.")
  } else {
    println("  → Jev's pick differs from the arena's strongest.")
  }
  println(
    "  \{resp.input_tokens} input tokens (~$\{@report.fixed(resp.input_tokens.to_double() / 1000000.0 * 0.042, 4)})",
  )
  println("")
}

///|
/// Left-justify `s` to at least `width` with spaces, for column alignment.
fn pad(s : String, width : Int) -> String {
  let mut out = s
  while out.length() < width {
    out = out + " "
  }
  out
}

// ----------------------------------------------------------------- plumbing

///|
async fn main {
  let cmd = @argparse.Command(
    "moba",
    about="A headless 3v3 MOBA with fog of war, played by Jev or a scripted bot.",
    flags=[
      @argparse.FlagArg(
        "verbose",
        long="verbose",
        about="Print every decision and the team-level reads.",
      ),
      @argparse.FlagArg(
        "tournament",
        long="tournament",
        about="Round-robin the named comps (scripted vs scripted) and print a win table. Needs no API key.",
      ),
      @argparse.FlagArg(
        "arena",
        long="arena",
        about="Round-robin the named comps as pure 3v3 teamfights (composition only). Needs no API key.",
      ),
      @argparse.FlagArg(
        "draft",
        long="draft",
        about="Ask Jev to rank the comps from the raw archetype stats, vs the empirical arena.",
      ),
      @argparse.FlagArg(
        "comeback",
        long="comeback",
        about="Can a wrong draft + correct actions (Jev) recover vs a right draft + poor actions (scripted)?",
      ),
      @argparse.FlagArg(
        "boundary",
        long="boundary",
        about="Sweep a stat handicap on the Jev team (same comp both sides) to find the unrecoverable deficit.",
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
        "a",
        long="a",
        default_values=["jev"],
        about="Team A policy: jev or scripted.",
      ),
      @argparse.OptionArg(
        "b",
        long="b",
        default_values=["scripted"],
        about="Team B policy: jev or scripted.",
      ),
      @argparse.OptionArg(
        "games",
        long="games",
        default_values=["1"],
        about="How many games to play.",
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
        about="Team A composition, comma-separated top,jungle,bot (e.g. tank,marksman,mage). Default classic×3.",
      ),
      @argparse.OptionArg(
        "b-comp",
        long="b-comp",
        about="Team B composition, comma-separated top,jungle,bot. Default classic×3.",
      ),
      @argparse.OptionArg(
        "replay",
        long="replay",
        about="Write the last game's replay to this file (JSON lines) for cmd/moba_replay.",
      ),
      @argparse.OptionArg(
        "bad",
        long="bad",
        about="--comeback: the WRONG-draft comp name (default glass_ad).",
      ),
      @argparse.OptionArg(
        "good",
        long="good",
        about="--comeback: the RIGHT-draft comp name (default bruiser_mix).",
      ),
      @argparse.OptionArg(
        "baseline",
        long="baseline",
        about="--comeback/--boundary: the poor-actions baseline policy, scripted or smart (default scripted).",
      ),
      @argparse.OptionArg(
        "hcap-a",
        long="hcap-a",
        default_values=["100"],
        about="Team A stat handicap in percent (100 = full); scales attack and HP.",
      ),
      @argparse.OptionArg(
        "hcap-b",
        long="hcap-b",
        default_values=["100"],
        about="Team B stat handicap in percent (100 = full); scales attack and HP.",
      ),
    ],
  )
  let matches = @argparse.parse(cmd) catch {
    msg => raise @lib.ApiError::InvalidResponse("usage: \{msg}")
  }
  let api_key = match opt_value(matches, "api-key") {
    Some(k) if !k.is_empty() => k
    _ =>
      match @env.get_env_var("TYPESAFEAI_API_KEY") {
        Some(k) if !k.is_empty() => k
        _ => ""
      }
  }
  let opts : Opts = {
    api_key,
    base_url: opt_value(matches, "base-url").unwrap_or(
      "https://api.typesafe.ai",
    ),
    model: opt_value(matches, "model").unwrap_or("jev-latest"),
    team_a: opt_value(matches, "a").unwrap_or("jev"),
    team_b: opt_value(matches, "b").unwrap_or("scripted"),
    comp_a: split_comp(opt_value(matches, "a-comp")),
    comp_b: split_comp(opt_value(matches, "b-comp")),
    games: parse_int(opt_value(matches, "games"), 1),
    max_ticks: parse_int(opt_value(matches, "max-ticks"), 60),
    verbose: matches.flags.get("verbose").unwrap_or(false),
    tournament: matches.flags.get("tournament").unwrap_or(false),
    arena: matches.flags.get("arena").unwrap_or(false),
    draft: matches.flags.get("draft").unwrap_or(false),
    comeback: matches.flags.get("comeback").unwrap_or(false),
    comeback_bad: opt_value(matches, "bad").unwrap_or("glass_ad"),
    comeback_good: opt_value(matches, "good").unwrap_or("bruiser_mix"),
    comeback_baseline: opt_value(matches, "baseline").unwrap_or("scripted"),
    boundary: matches.flags.get("boundary").unwrap_or(false),
    hcap_a: parse_int(opt_value(matches, "hcap-a"), 100),
    hcap_b: parse_int(opt_value(matches, "hcap-b"), 100),
    replay: opt_value(matches, "replay").unwrap_or(""),
  }
  // The tournament and arena are scripted-only, so they need neither a valid
  // team policy nor an API key; skip both checks for them.
  let offline = opts.tournament || opts.arena
  if !offline {
    for kind in [opts.team_a, opts.team_b] {
      if kind != "jev" && kind != "scripted" && kind != "smart" {
        @stdio.stderr.write(
          "moba: team policy must be jev, scripted, or smart\n",
        )
        @sys.exit(1)
        return
      }
    }
  }
  let needs_api = !offline &&
    (
      opts.draft ||
      opts.comeback ||
      opts.boundary ||
      opts.team_a == "jev" ||
      opts.team_b == "jev"
    )
  if needs_api && api_key.is_empty() {
    @stdio.stderr.write(
      "moba: no API key; set TYPESAFEAI_API_KEY or pass --api-key\n",
    )
    @sys.exit(1)
    return
  }
  run(opts) catch {
    @lib.ApiError::Http(code, reason, body) => {
      @stdio.stderr.write(
        "moba: HTTP \{code} \{reason}: \{@report.clip(body, 300)}\n",
      )
      @sys.exit(1)
    }
    @lib.ApiError::InvalidResponse(msg) | @lib.ApiError::InvalidRequest(msg) => {
      @stdio.stderr.write("moba: \{msg}\n")
      @sys.exit(1)
    }
    _ => {
      @stdio.stderr.write("moba: unexpected error\n")
      @sys.exit(1)
    }
  }
}

///|
async fn run(opts : Opts) -> Unit {
  if opts.arena {
    run_arena(opts.max_ticks)
  }
  if opts.tournament {
    run_tournament(opts.max_ticks)
  }
  if opts.arena || opts.tournament {
    return
  }
  let client = if opts.base_url == "https://api.typesafe.ai" {
    @lib.Client::new(opts.api_key)
  } else {
    @lib.Client::with_base_url(opts.api_key, opts.base_url)
  }
  if opts.draft {
    run_draft(client, opts.model, opts.max_ticks)
    return
  }
  if opts.comeback {
    run_comeback(opts, client)
    return
  }
  if opts.boundary {
    run_boundary(opts, client)
    return
  }
  let stats = Stats::new()
  @report.header(
    "3v3 MOBA",
    "A=\{opts.team_a} vs B=\{opts.team_b}, \{opts.games} game(s), fog of war",
  )
  let mut a_wins = 0
  let mut b_wins = 0
  let mut draws = 0
  let mut total_ticks = 0
  let mut last_replay : Array[String] = []
  let wall0 = @env.now()
  for i in 0..<opts.games {
    let r = play_game(opts, client, stats, i)
    last_replay = r.replay
    total_ticks += r.ticks
    if r.winner == @game.TEAM_A {
      a_wins += 1
    } else if r.winner == @game.TEAM_B {
      b_wins += 1
    } else {
      draws += 1
    }
    let who = if r.winner == @game.TEAM_A {
      "A (\{opts.team_a})"
    } else if r.winner == @game.TEAM_B {
      "B (\{opts.team_b})"
    } else {
      "draw"
    }
    println(
      "  game \{i + 1}: \{who} after \{r.ticks} ticks   structures left A=\{r.a_structure_hp} B=\{r.b_structure_hp}",
    )
  }
  let wall = (@env.now() - wall0).to_int()
  println("")
  println(
    "  A (\{opts.team_a}) \{a_wins} — \{b_wins} B (\{opts.team_b})\{if draws > 0 { "  (\{draws} draw)" } else { "" }}, \{total_ticks} ticks total",
  )
  if stats.requests > 0 {
    let per_req = stats.api_ms.to_double() / stats.requests.to_double()
    let per_dec = stats.api_ms.to_double() / stats.decisions.to_double()
    println("")
    println(
      "  \{stats.requests} requests decided \{stats.decisions} champion actions",
    )
    println(
      "  \{@report.d0(per_req)} ms/request, \{@report.d0(per_dec)} ms per champion decision",
    )
    println(
      "  \{stats.input_tokens} input tokens (~$\{@report.fixed(stats.input_tokens.to_double() / 1000000.0 * 0.042, 4)}), wall clock \{@report.d1(wall.to_double() / 1000.0)}s",
    )
    println(
      "  illegal picks: \{stats.illegal} (the choices ARE the legal moves)",
    )
    if stats.fallback_ticks > 0 {
      println(
        "  scripted fallback ticks after API failures: \{stats.fallback_ticks}",
      )
    }
  }
  if opts.replay != "" && last_replay.length() > 0 {
    @fs.write_file(opts.replay, last_replay.join("\n") + "\n")
    println("  replay of the last game written to \{opts.replay}")
    println(
      "  play it back:  moon run --target native cmd/moba_replay -- --file \{opts.replay}",
    )
  }
  println("")
}

///|
fn opt_value(matches : @argparse.Matches, key : String) -> String? {
  match matches.values.get(key) {
    Some(arr) if arr.length() > 0 => Some(arr[0])
    _ => None
  }
}

///|
/// Parse a comma-separated composition into exactly three archetype keys. An
/// empty or absent value is classic×3, so the default game is unchanged. Fewer
/// than three names are padded with `classic`; extra names are dropped.
fn split_comp(v : String?) -> Array[String] {
  let raw = match v {
    Some(s) => s
    None => ""
  }
  // Split on commas. Spaces are dropped so "tank, marksman" works; champion
  // keys never contain spaces, so this is safe.
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

///|
fn parse_int(v : String?, fallback : Int) -> Int {
  match v {
    Some(s) => @string.from_str(s) catch { _ => fallback }
    None => fallback
  }
}
