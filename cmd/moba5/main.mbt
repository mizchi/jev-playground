///|
/// A headless 5v5 MOBA, and a scored benchmark built on it.
///
/// The 3v3 prototype (`moba/`, `cmd/moba`) is still there and unchanged; this
/// is the same idea at the size the genre is actually played at, with the
/// mechanics that make it a game of decisions rather than of stats: levels,
/// items, abilities on cooldowns, crowd control, two epic objectives, minion
/// pressure in three lanes, and wards.
///
/// Two things are measured, and they answer different questions:
///
///   --bench   How OFTEN a policy is right, per class of decision, against the
///             answer the simulator itself produces. This is the measurement
///             that does not move when the opponent changes.
///   (default) Whether it WINS, against a lane bot and against a macro bot,
///             plus the throughput numbers: one request decides five champions,
///             so ms per champion decision is the figure that matters.
///
///   moon run --target native cmd/moba5 -- --bench --dry      # no API key
///   moon run --target native cmd/moba5 -- --bench
///   moon run --target native cmd/moba5 -- --a jev --b smart --games 3
struct Opts {
  api_key : String
  base_url : String
  model : String
  team_a : String
  team_b : String
  comp_a : Array[String]
  comp_b : Array[String]
  games : Int
  max_ticks : Int
  verbose : Bool
  /// Round-robin the named comps as whole games, both sides, baseline vs
  /// baseline. No API key.
  tournament : Bool
  /// Round-robin the named comps as pure 5v5 teamfights. No API key.
  arena : Bool
  /// Ask Jev to draft from the raw archetype stats, against the empirical
  /// arena.
  draft : Bool
  /// Run the scored benchmark.
  bench : Bool
  /// With --bench: print the suite and the heuristic floor's score without
  /// touching the API.
  dry : Bool
  /// The baseline policy used as the opponent in tournament mode and as the
  /// floor everywhere.
  baseline : String
  hcap_a : Int
  hcap_b : Int
  replay : String
}

///|
/// Per-run counters, so the report can say what a game cost and what the
/// policy actually did with the richer action space.
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
  /// How many actions of each family were chosen.
  used : Map[String, Int]
  /// The fog-of-war read, scored against where the enemies actually were. The
  /// game knows the truth every tick, so this is free accuracy data.
  mut fog_asked : Int
  mut fog_right : Int
  mut fog_conf : Double
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
    used: Map([]),
    fog_asked: 0,
    fog_right: 0,
    fog_conf: 0.0,
  }
}

///|
fn Stats::note(self : Stats, a : @game.Action) -> Unit {
  let k = a.kind_name()
  self.used[k] = self.used.get(k).unwrap_or(0) + 1
}

///|
/// Input-token cost at the published rate, for the one line every report ends
/// with.
fn cost_of(tokens : Int) -> String {
  @report.fixed(tokens.to_double() / 1000000.0 * 0.042, 4)
}

// -------------------------------------------------------------- jev a team

