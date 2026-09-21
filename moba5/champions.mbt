///|
/// The roster: archetypes, signature abilities, and the shop.
///
/// The 3v3 prototype had two composition levers (a durable frontline, and
/// whether a team threatens both damage types). Five slots and an ability each
/// add three more, and every one of them is a decision a policy has to get
/// right rather than a stat it passively carries:
///
/// - **An ability on a cooldown.** Holding a stun or a burst for the moment it
///   decides a fight is worth more than spending it on cooldown. Timing is now
///   representable, so a policy can be wrong about it.
/// - **Attack range.** A ranged champion can `Poke` a neighbouring node for
///   half damage and take nothing back. Free damage for a team willing to
///   stand off — and nothing at all for a team that walks straight in.
/// - **Itemisation.** Gold buys armor, magic resist, health, attack or
///   penetration. The right buy depends on what the enemy team actually deals,
///   which the observation shows, so the correct answer is knowable and — see
///   `bench.mbt` — checkable against the simulator. The shop has two tiers:
///   a component is cheap and arrives sooner, a completed item consumes its
///   components and is worth more per gold, so "this now or that later" is a
///   decision as well as "which stat".

///|
pub const DMG_PHYSICAL = 0

///|
pub const DMG_MAGIC = 1

///|
/// Experience for one level. Six levels over a ~70 tick game means a champion
/// that farms well is roughly a level ahead, not five.
pub const LEVEL_XP = 55

///|
pub const MAX_LEVEL = 6

///|
/// How many items a champion can hold. Three 350-gold buys is about what a
/// winning lane affords, so the shop is a real budget and not a formality.
///
/// Components share those three slots, which is what makes the upper tier a
/// commitment rather than a free upgrade: two components waiting to become
/// one `bulwark` occupy two thirds of the bag while they wait. Combining is
/// slot-neutral, so a full bag can still be upgraded — see `Champ::slots_after`.
pub const ITEM_SLOTS = 3

///|
/// A signature ability. Each one is a different *kind* of decision, which is
/// the reason to have several rather than one tuned number:
pub(all) enum Ability {
  /// No ability. The `classic` control champion, so the 3v3 baseline behaviour
  /// stays reproducible here too.
  NoAbility
  /// Burst one enemy on this node, ignoring the frontline guard. This is the
  /// answer to a tank standing in front of a carry — and it is wasted on the
  /// tank itself.
  Nuke(Int)
  /// Damage every enemy on this node. Worth more the more of them are grouped,
  /// so its value depends on the enemy's positioning, not ours.
  Aoe(Int)
  /// Crowd control: the target cannot act for this many ticks. It deals no
  /// damage at all, so spending it correctly is purely a timing judgment.
  Stun(Int)
  /// Restore health to the lowest-health ally on this node (self included).
  Heal(Int)
  /// A temporary absorb on the lowest-health ally here. Unlike a heal it can be
  /// applied pre-emptively, before the damage lands.
  Shield(Int)
  /// Damage scaled by how much health the target is missing — a finisher. Wrong
  /// on a healthy target, decisive on a hurt one.
  Execute(Int)
  /// Move two nodes at once: an escape, or an engage nobody saw coming.
  Blink
} derive(Eq)

///|
pub fn Ability::name(self : Ability) -> String {
  match self {
    NoAbility => "none"
    Nuke(_) => "burst"
    Aoe(_) => "aoe"
    Stun(_) => "stun"
    Heal(_) => "heal"
    Shield(_) => "shield"
    Execute(_) => "execute"
    Blink => "blink"
  }
}

///|
/// A one-line description of what the ability does, for the observation and for
/// an action's description. The rules tell the policy what a move is worth; it
/// does not have to learn it from losing.
pub fn Ability::describe(self : Ability) -> String {
  match self {
    NoAbility => "no ability"
    Nuke(p) =>
      "burst \{p} damage to one enemy here, IGNORING their frontline (reaches the backline)"
    Aoe(p) => "\{p} damage to EVERY enemy on this node"
    Stun(t) => "stun one enemy here for \{t} tick(s): it cannot act at all"
    Heal(p) => "heal the lowest-health ally here (self included) for \{p}"
    Shield(p) =>
      "shield the lowest-health ally here for \{p}, absorbed before health"
    Execute(p) =>
      "\{p} damage plus a bonus that grows with the target's MISSING health"
    Blink => "move two nodes in one tick"
  }
}

