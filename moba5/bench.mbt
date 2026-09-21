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

///|
/// Whether this ask can be got wrong.
///
/// A choice question whose truth accepts every option is not a question: every
/// policy scores 1.00 on it and the class row moves for a reason that has
/// nothing to do with reading the state. `bench_wbtest`'s "a tie must not
/// swallow the whole option list" refuses to ship one, and this is the shipping
/// side of that test — the rules decide the truths, so a rules change can turn
/// a discriminating question into a degenerate one, and did: giving archetypes
/// their own growth rates made one derived fight so lopsided that all five
/// focus orders ended identically.
pub fn Ask::discriminates(self : Ask) -> Bool {
  if self.form != "choice" {
    return true
  }
  let mut accepted = 0
  for o in self.options {
    if truth_accepts(self.truth, o) {
      accepted += 1
    }
  }
  accepted < self.options.length()
}

///|
/// Drop the asks that cannot be got wrong, scenario by scenario. A scenario
/// left with no asks at all is dropped too.
fn prune(scenarios : Array[Scenario]) -> Array[Scenario] {
  let out : Array[Scenario] = []
  for sc in scenarios {
    let asks : Array[Ask] = []
    for ask in sc.asks {
      if ask.discriminates() {
        asks.push(ask)
      }
    }
    if asks.length() > 0 {
      out.push({ name: sc.name, note: sc.note, state: sc.state, asks, })
    }
  }
  out
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
fn item_options(c : Champ) -> (Array[String], Array[String]) {
  let names = []
  let descs = []
  for it in items {
    // Only what this champion could actually buy. Offering `edge` to a
    // champion with 390 gold would break the rule the whole action space is
    // built on — the choices offered ARE the legal moves — and would also make
    // the question unanswerable in the one way that does not show up in a
    // score, since the oracle skips a purchase the tick would refuse.
    if !c.can_buy(it.key) {
      continue
    }
    let price = c.price_of(it.key)
    let full = item_total_cost(it.key)
    let paid = if price < full {
      "\{price} gold (\{full} from nothing; you are holding a component)"
    } else {
      "\{price} gold"
    }
    names.push(it.key)
    descs.push("\{paid} — \{it.note}")
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
/// How long a fight is played out for before its result is read. Long enough
/// that a 5v5 resolves, short enough that it is still one fight.
pub const FIGHT_TICKS = 16

///|
/// How far forward the `retreat` truth prices the two options. Named because
/// the answer is a property of this number as much as of the position, and
/// because the coherence analysis has to price them the same way.
pub const RETREAT_HORIZON = 8

///|
/// `fight` — does committing on this node win the fight outright? Played out.
fn ask_fight(g : Game, node : Int, team : Int) -> Ask {
  let r = g.simulate_fight(node, FIGHT_TICKS)
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
    truth: g.best_focus_names(node, team, FIGHT_TICKS),
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
  let (s_commit, s_back) = g.retreat_scores(node, team, RETREAT_HORIZON)
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
    truth: retreat_pick(s_commit, s_back),
    why: "\{RETREAT_HORIZON} ticks forward with both sides on the strong baseline: fighting scored \{s_commit}, walking away scored \{s_back}",
    // The floor commits exactly when it would win the fight outright, which
    // ignores everything the position is worth afterwards.
    floor: if g.fight_is_won(node, team, FIGHT_TICKS) {
      "fight_now"
    } else {
      "walk_away"
    },
  }
}

///|
/// Which wording of the retreat question a derived fight scenario carries.
///
/// Every variant below asks the same decision and is scored against the same
/// truth; they differ only in the prose the options are offered with, and in
/// one case only in the order they are listed. That is the point: a share of
/// answers that moves between them was a property of my sentences, and a
/// share that does not was a property of the position.
pub(all) enum RetreatWording {
  /// `fight_now` / `walk_away`. What `bench_suite` ships.
  TwoWay
  /// Three options, described as the first three-way measurement described
  /// them. Two asymmetries sit in that prose: **the middle option is the only
  /// one whose description argues for it** ("the trade is still worth more to
  /// us than backing off"), and **walking away is described in half the words
  /// the two swings get**.
  ThreePlain
  /// Three options in the same shape and roughly the same length, each stating
  /// only its condition. The two swings are described in the words
  /// `noul_criteria` already uses for the `fight` question's two sides, so the
  /// two questions in the request describe the same outcomes identically —
  /// and no option argues for itself.
  ThreeFlat
  /// Three options with the argument moved OFF the middle one and onto walking
  /// away. If the middle option's share is a property of its sentence, this is
  /// where it drops.
  ThreeTilted
  /// `ThreePlain`'s sentences, listed walk-away first and the middle meaning
  /// last. "The middle option" is both the elaborated one and the second one;
  /// this separates those, so a share that survives the prose variants but
  /// moves here was position and not prose.
  ThreeReordered
} derive(Eq)

///|
/// The arm name this wording is recorded under. `ThreePlain` keeps the name
/// the first measurement's log used, because it is the same question — one
/// label per wording across every recorded run.
pub fn RetreatWording::arm_name(self : RetreatWording) -> String {
  match self {
    TwoWay => "two_way"
    ThreePlain => "three_way"
    ThreeFlat => "three_flat"
    ThreeTilted => "three_tilted"
    ThreeReordered => "three_reordered"
  }
}

///|
/// Whether this wording splits the commit side in two.
pub fn RetreatWording::is_three_way(self : RetreatWording) -> Bool {
  self != TwoWay
}

///|
/// The four three-option wordings, in report order, baseline first.
pub let retreat3_wordings : Array[RetreatWording] = [
  ThreePlain,
  ThreeFlat,
  ThreeTilted,
  ThreeReordered,
]

///|
/// The options and their descriptions, per wording.
fn retreat3_options(wording : RetreatWording) -> (Array[String], Array[String]) {
  let win = "win_and_fight"
  let lose = "lose_but_fight"
  let away = "walk_away"
  match wording {
    ThreeFlat =>
      (
        [win, lose, away],
        [
          "Swing. When the fight ends, at least one of ours is standing on the node and none of theirs is",
          "Swing. When the fight ends, at least one of theirs is standing on the node",
          "Do not swing. Our champions on this node step back toward our own base this tick",
        ],
      )
    ThreeTilted =>
      (
        [win, lose, away],
        [
          "Swing, and we win this fight outright: every one of them off the node with at least one of ours standing",
          "Swing even though we do not win it outright: some of them are still standing when it ends",
          "Break off toward our base — the position that buys us is worth more to us than this fight is now",
        ],
      )
    ThreeReordered =>
      (
        [away, win, lose],
        [
          "Break off toward our base and come back on better terms", "Swing, and we win this fight outright: every one of them off the node with at least one of ours standing",
          "Swing even though we do not win it outright — the trade is still worth more to us than backing off",
        ],
      )
    // `ThreePlain`, and `TwoWay` never reaches here.
    _ =>
      (
        [win, lose, away],
        [
          "Swing, and we win this fight outright: every one of them off the node with at least one of ours standing",
          "Swing even though we do not win it outright — the trade is still worth more to us than backing off",
          "Break off toward our base and come back on better terms",
        ],
      )
  }
}

///|
/// `retreat3` — the same decision with the same oracle, split three ways.
///
/// `ask_retreat` offers `fight_now` against `walk_away`, and a model that says
/// "we do not win this fight" and then `fight_now` about the same node looks
/// like it is contradicting itself. But it need not be: **"we lose the fight
/// and swinging is still the better move" is a real position** (a trade that
/// stops their siege, say), and the two-option question has nowhere to put it.
/// Splitting the commit side in two gives that answer a name, so the model can
/// state it instead of having it inferred:
///
/// - picking the MIDDLE option means the two-option question was too coarse;
/// - picking `win_and_fight` right after answering `fight` with `false`
///   disagrees with the same request's own answer about the same fight.
///
/// The second reading was written here as "a contradiction with no wording left
/// to blame", and **measuring the wordings took that away**: the share splits
/// 56% / 59% / 74% / 100% across the four variants below, and one of them
/// produces no such disagreement at all. There was wording left to blame. What
/// survived every variant is the pair of near-constant margins, not the split.
///
/// The oracle is `ask_retreat`'s, unchanged — the same two scores over the same
/// horizon — with the commit side labelled by whether the fight is won
/// outright, which is `ask_fight`'s truth. So the two questions cannot disagree
/// by construction, and whatever the model does with them is the measurement.
/// docs/56 §4 and TODO §1.12 item 2 report what it did.
///
/// `wording` picks which of the described variants is asked. The first
/// measurement found the middle option chosen in 73% of the states where the
/// model said it loses the fight and swung anyway — and **that share could be
/// a property of the one sentence describing it**, which is the failure the
/// `fight` question already demonstrated once (rewriting its two sides as
/// mirror images moved the class score 0.50 → 0.63). So the variants exist to
/// price the sentence.
fn ask_retreat3(
  g : Game,
  node : Int,
  team : Int,
  wording : RetreatWording,
) -> Ask {
  let (s_commit, s_back) = g.retreat_scores(node, team, RETREAT_HORIZON)
  let won = g.fight_is_won(node, team, FIGHT_TICKS)
  let commit_name = if won { "win_and_fight" } else { "lose_but_fight" }
  let (options, descriptions) = retreat3_options(wording)
  {
    key: "commit_or_disengage_3",
    class_: "retreat3",
    form: "choice",
    tier: "score",
    instructions: "What should the champions we have on \{node_name(node)} do this tick? Swinging can be right whether or not the fight itself is winnable, so say which it is.",
    options,
    descriptions,
    // Exactly `ask_retreat`'s truth with its commit side named: the same two
    // scores decide whether to swing, and `ask_fight`'s truth decides which
    // swing it is. Independent of how the options are worded or ordered,
    // which is what makes the variants comparable.
    truth: tied_best([commit_name, "walk_away"], [s_commit, s_back]),
    why: "\{RETREAT_HORIZON} ticks forward with both sides on the strong baseline: fighting scored \{s_commit}, walking away scored \{s_back}; the fight itself is \{if won { "won" } else { "not won" }} outright",
    // The floor has no concept of "worth it anyway": it commits exactly when
    // it wins, so it can never name the middle option. That is the point of
    // having the option.
    floor: if won {
      "win_and_fight"
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
  let now = g.simulate_fight_opening(node, champ_id, now_action, FIGHT_TICKS)
  let held = g.simulate_fight_opening(node, champ_id, None, FIGHT_TICKS)
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
      "\{c.kind}, hp \{c.hp}/\{c.max_hp}, armor \{c.armor()} — the structure deals \{g.tower_damage_to(c)} to it per tick, so it survives \{g.ticks_under_tower(c)} tick(s) there",
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
  let (inames, idescs) = item_options(c)
  let asked = "\{c.name} (\{c.kind}, level \{c.level}, hp \{c.hp}/\{c.max_hp}, armor \{c.armor()}, magic resist \{c.mr()}, deals \{if c.dmg_type == DMG_PHYSICAL { "physical" } else { "magic" }})"
  {
    key: "item_for_\{c.role}",
    class_: "item",
    form: "choice",
    tier: "rules",
    instructions: "A 5v5 is about to start on \{node_name(node)} and \{asked} has \{c.gold} gold. Which item should it buy? Every option below is priced at what this champion would actually pay, and only the ones it can afford are listed. Components are cheap and build into completed items, which are worth more per gold; the fight is starting now, so stats that arrive later are worth nothing. The enemies you can see are in the state; armor only reduces physical damage, magic resist only reduces magic damage, and penetration reduces whichever of those applies to this champion's own damage.",
    options: inames,
    descriptions: idescs,
    truth: g.best_item(champ_id, node, 16),
    why: "bought each item on a copy, then played the fight out; this one left us the most bodies and health",
    // What the strong baseline would actually put on the counter, which since
    // the shop grew tiers is not the same as the item it wants: `counter_item`
    // names the want and `shop_pick` names the purchase.
    floor: match g.shop_pick(c) {
      Some(k) => k
      None => g.counter_item(c)
    },
  }
}

///|
/// `cs` — what is the wave in front of this champion worth right now?
///
/// The arithmetic the last-hit rule defines, offered as the amounts it can
/// come to. A policy that reads `minions_ripe_here` gets this for free, which
/// is the point: the question is whether it reads the state at all before
/// deciding that poking is better.
fn ask_cs_pay(g : Game, champ_id : Int) -> Ask {
  let c = g.champs[champ_id]
  let ripe = g.ripe_here(c.node, c.team)
  let options = []
  let descs = []
  for n in 0..<=CS_RIPE_CAP {
    options.push("\{n * CS_GOLD}")
    descs.push(
      if n == 0 {
        "nothing is low enough to last-hit"
      } else {
        "\{n} minion(s) at \{CS_GOLD} gold each"
      },
    )
  }
  {
    key: "cs_pay_\{c.role}",
    class_: "cs",
    form: "choice",
    tier: "arith",
    instructions: "How much gold would \{c.name} take if it spent this tick on `farm` in \{node_lane[c.node]}? Each lane brings one more minion low per tick for each side, up to \{CS_RIPE_CAP}, and `farm` takes every minion that is low right now for \{CS_GOLD} gold each.",
    options,
    descriptions: descs,
    truth: "\{ripe * CS_GOLD}",
    why: "\{ripe} minion(s) are low in that lane for that team, at \{CS_GOLD} gold each",
    // The floor reads the same number off the state, so this row says whether
    // a model does — it is the one class where the heuristic should be perfect
    // and any gap is a failure to look.
    floor: "\{ripe * CS_GOLD}",
  }
}

///|
/// `cs` — what does standing in a lane and not farming it cost over a few
/// ticks?
///
/// The number nobody computes by accident. A wave refills at one minion a
/// tick, so three ticks of not farming a two-minion wave is four minions and
/// not six, and the naive answer is the one a policy reaches for. The truth
/// is played out rather than derived, so it cannot be wrong in the same way
/// the arithmetic in this comment could be.
fn ask_cs_forfeit(g : Game, champ_id : Int, ticks : Int) -> Ask {
  let c = g.champs[champ_id]
  let lost = {
    let h = g.copy()
    let me = h.champs[champ_id]
    // Everybody else out of the lane, so the only thing moving the counter is
    // this champion standing there not farming.
    for other in h.champs {
      if other.id != champ_id {
        other.node = base_of(other.team)
      }
    }
    let before = me.cs_lost
    for _t in 0..<ticks {
      h.step(Map([(champ_id, Hold)]))
    }
    me.cs_lost - before
  }
  let options = []
  let descs = []
  let ripe = g.ripe_here(c.node, c.team)
  for n in 0..<=(CS_RIPE_CAP * ticks) {
    options.push("\{n * CS_GOLD}")
    descs.push("\{n} minion(s) finished by our own wave")
  }
  {
    key: "cs_forfeit_\{c.role}",
    class_: "cs",
    form: "choice",
    tier: "rules",
    instructions: "\{c.name} is going to spend the next \{ticks} tick(s) standing in \{node_lane[c.node]} doing something other than `farm` — trading, poking, holding, it does not matter which. How much gold will its own wave finish without it? Whatever is low at the end of a tick is finished by our minions and paid to nobody, and the lane brings one more low per tick up to \{CS_RIPE_CAP}.",
    options,
    descriptions: descs,
    truth: "\{lost * CS_GOLD}",
    why: "the champion held for \{ticks} tick(s) on a copy and its `minions_let_die` counter moved by \{lost}",
    // The answer a reader reaches for: what is low now, every tick. It is
    // wrong because the wave refills at one a tick rather than staying as big
    // as it is, and it is wrong in the direction that matters — it overstates
    // the cost of leaving the wave alone.
    floor: "\{ripe * ticks * CS_GOLD}",
  }
}

///|
/// `cs` — farm, poke or hold? Each is taken on a copy and the champion's own
/// gold and experience compared a tick later.
///
/// A one-tick horizon on purpose. Over ten ticks the answer would be about
/// the fight that follows; over one it is exactly the trade the last-hit rule
/// creates, which is the thing worth measuring separately from the fight.
fn ask_cs_choice(g : Game, champ_id : Int) -> Ask {
  let c = g.champs[champ_id]
  let legal = g.legal_actions(c)
  let names = []
  let descs = []
  let scores = []
  for a in legal {
    let keep = match a {
      Farm | Hold => true
      Poke(_) => true
      _ => false
    }
    if !keep {
      continue
    }
    let h = g.copy()
    h.step(Map([(c.id, a)]))
    let after = h.champs[c.id]
    names.push(a.to_string())
    descs.push(g.describe_action(c, a))
    // Gold and experience, plus what the enemy lost: poking is worth the
    // damage it does, and the last-hit rule is what makes that a trade rather
    // than a free hit.
    let mut theirs = 0
    for e in h.champs {
      if e.team != c.team {
        theirs += g.champs[e.id].hp - e.hp
      }
    }
    scores.push((after.gold - c.gold) * 3 + (after.xp - c.xp) * 2 + theirs)
  }
  {
    key: "cs_trade_\{c.role}",
    class_: "cs",
    form: "choice",
    tier: "rules",
    instructions: "\{c.name} is standing in \{node_lane[c.node]}. Taking the wave pays gold and experience; poking an enemy costs the wave and pays damage instead. Which is worth more to us this tick?",
    options: names,
    descriptions: descs,
    truth: tied_best(names, scores),
    why: "each action taken on a copy for one tick, scored on the gold and experience gained plus the health taken off them",
    // The baseline's lane-economy branch, rather than `smart_action` whole.
    // Asked for a whole turn it may answer with a move or a recall, which is
    // an answer to a different question; what this asks about is the part of
    // it that chooses between the wave and the trade, so that is the part
    // quoted here.
    floor: cs_floor(g, c, names),
  }
}

///|
/// What the strong baseline does about the wave-or-trade decision: take the
/// gold when there is gold on the floor, poke when there is not. The same
/// order `smart_action` uses, restricted to the options this question offers.
fn cs_floor(g : Game, c : Champ, names : Array[String]) -> String {
  if g.ripe_here(c.node, c.team) > 0 && names.contains(Farm.to_string()) {
    return Farm.to_string()
  }
  for n in names {
    if n.has_prefix("poke_") {
      return n
    }
  }
  if names.contains(Farm.to_string()) {
    return Farm.to_string()
  }
  names[0]
}

///|
/// `drake` — which element helps this team most in the fight on this pit?
fn ask_drake_element(g : Game, team : Int, node : Int) -> Ask {
  let descs = []
  for element in drake_kinds {
    descs.push(drake_reward(element))
  }
  {
    key: "drake_element",
    class_: "drake",
    form: "choice",
    tier: "rules",
    instructions: "A drake is about to die on \{node_name(node)} and the rift could have made it any of the four elements. Which element's stack would help OUR five most in the fight that is happening on that pit right now? The teams are in the state; each element is permanent and team-wide.",
    options: drake_kinds,
    descriptions: descs,
    truth: g.best_drake_element(team, node, FIGHT_TICKS),
    why: "each element granted on a copy and the fight on that node played out; this one left us the most bodies and health",
    // The heuristic has no opinion about elements, so it names the one that is
    // worth the most in the abstract. Being wrong here is what the class is
    // for: which stack pays depends on the two teams, not on the stack.
    floor: "infernal",
  }
}

///|
/// `drake` — how many more drakes does this team need for the soul?
fn ask_drake_soul(g : Game, team : Int) -> Ask {
  let need = g.drakes_to_soul(team)
  let options = []
  for n in 0..<=SOUL_STACKS {
    options.push("\{n}")
  }
  {
    key: "drake_to_soul",
    class_: "drake",
    form: "choice",
    tier: "arith",
    instructions: "Counting the drake that is about to fall to us, how many more drakes does OUR team need before it has the \{g.rift_element()} soul? The first team to \{SOUL_STACKS} of any elements takes it, and only the first.",
    options,
    descriptions: [],
    truth: "\{if need <= 1 { 0 } else { need - 1 }}",
    why: "we hold \{g.drake_total(team)} of the \{SOUL_STACKS} the soul needs, and this one makes \{g.drake_total(team) + 1}",
    floor: "\{g.drakes_to_soul(team)}",
  }
}

///|
/// `brush` — which node could be hiding the enemies we cannot account for?
fn ask_brush_hidden(g : Game, team : Int) -> Ask {
  let blind = g.blind_brush(team)
  let seen = g.vision(team)
  let options = []
  let descs = []
  // The river is in the list on purpose. It is the node a reader would expect
  // to be cover — it is off-lane, it is where the monsters are — and it is
  // not, so an option list of nothing but brush would let a policy score by
  // naming any unlit node rather than by knowing which nodes hide anybody.
  let candidates = []
  for n in brush_nodes {
    candidates.push(n)
  }
  candidates.push(RIV_TOP)
  candidates.push(RIV_BOT)
  for n in candidates {
    options.push(node_name(n))
    descs.push(
      if !is_brush(n) {
        "\{node_lane[n]}, not brush\{if seen[n] { ", and we can see it" } else { ", and we have no vision of it" }}"
      } else if seen[n] {
        "brush, and we have vision of it right now"
      } else {
        "brush, and we have no vision of it"
      },
    )
  }
  // Any blind brush is an acceptable answer: the question is whether a policy
  // knows which nodes the rule hides, not which of several equally unlit
  // ones it picks.
  let names = []
  for n in blind {
    names.push(node_name(n))
  }
  {
    key: "brush_hidden",
    class_: "brush",
    form: "choice",
    tier: "arith",
    instructions: "Standing next to a brush shows you nothing inside it. Which of these could be holding enemies we cannot see right now?",
    options,
    descriptions: descs,
    truth: names.join("|"),
    why: "the brush nodes outside our vision mask, which is the same mask the observation was built from",
    // The floor names the brush nearest our own base, which is the wrong
    // instinct: the one that matters is the one next to the lane we are in.
    floor: node_name(brush_nodes[0]),
  }
}

///|
/// `brush` — where should this champion put its ward?
fn ask_brush_ward(g : Game, team : Int, champ_id : Int) -> Ask {
  let c = g.champs[champ_id]
  let options = []
  let descs = []
  for n in ward_spots(c.node) {
    options.push(node_name(n))
    descs.push(
      "\{node_lane[n]}\{if is_brush(n) { ", BRUSH — a ward is the only way to watch one from outside" } else { "" }}\{if g.has_ward(team, n) { "; already warded" } else { "" }}",
    )
  }
  {
    key: "brush_ward",
    class_: "brush",
    form: "choice",
    tier: "rules",
    instructions: "\{c.name} has a ward to place from \{node_name(c.node)}. Which node reveals the most of their five? A ward sees the node it sits in and its neighbours, and a ward in a brush is the only way to see inside one from outside.",
    options,
    descriptions: descs,
    truth: g.best_ward(team, c.node),
    why: "each spot warded on a copy and the enemies then visible counted",
    floor: node_name(ward_spots(c.node)[0]),
  }
}

///|
/// `brush` — does walking into that brush get this champion killed?
fn ask_brush_step(g : Game, champ_id : Int, node : Int) -> Ask {
  let c = g.champs[champ_id]
  {
    key: "brush_step_\{c.role}",
    class_: "brush",
    form: "noul",
    tier: "rules",
    instructions: "\{c.name} is about to step into \{node_name(node)}, which is brush we have no vision of. Would it still be alive \{RETREAT_HORIZON} ticks later? Answer true if it survives.",
    options: [],
    descriptions: [],
    truth: "\{g.step_in_survives(champ_id, node, RETREAT_HORIZON)}",
    why: "the champion moved into that node on a copy and both teams played the strong baseline for \{RETREAT_HORIZON} ticks",
    // The heuristic walks in whenever it is not already hurt, which is the
    // mistake the brush exists to punish.
    floor: "\{c.hp * 100 >= c.max_hp * 50}",
  }
}

///|
/// `siege` — what is the plating on this tower worth to the team?
fn ask_siege_plates(g : Game, node : Int) -> Ask {
  let plates = match g.structure_at(node) {
    Some(s) => s.plates
    None => 0
  }
  let options = []
  let descs = []
  for n in 0..<=PLATES {
    options.push("\{n * PLATE_GOLD}")
    descs.push(
      if n == 0 {
        "no plating left on it"
      } else {
        "\{n} plate(s) at \{PLATE_GOLD} gold each, to every champion on the team"
      },
    )
  }
  {
    key: "siege_plates",
    class_: "siege",
    form: "choice",
    tier: "arith",
    instructions: "How much gold would each of our champions earn if we took ALL the plating still on the tower at \{node_name(node)}? Champion damage takes plates off one at a time and pays \{PLATE_GOLD} gold per plate to every champion on the team; minion damage takes none, and the plating falls off by itself at tick \{PLATE_TICKS}.",
    options,
    descriptions: descs,
    truth: "\{plates * PLATE_GOLD}",
    why: "\{plates} plate(s) left at \{PLATE_GOLD} gold each",
    floor: "\{PLATES * PLATE_GOLD}",
  }
}

///|
/// `siege` — their gate is down; can we reach the nexus before it closes?
fn ask_siege_window(g : Game, team : Int, champ_id : Int) -> Ask {
  let c = g.champs[champ_id]
  let foe = enemy_of(team)
  let mut left = 0
  for s in g.structures {
    if s.team == foe && s.tier == 2 && s.respawn_in > left {
      left = s.respawn_in
    }
  }
  let trip = hops(c.node, base_of(foe))
  {
    key: "siege_window",
    class_: "siege",
    form: "noul",
    tier: "arith",
    instructions: "One of their inner towers is down, so their nexus can be attacked — but it comes back up in \{left} tick(s) and closes the lane again. \{c.name} is \{trip} hop(s) from their base and moving is one node a tick. Would it arrive with at least one tick left to swing? Answer true if it would.",
    options: [],
    descriptions: [],
    truth: "\{trip < left}",
    why: "\{trip} hop(s) against \{left} tick(s) on the gate's timer",
    // The heuristic goes whenever the nexus reads as attackable, which is what
    // the timer is there to make wrong.
    floor: "true",
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
  g.drakes[drake_index(TEAM_A, "infernal")] = 2
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
    note: "5v5 on the baron pit; they have the Baron buff, we have two infernal drakes",
    state,
    asks: [
      ask_power(g, TEAM_A),
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
        "Their whole team has the Baron buff for another \{g.baron[TEAM_B]} ticks, which raises their attack and their siege damage. We have two infernal drakes — a permanent +\{2 * DRAKE_INFERNAL_PCT}% damage — and they have none. What should our five do?",
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
      ask_fog_where(g, TEAM_A, mem, " Three of them were last seen grouping."),
      ask_power(g, TEAM_A),
    ],
  }
}

///|
/// One derived fight: a case from the balanced sweep in `fightset.mbt`, with
/// the questions its state can answer.
///
/// The bucket is in the scenario's name so the report shows the balance, and
/// it never reaches the model — a request carries only the state and the
/// question text.
/// `wording` swaps the two-option `retreat` question for one of the
/// three-option `retreat3` wordings and changes nothing else, which is what
/// makes any two of these suites a paired A/B on the wording rather than two
/// different measurements.
fn sc_fight_case(
  case_ : FightCase,
  index : Int,
  wording : RetreatWording,
) -> Scenario {
  let g = case_.build()
  let (state, _) = observe(g, TEAM_A)
  {
    name: "fight_\{index + 1}_\{case_.bucket()}",
    note: case_.describe(),
    state,
    asks: [
      ask_fight(g, case_.node, TEAM_A),
      ask_focus(g, case_.node, TEAM_A, ""),
      ask_power(g, TEAM_A),
      // `retreat` rides along here for the same reason the fight set exists:
      // written only into the narrative scenarios, five of its six truths came
      // out "walk away", so answering "walk away" to everything scored 0.83
      // and the class could not tell a model from a rubber stamp. Half of
      // these fights are ones we win, so asking here balances it.
      if wording.is_three_way() {
        ask_retreat3(g, case_.node, TEAM_A, wording)
      } else {
        ask_retreat(g, case_.node, TEAM_A)
      },
    ],
  }
}

///|
/// The derived fight states as their own suite, in either retreat wording.
///
/// `bench_suite` appends the two-option arm; the wording experiments ask
/// several and compare them state by state. Every arm is built from the same
/// `balanced_fight_cases`, so the states, their names and every other question
/// in the request are identical and the retreat wording is the only difference.
pub fn fight_scenarios(wording : RetreatWording) -> Array[Scenario] {
  let out : Array[Scenario] = []
  let cases = balanced_fight_cases(FIGHT_PER_BUCKET)
  for i in 0..<cases.length() {
    out.push(sc_fight_case(cases[i], i, wording))
  }
  prune(out)
}

// --------------------------------------------------------------- the suite

///|
/// A laning state: two of ours in lanes with minions low, one of theirs in
/// range to poke. The `cs` class's home.
///
/// `tick` and the ripe counts are set directly rather than played into,
/// because a lane that has been played into for thirty ticks is a lane whose
/// state nobody designed — the same reason `park_all` exists.
fn sc_laning(
  name : String,
  note : String,
  ripe_mid : Int,
  ripe_bot : Int,
  their_mid_hp : Int,
) -> Scenario {
  let g = stage(comp_by_name("meta"), comp_by_name("poke"), 4, 18)
  park_all(g)
  let mid = g.champs[2]
  let bot = g.champs[3]
  mid.node = node_id("mid_mid")
  bot.node = node_id("a1_bot")
  // One of theirs beside each, so poking is on the table and the trade is a
  // real alternative to the wave rather than an illegal move.
  g.champs[7].node = node_id("b1_mid")
  g.champs[8].node = node_id("mid_bot")
  at_hp(g.champs[7], their_mid_hp)
  at_hp(g.champs[8], 90)
  g.ripe[ripe_index("mid", TEAM_A)] = ripe_mid
  g.ripe[ripe_index("bot", TEAM_A)] = ripe_bot
  let (state, _) = observe(g, TEAM_A)
  {
    name,
    note,
    state,
    asks: [
      ask_cs_pay(g, mid.id),
      ask_cs_forfeit(g, bot.id, 3),
      ask_cs_choice(g, mid.id),
      ask_cs_choice(g, bot.id),
    ],
  }
}

///|
/// A drake about to fall, with the two teams on the pit and the soul in
/// reach. The `drake` class's home.
fn sc_drake(
  name : String,
  note : String,
  comp_b : Array[String],
  rotation : Array[String],
  ours : Int,
  theirs : Int,
) -> Scenario {
  let g = stage(comp_by_name("meta"), comp_b, 5, 44)
  g.with_drakes(rotation)
  g.place_all(RIV_BOT)
  g.drakes[drake_index(TEAM_A, rotation[0])] = ours
  g.drakes[drake_index(TEAM_B, rotation[0])] = theirs
  match g.neutral_named("dragon") {
    Some(n) => {
      n.spawn_in = 0
      n.hp = 30
    }
    None => ()
  }
  // A worn fight, so the element that helps is not simply the one that adds
  // the most damage to a team that was winning anyway.
  at_hp(g.champs[0], 60)
  at_hp(g.champs[3], 50)
  at_hp(g.champs[5], 65)
  at_hp(g.champs[8], 55)
  let (state, _) = observe(g, TEAM_A)
  {
    name,
    note,
    state,
    asks: [ask_drake_element(g, TEAM_A, RIV_BOT), ask_drake_soul(g, TEAM_A)],
  }
}

///|
/// A jungle crossing with enemies in the brush. The `brush` class's home.
fn sc_brush(
  name : String,
  note : String,
  hiding : Array[Int],
  ward_from : Int,
  lit : Int,
) -> Scenario {
  let g = stage(comp_by_name("meta"), comp_by_name("dive"), 5, 30)
  park_all(g)
  let scout = g.champs[1]
  scout.node = ward_from
  scout.wards = WARD_CHARGES
  // One of ours sitting in a brush, so at least one is lit and "which of
  // these could be hiding them" has a wrong answer in it. Which one differs
  // between the states: with the same brush lit in both, the two questions
  // had the same answer and the class was measuring one state twice.
  g.champs[4].node = lit
  let carry = g.champs[3]
  carry.node = node_id("mid_bot")
  // Theirs, tucked into the brush the crossing runs past.
  for i in 0..<hiding.length() {
    g.champs[5 + i].node = hiding[i]
  }
  let (state, _) = observe(g, TEAM_A)
  {
    name,
    note,
    state,
    asks: [
      ask_brush_hidden(g, TEAM_A),
      ask_brush_ward(g, TEAM_A, scout.id),
      ask_brush_step(g, carry.id, hiding[0]),
    ],
  }
}

///|
/// A plated tower and an open gate: the two clocks the siege runs on.
fn sc_siege(
  name : String,
  note : String,
  tick : Int,
  plates_left : Int,
  gate_left : Int,
  from : Int,
) -> Scenario {
  let g = stage(comp_by_name("meta"), comp_by_name("bruisers"), 5, tick)
  park_all(g)
  // The plated tower is in TOP, and the open gate is in MID. They have to be
  // different lanes: the first version plated their mid outer tower and then
  // broke it two lines later to open the lane, so the plate question was
  // asked about a tower that was not there and answered 140 — the count on
  // an untouched tower somewhere else — in all three states.
  let tower = node_id("b1_top")
  for s in g.structures {
    if s.node == tower {
      s.plates = plates_left
      s.hp = s.max_hp * (plates_left + 1) / (PLATES + 1)
    }
    // Their mid gate is down with a clock on it, and its outer tower with it,
    // so the lane really is open.
    if s.team == TEAM_B && s.lane == "mid" && s.tier == 2 {
      s.hp = 0
      s.respawn_in = gate_left
    }
    if s.team == TEAM_B && s.lane == "mid" && s.tier == 1 {
      s.hp = 0
      s.plates = 0
    }
  }
  let mut runner = g.champs[0]
  for c in g.champs {
    if c.team == TEAM_A {
      c.node = from
      runner = c
    }
  }
  g.push[lane_index("mid")] = PUSH_TO_TOWER
  let (state, _) = observe(g, TEAM_A)
  {
    name,
    note,
    state,
    asks: [ask_siege_plates(g, tower), ask_siege_window(g, TEAM_A, runner.id)],
  }
}

///|
/// Every scenario, in report order. Each one is a single request: one state,
/// several questions.
pub fn bench_suite() -> Array[Scenario] {
  let out : Array[Scenario] = [
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
    // The mechanics the game grew after docs/56 was first written. Each class
    // gets more than one state, because one state's answer is one state's
    // answer: the `cs` arithmetic is only a measurement if the number differs
    // between questions, and which drake element pays is only a judgment if
    // the two teams differ between scenarios.
    sc_laning(
      "laning_full_wave", "two minions low in mid, three in bot, nobody in poke range is hurt",
      2, 3, 45,
    ),
    sc_laning(
      "laning_thin_wave", "nothing low in mid, one low in bot", 0, 1, 60,
    ),
    // The state the baseline's rule gets wrong. It takes the gold whenever
    // there is gold on the floor, and here one minion is on the floor and a
    // kill is standing next to it.
    sc_laning(
      "laning_kill_in_range", "one minion low in mid and their mid laner is nearly dead beside it",
      1, 2, 3,
    ),
    sc_drake(
      "drake_vs_carries",
      "a drake one hit from dying, both fives on the pit, their comp is carries",
      comp_by_name("glass_ad"),
      ["infernal", "mountain"],
      1,
      2,
    ),
    sc_drake(
      "drake_at_soul_point",
      "the same pit with three of ours already down: this one is the soul",
      comp_by_name("dive"),
      ["ocean", "cloud"],
      3,
      1,
    ),
    sc_drake(
      "drake_vs_frontline",
      "their comp is bodies rather than damage, and nobody is near the soul",
      comp_by_name("bruisers"),
      ["cloud", "infernal"],
      0,
      0,
    ),
    sc_brush(
      "brush_two_waiting",
      "two of theirs in the bottom jungle, our own top jungle lit, and a carry about to cross",
      [node_id("b_jg_bot"), node_id("a_jg_bot")],
      RIV_BOT,
      node_id("a_jg_top"),
    ),
    sc_brush(
      "brush_one_waiting",
      "one of theirs in their bottom jungle, and we are standing in their TOP jungle",
      [node_id("b_jg_bot")],
      RIV_BOT,
      node_id("b_jg_top"),
    ),
    sc_siege(
      "siege_early_plates",
      "tick 20: the plating is still worth gold and the gate has just opened",
      20,
      PLATES,
      5,
      node_id("mid_mid"),
    ),
    sc_siege(
      "siege_half_plated",
      "tick 32: two plates left, and we are a long way from their base",
      32,
      2,
      3,
      node_id("a2_mid"),
    ),
    sc_siege(
      "siege_late_window",
      "tick 52: the plating is gone and the gate is closing",
      52,
      0,
      2,
      node_id("a1_mid"),
    ),
  ]
  // The `fight` class comes last and comes from the sweep, not from here: two
  // cases per bucket, so the head count is worth 0.50 on the class and any
  // score above chance is a read of the fight rather than of the head count.
  let narrative = prune(out)
  for sc in fight_scenarios(TwoWay) {
    narrative.push(sc)
  }
  narrative
}

///|
/// How many fights to take from each of the four buckets. Four buckets times
/// this is the size of the `fight` class.
pub const FIGHT_PER_BUCKET = 4

///|
/// The classes the report groups by, in a fixed order so two runs line up.
pub let bench_classes : Array[String] = [
  "fight", "focus", "item", "dive", "lane", "macro", "retreat", "retreat3", "power",
  "ability", "fog", "cs", "drake", "brush", "siege",
]
