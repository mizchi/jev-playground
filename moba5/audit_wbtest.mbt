///|
test "the audit accounts for every point of gold and experience the engine pays" {
  // Game by game through the tournament field, until every source the audit
  // has to read off an event rather than a counter has come up at least once:
  // a plate, a structure lost to champions and one lost to minions, a drake,
  // the Herald and Baron. The property holds tick by tick, so each game is
  // checked on its own. No game is chosen by name, so a rule change cannot
  // break this test just by changing what one particular game contains — the
  // first version named four, and a cheaper control ward took the plates out
  // of all of them.
  let mut plates = false
  let mut by_champs = false
  let mut by_minions = false
  let mut drake = false
  let mut herald = false
  let mut baron = false
  for i in 0..<tournament_comps.length() {
    for j in 0..<tournament_comps.length() {
      let seen_all = plates &&
        by_champs &&
        by_minions &&
        drake &&
        herald &&
        baron
      if i == j || seen_all {
        continue
      }
      let a = audit_games(
        [(tournament_comps[i].picks, tournament_comps[j].picks)],
        "smart",
        150,
      )
      assert_eq(a.unaccounted_gold, 0)
      assert_eq(a.unaccounted_xp, 0)
      // The tower bounty is what is left once everything else is placed, so
      // it has to come to exactly one bounty per structure the champions
      // destroyed — anything else would be a source the audit does not know.
      assert_eq(a.gold[6], TOWER_GOLD * a.towers_by_champs)
      // Plates pay gold and never experience.
      assert_eq(a.xp[5], 0)
      plates = plates || a.plates_taken > 0
      by_champs = by_champs || a.towers_by_champs > 0
      by_minions = by_minions || a.towers_by_minions > 0
      drake = drake || a.drakes > 0
      herald = herald || a.heralds > 0
      baron = baron || a.barons > 0
    }
  }
  assert_true(plates && by_champs && by_minions && drake && herald && baron)
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
