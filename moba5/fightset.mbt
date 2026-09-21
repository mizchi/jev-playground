///|
/// The `fight` class's questions, derived rather than written down.
///
/// The first version of the class was biased and counting said so: **seven of
/// its eight questions were won by whoever had more bodies on the node**, so a
/// heuristic that does nothing but compare head counts scored 0.88 on it, and
/// a model's score there was mostly a score on arithmetic nobody needed a
/// model for.
///
/// Hand-picking replacements would have been worse, because I would have
/// picked situations that confirm whatever I expected. So the set is swept
/// instead: a fixed grid of staged fights is enumerated, each one is played out
/// by `simulate_fight`, and each is filed by whether the head count predicted
/// the outcome:
///
/// | bucket | more or equal bodies | we win outright |
/// | --- | --- | --- |
/// | `count_right_win` | yes | yes |
/// | `count_wrong_loss` | yes | **no** |
/// | `count_wrong_win` | **no** | yes |
/// | `count_right_loss` | no | no |
///
/// Taking the same number from each bucket makes the head count **worth
/// exactly 0.50 on the class by construction**, and it does the same to
/// "always answer yes". Any score above chance therefore comes from reading
/// the fight, which is what the class is supposed to measure.
///
/// The whole sweep runs on copies of the game with no API and no randomness,
/// so the chosen set is a property of the rules and the grid, not of a run.

///|
/// One candidate fight: the parameters that stage it.
pub(all) struct FightCase {
  comp_a : String
  comp_b : String
  /// A node with no structure on it, so this is a fight and not a dive.
  node : Int
  /// How many of each side are on the node. The rest are at their own base,
  /// which is what "some of us have not arrived" looks like.
  n_a : Int
  n_b : Int
  level_a : Int
  level_b : Int
  /// Health as a percentage of maximum.
  hp_a : Int
  hp_b : Int
}

///|
/// Stage the fight. Champion ids are role-ordered, so "four of five" always
/// leaves the same champion at home and the case is reproducible.
pub fn FightCase::build(self : FightCase) -> Game {
  let g = Game::with_comps(comp_by_name(self.comp_a), comp_by_name(self.comp_b))
  g.tick = 30
  for c in g.champs {
    if c.team == TEAM_A {
      at_level(c, self.level_a)
      at_hp(c, self.hp_a)
    } else {
      at_level(c, self.level_b)
      at_hp(c, self.hp_b)
    }
    c.node = base_of(c.team)
  }
  for i in 0..<self.n_a {
    g.champs[i].node = self.node
  }
  for i in 0..<self.n_b {
    g.champs[5 + i].node = self.node
  }
  g
}

///|
/// A one-line description of what makes this fight what it is, for the report.
pub fn FightCase::describe(self : FightCase) -> String {
  let parts = ["\{self.n_a}v\{self.n_b} on \{node_name(self.node)}"]
  parts.push("\{self.comp_a} vs \{self.comp_b}")
  if self.level_a != self.level_b {
    parts.push("level \{self.level_a} vs \{self.level_b}")
  } else {
    parts.push("both level \{self.level_a}")
  }
  if self.hp_a != 100 || self.hp_b != 100 {
    parts.push("health \{self.hp_a}% vs \{self.hp_b}%")
  }
  parts.join(", ")
}

///|
/// Whether the head count favours us — the exact reading `ask_fight`'s floor
/// makes, so that the buckets are about that heuristic and not a paraphrase.
pub fn FightCase::count_favours_us(self : FightCase) -> Bool {
  self.n_a >= self.n_b
}

///|
/// The bucket this case belongs to. A fight neither side wins outright counts
/// as "we do not win it", which is exactly what the question asks.
pub fn FightCase::bucket(self : FightCase) -> String {
  let g = self.build()
  let we_win = g.simulate_fight(self.node, FIGHT_TICKS).winner == TEAM_A
  if self.count_favours_us() {
    if we_win {
      "count_right_win"
    } else {
      "count_wrong_loss"
    }
  } else if we_win {
    "count_wrong_win"
  } else {
    "count_right_loss"
  }
}

