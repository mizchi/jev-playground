///|
/// Combat, crowd control, levels, items and the wave rule — the mechanics the
/// benchmark's ground truth rests on. Every one of these is a claim the reports
/// make, checked here so it is measured rather than asserted.

///|
/// Put two champions alone on a node, so a test is about the two of them.
fn duel(a_comp : Array[String], b_comp : Array[String], node : Int) -> Game {
  let g = Game::with_comps(a_comp, b_comp)
  for c in g.champs {
    c.node = if c.team == TEAM_A { A_BASE } else { B_BASE }
  }
  g.champs[0].node = node
  g.champs[5].node = node
  g
}

///|
/// A mutual lethal must kill BOTH champions and credit BOTH a kill.
/// Simultaneous resolution is what removes the free advantage the lower-id
/// (always team A) attacker would otherwise have.
test "mutual lethal kills both sides" {
  let g = duel(comp_by_name("classic"), comp_by_name("classic"), 9)
  let a = g.champs[0]
  let b = g.champs[5]
  a.hp = 10
  b.hp = 10
  g.step(Map([(0, AttackChamp(5)), (5, AttackChamp(0))]))
  assert_false(a.alive())
  assert_false(b.alive())
  assert_eq(a.deaths, 1)
  assert_eq(b.deaths, 1)
  assert_eq(a.kills, 1)
  assert_eq(b.kills, 1)
}

///|
/// A champion one hit from death still lands its blow, because damage is
/// computed against the start-of-tick snapshot.
test "a dying champion still deals its blow" {
  let g = duel(comp_by_name("classic"), comp_by_name("classic"), 9)
  let a = g.champs[0]
  let b = g.champs[5]
  a.hp = 5
  b.hp = 100
  g.step(Map([(0, AttackChamp(5)), (5, AttackChamp(0))]))
  assert_false(a.alive())
  assert_true(b.alive())
  // Took a's 10 even though a died — and then, with the node suddenly to
  // itself, regenerated its 6% on the same tick.
  assert_eq(b.hp, 100 - 10 + 100 * REGEN_PCT / 100)
}

///|
/// Armor mitigates physical damage and does nothing to magic; magic resist is
/// the mirror. This is the lever that makes a mono-damage team exploitable.
test "resists only answer their own damage type" {
  let g = Game::with_comps(comp_by_name("classic"), comp_by_name("classic"))
  let classic = g.champs[0]
  assert_eq(g.damage_to(classic, 0, 0), 10)
  assert_eq(g.damage_to(classic, 55, 45), 6) // 10*100/155
  assert_eq(g.damage_to(classic, 0, 100), 10) // physical ignores magic resist
  let mage = Game::with_comps(
    ["mage", "classic", "classic", "classic", "classic"],
    comp_by_name("classic"),
  )
  let m = mage.champs[0]
  assert_eq(mage.damage_to(m, 0, 0), 15)
  assert_eq(mage.damage_to(m, 100, 0), 15) // magic ignores armor
  assert_eq(mage.damage_to(m, 0, 50), 10) // 15*100/150
}

///|
/// Penetration cuts the resist that matters and never the other one.
test "penetration cuts the matching resist" {
  let g = Game::with_comps(comp_by_name("classic"), comp_by_name("classic"))
  let c = g.champs[0]
  let before = g.damage_to(c, 40, 40)
  c.items.push("pierce")
  // pierce is +2 attack and 30 penetration: 12 raw against an effective armor
  // of 10 rather than 10 raw against 40.
  let after = g.damage_to(c, 40, 40)
  assert_true(after > before)
  assert_eq(c.pen(), 30)
  assert_eq(g.damage_to(c, 20, 40), 12) // armor 20 - pen 30, floored at 0
}

///|
/// The frontline guard: a blow aimed at a squishy is soaked by a living
/// frontliner of the same team on the node.
test "a frontliner soaks hits aimed at the backline" {
  let g = Game::with_comps(comp_by_name("classic"), [
    "tank", "marksman", "classic", "classic", "classic",
  ])
  for c in g.champs {
    c.node = 9
  }
  let tank = g.champs[5]
  let carry = g.champs[6]
  let tank_hp0 = tank.hp
  let carry_hp0 = carry.hp
  g.step(Map([(0, AttackChamp(6))]))
  assert_eq(carry.hp, carry_hp0)
  assert_true(tank.hp < tank_hp0)
}

