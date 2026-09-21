///|
/// Last hitting: the rule, and the price of not doing it.
///
/// `Farm` paid a flat camp before this, so a policy could not be wrong about
/// farming — only about where it stood. The gold now goes to whoever lands the
/// killing blow, which means every other action in a lane has a cost, and the
/// cost is exactly countable. These tests pin that arithmetic, because a
/// laning economy that is wrong by a few gold a tick is a laning economy that
/// is wrong by an item by tick 40, and no game's outcome would say which.

///|
/// A lane brings minions low for both sides, up to the cap, and stops there.
test "an abandoned lane stacks up to the cap and no further" {
  let g = Game::new()
  // Send everybody home so no champion is standing in any lane.
  for c in g.champs {
    c.node = base_of(c.team)
  }
  let mid = ripe_index("mid", TEAM_A)
  assert_true(mid >= 0)
  assert_eq(g.ripe[mid], 0)
  for i in 1..<=(CS_RIPE_CAP + 3) {
    g.step(Map([]))
    let want = if i < CS_RIPE_CAP { i } else { CS_RIPE_CAP }
    assert_eq(g.ripe[mid], want)
  }
  // Both sides of the lane accrue: a last hit is taken from the enemy's wave,
  // so each team has its own minions to kill.
  assert_eq(g.ripe[ripe_index("mid", TEAM_B)], CS_RIPE_CAP)
}

///|
/// Farming takes everything ripe, and pays per minion.
test "farming banks the ripe minions and resets the lane" {
  let g = Game::new()
  for c in g.champs {
    c.node = base_of(c.team)
  }
  // Let the mid wave stack, with nobody there.
  for _i in 0..<CS_RIPE_CAP {
    g.step(Map([]))
  }
  let ri = ripe_index("mid", TEAM_A)
  assert_eq(g.ripe[ri], CS_RIPE_CAP)

  // Now walk one champion in and farm it.
  let c = g.champs[2]
  c.node = node_id("a1_mid")
  assert_eq(node_lane[c.node], "mid")
  let gold_before = c.gold
  let cs_before = c.cs
  let banked = g.ripe[ri]
  g.step(Map([(c.id, Farm)]))
  assert_eq(c.cs, cs_before + banked)
  // The gold is the minions plus the passive trickle every champion in a lane
  // gets, so the test asserts the minion part is present rather than the total.
  assert_true(c.gold >= gold_before + banked * CS_GOLD)
  // Took everything, then one more came low.
  assert_eq(g.ripe[ri], 1)
  assert_eq(c.cs_lost, 0)
}

///|
/// Farming an empty lane pays nothing. The point of the rule: a turn spent on
/// a wave with nothing low is a wasted turn, and the description says so.
test "farming a lane with nothing low pays nothing" {
  let g = Game::new()
  for c in g.champs {
    c.node = base_of(c.team)
  }
  let c = g.champs[2]
  c.node = node_id("a1_mid")
  let ri = ripe_index("mid", TEAM_A)
  // Farm twice in a row: the second tick has only the one minion that came low
  // at the end of the first, so it cannot pay more than one minion.
  g.step(Map([(c.id, Farm)]))
  let after_first = c.cs
  g.ripe[ri] = 0
  let gold = c.gold
  g.step(Map([(c.id, Farm)]))
  assert_eq(c.cs, after_first)
  // Only the passive trickle moved, which is strictly less than a minion.
  assert_true(c.gold - gold < CS_GOLD)
}

///|
/// Standing in a lane and doing something else costs exactly what was ripe.
///
/// This is the trade-off the whole mechanic exists to create, so it is stated
/// as an equality rather than a direction.
test "a tick spent not farming costs exactly the minions that were low" {
  let g = Game::new()
  for c in g.champs {
    c.node = base_of(c.team)
  }
  let c = g.champs[2]
  c.node = node_id("a1_mid")
  let ri = ripe_index("mid", TEAM_A)
  g.ripe[ri] = 2
  let lost_before = c.cs_lost
  let cs_before = c.cs
  // `Hold` is the cheapest "something else" there is, so nothing but the rule
  // under test can move these counters.
  g.step(Map([(c.id, Hold)]))
  assert_eq(c.cs_lost, lost_before + 2)
  assert_eq(c.cs, cs_before)
  // The two that were low are gone; one new one came low.
  assert_eq(g.ripe[ri], 1)
}

///|
/// The cost falls on whoever is standing there, and only on them.
test "the miss is charged to the champions in that lane" {
  let g = Game::new()
  for c in g.champs {
    c.node = base_of(c.team)
  }
  let in_lane = g.champs[2]
  let elsewhere = g.champs[0]
  in_lane.node = node_id("a1_mid")
  elsewhere.node = node_id("a1_top")
  g.ripe[ripe_index("mid", TEAM_A)] = 2
  g.ripe[ripe_index("top", TEAM_A)] = 0
  g.step(Map([]))
  assert_eq(in_lane.cs_lost, 2)
  // The champion in the top lane had nothing low to lose, so it is charged
  // nothing — the counter is per lane, not per team.
  assert_eq(elsewhere.cs_lost, 0)
}

///|
/// A copy carries the wave. The oracle plays every situation out on copies, so
/// a `ripe` array shared or dropped by `Game::copy` would make the benchmark's
/// truths disagree with the game they claim to describe.
test "a copy carries the wave, and does not share it" {
  let g = Game::new()
  let ri = ripe_index("bot", TEAM_B)
  g.ripe[ri] = 2
  let c = g.copy()
  assert_eq(c.ripe[ri], 2)
  c.ripe[ri] = 0
  assert_eq(g.ripe[ri], 2)
}

///|
/// The description a policy actually reads names the number it has to decide
/// on. A `Farm` that does not say what it pays is a decision made blind.
test "the farm description names the minions it would take" {
  let g = Game::new()
  let c = g.champs[2]
  c.node = node_id("a1_mid")
  g.ripe[ripe_index("mid", TEAM_A)] = 2
  let with_two = g.describe_action(c, Farm)
  assert_true(with_two.contains("2 minion"))
  assert_true(with_two.contains("\{2 * CS_GOLD} gold"))
  g.ripe[ripe_index("mid", TEAM_A)] = 0
  let with_none = g.describe_action(c, Farm)
  assert_true(with_none.contains("0 gold"))
}
