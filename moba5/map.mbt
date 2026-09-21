///|
/// The 5v5 map: three lanes, two jungles, and a river with two epic monsters.
///
/// Still a graph rather than a plane — the decision under study is "where do I
/// go and what do I hit", not pathfinding — but the graph is now the shape a
/// real MOBA has, and that shape is what generates the decisions the 3v3
/// prototype could not pose:
///
/// ```text
///          a2_top --- a1_top --- mid_top --- b1_top --- b2_top
///         /              |          |           |             \
///        /          a_jg_top --- riv_top --- b_jg_top          \
///       /           /      \       |        /      \            \
/// a_base --- a2_mid --- a1_mid - mid_mid - b1_mid --- b2_mid --- b_base
///       \           \      /       |        \      /            /
///        \          a_jg_bot --- riv_bot --- b_jg_bot          /
///         \              |          |           |             /
///          a2_bot --- a1_bot --- mid_bot --- b1_bot --- b2_bot
/// ```
///
/// - **Three lanes** (top / mid / bot) with two towers a side: the outer `a1_`
///   tower falls first, then the inner `a2_`. A team's nexus can only be hit
///   once one whole lane is open — both of that lane's towers down — so a
///   single lane's worth of siege wins the game, which is why lane pressure
///   matters here and did not in the 3v3 map.
/// - **Two jungles**, one per side, each touching its own lanes and the river.
///   The jungle is how a team crosses the map without walking a lane, so it is
///   both the rotation route and the place ambushes come from.
/// - **A river** with `riv_top` (Baron) and `riv_bot` (Dragon). These are the
///   two nodes both teams want and neither owns, and they sit off-lane, so
///   contesting one means leaving a lane — the central macro trade of the genre.

///|
pub const N_NODES = 23

///|
pub const A_BASE = 0

///|
pub const B_BASE = 1

///|
/// The Baron pit. Taking it grants a strong, temporary, team-wide buff.
pub const RIV_TOP = 20

///|
/// The Dragon pit. Taking it grants a small, permanent, stacking buff.
pub const RIV_BOT = 21

///|
/// Node names, in id order. `a_`/`b_` is the side of the map, `1` is the outer
/// tower node and `2` the inner one, so `a1_top` is further from a_base than
/// `a2_top` — the same reading as a lane diagram.
pub let node_names : Array[String] = [
  // 0..1 bases
  "a_base", "b_base",
  // 2..6 top lane, a side to b side
   "a2_top", "a1_top", "mid_top", "b1_top", "b2_top",
  // 7..11 mid lane
   "a2_mid", "a1_mid", "mid_mid", "b1_mid", "b2_mid",
  // 12..16 bot lane
   "a2_bot", "a1_bot", "mid_bot", "b1_bot", "b2_bot",
  // 17..19 jungle quadrants (the fourth is 22, after the river)
   "a_jg_top", "a_jg_bot", "b_jg_top",
  // 20..21 river
   "riv_top", "riv_bot",
  // 22 the last jungle quadrant
   "b_jg_bot",
]

///|
/// Which lane a node belongs to, for readable state and for lane-loyal bots.
/// `river` is its own thing: it is nobody's lane, which is the point of it.
pub let node_lane : Array[String] = [
  "base", "base", "top", "top", "top", "top", "top", "mid", "mid", "mid", "mid",
  "mid", "bot", "bot", "bot", "bot", "bot", "jungle", "jungle", "jungle", "river",
  "river", "jungle",
]

///|
/// The three lanes a structure can sit in, in the order reports print them.
pub let lanes : Array[String] = ["top", "mid", "bot"]

///|
/// Undirected adjacency. A champion may move to any neighbour in one tick;
/// `Blink` reaches a neighbour's neighbour.
pub let adjacency : Array[Array[Int]] = [
  [2, 7, 12, 17, 18], // 0  a_base
  [6, 11, 16, 19, 22], // 1  b_base
  [0, 3, 17], // 2  a2_top
  [2, 4, 17], // 3  a1_top
  [3, 5, 20], // 4  mid_top
  [4, 6, 19], // 5  b1_top
  [1, 5, 19], // 6  b2_top
  [0, 8, 17, 18], // 7  a2_mid
  [7, 9, 17, 18], // 8  a1_mid
  [8, 10, 20, 21], // 9  mid_mid
  [9, 11, 19, 22], // 10 b1_mid
  [1, 10, 19, 22], // 11 b2_mid
  [0, 13, 18], // 12 a2_bot
  [12, 14, 18], // 13 a1_bot
  [13, 15, 21], // 14 mid_bot
  [14, 16, 22], // 15 b1_bot
  [1, 15, 22], // 16 b2_bot
  [0, 2, 3, 7, 8, 20], // 17 a_jg_top
  [0, 7, 8, 12, 13, 21], // 18 a_jg_bot
  [1, 5, 6, 10, 11, 20], // 19 b_jg_top
  [4, 9, 17, 19], // 20 riv_top  (Baron)
  [9, 14, 18, 22], // 21 riv_bot  (Dragon)
  [1, 10, 11, 15, 16, 21], // 22 b_jg_bot
]