///|
/// A burst ability reaches past the frontline. This is the whole reason an
/// assassin is worth a roster slot, and the guard test above is what it beats.
test "a burst ability ignores the frontline guard" {
  let g = Game::with_comps(
    ["assassin", "classic", "classic", "classic", "classic"],
    ["tank", "marksman", "classic", "classic", "classic"],
  )
  for c in g.champs {
    c.node = 9
  }
  let assassin = g.champs[0]
  let tank = g.champs[5]
  let carry = g.champs[6]
  let tank_hp0 = tank.hp
  let carry_hp0 = carry.hp
  assert_true(assassin.ability_ready())
  g.step(Map([(0, Cast(assassin.ability, 6))]))
  assert_true(carry.hp < carry_hp0) // reached the backline
  assert_eq(tank.hp, tank_hp0) // the wall was not touched
  // And it cost the cooldown: set to its full length during the tick, then
  // counted down once at the end of it, so it is ready again `cooldown` ticks
  // after the one it was spent on.
  assert_eq(assassin.cd, assassin.cooldown - 1)
  assert_false(assassin.ability_ready())
}

///|
/// Crowd control removes the target's turn — and does not expire on the tick it
/// lands, which would make a one-tick stun free.
test "a stun costs the target its next turn" {
  let g = Game::with_comps(
    ["bruiser", "classic", "classic", "classic", "classic"],
    comp_by_name("classic"),
  )
  for c in g.champs {
    c.node = 9
  }
  let bruiser = g.champs[0]
  let victim = g.champs[5]
  assert_true(bruiser.ability is Stun(_))
  g.step(Map([(0, Cast(bruiser.ability, 5))]))
  // Landed this tick, so it must still be standing at the end of it.
  assert_eq(victim.stunned, 1)
  assert_false(victim.can_act())
  assert_true(g.legal_actions(victim).is_empty())
  let hp0 = bruiser.hp
  // The victim's action is discarded: it cannot hit back this tick.
  g.step(Map([(0, Hold), (5, AttackChamp(0))]))
  assert_eq(bruiser.hp, hp0)
  assert_eq(victim.stunned, 0)
  assert_true(victim.can_act())
}

///|
/// A shield absorbs before health, and absorbs damage landing on the same tick
/// it is cast — which is what makes shielding pre-emptively better than
/// healing afterwards.
test "a shield absorbs before health, on the tick it is cast" {
  let g = Game::with_comps(
    ["enchanter", "marksman", "classic", "classic", "classic"],
    comp_by_name("classic"),
  )
  for c in g.champs {
    c.node = 9
  }
  let enchanter = g.champs[0]
  let carry = g.champs[1]
  at_hp(carry, 50)
  let hp0 = carry.hp
  assert_true(enchanter.ability is Shield(_))
  g.step(Map([(0, Cast(enchanter.ability, -1)), (5, AttackChamp(1))]))
  // The blow landed on the shield, not on the carry.
  assert_eq(carry.hp, hp0)
  assert_true(carry.shield > 0)
}

///|
/// Levels raise stats, and health follows the change immediately.
test "a level raises stats and health follows" {
  let g = Game::with_comps(comp_by_name("classic"), comp_by_name("classic"))
  let c = g.champs[0]
  let atk1 = c.attack()
  let hp1 = c.max_hp
  c.gain_xp(LEVEL_XP)
  assert_eq(c.level, 2)
  assert_true(c.attack() > atk1)
  assert_true(c.max_hp > hp1)
  assert_eq(c.hp, c.max_hp) // the new health arrived full, not empty
  assert_eq(c.max_hp, c.hp_cap())
}

///|
/// An item is felt immediately, including the health it carries.
test "buying a health item raises health at once" {
  let g = Game::with_comps(comp_by_name("classic"), comp_by_name("classic"))
  let c = g.champs[0]
  c.node = A_BASE
  c.gold = ITEM_COST
  let hp0 = c.max_hp
  g.step(Map([(0, Buy("belt"))]))
  assert_eq(c.items.length(), 1)
  assert_eq(c.gold, 0)
  assert_eq(c.max_hp, hp0 + 80)
  assert_eq(c.hp, c.max_hp)
}

