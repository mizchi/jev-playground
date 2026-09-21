///|
/// Game state and one tick of resolution, for the 5v5 game.
///
/// Everything is still deterministic given the action list: the point of the
/// experiment is to compare policies, and a stochastic sim would need far more
/// games to say anything. What the 3v3 prototype did not have, and this does:
///
/// - **Levels.** Farming and kills buy experience, experience buys stats. A
///   champion left out of the game falls behind measurably.
/// - **Items.** Gold is spent at base rather than passively added to damage, so
///   the shop is a decision with a knowable right answer (see `bench.mbt`).
/// - **Abilities on cooldowns**, including crowd control that removes a
///   champion's turn outright, and shields that absorb before health.
/// - **Neutral objectives.** Dragon stacks permanently; Baron is a short, large
///   swing. Both sit off-lane, so taking one costs lane presence.
/// - **Minion pressure.** A lane nobody stands in still moves, so a team that
///   groups all five somewhere gives up the other two lanes. This is the
///   mechanism that makes "where should we be" a real question.
/// - **Wards.** Vision can be bought with a turn and placed at range, so fog of
///   war is something a policy can act on rather than only suffer.

///|
pub const TEAM_A = 1

///|
pub const TEAM_B = 2

///|
/// Damage a tower deals each tick to an enemy champion standing on it, before
/// the target's armor. High enough that a squishy cannot solo a tower, low
/// enough that a frontliner can tank one — so diving is a real trade.
pub const TOWER_DAMAGE = 26

///|
/// Structures have modest resists so both damage types siege at a similar pace.
pub const STRUCT_ARMOR = 20

///|
pub const STRUCT_MR = 20

///|
pub const HEAL_AT_BASE = 30

///|
/// Base respawn time; a champion's level is added, so dying late costs more.
pub const RESPAWN_BASE = 4

///|
/// Damage a winning minion wave does to the tower it has reached.
///
/// Deliberately small. A shoved lane has to be worth answering, or the map is
/// decoration — but it must not win the game on its own, or the correct policy
/// collapses to "put one champion in each lane and never group again", which is
/// what a larger number here actually produced. Minions strip towers; they
/// never touch a nexus (see `lane_front`), so closing a game still takes
/// champions standing in the enemy base.
pub const MINION_DAMAGE = 4

///|
/// How lopsided a lane's minion wave must get before it reaches a structure by
/// itself, and how far the pressure can accumulate.
pub const PUSH_TO_TOWER = 3

///|
pub const PUSH_CAP = 5

///|
/// Health regenerated per tick, as a percent of maximum, while no enemy
/// champion is standing on the same node. Without it a champion that loses a
/// trade has to walk home, and both teams spend the game commuting instead of
/// playing it.
pub const REGEN_PCT = 6

///|
pub const DRAGON_HP = 210

///|
pub const BARON_HP = 340

///|
/// Attack bonus per permanent Dragon stack, in percent.
pub const DRAGON_ATK_PCT = 7

///|
/// The Baron buff: a large attack bonus and faster sieging, for a short window.
pub const BARON_ATK_PCT = 25

///|
pub const BARON_STRUCT_PCT = 40

///|
pub const BARON_TICKS = 12

///|
/// How long a ward sees, how many a champion carries, and what a `Ward` costs.
pub const WARD_TTL = 8

///|
pub const WARD_CHARGES = 2

///|
pub const KILL_GOLD = 160

///|
pub const KILL_XP = 45

///|
pub const ASSIST_GOLD = 60

///|
/// Bonus damage from `Execute`, as a percent of the target's MISSING health.
pub const EXECUTE_PCT = 35

///|
/// How long a shield lasts before it expires unused.
pub const SHIELD_TTL = 3

///|
/// The five roles, in the order champions are created and printed.
pub let roles : Array[String] = ["top", "jungle", "mid", "bot", "support"]

// ------------------------------------------------------------------ champions

///|
pub struct Champ {
  id : Int
  name : String
  team : Int
  /// The lane this champion is drafted into; lane-loyal bots stay in it.
  role : String
  /// Archetype key; "classic" is the 3v3 prototype's uniform champion.
  kind : String
  dmg_type : Int
  /// Level-1 stats, after any team handicap. Everything else is derived.
  base_attack : Int
  base_hp : Int
  base_armor : Int
  base_mr : Int
  frontline : Bool
  /// Ranged champions may `Poke` an adjacent node for half damage.
  ranged : Bool
  ability : Ability
  /// The ability's cooldown length; `cd` is what is left of it.
  cooldown : Int
  mut cd : Int
  mut hp : Int
  /// Recomputed whenever level or items change; health follows the change.
  mut max_hp : Int
  mut shield : Int
  mut shield_ttl : Int
  /// Ticks this champion cannot act for. Crowd control.
  mut stunned : Int
  mut node : Int
  mut gold : Int
  mut xp : Int
  mut level : Int
  /// Ticks until respawn. 0 when alive.
  mut respawn : Int
  mut kills : Int
  mut deaths : Int
  mut assists : Int
  /// Item keys, at most `ITEM_SLOTS` of them.
  items : Array[String]
  /// Unplaced wards in hand.
  mut wards : Int
}

///|
pub fn Champ::alive(self : Champ) -> Bool {
  self.respawn == 0
}

///|
/// A champion that is alive but stunned cannot act at all this tick.
pub fn Champ::can_act(self : Champ) -> Bool {
  self.respawn == 0 && self.stunned == 0
}

///|
pub fn Champ::ability_ready(self : Champ) -> Bool {
  self.ability != NoAbility && self.cd == 0
}

///|
/// Attack after level scaling and items, before team buffs and mitigation.
/// Buffs are team state, so the full number comes from `Game::raw_attack`.
pub fn Champ::attack(self : Champ) -> Int {
  let scaled = self.base_attack * (100 + 12 * (self.level - 1)) / 100
  let mut bonus = 0
  for key in self.items {
    match item_of(key) {
      Some(it) => bonus += it.atk
      None => ()
    }
  }
  scaled + bonus
}