///|
/// One request decides the whole team's tick.
///
/// `questions` carries one `choice` per champion that can act, over exactly
/// that champion's legal actions, so whatever comes back is a legal move. Three
/// team-level reads ride along for free, because the state is already paid for:
/// how much danger we are in (ordered, so a `score` and not a `choice`, per
/// docs/01), where the enemies we cannot see have gone, and what the team's
/// next objective should be.
///
/// Five champions per request rather than three is the point of the exercise:
/// the state is the expensive part, and it is sent once either way.
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
    if c.team != team || !c.can_act() {
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
      instructions="What should \{c.name} (the \{c.role}, a level \{c.level} \{c.kind}, hp \{c.hp}/\{c.max_hp}) do this tick? Win the game: open a lane and break the nexus. Do not feed kills, do not walk alone into places you cannot see, and do not give up all three lanes at once.",
    )
  }
  if qs.is_empty() {
    return out
  }
  qs["danger"] = @lib.Question::score(
    [
      "Safe, keep pushing", "Trade carefully", "Back off and regroup", "Our nexus is about to fall",
    ],
    instructions="How much danger is our team in right now?",
  )
  let nodes = []
  for i in 0..<@game.N_NODES {
    nodes.push(@game.node_names[i])
  }
  qs["enemy_probably_at"] = @lib.Question::choice_of(
    nodes,
    instructions="The enemies you cannot see right now — which single node are they most likely standing on?",
  )
  qs["next_objective"] = @lib.Question::choice_of(
    ["baron", "dragon", "top", "mid", "bot", "their_nexus", "defend_our_base"],
    instructions="What should this team's next objective be?",
  )

  let state = g.observation(team, mem)
  let t0 = @env.now()
  let resp = client.system_one({ state, model, questions: qs, }) catch {
    _ => {
      // The game must keep moving; fall back to the scripted policy and say so.
      stats.fallback_ticks += 1
      for e in @game.scripted_team_actions(g, team) {
        out[e.0] = e.1
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
        stats.note(a)
        if verbose {
          println(
            "    \{g.champs[id].name}: \{a.to_string()} (conf \{@report.d2(conf)})",
          )
        }
      }
      None => {
        // Cannot happen while the criteria are the legal moves; counted so the
        // claim is measured rather than asserted.
        stats.illegal += 1
        out[id] = @game.scripted_action(g, g.champs[id])
      }
    }
  }
  // Score the fog read against where the enemies actually are. This costs
  // nothing and turns every game into calibration data for one class of
  // judgment the 3v3 prototype could only describe.
  let (guess, gconf) = @report.choice_at(resp, "enemy_probably_at")
  let truth = hidden_mode(g, team)
  if truth != "" {
    stats.fog_asked += 1
    stats.fog_conf += gconf
    if guess == truth {
      stats.fog_right += 1
    }
  }
  if verbose {
    let (danger, dconf) = @report.score_at(resp, "danger")
    let (obj, oconf) = @report.choice_at(resp, "next_objective")
    let fog = if truth == "" {
      "all visible"
    } else if guess == truth {
      "\{guess} RIGHT"
    } else {
      "\{guess}, actually \{truth}"
    }
    println(
      "    [team] danger=\{@report.d2(danger)}/3@\{@report.d2(dconf)}  objective=\{obj}@\{@report.d2(oconf)}  unseen at \{fog}@\{@report.d2(gconf)}  (\{resp.input_tokens} tok)",
    )
  }
  out
}

///|
/// The node holding the most enemies a team cannot see, or "" when it can see
/// them all. The truth for the in-game fog read.
fn hidden_mode(g : @game.Game, team : Int) -> String {
  let seen = g.vision(team)
  let counts = Array::make(@game.N_NODES, 0)
  let mut best = -1
  let mut best_n = 0
  for e in g.champs {
    if e.team != team && e.alive() && !seen[e.node] {
      counts[e.node] += 1
      if counts[e.node] > best_n {
        best_n = counts[e.node]
        best = e.node
      }
    }
  }
  if best < 0 {
    ""
  } else {
    @game.node_names[best]
  }
}

// ------------------------------------------------------------------ one game