///|
/// A champion cannot buy what it cannot afford, and cannot buy away from base.
test "the shop is only open at base, and only with the gold" {
  let g = Game::with_comps(comp_by_name("classic"), comp_by_name("classic"))
  let c = g.champs[0]
  c.node = 9
  c.gold = ITEM_COST * 2
  g.step(Map([(0, Buy("belt"))]))
  assert_eq(c.items.length(), 0) // not at base
  c.node = A_BASE
  c.gold = ITEM_COST - 1
  g.step(Map([(0, Buy("belt"))]))
  assert_eq(c.items.length(), 0) // cannot afford it
}

///|
/// Tiers cannot be skipped: an inner tower is shielded by its own lane's outer
/// tower, and a nexus needs one whole lane open.
test "structures fall in order, and a nexus needs an open lane" {
  let g = Game::with_comps(comp_by_name("classic"), comp_by_name("classic"))
  let mut outer = -1
  let mut inner = -1
  let mut nexus = -1
  for i in 0..<g.structures.length() {
    let s = g.structures[i]
    if s.team == TEAM_B && s.lane == "top" && s.tier == 1 {
      outer = i
    }
    if s.team == TEAM_B && s.lane == "top" && s.tier == 2 {
      inner = i
    }
    if s.team == TEAM_B && s.is_nexus() {
      nexus = i
    }
  }
  assert_true(g.structure_attackable(g.structures[outer]))
  assert_false(g.structure_attackable(g.structures[inner]))
  assert_false(g.structure_attackable(g.structures[nexus]))
  assert_false(g.nexus_exposed(TEAM_B))
  g.structures[outer].hp = 0
  assert_true(g.structure_attackable(g.structures[inner]))
  assert_false(g.nexus_exposed(TEAM_B))
  g.structures[inner].hp = 0
  assert_true(g.lane_open(TEAM_B, "top"))
  assert_true(g.nexus_exposed(TEAM_B))
  assert_true(g.structure_attackable(g.structures[nexus]))
}

///|
/// Minions strip towers but never touch a nexus: closing a game takes
/// champions standing in the enemy base.
test "minions never damage a nexus" {
  let g = Game::with_comps(comp_by_name("classic"), comp_by_name("classic"))
  for s in g.structures {
    if s.team == TEAM_B && s.lane == "top" {
      s.hp = 0
    }
  }
  assert_true(g.nexus_exposed(TEAM_B))
  // Champions have a target in that lane; minions do not.
  assert_eq(g.lane_front(TEAM_A, "top"), B_BASE)
  assert_eq(g.minion_front(TEAM_A, "top"), -1)
}

///|
/// The wave rule: a tower does not fire at a champion whose own team holds the
/// lane, and farming is what earns that. This is the mechanic the whole map
/// turns on, so both halves of it are pinned.
test "a tower does not shoot a champion who has the wave" {
  let g = Game::with_comps(comp_by_name("classic"), comp_by_name("classic"))
  let c = g.champs[0]
  c.node = 5 // b1_top, their outer top tower
  for other in g.champs {
    if other.id != 0 {
      other.node = if other.team == TEAM_A { A_BASE } else { B_BASE }
    }
  }
  assert_false(g.has_wave(TEAM_A, "top"))
  let hp0 = c.hp
  g.step(Map([(0, AttackStructure)]))
  assert_true(c.hp < hp0) // no wave: the tower answered
  // Farming shoves the lane, and then it does not.
  g.push[0] = 2
  assert_true(g.has_wave(TEAM_A, "top"))
  let hp1 = c.hp
  g.step(Map([(0, AttackStructure)]))
  assert_eq(c.hp, hp1 + c.max_hp * REGEN_PCT / 100) // untouched, and regenerating
}

///|
/// Farming a lane shoves its wave; a lane both teams have left drifts back.
test "farming shoves the lane, an empty lane drifts back" {
  let g = Game::with_comps(comp_by_name("classic"), comp_by_name("classic"))
  for c in g.champs {
    c.node = if c.team == TEAM_A { A_BASE } else { B_BASE }
  }
  g.champs[0].node = 4 // mid_top, a lane node with minions
  g.step(Map([(0, Farm)]))
  assert_eq(g.push[0], 1)
  g.step(Map([(0, Farm)]))
  assert_eq(g.push[0], 2)
  // Leave the lane: the two waves meet in the middle again.
  g.champs[0].node = A_BASE
  g.step(Map([]))
  assert_eq(g.push[0], 1)
  g.step(Map([]))
  assert_eq(g.push[0], 0)
}

