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
///   `bench.mbt` — checkable against the simulator.

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
}

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
pub(all) struct Item {
  key : String
  cost : Int
  atk : Int
  armor : Int
  mr : Int
  hp : Int
  pen : Int
  note : String
}

///|
/// Everything costs the same, so a buy is a pure choice of *what the enemy is
/// doing to us* rather than an affordability puzzle.
pub const ITEM_COST = 350

///|
pub let items : Array[Item] = [
  {
    key: "blade",
    cost: ITEM_COST,
    atk: 8,
    armor: 0,
    mr: 0,
    hp: 0,
    pen: 0,
    note: "+8 attack — more damage, whatever they are building",
  },
  {
    key: "pierce",
    cost: ITEM_COST,
    atk: 2,
    armor: 0,
    mr: 0,
    hp: 0,
    pen: 30,
    note: "+2 attack and 30 penetration — cuts the target's matching resist, the answer to a tanky enemy",
  },
  {
    key: "plate",
    cost: ITEM_COST,
    atk: 0,
    armor: 45,
    mr: 0,
    hp: 0,
    pen: 0,
    note: "+45 armor — mitigates PHYSICAL damage only",
  },
  {
    key: "cloak",
    cost: ITEM_COST,
    atk: 0,
    armor: 0,
    mr: 45,
    hp: 0,
    pen: 0,
    note: "+45 magic resist — mitigates MAGIC damage only",
  },
  {
    key: "belt",
    cost: ITEM_COST,
    atk: 0,
    armor: 0,
    mr: 0,
    hp: 80,
    pen: 0,
    note: "+80 health — works against both damage types, but less per gold than the matching resist",
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
    name: "classic",
    picks: ["classic", "classic", "classic", "classic", "classic"],
    note: "uniform control (the 3v3 prototype's champion, five of them)",
  },
]

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
