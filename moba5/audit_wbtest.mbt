///|
test "the audit accounts for every point of gold and experience the engine pays" {
  // Four of the tournament's games rather than all seventy-two. The property
  // holds tick by tick, and between them these four break plates, lose towers
  // to champions and to minions, and give up drakes, the Herald and Baron —
  // every source the audit has to read off an event rather than a counter.
  let a = audit_games(
    [
      (comp_by_name("meta"), comp_by_name("dive")),
      (comp_by_name("poke"), comp_by_name("glass_ad")),
      (comp_by_name("glass_ad"), comp_by_name("early")),
      (comp_by_name("dive"), comp_by_name("early")),
    ],
    "smart",
    150,
  )
  assert_eq(a.unaccounted_gold, 0)
  assert_eq(a.unaccounted_xp, 0)
  // The tower bounty is what is left once everything else is placed, so it
  // has to come to exactly one bounty per structure the champions destroyed —
  // anything else would be a source the audit does not know about.
  assert_eq(a.gold[6], TOWER_GOLD * a.towers_by_champs)
  assert_true(a.plates_taken > 0)
  assert_true(a.towers_by_champs > 0 && a.towers_by_minions > 0)
  assert_true(a.drakes > 0 && a.heralds > 0 && a.barons > 0)
  // Plates pay gold and never experience.
  assert_eq(a.xp[5], 0)
}

///|
test "the audit's full build is the shop's ceiling and fits the bag" {
  for kind in ["marksman", "tank"] {
    let build = audit_full_build(kind)
    assert_eq(build.length(), ITEM_SLOTS)
    let mut cost = 0
    for key in build {
      cost += item_total_cost(key)
    }
    assert_eq(cost, ITEM_SLOTS * BIG_ITEM_COST)
  }
}
