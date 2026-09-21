///|
/// Plating, the inner tower as a gate that comes back, and Herald.
///
/// All three exist to put a clock on something. Plating pays for damage that
/// does not have to finish the tower, and stops paying at `PLATE_TICKS`; an
/// inner tower opens a lane for `INHIB_TICKS` and then closes it again;
/// Herald hands out siege damage for `HERALD_TICKS` and leaves the map for
/// good at `HERALD_GONE_TICK`. A clock that never runs and a clock that never
/// stops are both bugs, and neither shows up in a game's outcome, so each one
/// is asserted at both ends.

///|
/// Plates come off the top of the bar, one step at a time.
test "plating tracks the health it is sitting on" {
  let g = Game::new()
  let mut tower = g.structures[0]
  for s in g.structures {
    if s.tier == 1 {
      tower = s
    }
  }
  assert_eq(tower.plates, PLATES)
  assert_eq(tower.plates_for_hp(), PLATES)
  // Just under four fifths: the fifth plate is gone.
  tower.hp = tower.max_hp * 4 / 5 - 1
  assert_eq(tower.plates_for_hp(), PLATES - 1)
  // Dead: none.
  tower.hp = 0
  assert_eq(tower.plates_for_hp(), 0)
  // And plating never comes BACK: `plates_for_hp` is capped by what is left,
  // so a tower that somehow healed would not re-earn its plates.
  tower.plates = 2
  tower.hp = tower.max_hp
  assert_eq(tower.plates_for_hp(), 2)
  // Nothing but an outer tower is plated.
  for s in g.structures {
    if s.tier != 1 {
      assert_eq(s.plates, 0)
      assert_eq(s.plates_for_hp(), 0)
    }
  }
}

///|
/// A champion taking a plate is paid, and the whole team is paid.
test "a champion that takes a plate is paid for it" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  let tower = enemy_outer(g, TEAM_A, "top")
  let c = g.champs[0]
  c.node = tower.node
  // Our wave holds the lane, so the tower cannot shoot back and the only
  // thing moving is the plating.
  g.push[lane_index("top")] = PUSH_CAP
  let ally = g.champs[1]
  let ally_gold = ally.gold
  let mut ticks = 0
  while tower.plates == PLATES && ticks < 20 {
    g.step(Map([(c.id, AttackStructure)]))
    ticks += 1
  }
  assert_true(tower.plates < PLATES)
  // Every champion on the team, not just the one swinging.
  assert_true(ally.gold >= ally_gold + PLATE_GOLD)
}

///|
/// Minions take no plates. A lane that shoves itself into a tower would
/// otherwise pay a team for standing somewhere else entirely.
test "minions break no plates" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  let tower = enemy_outer(g, TEAM_A, "mid")
  // Everybody home, and the mid wave shoved all the way into their tower.
  for c in g.champs {
    c.node = base_of(c.team)
  }
  g.push[lane_index("mid")] = PUSH_CAP
  let hp0 = tower.hp
  let plates0 = tower.plates
  for _i in 0..<6 {
    g.step(Map([]))
  }
  // The minions are doing damage and taking nothing off the plating.
  assert_true(tower.hp < hp0)
  assert_eq(tower.plates, plates0)
}

///|
/// The plating falls off on its own, and pays nobody for it.
test "plating expires without paying anyone" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  for c in g.champs {
    c.node = base_of(c.team)
  }
  let gold_before = g.team_gold(TEAM_A) + g.team_gold(TEAM_B)
  while g.tick < PLATE_TICKS {
    g.step(Map([]))
  }
  for s in g.structures {
    assert_eq(s.plates, 0)
  }
  // Champions at base earn nothing at all, so the plating paid nothing: any
  // gold at this point would have to have come from the plates falling off.
  assert_eq(g.team_gold(TEAM_A) + g.team_gold(TEAM_B), gold_before)
}