///|
/// A champion template.
pub(all) struct Kind {
  key : String
  /// The role this archetype is drafted into, for readable rosters.
  slot : String
  dmg_type : Int
  attack : Int
  max_hp : Int
  armor : Int
  mr : Int
  /// A durable body that stands between attackers and the backline.
  frontline : Bool
  /// A ranged champion may `Poke` an adjacent node for half damage, taking
  /// nothing back.
  ranged : Bool
  ability : Ability
  /// Ticks before the ability can be used again.
  cooldown : Int
  /// Attack gained per level, in percent of the base.
  ///
  /// Every archetype grew at the same 12% before this field existed, which
  /// meant a higher base attack was better at every level and "when should we
  /// fight" had no answer beyond "whenever we are ahead". Splitting the rate
  /// makes the question real: a `bully` out-damages a `marksman` at level 1
  /// and loses to it at level 6, so the same two teams have a window rather
  /// than a ranking. `power_ratio` reads the difference, and the `power` class
  /// is scored against it.
  growth : Int
}

///|
/// The rate every archetype grew at before growth was per-archetype. Kept as
/// the neutral value so an archetype that is not making a timing claim reads
/// as making none.
pub const GROWTH_EVEN = 12

///|
/// The roster. `classic` reproduces the 3v3 prototype's uniform champion
/// (attack 10, hp 100, no resists, no ability) so a `classic`-only game here is
/// the old game with five bodies instead of three, and the difference the new
/// mechanics make is measurable against it.
pub let kinds : Map[String, Kind] = {
  "classic": {
    key: "classic",
    slot: "any",
    dmg_type: DMG_PHYSICAL,
    attack: 10,
    max_hp: 100,
    armor: 0,
    mr: 0,
    frontline: false,
    ranged: false,
    ability: NoAbility,
    growth: 12,
    cooldown: 0,
  },
  "marksman": {
    key: "marksman",
    slot: "bot",
    dmg_type: DMG_PHYSICAL,
    attack: 13,
    max_hp: 95,
    armor: 15,
    mr: 15,
    frontline: false,
    ranged: true,
    ability: Execute(10),
    growth: 19,
    cooldown: 4,
  },
  // The second bot laner, and the roster's clearest timing claim. It beats
  // `marksman` at level 1 on raw attack and loses to it by level 6 (growth 5
  // against 19), so "fight now or farm and fight later" has a right answer
  // that depends on the tick rather than on the draft.
  "bully": {
    key: "bully",
    slot: "bot",
    dmg_type: DMG_PHYSICAL,
    attack: 17,
    max_hp: 105,
    armor: 18,
    mr: 14,
    frontline: false,
    ranged: true,
    ability: Nuke(18),
    growth: 5,
    cooldown: 4,
  },
  "mage": {
    key: "mage",
    slot: "mid",
    dmg_type: DMG_MAGIC,
    attack: 15,
    max_hp: 85,
    armor: 12,
    mr: 12,
    frontline: false,
    ranged: true,
    ability: Aoe(13),
    growth: 14,
    cooldown: 5,
  },
  "artillery": {
    key: "artillery",
    slot: "mid",
    dmg_type: DMG_MAGIC,
    attack: 12,
    max_hp: 80,
    armor: 10,
    mr: 15,
    frontline: false,
    ranged: true,
    ability: Aoe(17),
    growth: 13,
    cooldown: 6,
  },
  "assassin": {
    key: "assassin",
    slot: "mid",
    dmg_type: DMG_PHYSICAL,
    attack: 17,
    max_hp: 90,
    armor: 15,
    mr: 12,
    frontline: false,
    ranged: false,
    ability: Nuke(24),
    growth: 16,
    cooldown: 5,
  },
  "skirmisher": {
    key: "skirmisher",
    slot: "jungle",
    dmg_type: DMG_PHYSICAL,
    attack: 15,
    max_hp: 115,
    armor: 25,
    mr: 20,
    frontline: false,
    ranged: false,
    ability: Execute(14),
    growth: 13,
    cooldown: 4,
  },
  "jungler": {
    key: "jungler",
    slot: "jungle",
    dmg_type: DMG_PHYSICAL,
    attack: 14,
    max_hp: 125,
    armor: 28,
    mr: 22,
    frontline: true,
    ranged: false,
    ability: Blink,
    growth: 10,
    cooldown: 4,
  },
  "bruiser": {
    key: "bruiser",
    slot: "top",
    dmg_type: DMG_PHYSICAL,
    attack: 11,
    max_hp: 140,
    armor: 35,
    mr: 25,
    frontline: true,
    ranged: false,
    ability: Stun(1),
    growth: 9,
    cooldown: 5,
  },
  "tank": {
    key: "tank",
    slot: "top",
    dmg_type: DMG_PHYSICAL,
    attack: 6,
    max_hp: 180,
    armor: 55,
    mr: 45,
    frontline: true,
    ranged: false,
    ability: Stun(2),
    growth: 6,
    cooldown: 6,
  },
  "support": {
    key: "support",
    slot: "support",
    dmg_type: DMG_MAGIC,
    attack: 7,
    max_hp: 110,
    armor: 25,
    mr: 30,
    frontline: false,
    ranged: false,
    ability: Heal(32),
    growth: 8,
    cooldown: 4,
  },
  "enchanter": {
    key: "enchanter",
    slot: "support",
    dmg_type: DMG_MAGIC,
    attack: 8,
    max_hp: 100,
    armor: 20,
    mr: 28,
    frontline: false,
    ranged: true,
    ability: Shield(38),
    growth: 8,
    cooldown: 4,
  },
}

