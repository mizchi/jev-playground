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
  /// With --bench: ask the identical questions this many times. The model is
  /// probabilistic, so one pass cannot separate a real gap from a draw.
  repeat : Int
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
  /// Requests that failed once and were retried, and requests that failed
  /// every attempt. A measurement has to say which of its numbers are missing.
  mut retries : Int
  mut failures : Int
  mut last_error : String
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
    retries: 0,
    failures: 0,
    last_error: "",
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

///|
/// How many times a request is attempted before it is called a failure, and
/// how long the first wait is (doubling each time).
const ATTEMPTS = 3

///|
const BACKOFF_MS = 400

///|
/// Send a request, retrying a failure with backoff.
///
/// Without this a single transient failure silently degrades a measurement
/// rather than showing up as one: in a game the tick falls back to the
/// scripted policy, and in the benchmark a whole scenario's questions go
/// unanswered and are scored as misses. Neither is a fact about the model.
/// `stats.retries` counts what happened so the report can say so.
async fn ask_with_retry(
  client : @lib.Client,
  req : @lib.SystemOneRequest,
  stats : Stats,
) -> @lib.SystemOneResponse? {
  let mut wait = BACKOFF_MS
  for attempt in 0..<ATTEMPTS {
    let t0 = @env.now()
    let resp = client.system_one(req) catch {
      e => {
        stats.api_ms += (@env.now() - t0).to_int()
        if attempt + 1 < ATTEMPTS {
          stats.retries += 1
          @async.sleep(wait)
          wait *= 2
          continue
        }
        stats.failures += 1
        stats.last_error = "\{e}"
        return None
      }
    }
    stats.api_ms += (@env.now() - t0).to_int()
    stats.requests += 1
    stats.input_tokens += resp.input_tokens
    return Some(resp)
  }
  None
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
  let resp = match
    ask_with_retry(client, { state, model, questions: qs, }, stats) {
    Some(r) => r
    None => {
      // Every attempt failed. The game must keep moving; fall back to the
      // scripted policy and say so in the report.
      stats.fallback_ticks += 1
      for e in @game.scripted_team_actions(g, team) {
        out[e.0] = e.1
      }
      return out
    }
  }

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
/// What one question did across every repeat. Keeping the individual answers
/// rather than only a running total is what makes the noise floor below
/// computable: a model that flips its own answer between two identical runs
/// has told you how large a difference has to be before it means anything.
struct AskRuns {
  ask : @game.Ask
  /// Which scenario this question was asked in, for the detail lines.
  where_ : String
  said : Array[String]
  conf : Array[Double]
  mut hits : Int
}

///|
fn AskRuns::new(ask : @game.Ask, where_ : String) -> AskRuns {
  { ask, where_, said: [], conf: [], hits: 0, }
}

///|
/// Whether this question got the same answer every time it was asked. Only
/// meaningful once it has been answered twice, which `comparable` reports.
fn AskRuns::comparable(self : AskRuns) -> Bool {
  self.said.length() >= 2
}

///|
fn AskRuns::stable(self : AskRuns) -> Bool {
  for s in self.said {
    if s != self.said[0] {
      return false
    }
  }
  true
}

///|
/// Running totals for one class of decision, pooled over every repeat.
struct Tally {
  /// Questions in this class, and answers collected for them (questions ×
  /// repeats, minus anything a failed request lost).
  mut asks : Int
  mut n : Int
  mut jev : Int
  /// The floor answers once and deterministically, so it is counted per
  /// QUESTION and its denominator is `asks`, not `n`.
  mut floor : Int
  /// Questions answered at least twice, and how many of those never moved.
  mut comparable : Int
  mut stable : Int
  /// Every truth in the class, so the report can say what the best CONSTANT
  /// answer would score. A class where "always no" scores 0.80 cannot
  /// distinguish a model from a rubber stamp, and the accuracy column alone
  /// does not show that.
  truths : Array[String]
  mut conf_hit : Double
  mut conf_hit_n : Int
  mut conf_miss : Double
  mut conf_miss_n : Int
}

///|
fn Tally::new() -> Tally {
  {
    asks: 0,
    n: 0,
    jev: 0,
    floor: 0,
    comparable: 0,
    stable: 0,
    truths: [],
    conf_hit: 0.0,
    conf_hit_n: 0,
    conf_miss: 0.0,
    conf_miss_n: 0,
  }
}

///|
/// What the best CONSTANT answer scores on these questions: the share of the
/// most common truth.
///
/// This is the column that says whether an accuracy figure is a measurement.
/// A model that answers "no" to every question in a class where four of five
/// truths are "no" scores 0.80 and has read nothing, and the `fight` class was
/// built balanced (0.50 here) precisely so that a rubber stamp cannot beat
/// chance on it.
fn trivial_rate(truths : Array[String]) -> String {
  if truths.length() == 0 {
    return "—"
  }
  let seen : Array[String] = []
  let counts : Array[Int] = []
  for t in truths {
    let mut at = -1
    for i in 0..<seen.length() {
      if seen[i] == t {
        at = i
      }
    }
    if at < 0 {
      seen.push(t)
      counts.push(1)
    } else {
      counts[at] += 1
    }
  }
  let mut best = 0
  for c in counts {
    if c > best {
      best = c
    }
  }
  rate(best, truths.length())
}

///|
fn rate(hits : Int, n : Int) -> String {
  if n == 0 {
    "—"
  } else {
    @report.d2(hits.to_double() / n.to_double())
  }
}

///|
/// The yes/no boundary for a noul question, by class. A `noul` answers a
/// probability, and naming the two sides sharpens where the boundary is; the
/// wording belongs with the request rather than with the ground truth, so it
/// lives here and not in `bench.mbt`.
///
/// The two sides are kept the same SHAPE on purpose. The `fight` pair used to
/// read "we win outright: every one of them off the node and at least one of
/// ours standing" against "we do not win it outright: some of them are still
/// standing, or we are wiped, or both sides survive" — one clause against
/// three, with "do not" and "wiped" on the second. Against a balanced set the
/// model answered `false` to 31 of 32, and a lopsided pair of criteria is a
/// live explanation for that which has nothing to do with reading a fight. So
/// each side is now a single mirrored clause; docs/56 §4 reports what the
/// change was worth.
fn noul_criteria(class_ : String) -> (String, String) {
  match class_ {
    "fight" =>
      (
        "When the fight ends, at least one of ours is standing on the node and none of theirs is",
        "When the fight ends, at least one of theirs is standing on the node",
      )
    "dive" =>
      (
        "The target dies and not one of ours is lost to the tower or to their team",
        "The target survives, or we trade at least one of our own for it",
      )
    "ability" =>
      (
        "Spending it now leaves us better off than holding it", "Holding it leaves us better off than spending it now",
      )
    "retreat" =>
      (
        "Committing leaves us better off than backing away", "Backing away leaves us better off than committing",
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
/// Did the heuristic floor get this one right? The floor answers in the same
/// vocabulary as the truth, so both columns go through the same check — which
/// also means both get the benefit of a tie the simulator could not separate.
fn floor_hit(ask : @game.Ask) -> Bool {
  @game.truth_accepts(ask.truth, ask.floor)
}

///|
/// Read one answer out of a response, as the string the truth is compared
/// against plus a confidence. A `noul` answers a probability, so its
/// confidence is how far it is from the coin flip.
fn read_answer(
  resp : @lib.SystemOneResponse,
  ask : @game.Ask,
) -> (String, Double) {
  if ask.form == "noul" {
    let p = @report.noul_at(resp, ask.key)
    let said = if p >= 0.5 { "true" } else { "false" }
    let conf = if p >= 0.5 { (p - 0.5) * 2.0 } else { (0.5 - p) * 2.0 }
    (said, conf)
  } else if ask.form == "score" {
    let (s, conf) = @report.score_at(resp, ask.key)
    ("\{to_level(s)}", conf)
  } else {
    @report.choice_at(resp, ask.key)
  }
}

///|
/// The scored benchmark. Every scenario is one request; every question carries
/// the answer the simulator produced for it, so the output is an accuracy
/// table rather than a transcript.
///
/// `--repeat N` asks the identical questions N times. That is not padding: the
/// model is probabilistic, so one pass cannot tell a real gap from a draw, and
/// the fraction of questions whose own answer moves between passes is the floor
/// any claimed difference has to clear (docs/37 and docs/41 call it draw
/// noise). An unanswered question — a request that failed every attempt — is
/// left out rather than scored wrong: missing data is not a mistake.
async fn run_bench(opts : Opts, client : @lib.Client) -> Unit {
  let suite = @game.bench_suite()
  let repeat = if opts.dry || opts.repeat < 1 { 1 } else { opts.repeat }
  let mut asks_total = 0
  for sc in suite {
    asks_total += sc.ask_count()
  }
  @report.header(
    "moba5 benchmark — a policy against the simulator's own answers",
    if opts.dry {
      "the suite and the heuristic floor, no API"
    } else {
      "\{opts.model}, \{suite.length()} scenarios, \{asks_total} questions × \{repeat} run(s)"
    },
  )

  // One row per question, in suite order, reused across every repeat so the
  // questions really are identical between runs.
  let rows : Array[AskRuns] = []
  for sc in suite {
    for ask in sc.asks {
      rows.push(AskRuns::new(ask, "\{sc.name} — \{sc.note}"))
    }
  }
  let stats = Stats::new()
  // Per-run overall scores, so the spread is visible rather than averaged away.
  let per_run : Array[Int] = []
  for run in 0..<repeat {
    if opts.dry {
      break
    }
    let mut row = 0
    let mut run_hits = 0
    let mut run_answered = 0
    for sc in suite {
      let qs = scenario_questions(sc)
      let resp = ask_with_retry(
        client,
        { state: sc.state, model: opts.model, questions: qs, },
        stats,
      )
      for ask in sc.asks {
        let r = rows[row]
        row += 1
        match resp {
          Some(got) => {
            let (said, conf) = read_answer(got, ask)
            r.said.push(said)
            r.conf.push(conf)
            run_answered += 1
            if @game.truth_accepts(ask.truth, said) {
              r.hits += 1
              run_hits += 1
            }
          }
          None => ()
        }
      }
    }
    per_run.push(run_hits)
    if repeat > 1 {
      println(
        "  run \{run + 1}: \{run_hits}/\{run_answered}  \{rate(run_hits, run_answered)}",
      )
    }
  }
  if repeat > 1 && !opts.dry {
    println("")
  }

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

  let overall = Tally::new()
  let mut missing = 0
  let mut shown = ""
  for r in rows {
    let ask = r.ask
    let t = tally(ask.class_)
    for acc in [t, overall] {
      acc.asks += 1
      acc.n += r.said.length()
      acc.jev += r.hits
      acc.truths.push(ask.truth)
      if floor_hit(ask) {
        acc.floor += 1
      }
      if r.comparable() {
        acc.comparable += 1
        if r.stable() {
          acc.stable += 1
        }
      }
    }
    missing += repeat - r.said.length()
    for k in 0..<r.said.length() {
      let ok = @game.truth_accepts(ask.truth, r.said[k])
      for acc in [t, overall] {
        if ok {
          acc.conf_hit += r.conf[k]
          acc.conf_hit_n += 1
        } else {
          acc.conf_miss += r.conf[k]
          acc.conf_miss_n += 1
        }
      }
    }
    if !(opts.verbose || opts.dry) {
      continue
    }
    if r.where_ != shown {
      println("")
      println("  \{r.where_}")
      shown = r.where_
    }
    let truth_shown = if ask.form == "score" {
      let lvl : Int = @string.from_str(ask.truth) catch { _ => 0 }
      "\{ask.truth} (\{ask.options[lvl]})"
    } else {
      ask.truth
    }
    println(
      "    \{@report.pad(ask.key, 22)} \{@report.pad(ask.class_, 9)} \{@report.pad(ask.tier, 6)} truth=\{truth_shown}",
    )
    println("        why: \{ask.why}")
    println(
      "        floor: \{ask.floor} \{if floor_hit(ask) { "hit" } else { "MISS" }}",
    )
    if r.said.length() > 0 {
      let marks = []
      for k in 0..<r.said.length() {
        let ok = @game.truth_accepts(ask.truth, r.said[k])
        marks.push("\{r.said[k]}\{if ok { "" } else { "*" }}")
      }
      println(
        "        \{opts.model}: \{r.hits}/\{r.said.length()} — \{marks.join(", ")}\{if r.comparable() && !r.stable() { "   (moved between runs)" } else { "" }}",
      )
    }
  }
  if opts.verbose || opts.dry {
    println("")
  }

  let model_col = if opts.dry { "—" } else { opts.model }
  println(
    "  class      asks  ans  \{@report.pad(model_col, 16)} floor        const  stable   conf(hit)  conf(miss)",
  )
  @report.rule(95)
  fn row_of(name : String, t : Tally, with_const : Bool) -> Unit {
    let jev_col = if opts.dry || t.n == 0 {
      "—"
    } else {
      "\{t.jev}/\{t.n}  \{rate(t.jev, t.n)}"
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
      "  \{@report.pad(name, 10)} \{@report.pad(t.asks.to_string(), 5)} \{@report.pad(t.n.to_string(), 4)} \{@report.pad(jev_col, 16)} \{@report.pad("\{t.floor}/\{t.asks}  \{rate(t.floor, t.asks)}", 12)} \{@report.pad(if with_const { trivial_rate(t.truths) } else { "—" }, 6)} \{@report.pad(rate(t.stable, t.comparable), 8)} \{@report.pad(ch, 10)} \{cm}",
    )
  }

  for name in @game.bench_classes {
    match tallies.get(name) {
      Some(t) => if t.asks > 0 { row_of(name, t, true) }
      None => ()
    }
  }
  @report.rule(95)
  // No `const` on this row: the most common truth across ten mixed classes is
  // not a baseline for anything.
  row_of("overall", overall, false)
  // The pooled `overall` weights a class by how many questions it has, and
  // that count is an artifact of which scenarios happened to be able to answer
  // it — `power` rides along on almost every state, `macro` on almost none. So
  // print the mean over classes as well, which does not move when a class
  // gains questions. When the two disagree, the class mean is the one to read.
  let mut jev_sum = 0.0
  let mut floor_sum = 0.0
  let mut classes = 0
  for name in @game.bench_classes {
    match tallies.get(name) {
      Some(t) =>
        if t.asks > 0 {
          classes += 1
          floor_sum += t.floor.to_double() / t.asks.to_double()
          if t.n > 0 {
            jev_sum += t.jev.to_double() / t.n.to_double()
          }
        }
      None => ()
    }
  }
  if classes > 0 {
    let n = classes.to_double()
    let jev_mean = if opts.dry { "—" } else { @report.d2(jev_sum / n) }
    println(
      "  \{@report.pad("class mean", 10)} \{@report.pad("\{classes}", 5)}      \{@report.pad(jev_mean, 16)} \{@report.d2(floor_sum / n)}",
    )
  }
  println("")

  if opts.dry {
    println(
      "  the heuristic floor gets \{overall.floor}/\{overall.asks} = \{rate(overall.floor, overall.asks)}",
    )
    println("")
    println(
      "  Every truth above was produced by the simulator, not written down by hand:",
    )
    println(
      "  `rules` rows were played out, `arith` rows are exact arithmetic the rules define,",
    )
    println(
      "  and `score` rows are the argmax of moba5's position score over the stated horizon.",
    )
    println(
      "  Re-run without --dry to score a model against the same answers, and with",
    )
    println(
      "  --repeat N to see how much of any difference is the model's own draw noise.",
    )
    println("")
    return
  }

  // The three readings that decide whether the accuracy column means anything.
  if overall.comparable > 0 {
    let moved = overall.comparable - overall.stable
    println(
      "  self-consistency: \{overall.stable}/\{overall.comparable} questions answered the same way every run",
    )
    if moved > 0 {
      println(
        "  → \{moved} moved on their own, so a gap under \{rate(moved, overall.comparable)} of the suite is draw noise",
      )
    }
  }
  if overall.conf_hit_n > 0 && overall.conf_miss_n > 0 {
    let ch = overall.conf_hit / overall.conf_hit_n.to_double()
    let cm = overall.conf_miss / overall.conf_miss_n.to_double()
    println(
      "  calibration: mean confidence \{@report.d2(ch)} when right, \{@report.d2(cm)} when wrong\{if ch > cm { " — the gap is in the right direction" } else { " — NOT separating right from wrong" }}",
    )
  }
  if per_run.length() > 1 {
    let mut lo = per_run[0]
    let mut hi = per_run[0]
    for v in per_run {
      if v < lo {
        lo = v
      }
      if v > hi {
        hi = v
      }
    }
    println(
      "  per-run spread: \{lo} to \{hi} of \{asks_total} (\{rate(lo, asks_total)} to \{rate(hi, asks_total)}), floor \{rate(overall.floor, overall.asks)}",
    )
  }
  if stats.retries > 0 {
    println("  \{stats.retries} request(s) failed once and were retried")
  }
  if stats.failures > 0 {
    println(
      "  \{stats.failures} request(s) failed every attempt: \{@report.clip(stats.last_error, 120)}",
    )
  }
  if missing > 0 {
    println(
      "  \{missing} answer(s) missing because a request failed — left out, not scored as wrong",
    )
  }
  if stats.requests > 0 && overall.n > 0 {
    println(
      "  \{stats.requests} requests decided \{overall.n} answers, \{@report.d0(stats.api_ms.to_double() / overall.n.to_double())} ms per answer",
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
  let stats = Stats::new()
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
  let resp = match
    ask_with_retry(client, { state, model, questions: qs, }, stats) {
    Some(r) => r
    None => {
      println(
        "  draft request failed after \{ATTEMPTS} attempts: \{stats.last_error}",
      )
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
        "repeat",
        long="repeat",
        default_values=["1"],
        about="--bench: ask the identical questions this many times, and report the spread and the model's own self-consistency.",
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
    repeat: parse_int(opt_value(matches, "repeat"), 1),
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