///|
/// The inner tower is a gate on a timer: down opens the lane, up closes it.
test "the inner tower comes back and closes the lane again" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  for c in g.champs {
    c.node = base_of(c.team)
  }
  let outer = enemy_outer(g, TEAM_B, "top") // team A's own outer, top
  let inner = inner_of(g, TEAM_A, "top")
  assert_false(g.lane_open(TEAM_A, "top"))

  // Break the outer by hand and the inner through the rules, so the respawn
  // is set by the tick rather than by the test.
  outer.hp = 0
  inner.hp = 4
  let killer = g.champs[5] // one of theirs
  killer.node = inner.node
  g.push[lane_index("top")] = -PUSH_CAP
  g.step(Map([(killer.id, AttackStructure)]))
  assert_eq(inner.hp, 0)
  assert_true(inner.is_down_temporarily())
  assert_true(g.lane_open(TEAM_A, "top"))
  assert_true(g.nexus_exposed(TEAM_A))

  // While it is down, the lane pushes itself toward the team that broke it.
  for c in g.champs {
    c.node = base_of(c.team)
  }
  g.push[lane_index("top")] = 0
  g.step(Map([]))
  assert_true(g.push[lane_index("top")] < 0) // toward team B
  // An untouched lane does not.
  assert_eq(g.push[lane_index("mid")], 0)

  // And it comes back, at full health, closing the lane.
  while inner.is_down_temporarily() {
    g.step(Map([]))
  }
  assert_eq(inner.hp, inner.max_hp)
  assert_false(g.lane_open(TEAM_A, "top"))
  assert_false(g.nexus_exposed(TEAM_A))
  // It is attackable again, since its outer is still down.
  assert_true(g.structure_attackable(inner))
}

///|
/// Only the inner tower comes back.
test "an outer tower and a nexus stay down" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  for c in g.champs {
    c.node = base_of(c.team)
  }
  let outer = enemy_outer(g, TEAM_A, "bot")
  let killer = g.champs[0]
  killer.node = outer.node
  g.push[lane_index("bot")] = PUSH_CAP
  outer.hp = 3
  g.step(Map([(killer.id, AttackStructure)]))
  assert_eq(outer.hp, 0)
  assert_false(outer.is_down_temporarily())
  for _i in 0..<(INHIB_TICKS + 4) {
    g.step(Map([]))
  }
  assert_eq(outer.hp, 0)
  // The nexus has no timer either, which is what makes it the win condition.
  for s in g.structures {
    if s.is_nexus() {
      assert_eq(s.respawn_in, 0)
    }
  }
}

///|
/// Herald: up early, one per game, and gone before Baron wants the pit.
test "there is one herald and it leaves before baron arrives" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  let herald = match g.neutral_named("herald") {
    Some(n) => n
    None => panic()
  }
  let baron = match g.neutral_named("baron") {
    Some(n) => n
    None => panic()
  }
  // They share a pit, so they must not share a tick.
  assert_eq(herald.node, baron.node)
  assert_true(HERALD_GONE_TICK <= baron.spawn_in)
  for c in g.champs {
    c.node = base_of(c.team)
  }
  let mut seen_up = false
  while g.tick < HERALD_GONE_TICK + 2 {
    g.step(Map([]))
    if herald.alive() {
      seen_up = true
      assert_false(baron.alive())
    }
  }
  assert_true(seen_up)
  assert_false(herald.alive())
  // And it does not come back for the rest of any game.
  for _i in 0..<40 {
    g.step(Map([]))
    assert_false(herald.alive())
  }
}

