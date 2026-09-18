///|
/// Game state, vision, and one tick of resolution.
///
/// Everything is deterministic given the action list: the point of the
/// experiment is to compare policies, and a stochastic sim would need far more
/// games to say anything. Damage is flat, so a 2-on-1 always wins.

///|
pub const TEAM_A = 1

///|
pub const TEAM_B = 2

///|
/// What a champion can be told to do in a tick. `Move` is to an adjacent node
/// only; the rest act on whatever is in the champion's current node.
pub(all) enum Action {
  /// Walk to an adjacent node.
  Move(Int)
  /// Hit an enemy champion standing here, by champion id.
  AttackChamp(Int)
  /// Hit the enemy tower or base standing here.
  AttackStructure
  /// Take gold from the minions or camp here.
  Farm
  /// Teleport home and start healing. Costs the tick.
  Recall
  /// Do nothing.
  Hold
} derive(Eq)

///|
pub fn Action::to_string(self : Action) -> String {
  match self {
    Move(n) => "move_\{node_name(n)}"
    AttackChamp(id) => "attack_champ_\{id}"
    AttackStructure => "attack_structure"
    Farm => "farm"
    Recall => "recall"
    Hold => "hold"
  }
}

///|
pub struct Champ {
  id : Int
  name : String
  team : Int
  /// Lane this champion starts in; the scripted bot stays loyal to it.
  role : String
  /// Archetype key (marksman, mage, tank, …); "classic" is the uniform champ.
  kind : String
  /// Physical (AD) or magic (AP); see champions.mbt.
  dmg_type : Int
  /// Per-tick damage before mitigation and the gold bonus.
  attack : Int
  /// Incoming physical / magic mitigation.
  armor : Int
  mr : Int
  /// A durable body that stands between attackers and the backline; see the
  /// guard rule in `step`. This is the mechanism that makes a frontline worth
  /// a roster slot despite its low damage.
  frontline : Bool
  mut hp : Int
  max_hp : Int
  mut node : Int
  mut gold : Int
  /// Ticks until respawn. 0 when alive.
  mut respawn : Int
  mut kills : Int
  mut deaths : Int
}

///|
pub fn Champ::alive(self : Champ) -> Bool {
  self.respawn == 0
}

///|
/// A tower, or a base when `is_base`. Towers must fall before the base behind
/// them can be attacked.
pub struct Structure {
  node : Int
  team : Int
  mut hp : Int
  max_hp : Int
  is_base : Bool
}

///|
pub fn Structure::alive(self : Structure) -> Bool {
  self.hp > 0
}

///|
pub struct Game {
  champs : Array[Champ]
  structures : Array[Structure]
  mut tick : Int
  /// 0 while the game is running, otherwise the winning team.
  mut winner : Int
  /// One line per tick, for the report.
  log : Array[String]
}

///|
/// Damage a tower deals to an enemy champion standing on it, before the
/// target's armor. Below a champion's output but high enough that soloing a
/// tower costs most of a squishy's health bar, so a tank diving in front is a
/// real synergy: it survives what a marksman cannot.
const TOWER_DAMAGE = 22

///|
/// Structures have modest resists so both damage types work on them, and a
/// pure-AP or pure-AD siege is only mildly slower than a mixed one.
const STRUCT_ARMOR = 15

///|
const STRUCT_MR = 15

///|
const HEAL_AT_BASE = 25

///|
const RESPAWN_TICKS = 6

///|
/// The classic uniform game: both sides three `classic` champions. Reproduces
/// the pre-archetype behaviour of docs/02.
pub fn Game::new() -> Game {
  Game::with_comps(["classic", "classic", "classic"], [
    "classic", "classic", "classic",
  ])
}

///|
/// A game with an explicit archetype per lane for each side. `comp_a[i]` and
/// `comp_b[i]` are the archetype keys for the top / jungle / bot champions.
pub fn Game::with_comps(comp_a : Array[String], comp_b : Array[String]) -> Game {
  Game::with_handicap(comp_a, comp_b, 100, 100)
}