///|
/// Look up an archetype, falling back to `classic` for an unknown key.
pub fn kind_of(key : String) -> Kind {
  match kinds.get(key) {
    Some(k) => k
    None => kinds.get("classic").unwrap()
  }
}

///|
pub fn Kind::dmg_type_name(self : Kind) -> String {
  if self.dmg_type == DMG_PHYSICAL {
    "physical (AD)"
  } else {
    "magic (AP)"
  }
}

// -------------------------------------------------------------------- the shop

///|
/// A purchasable item. `pen` reduces the resist that matters against this
/// champion's damage type, which is the only answer to a target whose resist is
/// so high that raw attack is being thrown away.
///
/// `builds_from` names the components this item consumes. A component lists
/// none, and is the only reason `cost` and `item_total_cost` differ: `cost` is
/// what the counter charges once the components are in hand.
pub(all) struct Item {
  key : String
  cost : Int
  builds_from : Array[String]
  atk : Int
  armor : Int
  mr : Int
  hp : Int
  pen : Int
  note : String
}

///|
/// A component's price, and what every one-component item charges to combine.
/// Their sum is `ITEM_COST`, so the five items that existed before the shop had
/// tiers still cost exactly what they did.
pub const COMPONENT_COST = 150

///|
pub const COMBINE_COST = 200

///|
/// The price of a one-component item from nothing. Named because the benchmark
/// and the baselines both use it as "one item's worth of gold".
pub const ITEM_COST : Int = COMPONENT_COST + COMBINE_COST

///|
/// The price of a two-component item from nothing.
pub const BIG_ITEM_COST : Int = 2 * COMPONENT_COST + 250

