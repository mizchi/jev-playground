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
/// - **Neutral objectives.** The drake stacks permanently, in one of four
///   elements, and the fourth one a team takes gives it the rift's soul; Baron
///   is a short, large swing. Both sit off-lane, so taking one costs lane
///   presence, and the soul is what makes that cost worth paying twice.
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
/// Gold for one minion taken with a last hit, and the experience with it.
///
/// `Farm` used to pay a flat camp whether or not there was anything in the
/// lane to kill, which made it a faucet rather than a skill: a policy could
/// not be wrong about farming, only about where it stood. Paying per minion
/// taken puts the genre's first decision back — **the wave is worth gold only
/// to whoever lands the killing blow, and a minion your own wave finishes is
/// gold nobody gets.**
pub const CS_GOLD = 6

///|
pub const CS_XP = 7

///|
/// How many minions a lane holds ripe at once. One comes low each tick, so the
/// cap is how long the lane will wait for you: past it the wave has moved on.
pub const CS_RIPE_CAP = 3

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
pub const HERALD_HP = 170

///|
/// Herald's charge: a large bonus to structure damage, for a short while, and
/// nothing else. It is worth more than Baron's siege bonus and lasts less
/// long, which is what makes it a tool for taking one tower rather than a
/// window for closing a game.
pub const HERALD_STRUCT_PCT = 60

///|
pub const HERALD_TICKS = 16

///|
/// The tick Herald leaves the map. Baron takes its pit, so the two are never
/// up at once and the top river's question changes rather than doubling.
pub const HERALD_GONE_TICK = 70

///|
/// A jungle camp's bounty, and how long it takes to come back.
///
/// Sized against a lane: two own camps on a six-tick round trip pay about ten
/// gold a tick, which is what a laner earns last-hitting. The respawn is
/// slightly LONGER than that round trip on purpose — a jungler that cycles
/// perfectly arrives early sometimes, and then has to decide whether to wait,
/// walk into the enemy's half, or go and help a lane. A respawn shorter than
/// the trip would answer that question permanently.
pub const CAMP_GOLD = 30

///|
pub const CAMP_XP = 22

///|
pub const CAMP_RESPAWN = 8

///|
/// Plating. An outer tower's health is divided into this many plates; a
/// champion that takes one off is paid for it whether or not the tower falls,
/// which is what makes chipping a tower worth a tick of somebody's time.
///
/// Minions do not break plates. A lane that shoves itself into a tower would
/// otherwise pay a team for standing somewhere else, and "go and hit it
/// yourself" is the decision the plate is there to create.
pub const PLATES = 5

///|
pub const PLATE_GOLD = 28

///|
/// When the plating falls off. After this the tower is just a tower, so the
/// early game has a window in it that the late game does not.
pub const PLATE_TICKS = 40

///|
/// How long an inner tower stays down before it comes back.
///
/// The inner tower plays the inhibitor's part here: it is the gate to the
/// nexus, breaking it opens the lane, and it returns on a timer so the lane
/// closes again. The base is one node on this map, so an inhibitor of its own
/// would have to share that node with the nexus and `Game::structure_at`
/// would have to guess which of the two "the structure here" meant.
pub const INHIB_TICKS = 22

///|
/// Extra pressure per tick, in the breaker's favour, in a lane whose inner
/// tower is down. These are the super minions: the lane pushes itself while
/// the gate is open, so the defender has to answer it and the window costs
/// them something even if nothing else happens in it.
pub const SUPER_PUSH = 1

///|
/// The four drake elements, in the order `drake_index` numbers them.
pub let drake_kinds : Array[String] = ["infernal", "mountain", "ocean", "cloud"]

///|
/// What one stack of each element is worth, permanently and team-wide.
///
/// Each element moves a different one of the engine's four levers — damage
/// dealt, damage taken, health regained, ability uptime — so "which drake is
/// this one" is a question with a different answer in different states rather
/// than a reskin of the same +7%. The numbers are deliberately close in
/// expected value at one stack; what separates them is *when* each one pays.
pub const DRAKE_INFERNAL_PCT = 7

///|
/// Mountain is a reduction in damage taken rather than a bonus to `armor` and
/// `mr`. Those are per-champion numbers read in seventeen places, including
/// the stat lines the observation hands a policy, and a team-wide resist that
/// three of those places forgot would be an asymmetry nobody could see from
/// watching a game. A divisor at the one point damage is computed cannot be
/// forgotten.
pub const DRAKE_MOUNTAIN_PCT = 6

///|
/// Ocean adds to out-of-combat regeneration, so it pays for a team that trades
/// and resets rather than one that commits.
pub const DRAKE_OCEAN_PCT = 4

///|
/// Cloud is ability haste: a percentage off the cooldown, rounded. It is worth
/// more to a long cooldown than a short one, which is true of haste in the
/// games this is modelled on and is also why one stack can be worth nothing to
/// a four-tick ability — `Game::ability_cd` states that plainly.
pub const DRAKE_CLOUD_PCT = 12

///|
/// Drakes needed for the soul. Four, as in the game this is modelled on, and
/// the whole reason the third and fourth drake are worth a teamfight.
pub const SOUL_STACKS = 4

///|
/// The soul, on top of whatever the stacks already give. Each one is a larger
/// version of its element's lever except mountain and ocean, which change kind
/// rather than degree: mountain's soul is a shield that comes back, and
/// ocean's soul heals during a fight instead of only after it.
pub const SOUL_INFERNAL_PCT = 15

///|
pub const SOUL_MOUNTAIN_SHIELD = 24

///|
pub const SOUL_OCEAN_PCT = 8

///|
pub const SOUL_CLOUD_PCT = 30

///|
/// The Baron buff: a large attack bonus and faster sieging, for a short window.
pub const BARON_ATK_PCT = 25

///|
pub const BARON_STRUCT_PCT = 40

///|
pub const BARON_TICKS = 12

///|
/// The two kinds of ward. A stealth ward is the one a champion carries; a
/// control ward is bought with gold and **takes vision away**, which is the
/// half of the vision game that a map with only one ward kind cannot have.
pub const WARD_STEALTH = 0

///|
pub const WARD_CONTROL = 1