///|
/// Whether a node is brush: vision does not reach into it from outside.
///
/// Every other node is seen by standing next to it, which made the map's
/// unlit half a formality — a jungler crossing it was visible to both lanes it
/// ran between, so there was nowhere to wait and nothing a ward bought that
/// standing nearby did not. Brush is the rule that makes the space real, and
/// it is asymmetric on purpose: **from inside a brush you see out normally,
/// and from outside you see nothing of it**. That is what an ambush is, and it
/// is why a ward placed in one is worth a turn.
///
/// The four jungle quadrants are the brush here. In a game with a plane the
/// brush is a patch inside the jungle; in a graph the quadrant IS the patch
/// you wait in, and it already sits between the lanes it threatens, so the
/// decision it creates — "their jungler could be in there, do I push up" —
/// is the same one. The river is deliberately NOT brush: both teams need to
/// see an objective's pit to plan around its timer, and hiding it would turn
/// the macro question into a coin flip.
pub fn is_brush(node : Int) -> Bool {
  node_lane[node] == "jungle"
}

///|
/// Every brush node, in id order. For the observation, and for the tests that
/// check the set is neither empty nor the whole map.
pub let brush_nodes : Array[Int] = {
  let out : Array[Int] = []
  for i in 0..<N_NODES {
    if is_brush(i) {
      out.push(i)
    }
  }
  out
}

///|
/// What one tick of farming pays at a node, in gold. Lane minions are safe but
/// thin; a jungle camp pays better and is off-lane, which is the trade that
/// makes a jungler a distinct role rather than a fourth laner.
pub fn camp_gold(node : Int) -> Int {
  match node_lane[node] {
    "jungle" => 16
    "river" => 0
    "base" => 0
    _ => 9
  }
}

///|
/// Experience for one tick of farming. Slightly flatter than gold, so a
/// champion that only farms jungle still levels at roughly a laner's pace.
pub fn camp_xp(node : Int) -> Int {
  match node_lane[node] {
    "jungle" => 13
    "river" => 0
    "base" => 0
    _ => 11
  }
}

///|
pub fn node_name(node : Int) -> String {
  node_names[node]
}

///|
/// The id of a named node, or -1. Used when a policy or a probe names a node in
/// prose rather than by index.
pub fn node_id(name : String) -> Int {
  for i in 0..<N_NODES {
    if node_names[i] == name {
      return i
    }
  }
  -1
}

///|
pub fn base_of(team : Int) -> Int {
  if team == TEAM_A {
    A_BASE
  } else {
    B_BASE
  }
}

///|
pub fn enemy_of(team : Int) -> Int {
  if team == TEAM_A {
    TEAM_B
  } else {
    TEAM_A
  }
}

///|
/// Distance in moves between two nodes, by breadth-first search on `adjacency`.
pub fn hops(from : Int, to : Int) -> Int {
  if from == to {
    return 0
  }
  let dist = Array::make(N_NODES, -1)
  dist[from] = 0
  let queue = [from]
  let mut head = 0
  while head < queue.length() {
    let cur = queue[head]
    head += 1
    if cur == to {
      return dist[cur]
    }
    for next in adjacency[cur] {
      if dist[next] < 0 {
        dist[next] = dist[cur] + 1
        queue.push(next)
      }
    }
  }
  dist[to]
}

///|
/// The first step of a shortest walk from `from` to `to`, breaking ties toward
/// `prefer` — normally the enemy base, so a champion that has a choice of
/// equally short routes takes the one that also gains ground.
///
/// This graph has many shortest paths (a1_bot is six hops from b1_top through
/// the bot lane, and six hops through its own base as well), so the tie-break
/// is not cosmetic. Leaving it to the order the adjacency lists happen to be
/// written in is what it was before, and because those lists are not mirrored
/// between the two sides, it sent team A's bot laner *backwards* out of lane on
/// tick one while team B's walked forwards. That single tie was worth
/// essentially a free win to team B in every mirror match.
pub fn step_toward_prefer(from : Int, to : Int, prefer : Int) -> Int {
  if from == to {
    return from
  }
  let best_d = hops(from, to)
  let mut best = from
  let mut best_pref = 1 << 28
  for next in adjacency[from] {
    if hops(next, to) >= best_d {
      continue
    }
    let p = hops(next, prefer)
    if best == from || p < best_pref {
      best = next
      best_pref = p
    }
  }
  best
}

///|
/// The first step of a shortest walk from `from` to `to`, or `from` when it is
/// already there. Ties are broken toward the destination, which is what a
/// caller with no "forward" direction to care about wants — a retreat, for
/// instance, where every shortest step home is as good as any other.
pub fn step_toward(from : Int, to : Int) -> Int {
  step_toward_prefer(from, to, to)
}

///|
/// Every node two moves away and not adjacent — where a `Blink` can land that
/// walking could not reach this tick. The champion's own node is excluded.
pub fn blink_targets(from : Int) -> Array[Int] {
  let out = []
  for mid in adjacency[from] {
    for far in adjacency[mid] {
      if far != from && !adjacency[from].contains(far) && !out.contains(far) {
        out.push(far)
      }
    }
  }
  out
}
