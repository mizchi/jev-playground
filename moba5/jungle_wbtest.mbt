///|
/// The jungle, counter-jungling, and the two kinds of ward.
///
/// All three used to be one thing that did nothing. A jungle node paid a flat
/// sixteen gold a tick for as long as a champion stood on it, so there was no
/// camp to take, no timer to plan around, and — because `a_jg_top` paid team B
/// exactly what it paid team A — nothing a counter-jungle could deny. Wards
/// existed but only added vision; there was no action in the game that took
/// any away.
///
/// The tests below state the rules. The two at the end ask the question no
/// unit test asks: does any of this happen in a game nobody set up.

///|
/// A camp is taken whole, once, and then it is gone for a while.
test "a camp pays its bounty once and goes on a timer" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  park_all(g)
  let c = g.champs[1]
  let camp_node = node_id("a_jg_top")
  c.node = camp_node
  let camp = match g.camp_at(camp_node) {
    Some(x) => x
    None => panic()
  }
  assert_true(camp.up())
  assert_eq(camp.side, TEAM_A)
  let gold = c.gold
  let xp = c.xp
  g.step(Map([(c.id, Farm)]))
  // The whole bounty at once, not a trickle.
  assert_eq(c.gold, gold + CAMP_GOLD)
  assert_eq(c.xp, xp + CAMP_XP)
  assert_eq(c.camps, 1)
  assert_false(camp.up())

  // Farming it again pays nothing at all while it is down.
  let after = c.gold
  g.step(Map([(c.id, Farm)]))
  assert_eq(c.gold, after)
  assert_eq(c.camps, 1)

  // And it comes back.
  while !camp.up() {
    g.step(Map([]))
  }
  let back = c.gold
  g.step(Map([(c.id, Farm)]))
  assert_eq(c.gold, back + CAMP_GOLD)
  assert_eq(c.camps, 2)
}

///|
/// Standing in the jungle earns nothing by itself. A lane does.
///
/// This is the rule that makes a jungler have to move: before it, one jungle
/// node was a better income than any lane and the answer to "where should the
/// jungler be" was the same every tick of every game.
test "the jungle has no passive income and a lane does" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  park_all(g)
  let in_jungle = g.champs[1]
  let in_lane = g.champs[2]
  in_jungle.node = node_id("a_jg_bot")
  in_lane.node = node_id("a1_mid")
  // Take the camp out of the picture, so what is left is the trickle alone.
  match g.camp_at(in_jungle.node) {
    Some(camp) => camp.down_for = CAMP_RESPAWN
    None => ()
  }
  let jg = in_jungle.gold
  let ln = in_lane.gold
  g.step(Map([(in_jungle.id, Hold), (in_lane.id, Hold)]))
  assert_eq(in_jungle.gold, jg)
  assert_eq(in_lane.gold, ln + LANE_TRICKLE)
  // And the trickle is strictly less than a minion, so it can never stand in
  // for the last hit.
  assert_true(LANE_TRICKLE < CS_GOLD)
}

///|
/// Every jungle node has a camp, each belongs to the side it sits in, and the
/// four are two a side.
test "there are four camps, two a side" {
  let g = Game::new()
  assert_eq(g.camps.length(), brush_nodes.length())
  let mut ours = 0
  let mut theirs = 0
  for camp in g.camps {
    assert_eq(camp.side, camp_side(camp.node))
    assert_true(camp.up())
    if camp.side == TEAM_A {
      ours += 1
    } else {
      theirs += 1
    }
  }
  assert_eq(ours, 2)
  assert_eq(theirs, 2)
  // And every jungle node has one, so `Farm` in the jungle always means a camp.
  for n in brush_nodes {
    assert_true(g.camp_at(n) is Some(_))
  }
}