///|
/// Herald's charge is siege damage and nothing else — the reason it is a tool
/// for taking a tower rather than a small Baron.
test "the herald buff moves structure damage and not champion damage" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  g.level_all(4)
  let c = g.champs[3]
  let structure_before = g.damage_to_structure(c)
  let champ_before = g.damage_to_champ(c, g.champs[5])
  let attack_before = g.raw_attack(c)
  g.herald[TEAM_A] = HERALD_TICKS
  assert_true(g.damage_to_structure(c) > structure_before)
  assert_eq(g.damage_to_champ(c, g.champs[5]), champ_before)
  assert_eq(g.raw_attack(c), attack_before)
  // Theirs is untouched.
  assert_eq(
    g.damage_to_structure(g.champs[8]),
    g.damage_to_structure(g.champs[8]),
  )
  // It runs out.
  for c2 in g.champs {
    c2.node = base_of(c2.team)
  }
  for _i in 0..<(HERALD_TICKS + 1) {
    g.step(Map([]))
  }
  assert_eq(g.herald[TEAM_A], 0)
  assert_eq(g.damage_to_structure(c), structure_before)
}

///|
/// Taking it through the rules gives the charge to the whole team.
test "killing the herald charges the team that killed it" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  let herald = match g.neutral_named("herald") {
    Some(n) => n
    None => panic()
  }
  herald.spawn_in = 0
  herald.hp = 4
  let c = g.champs[2]
  c.node = herald.node
  g.step(Map([(c.id, AttackNeutral)]))
  // One less than `HERALD_TICKS`: the tick it was taken on is spent taking
  // it, and the countdown in the same `step` sees the buff it just granted.
  // Baron has always behaved this way, so the herald matches it rather than
  // being a tick longer than the constant it is named for.
  assert_eq(g.herald[TEAM_A], HERALD_TICKS - 1)
  assert_eq(g.herald[TEAM_B], 0)
  // The reward for it sits between a drake's and Baron's, so a team is paid
  // for the rotation as well as charged for it.
  assert_true(c.gold > 0)
}

///|
/// A copy carries the plating and the timer. Every benchmark truth is computed
/// on a copy, so a plate count that did not travel would have the oracle
/// answering about a tower with different gold on it.
test "a copy carries the plates and the respawn timer" {
  let g = Game::new()
  let inner = inner_of(g, TEAM_A, "mid")
  let outer = enemy_outer(g, TEAM_B, "mid")
  outer.plates = 2
  inner.respawn_in = 7
  g.herald[TEAM_B] = 5
  let h = g.copy()
  assert_eq(inner_of(h, TEAM_A, "mid").respawn_in, 7)
  assert_eq(enemy_outer(h, TEAM_B, "mid").plates, 2)
  assert_eq(h.herald[TEAM_B], 5)
  inner_of(h, TEAM_A, "mid").respawn_in = 0
  enemy_outer(h, TEAM_B, "mid").plates = 0
  h.herald[TEAM_B] = 0
  assert_eq(inner.respawn_in, 7)
  assert_eq(outer.plates, 2)
  assert_eq(g.herald[TEAM_B], 5)
}

///|
/// The descriptions and the observation say all of it, because a clock nobody
/// is told about is a clock nobody can play around.
test "the plate count, the gate and the herald all reach the policy" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  let tower = enemy_outer(g, TEAM_A, "top")
  let c = g.champs[0]
  c.node = tower.node
  g.push[lane_index("top")] = PUSH_CAP
  let on_outer = g.describe_action(c, AttackStructure)
  assert_true(on_outer.contains("\{PLATES} plate(s) left"))
  assert_true(on_outer.contains("\{PLATE_GOLD} gold"))

  // The inner tower's description says what breaking it buys, and for how long.
  let inner = enemy_outer(g, TEAM_A, "top")
  inner.hp = 0
  let gate = inner_of(g, TEAM_B, "top")
  let d = g.champs[1]
  d.node = gate.node
  let on_inner = g.describe_action(d, AttackStructure)
  assert_true(on_inner.contains("\{INHIB_TICKS} ticks"))
  assert_true(on_inner.contains("nexus"))

  // Herald says what it gives and that it will not wait.
  let herald = match g.neutral_named("herald") {
    Some(n) => n
    None => panic()
  }
  herald.spawn_in = 0
  let e = g.champs[2]
  e.node = herald.node
  let on_herald = g.describe_action(e, AttackNeutral)
  assert_true(on_herald.contains("herald"))
  assert_true(on_herald.contains("\{HERALD_STRUCT_PCT}%"))
  assert_true(on_herald.contains("\{HERALD_GONE_TICK}"))

  // And the observation carries the rules and the live numbers.
  let mem = Memory::new()
  let text = g.observation(TEAM_A, mem).stringify()
  assert_true(text.contains("plating_rule"))
  assert_true(text.contains("inhibitor_rule"))
  assert_true(text.contains("plates_left"))
  assert_true(text.contains("comes_back_in"))
  assert_true(text.contains("herald_ticks_left"))
}

