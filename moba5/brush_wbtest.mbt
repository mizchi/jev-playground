///|
/// The brush rule, which is a vision rule and therefore the easiest kind of
/// rule to get backwards without noticing.
///
/// Vision bugs do not show up in a game's outcome — they show up as a policy
/// that looks careless. These tests state the asymmetry in both directions and
/// pin the two things that would quietly undo it: a brush set that is empty
/// (the rule never fires) or that covers the map (nobody sees anything).

///|
/// The brush set is a real subset: some nodes are cover and some are not.
test "brush is some of the map, not none and not all" {
  assert_true(brush_nodes.length() > 0)
  assert_true(brush_nodes.length() < N_NODES)
  for n in brush_nodes {
    assert_true(is_brush(n))
  }
  // The river is not brush. Both teams have to be able to see an objective's
  // pit to plan around its timer, and hiding it would make the macro question
  // a coin flip rather than a read.
  assert_false(is_brush(RIV_TOP))
  assert_false(is_brush(RIV_BOT))
  // Nor are the bases or the lanes.
  assert_false(is_brush(A_BASE))
  assert_false(is_brush(B_BASE))
  assert_false(is_brush(node_id("mid_mid")))
}

///|
/// Brush is mirrored under the A↔B relabelling, like every other map table.
///
/// The map's two side-advantage bugs were both asymmetries nobody could see
/// from watching a game, and a brush on one side only would be a third.
test "brush is symmetric under the A-B relabelling" {
  for i in 0..<N_NODES {
    assert_eq(is_brush(i), is_brush(mirror_node(i)))
  }
}

///|
/// The rule, in both directions, on the live game.
test "you cannot see into a brush from outside, and you can see out from in" {
  let g = Game::new()
  let brush = node_id("a_jg_top")
  assert_true(is_brush(brush))
  let outside = lane_beside(brush)
  assert_true(outside >= 0)

  // One champion of team A, standing outside.
  park_all_to(g, A_BASE)
  g.champs[0].node = outside
  let from_outside = g.vision(TEAM_A)
  assert_true(from_outside[outside]) // where we stand
  assert_false(from_outside[brush]) // the cover next to us

  // The same champion, standing in the brush.
  g.champs[0].node = brush
  let from_inside = g.vision(TEAM_A)
  assert_true(from_inside[brush]) // where we stand
  assert_true(from_inside[outside]) // and out, as normal
}

///|
/// An enemy in a brush is not a visible enemy; the same enemy one step out is.
///
/// This is the rule as a policy meets it — through `visible_enemies`, which is
/// what the observation is built from — rather than through the vision array.
test "an enemy waiting in a brush is not in the visible list" {
  let g = Game::new()
  let brush = node_id("b_jg_top")
  let outside = lane_beside(brush)
  assert_true(outside >= 0)
  park_all_to(g, A_BASE)
  // One of ours next to the brush, one of theirs inside it.
  g.champs[0].node = outside
  for i in 5..<10 {
    g.champs[i].node = B_BASE
  }
  g.champs[5].node = brush
  assert_eq(g.visible_enemies(TEAM_A).length(), 0)
  // Step it out of cover and it is seen.
  g.champs[5].node = outside
  let seen = g.visible_enemies(TEAM_A)
  assert_eq(seen.length(), 1)
  assert_eq(seen[0].id, 5)
}

///|
/// A ward in a brush is the counter-play, and the only one from outside.
test "a ward inside a brush reveals it" {
  let g = Game::new()
  let brush = node_id("a_jg_bot")
  park_all_to(g, A_BASE)
  g.champs[0].node = A_BASE
  assert_false(g.vision(TEAM_A)[brush])
  g.wards.push({ node: brush, team: TEAM_A, kind: WARD_STEALTH, ttl: WARD_TTL, })
  assert_true(g.vision(TEAM_A)[brush])
  // And it expires, so the cover comes back.
  g.wards[0].ttl = 0
  assert_false(g.vision(TEAM_A)[brush])
}

///|
/// Put every champion on one node. A test-local helper: `Game::place_all` is
/// the shipped one, and using it here would hide a champion in the brush by
/// accident.
fn park_all_to(g : Game, node : Int) -> Unit {
  for c in g.champs {
    c.node = node
  }
}

///|
/// A neighbour of `brush` that is neither brush nor a base.
///
/// "Any non-brush neighbour" is not good enough and the first version of these
/// tests proved it: `b_jg_top` touches `b_base`, so standing "outside" the
/// brush put the champion in the enemy fountain and it saw the four champions
/// parked there. The rule was right; the test was standing in the wrong place.
fn lane_beside(brush : Int) -> Int {
  for n in adjacency[brush] {
    if !is_brush(n) && n != A_BASE && n != B_BASE {
      return n
    }
  }
  -1
}