///|
/// The four buckets, in the order the suite lists them.
pub let fight_buckets : Array[String] = [
  "count_right_win", "count_wrong_loss", "count_wrong_win", "count_right_loss",
]

///|
/// The grid, in a fixed order.
///
/// The levers are the ones that make a head count the wrong read: composition
/// (a durable frontline against five squishies), level, and health. Nodes are
/// deliberately structure-free — a tower changes the answer, and that is the
/// `dive` class's job.
fn fight_grid() -> Array[FightCase] {
  let pairs = [
    ("meta", "glass_ad"),
    ("glass_ad", "meta"),
    ("meta", "bruisers"),
    ("bruisers", "meta"),
    ("poke", "dive"),
    ("dive", "poke"),
  ]
  let counts = [(5, 5), (4, 5), (5, 4), (3, 5), (5, 3)]
  let levels = [(4, 4), (3, 5), (5, 3)]
  let healths = [(100, 100), (60, 100), (100, 60)]
  let nodes = [9, 20] // mid_mid and riv_top: no structure on either
  let out : Array[FightCase] = []
  for node in nodes {
    for pair in pairs {
      for count in counts {
        for level in levels {
          for health in healths {
            out.push({
              comp_a: pair.0,
              comp_b: pair.1,
              node,
              n_a: count.0,
              n_b: count.1,
              level_a: level.0,
              level_b: level.1,
              hp_a: health.0,
              hp_b: health.1,
            })
          }
        }
      }
    }
  }
  out
}

///|
/// `per_bucket` cases from each of the four buckets, in bucket order.
///
/// Two passes, because the obvious single pass is biased in a second way.
/// Walking the grid and keeping the first cases that fill each bucket fills all
/// four inside the first composition pairing, so all eight questions end up
/// being the same two teams on the same node with the health numbers moved
/// around — balanced against the head count, and useless as a test of anything
/// else. So the first pass takes at most one case per (composition pair, node),
/// spreading the set across matchups; a second pass fills whatever is still
/// short without that constraint, so the function cannot fail to return a
/// balanced set. Both passes walk the grid in its fixed order, so the choice
/// remains the grid's and not mine.
pub fn balanced_fight_cases(per_bucket : Int) -> Array[FightCase] {
  let picked : Map[String, Array[FightCase]] = Map([])
  for b in fight_buckets {
    picked[b] = []
  }
  let used : Array[String] = []
  fn full() -> Bool {
    for name in fight_buckets {
      match picked.get(name) {
        Some(arr) => if arr.length() < per_bucket { return false }
        None => return false
      }
    }
    true
  }

  fn room(b : String) -> Bool {
    match picked.get(b) {
      Some(arr) => arr.length() < per_bucket
      None => false
    }
  }

  fn keep(b : String, case_ : FightCase) -> Unit {
    match picked.get(b) {
      Some(arr) => arr.push(case_)
      None => ()
    }
  }

  let grid = fight_grid()
  for case_ in grid {
    if full() {
      break
    }
    let tag = "\{case_.comp_a}|\{case_.comp_b}|\{case_.node}"
    if used.contains(tag) {
      continue
    }
    let b = case_.bucket()
    if room(b) {
      keep(b, case_)
      used.push(tag)
    }
  }
  for case_ in grid {
    if full() {
      break
    }
    let b = case_.bucket()
    if !room(b) {
      continue
    }
    // Never the same case twice.
    let mut dup = false
    match picked.get(b) {
      Some(arr) =>
        for c in arr {
          if c.describe() == case_.describe() {
            dup = true
          }
        }
      None => ()
    }
    if !dup {
      keep(b, case_)
    }
  }
  let out : Array[FightCase] = []
  for b in fight_buckets {
    match picked.get(b) {
      Some(arr) =>
        for c in arr {
          out.push(c)
        }
      None => ()
    }
  }
  out
}

///|
/// How many cases the grid puts in each bucket, for the report and for the
/// test that the sweep can fill all four at all.
pub fn fight_bucket_census() -> Map[String, Int] {
  let census : Map[String, Int] = Map([])
  for b in fight_buckets {
    census[b] = 0
  }
  for case_ in fight_grid() {
    let b = case_.bucket()
    census[b] = census.get(b).unwrap_or(0) + 1
  }
  census
}