///|
/// What a control ward costs, how long it lasts, and the rule that makes it
/// worth the gold: an enemy ward on its node or a neighbour is destroyed when
/// it goes down, and an enemy STEALTH ward placed there afterwards is
/// destroyed at the end of that tick. It cannot be restocked at base, so it
/// competes with the shop — which is what makes it a decision rather than a
/// second free charge.
pub const CONTROL_COST = 75

///|
pub const CONTROL_TTL = 24

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
  /// Attack gained per level, in percent of `base_attack` — the archetype's,
  /// so two champions with the same base attack can still be on opposite
  /// sides of the level curve.
  growth : Int
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
  /// Jungle camps this champion has taken, its own side's and the enemy's.
  mut camps : Int
  /// Minions taken with a last hit. Gold follows from it, so this is the laning
  /// phase's score and what the `cs` class is marked against.
  mut cs : Int
  /// Minions this champion let its own wave finish — the price of every tick it
  /// spent on something else, counted rather than inferred.
  mut cs_lost : Int
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

// --------------------------------------------------------------- the counter
//
// Buying is one rule in three places — the legal move, the description of it,
// and the tick that resolves it — plus a fourth, the oracle that prices the
// `item` class by buying each item on a copy. Components made those four
// disagreeable, so the arithmetic lives here and all four call it.

///|
/// How many of `key` this champion is holding.
pub fn Champ::count_of(self : Champ, key : String) -> Int {
  let mut n = 0
  for held in self.items {
    if held == key {
      n += 1
    }
  }
  n
}

///|
/// What this champion would pay for `key` right now: the combine cost, plus
/// the full price of every component it does not already hold. Holding a
/// component is the discount, which is the whole of what a build path is.
pub fn Champ::price_of(self : Champ, key : String) -> Int {
  match item_of(key) {
    Some(it) => {
      let mut price = it.cost
      let used : Map[String, Int] = Map([])
      for comp in it.builds_from {
        let already = used.get(comp).unwrap_or(0)
        // Each component in the recipe is matched against a *different* copy
        // of it in the inventory: `edge` needs two swords, and one sword in
        // the bag pays for one of them.
        if self.count_of(comp) > already {
          used[comp] = already + 1
        } else {
          price += item_total_cost(comp)
        }
      }
      price
    }
    None => 0
  }
}

///|
/// Item slots this champion would be using after buying `key`: the components
/// the purchase consumes come back out of the bag, so upgrading a component is
/// slot-neutral and a champion with full slots can still combine.
pub fn Champ::slots_after(self : Champ, key : String) -> Int {
  match item_of(key) {
    Some(it) => {
      let mut freed = 0
      let used : Map[String, Int] = Map([])
      for comp in it.builds_from {
        let already = used.get(comp).unwrap_or(0)
        if self.count_of(comp) > already {
          used[comp] = already + 1
          freed += 1
        }
      }
      self.items.length() - freed + 1
    }
    None => self.items.length()
  }
}

///|
/// Whether this champion could buy `key` if it were standing at base.
pub fn Champ::can_buy(self : Champ, key : String) -> Bool {
  match item_of(key) {
    Some(_) =>
      self.gold >= self.price_of(key) && self.slots_after(key) <= ITEM_SLOTS
    None => false
  }
}

///|
/// Take the gold, consume the components, hand over the item. Assumes
/// `can_buy`; the callers check it.
pub fn Champ::apply_buy(self : Champ, key : String) -> Unit {
  match item_of(key) {
    Some(it) => {
      self.gold -= self.price_of(key)
      for comp in it.builds_from {
        // Remove one copy, not every copy: two swords in the bag and a recipe
        // wanting one leaves a sword behind.
        for i in 0..<self.items.length() {
          if self.items[i] == comp {
            self.items.remove(i) |> ignore
            break
          }
        }
      }
      self.items.push(key)
      self.refresh_hp()
    }
    None => ()
  }
}

///|
/// Attack after level scaling and items, before team buffs and mitigation.
/// Buffs are team state, so the full number comes from `Game::raw_attack`.
pub fn Champ::attack(self : Champ) -> Int {
  let scaled = self.base_attack * (100 + self.growth * (self.level - 1)) / 100
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
    growth: self.growth,
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
    camps: self.camps,
    cs: self.cs,
    cs_lost: self.cs_lost,
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
  /// Plates left on an outer tower: gold for whoever takes one off, and gone
  /// at `PLATE_TICKS` whether anybody took them or not. 0 on everything else.
  mut plates : Int
  /// Ticks until an inner tower comes back, or 0. Only an inner tower
  /// respawns — see `INHIB_TICKS`.
  mut respawn_in : Int
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
    plates: self.plates,
    respawn_in: self.respawn_in,
  }
}

///|
/// How many plates this structure's remaining health corresponds to. Plates
/// come off from the top, so a tower at four fifths of its health has four
/// left and the fifth has been paid for.
pub fn Structure::plates_for_hp(self : Structure) -> Int {
  if self.plates == 0 || self.max_hp <= 0 {
    return 0
  }
  let want = (self.hp * PLATES + self.max_hp - 1) / self.max_hp
  if want > self.plates {
    self.plates
  } else if want < 0 {
    0
  } else {
    want
  }
}