///|
/// The shop, in two tiers.
///
/// A component is available sooner and a completed item is worth more per
/// gold, which is the trade the build path exists to create: 3 attack at tick
/// 12 or 8 attack at tick 20, and the answer depends on what happens between
/// them. `edge` and `bulwark` push that further — nearly twice the stats per
/// gold, for a champion patient enough to save through a fight.
pub let items : Array[Item] = [
  // ---- components
  {
    key: "sword",
    cost: COMPONENT_COST,
    builds_from: [],
    atk: 3,
    armor: 0,
    mr: 0,
    hp: 0,
    pen: 0,
    note: "+3 attack — a component; builds into blade, pierce or edge",
  },
  {
    key: "hide",
    cost: COMPONENT_COST,
    builds_from: [],
    atk: 0,
    armor: 18,
    mr: 0,
    hp: 0,
    pen: 0,
    note: "+18 armor — a component; builds into plate or bulwark",
  },
  {
    key: "silk",
    cost: COMPONENT_COST,
    builds_from: [],
    atk: 0,
    armor: 0,
    mr: 18,
    hp: 0,
    pen: 0,
    note: "+18 magic resist — a component; builds into cloak or bulwark",
  },
  {
    key: "ruby",
    cost: COMPONENT_COST,
    builds_from: [],
    atk: 0,
    armor: 0,
    mr: 0,
    hp: 30,
    pen: 0,
    note: "+30 health — a component; builds into belt",
  },
  // ---- completed, one component
  {
    key: "blade",
    cost: COMBINE_COST,
    builds_from: ["sword"],
    atk: 8,
    armor: 0,
    mr: 0,
    hp: 0,
    pen: 0,
    note: "+8 attack — more damage, whatever they are building",
  },
  {
    key: "pierce",
    cost: COMBINE_COST,
    builds_from: ["sword"],
    atk: 2,
    armor: 0,
    mr: 0,
    hp: 0,
    pen: 30,
    note: "+2 attack and 30 penetration — cuts the target's matching resist, the answer to a tanky enemy",
  },
  {
    key: "plate",
    cost: COMBINE_COST,
    builds_from: ["hide"],
    atk: 0,
    armor: 45,
    mr: 0,
    hp: 0,
    pen: 0,
    note: "+45 armor — mitigates PHYSICAL damage only",
  },
  {
    key: "cloak",
    cost: COMBINE_COST,
    builds_from: ["silk"],
    atk: 0,
    armor: 0,
    mr: 45,
    hp: 0,
    pen: 0,
    note: "+45 magic resist — mitigates MAGIC damage only",
  },
  {
    key: "belt",
    cost: COMBINE_COST,
    builds_from: ["ruby"],
    atk: 0,
    armor: 0,
    mr: 0,
    hp: 80,
    pen: 0,
    note: "+80 health — works against both damage types, but less per gold than the matching resist",
  },
  // ---- completed, two components
  {
    key: "edge",
    cost: 250,
    builds_from: ["sword", "sword"],
    atk: 18,
    armor: 0,
    mr: 0,
    hp: 0,
    pen: 0,
    note: "+18 attack — half again the attack of two blades for the same gold, if you can wait for it",
  },
  {
    key: "bulwark",
    cost: 250,
    builds_from: ["hide", "silk"],
    atk: 0,
    armor: 30,
    mr: 30,
    hp: 40,
    pen: 0,
    note: "+30 armor, +30 magic resist and +40 health — the answer to a team doing BOTH kinds of damage, where a single resist is half wasted",
  },
]

///|
pub fn item_of(key : String) -> Item? {
  for it in items {
    if it.key == key {
      return Some(it)
    }
  }
  None
}

///|
/// The full price of `key` from an empty inventory: its own cost plus every
/// component's.
///
/// One level deep, because the shop is: `item_tree_is_two_deep` in
/// `shop_wbtest.mbt` checks that rather than leaving it to be assumed, which
/// is cheaper than making this recursive over data that cannot be cyclic.
pub fn item_total_cost(key : String) -> Int {
  match item_of(key) {
    Some(it) => {
      let mut total = it.cost
      for comp in it.builds_from {
        total += match item_of(comp) {
          Some(c) => c.cost
          None => 0
        }
      }
      total
    }
    None => 0
  }
}

///|
/// Everything `key` builds into, for the shop listing and for a baseline
/// deciding whether the component it can afford is on the way to the item it
/// wants.
pub fn item_builds_into(key : String) -> Array[String] {
  let out = []
  for it in items {
    if it.builds_from.contains(key) {
      out.push(it.key)
    }
  }
  out
}

// ------------------------------------------------------------- compositions

///|
/// A named five-champion composition, for the draft and the tournament.
pub(all) struct Comp {
  name : String
  picks : Array[String]
  note : String
}