///|
/// Out-of-combat regeneration only happens out of combat.
test "regeneration stops while an enemy is on the node" {
  let g = Game::with_comps(comp_by_name("classic"), comp_by_name("classic"))
  for c in g.champs {
    c.node = if c.team == TEAM_A { A_BASE } else { B_BASE }
  }
  let c = g.champs[0]
  c.node = 9
  at_hp(c, 50)
  let hp0 = c.hp
  g.step(Map([(0, Hold)]))
  assert_true(c.hp > hp0) // alone: regenerating
  g.champs[5].node = 9
  let hp1 = c.hp
  g.step(Map([(0, Hold), (5, Hold)]))
  assert_eq(c.hp, hp1) // contested: not regenerating
}

///|
/// Poke is ranged-only, halved, and takes nothing back.
test "poke is free damage a melee champion cannot make" {
  let g = Game::with_comps(
    ["marksman", "bruiser", "classic", "classic", "classic"],
    comp_by_name("classic"),
  )
  for c in g.champs {
    c.node = if c.team == TEAM_A { A_BASE } else { B_BASE }
  }
  let ranged = g.champs[0]
  let melee = g.champs[1]
  let victim = g.champs[5]
  ranged.node = 4 // mid_top
  melee.node = 4
  victim.node = 5 // b1_top, adjacent
  // Only the ranged champion is offered the move at all.
  assert_true(g.legal_actions(ranged).contains(Poke(5)))
  assert_false(g.legal_actions(melee).contains(Poke(5)))
  // Send the melee champion in so the victim is in combat and not
  // regenerating, then compare the tick with the poke against the same tick
  // without it. The difference is the poke and nothing else.
  melee.node = 5
  let held = g.copy()
  held.step(Map([(0, Hold), (1, AttackChamp(5)), (5, AttackChamp(1))]))
  let ranged_hp0 = ranged.hp
  let expected = g.damage_to_champ(ranged, victim) / 2
  g.step(Map([(0, Poke(5)), (1, AttackChamp(5)), (5, AttackChamp(1))]))
  // Exactly half of what a basic attack on the same target would do.
  assert_eq(held.champs[5].hp - g.champs[5].hp, expected)
  assert_true(expected > 0)
  // And the victim's own attack could not reach across the node boundary.
  assert_eq(ranged.hp, ranged_hp0)
}

///|
/// Killing an epic monster buffs the whole team, not the champion that landed
/// the last hit.
test "an objective buffs the whole team" {
  let g = Game::with_comps(comp_by_name("classic"), comp_by_name("classic"))
  let dragon = g.neutrals[0]
  dragon.spawn_in = 0
  dragon.hp = 5
  let c = g.champs[0]
  c.node = dragon.node
  let ally = g.champs[1]
  let before = g.raw_attack(ally)
  g.step(Map([(0, AttackNeutral)]))
  assert_eq(g.dragons[TEAM_A], 1)
  assert_eq(g.dragons[TEAM_B], 0)
  assert_true(g.raw_attack(ally) > before) // the ally that did nothing benefits
  assert_true(dragon.spawn_in > 0) // and it is on a timer again
}

///|
/// A ward buys vision of a node and its neighbours, and expires.
test "a ward sees a node the team is standing nowhere near" {
  let g = Game::with_comps(comp_by_name("classic"), comp_by_name("classic"))
  for c in g.champs {
    c.node = if c.team == TEAM_A { A_BASE } else { B_BASE }
  }
  let c = g.champs[0]
  c.node = 18 // a_jg_bot, adjacent to the dragon pit
  assert_false(g.vision(TEAM_A)[9]) // mid_mid is not visible from there
  g.step(Map([(0, PlaceWard(RIV_BOT))]))
  assert_eq(c.wards, WARD_CHARGES - 1)
  assert_true(g.has_ward(TEAM_A, RIV_BOT))
  // The ward's node and its neighbours, one of which is mid_mid.
  assert_true(g.vision(TEAM_A)[RIV_BOT])
  assert_true(g.vision(TEAM_A)[9])
  for _t in 0..<WARD_TTL {
    g.step(Map([]))
  }
  assert_false(g.has_ward(TEAM_A, RIV_BOT))
}

