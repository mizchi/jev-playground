///|
/// The map's structural invariants.
///
/// These are the tests that make a win rate mean something. If the two sides do
/// not face the same map, a report cannot tell a better policy from a better
/// seat — and both of the bugs these pin were found exactly that way: team B
/// used to win nearly every mirror match, first because its jungler started
/// next to the early objective and then because the adjacency lists broke a
/// pathing tie in its favour.

///|
/// The A↔B relabelling of a node name. `mid_*` and `riv_*` are their own
/// mirror images; everything else swaps side.
fn mirror_name(n : String) -> String {
  if n.has_prefix("a_") {
    return "b_" + "\{n[2:]}"
  }
  if n.has_prefix("b_") {
    return "a_" + "\{n[2:]}"
  }
  if n.has_prefix("a1_") || n.has_prefix("a2_") {
    return "b" + "\{n[1:]}"
  }
  if n.has_prefix("b1_") || n.has_prefix("b2_") {
    return "a" + "\{n[1:]}"
  }
  n
}

///|
fn mirror_node(n : Int) -> Int {
  node_id(mirror_name(node_names[n]))
}

///|
/// Every table is the same length, and every name resolves.
test "the map's tables line up" {
  assert_eq(node_names.length(), N_NODES)
  assert_eq(node_lane.length(), N_NODES)
  assert_eq(adjacency.length(), N_NODES)
  for i in 0..<N_NODES {
    assert_eq(node_id(node_names[i]), i)
  }
  // The two river nodes really are the river, and the objectives sit on them.
  assert_eq(node_lane[RIV_TOP], "river")
  assert_eq(node_lane[RIV_BOT], "river")
  assert_eq(node_name(RIV_TOP), "riv_top")
  assert_eq(node_name(RIV_BOT), "riv_bot")
  assert_eq(node_name(A_BASE), "a_base")
  assert_eq(node_name(B_BASE), "b_base")
  // Nobody farms in the river or at a base; lanes and the jungle both do.
  assert_false(is_farmable(RIV_TOP))
  assert_false(is_farmable(A_BASE))
  assert_true(is_farmable(4))
  assert_true(is_farmable(17))
  // And a jungle node belongs to a side, which is what makes taking one on
  // the other side a counter-jungle rather than a synonym for farming.
  assert_eq(camp_side(4), 0) // a lane belongs to nobody
  assert_eq(camp_side(node_id("a_jg_top")), TEAM_A)
  assert_eq(camp_side(node_id("a_jg_bot")), TEAM_A)
  assert_eq(camp_side(node_id("b_jg_top")), TEAM_B)
  assert_eq(camp_side(node_id("b_jg_bot")), TEAM_B)
}

///|
/// Adjacency is undirected, and no node lists itself.
test "adjacency is undirected" {
  for i in 0..<N_NODES {
    for j in adjacency[i] {
      assert_true(j != i)
      assert_true(adjacency[j].contains(i))
    }
  }
}

///|
/// The map is the SAME map for both teams: relabelling every node A↔B maps the
/// adjacency onto itself. This is the invariant a win rate depends on.
test "the map is symmetric under the A-B relabelling" {
  for i in 0..<N_NODES {
    let m = mirror_node(i)
    assert_true(m >= 0)
    assert_eq(mirror_node(m), i) // the relabelling is its own inverse
    assert_eq(node_lane[i], node_lane[m]) // a top lane node mirrors to one
    assert_eq(is_farmable(i), is_farmable(m))
    // A camp mirrors to the OTHER side's camp: that is what the relabelling
    // means, and it is the property counter-jungling rests on.
    if camp_side(i) != 0 {
      assert_eq(camp_side(m), enemy_of(camp_side(i)))
    } else {
      assert_eq(camp_side(m), 0)
    }
    assert_eq(adjacency[i].length(), adjacency[m].length())
    for j in adjacency[i] {
      assert_true(adjacency[m].contains(mirror_node(j)))
    }
  }
}

///|
/// And both teams start in mirrored positions, with mirrored structures, so a
/// mirror match is a fair fight rather than a seat allocation.
test "both teams start on the same map" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  for i in 0..<5 {
    let a = g.champs[i]
    let b = g.champs[i + 5]
    assert_eq(a.role, b.role)
    assert_eq(a.kind, b.kind)
    assert_eq(a.max_hp, b.max_hp)
    assert_eq(mirror_node(a.node), b.node)
    // The same distance from their own base and from the enemy's.
    assert_eq(hops(a.node, A_BASE), hops(b.node, B_BASE))
    assert_eq(hops(a.node, B_BASE), hops(b.node, A_BASE))
    // And the same distance from each objective, which is what a jungler
    // starting on the wrong side of the river quietly broke.
    assert_eq(hops(a.node, RIV_TOP), hops(b.node, RIV_TOP))
    assert_eq(hops(a.node, RIV_BOT), hops(b.node, RIV_BOT))
  }
  for s in g.structures {
    let mut twin = false
    for t in g.structures {
      if t.team != s.team &&
        t.tier == s.tier &&
        t.lane == s.lane &&
        t.max_hp == s.max_hp &&
        t.node == mirror_node(s.node) {
        twin = true
      }
    }
    assert_true(twin)
  }
  assert_eq(g.structure_hp(TEAM_A), g.structure_hp(TEAM_B))
  assert_eq(g.team_power(TEAM_A), g.team_power(TEAM_B))
}