///|
/// The tournament field. The picks vary the levers independently — frontline or
/// not, mixed damage or mono, and now whether the team has any crowd control or
/// any sustain — so a report can say which lever a result came from.
pub let tournament_comps : Array[Comp] = [
  {
    name: "meta",
    picks: ["tank", "jungler", "mage", "marksman", "enchanter"],
    note: "frontline + AD + AP + CC + shield",
  },
  {
    name: "poke",
    picks: ["bruiser", "skirmisher", "artillery", "marksman", "enchanter"],
    note: "three ranged, wins from a distance",
  },
  {
    name: "dive",
    picks: ["tank", "assassin", "assassin", "marksman", "support"],
    note: "frontline + two backline nukes",
  },
  {
    name: "bruisers",
    picks: ["bruiser", "jungler", "bruiser", "skirmisher", "tank"],
    note: "all frontline, almost no damage",
  },
  {
    name: "glass_ad",
    picks: ["marksman", "assassin", "skirmisher", "marksman", "marksman"],
    note: "no frontline, all physical",
  },
  {
    name: "glass_ap",
    picks: ["mage", "mage", "artillery", "support", "enchanter"],
    note: "no frontline, all magic",
  },
  {
    name: "early",
    picks: ["bully", "jungler", "assassin", "bully", "support"],
    note: "high base attack, low growth — wants the fight now",
  },
  {
    name: "late",
    picks: ["tank", "skirmisher", "mage", "marksman", "enchanter"],
    note: "low base attack, high growth — wants the fight at six",
  },
  {
    name: "classic",
    picks: ["classic", "classic", "classic", "classic", "classic"],
    note: "uniform control (the 3v3 prototype's champion, five of them)",
  },
]

///|
/// A composition's mean attack growth, in percent per level. The draft's timing
/// axis: two comps with the same level-1 power and different growth do not have
/// the same answer to "fight now or later".
pub fn Comp::mean_growth(self : Comp) -> Int {
  let mut sum = 0
  for p in self.picks {
    sum += kind_of(p).growth
  }
  sum / self.picks.length()
}

///|
/// A composition's level-1 attack, summed. Read against `mean_growth`, the two
/// say which side of the curve a draft sits on.
pub fn Comp::base_attack(self : Comp) -> Int {
  let mut sum = 0
  for p in self.picks {
    sum += kind_of(p).attack
  }
  sum
}

///|
/// Whether a composition fields a durable body.
pub fn Comp::has_frontline(self : Comp) -> Bool {
  for p in self.picks {
    if kind_of(p).frontline {
      return true
    }
  }
  false
}

///|
/// Whether a composition threatens both damage types. A mono-damage team can be
/// answered by one resist; a mixed one always finds the softer stat.
pub fn Comp::mixed_damage(self : Comp) -> Bool {
  let mut ad = false
  let mut ap = false
  for p in self.picks {
    if kind_of(p).dmg_type == DMG_PHYSICAL {
      ad = true
    } else {
      ap = true
    }
  }
  ad && ap
}

///|
/// Whether a composition brings any crowd control — the lever that lets a team
/// choose when a fight happens rather than only how hard it hits.
pub fn Comp::has_cc(self : Comp) -> Bool {
  for p in self.picks {
    if kind_of(p).ability is Stun(_) {
      return true
    }
  }
  false
}

///|
/// Whether a composition brings sustain (a heal or a shield).
pub fn Comp::has_sustain(self : Comp) -> Bool {
  for p in self.picks {
    match kind_of(p).ability {
      Heal(_) | Shield(_) => return true
      _ => ()
    }
  }
  false
}

///|
/// How many of a composition's picks are ranged.
pub fn Comp::ranged_count(self : Comp) -> Int {
  let mut n = 0
  for p in self.picks {
    if kind_of(p).ranged {
      n += 1
    }
  }
  n
}

///|
/// A named composition's picks, or classic×5 if the name is unknown.
pub fn comp_by_name(name : String) -> Array[String] {
  for c in tournament_comps {
    if c.name == name {
      return c.picks
    }
  }
  ["classic", "classic", "classic", "classic", "classic"]
}
