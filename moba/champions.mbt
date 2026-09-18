///|
/// Champion archetypes: what gives a team a composition worth reasoning about.
///
/// Two levers make composition matter, and both are checkable:
///
/// - **Damage type vs resist.** Physical (AD) damage is mitigated by the
///   target's armor, magic (AP) by its magic resist. A team that deals only
///   one type loses value against an enemy whose matching resist happens to
///   be high; a team that threatens both always finds the softer stat. There
///   is no itemization here, so resists are fixed per archetype — which is
///   exactly what makes a mono-damage team exploitable.
/// - **A durable frontline.** Tanks and bruisers have several times the
///   effective HP of a marksman or mage, so a team with one has a body that
///   survives a siege while an all-squishy team folds to focus fire.
///
/// The canonical good comp is therefore frontline + AD + AP (durable and
/// mixed-damage); the canonical bad comp is three squishies of one damage
/// type (no frontline, one resist defends the whole enemy team against it).
/// docs/11 checks that the good comp actually wins.

///|
pub const DMG_PHYSICAL = 0

///|
pub const DMG_MAGIC = 1

///|
/// A champion template. `attack` is per-tick damage before mitigation and the
/// gold bonus; `armor`/`mr` mitigate incoming physical/magic.
pub(all) struct Kind {
  key : String
  dmg_type : Int
  attack : Int
  max_hp : Int
  armor : Int
  mr : Int
  /// A durable body the enemy cannot ignore; used only for readable state.
  frontline : Bool
}

///|
/// The roster. `classic` reproduces the original uniform champion (armor 0 so
/// mitigation is 1.0, attack 10, hp 100), so the pre-archetype behaviour and
/// docs/02 stay reproducible; everything else is a real archetype.
pub let kinds : Map[String, Kind] = {
  "classic": {
    key: "classic",
    dmg_type: DMG_PHYSICAL,
    attack: 10,
    max_hp: 100,
    armor: 0,
    mr: 0,
    frontline: false,
  },
  "marksman": {
    key: "marksman",
    dmg_type: DMG_PHYSICAL,
    attack: 12,
    max_hp: 95,
    armor: 15,
    mr: 15,
    frontline: false,
  },
  "mage": {
    key: "mage",
    dmg_type: DMG_MAGIC,
    attack: 14,
    max_hp: 85,
    armor: 12,
    mr: 12,
    frontline: false,
  },
  "assassin": {
    key: "assassin",
    dmg_type: DMG_PHYSICAL,
    attack: 16,
    max_hp: 90,
    armor: 15,
    mr: 12,
    frontline: false,
  },
  "bruiser": {
    key: "bruiser",
    dmg_type: DMG_PHYSICAL,
    attack: 10,
    max_hp: 135,
    armor: 35,
    mr: 25,
    frontline: true,
  },
  "tank": {
    key: "tank",
    dmg_type: DMG_PHYSICAL,
    attack: 6,
    max_hp: 175,
    armor: 55,
    mr: 45,
    frontline: true,
  },
  "support": {
    key: "support",
    dmg_type: DMG_MAGIC,
    attack: 7,
    max_hp: 105,
    armor: 25,
    mr: 30,
    frontline: false,
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
/// A named composition, for the synergy tournament. The point of the set is to
/// vary the two levers independently: whether the team has a durable frontline,
/// and whether it threatens both damage types or only one.
pub(all) struct Comp {
  name : String
  picks : Array[String]
  /// A human note on why it is good or bad, for the report.
  note : String
}

///|
/// The tournament field. `meta` and `bruiser_mix` are the "correct synergy"
/// comps (frontline + both damage types); the glass comps are the mistakes
/// (no frontline, one damage type the enemy can itemise against). `classic` is
/// the pre-archetype uniform team, as a control.
pub let tournament_comps : Array[Comp] = [
  {
    name: "meta",
    picks: ["tank", "marksman", "mage"],
    note: "frontline + AD + AP",
  },
  {
    name: "bruiser_mix",
    picks: ["bruiser", "marksman", "support"],
    note: "frontline + AD + AP (softer)",
  },
  {
    name: "frontline_ad",
    picks: ["bruiser", "marksman", "assassin"],
    note: "frontline, but all physical",
  },
  {
    name: "glass_ad",
    picks: ["marksman", "assassin", "marksman"],
    note: "no frontline, all physical",
  },
  {
    name: "glass_ap",
    picks: ["mage", "mage", "support"],
    note: "no frontline, all magic",
  },
  {
    name: "classic",
    picks: ["classic", "classic", "classic"],
    note: "uniform control (docs/02)",
  },
]

///|
/// Whether a composition fields a durable body (tank or bruiser).
pub fn Comp::has_frontline(self : Comp) -> Bool {
  for p in self.picks {
    if kind_of(p).frontline {
      return true
    }
  }
  false
}

///|
/// Whether a composition threatens both damage types. A mono-damage team can
/// be answered by one resist; a mixed one always finds the softer stat.
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
pub fn Kind::dmg_type_name(self : Kind) -> String {
  if self.dmg_type == DMG_PHYSICAL {
    "physical (AD)"
  } else {
    "magic (AP)"
  }
}

///|
/// Damage `attacker` lands on a target with the given resists, after
/// mitigation by the resist matching the attacker's damage type and the gold
/// bonus. Always at least 1, so a fight cannot stall forever.
pub fn Champ::damage_to(
  self : Champ,
  target_armor : Int,
  target_mr : Int,
) -> Int {
  let base = self.attack + self.gold / 100
  let resist = if self.dmg_type == DMG_PHYSICAL {
    target_armor
  } else {
    target_mr
  }
  let dealt = base * 100 / (100 + resist)
  if dealt < 1 {
    1
  } else {
    dealt
  }
}