///|
pub fn Champ::armor(self : Champ) -> Int {
  let mut v = self.base_armor + 3 * (self.level - 1)
  for key in self.items {
    match item_of(key) {
      Some(it) => v += it.armor
      None => ()
    }
  }
  v
}

///|
pub fn Champ::mr(self : Champ) -> Int {
  let mut v = self.base_mr + 3 * (self.level - 1)
  for key in self.items {
    match item_of(key) {
      Some(it) => v += it.mr
      None => ()
    }
  }
  v
}

///|
/// Penetration: how much of the target's matching resist this champion ignores.
pub fn Champ::pen(self : Champ) -> Int {
  let mut v = 0
  for key in self.items {
    match item_of(key) {
      Some(it) => v += it.pen
      None => ()
    }
  }
  v
}

///|
/// Health at this level with these items.
pub fn Champ::hp_cap(self : Champ) -> Int {
  let mut v = self.base_hp * (100 + 14 * (self.level - 1)) / 100
  for key in self.items {
    match item_of(key) {
      Some(it) => v += it.hp
      None => ()
    }
  }
  v
}

///|
/// Bring `max_hp` in line with level and items, moving current health by the
/// same amount — a level-up or a health item is felt immediately, as in the
/// games this is modelled on.
pub fn Champ::refresh_hp(self : Champ) -> Unit {
  let target = self.hp_cap()
  let delta = target - self.max_hp
  self.max_hp = target
  if delta > 0 {
    self.hp += delta
  }
  if self.hp > self.max_hp {
    self.hp = self.max_hp
  }
}

///|
/// Award experience and level up if it crosses a threshold.
pub fn Champ::gain_xp(self : Champ, amount : Int) -> Unit {
  self.xp += amount
  let mut want = 1 + self.xp / LEVEL_XP
  if want > MAX_LEVEL {
    want = MAX_LEVEL
  }
  if want > self.level {
    self.level = want
    self.refresh_hp()
  }
}

///|
/// Effective health against a physical and a magic attacker, averaged. Used for
/// readable state and for the power read in `bench.mbt`; the simulation itself
/// always uses the exact resist.
pub fn Champ::effective_hp(self : Champ) -> Int {
  let vs_ad = self.hp * (100 + self.armor()) / 100
  let vs_ap = self.hp * (100 + self.mr()) / 100
  (vs_ad + vs_ap) / 2
}

///|
pub fn Champ::copy(self : Champ) -> Champ {
  let items = []
  for it in self.items {
    items.push(it)
  }
  {
    id: self.id,
    name: self.name,
    team: self.team,
    role: self.role,
    kind: self.kind,
    dmg_type: self.dmg_type,
    base_attack: self.base_attack,
    base_hp: self.base_hp,
    base_armor: self.base_armor,
    base_mr: self.base_mr,
    frontline: self.frontline,
    ranged: self.ranged,
    ability: self.ability,
    cooldown: self.cooldown,
    cd: self.cd,
    hp: self.hp,
    max_hp: self.max_hp,
    shield: self.shield,
    shield_ttl: self.shield_ttl,
    stunned: self.stunned,
    node: self.node,
    gold: self.gold,
    xp: self.xp,
    level: self.level,
    respawn: self.respawn,
    kills: self.kills,
    deaths: self.deaths,
    assists: self.assists,
    items,
    wards: self.wards,
  }
}

// ----------------------------------------------------------------- structures

///|
/// A tower or a nexus. `tier` is 1 for the outer tower, 2 for the inner one and
/// 3 for the nexus; a tier cannot be attacked while a lower one in the same
/// lane still stands.
pub struct Structure {
  node : Int
  team : Int
  lane : String
  tier : Int
  mut hp : Int
  max_hp : Int
}

///|
pub fn Structure::alive(self : Structure) -> Bool {
  self.hp > 0
}

///|
pub fn Structure::is_nexus(self : Structure) -> Bool {
  self.tier == 3
}

///|
pub fn Structure::kind_name(self : Structure) -> String {
  match self.tier {
    1 => "outer tower"
    2 => "inner tower"
    _ => "NEXUS"
  }
}

///|
pub fn Structure::copy(self : Structure) -> Structure {
  {
    node: self.node,
    team: self.team,
    lane: self.lane,
    tier: self.tier,
    hp: self.hp,
    max_hp: self.max_hp,
  }
}

// ------------------------------------------------------------------- neutrals

///|
/// An epic monster in the river. `spawn_in` counts down to its (re)appearance,
/// so both teams know when the next one is coming — which is what makes an
/// objective timer something to plan around rather than react to.
pub struct Neutral {
  node : Int
  key : String
  mut hp : Int
  max_hp : Int
  mut spawn_in : Int
  respawn_ticks : Int
}

///|
pub fn Neutral::alive(self : Neutral) -> Bool {
  self.spawn_in == 0 && self.hp > 0
}

///|
pub fn Neutral::copy(self : Neutral) -> Neutral {
  {
    node: self.node,
    key: self.key,
    hp: self.hp,
    max_hp: self.max_hp,
    spawn_in: self.spawn_in,
    respawn_ticks: self.respawn_ticks,
  }
}

///|
/// A placed ward: vision of a node and its neighbours, for a while.
pub struct Ward {
  node : Int
  team : Int
  mut ttl : Int
}

///|
pub fn Ward::copy(self : Ward) -> Ward {
  { node: self.node, team: self.team, ttl: self.ttl, }
}

// ----------------------------------------------------------------- the game

///|
pub struct Game {
  champs : Array[Champ]
  structures : Array[Structure]
  neutrals : Array[Neutral]
  wards : Array[Ward]
  /// Minion pressure per lane, indexed as `lanes`. Positive means team A's
  /// wave is ahead in that lane.
  push : Array[Int]
  /// Permanent Dragon stacks, indexed by team id (slot 0 unused).
  dragons : Array[Int]
  /// Ticks of Baron buff left, indexed by team id.
  baron : Array[Int]
  mut tick : Int
  /// 0 while the game is running, otherwise the winning team.
  mut winner : Int
  /// One line per eventful tick, for the report and the replay.
  log : Array[String]
}

///|
/// The uniform control game: five `classic` champions a side, which is the 3v3
/// prototype's champion with two more bodies and the new map.
pub fn Game::new() -> Game {
  Game::with_comps(comp_by_name("classic"), comp_by_name("classic"))
}