///|
/// Counter-jungling: the same bounty, and the enemy loses the camp too.
test "taking their camp pays us and costs them" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  park_all(g)
  let c = g.champs[1]
  let theirs = node_id("b_jg_bot")
  c.node = theirs
  assert_eq(camp_side(theirs), TEAM_B)
  let gold = c.gold
  assert_eq(g.camps_lost[TEAM_B], 0)
  g.step(Map([(c.id, Farm)]))
  // Paid the same as our own camp would.
  assert_eq(c.gold, gold + CAMP_GOLD)
  // And counted against the side that lost it, which is where the price of a
  // counter-jungle belongs: the gold is ours, the denial is theirs.
  assert_eq(g.camps_lost[TEAM_B], 1)
  assert_eq(g.camps_lost[TEAM_A], 0)
  // Their jungler arriving now finds nothing.
  let theirs_jg = g.champs[6]
  theirs_jg.node = theirs
  let their_gold = theirs_jg.gold
  g.step(Map([(theirs_jg.id, Farm)]))
  assert_eq(theirs_jg.gold, their_gold)

  // Taking our OWN camp costs nobody anything.
  let mine = node_id("a_jg_top")
  c.node = mine
  g.step(Map([(c.id, Farm)]))
  assert_eq(g.camps_lost[TEAM_A], 0)
}

///|
/// The baseline crosses over only when its own half is empty, which is the
/// shape of the decision rather than a rule of the game.
test "the baseline counter-jungles when its own camps are down" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  park_all(g)
  let jg = g.champs[1]
  jg.node = node_id("a1_mid")
  // Ours up: no reason to cross.
  assert_false(g.counter_jungle_worth(TEAM_A, jg.node))
  assert_eq(camp_side(g.next_camp(TEAM_A, jg.node)), TEAM_A)
  // Ours down: theirs is worth the walk.
  for camp in g.camps {
    if camp.side == TEAM_A {
      camp.down_for = CAMP_RESPAWN
    }
  }
  assert_true(g.counter_jungle_worth(TEAM_A, jg.node))
  assert_eq(camp_side(g.next_camp(TEAM_A, jg.node)), TEAM_B)
  // Everything down: nothing to cross for, and the route goes to whichever of
  // ours is back first — it used to answer -1, "nowhere", which left the
  // jungler to drift with the group while its own camps ticked back.
  for camp in g.camps {
    camp.down_for = CAMP_RESPAWN
  }
  assert_false(g.counter_jungle_worth(TEAM_A, jg.node))
  assert_eq(camp_side(g.next_camp(TEAM_A, jg.node)), TEAM_A)
}

///|
/// The route reads the timers. A camp of ours that is back before we could
/// reach one of theirs is worth waiting for; one that is not, is not.
test "the route waits for our camp when it is back before theirs is reached" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  park_all(g)
  let jg = g.champs[1]
  let ours = node_id("a_jg_bot")
  jg.node = ours
  // Both of ours down; theirs all standing. b_jg_bot is two hops away,
  // through the drake pit.
  for camp in g.camps {
    if camp.side == TEAM_A {
      camp.down_for = CAMP_RESPAWN
    }
  }
  assert_eq(hops(ours, node_id("b_jg_bot")), 2)
  // Ours is back in one: stand on it rather than walk two hops into theirs.
  match g.camp_at(ours) {
    Some(camp) => camp.down_for = 1
    None => panic()
  }
  assert_eq(g.next_camp(TEAM_A, jg.node), ours)
  assert_false(g.counter_jungle_worth(TEAM_A, jg.node))
  // Back in exactly the walk: the same arrival either way, and the walk into
  // their half is the risk, so still ours.
  match g.camp_at(ours) {
    Some(camp) => camp.down_for = 2
    None => panic()
  }
  assert_eq(g.next_camp(TEAM_A, jg.node), ours)
  // Back in three: theirs is standing and nearer in time. Cross.
  match g.camp_at(ours) {
    Some(camp) => camp.down_for = 3
    None => panic()
  }
  assert_eq(g.next_camp(TEAM_A, jg.node), node_id("b_jg_bot"))
  assert_true(g.counter_jungle_worth(TEAM_A, jg.node))
  // And a standing camp of ours still beats any of theirs, however near —
  // the preference the timers overrule only when none of ours is up.
  match g.camp_at(node_id("a_jg_top")) {
    Some(camp) => camp.down_for = 0
    None => panic()
  }
  assert_eq(g.next_camp(TEAM_A, jg.node), node_id("a_jg_top"))
  assert_false(g.counter_jungle_worth(TEAM_A, jg.node))
}

