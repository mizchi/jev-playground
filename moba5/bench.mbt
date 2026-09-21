///|
/// The scored benchmark: situations whose correct answer the simulator
/// produces, so a policy's decisions can be marked rather than admired.
///
/// The 3v3 prototype could only report win/loss against a bot. That measures
/// something, but it cannot say *which* judgments were wrong, and it moves
/// whenever the bot does. Here every question carries the answer the rules
/// give, with the derivation named, so the output is an accuracy table per
/// class of decision — and the same table for a hand-written heuristic, as a
/// floor.
///
/// Three tiers of truth, labelled per question, because they are not equally
/// strong and pretending otherwise would be the easiest way to make a
/// benchmark look better than it is:
///
/// | tier | what it means |
/// | --- | --- |
/// | `rules` | The simulator plays the situation out. The answer is the rules' own outcome — a fight won, a dive survived, a champion actually standing on a node. Nothing to disagree with. |
/// | `arith` | Exact arithmetic the rules define (ticks survivable under a tower, team power, how many enemies are outside our vision). Not played out, but not a judgment either. |
/// | `score` | The argmax of `Game::position_score` over a stated horizon, with the enemy playing the strong baseline. A stated objective, not a fact; a reader who weights positions differently should read these rows differently. |
///
/// Every scenario is one request: a single state with several questions about
/// it, which is the fan-out shape docs/02 established and the reason the whole
/// suite costs a handful of round trips. Questions are built by the `ask_*`
/// helpers below rather than written out per scenario, so a class's wording and
/// its oracle exist once and every scenario that can answer it gets the same
/// question.

///|
/// One question, with the answer the simulator gives for it.
pub(all) struct Ask {
  /// Unique within its scenario; also the question name on the wire.
  key : String
  /// The class of decision, for the per-class accuracy table.
  class_ : String
  /// "choice", "noul" or "score".
  form : String
  /// "rules", "arith" or "score" — see the table above.
  tier : String
  instructions : String
  /// Choice option names, or the ordered rubric for a score question. Empty
  /// for a noul.
  options : Array[String]
  /// One description per option, or empty to read the options by name alone.
  descriptions : Array[String]
  /// The correct answer: an option name, "true"/"false", or a rubric index.
  ///
  /// Occasionally the simulator cannot separate two options — two plans that
  /// reach the same position, say. Rather than let the option order decide and
  /// mark a defensible answer wrong, such an ask carries every tying option,
  /// joined by "|", and `truth_accepts` treats any of them as correct.
  truth : String
  /// How that answer was derived, printed with the results.
  why : String
  /// What the repository's own hand-written heuristic answers. The floor a
  /// decision model has to clear to be worth its round trip.
  floor : String
}

///|
/// A state and every question asked about it. One request per scenario.
pub(all) struct Scenario {
  name : String
  note : String
  state : Json
  asks : Array[Ask]
}

///|
pub fn Scenario::ask_count(self : Scenario) -> Int {
  self.asks.length()
}

///|
/// Whether `answer` is one of the answers `truth` accepts. Anything but a tie
/// is a plain string compare; a tie is a "|"-joined set and any member counts.
pub fn truth_accepts(truth : String, answer : String) -> Bool {
  if truth == answer {
    return true
  }
  let cur = StringBuilder()
  for ch in truth {
    if ch == '|' {
      if cur.to_string() == answer {
        return true
      }
      cur.reset()
    } else {
      cur.write_char(ch)
    }
  }
  cur.to_string() == answer
}

// ------------------------------------------------------------------ builders

///|
/// Put a champion at a level, with health and stats to match.
fn at_level(c : Champ, level : Int) -> Unit {
  c.xp = (level - 1) * LEVEL_XP
  c.level = level
  c.refresh_hp()
  c.hp = c.max_hp
}

///|
/// Set a champion's health as a percentage of its maximum.
fn at_hp(c : Champ, pct : Int) -> Unit {
  let v = c.max_hp * pct / 100
  c.hp = if v < 1 { 1 } else { v }
}

///|
/// A staged game: both comps, everybody at `level`, at a given tick.
fn stage(
  comp_a : Array[String],
  comp_b : Array[String],
  level : Int,
  tick : Int,
) -> Game {
  let g = Game::with_comps(comp_a, comp_b)
  g.tick = tick
  for c in g.champs {
    at_level(c, level)
  }
  g
}

///|
/// Send everyone home, so a scenario can then place exactly the champions it
/// is about. Without this a scenario inherits ten champions in their lanes and
/// every question is about a situation nobody designed.
fn park_all(g : Game) -> Unit {
  for c in g.champs {
    c.node = base_of(c.team)
  }
}

///|
/// The observation a scenario sends, plus a memory that has already seen
/// whatever was visible when it was built.
fn observe(g : Game, team : Int) -> (Json, Memory) {
  let mem = Memory::new()
  mem.observe(g, team)
  (g.observation(team, mem), mem)
}

///|
/// Option names and descriptions for "which enemy", over the enemies on a node.
fn enemy_options(
  g : Game,
  node : Int,
  team : Int,
) -> (Array[String], Array[String]) {
  let names = []
  let descs = []
  for e in g.champs_at(node, enemy_of(team)) {
    names.push(e.name)
    let wall = g.guarded_target(e, node)
    let reach = if wall.id == e.id {
      "reachable"
    } else {
      "shielded by their frontline \{wall.name}"
    }
    descs.push(
      "\{e.kind}, level \{e.level}, hp \{e.hp}/\{e.max_hp}, armor \{e.armor()}, magic resist \{e.mr()}, deals \{if e.dmg_type == DMG_PHYSICAL { "physical" } else { "magic" }} \{g.raw_attack(e)} per tick, \{if e.frontline { "frontline" } else { "backline" }}, \{reach}",
    )
  }
  (names, descs)
}

