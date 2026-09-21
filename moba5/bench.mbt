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
/// | `arith` | Exact arithmetic the rules define (ticks survivable under a tower, team power). Not played out, but not a judgment either. |
/// | `score` | The argmax of `Game::position_score` over a stated horizon, with the enemy playing the strong baseline. A stated objective, not a fact; a reader who weights positions differently should read these rows differently. |
///
/// Every scenario is one request: a single state with several questions about
/// it, which is the fan-out shape docs/02 established and the reason the whole
/// suite costs a handful of round trips.

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

///|
/// Every option that ties for the highest score, joined by "|". This is what a
/// `score`-tier truth is: the argmax of a stated objective, and honestly the
/// whole argmax rather than whichever member of it was listed first.
fn best_of(options : Array[String], scores : Array[Int]) -> String {
  let mut best = -(1 << 30)
  for s in scores {
    if s > best {
      best = s
    }
  }
  let winners = []
  for i in 0..<options.length() {
    if scores[i] == best {
      winners.push(options[i])
    }
  }
  winners.join("|")
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

// ---------------------------------------------------------------- scenario 1

///|
/// A full 5v5 on the Dragon pit: the situation the whole genre is built
/// around. Four questions about one state — whether the fight is ours, who to
/// remove first, how the teams compare, and whether the tank's stun is worth
/// spending on tick one.
fn sc_river_fight() -> Scenario {
  let g = stage(comp_by_name("meta"), comp_by_name("glass_ad"), 4, 20)
  g.place_all(RIV_BOT)
  g.neutrals[0].spawn_in = 0
  // A slightly worn team fight rather than a clean one, so the answer is not
  // simply "whoever has more bodies".
  at_hp(g.champs[0], 70) // A_top   tank
  at_hp(g.champs[3], 55) // A_bot   marksman
  at_hp(g.champs[4], 80) // A_support enchanter
  at_hp(g.champs[5], 60) // B_top   marksman
  at_hp(g.champs[6], 45) // B_jungle assassin
  at_hp(g.champs[9], 90)
  let (state, _) = observe(g, TEAM_A)
  let (names, descs) = enemy_options(g, RIV_BOT, TEAM_A)
  let won = g.fight_is_won(RIV_BOT, TEAM_A, 14)
  let r = g.simulate_fight(RIV_BOT, 14)
  let best = g.best_focus_names(RIV_BOT, TEAM_A, 14)
  let ratio = g.power_ratio(TEAM_A)
  let level = power_level(ratio)
  // Spend the tank's stun on tick one, or hold it?
  let tank = g.champs[0]
  let now = match g.cc_pick(RIV_BOT, TEAM_A) {
    Some(t) =>
      g.simulate_fight_opening(
        RIV_BOT,
        tank.id,
        Some(Cast(tank.ability, t.id)),
        14,
      )
    None => g.simulate_fight_opening(RIV_BOT, tank.id, None, 14)
  }
  let held = g.simulate_fight_opening(RIV_BOT, tank.id, None, 14)
  let stun_now = now.score_for(TEAM_A) > held.score_for(TEAM_A)
  // The floor's fight read: commit on bodies, a frontline and health.
  let floor_commit = g.champs_at(RIV_BOT, TEAM_A).length() >=
    g.champs_at(RIV_BOT, TEAM_B).length()
  let floor_focus = match g.focus_pick(RIV_BOT, TEAM_A) {
    Some(t) => t.name
    None => ""
  }
  let bodies = g.living(TEAM_A).length() *
    100 /
    @cmp.maximum(1, g.living(TEAM_B).length())
  let asks = [
    {
      key: "we_win_this_fight",
      class_: "fight",
      form: "noul",
      tier: "rules",
      instructions: "All five of our champions and all five of theirs are standing on the dragon pit. If we commit to this fight right now and nobody runs, do we win it — them wiped off the node and us still standing?",
      options: [],
      descriptions: [],
      truth: if won {
        "true"
      } else {
        "false"
      },
      why: "played the fight out: after \{r.ticks} ticks A had \{r.a_standing} standing (\{r.a_hp} hp), B had \{r.b_standing} (\{r.b_hp} hp)",
      floor: if floor_commit {
        "true"
      } else {
        "false"
      },
    },
    {
      key: "focus_first",
      class_: "focus",
      form: "choice",
      tier: "rules",
      instructions: "In that fight, which enemy champion should our team focus its attacks on first? Remember that a hit aimed at one of their backline lands on their frontline instead, while their frontline is alive.",
      options: names,
      descriptions: descs,
      truth: best,
      why: "played the fight out once per focus target and kept the order that left us the most bodies and health",
      floor: floor_focus,
    },
    {
      key: "power_read",
      class_: "power",
      form: "score",
      tier: "arith",
      instructions: "Taking levels, items, health and resists into account, how does our team's strength compare to theirs right now?",
      options: power_rubric,
      descriptions: [],
      truth: "\{level}",
      why: "our team power is \{ratio}% of theirs, which is rubric level \{level}",
      floor: "\{power_level(bodies)}",
    },
    {
      key: "stun_on_tick_one",
      class_: "ability",
      form: "noul",
      tier: "rules",
      instructions: "Our frontline champion's stun is off cooldown. A stun deals no damage at all; it removes the target's next turn. Should it be spent on the first tick of this fight, rather than held?",
      options: [],
      descriptions: [],
      truth: if stun_now {
        "true"
      } else {
        "false"
      },
      why: "spending it scored \{now.score_for(TEAM_A)} for us, holding it scored \{held.score_for(TEAM_A)}",
      floor: if g.ability_play(tank) is Some(_) {
        "true"
      } else {
        "false"
      },
    },
  ]
  {
    name: "river_fight",
    note: "5v5 on the dragon pit, both teams worn",
    state,
    asks,
  }
}

// ---------------------------------------------------------------- scenario 2

///|
/// Four of ours against five of theirs. The fight read should flip, and the
/// follow-up question is what to do about it.
fn sc_down_a_body() -> Scenario {
  let g = stage(comp_by_name("meta"), comp_by_name("dive"), 4, 26)
  g.place_all(9) // mid_mid, no tower either way
  // Our jungler is dead, so we are a body down where it matters.
  let jg = g.champs[1]
  jg.hp = 0
  jg.respawn = 6
  jg.node = A_BASE
  at_hp(g.champs[0], 65)
  at_hp(g.champs[3], 70)
  let (state, _) = observe(g, TEAM_A)
  let won = g.fight_is_won(9, TEAM_A, 14)
  let r = g.simulate_fight(9, 14)
  // Fight it, or walk away? Compare the two openings over a short horizon.
  let commit : Map[Int, Action] = g.fight_actions(9)
  let retreat : Map[Int, Action] = Map([])
  for c in g.champs_at(9, TEAM_A) {
    let away = step_toward(c.node, base_of(TEAM_A))
    retreat[c.id] = if away != c.node { Move(away) } else { Hold }
  }
  let s_commit = g.simulate_opening(TEAM_A, commit, 8)
  let s_retreat = g.simulate_opening(TEAM_A, retreat, 8)
  let asks = [
    {
      key: "we_win_this_fight",
      class_: "fight",
      form: "noul",
      tier: "rules",
      instructions: "Our four living champions are on mid_mid with all five of theirs. If we commit and nobody runs, do we win the fight — them wiped off the node and us still standing?",
      options: [],
      descriptions: [],
      truth: if won {
        "true"
      } else {
        "false"
      },
      why: "played it out: A left \{r.a_standing} standing, B left \{r.b_standing}",
      floor: if g.champs_at(9, TEAM_A).length() >=
        g.champs_at(9, TEAM_B).length() {
        "true"
      } else {
        "false"
      },
    },
    {
      key: "commit_or_disengage",
      class_: "retreat",
      form: "choice",
      tier: "score",
      instructions: "Given that, what should the four of us do on this tick: swing at them, or walk back toward our own base and wait for our fifth to respawn?",
      options: ["fight_now", "walk_away"],
      descriptions: [
        "Commit to the fight on this node with the four bodies we have", "Break off toward our base and regroup when the dead champion is back",
      ],
      truth: best_of(["fight_now", "walk_away"], [s_commit, s_retreat]),
      why: "eight ticks forward with both sides on the strong baseline: fighting scored \{s_commit}, walking away scored \{s_retreat}",
      floor: if won {
        "fight_now"
      } else {
        "walk_away"
      },
    },
  ]
  {
    name: "down_a_body",
    note: "4v5 on mid_mid, our jungler dead for 6 ticks",
    state,
    asks,
  }
}

// ---------------------------------------------------------------- scenario 3

///|
/// The focus trap. The lowest-health enemy is a nearly-full-armor frontliner;
/// the right answer is usually the healthy carry standing behind it, which is
/// exactly the read "hit the lowest health bar" gets wrong.
fn sc_focus_trap() -> Scenario {
  let g = stage(comp_by_name("glass_ap"), comp_by_name("dive"), 5, 32)
  g.place_all(20) // riv_top, no structures
  // Their tank is hurt but enormous; their carries are healthy.
  at_hp(g.champs[5], 35) // B_top  tank
  at_hp(g.champs[8], 95) // B_bot  marksman
  at_hp(g.champs[6], 90)
  at_hp(g.champs[7], 90)
  at_hp(g.champs[9], 90)
  // Our team is all magic, so their armor is irrelevant and their magic
  // resist is what matters — another way the obvious read misses.
  let (state, _) = observe(g, TEAM_A)
  let (names, descs) = enemy_options(g, 20, TEAM_A)
  let best = g.best_focus_names(20, TEAM_A, 16)
  let floor_focus = match g.focus_pick(20, TEAM_A) {
    Some(t) => t.name
    None => ""
  }
  let asks = [
    {
      key: "focus_first",
      class_: "focus",
      form: "choice",
      tier: "rules",
      instructions: "A 5v5 has started on riv_top. Which of their champions should we put our damage into first? Our whole team deals magic damage, and a hit aimed at their backline is soaked by their frontline while it lives.",
      options: names,
      descriptions: descs,
      truth: best,
      why: "played the fight out once per focus target; this order left us the most bodies and health",
      floor: floor_focus,
    },
    {
      key: "we_win_this_fight",
      class_: "fight",
      form: "noul",
      tier: "rules",
      instructions: "If we commit to that fight and nobody runs, do we win it outright?",
      options: [],
      descriptions: [],
      truth: if g.fight_is_won(20, TEAM_A, 16) {
        "true"
      } else {
        "false"
      },
      why: "played it out with both sides focusing the body they can reach",
      floor: "true",
    },
  ]
  {
    name: "focus_trap",
    note: "their hurt tank in front of three healthy carries; our team is mono-magic",
    state,
    asks,
  }
}

// ---------------------------------------------------------------- scenario 4

///|
/// A tower dive. The tower's damage is part of the rules, so "is this dive
/// clean" has an exact answer, and so does "who should walk in".
fn sc_tower_dive() -> Scenario {
  let g = stage(comp_by_name("meta"), comp_by_name("glass_ad"), 4, 22)
  let pit = 5 // b1_top: their outer top tower
  // Three of ours arrive; their marksman is low and standing on its tower.
  for id in [0, 1, 2] {
    g.champs[id].node = pit
  }
  g.champs[3].node = 4
  g.champs[4].node = 4
  g.champs[5].node = pit
  at_hp(g.champs[5], 22)
  for id in [6, 7, 8, 9] {
    g.champs[id].node = 1
  }
  at_hp(g.champs[2], 60) // our mage is not fresh
  let (state, _) = observe(g, TEAM_A)
  let clean = g.dive_is_clean(5, TEAM_A, 8)
  let diver = g.best_diver_names(pit, TEAM_A)
  let names = []
  let descs = []
  for c in g.champs_at(pit, TEAM_A) {
    names.push(c.name)
    descs.push(
      "\{c.kind}, hp \{c.hp}/\{c.max_hp}, armor \{c.armor()} — the tower deals \{TOWER_DAMAGE * 100 / (100 + c.armor())} to it per tick, so it survives \{g.ticks_under_tower(c)} tick(s) under the tower",
    )
  }
  let floor_clean = {
    let mut burst = 0
    for c in g.champs_at(pit, TEAM_A) {
      burst += g.damage_to_champ(c, g.champs[5])
    }
    burst >= g.champs[5].hp
  }
  let asks = [
    {
      key: "dive_is_clean",
      class_: "dive",
      form: "noul",
      tier: "rules",
      instructions: "Their marksman is low and standing on its own outer tower in top lane, and three of our champions are on that node. The tower damages anyone of ours standing there, every tick, reduced by their armor. Can we kill it without losing a single one of our own?",
      options: [],
      descriptions: [],
      truth: if clean {
        "true"
      } else {
        "false"
      },
      why: "played the dive out under the tower's damage: \{if clean { "the target died and all three of ours lived" } else { "either the target lived or one of ours died" }}",
      floor: if floor_clean {
        "true"
      } else {
        "false"
      },
    },
    {
      key: "who_walks_in",
      class_: "dive",
      form: "choice",
      tier: "arith",
      instructions: "Which of our three champions on that node can stand under their tower the longest, and so should be the one to hold the dive?",
      options: names,
      descriptions: descs,
      truth: diver,
      why: "ticks survivable under the tower = health / (tower damage after armor); this champion has the most",
      floor: {
        // The floor picks the most health, ignoring armor.
        let mut pick = ""
        let mut best = -1
        for c in g.champs_at(pit, TEAM_A) {
          if c.hp > best {
            best = c.hp
            pick = c.name
          }
        }
        pick
      },
    },
  ]
  {
    name: "tower_dive",
    note: "three of ours on their outer top tower, their marksman low",
    state,
    asks,
  }
}

// ------------------------------------------------------------- scenarios 5-7

///|
/// A shop scenario: a fight is about to happen, two of ours have gold, and the
/// enemy's damage is all of one type. The right buy is the one that wins the
/// fight that is coming, which the simulator can settle by buying each item on
/// a copy and playing it out.
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
  // attack" to almost everything, and the shop stops being a decision.
  for c in g.champs {
    if c.team == TEAM_B {
      at_level(c, 6)
    }
  }
  if tanky {
    // Give their whole team a resist item, so raw attack starts being thrown
    // away and penetration becomes the answer.
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
  let (inames, idescs) = item_options()
  let asks : Array[Ask] = []
  // One question for the frontliner and one for the carry: the right answer is
  // different for the two roles even against the same enemy, which is the part
  // a single rule of thumb gets wrong.
  for who in ["A_top", "A_bot"] {
    let id = champ_named(g, who)
    let c = g.champs[id]
    let truth = g.best_item(id, node, 16)
    let asked = "\{c.name} (\{c.kind}, level \{c.level}, hp \{c.hp}/\{c.max_hp}, armor \{c.armor()}, magic resist \{c.mr()}, deals \{if c.dmg_type == DMG_PHYSICAL { "physical" } else { "magic" }})"
    asks.push({
      key: "item_for_\{c.role}",
      class_: "item",
      form: "choice",
      tier: "rules",
      instructions: "A 5v5 is about to start on mid_mid and \{asked} has exactly one item's worth of gold. Which item should it buy? The enemies you can see are in the state; armor only reduces physical damage, magic resist only reduces magic damage, and penetration reduces whichever of those applies to this champion's own damage.",
      options: inames,
      descriptions: idescs,
      truth,
      why: "bought each item on a copy, then played the fight out; this one left us the most bodies and health",
      floor: g.counter_item(c),
    })
  }
  { name, note, state, asks, }
}

// ---------------------------------------------------------------- scenario 8

///|
/// Three lanes moving at once while a dragon is up. The macro question the
/// minion rules exist to pose: a team standing at the objective is a team not
/// standing in its lanes.
fn sc_three_lanes() -> Scenario {
  let g = stage(comp_by_name("meta"), comp_by_name("poke"), 4, 30)
  // All five of ours are at the dragon pit; theirs are spread.
  for id in [0, 1, 2, 3, 4] {
    g.champs[id].node = RIV_BOT
  }
  g.neutrals[0].spawn_in = 0
  g.champs[5].node = 3 // B_top pressing our outer top tower
  g.champs[6].node = 17
  g.champs[7].node = 8 // B_mid pressing our outer mid tower
  g.champs[8].node = RIV_BOT
  g.champs[9].node = RIV_BOT
  // Their minions are through in top and mid; ours are through in bot.
  g.push[0] = -4
  g.push[1] = -3
  g.push[2] = 4
  // Our top tower is nearly down, our mid tower is healthy: the lane with the
  // most pressure is NOT the lane that falls first.
  for s in g.structures {
    if s.team == TEAM_A && s.lane == "top" && s.tier == 1 {
      s.hp = 20
    }
    if s.team == TEAM_A && s.lane == "mid" && s.tier == 1 {
      s.hp = 120
    }
  }
  let (state, _) = observe(g, TEAM_A)
  let (worst, ticks) = g.lane_under_pressure(TEAM_A)
  // Three candidate shapes for the next few ticks.
  let all_dragon = Array::make(10, -1)
  for id in [0, 1, 2, 3, 4] {
    all_dragon[id] = RIV_BOT
  }
  let send_one = Array::make(10, -1)
  for id in [1, 2, 3, 4] {
    send_one[id] = RIV_BOT
  }
  send_one[0] = 3 // the top laner goes home to top
  let all_top = Array::make(10, -1)
  for id in [0, 1, 2, 3, 4] {
    all_top[id] = 3
  }
  let s_dragon = g.simulate_macro(TEAM_A, all_dragon, 8)
  let s_one = g.simulate_macro(TEAM_A, send_one, 8)
  let s_top = g.simulate_macro(TEAM_A, all_top, 8)
  let macro_options = [
    "all_five_stay_on_dragon", "send_one_to_top", "all_five_go_to_top",
  ]
  let best_plan = best_of(macro_options, [s_dragon, s_one, s_top])
  let asks = [
    {
      key: "lane_in_most_danger",
      class_: "lane",
      form: "choice",
      tier: "arith",
      instructions: "Which of our three lanes is closest to losing a structure to their minions? Their minion pressure and each of our structures' health are both in the state.",
      options: ["top", "mid", "bot", "none"],
      descriptions: [
        "Our top lane structure", "Our mid lane structure", "Our bot lane structure",
        "No lane of ours is under minion pressure",
      ],
      truth: if worst < 0 {
        "none"
      } else {
        lanes[worst]
      },
      why: if worst < 0 {
        "no lane has enemy pressure past the threshold"
      } else {
        "that structure's health divided by minion damage per tick is \{ticks} ticks, the smallest of the three"
      },
      floor: {
        // The floor answers "the lane they are pushing hardest", ignoring how
        // much health the structure actually has left.
        let mut pick = "none"
        let mut worst_push = PUSH_TO_TOWER - 1
        for li in 0..<3 {
          let against = -g.push[li]
          if against > worst_push {
            worst_push = against
            pick = lanes[li]
          }
        }
        pick
      },
    },
    {
      key: "where_should_we_be",
      class_: "macro",
      form: "choice",
      tier: "score",
      instructions: "The dragon is up and we are all five standing on it. Two of our lanes are being pushed. What should the team do over the next few ticks?",
      options: macro_options,
      descriptions: [
        "Keep all five on the dragon and take it, accepting whatever the lanes cost us",
        "Four take the dragon while one walks back to hold the lane that is falling",
        "Abandon the dragon; all five go and clear the lane that is falling",
      ],
      truth: best_plan,
      why: "eight ticks forward with the enemy on the strong baseline: staying scored \{s_dragon}, sending one scored \{s_one}, all five going scored \{s_top}",
      floor: {
        let plan = g.team_plan(TEAM_A)
        if node_lane[plan.rally] == "river" {
          if plan.hold_lane >= 0 {
            "send_one_to_top"
          } else {
            "all_five_stay_on_dragon"
          }
        } else {
          "all_five_go_to_top"
        }
      },
    },
  ]
  {
    name: "three_lanes",
    note: "dragon up, two of our lanes pushed in, our top tower at 20",
    state,
    asks,
  }
}

// ---------------------------------------------------------------- scenario 9

///|
/// Baron is up and one of their lanes is already open. The classic
/// end-of-game fork: take the buff, or take the game.
fn sc_baron_or_nexus() -> Scenario {
  let g = stage(comp_by_name("meta"), comp_by_name("bruisers"), 5, 46)
  for id in [0, 1, 2, 3, 4] {
    g.champs[id].node = 4 // mid_top, one hop from riv_top and from their lane
  }
  for id in [5, 6, 7, 8, 9] {
    g.champs[id].node = 1 // they are home, defending
  }
  g.neutrals[1].spawn_in = 0 // baron up
  g.neutrals[0].spawn_in = 9
  // Their top lane is fully open, so their nexus can be hit.
  for s in g.structures {
    if s.team == TEAM_B && s.lane == "top" {
      s.hp = 0
    }
  }
  let (state, _) = observe(g, TEAM_A)
  let baron_plan = Array::make(10, -1)
  for id in [0, 1, 2, 3, 4] {
    baron_plan[id] = RIV_TOP
  }
  let nexus_plan = Array::make(10, -1)
  for id in [0, 1, 2, 3, 4] {
    nexus_plan[id] = B_BASE
  }
  let split_plan = Array::make(10, -1)
  for id in [0, 1, 2] {
    split_plan[id] = RIV_TOP
  }
  for id in [3, 4] {
    split_plan[id] = B_BASE
  }
  let s_baron = g.simulate_macro(TEAM_A, baron_plan, 10)
  let s_nexus = g.simulate_macro(TEAM_A, nexus_plan, 10)
  let s_split = g.simulate_macro(TEAM_A, split_plan, 10)
  let macro_options = ["take_baron", "push_the_nexus", "split_three_and_two"]
  let best_plan = best_of(macro_options, [s_baron, s_nexus, s_split])
  let asks = [
    {
      key: "baron_or_nexus",
      class_: "macro",
      form: "choice",
      tier: "score",
      instructions: "Baron is up one hop away, and their top lane is already open so their nexus can be attacked. All five of them are home defending. What should our five do?",
      options: macro_options,
      descriptions: [
        "All five take Baron first, then siege with the buff", "Ignore Baron; all five go straight at their nexus",
        "Three take Baron while two start on the nexus",
      ],
      truth: best_plan,
      why: "ten ticks forward with them on the strong baseline: Baron scored \{s_baron}, the nexus scored \{s_nexus}, splitting scored \{s_split}",
      floor: {
        let plan = g.team_plan(TEAM_A)
        if plan.rally == B_BASE {
          "push_the_nexus"
        } else if plan.rally == RIV_TOP {
          "take_baron"
        } else {
          "split_three_and_two"
        }
      },
    },
  ]
  {
    name: "baron_or_nexus",
    note: "baron up, their top lane open, all five of them home",
    state,
    asks,
  }
}

// --------------------------------------------------------------- scenario 10

///|
/// A standoff: our three ranged champions next door to their melee team. Poke
/// is free damage, walking in is not — but standing still forever loses the
/// lanes, so the answer is a position, not a principle.
fn sc_poke_standoff() -> Scenario {
  let g = stage(comp_by_name("poke"), comp_by_name("bruisers"), 4, 24)
  for id in [0, 1, 2, 3, 4] {
    g.champs[id].node = 9 // mid_mid
  }
  for id in [5, 6, 7, 8, 9] {
    g.champs[id].node = 10 // b1_mid, their outer mid tower, adjacent to us
  }
  let (state, _) = observe(g, TEAM_A)
  // Three openings, priced the same way.
  let poke : Map[Int, Action] = Map([])
  for c in g.champs_at(9, TEAM_A) {
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
  let walk_in : Map[Int, Action] = Map([])
  for c in g.champs_at(9, TEAM_A) {
    walk_in[c.id] = Move(10)
  }
  let back_off : Map[Int, Action] = Map([])
  for c in g.champs_at(9, TEAM_A) {
    back_off[c.id] = Move(8)
  }
  let s_poke = g.simulate_opening(TEAM_A, poke, 8)
  let s_walk = g.simulate_opening(TEAM_A, walk_in, 8)
  let s_back = g.simulate_opening(TEAM_A, back_off, 8)
  let macro_options = [
    "poke_from_here", "walk_onto_their_tower", "step_back_toward_our_tower",
  ]
  let best_plan = best_of(macro_options, [s_poke, s_walk, s_back])
  let asks = [
    {
      key: "standoff_opening",
      class_: "macro",
      form: "choice",
      tier: "score",
      instructions: "All five of us are on mid_mid; all five of them are on their outer mid tower, one node away. Three of ours are ranged and can hit an adjacent node for half damage while taking nothing back. Their team is all melee. What should we do this tick?",
      options: macro_options,
      descriptions: [
        "Stay on this node and poke them from range", "Walk onto their tower node and fight them there, under their tower",
        "Step back toward our own tower and make them come to us",
      ],
      truth: best_plan,
      why: "eight ticks forward with them on the strong baseline: poking scored \{s_poke}, walking in scored \{s_walk}, stepping back scored \{s_back}",
      floor: "poke_from_here",
    },
  ]
  {
    name: "poke_standoff",
    note: "our ranged five next door to their melee five, on their tower",
    state,
    asks,
  }
}

// --------------------------------------------------------------- scenario 11

///|
/// The fog-of-war read, scored for the first time. docs/02 asked Jev where the
/// enemies it could not see had gone and had no way to mark the answer; the
/// simulator knows exactly where they are, so now it does.
fn sc_hidden_enemies() -> Scenario {
  let g = stage(comp_by_name("meta"), comp_by_name("dive"), 4, 28)
  for id in [0, 1, 2, 3, 4] {
    g.champs[id].node = 13 // a1_bot, our own outer bot tower
  }
  // Seed the memory while they are still visible in bot lane, then let them
  // rotate away — which is what makes the question a memory question.
  for id in [5, 6, 7, 8, 9] {
    g.champs[id].node = 14 // mid_bot, adjacent, so we see them
  }
  let mem = Memory::new()
  mem.observe(g, TEAM_A)
  g.tick += 3
  // Four of them group on Baron; one stays to hold bot.
  for id in [5, 6, 7, 8] {
    g.champs[id].node = RIV_TOP
  }
  g.champs[9].node = 15
  g.neutrals[1].spawn_in = 0
  let state = g.observation(TEAM_A, mem)
  // Truth: the node holding the most enemies we cannot currently see.
  let seen = g.vision(TEAM_A)
  let counts = Array::make(N_NODES, 0)
  let mut best_node = -1
  let mut best_n = 0
  for e in g.champs {
    if e.team == TEAM_B && e.alive() && !seen[e.node] {
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
  // The floor answers with the staleest sighting it has — the memory read with
  // no inference on top of it.
  let mut floor_node = "b_base"
  let mut freshest = -1
  for e in g.champs {
    if e.team == TEAM_B && e.alive() && !seen[e.node] {
      if mem.last_seen_tick[e.id] > freshest && mem.last_seen_node[e.id] >= 0 {
        freshest = mem.last_seen_tick[e.id]
        floor_node = node_names[mem.last_seen_node[e.id]]
      }
    }
  }
  let asks = [
    {
      key: "enemy_probably_at",
      class_: "fog",
      form: "choice",
      tier: "rules",
      instructions: "Some of their champions are not in our vision. Baron spawned three ticks ago. Which single node are the enemies we cannot see most likely standing on right now?",
      options: all_nodes,
      descriptions: [],
      truth: if best_node < 0 {
        ""
      } else {
        node_names[best_node]
      },
      why: "the simulator's own state: \{best_n} of the enemies we cannot see are standing on that node",
      floor: floor_node,
    },
    {
      key: "how_many_are_missing",
      class_: "fog",
      form: "score",
      tier: "arith",
      instructions: "How many of their five champions are outside our vision right now?",
      options: [
        "None of them", "One of them", "Two of them", "Three of them", "Four of them",
        "All five of them",
      ],
      descriptions: [],
      truth: {
        let mut n = 0
        for e in g.champs {
          if e.team == TEAM_B && e.alive() && !seen[e.node] {
            n += 1
          }
        }
        "\{n}"
      },
      why: "counted directly against the vision mask the observation was built from",
      floor: "\{5 - g.visible_enemies(TEAM_A).length()}",
    },
  ]
  {
    name: "hidden_enemies",
    note: "four of them rotated to Baron out of our vision, one left in bot",
    state,
    asks,
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
  ]
}

///|
/// The classes the report groups by, in a fixed order so two runs line up.
pub let bench_classes : Array[String] = [
  "fight", "focus", "item", "dive", "lane", "macro", "retreat", "power", "ability",
  "fog",
]