///|
/// A control ward is bought against the wards the team can SEE, and put where
/// it clears the most of them.
test "the baseline's control ward reads only the wards it can see" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  park_all(g)
  let scout = g.champs[4]
  scout.node = RIV_BOT
  scout.gold = CONTROL_COST
  let their_jg = node_id("b_jg_bot")
  // One of theirs in a brush beside the pit. Standing on the pit does not see
  // into it, so the rules know it is there and the team does not.
  g.wards.push({
    node: their_jg,
    team: TEAM_B,
    kind: WARD_STEALTH,
    ttl: WARD_TTL,
  })
  assert_true(g.enemy_ward_near(TEAM_A, RIV_BOT))
  assert_false(g.vision(TEAM_A)[their_jg])
  assert_false(g.enemy_ward_seen_near(TEAM_A, RIV_BOT))
  assert_eq(g.visible_clears(TEAM_A, RIV_BOT), 0)
  let (_, clears) = g.control_ward_spot(scout, RIV_BOT)
  assert_eq(clears, 0)
  // So the baseline does not pay for it. It used to: `enemy_ward_near` read
  // the hidden ward and the pit got a control ward against nothing it knew of.
  let drake = match g.neutral_named("dragon") {
    Some(n) => n
    None => panic()
  }
  drake.spawn_in = 0
  // It spends the free charge on the pit instead — the 75 gold buys no item,
  // so nothing else competes for the turn.
  assert_true(scout.gold < COMPONENT_COST)
  assert_true(smart_action(g, scout, g.team_plan(TEAM_A)) == PlaceWard(RIV_BOT))
  // Once somebody stands in that brush the ward is seen, and it is cleared —
  // from the pit, which reaches it, on the tie with the brush itself.
  g.champs[3].node = their_jg
  assert_true(g.enemy_ward_seen_near(TEAM_A, RIV_BOT))
  let (spot, seen) = g.control_ward_spot(scout, RIV_BOT)
  assert_eq(seen, 1)
  assert_eq(spot, RIV_BOT)
}

///|
/// A control ward goes to the spot that clears the most, not to the pit by
/// habit.
test "the control ward goes where it clears the most" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  park_all(g)
  let scout = g.champs[4]
  let from = node_id("a_jg_bot")
  scout.node = from
  // Two of theirs on our side of the bot jungle, both in sight of the scout
  // standing in the brush: one in the brush itself, one in the lane beside
  // it. A control ward on the pit reaches the brush but not the lane.
  let lane = node_id("a1_bot")
  g.wards.push({ node: from, team: TEAM_B, kind: WARD_STEALTH, ttl: WARD_TTL, })
  g.wards.push({ node: lane, team: TEAM_B, kind: WARD_STEALTH, ttl: WARD_TTL, })
  assert_eq(g.visible_clears(TEAM_A, RIV_BOT), 1)
  assert_eq(g.visible_clears(TEAM_A, from), 2)
  let (spot, clears) = g.control_ward_spot(scout, RIV_BOT)
  assert_eq(spot, from)
  assert_eq(clears, 2)
}

///|
/// A copy carries the camps and their timers, and shares neither.
test "a copy carries the camps and does not share them" {
  let g = Game::new()
  let node = node_id("b_jg_top")
  match g.camp_at(node) {
    Some(camp) => camp.down_for = 5
    None => ()
  }
  g.camps_lost[TEAM_B] = 3
  let h = g.copy()
  assert_eq(
    match h.camp_at(node) {
      Some(c) => c.down_for
      None => -1
    },
    5,
  )
  assert_eq(h.camps_lost[TEAM_B], 3)
  match h.camp_at(node) {
    Some(camp) => camp.down_for = 0
    None => ()
  }
  h.camps_lost[TEAM_B] = 0
  assert_eq(
    match g.camp_at(node) {
      Some(c) => c.down_for
      None => -1
    },
    5,
  )
  assert_eq(g.camps_lost[TEAM_B], 3)
}

// ---------------------------------------------------------------- the wards