///|
/// A dead or stunned champion is asked nothing at all: the question is absent
/// from the request rather than answered with a hold.
test "a champion with no turn produces no legal actions" {
  let g = Game::with_comps(comp_by_name("classic"), comp_by_name("classic"))
  let c = g.champs[0]
  assert_true(g.legal_actions(c).length() > 0)
  c.respawn = 3
  assert_true(g.legal_actions(c).is_empty())
  c.respawn = 0
  c.stunned = 1
  assert_true(g.legal_actions(c).is_empty())
}

///|
/// Every legal action round-trips through its own name. This is the invariant
/// the whole "an illegal move is unrepresentable" claim rests on: the choice
/// keys a policy is handed are exactly the moves it can make.
test "every legal action round-trips through its key" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("dive"))
  // Reach a busy state: enemies adjacent and on the node, gold in hand,
  // an objective up, a tower to hit.
  g.place_all(9)
  g.neutrals[0].spawn_in = 0
  for c in g.champs {
    c.gold = ITEM_COST
    at_level(c, 3)
  }
  g.champs[0].node = A_BASE
  g.champs[1].node = RIV_BOT
  for c in g.champs {
    let legal = g.legal_actions(c)
    let keyed = g.legal_action_map(c)
    assert_eq(keyed.size(), legal.length())
    for a in legal {
      match keyed.get(a.to_string()) {
        Some(b) => assert_true(a == b)
        None => fail("action \{a.to_string()} lost its key")
      }
      // And every action has a description that mentions something.
      assert_true(g.describe_action(c, a).length() > 0)
    }
  }
}

///|
/// `Game::copy` is a deep copy. Every oracle in `bench.mbt` plays a situation
/// out several different ways on copies, so a shared array anywhere here would
/// quietly corrupt the ground truth.
test "a copied game shares nothing with its original" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("dive"))
  g.neutrals[0].spawn_in = 0
  g.wards.push({ node: RIV_BOT, team: TEAM_A, ttl: 4, })
  let h = g.copy()
  h.champs[0].hp = 1
  h.champs[0].items.push("blade")
  h.structures[0].hp = 1
  h.neutrals[0].hp = 1
  h.wards[0].ttl = 1
  h.push[0] = 5
  h.dragons[TEAM_A] = 3
  h.baron[TEAM_B] = 7
  h.tick = 99
  assert_true(g.champs[0].hp > 1)
  assert_eq(g.champs[0].items.length(), 0)
  assert_true(g.structures[0].hp > 1)
  assert_true(g.neutrals[0].hp > 1)
  assert_eq(g.wards[0].ttl, 4)
  assert_eq(g.push[0], 0)
  assert_eq(g.dragons[TEAM_A], 0)
  assert_eq(g.baron[TEAM_B], 0)
  assert_true(g.tick < 99)
}

///|
/// Simulating a fight must not touch the game it was asked about.
test "simulating a fight leaves the live game alone" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("glass_ad"))
  g.place_all(9)
  let hp_before = []
  for c in g.champs {
    hp_before.push(c.hp)
  }
  let tick_before = g.tick
  let r = g.simulate_fight(9, 14)
  assert_true(r.ticks > 0)
  assert_eq(g.tick, tick_before)
  for i in 0..<g.champs.length() {
    assert_eq(g.champs[i].hp, hp_before[i])
  }
}

///|
/// A fight the rules say is won must be won for the right reason: one side
/// standing and the other not.
test "a won fight means one side is left standing" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("classic"))
  g.place_all(9)
  for c in g.champs {
    if c.team == TEAM_A {
      at_level(c, 6)
    }
  }
  let r = g.simulate_fight(9, 20)
  assert_eq(r.winner, TEAM_A)
  assert_true(r.a_standing > 0)
  assert_eq(r.b_standing, 0)
  assert_true(r.score_for(TEAM_A) > 0)
  assert_true(r.score_for(TEAM_B) < 0)
}