///|
/// Like `with_comps`, but each team's champions have their attack AND HP scaled
/// to `pct` percent (100 = full). A handicap is a single continuous knob for
/// "this team's draft/economy is behind by X", used by the boundary sweep in
/// docs/12 to find how large a deficit correct actions can still buy back.
pub fn Game::with_handicap(
  comp_a : Array[String],
  comp_b : Array[String],
  pct_a : Int,
  pct_b : Int,
) -> Game {
  let champs = []
  let roles = ["top", "jungle", "bot"]
  let a_start = [1, 8, 5]
  let b_start = [3, 10, 7]
  fn scale(x : Int, pct : Int) -> Int {
    let v = x * pct / 100
    if v < 1 {
      1
    } else {
      v
    }
  }

  fn make(
    i : Int,
    team : Int,
    start : Int,
    comp : Array[String],
    pct : Int,
  ) -> Champ {
    let k = kind_of(comp[i])
    let prefix = if team == TEAM_A { "A" } else { "B" }
    let hp = scale(k.max_hp, pct)
    {
      id: (if team == TEAM_A { 0 } else { 3 }) + i,
      name: "\{prefix}_\{roles[i]}",
      team,
      role: roles[i],
      kind: k.key,
      dmg_type: k.dmg_type,
      attack: scale(k.attack, pct),
      armor: k.armor,
      mr: k.mr,
      frontline: k.frontline,
      hp,
      max_hp: hp,
      node: start,
      gold: 0,
      respawn: 0,
      kills: 0,
      deaths: 0,
    }
  }

  for i in 0..<3 {
    champs.push(make(i, TEAM_A, a_start[i], comp_a, pct_a))
  }
  for i in 0..<3 {
    champs.push(make(i, TEAM_B, b_start[i], comp_b, pct_b))
  }
  let structures = [
    { node: 1, team: TEAM_A, hp: 100, max_hp: 100, is_base: false, },
    { node: 5, team: TEAM_A, hp: 100, max_hp: 100, is_base: false, },
    { node: A_BASE, team: TEAM_A, hp: 150, max_hp: 150, is_base: true, },
    { node: 3, team: TEAM_B, hp: 100, max_hp: 100, is_base: false, },
    { node: 7, team: TEAM_B, hp: 100, max_hp: 100, is_base: false, },
    { node: B_BASE, team: TEAM_B, hp: 150, max_hp: 150, is_base: true, },
  ]
  { champs, structures, tick: 0, winner: 0, log: [], }
}

///|
pub fn base_of(team : Int) -> Int {
  if team == TEAM_A {
    A_BASE
  } else {
    B_BASE
  }
}

///|
pub fn Game::structure_at(self : Game, node : Int) -> Structure? {
  for s in self.structures {
    if s.node == node && s.alive() {
      return Some(s)
    }
  }
  None
}

///|
/// A team's base can only be attacked once both its towers are down. Without
/// this the jungle route would win every game on turn four.
pub fn Game::base_exposed(self : Game, team : Int) -> Bool {
  for s in self.structures {
    if s.team == team && !s.is_base && s.alive() {
      return false
    }
  }
  true
}

///|
/// Who actually takes a blow aimed at `target` on `node`. A frontliner stands
/// between attackers and the backline: if `target` is a squishy and its team
/// has a living frontline champion on the same node, that frontliner soaks the
/// hit instead (the highest-HP one — the freshest wall). This is the whole
/// reason to run a tank: without it, focus fire deletes the carries and a
/// durable body is just a low-damage roster slot. A champion attacking the
/// frontliner directly, or a team with no frontline up, is unaffected.
pub fn Game::guarded_target(self : Game, target : Champ, node : Int) -> Champ {
  if target.frontline {
    return target
  }
  let mut wall = target
  let mut found = false
  for ally in self.champs {
    if ally.team == target.team &&
      ally.alive() &&
      ally.node == node &&
      ally.frontline {
      if !found || ally.hp > wall.hp {
        wall = ally
        found = true
      }
    }
  }
  wall
}

///|
/// Put every living champion on one node. Used only by the teamfight arena, to
/// force a 3v3 on a single node with no map macro in the way.
pub fn Game::place_all(self : Game, node : Int) -> Unit {
  for c in self.champs {
    c.node = node
  }
}

///|
pub fn Game::champs_at(self : Game, node : Int, team : Int) -> Array[Champ] {
  let out = []
  for c in self.champs {
    if c.team == team && c.alive() && c.node == node {
      out.push(c)
    }
  }
  out
}

// --------------------------------------------------------------- fog of war