///|
/// Option names and descriptions for the shop.
fn item_options() -> (Array[String], Array[String]) {
  let names = []
  let descs = []
  for it in items {
    names.push(it.key)
    descs.push(it.note)
  }
  (names, descs)
}

///|
/// The champion id whose name is `name`, or -1.
fn champ_named(g : Game, name : String) -> Int {
  for c in g.champs {
    if c.name == name {
      return c.id
    }
  }
  -1
}

// ------------------------------------------------------------- ask builders
//
// One builder per class. The wording, the oracle and the floor's answer each
// exist once here, so every scenario that can answer a class asks it the same
// way and a class's rows are comparable across scenarios.

///|
/// `fight` — does committing on this node win the fight outright? Played out.
fn ask_fight(g : Game, node : Int, team : Int) -> Ask {
  let r = g.simulate_fight(node, 16)
  let won = r.winner == team
  let mine = g.champs_at(node, team).length()
  let theirs = g.champs_at(node, enemy_of(team)).length()
  {
    key: "we_win_this_fight",
    class_: "fight",
    form: "noul",
    tier: "rules",
    instructions: "Our \{mine} champion(s) and \{theirs} of theirs are standing on \{node_name(node)}. If we commit to this fight right now and nobody runs, do we win it — every one of them off the node and at least one of ours still standing?",
    options: [],
    descriptions: [],
    truth: if won {
      "true"
    } else {
      "false"
    },
    why: "played the fight out: after \{r.ticks} ticks A had \{r.a_standing} standing (\{r.a_hp} hp), B had \{r.b_standing} (\{r.b_hp} hp)",
    // The floor commits on a body count, which is the rule of thumb everyone
    // starts with and the one a worn fight breaks.
    floor: if mine >= theirs {
      "true"
    } else {
      "false"
    },
  }
}

///|
/// `focus` — which enemy should the team's damage go into first? The answer is
/// found by playing the fight out once per focus target.
fn ask_focus(g : Game, node : Int, team : Int, note : String) -> Ask {
  let (names, descs) = enemy_options(g, node, team)
  let floor_focus = match g.focus_pick(node, team) {
    Some(t) => t.name
    None => ""
  }
  {
    key: "focus_first",
    class_: "focus",
    form: "choice",
    tier: "rules",
    instructions: "In that fight on \{node_name(node)}, which enemy champion should our team focus its attacks on first? A hit aimed at one of their backline lands on their frontline instead, while their frontline is alive.\{note}",
    options: names,
    descriptions: descs,
    truth: g.best_focus_names(node, team, 16),
    why: "played the fight out once per focus target and kept the order that left us the most bodies and health",
    // The floor hits the softest body it can reach, which is what focus fire
    // means and what a durable frontline is drafted to punish.
    floor: floor_focus,
  }
}

///|
/// `retreat` — commit on this node, or break off? Priced over a short horizon
/// with both sides on the strong baseline afterwards.
fn ask_retreat(g : Game, node : Int, team : Int) -> Ask {
  let commit = g.fight_actions(node)
  let back : Map[Int, Action] = Map([])
  for c in g.champs_at(node, team) {
    let away = step_toward(c.node, base_of(team))
    back[c.id] = if away != c.node { Move(away) } else { Hold }
  }
  let s_commit = g.simulate_opening(team, commit, 8)
  let s_back = g.simulate_opening(team, back, 8)
  {
    key: "commit_or_disengage",
    class_: "retreat",
    form: "choice",
    tier: "score",
    instructions: "What should the champions we have on \{node_name(node)} do this tick: swing at the enemies standing there, or walk back toward our own base?",
    options: ["fight_now", "walk_away"],
    descriptions: [
      "Commit to the fight on this node with the bodies we have there", "Break off toward our base and come back on better terms",
    ],
    truth: tied_best(["fight_now", "walk_away"], [s_commit, s_back]),
    why: "eight ticks forward with both sides on the strong baseline: fighting scored \{s_commit}, walking away scored \{s_back}",
    // The floor commits exactly when it would win the fight outright, which
    // ignores everything the position is worth afterwards.
    floor: if g.fight_is_won(node, team, 16) {
      "fight_now"
    } else {
      "walk_away"
    },
  }
}

///|
/// `ability` — spend this champion's cooldown on the first tick of the fight,
/// or hold it? A stun deals no damage at all, so the answer is pure timing.
fn ask_ability(g : Game, node : Int, champ_id : Int) -> Ask {
  let c = g.champs[champ_id]
  let team = c.team
  let now_action = match c.ability {
    Stun(_) =>
      match g.cc_pick(node, team) {
        Some(t) => Some(Cast(c.ability, t.id))
        None => None
      }
    Nuke(_) =>
      match g.backline_pick(node, team) {
        Some(t) => Some(Cast(c.ability, t.id))
        None => None
      }
    Execute(_) =>
      match g.focus_pick(node, team) {
        Some(t) => Some(Cast(c.ability, t.id))
        None => None
      }
    Aoe(_) | Heal(_) | Shield(_) => Some(Cast(c.ability, -1))
    NoAbility | Blink => None
  }
  let now = g.simulate_fight_opening(node, champ_id, now_action, 16)
  let held = g.simulate_fight_opening(node, champ_id, None, 16)
  let spend = now.score_for(team) > held.score_for(team)
  {
    key: "spend_\{c.ability.name()}_now",
    class_: "ability",
    form: "noul",
    tier: "rules",
    instructions: "\{c.name}'s \{c.ability.name()} is off cooldown, on \{node_name(node)}. It does this: \{c.ability.describe()}. Should it be spent on the first tick of this fight, rather than held for later in it?",
    options: [],
    descriptions: [],
    truth: if spend {
      "true"
    } else {
      "false"
    },
    why: "spending it scored \{now.score_for(team)} for us, holding it scored \{held.score_for(team)}",
    // The floor is `fight.mbt`'s timing rule, which is a decent heuristic and
    // still only a heuristic.
    floor: if g.ability_play(c) is Some(_) {
      "true"
    } else {
      "false"
    },
  }
}

