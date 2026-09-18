///|
/// Combat resolution and mitigation, the two mechanics docs/11 leans on.

///|
/// A mutual lethal must kill BOTH champions and credit BOTH a kill. The old
/// id-ordered resolution let the lower-id attacker (always team A) strike
/// first and survive; simultaneous resolution removes that free advantage.
test "mutual lethal kills both sides" {
  let g = Game::new() // classic: attack 10, armor 0, so one hit does 10
  let a = g.champs[0]
  let b = g.champs[3]
  a.node = 2
  b.node = 2
  a.hp = 10
  b.hp = 10
  g.step(Map([(0, AttackChamp(3)), (3, AttackChamp(0))]))
  assert_false(a.alive())
  assert_false(b.alive())
  assert_eq(a.deaths, 1)
  assert_eq(b.deaths, 1)
  // Both blows land, so both attackers are credited the kill.
  assert_eq(a.kills, 1)
  assert_eq(b.kills, 1)
}

///|
/// A champion that is one hit from death still gets to strike back in the same
/// tick, because damage is computed against the start-of-tick snapshot.
test "a dying champion still deals its blow" {
  let g = Game::new()
  let a = g.champs[0]
  let b = g.champs[3]
  a.node = 2
  b.node = 2
  a.hp = 10 // will die this tick
  b.hp = 100 // will survive, but must still take a's hit
  g.step(Map([(0, AttackChamp(3)), (3, AttackChamp(0))]))
  assert_false(a.alive())
  assert_true(b.alive())
  assert_eq(b.hp, 90) // took a's 10 even though a died
}

///|
/// Armor mitigates physical damage; magic resist does nothing to it. This is
/// the lever that makes a mono-damage team exploitable.
test "armor mitigates physical, not magic" {
  let ad = Game::with_comps(["marksman", "classic", "classic"], [
      "classic", "classic", "classic",
    ]).champs[0]
  // classic attacker (attack 10, physical): 10 raw, 10*100/155 = 6 vs armor 55.
  let classic = Game::new().champs[0]
  assert_eq(classic.damage_to(0, 0), 10)
  assert_eq(classic.damage_to(55, 45), 6)
  // Physical damage ignores magic resist entirely.
  assert_eq(classic.damage_to(0, 100), 10)
  // A marksman (attack 12, physical) hits harder but is still cut by armor.
  assert_eq(ad.damage_to(0, 0), 12)
  assert_eq(ad.damage_to(55, 0), 7)
}

///|
/// Magic damage is mitigated by magic resist, not armor — the mirror image, so
/// a team stacking only armor is still soft to an AP threat.
test "magic mitigated by resist, not armor" {
  let mage = Game::with_comps(["mage", "classic", "classic"], [
      "classic", "classic", "classic",
    ]).champs[0]
  // mage: attack 14, magic. 14 raw; 14*100/145 = 9 vs mr 45; armor is ignored.
  assert_eq(mage.damage_to(0, 0), 14)
  assert_eq(mage.damage_to(0, 45), 9)
  assert_eq(mage.damage_to(100, 0), 14) // armor does nothing to magic
}

///|
/// The frontline guard: a blow aimed at a squishy is soaked by a living
/// frontliner of the same team on the node. Without this, focus fire deletes
/// the carries and a tank is only a low-damage body.
test "a frontliner soaks hits aimed at the backline" {
  // Team A: a tank (id 0) and a marksman (id 1). Team B: one marksman (id 3).
  let g = Game::with_comps(["tank", "marksman", "classic"], [
    "marksman", "classic", "classic",
  ])
  let tank = g.champs[0]
  let carry = g.champs[1]
  let enemy = g.champs[3]
  tank.node = 2
  carry.node = 2
  enemy.node = 2
  let tank_hp0 = tank.hp
  let carry_hp0 = carry.hp
  // Enemy tries to focus the squishy carry; the tank must intercept.
  g.step(Map([(3, AttackChamp(1))]))
  assert_eq(carry.hp, carry_hp0) // carry untouched
  assert_true(tank.hp < tank_hp0) // tank ate it
}

///|
/// A carry with no frontline up takes the hit itself — the guard is a real
/// roster investment, not a free effect.
test "no frontline means the carry eats the hit" {
  let g = Game::with_comps(["marksman", "marksman", "classic"], [
    "marksman", "classic", "classic",
  ])
  let carry = g.champs[1]
  let enemy = g.champs[3]
  carry.node = 2
  enemy.node = 2
  let carry_hp0 = carry.hp
  g.step(Map([(3, AttackChamp(1))]))
  assert_true(carry.hp < carry_hp0)
}

///|
/// A tank has several times a marksman's effective HP against focus fire: same
/// number of incoming hits, far more survived. This is the frontline lever.
test "a frontline body survives far more than a squishy" {
  let g = Game::with_comps(["tank", "marksman", "mage"], [
    "marksman", "marksman", "marksman",
  ])
  let tank = g.champs[0]
  let marksman = g.champs[1]
  // Effective HP against a physical attacker: hp * (100 + armor) / 100.
  let tank_ehp = tank.max_hp * (100 + tank.armor) / 100
  let mk_ehp = marksman.max_hp * (100 + marksman.armor) / 100
  assert_true(tank_ehp >= mk_ehp * 2)
}