///|
/// Which nodes a team can see: where its living champions stand, everything
/// adjacent to them, and the nodes its surviving structures sit on. This is
/// the only channel through which a policy learns about the enemy.
pub fn Game::vision(self : Game, team : Int) -> Array[Bool] {
  let seen = Array::make(N_NODES, false)
  for c in self.champs {
    if c.team == team && c.alive() {
      seen[c.node] = true
      for n in adjacency[c.node] {
        seen[n] = true
      }
    }
  }
  for s in self.structures {
    if s.team == team && s.alive() {
      seen[s.node] = true
    }
  }
  seen
}

///|
/// The enemy champions a team can currently see.
pub fn Game::visible_enemies(self : Game, team : Int) -> Array[Champ] {
  let seen = self.vision(team)
  let out = []
  for c in self.champs {
    if c.team != team && c.alive() && seen[c.node] {
      out.push(c)
    }
  }
  out
}

// ------------------------------------------------------------- legal actions

///|
/// Everything a champion may do this tick. A policy picks from exactly this
/// list, so an illegal move is impossible by construction — the model cannot
/// hallucinate a move the way it could with free-form text.
pub fn Game::legal_actions(self : Game, c : Champ) -> Array[Action] {
  if !c.alive() {
    return []
  }
  let out : Array[Action] = []
  for n in adjacency[c.node] {
    out.push(Move(n))
  }
  for e in self.visible_enemies(c.team) {
    if e.node == c.node {
      out.push(AttackChamp(e.id))
    }
  }
  match self.structure_at(c.node) {
    Some(s) =>
      if s.team != c.team && (!s.is_base || self.base_exposed(s.team)) {
        out.push(AttackStructure)
      }
    None => ()
  }
  if camp_gold(c.node) > 0 {
    out.push(Farm)
  }
  if c.node != base_of(c.team) {
    out.push(Recall)
  }
  out.push(Hold)
  out
}

// ------------------------------------------------------------------ one tick