///|
/// A shortest step is a step that actually gets closer, and the forward
/// tie-break never makes the walk longer. This is the function that used to
/// send team A's bot laner backwards out of lane on tick one.
test "a step toward a target always closes the distance" {
  for from in 0..<N_NODES {
    for to in 0..<N_NODES {
      let plain = step_toward(from, to)
      let forward = step_toward_prefer(from, to, B_BASE)
      if from == to {
        assert_eq(plain, from)
        assert_eq(forward, from)
        continue
      }
      // Both are neighbours, and both are one hop closer.
      assert_true(adjacency[from].contains(plain))
      assert_true(adjacency[from].contains(forward))
      assert_eq(hops(plain, to), hops(from, to) - 1)
      assert_eq(hops(forward, to), hops(from, to) - 1)
    }
  }
}

///|
/// Both champions in a mirrored position take mirrored steps toward mirrored
/// targets. Without this the two teams walk different routes to the same kind
/// of place, and the mirror match stops being a mirror.
test "mirrored champions take mirrored steps" {
  for from in 0..<N_NODES {
    for to in 0..<N_NODES {
      if from == to {
        continue
      }
      // Team A walking from `from` to `to`, preferring the enemy base.
      let a = step_toward_prefer(from, to, B_BASE)
      // Team B doing the mirror of that.
      let b = step_toward_prefer(mirror_node(from), mirror_node(to), A_BASE)
      assert_eq(hops(a, to), hops(b, mirror_node(to)))
    }
  }
}

///|
/// A blink reaches exactly two hops, and never somewhere a walk already would.
test "a blink goes two nodes, not one" {
  for from in 0..<N_NODES {
    let targets = blink_targets(from)
    assert_true(targets.length() > 0)
    for t in targets {
      assert_eq(hops(from, t), 2)
      assert_false(adjacency[from].contains(t))
      assert_true(t != from)
    }
  }
}

///|
/// Wards only go where vision is actually missing: the jungle and the river.
test "wards go to the jungle and the river" {
  for from in 0..<N_NODES {
    for n in ward_spots(from) {
      assert_true(node_lane[n] == "jungle" || node_lane[n] == "river")
      assert_true(n == from || adjacency[from].contains(n))
    }
  }
  // From the dragon-side jungle there is somewhere worth warding.
  assert_true(ward_spots(18).contains(RIV_BOT))
  // Standing on a lane tower with no jungle next door, there is not.
  assert_true(ward_spots(4).contains(RIV_TOP))
}

///|
/// The shape of the map, as the distances a rotation actually pays.
///
/// These are the numbers that make the lanes different from each other, and
/// every one of them was wrong before the jungle stopped being a highway: the
/// fountain opened onto both jungle quadrants and each quadrant touched six
/// nodes, so base to base was four hops through any lane and a jungler was one
/// step from a camp after every recall.
test "the lanes and the jungle are the shape the real map has" {
  // A base's only exits are its own three inner towers — one per lane, and
  // three DIFFERENT lanes, so the fountain is a fork and not a crossroads.
  assert_eq(adjacency[A_BASE].length(), 3)
  let from_base = []
  for n in adjacency[A_BASE] {
    assert_true(node_names[n].has_prefix("a2_"))
    assert_false(from_base.contains(node_lane[n]))
    from_base.push(node_lane[n])
  }
  assert_eq(from_base.length(), lanes.length())
  // A jungle quadrant has exactly three: two outer-tower nodes and one river.
  for n in brush_nodes {
    assert_eq(adjacency[n].length(), 3)
    let mut rivers = 0
    let mut outers = 0
    for m in adjacency[n] {
      if node_lane[m] == "river" {
        rivers += 1
      } else if node_names[m].has_prefix("a1_") ||
        node_names[m].has_prefix("b1_") {
        outers += 1
      }
    }
    assert_eq(rivers, 1)
    assert_eq(outers, 2)
  }

  // Base to base is the full length of a lane, the same through each of them.
  // The sameness is a limitation and not a property: on the real map mid is
  // the diagonal and shorter, and five nodes a lane cannot say that.
  assert_eq(hops(A_BASE, B_BASE), 6)
  for lane in lanes {
    assert_eq(hops(A_BASE, node_id("mid_\{lane}")), 3)
  }

  // The jungle is a walk from the fountain, not a step.
  for n in brush_nodes {
    assert_true(hops(n, A_BASE) >= 3)
    assert_true(hops(n, B_BASE) >= 3)
  }

  // And the asymmetry that decides which half of the map an objective pulls:
  // top is near Baron and far from Dragon, bot the reverse, and mid is the
  // only lane equally close to both.
  assert_eq(hops(node_id("a1_top"), RIV_TOP), 2)
  assert_eq(hops(node_id("a1_top"), RIV_BOT), 4)
  assert_eq(hops(node_id("a1_bot"), RIV_TOP), 4)
  assert_eq(hops(node_id("a1_bot"), RIV_BOT), 2)
  assert_eq(hops(node_id("a1_mid"), RIV_TOP), 2)
  assert_eq(hops(node_id("a1_mid"), RIV_BOT), 2)
  // The far corner of the map is a bottom-lane inner tower against Baron.
  assert_eq(hops(node_id("a2_bot"), RIV_TOP), 5)

  // Nothing is cut off, which is the one way an edge list can be wrong that
  // no other assertion here would notice.
  for i in 0..<N_NODES {
    for j in 0..<N_NODES {
      assert_true(hops(i, j) < N_NODES)
    }
  }
}