///|
/// `lane` — which of our lanes is closest to losing a structure to their
/// minions? Structure health divided by minion damage, which the state gives.
fn ask_lane(g : Game, team : Int) -> Ask {
  let (worst, ticks) = g.lane_under_pressure(team)
  // The floor answers "the lane they are pushing hardest", ignoring how much
  // health the structure there actually has left.
  let mut floor_lane = "none"
  let mut worst_push = PUSH_TO_TOWER - 1
  for li in 0..<3 {
    let against = if team == TEAM_A { -g.push[li] } else { g.push[li] }
    if against > worst_push {
      worst_push = against
      floor_lane = lanes[li]
    }
  }
  {
    key: "lane_in_most_danger",
    class_: "lane",
    form: "choice",
    tier: "arith",
    instructions: "Which of our three lanes is closest to losing a structure to their minions? Their minion pressure per lane and every structure's health are both in the state. Minions never damage a nexus, so a lane whose towers are already gone is not about to fall to them.",
    options: ["top", "mid", "bot", "none"],
    descriptions: [
      "Our top lane structure", "Our mid lane structure", "Our bot lane structure",
      "No lane of ours is losing a structure to minions right now",
    ],
    truth: if worst < 0 {
      "none"
    } else {
      lanes[worst]
    },
    why: if worst < 0 {
      "no lane has enemy minion pressure past the threshold with a tower left to lose"
    } else {
      "that structure's health divided by minion damage per tick is \{ticks} ticks, the smallest of the three"
    },
    floor: floor_lane,
  }
}

///|
/// `power` — how does our team compare to theirs right now? Exact arithmetic
/// over levels, items, health and resists, bucketed into the stated rubric.
fn ask_power(g : Game, team : Int) -> Ask {
  let ratio = g.power_ratio(team)
  // The floor counts living bodies, which is the read available at a glance
  // and misses levels and items entirely.
  let bodies = g.living(team).length() *
    100 /
    @cmp.maximum(1, g.living(enemy_of(team)).length())
  {
    key: "power_read",
    class_: "power",
    form: "score",
    tier: "arith",
    instructions: "Taking levels, items, health and resists into account, how does our team's strength compare to theirs right now?",
    options: power_rubric,
    descriptions: [],
    truth: "\{power_level(ratio)}",
    why: "our team power is \{ratio}% of theirs, which is rubric level \{power_level(ratio)}",
    floor: "\{power_level(bodies)}",
  }
}

///|
/// `dive` — can we kill this champion under its own structure without losing
/// anybody? The tower's damage is part of `step`, so this is the rules' answer.
fn ask_dive(g : Game, target_id : Int, team : Int) -> Ask {
  let target = g.champs[target_id]
  let node = target.node
  let clean = g.dive_is_clean(target_id, team, 10)
  // The floor asks whether this tick's burst kills them, which is the question
  // that ignores the tower entirely.
  let mut burst = 0
  for c in g.champs_at(node, team) {
    burst += g.damage_to_champ(c, target)
  }
  let here = g.champs_at(node, team).length()
  let what = match g.structure_at(node) {
    Some(s) => s.kind_name()
    None => "structure"
  }
  {
    key: "dive_\{target.role}_is_clean",
    class_: "dive",
    form: "noul",
    tier: "rules",
    instructions: "\{target.name} (\{target.kind}, hp \{target.hp}/\{target.max_hp}) is standing on its own \{what} at \{node_name(node)}, and \{here} of our champions are on that node. The structure damages anyone of ours standing there every tick, reduced by their armor. Can we kill it without losing a single one of our own?",
    options: [],
    descriptions: [],
    truth: if clean {
      "true"
    } else {
      "false"
    },
    why: "played the dive out under the structure's damage: \{if clean { "the target died and every one of ours lived" } else { "either the target lived or one of ours died" }}",
    floor: if burst >= target.hp + target.shield {
      "true"
    } else {
      "false"
    },
  }
}

///|
/// `dive` — which of our champions on this node can hold the dive longest?
fn ask_diver(g : Game, node : Int, team : Int) -> Ask {
  let names = []
  let descs = []
  for c in g.champs_at(node, team) {
    names.push(c.name)
    descs.push(
      "\{c.kind}, hp \{c.hp}/\{c.max_hp}, armor \{c.armor()} — the structure deals \{TOWER_DAMAGE * 100 / (100 + c.armor())} to it per tick, so it survives \{g.ticks_under_tower(c)} tick(s) there",
    )
  }
  // The floor picks the most health, ignoring armor.
  let mut floor_name = ""
  let mut best_hp = -1
  for c in g.champs_at(node, team) {
    if c.hp > best_hp {
      best_hp = c.hp
      floor_name = c.name
    }
  }
  {
    key: "who_walks_in",
    class_: "dive",
    form: "choice",
    tier: "arith",
    instructions: "Which of our champions on \{node_name(node)} can stand under their structure the longest, and so should be the one to hold the dive?",
    options: names,
    descriptions: descs,
    truth: g.best_diver_names(node, team),
    why: "ticks survivable under the structure = health / (structure damage after armor); this champion has the most",
    floor: floor_name,
  }
}