///|
/// A control ward costs gold rather than a charge, and clears what is there.
test "a control ward is bought with gold and clears their wards" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  park_all(g)
  let scout = g.champs[1]
  scout.node = RIV_TOP
  scout.wards = 0 // no charges at all: this is not a stealth ward
  scout.gold = CONTROL_COST

  // Two of theirs watching the pit: one on it, one next door.
  g.wards.push({
    node: RIV_TOP,
    team: TEAM_B,
    kind: WARD_STEALTH,
    ttl: WARD_TTL,
  })
  g.wards.push({
    node: node_id("b_jg_top"),
    team: TEAM_B,
    kind: WARD_STEALTH,
    ttl: WARD_TTL,
  })
  // And one of theirs far away, which must survive.
  g.wards.push({
    node: RIV_BOT,
    team: TEAM_B,
    kind: WARD_STEALTH,
    ttl: WARD_TTL,
  })
  assert_true(g.enemy_ward_near(TEAM_A, RIV_TOP))
  let legal = g.legal_actions(scout)
  assert_true(legal.contains(PlaceControl(RIV_TOP)))
  assert_false(legal.contains(PlaceWard(RIV_TOP))) // no charges

  g.step(Map([(scout.id, PlaceControl(RIV_TOP))]))
  assert_eq(scout.gold, 0)
  assert_eq(scout.wards, 0) // it cost gold, not a charge
  assert_false(g.enemy_ward_near(TEAM_A, RIV_TOP))
  // The far one is untouched.
  assert_eq(g.wards_of(TEAM_B).length(), 1)
  assert_eq(g.wards_of(TEAM_B)[0].node, RIV_BOT)
  // And ours is standing, as a control ward, for longer than a stealth one.
  assert_eq(g.wards_of(TEAM_A).length(), 1)
  assert_eq(g.wards_of(TEAM_A)[0].kind, WARD_CONTROL)
  assert_true(g.wards_of(TEAM_A)[0].ttl > WARD_TTL)
  assert_true(g.vision(TEAM_A)[RIV_TOP])
}

///|
/// It keeps clearing: a stealth ward cannot be dropped back under it.
test "a stealth ward under a live control ward does not survive the tick" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  park_all(g)
  let mine = g.champs[1]
  mine.node = RIV_BOT
  mine.gold = CONTROL_COST
  g.step(Map([(mine.id, PlaceControl(RIV_BOT))]))
  assert_eq(g.wards_of(TEAM_A).length(), 1)

  // One of theirs walks in and wards the same node. The charge is topped up
  // before each attempt, so what this measures is the sweep and not the
  // champion running out of wards.
  let theirs = g.champs[6]
  theirs.node = RIV_BOT
  theirs.wards = WARD_CHARGES
  g.step(Map([(theirs.id, PlaceWard(RIV_BOT))]))
  assert_eq(g.wards_of(TEAM_B).length(), 0)
  // A neighbour of it is no better.
  theirs.node = node_id("b_jg_bot")
  theirs.wards = WARD_CHARGES
  g.step(Map([(theirs.id, PlaceWard(theirs.node))]))
  assert_eq(g.wards_of(TEAM_B).length(), 0)
  // Somewhere out of range stands.
  theirs.node = RIV_TOP
  theirs.wards = WARD_CHARGES
  assert_false(adjacency[RIV_BOT].contains(RIV_TOP))
  g.step(Map([(theirs.id, PlaceWard(RIV_TOP))]))
  assert_eq(g.wards_of(TEAM_B).length(), 1)
}

///|
/// Control against control goes to whoever paid last, and only on placement.
///
/// Stated because the alternative is a rule with no stable answer: two control
/// wards sweeping each other every tick would both be gone, or neither,
/// depending on the order the list happened to hold them.
test "a control ward is cleared by a newer one and not by a standing one" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  park_all(g)
  let mine = g.champs[1]
  let theirs = g.champs[6]
  mine.node = RIV_TOP
  theirs.node = RIV_TOP
  mine.gold = CONTROL_COST
  theirs.gold = CONTROL_COST
  g.step(Map([(mine.id, PlaceControl(RIV_TOP))]))
  assert_eq(g.wards_of(TEAM_A).length(), 1)
  // Theirs lands second and takes the node.
  g.step(Map([(theirs.id, PlaceControl(RIV_TOP))]))
  assert_eq(g.wards_of(TEAM_A).length(), 0)
  assert_eq(g.wards_of(TEAM_B).length(), 1)
  // And it is not swept back out by anything standing: it stays until it
  // expires or somebody pays again.
  for _i in 0..<3 {
    g.step(Map([]))
  }
  assert_eq(g.wards_of(TEAM_B).length(), 1)
}