///|
/// A game with an explicit archetype per role for each side. `comp[i]` is the
/// archetype for `roles[i]`.
pub fn Game::with_comps(comp_a : Array[String], comp_b : Array[String]) -> Game {
  Game::with_handicap(comp_a, comp_b, 100, 100)
}

///|
/// Like `with_comps`, but each team's champions have attack AND health scaled
/// to `pct` percent. One continuous knob for "this team's draft or economy is
/// behind by X", which the boundary sweep uses.
pub fn Game::with_handicap(
  comp_a : Array[String],
  comp_b : Array[String],
  pct_a : Int,
  pct_b : Int,
) -> Game {
  // Where each role starts: on its own outer tower, one hop from the middle of
  // its lane. The jungler starts in its own bottom-side jungle, next to the
  // Dragon pit; the support shares the bot lane, as the role does in the games
  // this is modelled on.
  //
  // These two lists are exact mirrors of each other under the A↔B relabelling
  // of node names, and so is `adjacency`. That matters more than it looks: it
  // means a mirror match between two deterministic policies must draw, so a
  // win in this game is never a side advantage in disguise. Starting A's
  // jungler on the top side instead — next to Baron, which spawns at tick 24,
  // while B's sat next to a Dragon that spawns at tick 6 — was worth about a
  // free win to team B.
  let a_start = [3, 18, 8, 13, 13]
  let b_start = [5, 22, 10, 15, 15]
  fn scale(x : Int, pct : Int) -> Int {
    let v = x * pct / 100
    if v < 1 {
      1
    } else {
      v
    }
  }

  fn make(i : Int, team : Int, comp : Array[String], pct : Int) -> Champ {
    let key = if i < comp.length() { comp[i] } else { "classic" }
    let k = kind_of(key)
    let prefix = if team == TEAM_A { "A" } else { "B" }
    let hp = scale(k.max_hp, pct)
    let start = if team == TEAM_A { a_start[i] } else { b_start[i] }
    {
      id: (if team == TEAM_A { 0 } else { 5 }) + i,
      name: "\{prefix}_\{roles[i]}",
      team,
      role: roles[i],
      kind: k.key,
      dmg_type: k.dmg_type,
      base_attack: scale(k.attack, pct),
      base_hp: hp,
      base_armor: k.armor,
      base_mr: k.mr,
      frontline: k.frontline,
      ranged: k.ranged,
      ability: k.ability,
      cooldown: k.cooldown,
      cd: 0,
      hp,
      max_hp: hp,
      shield: 0,
      shield_ttl: 0,
      stunned: 0,
      node: start,
      gold: 0,
      xp: 0,
      level: 1,
      respawn: 0,
      kills: 0,
      deaths: 0,
      assists: 0,
      items: [],
      wards: WARD_CHARGES,
    }
  }

  let champs = []
  for i in 0..<5 {
    champs.push(make(i, TEAM_A, comp_a, pct_a))
  }
  for i in 0..<5 {
    champs.push(make(i, TEAM_B, comp_b, pct_b))
  }
  // Two towers per lane per side, then the nexus. The outer tower is the one
  // further from its own base.
  let structures : Array[Structure] = []
  let a_outer = [3, 8, 13]
  let a_inner = [2, 7, 12]
  let b_outer = [5, 10, 15]
  let b_inner = [6, 11, 16]
  for li in 0..<3 {
    let lane = lanes[li]
    structures.push({
      node: a_outer[li],
      team: TEAM_A,
      lane,
      tier: 1,
      hp: 130,
      max_hp: 130,
    })
    structures.push({
      node: a_inner[li],
      team: TEAM_A,
      lane,
      tier: 2,
      hp: 160,
      max_hp: 160,
    })
    structures.push({
      node: b_outer[li],
      team: TEAM_B,
      lane,
      tier: 1,
      hp: 130,
      max_hp: 130,
    })
    structures.push({
      node: b_inner[li],
      team: TEAM_B,
      lane,
      tier: 2,
      hp: 160,
      max_hp: 160,
    })
  }
  structures.push({
    node: A_BASE,
    team: TEAM_A,
    lane: "base",
    tier: 3,
    hp: 260,
    max_hp: 260,
  })
  structures.push({
    node: B_BASE,
    team: TEAM_B,
    lane: "base",
    tier: 3,
    hp: 260,
    max_hp: 260,
  })
  let neutrals : Array[Neutral] = [
    // Dragon is up early and often: a small permanent stack, repeatedly
    // contested. Baron arrives late and once: a short, decisive window.
    {
      node: RIV_BOT,
      key: "dragon",
      hp: DRAGON_HP,
      max_hp: DRAGON_HP,
      spawn_in: 6,
      respawn_ticks: 16,
    },
    {
      node: RIV_TOP,
      key: "baron",
      hp: BARON_HP,
      max_hp: BARON_HP,
      spawn_in: 24,
      respawn_ticks: 24,
    },
  ]
  {
    champs,
    structures,
    neutrals,
    wards: [],
    push: [0, 0, 0],
    dragons: [0, 0, 0],
    baron: [0, 0, 0],
    tick: 0,
    winner: 0,
    log: [],
  }
}

///|
/// A deep copy. The benchmark's ground truth is computed by playing a situation
/// out several different ways, so every oracle in `bench.mbt` works on one of
/// these rather than on the live game.
pub fn Game::copy(self : Game) -> Game {
  let champs = []
  for c in self.champs {
    champs.push(c.copy())
  }
  let structures = []
  for s in self.structures {
    structures.push(s.copy())
  }
  let neutrals = []
  for n in self.neutrals {
    neutrals.push(n.copy())
  }
  let wards = []
  for w in self.wards {
    wards.push(w.copy())
  }
  let log = []
  for l in self.log {
    log.push(l)
  }
  {
    champs,
    structures,
    neutrals,
    wards,
    push: [self.push[0], self.push[1], self.push[2]],
    dragons: [0, self.dragons[1], self.dragons[2]],
    baron: [0, self.baron[1], self.baron[2]],
    tick: self.tick,
    winner: self.winner,
    log,
  }
}