///|
/// `fog` — which node are the enemies we cannot see standing on? The simulator
/// knows, which is what makes this the one class the 3v3 game could never mark.
fn ask_fog_where(g : Game, team : Int, mem : Memory, note : String) -> Ask {
  let seen = g.vision(team)
  let counts = Array::make(N_NODES, 0)
  let mut best_node = -1
  let mut best_n = 0
  for e in g.champs {
    if e.team != team && e.alive() && !seen[e.node] {
      counts[e.node] += 1
      if counts[e.node] > best_n {
        best_n = counts[e.node]
        best_node = e.node
      }
    }
  }
  let all_nodes = []
  for i in 0..<N_NODES {
    all_nodes.push(node_names[i])
  }
  // The floor answers with the freshest sighting it has: the memory read with
  // no inference on top of it.
  let mut floor_node = node_names[base_of(enemy_of(team))]
  let mut freshest = -1
  for e in g.champs {
    if e.team != team &&
      e.alive() &&
      !seen[e.node] &&
      mem.last_seen_node[e.id] >= 0 &&
      mem.last_seen_tick[e.id] > freshest {
      freshest = mem.last_seen_tick[e.id]
      floor_node = node_names[mem.last_seen_node[e.id]]
    }
  }
  {
    key: "enemy_probably_at",
    class_: "fog",
    form: "choice",
    tier: "rules",
    instructions: "Some of their champions are not in our vision.\{note} Which single node are the enemies we cannot see most likely standing on right now?",
    options: all_nodes,
    descriptions: [],
    truth: if best_node < 0 {
      ""
    } else {
      node_names[best_node]
    },
    why: "the simulator's own state: \{best_n} of the enemies we cannot see are standing on that node",
    floor: floor_node,
  }
}

///|
/// `fog` — how many of them are outside our vision? Counting, not inference.
fn ask_fog_count(g : Game, team : Int) -> Ask {
  let seen = g.vision(team)
  let mut n = 0
  for e in g.champs {
    if e.team != team && e.alive() && !seen[e.node] {
      n += 1
    }
  }
  {
    key: "how_many_are_missing",
    class_: "fog",
    form: "score",
    tier: "arith",
    instructions: "How many of their living champions are outside our vision right now?",
    options: [
      "None of them", "One of them", "Two of them", "Three of them", "Four of them",
      "Five of them",
    ],
    descriptions: [],
    truth: "\{n}",
    why: "counted directly against the vision mask the observation was built from",
    // The floor subtracts what it can see from five, which over-counts once
    // one of them is dead and therefore not hidden at all.
    floor: "\{5 - g.visible_enemies(team).length()}",
  }
}

///|
/// `item` — which item should this champion buy for the fight that is coming?
/// Every item is bought on a copy and the fight played out.
fn ask_item(g : Game, champ_id : Int, node : Int) -> Ask {
  let c = g.champs[champ_id]
  let (inames, idescs) = item_options()
  let asked = "\{c.name} (\{c.kind}, level \{c.level}, hp \{c.hp}/\{c.max_hp}, armor \{c.armor()}, magic resist \{c.mr()}, deals \{if c.dmg_type == DMG_PHYSICAL { "physical" } else { "magic" }})"
  {
    key: "item_for_\{c.role}",
    class_: "item",
    form: "choice",
    tier: "rules",
    instructions: "A 5v5 is about to start on \{node_name(node)} and \{asked} has exactly one item's worth of gold. Which item should it buy? The enemies you can see are in the state; armor only reduces physical damage, magic resist only reduces magic damage, and penetration reduces whichever of those applies to this champion's own damage.",
    options: inames,
    descriptions: idescs,
    truth: g.best_item(champ_id, node, 16),
    why: "bought each item on a copy, then played the fight out; this one left us the most bodies and health",
    floor: g.counter_item(c),
  }
}

///|
/// `macro` — which of these plans leaves us best off? Each is played forward
/// with the enemy on the strong baseline.
fn ask_macro(
  key : String,
  instructions : String,
  options : Array[String],
  descriptions : Array[String],
  scores : Array[Int],
  horizon : Int,
  floor : String,
) -> Ask {
  let parts = []
  for i in 0..<options.length() {
    parts.push("\{options[i]} scored \{scores[i]}")
  }
  {
    key,
    class_: "macro",
    form: "choice",
    tier: "score",
    instructions,
    options,
    descriptions,
    truth: tied_best(options, scores),
    why: "\{horizon} ticks forward with them on the strong baseline: " +
    parts.join(", "),
    floor,
  }
}

///|
/// The `goto` array a macro plan is: our five champions sent to `node`.
fn plan_all(team : Int, node : Int) -> Array[Int] {
  let goto = Array::make(10, -1)
  let base = if team == TEAM_A { 0 } else { 5 }
  for i in 0..<5 {
    goto[base + i] = node
  }
  goto
}

///|
/// What the strong baseline's own plan would call this rally, for the floor.
fn floor_plan_name(
  g : Game,
  team : Int,
  choices : Array[(Int, String)],
  fallback : String,
) -> String {
  let rally = g.team_plan(team).rally
  for c in choices {
    if c.0 == rally {
      return c.1
    }
  }
  fallback
}

// ---------------------------------------------------------------- scenarios

///|
/// A full 5v5 on the Dragon pit: the situation the whole genre is built around.
fn sc_river_fight() -> Scenario {
  let g = stage(comp_by_name("meta"), comp_by_name("glass_ad"), 4, 20)
  g.place_all(RIV_BOT)
  g.neutrals[0].spawn_in = 0
  // A worn team fight rather than a clean one, so the answer is not simply
  // "whoever has more bodies".
  at_hp(g.champs[0], 70) // A_top   tank
  at_hp(g.champs[3], 55) // A_bot   marksman
  at_hp(g.champs[4], 80) // A_support enchanter
  at_hp(g.champs[5], 60) // B_top   marksman
  at_hp(g.champs[6], 45) // B_jungle assassin
  at_hp(g.champs[9], 90)
  let (state, _) = observe(g, TEAM_A)
  {
    name: "river_fight",
    note: "5v5 on the dragon pit, both teams worn",
    state,
    asks: [
      ask_fight(g, RIV_BOT, TEAM_A),
      ask_focus(g, RIV_BOT, TEAM_A, ""),
      ask_power(g, TEAM_A),
      ask_ability(g, RIV_BOT, 0),
      ask_retreat(g, RIV_BOT, TEAM_A),
      // Nobody is pushing a lane, because all ten champions are in the river.
      // "none" is an answer, and a suite where it never comes up would teach a
      // policy that some lane is always falling.
      ask_lane(g, TEAM_A),
    ],
  }
}

