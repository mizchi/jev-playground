///|
/// A compact MOBA: two lanes and a jungle, three champions a side.
///
/// The map is a graph rather than a plane, because the decision we want to
/// study is "where do I go and what do I hit", not pathfinding. Positions are
/// nodes; a champion moves one node per tick.
///
/// ```text
///        a_top --- m_top --- b_top
///       /            |            \
/// a_base --- a_jg - m_jg - b_jg --- b_base
///       \            |            /
///        a_bot --- m_bot --- b_bot
/// ```
///
/// Team A defends `a_base`, team B defends `b_base`. Each side has two lane
/// towers that shoot enemies standing on them and must fall before the base
/// can be hit. The jungle row is the flank: it is the fastest way between the
/// two lanes and the only route with no tower on it.

///|
pub const N_NODES = 11

///|
pub const A_BASE = 0

///|
pub const B_BASE = 4

///|
/// Node names, in id order. Prefix `a_`/`b_` is the side of the map.
pub let node_names : Array[String] = [
  "a_base", "a_top", "m_top", "b_top", "b_base", "a_bot", "m_bot", "b_bot",
  "a_jg", "m_jg", "b_jg",
]

///|
/// Which lane a node belongs to, for readable state and for the scripted bot.
pub let node_lane : Array[String] = [
  "base", "top", "top", "top", "base", "bot", "bot", "bot", "jungle", "jungle",
  "jungle",
]

///|
/// Undirected adjacency. A champion may move to any neighbour in one tick.
pub let adjacency : Array[Array[Int]] = [
  [1, 5, 8], // 0 a_base
  [0, 2], // 1 a_top
  [1, 3, 9], // 2 m_top
  [2, 4], // 3 b_top
  [3, 7, 10], // 4 b_base
  [0, 6], // 5 a_bot
  [5, 7, 9], // 6 m_bot
  [6, 4], // 7 b_bot
  [0, 9], // 8 a_jg
  [8, 2, 6, 10], // 9 m_jg
  [9, 4], // 10 b_jg
]

///|
/// Nodes with a farmable camp, and what one tick of farming pays.
pub fn camp_gold(node : Int) -> Int {
  match node_lane[node] {
    "jungle" => 12
    "base" => 0
    // Lane minions pay less than a jungle camp but are safe to sit on.
    _ => 8
  }
}

///|
pub fn node_name(node : Int) -> String {
  node_names[node]
}

///|
/// Distance in moves between two nodes, precomputed by breadth-first search.
/// The scripted bot uses it to walk toward a target, and the state uses it to
/// tell a champion how far away things are.
pub fn hops(from : Int, to : Int) -> Int {
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
/// The first step of a shortest walk from `from` to `to`, or `from` when it is
/// already there.
pub fn step_toward(from : Int, to : Int) -> Int {
  if from == to {
    return from
  }
  let mut best = from
  let mut best_d = hops(from, to)
  for next in adjacency[from] {
    let d = hops(next, to)
    if d < best_d {
      best_d = d
      best = next
    }
  }
  best
}