// --------------------------------------------------------------- state queries

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
pub fn Game::neutral_at(self : Game, node : Int) -> Neutral? {
  for n in self.neutrals {
    if n.node == node && n.alive() {
      return Some(n)
    }
  }
  None
}

///|
/// Whether both of a lane's towers are down for `team` — the condition that
/// exposes its nexus. One lane is enough, which is why a single lane's siege
/// is a win condition and lane pressure is worth spending a champion on.
pub fn Game::lane_open(self : Game, team : Int, lane : String) -> Bool {
  for s in self.structures {
    if s.team == team && s.lane == lane && !s.is_nexus() && s.alive() {
      return false
    }
  }
  true
}

///|
/// The lane's index in `lanes`, or -1 for a node that is not in a lane.
pub fn lane_index(lane : String) -> Int {
  for i in 0..<3 {
    if lanes[i] == lane {
      return i
    }
  }
  -1
}

///|
/// Whether `team`'s minion wave currently holds `lane`. This is the single
/// most load-bearing piece of state in the game: a team with the wave can
/// siege, and a team without it cannot.
pub fn Game::has_wave(self : Game, team : Int, lane : String) -> Bool {
  let li = lane_index(lane)
  if li < 0 {
    return false
  }
  let ours = if team == TEAM_A { self.push[li] } else { -self.push[li] }
  ours >= 1
}

///|
/// Whether a structure shoots `c` while it stands there.
///
/// It does NOT if `c`'s own minion wave holds that lane — the minions are what
/// the tower shoots instead. This is the rule that makes lane pressure the
/// centre of the game rather than a decoration: a champion alone under a tower
/// with no wave loses the trade to the tower every time, and the same champion
/// with a wave in front of it takes the tower down. A nexus is not in a lane,
/// so it always shoots.
pub fn Game::tower_shoots(self : Game, s : Structure, c : Champ) -> Bool {
  if s.is_nexus() {
    return true
  }
  !self.has_wave(c.team, s.lane)
}

///|
pub fn Game::nexus_exposed(self : Game, team : Int) -> Bool {
  for lane in lanes {
    if self.lane_open(team, lane) {
      return true
    }
  }
  false
}

///|
/// Whether a structure can be damaged right now. A tier cannot be skipped.
pub fn Game::structure_attackable(self : Game, s : Structure) -> Bool {
  if !s.alive() {
    return false
  }
  if s.is_nexus() {
    return self.nexus_exposed(s.team)
  }
  if s.tier == 1 {
    return true
  }
  // An inner tower is shielded by its own lane's outer tower.
  for o in self.structures {
    if o.team == s.team && o.lane == s.lane && o.tier == 1 && o.alive() {
      return false
    }
  }
  true
}

///|
/// The structure `team`'s champions are pressing in `lane`: the enemy's outer
/// tower, then its inner tower, then the nexus once the lane is open. -1 when
/// there is nothing left to press.
pub fn Game::lane_front(self : Game, team : Int, lane : String) -> Int {
  let foe = enemy_of(team)
  for tier in [1, 2] {
    for s in self.structures {
      if s.team == foe && s.lane == lane && s.tier == tier && s.alive() {
        return s.node
      }
    }
  }
  if self.lane_open(foe, lane) {
    for s in self.structures {
      if s.team == foe && s.is_nexus() && s.alive() {
        return s.node
      }
    }
  }
  -1
}