///|
/// Four of ours against five of theirs. The fight read should flip.
fn sc_down_a_body() -> Scenario {
  let g = stage(comp_by_name("meta"), comp_by_name("dive"), 4, 26)
  g.place_all(9) // mid_mid, no structure either way
  let jg = g.champs[1]
  jg.hp = 0
  jg.respawn = 6
  jg.node = A_BASE
  at_hp(g.champs[0], 65)
  at_hp(g.champs[3], 70)
  let (state, _) = observe(g, TEAM_A)
  {
    name: "down_a_body",
    note: "4v5 on mid_mid, our jungler dead for 6 ticks",
    state,
    asks: [
      ask_fight(g, 9, TEAM_A),
      ask_retreat(g, 9, TEAM_A),
      ask_power(g, TEAM_A),
      ask_fog_count(g, TEAM_A),
    ],
  }
}

///|
/// The focus trap. The lowest-health enemy is a nearly-full-armor frontliner;
/// the right answer is usually the healthy carry standing behind it, which is
/// exactly the read "hit the lowest health bar" gets wrong.
fn sc_focus_trap() -> Scenario {
  let g = stage(comp_by_name("glass_ap"), comp_by_name("dive"), 5, 32)
  g.place_all(20) // riv_top, no structures
  at_hp(g.champs[5], 35) // B_top tank: hurt, but enormous
  at_hp(g.champs[6], 90)
  at_hp(g.champs[7], 90)
  at_hp(g.champs[8], 95)
  at_hp(g.champs[9], 90)
  let (state, _) = observe(g, TEAM_A)
  {
    name: "focus_trap",
    note: "their hurt tank in front of three healthy carries; our team is mono-magic",
    state,
    asks: [
      ask_focus(
        g,
        20,
        TEAM_A,
        " Our whole team deals magic damage, so their armor is irrelevant and their magic resist is what matters.",
      ),
      ask_fight(g, 20, TEAM_A),
      ask_power(g, TEAM_A),
      // Our mid is a mage with an area ability and four enemies in front of it.
      ask_ability(g, 20, 2),
    ],
  }
}

///|
/// A tower dive with two targets on the same node: one nearly dead and one
/// healthy, so the same question has both answers in one request.
fn sc_tower_dive() -> Scenario {
  let g = stage(comp_by_name("meta"), comp_by_name("glass_ad"), 4, 22)
  let pit = 5 // b1_top: their outer top tower
  park_all(g)
  for id in [0, 1, 2] {
    g.champs[id].node = pit
  }
  g.champs[3].node = 4
  g.champs[4].node = 4
  g.champs[5].node = pit // their top marksman, nearly dead
  g.champs[6].node = pit // their jungle assassin, healthy
  at_hp(g.champs[5], 22)
  at_hp(g.champs[6], 95)
  at_hp(g.champs[2], 60) // our mage is not fresh
  let (state, _) = observe(g, TEAM_A)
  {
    name: "tower_dive",
    note: "three of ours on their outer top tower, one of theirs nearly dead and one healthy",
    state,
    asks: [
      ask_dive(g, 5, TEAM_A),
      ask_dive(g, 6, TEAM_A),
      ask_diver(g, pit, TEAM_A),
      ask_focus(g, pit, TEAM_A, ""),
      ask_fight(g, pit, TEAM_A),
      // Our tank's stun, under their tower, where a removed turn buys the
      // whole dive a tick.
      ask_ability(g, pit, 0),
    ],
  }
}

///|
/// The same dive, alone and without a wave: the tower is the whole opponent.
fn sc_lone_dive() -> Scenario {
  let g = stage(comp_by_name("meta"), comp_by_name("poke"), 3, 18)
  let pit = 15 // b1_bot: their outer bot tower
  park_all(g)
  // Two of ours, so "who walks in" is a real question — and a squishy plus a
  // frontliner, so it is not the same answer as "who has the most health".
  g.champs[3].node = pit // our marksman
  g.champs[0].node = pit // our tank
  at_hp(g.champs[0], 45) // hurt, but still the armored body
  at_hp(g.champs[3], 80)
  g.champs[8].node = pit // their marksman
  g.champs[9].node = pit // their enchanter
  at_hp(g.champs[8], 40)
  at_hp(g.champs[9], 85)
  // Nobody has shoved this lane, so their tower is firing.
  g.push[2] = 0
  let (state, _) = observe(g, TEAM_A)
  {
    name: "lone_dive",
    note: "two of ours on their bot tower with no wave behind them, two of theirs defending",
    state,
    asks: [
      ask_dive(g, 8, TEAM_A),
      ask_diver(g, pit, TEAM_A),
      ask_fight(g, pit, TEAM_A),
      ask_retreat(g, pit, TEAM_A),
      ask_focus(g, pit, TEAM_A, ""),
    ],
  }
}

///|
/// A shop scenario: a fight is about to happen, two of ours have gold, and the
/// enemy's damage has a shape the state shows.
fn sc_shop(
  name : String,
  note : String,
  comp_b : Array[String],
  tanky : Bool,
) -> Scenario {
  let g = stage(comp_by_name("meta"), comp_b, 5, 34)
  let node = 9 // mid_mid
  g.place_all(node)
  // They are a level up on us, so their damage is real and surviving it is
  // worth paying for. With the teams level, the simulator answers "more
  // attack" to almost everything and the shop stops being a decision.
  for c in g.champs {
    if c.team == TEAM_B {
      at_level(c, 6)
    }
  }
  if tanky {
    for c in g.champs {
      if c.team == TEAM_B {
        c.items.push("plate")
        c.items.push("cloak")
        c.refresh_hp()
      }
    }
  }
  for c in g.champs {
    if c.team == TEAM_A {
      c.gold = ITEM_COST + 40
    }
  }
  let (state, _) = observe(g, TEAM_A)
  // One question for the frontliner and one for the carry: the right answer is
  // different for the two roles against the same enemy, which is the part a
  // single rule of thumb gets wrong.
  {
    name,
    note,
    state,
    asks: [
      ask_item(g, champ_named(g, "A_top"), node),
      ask_item(g, champ_named(g, "A_bot"), node),
      ask_power(g, TEAM_A),
    ],
  }
}