///|
/// Without the gold it is not on offer, which is what makes it compete with
/// the shop rather than being a second free charge.
test "a control ward is not legal without the gold" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  park_all(g)
  let c = g.champs[1]
  c.node = RIV_TOP
  c.gold = CONTROL_COST - 1
  assert_false(g.legal_actions(c).contains(PlaceControl(RIV_TOP)))
  c.gold = CONTROL_COST
  assert_true(g.legal_actions(c).contains(PlaceControl(RIV_TOP)))
  // Asking for one anyway changes nothing.
  c.gold = CONTROL_COST - 1
  g.step(Map([(c.id, PlaceControl(RIV_TOP))]))
  assert_eq(g.wards_of(TEAM_A).length(), 0)
  assert_eq(c.gold, CONTROL_COST - 1)
}

///|
/// The rules and the live numbers reach the policy. A camp timer nobody is
/// told about is a route nobody can plan, and a ward you cannot see is a ward
/// you cannot clear.
test "the jungle and the wards reach the observation" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("dive"))
  park_all(g)
  g.champs[1].node = RIV_TOP
  match g.camp_at(node_id("a_jg_bot")) {
    Some(camp) => camp.down_for = 4
    None => ()
  }
  g.camps_lost[TEAM_A] = 2
  g.wards.push({ node: RIV_TOP, team: TEAM_B, kind: WARD_CONTROL, ttl: 9, })
  g.wards.push({
    node: node_id("a_jg_bot"),
    team: TEAM_A,
    kind: WARD_STEALTH,
    ttl: 3,
  })
  let mem = Memory::new()
  let text = g.observation(TEAM_A, mem).stringify()
  // The camps, their sides and their clocks.
  assert_true(text.contains("jungle_rule"))
  assert_true(text.contains("comes_back_in"))
  assert_true(text.contains("camps_of_ours_they_took"))
  assert_true(text.contains("our_camps_up_now"))
  assert_true(text.contains("\{CAMP_GOLD} gold"))
  assert_true(text.contains("\{CAMP_RESPAWN} ticks"))
  // Both ward kinds, and the rule that one of them removes the other.
  assert_true(text.contains("ward_rule"))
  assert_true(text.contains("control"))
  assert_true(text.contains("stealth"))
  assert_true(text.contains("their_wards_we_can_see"))
  assert_true(text.contains("\{CONTROL_COST} gold"))
  // And the action descriptions say what the tick would actually do.
  let c = g.champs[1]
  c.gold = CONTROL_COST
  // Their control ward is on the node we are standing on, so it is in sight
  // and counted.
  assert_true(
    g
    .describe_action(c, PlaceControl(RIV_TOP))
    .contains("DESTROYS the 1 ward(s) of theirs we can see"),
  )
  let jg = g.champs[2]
  jg.node = node_id("b_jg_top")
  assert_true(g.describe_action(jg, Farm).contains("counter-jungle"))
  jg.node = node_id("a_jg_bot")
  assert_true(g.describe_action(jg, Farm).contains("comes back in 4"))
}