///|
/// The same, but only as far as minions go: a wave strips towers and stops at
/// the nexus. Closing a game is a thing champions do.
pub fn Game::minion_front(self : Game, team : Int, lane : String) -> Int {
  let front = self.lane_front(team, lane)
  if front < 0 {
    return -1
  }
  match self.structure_at(front) {
    Some(s) => if s.is_nexus() { -1 } else { front }
    None => -1
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

///|
pub fn Game::living(self : Game, team : Int) -> Array[Champ] {
  let out = []
  for c in self.champs {
    if c.team == team && c.alive() {
      out.push(c)
    }
  }
  out
}

///|
/// Put every living champion on one node. Used only by the teamfight arena and
/// by the benchmark, to force a fight with no map macro in the way.
pub fn Game::place_all(self : Game, node : Int) -> Unit {
  for c in self.champs {
    c.node = node
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
/// Total gold earned by a team, spent or not — the economy line a real client
/// shows, and the cheapest single read of who is ahead.
pub fn Game::team_gold(self : Game, team : Int) -> Int {
  let mut total = 0
  for c in self.champs {
    if c.team == team {
      total += c.gold + c.items.length() * ITEM_COST
    }
  }
  total
}

///|
pub fn Game::team_level(self : Game, team : Int) -> Int {
  let mut total = 0
  for c in self.champs {
    if c.team == team {
      total += c.level
    }
  }
  total
}

// ------------------------------------------------------------------- vision

///|
/// Which nodes a team can see: where its living champions stand, everything
/// adjacent to them, the nodes its surviving structures sit on, and everything
/// its wards cover. This is the only channel through which a policy learns
/// about the enemy.
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
  for w in self.wards {
    if w.team == team && w.ttl > 0 {
      seen[w.node] = true
      for n in adjacency[w.node] {
        seen[n] = true
      }
    }
  }
  seen
}

///|
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

///|
/// Whether `team` already has a live ward on `node`. A second ward on a node
/// that is already watched buys nothing, and a policy that keeps placing one is
/// spending a turn a tick on vision it already has.
pub fn Game::has_ward(self : Game, team : Int, node : Int) -> Bool {
  for w in self.wards {
    if w.team == team && w.node == node && w.ttl > 0 {
      return true
    }
  }
  false
}

///|
pub fn Game::wards_of(self : Game, team : Int) -> Array[Ward] {
  let out = []
  for w in self.wards {
    if w.team == team && w.ttl > 0 {
      out.push(w)
    }
  }
  out
}

// ------------------------------------------------------------------- combat

///|
/// The team-wide damage multiplier from objectives, in percent. Dragon stacks
/// are permanent and small; the Baron buff is temporary and large. Both apply
/// to basic attacks and to ability power, so an objective is worth the same to
/// every composition rather than only to the ones that auto-attack.
pub fn Game::buff_pct(self : Game, team : Int) -> Int {
  let mut pct = 100 + DRAGON_ATK_PCT * self.dragons[team]
  if self.baron[team] > 0 {
    pct += BARON_ATK_PCT
  }
  pct
}

///|
/// Attack after level, items and team buffs, before the target's mitigation.
///
/// The buff is rounded rather than truncated. Truncating it meant a single
/// Dragon stack — a permanent +7% — was worth exactly nothing to a champion
/// with an attack below 15, which is most of them early, so the objective the
/// whole bottom half of the map exists for did not register.
pub fn Game::raw_attack(self : Game, c : Champ) -> Int {
  let v = (c.attack() * self.buff_pct(c.team) + 50) / 100
  if v < 1 {
    1
  } else {
    v
  }
}

///|
/// Damage `c` lands on a target with the given resists: mitigated by the
/// resist matching `c`'s damage type, reduced by `c`'s penetration, never less
/// than 1 so a fight cannot stall forever.
pub fn Game::damage_to(
  self : Game,
  c : Champ,
  target_armor : Int,
  target_mr : Int,
) -> Int {
  let base = self.raw_attack(c)
  let raw_resist = if c.dmg_type == DMG_PHYSICAL {
    target_armor
  } else {
    target_mr
  }
  let mut resist = raw_resist - c.pen()
  if resist < 0 {
    resist = 0
  }
  let dealt = base * 100 / (100 + resist)
  if dealt < 1 {
    1
  } else {
    dealt
  }
}

///|
pub fn Game::damage_to_champ(self : Game, c : Champ, target : Champ) -> Int {
  self.damage_to(c, target.armor(), target.mr())
}

///|
/// Damage a structure takes from `c`, including the Baron siege bonus.
pub fn Game::damage_to_structure(self : Game, c : Champ) -> Int {
  let mut d = self.damage_to(c, STRUCT_ARMOR, STRUCT_MR)
  if self.baron[c.team] > 0 {
    d = d * (100 + BARON_STRUCT_PCT) / 100
  }
  d
}

///|
/// An ability's damage on a target: the power scaled by level, mitigated like a
/// basic attack, plus `Execute`'s bonus for missing health.
pub fn Game::ability_damage(self : Game, c : Champ, target : Champ) -> Int {
  let power = match c.ability {
    Nuke(p) | Aoe(p) => p
    Execute(p) => p + (target.max_hp - target.hp) * EXECUTE_PCT / 100
    _ => 0
  }
  if power == 0 {
    return 0
  }
  let by_level = power * (100 + 15 * (c.level - 1)) / 100
  let scaled = (by_level * self.buff_pct(c.team) + 50) / 100
  let raw_resist = if c.dmg_type == DMG_PHYSICAL {
    target.armor()
  } else {
    target.mr()
  }
  let mut resist = raw_resist - c.pen()
  if resist < 0 {
    resist = 0
  }
  let dealt = scaled * 100 / (100 + resist)
  if dealt < 1 {
    1
  } else {
    dealt
  }
}

///|
/// How much an ability restores or absorbs, after level scaling. Objective
/// buffs do not make a support heal harder — they are a damage buff, so
/// sustain is the one thing a Baron does not inflate.
pub fn ability_support(c : Champ) -> Int {
  let power = match c.ability {
    Heal(p) | Shield(p) => p
    _ => 0
  }
  power * (100 + 15 * (c.level - 1)) / 100
}

///|
/// Who actually takes a blow aimed at `target` on `node`. A frontliner stands
/// between attackers and the backline: if `target` is a squishy and its team
/// has a living frontline champion on the same node, that frontliner soaks the
/// hit instead (the highest-health one — the freshest wall). `Nuke` bypasses
/// this, which is the whole reason an assassin is drafted.
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
/// The softest enemy on a node: lowest current health. What focus fire picks,
/// and the reason a frontline is worth a roster slot.
pub fn Game::softest_at(self : Game, node : Int, team : Int) -> Champ? {
  let foes = self.champs_at(node, enemy_of(team))
  if foes.is_empty() {
    return None
  }
  let mut pick = foes[0]
  for f in foes {
    if f.hp < pick.hp {
      pick = f
    }
  }
  Some(pick)
}

///|
/// Apply damage to a champion, spending any shield first.
fn take_damage(c : Champ, amount : Int) -> Unit {
  let mut left = amount
  if c.shield > 0 {
    let absorbed = @cmp.minimum(c.shield, left)
    c.shield -= absorbed
    left -= absorbed
    if c.shield == 0 {
      c.shield_ttl = 0
    }
  }
  c.hp -= left
}

// ------------------------------------------------------------------ one tick

///|
/// Apply one action per champion that can act, then resolve. `actions` is keyed
/// by champion id; an id with no entry holds. A stunned champion's action is
/// discarded — crowd control removes the turn, it does not delay it.
pub fn Game::step(self : Game, actions : Map[Int, Action]) -> Unit {
  if self.winner != 0 {
    return
  }
  self.tick += 1
  let events : Array[String] = []
  // Who was already stunned when this tick began. Crowd control applied during
  // this tick must not also expire during it: a `Stun(1)` that ticked down the
  // moment it landed cost the target nothing at all.
  let pre_stunned = Array::make(self.champs.length(), false)
  for i in 0..<self.champs.length() {
    pre_stunned[i] = self.champs[i].stunned > 0
  }

  // Movement, recalls and purchases first, so combat happens where champions
  // end up and with the items they just bought.
  for c in self.champs {
    if !c.can_act() {
      continue
    }
    match actions.get(c.id) {
      Some(Move(n)) => if adjacency[c.node].contains(n) { c.node = n }
      Some(Blink(n)) =>
        if c.ability == Blink && c.cd == 0 && blink_targets(c.node).contains(n) {
          c.node = n
          c.cd = c.cooldown
          events.push("\{c.name} blinked to \{node_name(n)}")
        }
      Some(Recall) => {
        c.node = base_of(c.team)
        events.push("\{c.name} recalled")
      }
      Some(Buy(key)) =>
        if c.node == base_of(c.team) && c.items.length() < ITEM_SLOTS {
          match item_of(key) {
            Some(it) =>
              if c.gold >= it.cost {
                c.gold -= it.cost
                c.items.push(it.key)
                c.refresh_hp()
                events.push("\{c.name} bought \{it.key}")
              }
            None => ()
          }
        }
      Some(PlaceWard(n)) =>
        if c.wards > 0 && (n == c.node || adjacency[c.node].contains(n)) {
          c.wards -= 1
          self.wards.push({ node: n, team: c.team, ttl: WARD_TTL, })
        }
      _ => ()
    }
  }

  // Combat is resolved simultaneously: every attacker's damage is computed
  // against the state at the START of this phase, accumulated, and only then
  // applied. So in a mutual lethal both champions land their blow and both
  // die — there is no advantage to being resolved first.
  let champ_dmg : Map[Int, Int] = Map([])
  // For kill and assist credit: the largest single hit, and everyone who hit.
  let top_hit : Map[Int, (Int, Int)] = Map([])
  let hitters : Map[Int, Array[Int]] = Map([])
  let struct_dmg : Map[Int, Int] = Map([])
  let struct_top : Map[Int, (Int, Int)] = Map([])
  let neutral_dmg : Map[Int, Int] = Map([])
  let neutral_top : Map[Int, (Int, Int)] = Map([])
  // Crowd control and support land after damage, so a stun applied this tick
  // takes the target's NEXT turn and does not retroactively cancel this one.
  let pending_stun : Array[(Int, Int)] = []
  let pending_heal : Array[(Int, Int)] = []
  let pending_shield : Array[(Int, Int)] = []
  fn note_top(m : Map[Int, (Int, Int)], key : Int, who : Int, dmg : Int) {
    match m.get(key) {
      Some((_, best)) => if dmg > best { m[key] = (who, dmg) }
      None => m[key] = (who, dmg)
    }
  }

  fn hurt(target : Int, who : Int, dmg : Int) {
    champ_dmg[target] = champ_dmg.get(target).unwrap_or(0) + dmg
    note_top(top_hit, target, who, dmg)
    match hitters.get(target) {
      Some(arr) => if !arr.contains(who) { arr.push(who) }
      None => hitters[target] = [who]
    }
  }

  for c in self.champs {
    if !c.can_act() {
      continue
    }
    match actions.get(c.id) {
      Some(AttackChamp(target_id)) => {
        let aimed = self.champs[target_id]
        // `alive()` reads pre-combat state, so a champion being killed this
        // same tick is still a valid target and still gets to strike back.
        if aimed.team != c.team && aimed.alive() && aimed.node == c.node {
          let target = self.guarded_target(aimed, c.node)
          hurt(target.id, c.id, self.damage_to_champ(c, target))
        }
      }
      Some(Poke(target_id)) => {
        let aimed = self.champs[target_id]
        // Half damage into a neighbouring node, and nothing comes back. Only a
        // ranged champion can do it, and only through the enemy's frontline —
        // poke is chip damage, not an execution.
        if c.ranged &&
          aimed.team != c.team &&
          aimed.alive() &&
          adjacency[c.node].contains(aimed.node) {
          let target = self.guarded_target(aimed, aimed.node)
          let d = self.damage_to_champ(c, target) / 2
          hurt(target.id, c.id, if d < 1 { 1 } else { d })
        }
      }
      Some(Cast(_, target_id)) =>
        if c.ability_ready() {
          let mut spent = false
          match c.ability {
            Nuke(_) => {
              let aimed = self.champs[target_id]
              // A nuke reaches past the frontline: this is the answer to a
              // wall standing in front of a carry.
              if aimed.team != c.team && aimed.alive() && aimed.node == c.node {
                hurt(aimed.id, c.id, self.ability_damage(c, aimed))
                spent = true
              }
            }
            Execute(_) => {
              let aimed = self.champs[target_id]
              if aimed.team != c.team && aimed.alive() && aimed.node == c.node {
                let target = self.guarded_target(aimed, c.node)
                hurt(target.id, c.id, self.ability_damage(c, target))
                spent = true
              }
            }
            Aoe(_) => {
              let foes = self.champs_at(c.node, enemy_of(c.team))
              if !foes.is_empty() {
                for f in foes {
                  hurt(f.id, c.id, self.ability_damage(c, f))
                }
                spent = true
              }
            }
            Stun(ticks) => {
              let aimed = self.champs[target_id]
              if aimed.team != c.team && aimed.alive() && aimed.node == c.node {
                pending_stun.push((aimed.id, ticks))
                events.push("\{c.name} stunned \{aimed.name}")
                spent = true
              }
            }
            Heal(_) => {
              let amount = ability_support(c)
              match self.neediest_ally(c) {
                Some(a) => {
                  pending_heal.push((a.id, amount))
                  spent = true
                }
                None => ()
              }
            }
            Shield(_) => {
              let amount = ability_support(c)
              match self.neediest_ally(c) {
                Some(a) => {
                  pending_shield.push((a.id, amount))
                  spent = true
                }
                None => ()
              }
            }
            NoAbility | Blink => ()
          }
          if spent {
            c.cd = c.cooldown
          }
        }
      Some(AttackStructure) => {
        let mut idx = -1
        for si in 0..<self.structures.length() {
          let s = self.structures[si]
          if s.node == c.node && s.alive() && s.team != c.team {
            idx = si
          }
        }
        if idx >= 0 && self.structure_attackable(self.structures[idx]) {
          let d = self.damage_to_structure(c)
          struct_dmg[idx] = struct_dmg.get(idx).unwrap_or(0) + d
          note_top(struct_top, idx, c.id, d)
        }
      }
      Some(AttackNeutral) => {
        let mut idx = -1
        for ni in 0..<self.neutrals.length() {
          let n = self.neutrals[ni]
          if n.node == c.node && n.alive() {
            idx = ni
          }
        }
        if idx >= 0 {
          // Epic monsters have no resists: an objective is a damage race, and
          // both damage types race equally.
          let d = self.raw_attack(c)
          neutral_dmg[idx] = neutral_dmg.get(idx).unwrap_or(0) + d
          note_top(neutral_top, idx, c.id, d)
        }
      }
      // Farming pays the full camp on top of the passive trickle every
      // champion in a lane gets, and — see the minion phase — shoves the wave.
      Some(Farm) =>
        if camp_gold(c.node) > 0 {
          c.gold += camp_gold(c.node)
          c.gain_xp(camp_xp(c.node))
        }
      _ => ()
    }
  }

  // Support lands before damage is applied, so a shield thrown this tick
  // absorbs this tick's blows — which is what makes pre-emptive shielding a
  // better play than reactive healing.
  for entry in pending_shield {
    let (id, amount) = entry
    let a = self.champs[id]
    if a.alive() && amount > a.shield {
      a.shield = amount
      a.shield_ttl = SHIELD_TTL
    }
  }

  // Champion damage, then deaths — all at once.
  for entry in champ_dmg {
    let (id, d) = entry
    let target = self.champs[id]
    if !target.alive() {
      continue
    }
    take_damage(target, d)
  }
  // Heals apply after damage: a heal saves a champion only if the blows that
  // landed this tick did not already kill it.
  for entry in pending_heal {
    let (id, amount) = entry
    let a = self.champs[id]
    if a.alive() && a.hp > 0 {
      a.hp = @cmp.minimum(a.max_hp, a.hp + amount)
    }
  }
  for entry in champ_dmg {
    let (id, _) = entry
    let target = self.champs[id]
    if target.respawn != 0 || target.hp > 0 {
      continue
    }
    target.hp = 0
    target.deaths += 1
    target.respawn = RESPAWN_BASE + target.level
    target.shield = 0
    target.shield_ttl = 0
    target.stunned = 0
    match top_hit.get(id) {
      Some((killer_id, _)) => {
        let killer = self.champs[killer_id]
        killer.kills += 1
        killer.gold += KILL_GOLD
        killer.gain_xp(KILL_XP)
        match hitters.get(id) {
          Some(arr) =>
            for who in arr {
              if who != killer_id {
                let helper = self.champs[who]
                helper.assists += 1
                helper.gold += ASSIST_GOLD
                helper.gain_xp(KILL_XP / 2)
              }
            }
          None => ()
        }
        events.push(
          "\{killer.name} killed \{target.name} at \{node_name(target.node)}",
        )
      }
      None => ()
    }
  }

  // Crowd control takes the target's next turn.
  for entry in pending_stun {
    let (id, ticks) = entry
    let t = self.champs[id]
    if t.alive() && ticks > t.stunned {
      t.stunned = ticks
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
      let by = match struct_top.get(idx) {
        Some((who, _)) => {
          let killer = self.champs[who]
          killer.gold += 120
          // Everyone on the team shares the experience: a structure is a team
          // objective, not a last hit.
          for c in self.champs {
            if c.team == killer.team {
              c.gain_xp(20)
            }
          }
          killer.name
        }
        None => "someone"
      }
      events.push(
        "\{by} destroyed the \{s.kind_name()} at \{node_name(s.node)}",
      )
    }
  }

  for entry in neutral_dmg {
    let (idx, d) = entry
    let n = self.neutrals[idx]
    if !n.alive() {
      continue
    }
    n.hp -= d
    if n.hp <= 0 {
      n.hp = 0
      n.spawn_in = n.respawn_ticks
      n.hp = n.max_hp
      match neutral_top.get(idx) {
        Some((who, _)) => {
          let team = self.champs[who].team
          for c in self.champs {
            if c.team == team {
              c.gold += if n.key == "baron" { 100 } else { 60 }
              c.gain_xp(if n.key == "baron" { 40 } else { 25 })
            }
          }
          if n.key == "baron" {
            self.baron[team] = BARON_TICKS
            events.push(
              "team \{team_name(team)} took BARON (+\{BARON_ATK_PCT}% attack, +\{BARON_STRUCT_PCT}% siege for \{BARON_TICKS} ticks)",
            )
          } else {
            self.dragons[team] += 1
            events.push(
              "team \{team_name(team)} took the dragon (stack \{self.dragons[team]})",
            )
          }
        }
        None => ()
      }
    }
  }

  // Towers punish anyone standing on them who has no minion wave to hide
  // behind, mitigated by armor — so a frontliner can dive where a marksman
  // would die, and neither can siege a tower without shoving the lane first.
  for s in self.structures {
    if !s.alive() {
      continue
    }
    for c in self.champs_at(s.node, enemy_of(s.team)) {
      if !self.tower_shoots(s, c) {
        continue
      }
      take_damage(c, TOWER_DAMAGE * 100 / (100 + c.armor()))
      if c.hp <= 0 {
        c.hp = 0
        c.deaths += 1
        c.respawn = RESPAWN_BASE + c.level
        c.shield = 0
        c.shield_ttl = 0
        c.stunned = 0
        events.push(
          "\{c.name} was killed by the \{s.kind_name()} at \{node_name(s.node)}",
        )
      }
    }
  }

  // Minion waves.
  //
  // Farming a lane SHOVES it: clearing the wave in front of you sends the next
  // one forward. That is why `Farm` is a strategic action here and not just a
  // gold trickle — it is how a champion earns the wave it needs to touch a
  // tower. Failing that, a lane drifts toward whoever has more bodies in it,
  // and a lane both teams have abandoned drifts back to even, because the two
  // waves simply meet in the middle.
  for li in 0..<3 {
    let lane = lanes[li]
    let mut a = 0
    let mut b = 0
    let mut shove_a = 0
    let mut shove_b = 0
    for c in self.champs {
      if !c.alive() || node_lane[c.node] != lane {
        continue
      }
      let shoving = c.can_act() && actions.get(c.id) is Some(Farm)
      if c.team == TEAM_A {
        a += 1
        if shoving {
          shove_a += 1
        }
      } else {
        b += 1
        if shoving {
          shove_b += 1
        }
      }
    }
    let delta = if shove_a != shove_b {
      shove_a - shove_b
    } else if a != b {
      if a > b {
        1
      } else {
        -1
      }
    } else {
      0
    }
    if delta > 0 {
      self.push[li] = @cmp.minimum(PUSH_CAP, self.push[li] + delta)
    } else if delta < 0 {
      self.push[li] = @cmp.maximum(-PUSH_CAP, self.push[li] + delta)
    } else if a == 0 && b == 0 {
      // Nobody is in the lane: the two waves meet in the middle and the lane
      // drifts back to even. A wave that has been shoved STAYS shoved while
      // somebody is standing there — otherwise a shove is undone the tick
      // after it is made and no lane can ever be held.
      if self.push[li] > 0 {
        self.push[li] -= 1
      } else if self.push[li] < 0 {
        self.push[li] += 1
      }
    }
    let pusher = if self.push[li] >= PUSH_TO_TOWER {
      TEAM_A
    } else if self.push[li] <= -PUSH_TO_TOWER {
      TEAM_B
    } else {
      0
    }
    if pusher != 0 {
      let front = self.minion_front(pusher, lane)
      if front >= 0 {
        match self.structure_at(front) {
          Some(s) =>
            if self.structure_attackable(s) {
              s.hp -= MINION_DAMAGE
              if s.hp <= 0 {
                s.hp = 0
                events.push(
                  "minions destroyed the \{s.kind_name()} at \{node_name(s.node)}",
                )
              }
            }
          None => ()
        }
      }
    }
  }

  // Being in a lane or a jungle earns experience and a gold trickle whatever
  // the champion spent its turn on: the minions die next to it either way.
  // Without this, a policy that never picks `Farm` would still be level 1 at
  // tick 60, no champion would ever out-scale a tower, and no game would end —
  // which is not a lesson about the policy, only about the model.
  for c in self.champs {
    if c.alive() && camp_gold(c.node) > 0 {
      c.gold += camp_gold(c.node) / 3
      c.gain_xp(camp_xp(c.node) / 2)
    }
  }

  // Healing at home, regeneration in the field, respawns, and everything that
  // counts down.
  for c in self.champs {
    if c.alive() {
      if c.node == base_of(c.team) {
        if c.hp < c.max_hp {
          c.hp = @cmp.minimum(c.max_hp, c.hp + HEAL_AT_BASE)
        }
        // Restocking wards is free at base, as buying them is.
        if c.wards < WARD_CHARGES {
          c.wards += 1
        }
      } else if c.hp < c.max_hp &&
        self.champs_at(c.node, enemy_of(c.team)).is_empty() {
        // Out of combat: a lost trade costs position, not the rest of the game.
        c.hp = @cmp.minimum(c.max_hp, c.hp + c.max_hp * REGEN_PCT / 100)
      }
      if c.stunned > 0 && pre_stunned[c.id] {
        c.stunned -= 1
      }
      if c.shield_ttl > 0 {
        c.shield_ttl -= 1
        if c.shield_ttl == 0 {
          c.shield = 0
        }
      }
    } else {
      c.respawn -= 1
      if c.respawn == 0 {
        c.hp = c.max_hp
        c.node = base_of(c.team)
        c.wards = WARD_CHARGES
      }
    }
    if c.cd > 0 {
      c.cd -= 1
    }
  }
  for t in [TEAM_A, TEAM_B] {
    if self.baron[t] > 0 {
      self.baron[t] -= 1
    }
  }
  for n in self.neutrals {
    if n.spawn_in > 0 {
      n.spawn_in -= 1
      if n.spawn_in == 0 {
        events.push("\{n.key} has spawned at \{node_name(n.node)}")
      }
    }
  }
  let live_wards : Array[Ward] = []
  for w in self.wards {
    w.ttl -= 1
    if w.ttl > 0 {
      live_wards.push(w)
    }
  }
  self.wards.clear()
  for w in live_wards {
    self.wards.push(w)
  }

  for s in self.structures {
    if s.is_nexus() && !s.alive() {
      self.winner = enemy_of(s.team)
    }
  }
  if events.length() > 0 {
    self.log.push("t\{self.tick}: " + events.join("; "))
  }
}

///|
/// The ally on this node most in need of a heal or a shield — the lowest
/// fraction of health, the caster included. `None` when everyone is full, so a
/// support does not waste a cooldown on nobody.
pub fn Game::neediest_ally(self : Game, c : Champ) -> Champ? {
  let mut pick : Champ? = None
  let mut best = 100
  for a in self.champs_at(c.node, c.team) {
    let pct = a.hp * 100 / a.max_hp
    if pct < 100 && pct < best {
      best = pct
      pick = Some(a)
    }
  }
  pick
}

///|
pub fn team_name(team : Int) -> String {
  if team == TEAM_A {
    "A"
  } else {
    "B"
  }
}

///|
/// Why the game ended, for the closing message.
pub fn Game::over_reason(self : Game) -> String {
  if self.log.length() > 0 {
    self.log[self.log.length() - 1]
  } else {
    "tick cap"
  }
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
    let extra = []
    if c.items.length() > 0 {
      extra.push(c.items.join("+"))
    }
    if c.shield > 0 {
      extra.push("shield \{c.shield}")
    }
    if c.stunned > 0 {
      extra.push("STUNNED \{c.stunned}")
    }
    if c.cd > 0 {
      extra.push("cd \{c.cd}")
    }
    let tail = if extra.length() > 0 {
      "  [" + extra.join(", ") + "]"
    } else {
      ""
    }
    lines.push(
      "  \{c.name} (\{c.kind}) L\{c.level} hp=\{c.hp}/\{c.max_hp} at \{where_} g=\{c.gold} k/d/a=\{c.kills}/\{c.deaths}/\{c.assists}\{tail}",
    )
  }
  let structs = []
  for s in self.structures {
    if s.alive() {
      structs.push("\{node_name(s.node)}=\{s.hp}")
    }
  }
  lines.push("  standing: " + structs.join(" "))
  let pushes = []
  for li in 0..<3 {
    pushes.push(
      "\{lanes[li]}\{if self.push[li] >= 0 { "+" } else { "" }}\{self.push[li]}",
    )
  }
  lines.push(
    "  push: " +
    pushes.join(" ") +
    "   dragons A=\{self.dragons[TEAM_A]} B=\{self.dragons[TEAM_B]}   baron A=\{self.baron[TEAM_A]} B=\{self.baron[TEAM_B]}",
  )
  lines.join("\n")
}