///|
/// Three lanes moving at once while a dragon is up: the macro question the
/// minion rules exist to pose.
fn sc_three_lanes() -> Scenario {
  let g = stage(comp_by_name("meta"), comp_by_name("poke"), 4, 30)
  park_all(g)
  for id in [0, 1, 2, 3, 4] {
    g.champs[id].node = RIV_BOT
  }
  g.neutrals[0].spawn_in = 0
  g.champs[5].node = 3 // B_top pressing our outer top tower
  g.champs[6].node = 17 // B_jungle in their own top jungle, out of our vision
  g.champs[7].node = 8 // B_mid pressing our outer mid tower
  g.champs[8].node = RIV_BOT
  g.champs[9].node = RIV_BOT
  // Mid is pushed HARDEST and top is pushed LESS, but top's tower is nearly
  // dead and mid's is healthy — so "which lane are they pushing hardest" and
  // "which lane falls first" have different answers, which is the whole point
  // of asking. With both readings agreeing, the question scores a rule of
  // thumb rather than a judgment.
  g.push[0] = -3
  g.push[1] = -5
  g.push[2] = 4
  for s in g.structures {
    if s.team == TEAM_A && s.lane == "top" && s.tier == 1 {
      s.hp = 20
    }
    if s.team == TEAM_A && s.lane == "mid" && s.tier == 1 {
      s.hp = 120
    }
  }
  let (state, mem) = observe(g, TEAM_A)
  let all_dragon = plan_all(TEAM_A, RIV_BOT)
  let send_one = plan_all(TEAM_A, RIV_BOT)
  send_one[0] = 3 // the top laner goes home to top
  let all_top = plan_all(TEAM_A, 3)
  let options = [
    "all_five_stay_on_dragon", "send_one_to_top", "all_five_go_to_top",
  ]
  let scores = [
    g.simulate_macro(TEAM_A, all_dragon, 8),
    g.simulate_macro(TEAM_A, send_one, 8),
    g.simulate_macro(TEAM_A, all_top, 8),
  ]
  let plan = g.team_plan(TEAM_A)
  {
    name: "three_lanes",
    note: "dragon up, two of our lanes pushed in, our top tower at 20",
    state,
    asks: [
      ask_lane(g, TEAM_A),
      ask_macro(
        "where_should_we_be",
        "The dragon is up and we are all five standing on it. Two of our lanes are being pushed. What should the team do over the next few ticks?",
        options,
        [
          "Keep all five on the dragon and take it, accepting whatever the lanes cost us",
          "Four take the dragon while one walks back to hold the lane that is falling",
          "Abandon the dragon; all five go and clear the lane that is falling",
        ],
        scores,
        8,
        if node_lane[plan.rally] == "river" {
          if plan.hold_lane >= 0 {
            "send_one_to_top"
          } else {
            "all_five_stay_on_dragon"
          }
        } else {
          "all_five_go_to_top"
        },
      ),
      ask_power(g, TEAM_A),
      ask_fog_where(g, TEAM_A, mem, " Two of them are pressing our lanes."),
    ],
  }
}

///|
/// Baron is up and one of their lanes is already open: take the buff, or take
/// the game.
fn sc_baron_or_nexus() -> Scenario {
  let g = stage(comp_by_name("meta"), comp_by_name("bruisers"), 5, 46)
  park_all(g)
  for id in [0, 1, 2, 3, 4] {
    g.champs[id].node = 4 // mid_top, one hop from riv_top and from their lane
  }
  g.neutrals[1].spawn_in = 0 // baron up
  g.neutrals[0].spawn_in = 9
  for s in g.structures {
    if s.team == TEAM_B && s.lane == "top" {
      s.hp = 0
    }
  }
  let (state, mem) = observe(g, TEAM_A)
  let options = ["take_baron", "push_the_nexus", "split_three_and_two"]
  let split = plan_all(TEAM_A, RIV_TOP)
  split[3] = B_BASE
  split[4] = B_BASE
  let scores = [
    g.simulate_macro(TEAM_A, plan_all(TEAM_A, RIV_TOP), 10),
    g.simulate_macro(TEAM_A, plan_all(TEAM_A, B_BASE), 10),
    g.simulate_macro(TEAM_A, split, 10),
  ]
  {
    name: "baron_or_nexus",
    note: "baron up, their top lane open, all five of them home",
    state,
    asks: [
      ask_macro(
        "baron_or_nexus",
        "Baron is up one hop away, and their top lane is already open so their nexus can be attacked. All five of them are home defending. What should our five do?",
        options,
        [
          "All five take Baron first, then siege with the buff", "Ignore Baron; all five go straight at their nexus",
          "Three take Baron while two start on the nexus",
        ],
        scores,
        10,
        floor_plan_name(
          g,
          TEAM_A,
          [(B_BASE, "push_the_nexus"), (RIV_TOP, "take_baron")],
          "split_three_and_two",
        ),
      ),
      ask_lane(g, TEAM_A),
      ask_power(g, TEAM_A),
      ask_fog_where(g, TEAM_A, mem, " They were last seen defending."),
    ],
  }
}