///|
/// Apply one action per living champion, then resolve. `actions` is indexed by
/// champion id; an id with no entry holds.
pub fn Game::step(self : Game, actions : Map[Int, Action]) -> Unit {
  if self.winner != 0 {
    return
  }
  self.tick += 1
  let events = []

  // Movement and recalls first, so combat happens where champions end up.
  for c in self.champs {
    if !c.alive() {
      continue
    }
    match actions.get(c.id) {
      Some(Move(n)) => if adjacency[c.node].contains(n) { c.node = n }
      Some(Recall) => {
        c.node = base_of(c.team)
        events.push("\{c.name} recalled")
      }
      _ => ()
    }
  }

  // Combat is resolved simultaneously: every attacker's damage is computed
  // against the state at the START of this phase, accumulated, and only then
  // applied. So in a mutual lethal both champions land their blow and both
  // die — there is no advantage to being resolved first, which the id-ordered
  // version quietly gave team A.
  let champ_dmg : Map[Int, Int] = Map([])
  // For gold/kill credit: the single largest hit on each dying target.
  let top_hit : Map[Int, (Int, Int)] = Map([]) // target -> (attacker id, dmg)
  let struct_dmg : Map[Int, Int] = Map([]) // structure index -> damage
  let struct_top : Map[Int, (Int, Int)] = Map([])
  fn note_top(m : Map[Int, (Int, Int)], key : Int, attacker : Int, dmg : Int) {
    match m.get(key) {
      Some((_, best)) => if dmg > best { m[key] = (attacker, dmg) }
      None => m[key] = (attacker, dmg)
    }
  }

  for c in self.champs {
    if !c.alive() {
      continue
    }
    match actions.get(c.id) {
      Some(AttackChamp(target_id)) => {
        let aimed = self.champs[target_id]
        // `alive()` reads pre-combat state, so a champion being killed this same
        // tick is still a valid target and still gets to strike back. The
        // frontline guard then decides who actually eats the blow.
        if aimed.team != c.team && aimed.alive() && aimed.node == c.node {
          let target = self.guarded_target(aimed, c.node)
          let d = c.damage_to(target.armor, target.mr)
          champ_dmg[target.id] = champ_dmg.get(target.id).unwrap_or(0) + d
          note_top(top_hit, target.id, c.id, d)
        }
      }
      Some(AttackStructure) => {
        let mut idx = 0
        for si in 0..<self.structures.length() {
          let s = self.structures[si]
          if s.node == c.node && s.alive() {
            idx = si
          }
        }
        let s = self.structures[idx]
        if s.node == c.node &&
          s.alive() &&
          s.team != c.team &&
          (!s.is_base || self.base_exposed(s.team)) {
          let d = c.damage_to(STRUCT_ARMOR, STRUCT_MR)
          struct_dmg[idx] = struct_dmg.get(idx).unwrap_or(0) + d
          note_top(struct_top, idx, c.id, d)
        }
      }
      Some(Farm) => c.gold += camp_gold(c.node)
      _ => ()
    }
  }

  // Apply champion damage, then decide deaths — all at once.
  for entry in champ_dmg {
    let (id, d) = entry
    let target = self.champs[id]
    if !target.alive() {
      continue
    }
    target.hp -= d
    if target.hp <= 0 {
      target.hp = 0
      target.deaths += 1
      target.respawn = RESPAWN_TICKS
      match top_hit.get(id) {
        Some((killer_id, _)) => {
          let killer = self.champs[killer_id]
          killer.kills += 1
          killer.gold += 150
          events.push(
            "\{killer.name} killed \{target.name} at \{node_name(target.node)}",
          )
        }
        None => ()
      }
    }
  }
  for entry in struct_dmg {
    let (idx, d) = entry
    let s = self.structures[idx]
    if !s.alive() {
      continue
    }
    s.hp -= d
    if s.hp <= 0 {
      s.hp = 0
      match struct_top.get(idx) {
        Some((who, _)) => self.champs[who].gold += 100
        None => ()
      }
      let what = if s.is_base { "BASE" } else { "tower" }
      let by = match struct_top.get(idx) {
        Some((who, _)) => self.champs[who].name
        None => "someone"
      }
      events.push("\{by} destroyed the \{what} at \{node_name(s.node)}")
    }
  }

  // Towers punish anyone still standing on them, mitigated by armor — so a
  // tank can dive where a marksman would die.
  for s in self.structures {
    if !s.alive() {
      continue
    }
    let enemy = if s.team == TEAM_A { TEAM_B } else { TEAM_A }
    for c in self.champs_at(s.node, enemy) {
      c.hp -= TOWER_DAMAGE * 100 / (100 + c.armor)
      if c.hp <= 0 {
        c.hp = 0
        c.deaths += 1
        c.respawn = RESPAWN_TICKS
        events.push("\{c.name} was killed by the tower at \{node_name(s.node)}")
      }
    }
  }

  // Healing at home, and respawns.
  for c in self.champs {
    if c.alive() {
      if c.node == base_of(c.team) && c.hp < c.max_hp {
        c.hp = @cmp.minimum(c.max_hp, c.hp + HEAL_AT_BASE)
      }
    } else {
      c.respawn -= 1
      if c.respawn == 0 {
        c.hp = c.max_hp
        c.node = base_of(c.team)
      }
    }
  }

  for s in self.structures {
    if s.is_base && !s.alive() {
      self.winner = if s.team == TEAM_A { TEAM_B } else { TEAM_A }
    }
  }
  if events.length() > 0 {
    self.log.push("t\{self.tick}: " + events.join("; "))
  }
}

///|
/// Total structure health left, used to decide a game that hits the tick cap.
pub fn Game::structure_hp(self : Game, team : Int) -> Int {
  let mut total = 0
  for s in self.structures {
    if s.team == team {
      total += s.hp
    }
  }
  total
}

///|
/// A one-screen view of the game, for `--verbose`.
pub fn Game::render(self : Game) -> String {
  let lines = []
  lines.push("tick \{self.tick}")
  for c in self.champs {
    let where_ = if c.alive() {
      node_name(c.node)
    } else {
      "dead(\{c.respawn})"
    }
    lines.push(
      "  \{c.name} hp=\{c.hp}/\{c.max_hp} at \{where_} gold=\{c.gold} k/d=\{c.kills}/\{c.deaths}",
    )
  }
  let structs = []
  for s in self.structures {
    let tag = if s.is_base { "base" } else { "tower" }
    structs.push("\{node_name(s.node)}:\{tag}=\{s.hp}")
  }
  lines.push("  " + structs.join(" "))
  lines.join("\n")
}