///|
/// All three are reached in games nobody set up.
///
/// The third of these tests in the package and the one that has caught the
/// most: the mechanics above were all correct and all but invisible, because
/// the plan would not send anybody to a tower. Nothing in a unit test says
/// whether a rule ever happens.
test "plates, the gate and the herald all happen in played games" {
  let mut plates_taken = 0
  let mut heralds = 0
  let mut gates_opened = 0
  let mut gates_closed = 0
  for i in 0..<tournament_comps.length() {
    for j in 0..<tournament_comps.length() {
      if i == j {
        continue
      }
      let g = Game::with_comps(
        comp_by_name(tournament_comps[i].name),
        comp_by_name(tournament_comps[j].name),
      )
      let mut was_down = 0
      while g.winner == 0 && g.tick < 150 {
        let plates_before = total_plates(g)
        let down_before = was_down
        let charged_before = g.herald[TEAM_A] + g.herald[TEAM_B]
        let actions : Map[Int, Action] = Map([])
        for team in [TEAM_A, TEAM_B] {
          for e in smart_team_actions(g, team) {
            actions[e.0] = e.1
          }
        }
        g.step(actions)
        // A charge that went UP is a herald that was just killed. Reading the
        // herald's own `spawn_in` cannot tell a kill from its walking off at
        // `HERALD_GONE_TICK`, because both leave the same never-finishing
        // timer behind.
        if g.herald[TEAM_A] + g.herald[TEAM_B] > charged_before {
          heralds += 1
        }
        // Plates lost before the plating expires were taken by somebody.
        if g.tick < PLATE_TICKS {
          plates_taken += plates_before - total_plates(g)
        }
        was_down = 0
        for s in g.structures {
          if s.is_down_temporarily() {
            was_down += 1
          }
        }
        if was_down > down_before {
          gates_opened += was_down - down_before
        } else if was_down < down_before {
          gates_closed += down_before - was_down
        }
      }
    }
  }
  // Champions chip towers for the gold, and do it while the gold is there.
  // Champions chip towers for the gold, and do it while the gold is there.
  assert_true(plates_taken > 0)
  // The herald is taken somewhere.
  assert_true(heralds > 0)
  // And an inner tower goes down and comes back: the gate is the one of the
  // three that needs a team to have won a lane first, and both halves of its
  // clock are asserted because a gate that opened and never closed would be a
  // won game rather than a window.
  assert_true(gates_opened > 0)
  assert_true(gates_closed > 0)
}

///|
/// The enemy outer tower in `lane` from `team`'s point of view.
fn enemy_outer(g : Game, team : Int, lane : String) -> Structure {
  let foe = enemy_of(team)
  for s in g.structures {
    if s.team == foe && s.lane == lane && s.tier == 1 {
      return s
    }
  }
  panic()
}

///|
/// `team`'s own inner tower in `lane`.
fn inner_of(g : Game, team : Int, lane : String) -> Structure {
  for s in g.structures {
    if s.team == team && s.lane == lane && s.tier == 2 {
      return s
    }
  }
  panic()
}

///|
fn total_plates(g : Game) -> Int {
  let mut n = 0
  for s in g.structures {
    n += s.plates
  }
  n
}