///|
/// A standoff: our ranged five next door to their melee five, on their tower.
fn sc_poke_standoff() -> Scenario {
  let g = stage(comp_by_name("poke"), comp_by_name("bruisers"), 4, 24)
  park_all(g)
  for id in [0, 1, 2, 3, 4] {
    g.champs[id].node = 9 // mid_mid
  }
  for id in [5, 6, 7, 8, 9] {
    g.champs[id].node = 10 // b1_mid, their outer mid tower, adjacent to us
  }
  let (state, _) = observe(g, TEAM_A)
  let poke : Map[Int, Action] = Map([])
  let walk_in : Map[Int, Action] = Map([])
  let back_off : Map[Int, Action] = Map([])
  for c in g.champs_at(9, TEAM_A) {
    walk_in[c.id] = Move(10)
    back_off[c.id] = Move(8)
    let mut set = false
    if c.ranged {
      for e in g.champs_at(10, TEAM_B) {
        if !set {
          poke[c.id] = Poke(e.id)
          set = true
        }
      }
    }
    if !set {
      poke[c.id] = Hold
    }
  }
  let options = [
    "poke_from_here", "walk_onto_their_tower", "step_back_toward_our_tower",
  ]
  let scores = [
    g.simulate_opening(TEAM_A, poke, 8),
    g.simulate_opening(TEAM_A, walk_in, 8),
    g.simulate_opening(TEAM_A, back_off, 8),
  ]
  {
    name: "poke_standoff",
    note: "our ranged five next door to their melee five, on their tower",
    state,
    asks: [
      ask_macro(
        "standoff_opening",
        "All five of us are on mid_mid; all five of them are on their outer mid tower, one node away. Three of ours are ranged and can hit an adjacent node for half damage while taking nothing back. Their team is all melee. What should we do this tick?",
        options,
        [
          "Stay on this node and poke them from range", "Walk onto their tower node and fight them there, under their tower",
          "Step back toward our own tower and make them come to us",
        ],
        scores,
        8,
        "poke_from_here",
      ),
      ask_power(g, TEAM_A),
      ask_lane(g, TEAM_A),
      ask_fog_count(g, TEAM_A),
    ],
  }
}

///|
/// The fog-of-war read, scored. docs/02 asked where the enemies it could not
/// see had gone and had no way to mark the answer; the simulator knows.
fn sc_hidden_enemies() -> Scenario {
  let g = stage(comp_by_name("meta"), comp_by_name("dive"), 4, 28)
  park_all(g)
  for id in [0, 1, 2, 3, 4] {
    g.champs[id].node = 13 // a1_bot, our own outer bot tower
  }
  // Seed the memory while they are still visible in bot lane, then let them
  // rotate away — which is what makes this a memory question.
  for id in [5, 6, 7, 8, 9] {
    g.champs[id].node = 14 // mid_bot, adjacent, so we see them
  }
  let mem = Memory::new()
  mem.observe(g, TEAM_A)
  g.tick += 3
  for id in [5, 6, 7, 8] {
    g.champs[id].node = RIV_TOP
  }
  g.champs[9].node = 15
  g.neutrals[1].spawn_in = 0
  let state = g.observation(TEAM_A, mem)
  {
    name: "hidden_enemies",
    note: "four of them rotated to Baron out of our vision, one left in bot",
    state,
    asks: [
      ask_fog_where(g, TEAM_A, mem, " Baron spawned three ticks ago."),
      ask_fog_count(g, TEAM_A),
      ask_lane(g, TEAM_A),
      ask_power(g, TEAM_A),
    ],
  }
}

///|
/// An early two-on-two in a lane, everything off cooldown. The fights that
/// decide a lane are small, and the 5v5 questions never ask about them.
fn sc_early_skirmish() -> Scenario {
  let g = stage(comp_by_name("meta"), comp_by_name("dive"), 2, 8)
  park_all(g)
  let node = 14 // mid_bot, no structure
  g.champs[3].node = node // our marksman
  g.champs[4].node = node // our enchanter
  g.champs[8].node = node // their marksman
  g.champs[9].node = node // their support
  at_hp(g.champs[3], 75)
  at_hp(g.champs[8], 60)
  g.push[2] = 1
  let (state, _) = observe(g, TEAM_A)
  {
    name: "early_skirmish",
    note: "2v2 in bot lane at level 2, every cooldown up",
    state,
    asks: [
      ask_fight(g, node, TEAM_A),
      ask_focus(g, node, TEAM_A, ""),
      ask_retreat(g, node, TEAM_A),
      // Our enchanter's shield: pre-emptive, so the timing question is real.
      ask_ability(g, node, 4),
      ask_lane(g, TEAM_A),
      ask_power(g, TEAM_A),
    ],
  }
}

///|
/// Late, grouped, and they have the Baron buff. Every stat read has to account
/// for a buff that is not in anybody's items.
fn sc_baron_buffed() -> Scenario {
  let g = stage(comp_by_name("meta"), comp_by_name("poke"), 6, 58)
  g.place_all(RIV_TOP)
  g.baron[TEAM_B] = 8
  g.dragons[TEAM_A] = 2
  for c in g.champs {
    if c.team == TEAM_A {
      c.items.push("blade")
      c.refresh_hp()
    }
  }
  at_hp(g.champs[0], 85)
  at_hp(g.champs[3], 70)
  at_hp(g.champs[7], 80)
  let (state, _) = observe(g, TEAM_A)
  let options = [
    "fight_them_now", "back_off_until_baron_expires", "go_take_the_dragon",
  ]
  let scores = [
    g.simulate_macro(TEAM_A, plan_all(TEAM_A, RIV_TOP), 12),
    g.simulate_macro(TEAM_A, plan_all(TEAM_A, 8), 12),
    g.simulate_macro(TEAM_A, plan_all(TEAM_A, RIV_BOT), 12),
  ]
  {
    name: "baron_buffed",
    note: "5v5 on the baron pit; they have the Baron buff, we have two dragon stacks",
    state,
    asks: [
      ask_power(g, TEAM_A),
      ask_fight(g, RIV_TOP, TEAM_A),
      ask_retreat(g, RIV_TOP, TEAM_A),
      ask_focus(
        g,
        RIV_TOP,
        TEAM_A,
        " Their attack is inflated by the Baron buff for a few more ticks.",
      ),
      ask_ability(g, RIV_TOP, 0),
      // A buff on a timer is a macro question the 3v3 map could not pose: the
      // right answer can be "wait", and only for a stated number of ticks.
      ask_macro(
        "buffed_enemy_opening",
        "Their whole team has the Baron buff for another \{g.baron[TEAM_B]} ticks, which raises their attack and their siege damage. We have two permanent dragon stacks and they have none. What should our five do?",
        options,
        [
          "Fight them on the baron pit right now", "Pull back toward our own mid lane and wait for their buff to run out",
          "Leave them and go take the dragon that is up",
        ],
        scores,
        12,
        floor_plan_name(
          g,
          TEAM_A,
          [(RIV_BOT, "go_take_the_dragon"), (RIV_TOP, "fight_them_now")],
          "back_off_until_baron_expires",
        ),
      ),
    ],
  }
}