///|
struct GameResult {
  winner : Int
  ticks : Int
  a_structure_hp : Int
  b_structure_hp : Int
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
    g.replay_frame().stringify(),
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
          println("  tick \{g.tick + 1} team \{@game.team_name(team)}:")
        }
        for
          e in jev_team_actions(
            client,
            opts.model,
            g,
            team,
            mem,
            stats,
            opts.verbose,
          ) {
          actions[e.0] = e.1
        }
      } else {
        for e in @game.baseline_team_actions(g, team, kind) {
          actions[e.0] = e.1
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
/// A baseline-only game, run to completion. No client, no API — the free path
/// the tournament uses to measure composition against composition with the
/// policy held fixed.
fn play_baseline(
  comp_a : Array[String],
  comp_b : Array[String],
  policy : String,
  max_ticks : Int,
) -> Int {
  let g = @game.Game::with_comps(comp_a, comp_b)
  while g.winner == 0 && g.tick < max_ticks {
    let actions : Map[Int, @game.Action] = Map([])
    for team in [@game.TEAM_A, @game.TEAM_B] {
      for e in @game.baseline_team_actions(g, team, policy) {
        actions[e.0] = e.1
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
/// A pure 5v5 teamfight: both comps stacked on one node, everyone playing the
/// all-in, nobody retreating. This isolates composition from map macro — no
/// lanes, no objectives, no towers, just "which five-champion team wins the
/// fight".
fn arena_fight(
  comp_a : Array[String],
  comp_b : Array[String],
  max_ticks : Int,
) -> Int {
  let g = @game.Game::with_comps(comp_a, comp_b)
  let arena = 9 // mid_mid: central, no tower, no base heal
  g.place_all(arena)
  g.simulate_fight(arena, max_ticks).winner
}

// ------------------------------------------------------------- round robins

///|
/// The shared round-robin printer, so the arena and the tournament report the
/// same columns and can be read side by side.
fn print_table(
  title : String,
  subtitle : String,
  wins : Array[Int],
  losses : Array[Int],
  draws : Array[Int],
  games : Int,
) -> Unit {
  let comps = @game.tournament_comps
  let n = comps.length()
  @report.header(title, subtitle)
  println("  \{games} games over \{n} comps\n")
  let order = []
  for i in 0..<n {
    order.push(i)
  }
  order.sort_by((a, b) => wins[b] - wins[a])
  println(
    "  rank  comp        frontline  damage  cc   sustain  ranged  W-L-D    picks",
  )
  let mut rank = 1
  for idx in order {
    let c = comps[idx]
    let fl = if c.has_frontline() { "yes" } else { "no " }
    let dm = if c.mixed_damage() { "AD+AP" } else { "mono " }
    let cc = if c.has_cc() { "yes" } else { "no " }
    let su = if c.has_sustain() { "yes" } else { "no " }
    let wld = "\{wins[idx]}-\{losses[idx]}-\{draws[idx]}"
    println(
      "   \{rank}    \{@report.pad(c.name, 10)}  \{fl}        \{dm}   \{cc}  \{su}      \{c.ranged_count()}       \{@report.pad(wld, 7)}  \{c.picks.join(", ")}",
    )
    rank += 1
  }
  println("")
}

///|
fn run_arena(max_ticks : Int) -> Unit {
  let comps = @game.tournament_comps
  let n = comps.length()
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
  print_table(
    "moba5 synergy — teamfight arena", "5v5 to the death on one node, abilities on their timing rules, composition is the only variable",
    wins, losses, draws, games,
  )
}

///|
fn run_tournament(policy : String, max_ticks : Int) -> Unit {
  let comps = @game.tournament_comps
  let n = comps.length()
  let wins = Array::make(n, 0)
  let losses = Array::make(n, 0)
  let draws = Array::make(n, 0)
  let mut games = 0
  for i in 0..<n {
    for j in 0..<n {
      if i == j {
        continue
      }
      let w = play_baseline(comps[i].picks, comps[j].picks, policy, max_ticks)
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
  print_table(
    "moba5 synergy tournament",
    "whole games, \{policy} vs \{policy}, each ordered pair once",
    wins,
    losses,
    draws,
    games,
  )
}

// -------------------------------------------------------------- the benchmark

///|
/// Running totals for one class of decision.
struct Tally {
  mut n : Int
  mut jev : Int
  mut floor : Int
  mut conf_hit : Double
  mut conf_hit_n : Int
  mut conf_miss : Double
  mut conf_miss_n : Int
}

///|
fn Tally::new() -> Tally {
  {
    n: 0,
    jev: 0,
    floor: 0,
    conf_hit: 0.0,
    conf_hit_n: 0,
    conf_miss: 0.0,
    conf_miss_n: 0,
  }
}

///|
/// The yes/no boundary for a noul question, by class. A `noul` answers a
/// probability, and naming the two sides sharpens where the boundary is; the
/// wording belongs with the request rather than with the ground truth, so it
/// lives here and not in `bench.mbt`.
fn noul_criteria(class_ : String) -> (String, String) {
  match class_ {
    "fight" =>
      (
        "We win the fight outright: every one of them is off the node and at least one of ours is still standing",
        "We do not win it outright: some of them are still standing, or we are wiped, or both sides survive",
      )
    "dive" =>
      (
        "The target dies and not one of ours is lost to the tower or to their team",
        "The target survives, or we trade at least one of our own for it",
      )
    "ability" =>
      (
        "Spending it on the first tick leaves us better off than holding it", "Holding it leaves us better off than spending it now",
      )
    _ => ("Yes", "No")
  }
}

///|
/// Build the request for one scenario: every question about that state.
fn scenario_questions(sc : @game.Scenario) -> Map[String, @lib.Question] {
  let qs : Map[String, @lib.Question] = Map([])
  for ask in sc.asks {
    if ask.form == "noul" {
      let (t, f) = noul_criteria(ask.class_)
      qs[ask.key] = @lib.Question::noul(
        ask.instructions,
        true_desc=t,
        false_desc=f,
      )
    } else if ask.form == "score" {
      qs[ask.key] = @lib.Question::score(
        ask.options,
        instructions=ask.instructions,
      )
    } else if ask.descriptions.length() == ask.options.length() &&
      ask.options.length() > 0 {
      let criteria : Map[String, String] = Map([])
      for i in 0..<ask.options.length() {
        criteria[ask.options[i]] = ask.descriptions[i]
      }
      qs[ask.key] = @lib.Question::choice(
        criteria,
        instructions=ask.instructions,
      )
    } else {
      qs[ask.key] = @lib.Question::choice_of(
        ask.options,
        instructions=ask.instructions,
      )
    }
  }
  qs
}

///|
/// Round a score answer to the rubric level it names.
fn to_level(v : Double) -> Int {
  let n = (v + 0.5).to_int()
  if n < 0 {
    0
  } else {
    n
  }
}

///|
/// A score answer is right if it rounds to the correct rubric level — the same
/// rule the floor is held to, so the two columns are comparable.
fn score_hit(answer : Double, truth : String) -> Bool {
  let want = @string.from_str(truth) catch { _ => -1 }
  to_level(answer) == want
}

///|
/// Did the heuristic floor get this one right? The floor answers in the same
/// vocabulary as the truth, so both columns go through the same check — which
/// also means both get the benefit of a tie the simulator could not separate.
fn floor_hit(ask : @game.Ask) -> Bool {
  @game.truth_accepts(ask.truth, ask.floor)
}

///|
/// The scored benchmark. Every scenario is one request; every question carries
/// the answer the simulator produced for it, so the output is an accuracy
/// table rather than a transcript.
async fn run_bench(opts : Opts, client : @lib.Client) -> Unit {
  let suite = @game.bench_suite()
  let mut asks_total = 0
  for sc in suite {
    asks_total += sc.ask_count()
  }
  @report.header(
    "moba5 benchmark — a policy against the simulator's own answers",
    if opts.dry {
      "the suite and the heuristic floor, no API"
    } else {
      "\{opts.model}, \{suite.length()} scenarios, \{asks_total} questions, one request per scenario"
    },
  )
  let tallies : Map[String, Tally] = Map([])
  fn tally(name : String) -> Tally {
    match tallies.get(name) {
      Some(t) => t
      None => {
        let t = Tally::new()
        tallies[name] = t
        t
      }
    }
  }

  let stats = Stats::new()
  let overall = Tally::new()
  let mut missing = 0
  for sc in suite {
    if opts.verbose || opts.dry {
      println("  \{sc.name} — \{sc.note}")
    }
    // The floor is scored whether or not the API is in play, so `--dry` still
    // produces a complete left-hand column.
    let mut answers : Map[String, (String, Double)] = Map([])
    if !opts.dry {
      let qs = scenario_questions(sc)
      let t0 = @env.now()
      let resp = client.system_one({
        state: sc.state,
        model: opts.model,
        questions: qs,
      }) catch {
        e => {
          println("    request failed: \{e}")
          missing += sc.ask_count()
          continue
        }
      }
      stats.api_ms += (@env.now() - t0).to_int()
      stats.requests += 1
      stats.input_tokens += resp.input_tokens
      let got : Map[String, (String, Double)] = Map([])
      for ask in sc.asks {
        if ask.form == "noul" {
          let p = @report.noul_at(resp, ask.key)
          let said = if p >= 0.5 { "true" } else { "false" }
          // A noul's confidence is how far it is from the coin flip.
          let conf = if p >= 0.5 { (p - 0.5) * 2.0 } else { (0.5 - p) * 2.0 }
          got[ask.key] = (said, conf)
        } else if ask.form == "score" {
          let (s, conf) = @report.score_at(resp, ask.key)
          got[ask.key] = ("\{to_level(s)}", conf)
          // Keep the raw value for the verbose line.
          got["\{ask.key}__raw"] = (@report.d2(s), conf)
        } else {
          let (c, conf) = @report.choice_at(resp, ask.key)
          got[ask.key] = (c, conf)
        }
      }
      answers = got
    }
    for ask in sc.asks {
      let t = tally(ask.class_)
      t.n += 1
      overall.n += 1
      let floor_ok = floor_hit(ask)
      if floor_ok {
        t.floor += 1
        overall.floor += 1
      }
      let mut said = ""
      let mut conf = 0.0
      let mut ok = false
      if !opts.dry {
        match answers.get(ask.key) {
          Some((s, c)) => {
            said = s
            conf = c
            // Score answers were already rounded to a rubric level, so every
            // form compares the same way — and a tie the simulator could not
            // separate accepts any of its members.
            ok = @game.truth_accepts(ask.truth, s)
          }
          None => ()
        }
        if ok {
          t.jev += 1
          overall.jev += 1
          t.conf_hit += conf
          t.conf_hit_n += 1
          overall.conf_hit += conf
          overall.conf_hit_n += 1
        } else {
          t.conf_miss += conf
          t.conf_miss_n += 1
          overall.conf_miss += conf
          overall.conf_miss_n += 1
        }
      }
      if opts.verbose || opts.dry {
        let truth_shown = if ask.form == "score" {
          "\{ask.truth} (\{ask.options[@string.from_str(ask.truth) catch { _ => 0 }]})"
        } else {
          ask.truth
        }
        println(
          "    \{@report.pad(ask.key, 22)} \{@report.pad(ask.class_, 9)} \{@report.pad(ask.tier, 6)} truth=\{truth_shown}",
        )
        println("        why: \{ask.why}")
        println(
          "        floor: \{ask.floor} \{if floor_ok { "hit" } else { "MISS" }}",
        )
        if !opts.dry {
          println(
            "        \{opts.model}: \{said} \{if ok { "hit" } else { "MISS" }} (conf \{@report.d2(conf)})",
          )
        }
      }
    }
    if opts.verbose || opts.dry {
      println("")
    }
  }

  // The table.
  println(
    "  class      n    \{@report.pad(if opts.dry { "—" } else { opts.model }, 16)} floor        conf(hit)  conf(miss)",
  )
  @report.rule(78)
  for name in @game.bench_classes {
    match tallies.get(name) {
      Some(t) =>
        if t.n > 0 {
          let jev_col = if opts.dry {
            "—"
          } else {
            "\{t.jev}/\{t.n}  \{@report.d2(t.jev.to_double() / t.n.to_double())}"
          }
          let ch = if t.conf_hit_n > 0 {
            @report.d2(t.conf_hit / t.conf_hit_n.to_double())
          } else {
            "—"
          }
          let cm = if t.conf_miss_n > 0 {
            @report.d2(t.conf_miss / t.conf_miss_n.to_double())
          } else {
            "—"
          }
          println(
            "  \{@report.pad(name, 10)} \{@report.pad(t.n.to_string(), 4)} \{@report.pad(jev_col, 16)} \{t.floor}/\{t.n}  \{@report.d2(t.floor.to_double() / t.n.to_double())}   \{@report.pad(ch, 10)} \{cm}",
          )
        }
      None => ()
    }
  }
  @report.rule(78)
  let jev_col = if opts.dry {
    "—"
  } else {
    "\{overall.jev}/\{overall.n}  \{@report.d2(overall.jev.to_double() / overall.n.to_double())}"
  }
  println(
    "  \{@report.pad("overall", 10)} \{@report.pad(overall.n.to_string(), 4)} \{@report.pad(jev_col, 16)} \{overall.floor}/\{overall.n}  \{@report.d2(overall.floor.to_double() / overall.n.to_double())}",
  )
  println("")
  if opts.dry {
    println(
      "  Every truth above was produced by the simulator, not written down by hand:",
    )
    println(
      "  `rules` rows were played out, `arith` rows are exact arithmetic the rules define,",
    )
    println(
      "  and `score` rows are the argmax of moba5's position score over the stated horizon.",
    )
    println("  Re-run without --dry to score a model against the same answers.")
    println("")
    return
  }
  if overall.conf_hit_n > 0 && overall.conf_miss_n > 0 {
    let ch = overall.conf_hit / overall.conf_hit_n.to_double()
    let cm = overall.conf_miss / overall.conf_miss_n.to_double()
    println(
      "  calibration: mean confidence \{@report.d2(ch)} when right, \{@report.d2(cm)} when wrong\{if ch > cm { " — the gap is in the right direction" } else { " — NOT separating right from wrong" }}",
    )
  }
  if missing > 0 {
    println("  \{missing} question(s) went unanswered because a request failed")
  }
  if stats.requests > 0 {
    println(
      "  \{stats.requests} requests decided \{overall.n} questions, \{@report.d0(stats.api_ms.to_double() / overall.n.to_double())} ms per question",
    )
    println(
      "  \{stats.input_tokens} input tokens (~$\{cost_of(stats.input_tokens)})",
    )
  }
  println("")
}

// ------------------------------------------------------------------- draft

///|
/// Ask Jev to rank the compositions from the raw archetype stats and the bare
/// mechanics — without being told that a frontline, mixed damage, crowd control
/// or range is good — then set its ranking beside the empirical arena. The
/// question: can a model *choose* a composition, not just play one?
async fn run_draft(
  client : @lib.Client,
  model : String,
  max_ticks : Int,
) -> Unit {
  let comps = @game.tournament_comps
  let n = comps.length()
  @report.header(
    "moba5 draft", "the model ranks five-champion comps from raw stats; set beside the teamfight arena",
  )
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
      "attack_range": Json(if kd.ranged { "ranged" } else { "melee" }),
      "ability": Json(kd.ability.name()),
      "ability_does": Json(kd.ability.describe()),
      "ability_cooldown": Json(kd.cooldown),
    })
  }

  let roster = []
  for key, _ in @game.kinds {
    roster.push(stat_json(key))
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
    "game": Json("Draft a team of five champions for a 5v5 teamfight."),
    "damage_rule": Json(
      "Each tick a champion deals its attack to one enemy. Damage dealt = attack * 100 / (100 + resist), where resist is the target's armor when the attacker deals physical and its magic_resist when the attacker deals magic. Armor does nothing against magic; magic_resist does nothing against physical.",
    ),
    "frontline_rule": Json(
      "While a frontline champion is alive with its team, enemy hits aimed at its non-frontline allies land on the frontline champion instead. A 'burst' ability ignores this.",
    ),
    "range_rule": Json(
      "A ranged champion can also attack an enemy standing one node away for half damage, taking nothing back. A melee champion cannot.",
    ),
    "ability_rule": Json(
      "Each champion's ability can be used once every `ability_cooldown` ticks. A stun removes the target's next turn entirely and deals no damage.",
    ),
    "win_rule": Json(
      "A champion at 0 hp is out of the fight. The team left standing wins.",
    ),
    "roster": Json(roster),
    "candidates": Json(cands),
  })
  let qs : Map[String, @lib.Question] = Map([])
  let rubric = [
    "Loses most 5v5 fights", "About even", "Wins most 5v5 fights", "Dominates almost every fight",
  ]
  for c in comps {
    qs["score_\{c.name}"] = @lib.Question::score(
      rubric,
      instructions="Composition '\{c.name}' = \{c.picks.join(" + ")}. In a 5v5 teamfight under the rules and roster in the state, how does it fare?",
    )
  }
  let names = []
  for c in comps {
    names.push(c.name)
  }
  qs["draft"] = @lib.Question::choice_of(
    names,
    instructions="You are drafting for a 5v5 teamfight. Which of these compositions gives the best chance to win the fight?",
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
  println("  comp        model score  model#   arena W-L  arena#")
  for i in 0..<n {
    let idx = aorder[i]
    let c = comps[idx]
    println(
      "   \{@report.pad(c.name, 10)}  \{@report.pad(@report.d2(jscore[idx]), 11)} \{@report.pad(jev_rank[idx].to_string(), 7)}  \{@report.pad("\{wins[idx]}-\{losses[idx]}", 9)} \{arena_rank[idx]}",
    )
  }
  println("")
  let arena_best = comps[aorder[0]].name
  println("  it would draft: \{pick} (conf \{@report.d2(pconf)})")
  println("  arena-strongest: \{arena_best}")
  if pick == arena_best {
    println("  → it drafted the empirically strongest comp.")
  } else {
    println("  → its pick differs from the arena's strongest.")
  }
  println(
    "  \{resp.input_tokens} input tokens (~$\{cost_of(resp.input_tokens)})",
  )
  println("")
}

// ----------------------------------------------------------------- plumbing

///|
async fn main {
  let cmd = @argparse.Command(
    "moba5",
    about="A headless 5v5 MOBA with fog of war, objectives and items, plus a benchmark scored against the simulator's own answers.",
    flags=[
      @argparse.FlagArg(
        "verbose",
        long="verbose",
        about="Print every decision, the team-level reads, and every benchmark question.",
      ),
      @argparse.FlagArg(
        "bench",
        long="bench",
        about="Run the scored benchmark: one request per scenario, marked against the simulator.",
      ),
      @argparse.FlagArg(
        "dry",
        long="dry",
        about="With --bench: print the suite and the heuristic floor's score without calling the API.",
      ),
      @argparse.FlagArg(
        "tournament",
        long="tournament",
        about="Round-robin the named comps as whole games and print a win table. Needs no API key.",
      ),
      @argparse.FlagArg(
        "arena",
        long="arena",
        about="Round-robin the named comps as pure 5v5 teamfights. Needs no API key.",
      ),
      @argparse.FlagArg(
        "draft",
        long="draft",
        about="Ask the model to rank the comps from raw archetype stats, against the empirical arena.",
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
        about="Team A policy: jev, scripted or smart.",
      ),
      @argparse.OptionArg(
        "b",
        long="b",
        default_values=["smart"],
        about="Team B policy: jev, scripted or smart.",
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
        default_values=["150"],
        about="Tick cap; the tie breaks on structure damage.",
      ),
      @argparse.OptionArg(
        "a-comp",
        long="a-comp",
        about="Team A composition: five comma-separated archetypes for top,jungle,mid,bot,support, or a comp name. Default `meta`.",
      ),
      @argparse.OptionArg(
        "b-comp",
        long="b-comp",
        about="Team B composition, same form. Default `meta`.",
      ),
      @argparse.OptionArg(
        "baseline",
        long="baseline",
        default_values=["smart"],
        about="The baseline used as the tournament's policy: scripted or smart.",
      ),
      @argparse.OptionArg(
        "replay",
        long="replay",
        about="Write the last game's replay to this file (JSON lines).",
      ),
      @argparse.OptionArg(
        "hcap-a",
        long="hcap-a",
        default_values=["100"],
        about="Team A stat handicap in percent (100 = full); scales attack and health.",
      ),
      @argparse.OptionArg(
        "hcap-b",
        long="hcap-b",
        default_values=["100"],
        about="Team B stat handicap in percent (100 = full).",
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
    team_b: opt_value(matches, "b").unwrap_or("smart"),
    comp_a: split_comp(opt_value(matches, "a-comp")),
    comp_b: split_comp(opt_value(matches, "b-comp")),
    games: parse_int(opt_value(matches, "games"), 1),
    max_ticks: parse_int(opt_value(matches, "max-ticks"), 150),
    verbose: matches.flags.get("verbose").unwrap_or(false),
    tournament: matches.flags.get("tournament").unwrap_or(false),
    arena: matches.flags.get("arena").unwrap_or(false),
    draft: matches.flags.get("draft").unwrap_or(false),
    bench: matches.flags.get("bench").unwrap_or(false),
    dry: matches.flags.get("dry").unwrap_or(false),
    baseline: opt_value(matches, "baseline").unwrap_or("smart"),
    hcap_a: parse_int(opt_value(matches, "hcap-a"), 100),
    hcap_b: parse_int(opt_value(matches, "hcap-b"), 100),
    replay: opt_value(matches, "replay").unwrap_or(""),
  }
  // The arena, the tournament and a dry benchmark are simulator-only: they
  // need neither a team policy nor a key.
  let offline = opts.tournament || opts.arena || (opts.bench && opts.dry)
  if !offline && !opts.bench && !opts.draft {
    for kind in [opts.team_a, opts.team_b] {
      if kind != "jev" && kind != "scripted" && kind != "smart" {
        @stdio.stderr.write(
          "moba5: team policy must be jev, scripted, or smart\n",
        )
        @sys.exit(1)
        return
      }
    }
  }
  let needs_api = !offline &&
    (opts.draft || opts.bench || opts.team_a == "jev" || opts.team_b == "jev")
  if needs_api && api_key.is_empty() {
    @stdio.stderr.write(
      "moba5: no API key; set TYPESAFEAI_API_KEY or pass --api-key (or use --bench --dry)\n",
    )
    @sys.exit(1)
    return
  }
  run(opts) catch {
    @lib.ApiError::Http(code, reason, body) => {
      @stdio.stderr.write(
        "moba5: HTTP \{code} \{reason}: \{@report.clip(body, 300)}\n",
      )
      @sys.exit(1)
    }
    @lib.ApiError::InvalidResponse(msg) | @lib.ApiError::InvalidRequest(msg) => {
      @stdio.stderr.write("moba5: \{msg}\n")
      @sys.exit(1)
    }
    _ => {
      @stdio.stderr.write("moba5: unexpected error\n")
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
    run_tournament(opts.baseline, opts.max_ticks)
  }
  if opts.arena || opts.tournament {
    return
  }
  let client = if opts.base_url == "https://api.typesafe.ai" {
    @lib.Client::new(opts.api_key)
  } else {
    @lib.Client::with_base_url(opts.api_key, opts.base_url)
  }
  if opts.bench {
    run_bench(opts, client)
    return
  }
  if opts.draft {
    run_draft(client, opts.model, opts.max_ticks)
    return
  }
  let stats = Stats::new()
  @report.header(
    "5v5 MOBA",
    "A=\{opts.team_a} [\{opts.comp_a.join("/")}] vs B=\{opts.team_b} [\{opts.comp_b.join("/")}], \{opts.games} game(s), fog of war",
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
    let per_req_dec = stats.decisions.to_double() / stats.requests.to_double()
    println("")
    println(
      "  \{stats.requests} requests decided \{stats.decisions} champion actions (\{@report.d2(per_req_dec)} per request)",
    )
    println(
      "  \{@report.d0(per_req)} ms/request, \{@report.d0(per_dec)} ms per champion decision",
    )
    println(
      "  \{stats.input_tokens} input tokens (~$\{cost_of(stats.input_tokens)}), wall clock \{@report.d1(wall.to_double() / 1000.0)}s",
    )
    println(
      "  illegal picks: \{stats.illegal} (the choices ARE the legal moves)",
    )
    if stats.fallback_ticks > 0 {
      println(
        "  scripted fallback ticks after API failures: \{stats.fallback_ticks}",
      )
    }
    // What it actually did with the action space the 5v5 game added.
    let parts = []
    for k in @game.action_kinds {
      let n = stats.used.get(k).unwrap_or(0)
      if n > 0 {
        parts.push("\{k}=\{n}")
      }
    }
    println("  actions chosen: " + parts.join(" "))
    if stats.fog_asked > 0 {
      println(
        "  fog-of-war read: \{stats.fog_right}/\{stats.fog_asked} correct (\{@report.d2(stats.fog_right.to_double() / stats.fog_asked.to_double())}), mean confidence \{@report.d2(stats.fog_conf / stats.fog_asked.to_double())} — scored against where the enemies actually were",
      )
    }
  }
  if opts.replay != "" && last_replay.length() > 0 {
    @fs.write_file(opts.replay, last_replay.join("\n") + "\n")
    println("  replay of the last game written to \{opts.replay}")
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
/// Parse a composition: either the name of one in `tournament_comps`, or five
/// comma-separated archetype keys. An empty value is `meta`, so the default
/// game is a real one rather than five uniform bodies.
fn split_comp(v : String?) -> Array[String] {
  let raw = match v {
    Some(s) => s
    None => ""
  }
  if raw == "" {
    return @game.comp_by_name("meta")
  }
  // A bare name with no comma is a named comp.
  let mut has_comma = false
  for ch in raw {
    if ch == ',' {
      has_comma = true
    }
  }
  if !has_comma {
    return @game.comp_by_name(raw)
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
  for i in 0..<5 {
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