///|
/// Whether this structure is an inner tower waiting to come back — the state
/// in which its lane is open and the clock is running.
pub fn Structure::is_down_temporarily(self : Structure) -> Bool {
  self.respawn_in > 0
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
/// A jungle camp: a bounty that is taken whole and then has to come back.
///
/// It used to be a per-tick trickle keyed off the node, which meant a jungler
/// could stand on one node and print gold for the whole game, and meant that
/// "taking a camp" removed nothing from anybody. A camp with an owner and a
/// timer is what the two decisions the jungle is supposed to create need:
/// **where to be when it comes back**, and **whether to take theirs**.
pub struct Camp {
  node : Int
  /// Whose half of the jungle it sits in. Taking one on the enemy's side is
  /// counter-jungling.
  side : Int
  /// Ticks until it comes back, or 0 while it is up.
  mut down_for : Int
}

///|
pub fn Camp::up(self : Camp) -> Bool {
  self.down_for == 0
}

///|
pub fn Camp::copy(self : Camp) -> Camp {
  { node: self.node, side: self.side, down_for: self.down_for, }
}

///|
/// The default rotation: an infernal drake first, then an ocean rift. Two
/// entries is all the rule needs, because every drake after the second has the
/// rift's element — so the first entry is the opening drake and the second is
/// the rift, and therefore the soul.
///
/// `Game::with_drakes` takes another rotation, which is how the benchmark and
/// the arena reach the other three souls.
pub fn default_drake_rotation() -> Array[String] {
  ["infernal", "ocean"]
}

///|
/// Where team `team`'s stacks of `element` live in `Game::drakes`. -1 for an
/// element that is not one of the four.
pub fn drake_index(team : Int, element : String) -> Int {
  let ei = drake_kind_index(element)
  if ei < 0 || team < 0 || team > 2 {
    return -1
  }
  team * drake_kinds.length() + ei
}

///|
pub fn drake_kind_index(element : String) -> Int {
  for i in 0..<drake_kinds.length() {
    if drake_kinds[i] == element {
      return i
    }
  }
  -1
}

///|
/// A placed ward: vision of a node and its neighbours, for a while.
pub struct Ward {
  node : Int
  team : Int
  kind : Int
  mut ttl : Int
}

///|
pub fn Ward::copy(self : Ward) -> Ward {
  { node: self.node, team: self.team, kind: self.kind, ttl: self.ttl, }
}

///|
/// Whether this ward's sweep reaches `node`: its own node or a neighbour. Only
/// a control ward has one.
pub fn Ward::sweeps(self : Ward, node : Int) -> Bool {
  if self.kind != WARD_CONTROL {
    return false
  }
  self.node == node || adjacency[self.node].contains(node)
}

// ----------------------------------------------------------------- the game

///|
pub struct Game {
  champs : Array[Champ]
  structures : Array[Structure]
  neutrals : Array[Neutral]
  /// The four jungle camps, one per jungle node.
  camps : Array[Camp]
  wards : Array[Ward]
  /// Minion pressure per lane, indexed as `lanes`. Positive means team A's
  /// wave is ahead in that lane.
  push : Array[Int]
  /// Minions ripe for a last hit, indexed by `ripe_index(lane, team)`. One
  /// comes low in each lane each tick and the lane holds at most
  /// `CS_RIPE_CAP`; whatever is ripe at the start of a tick and is not taken
  /// during it is finished by its own side's wave and paid to nobody.
  ripe : Array[Int]
  /// The element of the first drake, then the element of every drake after
  /// it. Indexed by drakes already slain and clamped to the last entry: the
  /// rift takes the second drake's element and keeps it, as it does in the
  /// game this is modelled on, so the soul at stake is knowable in advance and
  /// both teams can plan around it. Deciding the elements at construction
  /// rather than drawing them keeps the simulator deterministic, which is what
  /// lets it be the benchmark's oracle.
  drake_rotation : Array[String]
  /// Permanent drake stacks, indexed by `drake_index(team, element)`.
  drakes : Array[Int]
  /// The team holding the soul, or 0 while it is still on the table. Only the
  /// first team to `SOUL_STACKS` gets one.
  mut soul_team : Int
  /// Ticks of Baron buff left, indexed by team id.
  baron : Array[Int]
  /// Ticks of Herald charge left, indexed by team id. Structures only.
  herald : Array[Int]
  /// Camps on this team's own side that the ENEMY took, indexed by team id.
  /// The price of a counter-jungle, counted where the team that paid it can
  /// read it.
  camps_lost : Array[Int]
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
      growth: k.growth,
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
      camps: 0,
      cs: 0,
      cs_lost: 0,
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
      plates: PLATES,
      respawn_in: 0,
    })
    structures.push({
      node: a_inner[li],
      team: TEAM_A,
      lane,
      tier: 2,
      hp: 160,
      max_hp: 160,
      plates: 0,
      respawn_in: 0,
    })
    structures.push({
      node: b_outer[li],
      team: TEAM_B,
      lane,
      tier: 1,
      hp: 130,
      max_hp: 130,
      plates: PLATES,
      respawn_in: 0,
    })
    structures.push({
      node: b_inner[li],
      team: TEAM_B,
      lane,
      tier: 2,
      hp: 160,
      max_hp: 160,
      plates: 0,
      respawn_in: 0,
    })
  }
  structures.push({
    node: A_BASE,
    team: TEAM_A,
    lane: "base",
    tier: 3,
    hp: 260,
    max_hp: 260,
    plates: 0,
    respawn_in: 0,
  })
  structures.push({
    node: B_BASE,
    team: TEAM_B,
    lane: "base",
    tier: 3,
    hp: 260,
    max_hp: 260,
    plates: 0,
    respawn_in: 0,
  })
  let neutrals : Array[Neutral] = [
    // The drake is up early and often: a small permanent stack, repeatedly
    // contested, four of them for a soul. Baron arrives late and once: a
    // short, decisive window.
    //
    // Baron used to spawn at 24 of a game that runs about 128 ticks, and
    // because it is worth more than any single drake the plan went to the top
    // river at tick 24 and never came back. The drake's whole cadence lived in
    // the first fifth of the game and no team ever reached a second stack.
    // Baron now arrives once the soul is roughly decided, which is the order
    // these two objectives come in in the game they are modelled on.
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
      spawn_in: 70,
      respawn_ticks: 30,
    },
    // Herald holds Baron's pit until Baron wants it. It is the top river's
    // early question, and because its reward is siege damage while the towers
    // are still plated, taking it is how a team converts a river fight into a
    // lane. It leaves at `HERALD_GONE_TICK` and does not come back.
    // One per game, as there is in the game this is modelled on: a respawn it
    // can never finish is how `Neutral` says "this does not come back"
    // without a field that only one monster would use.
    {
      node: RIV_TOP,
      key: "herald",
      hp: HERALD_HP,
      max_hp: HERALD_HP,
      spawn_in: 14,
      respawn_ticks: 1 << 24,
    },
  ]
  let camps : Array[Camp] = []
  for n in 0..<N_NODES {
    let side = camp_side(n)
    if side != 0 {
      camps.push({ node: n, side, down_for: 0, })
    }
  }
  {
    champs,
    structures,
    neutrals,
    camps,
    wards: [],
    push: [0, 0, 0],
    ripe: Array::make(lanes.length() * 3, 0),
    drake_rotation: default_drake_rotation(),
    drakes: Array::make(3 * drake_kinds.length(), 0),
    soul_team: 0,
    baron: [0, 0, 0],
    herald: [0, 0, 0],
    camps_lost: [0, 0, 0],
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
  let camps = []
  for c in self.camps {
    camps.push(c.copy())
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
    camps,
    wards,
    push: [self.push[0], self.push[1], self.push[2]],
    ripe: {
      let r = Array::make(self.ripe.length(), 0)
      for i in 0..<self.ripe.length() {
        r[i] = self.ripe[i]
      }
      r
    },
    drake_rotation: {
      let r = []
      for e in self.drake_rotation {
        r.push(e)
      }
      r
    },
    drakes: {
      let d = Array::make(self.drakes.length(), 0)
      for i in 0..<self.drakes.length() {
        d[i] = self.drakes[i]
      }
      d
    },
    soul_team: self.soul_team,
    baron: [0, self.baron[1], self.baron[2]],
    herald: [0, self.herald[1], self.herald[2]],
    camps_lost: [0, self.camps_lost[1], self.camps_lost[2]],
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
/// The monster with this key, alive or not. Named lookups, so nothing has to
/// remember that Baron is `neutrals[1]` — which stopped being obvious the
/// moment there were three of them.
pub fn Game::neutral_named(self : Game, key : String) -> Neutral? {
  for n in self.neutrals {
    if n.key == key {
      return Some(n)
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

// -------------------------------------------------------------------- jungle

///|
/// The camp at `node`, up or down, or None for a node that has none.
pub fn Game::camp_at(self : Game, node : Int) -> Camp? {
  for c in self.camps {
    if c.node == node {
      return Some(c)
    }
  }
  None
}

///|
/// Camps on `team`'s side of the jungle that are standing right now.
pub fn Game::camps_up(self : Game, team : Int) -> Array[Camp] {
  let out = []
  for c in self.camps {
    if c.side == team && c.up() {
      out.push(c)
    }
  }
  out
}

///|
/// The camp `team` should walk to: one that is up, nearest to `from`, ours
/// before theirs.
///
/// Ours first because theirs costs a walk through unlit brush next to their
/// lanes. That is a preference and not a rule — `counter_jungle_worth` is
/// where the other half of the decision lives.
pub fn Game::next_camp(self : Game, team : Int, from : Int) -> Int {
  let mut best = -1
  let mut best_key = 1 << 28
  for c in self.camps {
    if !c.up() {
      continue
    }
    let theirs = if c.side == team { 0 } else { 1 }
    let key = theirs * 100 + hops(from, c.node)
    if key < best_key {
      best_key = key
      best = c.node
    }
  }
  best
}

///|
/// Whether crossing into the enemy's half is the better use of the next few
/// ticks: none of ours is up, at least one of theirs is, and we can get there.
///
/// The denial is the point and it is not in this function — it is in the
/// enemy's gold, which `position_score` already counts. A camp we take is a
/// camp they do not, for `CAMP_RESPAWN` ticks.
pub fn Game::counter_jungle_worth(self : Game, team : Int, from : Int) -> Bool {
  if !self.camps_up(team).is_empty() {
    return false
  }
  for c in self.camps {
    if c.side != team && c.up() && hops(from, c.node) <= 3 {
      return true
    }
  }
  false
}

// ------------------------------------------------------------------- drakes

///|
/// How many stacks of `element` `team` holds.
pub fn Game::drakes_of(self : Game, team : Int, element : String) -> Int {
  let i = drake_index(team, element)
  if i < 0 {
    0
  } else {
    self.drakes[i]
  }
}

///|
/// Drakes of any element held by `team` — the number the soul counts.
pub fn Game::drake_total(self : Game, team : Int) -> Int {
  let mut n = 0
  for element in drake_kinds {
    n += self.drakes_of(team, element)
  }
  n
}

///|
/// Drakes slain this game by either team, which is what the rotation advances
/// on. A drake is a drake whoever took it: the rift transforms on the second
/// one regardless of who killed it.
pub fn Game::drakes_slain(self : Game) -> Int {
  self.drake_total(TEAM_A) + self.drake_total(TEAM_B)
}

///|
/// The element of the drake in the pit now — or of the next one, while the pit
/// is empty. Both teams can read it, which is the point: an objective whose
/// reward is a guess is not an objective a policy can plan around.
pub fn Game::drake_now(self : Game) -> String {
  let i = self.drakes_slain()
  if i >= self.drake_rotation.length() {
    self.drake_rotation[self.drake_rotation.length() - 1]
  } else {
    self.drake_rotation[i]
  }
}

///|
/// The rift's element, and so the soul on the table for whichever team reaches
/// `SOUL_STACKS` first. It is the second drake's element.
pub fn Game::rift_element(self : Game) -> String {
  if self.drake_rotation.length() < 2 {
    self.drake_rotation[0]
  } else {
    self.drake_rotation[1]
  }
}

///|
/// The soul `team` holds, or "" if it holds none. A team can hold exactly one,
/// and only one team can hold any.
pub fn Game::soul_of(self : Game, team : Int) -> String {
  if self.soul_team == team {
    self.rift_element()
  } else {
    ""
  }
}

///|
/// What one stack of `element` does, in words. One function, because the
/// observation, the `AttackNeutral` description and the benchmark's prompts all
/// have to describe the same rule, and three copies of a sentence is three
/// chances for one of them to describe a rule the game does not have.
pub fn drake_reward(element : String) -> String {
  match element {
    "infernal" =>
      "+\{DRAKE_INFERNAL_PCT}% damage dealt, permanently, whole team"
    "mountain" =>
      "-\{DRAKE_MOUNTAIN_PCT}% damage taken, permanently, whole team"
    "ocean" =>
      "+\{DRAKE_OCEAN_PCT} points of out-of-combat health regeneration per tick, permanently, whole team"
    "cloud" =>
      "\{DRAKE_CLOUD_PCT}% ability haste, permanently, whole team — worth a tick only on the longer cooldowns"
    _ => "nothing"
  }
}

///|
/// What the soul of `element` does, on top of the stacks.
pub fn soul_reward(element : String) -> String {
  match element {
    "infernal" => "a further +\{SOUL_INFERNAL_PCT}% damage dealt"
    "mountain" =>
      "a \{SOUL_MOUNTAIN_SHIELD}-point shield that refills whenever no enemy is on the node, so every fight starts with it"
    "ocean" =>
      "+\{SOUL_OCEAN_PCT} points of regeneration per tick that keep working WITH an enemy on the node, which nothing else in the game does"
    "cloud" => "a further \{SOUL_CLOUD_PCT}% ability haste"
    _ => "nothing"
  }
}

///|
/// A team's stacks as one readable string — `2 infernal + 1 ocean + SOUL`, or
/// `none`. For the state dump, the observation and the action descriptions,
/// which all have to say the same thing about the same state.
pub fn Game::drake_summary(self : Game, team : Int) -> String {
  let parts = []
  for element in drake_kinds {
    let n = self.drakes_of(team, element)
    if n > 0 {
      parts.push("\{n} \{element}")
    }
  }
  let soul = self.soul_of(team)
  if soul != "" {
    parts.push("\{soul} SOUL")
  }
  if parts.is_empty() {
    "none"
  } else {
    parts.join(" + ")
  }
}

///|
/// Drakes this team still needs for the soul, or 0 once the soul is decided.
pub fn Game::drakes_to_soul(self : Game, team : Int) -> Int {
  if self.soul_team != 0 {
    return 0
  }
  let left = SOUL_STACKS - self.drake_total(team)
  if left < 0 {
    0
  } else {
    left
  }
}

///|
/// A drake neither team can afford to trade away: one more and somebody has
/// the soul. Below that a free tower really is worth more than one stack, and
/// the plan is right to take the tower — this is the state in which it is not.
pub fn Game::soul_point(self : Game) -> Bool {
  if self.soul_team != 0 {
    return false
  }
  self.drakes_to_soul(TEAM_A) <= 1 || self.drakes_to_soul(TEAM_B) <= 1
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
/// How many minions `team` could last-hit at `node` this tick. 0 off-lane.
///
/// The number a laning decision turns on, so it is one call rather than an
/// index computation repeated at every site that needs it.
pub fn Game::ripe_here(self : Game, node : Int, team : Int) -> Int {
  let ri = ripe_index(node_lane[node], team)
  if ri < 0 {
    0
  } else {
    self.ripe[ri]
  }
}

///|
/// Where a lane's ripe-minion count for a team lives in `ripe`.
///
/// Per lane AND per team, because a last hit is taken from the enemy's wave:
/// the two sides of a lane have separate minions to kill and separate gold to
/// lose, which is why a lane can be held by one side and farmed by both.
pub fn ripe_index(lane : String, team : Int) -> Int {
  let li = lane_index(lane)
  if li < 0 {
    return -1
  }
  li * 3 + team
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
/// Set the drake rotation: the opening drake's element and then the rift's.
///
/// An empty or unrecognised rotation is refused in favour of the default,
/// because a rotation of elements that do not exist would make every drake
/// worth nothing and the game would still run.
pub fn Game::with_drakes(self : Game, rotation : Array[String]) -> Unit {
  for element in rotation {
    if drake_kind_index(element) < 0 {
      return
    }
  }
  if rotation.is_empty() {
    return
  }
  self.drake_rotation.clear()
  for element in rotation {
    self.drake_rotation.push(element)
  }
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
/// Put every champion at `level`, health and stats to match.
///
/// The arena needed this the moment growth became per-archetype: a round robin
/// fought at level 1 cannot see a lever that only acts above level 1, so it was
/// reporting that the timing axis did nothing when it was simply out of frame.
pub fn Game::level_all(self : Game, level : Int) -> Unit {
  let want = if level < 1 {
    1
  } else if level > MAX_LEVEL {
    MAX_LEVEL
  } else {
    level
  }
  for c in self.champs {
    c.xp = (want - 1) * LEVEL_XP
    c.level = want
    c.refresh_hp()
    c.hp = c.max_hp
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
///
/// Items are counted at what they cost, which stopped being one number when
/// the shop grew tiers: an inventory of three components and one of three
/// completed items are the same length and not the same lead.
pub fn Game::team_gold(self : Game, team : Int) -> Int {
  let mut total = 0
  for c in self.champs {
    if c.team == team {
      total += c.gold
      for key in c.items {
        total += item_total_cost(key)
      }
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
  // Standing on a node always reveals it, brush included — that is what
  // walking in buys. Reaching a NEIGHBOUR reveals it only if it is not brush:
  // vision does not cross into cover, which is the whole of the rule and the
  // reason a ward in a brush is worth a turn.
  for c in self.champs {
    if c.team == team && c.alive() {
      seen[c.node] = true
      for n in adjacency[c.node] {
        if !is_brush(n) {
          seen[n] = true
        }
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
      // A ward sees the node it sits in whatever that node is — a ward in a
      // brush is the counter-play to the brush — and its neighbours under the
      // same rule as a champion's.
      seen[w.node] = true
      for n in adjacency[w.node] {
        if !is_brush(n) {
          seen[n] = true
        }
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
/// Whether the enemy has a live ward watching `node` — on it, or next to it.
///
/// What a control ward is for. `has_ward` answers the additive question ("do
/// we already see this"); this one answers the subtractive one, and a map
/// with one ward kind had no way to ask it.
pub fn Game::enemy_ward_near(self : Game, team : Int, node : Int) -> Bool {
  for w in self.wards {
    if w.team != team &&
      w.ttl > 0 &&
      (w.node == node || adjacency[node].contains(w.node)) {
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
/// The team-wide damage multiplier from objectives, in percent. Infernal
/// stacks are permanent and small, the infernal soul is permanent and large,
/// and the Baron buff is large but runs out. All three apply to basic attacks
/// and to ability power, so an objective is worth the same to every
/// composition rather than only to the ones that auto-attack.
///
/// The other three elements do not appear here. Only infernal is damage dealt;
/// mountain is damage taken, ocean is health regained and cloud is ability
/// uptime, and each of those is applied where it belongs.
pub fn Game::buff_pct(self : Game, team : Int) -> Int {
  let mut pct = 100 + DRAKE_INFERNAL_PCT * self.drakes_of(team, "infernal")
  if self.soul_of(team) == "infernal" {
    pct += SOUL_INFERNAL_PCT
  }
  if self.baron[team] > 0 {
    pct += BARON_ATK_PCT
  }
  pct
}

///|
/// How much of the damage aimed at `team` actually lands, as a percent of 100
/// or more: the mountain divisor. 100 means no mountain stacks.
pub fn Game::tough_pct(self : Game, team : Int) -> Int {
  100 + DRAKE_MOUNTAIN_PCT * self.drakes_of(team, "mountain")
}

///|
/// `raw` after the target team's mountain stacks, never below 1 so a fight
/// cannot stall forever — the same floor every other damage path uses.
pub fn Game::mitigate(self : Game, raw : Int, team : Int) -> Int {
  let d = raw * 100 / self.tough_pct(team)
  if d < 1 {
    1
  } else {
    d
  }
}

///|
/// What a tower takes off this champion per tick: the flat shot, its armor,
/// and its team's mountain stacks.
///
/// This arithmetic used to be written out at each of the four places that
/// needed it — the tick, the dive oracle, the action description and the
/// benchmark's prompt. Mountain had to reach all four or the description would
/// have told a policy a number the game then did not use, so it is one
/// function now.
pub fn Game::tower_damage_to(self : Game, c : Champ) -> Int {
  self.mitigate(TOWER_DAMAGE * 100 / (100 + c.armor()), c.team)
}

///|
/// Health regained per tick out of combat, as a percent of maximum: the base
/// plus ocean stacks. The ocean *soul* is not here, because it is the one
/// element whose soul changes kind rather than degree — see `Game::in_combat_regen_pct`.
pub fn Game::regen_pct(self : Game, team : Int) -> Int {
  REGEN_PCT + DRAKE_OCEAN_PCT * self.drakes_of(team, "ocean")
}

///|
/// Health regained per tick *with an enemy standing on the node*, which is
/// nothing at all unless the team holds the ocean soul. Sustain during a fight
/// rather than after it is what makes that soul worth racing for.
pub fn Game::in_combat_regen_pct(self : Game, team : Int) -> Int {
  if self.soul_of(team) == "ocean" {
    SOUL_OCEAN_PCT
  } else {
    0
  }
}

///|
/// This champion's ability cooldown after cloud haste, at least 1.
///
/// Rounded rather than truncated, and the rounding is the honest part: a
/// four-tick ability with one cloud stack comes to 4.07 ticks and so is
/// unchanged, while a six-tick ability comes to 5.85 and drops a tick. Haste
/// is worth more to a long cooldown than a short one here, as it is in the
/// games this is modelled on.
pub fn Game::ability_cd(self : Game, c : Champ) -> Int {
  let mut haste = DRAKE_CLOUD_PCT * self.drakes_of(c.team, "cloud")
  if self.soul_of(c.team) == "cloud" {
    haste += SOUL_CLOUD_PCT
  }
  if haste == 0 {
    return c.cooldown
  }
  let v = (c.cooldown * 100 + (100 + haste) / 2) / (100 + haste)
  if v < 1 {
    1
  } else {
    v
  }
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
/// Damage `c` lands on `target`: the resist calculation, then the target
/// team's mountain stacks.
pub fn Game::damage_to_champ(self : Game, c : Champ, target : Champ) -> Int {
  self.mitigate(self.damage_to(c, target.armor(), target.mr()), target.team)
}

///|
/// Damage a structure takes from `c`, including both siege bonuses.
///
/// Baron and Herald stack, although they cannot in practice: Herald is off the
/// map before Baron arrives, so the sum is written out rather than guarded
/// with a rule the timers already enforce.
pub fn Game::damage_to_structure(self : Game, c : Champ) -> Int {
  let mut pct = 100
  if self.baron[c.team] > 0 {
    pct += BARON_STRUCT_PCT
  }
  if self.herald[c.team] > 0 {
    pct += HERALD_STRUCT_PCT
  }
  self.damage_to(c, STRUCT_ARMOR, STRUCT_MR) * pct / 100
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
  self.mitigate(scaled * 100 / (100 + resist), target.team)
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
  // What was ripe before anybody acted. A minion that was already low when the
  // tick began and is still low when it ends was finished by its own side, and
  // that is the miss; a minion that only came low during this tick is not yet
  // anybody's to lose.
  let ripe_before = Array::make(self.ripe.length(), 0)
  for i in 0..<self.ripe.length() {
    ripe_before[i] = self.ripe[i]
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
          c.cd = self.ability_cd(c)
          events.push("\{c.name} blinked to \{node_name(n)}")
        }
      Some(Recall) => {
        c.node = base_of(c.team)
        events.push("\{c.name} recalled")
      }
      Some(Buy(key)) =>
        if c.node == base_of(c.team) && c.can_buy(key) {
          let paid = c.price_of(key)
          c.apply_buy(key)
          events.push("\{c.name} bought \{key} for \{paid}")
        }
      Some(PlaceControl(n)) =>
        if c.gold >= CONTROL_COST &&
          (n == c.node || adjacency[c.node].contains(n)) {
          c.gold -= CONTROL_COST
          // It clears the node as it lands: every enemy ward in range goes,
          // control wards included, so a contested node goes to whoever paid
          // last. A stealth ward placed there later is swept at the end of
          // the tick instead — see the ward phase.
          let kept : Array[Ward] = []
          let mut cleared = 0
          for w in self.wards {
            if w.team != c.team &&
              w.ttl > 0 &&
              (w.node == n || adjacency[n].contains(w.node)) {
              cleared += 1
            } else {
              kept.push(w)
            }
          }
          self.wards.clear()
          for w in kept {
            self.wards.push(w)
          }
          self.wards.push({
            node: n,
            team: c.team,
            kind: WARD_CONTROL,
            ttl: CONTROL_TTL,
          })
          if cleared > 0 {
            events.push(
              "\{c.name}'s control ward at \{node_name(n)} cleared \{cleared} enemy ward(s)",
            )
          }
        }
      Some(PlaceWard(n)) =>
        if c.wards > 0 && (n == c.node || adjacency[c.node].contains(n)) {
          c.wards -= 1
          self.wards.push({
            node: n,
            team: c.team,
            kind: WARD_STEALTH,
            ttl: WARD_TTL,
          })
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
            c.cd = self.ability_cd(c)
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
      // Farming a LANE takes whatever is ripe there: the last hit is the
      // gold, so a tick spent farming an empty wave pays nothing and a tick
      // spent elsewhere leaves the ripe minions to be finished by our own
      // side. Farming the JUNGLE takes the camp whole and puts it on a timer,
      // so the jungler's tick is spent on a thing that is either there or
      // not — and a camp taken on the enemy's side is a camp they do not get
      // for `CAMP_RESPAWN` ticks.
      Some(Farm) => {
        let lane = node_lane[c.node]
        let ri = ripe_index(lane, c.team)
        if ri >= 0 {
          let took = self.ripe[ri]
          if took > 0 {
            self.ripe[ri] = 0
            c.cs += took
            c.gold += took * CS_GOLD
            c.gain_xp(took * CS_XP)
          }
        } else {
          match self.camp_at(c.node) {
            Some(camp) =>
              if camp.up() {
                camp.down_for = CAMP_RESPAWN
                c.camps += 1
                c.gold += CAMP_GOLD
                c.gain_xp(CAMP_XP)
                if camp.side != c.team {
                  self.camps_lost[camp.side] += 1
                  events.push(
                    "\{c.name} took \{team_name(camp.side)}'s camp at \{node_name(c.node)}",
                  )
                }
              }
            None => ()
          }
        }
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
  // Who died is decided HERE, from the damage and the heals, before anything
  // else in this loop can move anybody's health.
  //
  // It used to be decided inside the loop, and that was a real bug with a
  // real consequence: a kill awards experience, experience can raise a level,
  // a level raises maximum health and `refresh_hp` adds the difference to
  // current health — so a champion whose health had gone to -6 could be
  // lifted back to 8 by the experience from the kill it had just made, and
  // then read as alive when the loop reached it. Which of two champions that
  // killed each other survived came down to the order `champ_dmg` happened to
  // hold them, which is the order they acted, which is champion id order.
  // **Team A won every exactly even fight**, and in a mirror match — five
  // identical champions against five identical champions — the two teams'
  // plans diverged at tick 40 because of it.
  let dying : Array[Int] = []
  for entry in champ_dmg {
    let (id, _) = entry
    let target = self.champs[id]
    if target.respawn == 0 && target.hp <= 0 {
      dying.push(id)
    }
  }
  // Mark every death and set every respawn timer BEFORE awarding any kill.
  //
  // The timer is `RESPAWN_BASE + level`, and a kill awards experience that can
  // raise a level — so two champions that killed each other, marked and paid
  // one at a time, came back a tick apart: the second one's timer was read
  // after the first one's kill had levelled it. Same shape as the bug above,
  // one step further down, and it showed up the same way — a mirror match of
  // `dive` against `dive` diverged at tick 16 with one jungler back at base
  // and the other still lying in the river.
  for id in dying {
    let target = self.champs[id]
    target.hp = 0
    target.deaths += 1
    target.respawn = RESPAWN_BASE + target.level
    target.shield = 0
    target.shield_ttl = 0
    target.stunned = 0
  }
  for id in dying {
    let target = self.champs[id]
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
  // And zero them again. A champion that traded its life for a kill is owed
  // the experience for it, `gain_xp` may level it and `refresh_hp` then adds
  // the extra maximum to its current health — so without this a corpse shows
  // up in the observation with health on it. `alive()` already reads the
  // respawn timer, so this is about what a policy is shown rather than about
  // who is standing.
  for id in dying {
    self.champs[id].hp = 0
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
    // Plates come off as the health goes down, and are paid for whether or not
    // the tower falls. Only champion damage is in `struct_dmg`, which is what
    // keeps a minion wave from collecting them for a team standing somewhere
    // else.
    let broke = s.plates - s.plates_for_hp()
    if broke > 0 {
      s.plates -= broke
      match struct_top.get(idx) {
        Some((who, _)) => {
          let team = self.champs[who].team
          for c in self.champs {
            if c.team == team {
              c.gold += broke * PLATE_GOLD
            }
          }
          events.push(
            "team \{team_name(team)} took \{broke} plate(s) off the \{s.kind_name()} at \{node_name(s.node)} (+\{broke * PLATE_GOLD} each, \{s.plates} left)",
          )
        }
        None => ()
      }
    }
    if s.hp <= 0 {
      s.hp = 0
      s.plates = 0
      // The inner tower comes back. It is the gate to the nexus, so its being
      // down is a window rather than a state, and the window is why taking it
      // is worth a teamfight.
      if s.tier == 2 {
        s.respawn_in = INHIB_TICKS
      }
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
      let note = if s.tier == 2 {
        " (back in \{INHIB_TICKS} ticks; \{s.lane} is open until then)"
      } else {
        ""
      }
      events.push(
        "\{by} destroyed the \{s.kind_name()} at \{node_name(s.node)}\{note}",
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
              c.gold += match n.key {
                "baron" => 100
                "herald" => 80
                _ => 60
              }
              c.gain_xp(
                match n.key {
                  "baron" => 40
                  "herald" => 30
                  _ => 25
                },
              )
            }
          }
          if n.key == "baron" {
            self.baron[team] = BARON_TICKS
            events.push(
              "team \{team_name(team)} took BARON (+\{BARON_ATK_PCT}% attack, +\{BARON_STRUCT_PCT}% siege for \{BARON_TICKS} ticks)",
            )
          } else if n.key == "herald" {
            self.herald[team] = HERALD_TICKS
            events.push(
              "team \{team_name(team)} took the HERALD (+\{HERALD_STRUCT_PCT}% structure damage for \{HERALD_TICKS} ticks)",
            )
          } else {
            // The element is read BEFORE the stack is added, because the stack
            // is what advances the rotation: read it after and the second
            // drake of the game would already be counted as the third.
            let element = self.drake_now()
            let i = drake_index(team, element)
            if i >= 0 {
              self.drakes[i] += 1
            }
            events.push(
              "team \{team_name(team)} took the \{element} drake (\{self.drakes_of(team, element)} of that element, \{self.drake_total(team)} in all)",
            )
            // First to four takes the soul, and only the first.
            if self.soul_team == 0 && self.drake_total(team) >= SOUL_STACKS {
              self.soul_team = team
              events.push(
                "team \{team_name(team)} has the \{self.rift_element()} SOUL",
              )
            }
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
      take_damage(c, self.tower_damage_to(c))
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
    // Super minions: a lane whose inner tower is down pushes itself in the
    // breaker's favour for as long as the gate stays open. The champions in
    // the lane still decide the rest, so a defender that shows up can hold it
    // — it costs them the tick, which is the point.
    let mut super_ = 0
    for st in self.structures {
      if st.tier == 2 && st.lane == lane && st.is_down_temporarily() {
        super_ += if st.team == TEAM_A { -SUPER_PUSH } else { SUPER_PUSH }
      }
    }
    let delta = delta + super_
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
                // The plating goes with it, unpaid. Minions never break a
                // plate — that is the rule that makes "go and hit it
                // yourself" a decision — but a tower they finish cannot keep
                // plating on it either, or the observation would report
                // `plates_left` on a structure that is not there and the
                // expiry at `PLATE_TICKS` would announce plating coming off a
                // ruin.
                s.plates = 0
                // Nor does an inner tower they finish skip its timer.
                if s.tier == 2 {
                  s.respawn_in = INHIB_TICKS
                }
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

  // The minions nobody last-hit. Whatever was ripe when the tick began and is
  // still ripe now was finished by its own side's wave: that gold is gone, and
  // it is charged to the champions who were standing in the lane and chose
  // something else. This is the exact price of a trade, a poke or a rotation,
  // and `cs_lost` is what the `cs` class reads.
  for lane in lanes {
    for team in [TEAM_A, TEAM_B] {
      let ri = ripe_index(lane, team)
      // Who of ours is standing in this lane. It decides what happens to the
      // minions nobody last-hit, and the two cases are different plays:
      //
      // - **Somebody is there and spent the tick otherwise** (a poke, a trade,
      //   an ability) — their own wave finishes the low minions and the gold is
      //   gone. That is the exact price of the trade, charged to whoever was
      //   standing there.
      // - **Nobody is there** — the minions keep fighting and the wave stacks
      //   up to the cap. Leaving a lane to gank and coming back to a full wave
      //   is a play, not a loss, which is why the cap exists at all.
      let present : Array[Champ] = []
      for c in self.champs {
        if c.alive() && c.team == team && node_lane[c.node] == lane {
          present.push(c)
        }
      }
      if present.length() > 0 {
        let missed = @cmp.minimum(ripe_before[ri], self.ripe[ri])
        if missed > 0 {
          self.ripe[ri] -= missed
          for c in present {
            c.cs_lost += missed
          }
        }
      }
      // Then one more comes low, up to the cap.
      if self.ripe[ri] < CS_RIPE_CAP {
        self.ripe[ri] += 1
      }
    }
  }

  // Being in a LANE earns experience and a gold trickle whatever the champion
  // spent its turn on: the minions die next to it either way. Without this, a
  // policy that never picks `Farm` would still be level 1 at tick 60, no
  // champion would ever out-scale a tower, and no game would end — which is
  // not a lesson about the policy, only about the model.
  //
  // The jungle gets none of it. A jungle node pays its camp and nothing else,
  // which is what makes a jungler have to move: standing on one used to print
  // sixteen gold a tick forever.
  for c in self.champs {
    if c.alive() && lane_index(node_lane[c.node]) >= 0 {
      c.gold += LANE_TRICKLE
      c.gain_xp(CS_XP / 2)
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
      } else {
        let contested = !self.champs_at(c.node, enemy_of(c.team)).is_empty()
        // Out of combat: a lost trade costs position, not the rest of the
        // game, and ocean stacks make that reset faster. In combat nothing
        // regenerates — unless the team holds the ocean soul, which is the
        // whole of what that soul is: sustain that does not wait for the
        // fight to end.
        let pct = if contested {
          self.in_combat_regen_pct(c.team)
        } else {
          self.regen_pct(c.team)
        }
        if c.hp < c.max_hp && pct > 0 {
          c.hp = @cmp.minimum(c.max_hp, c.hp + c.max_hp * pct / 100)
        }
        // The mountain soul is a shield that comes back: out of combat it tops
        // itself up, so every fight starts with it and no fight ends with it.
        // It never shortens an ability's shield, only raises a smaller one.
        if !contested && self.soul_of(c.team) == "mountain" {
          if c.shield < SOUL_MOUNTAIN_SHIELD {
            c.shield = SOUL_MOUNTAIN_SHIELD
            c.shield_ttl = SHIELD_TTL
          }
        }
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
    if self.herald[t] > 0 {
      self.herald[t] -= 1
    }
  }
  // Camps come back.
  for camp in self.camps {
    if camp.down_for > 0 {
      camp.down_for -= 1
      if camp.down_for == 0 {
        events.push("the camp at \{node_name(camp.node)} is back")
      }
    }
  }
  // Plating falls off, and the inner towers come back.
  for st in self.structures {
    if st.plates > 0 && self.tick >= PLATE_TICKS {
      st.plates = 0
      events.push(
        "the plating came off the \{st.kind_name()} at \{node_name(st.node)}",
      )
    }
    if st.respawn_in > 0 {
      st.respawn_in -= 1
      if st.respawn_in == 0 {
        st.hp = st.max_hp
        events.push(
          "the \{st.kind_name()} at \{node_name(st.node)} is back up, closing \{st.lane}",
        )
      }
    }
  }
  for n in self.neutrals {
    // Herald hands its pit to Baron and does not come back. `alive` wants
    // `spawn_in == 0`, so a timer it can never finish is how it stays gone;
    // the alternative would be a field on `Neutral` that only one monster
    // uses.
    if n.key == "herald" && self.tick >= HERALD_GONE_TICK {
      if n.alive() {
        events.push("the herald has left the rift")
      }
      n.hp = 0
      n.spawn_in = 1 << 24
      continue
    }
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
    if w.ttl <= 0 {
      continue
    }
    // A live control ward keeps the enemy's STEALTH wards out of its range,
    // so one cannot simply be dropped back under it the tick after it lands.
    // Control against control is decided on placement instead — the newer one
    // clears the older — because sweeping each other every tick would be a
    // rule with no stable answer.
    if w.kind == WARD_STEALTH {
      let mut swept = false
      for other in self.wards {
        if other.team != w.team && other.ttl > 0 && other.sweeps(w.node) {
          swept = true
        }
      }
      if swept {
        events.push(
          "a control ward cleared the \{team_name(w.team)} ward at \{node_name(w.node)}",
        )
        continue
      }
    }
    live_wards.push(w)
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
    "   drakes A=\{self.drake_summary(TEAM_A)} B=\{self.drake_summary(TEAM_B)}   next=\{self.drake_now()}   baron A=\{self.baron[TEAM_A]} B=\{self.baron[TEAM_B]}",
  )
  lines.join("\n")
}