///|
/// One of ours deep in a side lane with the wave, their five grouped in the
/// river. The split-push question: is one champion's pressure worth more than
/// its body?
fn sc_split_pressure() -> Scenario {
  let g = stage(comp_by_name("meta"), comp_by_name("meta"), 5, 42)
  park_all(g)
  g.champs[0].node = 16 // our top laner on their INNER bot tower
  for id in [1, 2, 3, 4] {
    g.champs[id].node = 9 // the other four on mid_mid
  }
  g.champs[8].node = 16 // two of theirs rotate onto our split pusher
  g.champs[9].node = 16
  // Their other three were seen in the river a moment ago and have since
  // walked into their own top jungle, where we cannot see them. Seeding the
  // memory first is what makes the fog question a memory question rather than
  // a guess with nothing behind it.
  for id in [5, 6, 7] {
    g.champs[id].node = RIV_BOT
  }
  let seen_first = Memory::new()
  seen_first.observe(g, TEAM_A)
  g.tick += 2
  for id in [5, 6, 7] {
    g.champs[id].node = 19 // b_jg_top, out of our vision
  }
  // We hold the bot wave, so their tower there cannot shoot us.
  g.push[2] = 4
  g.push[0] = -3
  for s in g.structures {
    if s.team == TEAM_B && s.lane == "bot" && s.tier == 1 {
      s.hp = 0
    }
    if s.team == TEAM_A && s.lane == "top" && s.tier == 1 {
      s.hp = 40
    }
  }
  g.neutrals[0].spawn_in = 0
  // The two on our split pusher are visible; the three in their jungle are
  // only a memory, so the observation carries both kinds at once.
  seen_first.observe(g, TEAM_A)
  let mem = seen_first
  let state = g.observation(TEAM_A, mem)
  let options = [
    "keep_splitting", "collapse_on_bot", "all_five_to_the_dragon", "defend_top",
  ]
  let collapse = plan_all(TEAM_A, 16)
  let dragon = plan_all(TEAM_A, RIV_BOT)
  let defend = plan_all(TEAM_A, 3)
  let keep = Array::make(10, -1)
  keep[0] = 16
  for i in [1, 2, 3, 4] {
    keep[i] = 9
  }
  let scores = [
    g.simulate_macro(TEAM_A, keep, 10),
    g.simulate_macro(TEAM_A, collapse, 10),
    g.simulate_macro(TEAM_A, dragon, 10),
    g.simulate_macro(TEAM_A, defend, 10),
  ]
  {
    name: "split_pressure",
    note: "our top laner alone on their inner bot tower with the wave; two of theirs collapsing on it",
    state,
    asks: [
      ask_macro(
        "split_or_group",
        "Our top laner is alone on their inner bot tower and we hold that lane's wave, so the tower cannot shoot it — but two of them have arrived on that node. The other four of us are on mid_mid, the dragon is up, and our own top tower is at 40. What should the team do?",
        options,
        [
          "Leave the split pusher there and keep the other four in the middle", "All five collapse onto the bot tower to save the split and break it",
          "All five go to the dragon and take it while they are busy in bot", "All five go home and defend our top tower",
        ],
        scores,
        10,
        floor_plan_name(
          g,
          TEAM_A,
          [
            (16, "collapse_on_bot"),
            (RIV_BOT, "all_five_to_the_dragon"),
            (3, "defend_top"),
          ],
          "keep_splitting",
        ),
      ),
      ask_lane(g, TEAM_A),
      ask_retreat(g, 16, TEAM_A),
      ask_fight(g, 16, TEAM_A),
      ask_fog_where(g, TEAM_A, mem, " Three of them were last seen grouping."),
      ask_power(g, TEAM_A),
    ],
  }
}

// --------------------------------------------------------------- the suite

///|
/// Every scenario, in report order. Each one is a single request: one state,
/// several questions.
pub fn bench_suite() -> Array[Scenario] {
  [
    sc_river_fight(),
    sc_down_a_body(),
    sc_focus_trap(),
    sc_tower_dive(),
    sc_lone_dive(),
    sc_early_skirmish(),
    sc_shop(
      "shop_vs_physical",
      "their whole team deals physical damage",
      comp_by_name("glass_ad"),
      false,
    ),
    sc_shop(
      "shop_vs_magic",
      "their whole team deals magic damage",
      comp_by_name("glass_ap"),
      false,
    ),
    sc_shop(
      "shop_vs_armored",
      "their team is mixed damage AND has bought resists on every body",
      comp_by_name("meta"),
      true,
    ),
    sc_three_lanes(),
    sc_baron_or_nexus(),
    sc_poke_standoff(),
    sc_hidden_enemies(),
    sc_baron_buffed(),
    sc_split_pressure(),
  ]
}

///|
/// The classes the report groups by, in a fixed order so two runs line up.
pub let bench_classes : Array[String] = [
  "fight", "focus", "item", "dive", "lane", "macro", "retreat", "power", "ability",
  "fog",
]