///|
/// The question no unit test asks: do camps, counter-jungling and control
/// wards happen in games nobody set up.
///
/// The first version of the camps answered no. The jungler only left the
/// group when the plan fell through to its last branch, and the reworked plan
/// almost never gets there, so three camps fell in a hundred and fifty ticks
/// and no team ever crossed over. The plan now frees the jungler whenever the
/// rally is a tower rather than a fight — `Plan::grouped` is that distinction,
/// and it exists because of this test.
test "the jungle and both ward kinds are used in played games" {
  let mut camps = 0
  let mut counters = 0
  let mut controls = 0
  let mut stealths = 0
  let mut clear_ticks = 0
  for i in 0..<tournament_comps.length() {
    for j in 0..<tournament_comps.length() {
      if i == j {
        continue
      }
      let g = Game::with_comps(
        comp_by_name(tournament_comps[i].name),
        comp_by_name(tournament_comps[j].name),
      )
      while g.winner == 0 && g.tick < 150 {
        let actions : Map[Int, Action] = Map([])
        for team in [TEAM_A, TEAM_B] {
          for e in smart_team_actions(g, team) {
            actions[e.0] = e.1
          }
        }
        for e in actions {
          match e.1 {
            PlaceControl(_) => controls += 1
            PlaceWard(_) => stealths += 1
            _ => ()
          }
        }
        g.step(actions)
      }
      // Placing a control ward and clearing something with it are different
      // events: one that lands on an unwarded node logs nothing. The engine
      // only writes the line when it swept at least one enemy ward, so this
      // counts ticks in which a control ward did its job — a lower bound on
      // the wards cleared, since one tick's events share a line.
      for line in g.log {
        if line.contains("enemy ward(s)") {
          clear_ticks += 1
        }
      }
      for c in g.champs {
        camps += c.camps
      }
      counters += g.camps_lost[TEAM_A] + g.camps_lost[TEAM_B]
    }
  }
  // Camps are farmed, in quantity, across every matchup.
  assert_true(camps > 100)
  // Somebody crosses over. It is the rarer of the two on purpose — their half
  // is unlit brush next to their lanes — but a counter-jungle that never
  // happens is a rule nothing exercises.
  assert_true(counters > 0)
  // Both ward kinds get placed.
  assert_true(stealths > 0)
  assert_true(controls > 0)
  // And the control ward is not just an expense: the vision war has two sides,
  // so somebody's ward actually comes off the map. This is the assertion the
  // first version of the test left out — it counted the wards placed and threw
  // the clears away, which is the difference between "used" and "worked".
  assert_true(clear_ticks > 0)
}

///|
/// Nothing the model reads counts a ward it cannot see.
///
/// The observation lists only `their_wards_we_can_see`, and two sentences used
/// to undo that: the control ward's action description and the `vision_sweep`
/// options both counted every ward in range, so "destroys 1" appeared beside
/// a pit with nothing of theirs in sight. Adding a ward nobody can see must not
/// change a word of the observation, the options or the actions — and must
/// still change the truth, because the ward really is there to destroy.
test "no description counts a ward the team cannot see" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  park_all(g)
  let scout = g.champs[4]
  scout.node = RIV_BOT
  scout.gold = CONTROL_COST
  // One of theirs we can see, on the pit.
  g.wards.push({
    node: RIV_BOT,
    team: TEAM_B,
    kind: WARD_STEALTH,
    ttl: WARD_TTL,
  })
  // And one we cannot, in the brush beside it.
  let hidden = node_id("b_jg_bot")
  assert_false(g.vision(TEAM_A)[hidden])
  let h = g.copy()
  h.wards.push({
    node: hidden,
    team: TEAM_B,
    kind: WARD_STEALTH,
    ttl: WARD_TTL,
  })
  let (seen_g, _) = observe(g, TEAM_A)
  let (seen_h, _) = observe(h, TEAM_A)
  assert_eq(seen_g.stringify(), seen_h.stringify())
  let ask_g = ask_vision_sweep(g, TEAM_A, scout.id)
  let ask_h = ask_vision_sweep(h, TEAM_A, scout.id)
  assert_eq(ask_g.options, ask_h.options)
  assert_eq(ask_g.descriptions, ask_h.descriptions)
  assert_eq(ask_g.instructions, ask_h.instructions)
  for n in ward_spots(RIV_BOT) {
    assert_eq(
      g.describe_action(scout, PlaceControl(n)),
      h.describe_action(h.champs[4], PlaceControl(n)),
    )
  }
  // The truth is the rules' answer, and the rules see it: with the hidden ward
  // the pit and that brush each destroy two, without it every spot destroys one.
  assert_true(ask_g.truth != ask_h.truth)
}
