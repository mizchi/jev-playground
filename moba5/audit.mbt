///|
/// A read-only audit of what the rules do once they are played.
///
/// A constant says what a source *can* pay: a last hit is 6 gold, a plate is
/// 28 to everyone on the team, a drake is 60 to everyone. Only a played game
/// says what each one *does* pay, and the two came apart far enough that a
/// comparison with the game this is modelled on has to be read off play (see
/// docs/64). So this plays the tournament field — every ordered pair of comps,
/// the same baseline on both sides, exactly as `--tournament` does — and puts
/// every point of gold and experience against the rule that paid it.
///
/// Three sources leave no counter on the champion: plates, towers and epic
/// monsters. For those the audit reads the tick's events, so it is only as
/// good as those sentences. `audit_wbtest.mbt` holds it to the engine rather
/// than to the sentences: every tick must attribute exactly what each
/// champion's wealth and experience moved by, with nothing left over.

///|
/// The rules that pay gold and experience, in the order the audit reports
/// them. Every `gold +=` and every `gain_xp` in `Game::step` is one of these.
pub let audit_sources : Array[String] = [
  "cs", "camps", "kills", "assists", "trickle", "plates", "towers", "neutral",
]

///|
/// The ticks at which the audit samples the mean champion.
pub let audit_checkpoints : Array[Int] = [10, 20, 40, 60, 80, 100, 120, 150]

///|
/// What the played games added up to. Sums are over every champion of every
/// game unless a field says otherwise; the CLI turns them into rates.
pub(all) struct Audit {
  mut games : Int
  mut champ_games : Int
  /// Gold and experience by `audit_sources`.
  gold : Array[Int]
  xp : Array[Int]
  /// Gold that went on control wards: the one purchase that is not an item.
  mut control_spend : Int
  /// Whatever the attribution could not place. The test holds both at 0.
  mut unaccounted_gold : Int
  mut unaccounted_xp : Int
  mut kills : Int
  /// Champions a tower killed.
  mut tower_kills : Int
  mut dead_ticks : Int
  mut alive_ticks : Int
  /// Alive champion-ticks spent at `MAX_LEVEL`, where experience buys nothing.
  mut capped_ticks : Int
  mut towers_by_champs : Int
  mut towers_by_minions : Int
  mut inner_breaks : Int
  mut nexus_kills : Int
  mut plates_taken : Int
  mut drakes : Int
  mut heralds : Int
  mut barons : Int
  mut souls : Int
  /// Per game: the tick the first tower fell and the first drake was taken,
  /// or -1.
  first_tower : Array[Int]
  first_drake : Array[Int]
  /// `level_at[l]`, per champion-game: the tick it first stood at level `l`,
  /// or -1. Indices 0 and 1 are unused.
  level_at : Array[Array[Int]]
  /// Per champion-game: the tick it first held a completed item, or -1.
  first_item : Array[Int]
  /// How many completed items champions held at the end, by count.
  completed_held : Array[Int]
  /// Attack, health, armor and magic resist at the end, summed — the total,
  /// and the part of it that came from items.
  stat_total : Array[Int]
  stat_items : Array[Int]
  /// Per `audit_checkpoints` entry, summed over champions: level, gold earned
  /// so far, gold standing in items, completed items held.
  at_level : Array[Int]
  at_earned : Array[Int]
  at_items : Array[Int]
  at_completed : Array[Int]
  at_samples : Array[Int]
}

///|
fn Audit::new() -> Audit {
  let n = audit_checkpoints.length()
  {
    games: 0,
    champ_games: 0,
    gold: Array::make(audit_sources.length(), 0),
    xp: Array::make(audit_sources.length(), 0),
    control_spend: 0,
    unaccounted_gold: 0,
    unaccounted_xp: 0,
    kills: 0,
    tower_kills: 0,
    dead_ticks: 0,
    alive_ticks: 0,
    capped_ticks: 0,
    towers_by_champs: 0,
    towers_by_minions: 0,
    inner_breaks: 0,
    nexus_kills: 0,
    plates_taken: 0,
    drakes: 0,
    heralds: 0,
    barons: 0,
    souls: 0,
    first_tower: [],
    first_drake: [],
    level_at: Array::makei(MAX_LEVEL + 1, _ => []),
    first_item: [],
    completed_held: Array::make(ITEM_SLOTS + 1, 0),
    stat_total: [0, 0, 0, 0],
    stat_items: [0, 0, 0, 0],
    at_level: Array::make(n, 0),
    at_earned: Array::make(n, 0),
    at_items: Array::make(n, 0),
    at_completed: Array::make(n, 0),
    at_samples: Array::make(n, 0),
  }
}

///|
/// What a champion is worth in gold: what it holds, plus its items at what
/// they cost from nothing. Buying moves gold into items without changing this,
/// which is what lets a tick's income be read as the change in it.
fn audit_wealth(c : Champ) -> Int {
  let mut v = c.gold
  for key in c.items {
    v += item_total_cost(key)
  }
  v
}

///|
fn audit_completed(key : String) -> Bool {
  match item_of(key) {
    Some(it) => !it.builds_from.is_empty()
    None => false
  }
}

///|
/// Play one game between two comps and add it to the audit.
fn Audit::play(
  self : Audit,
  comp_a : Array[String],
  comp_b : Array[String],
  policy : String,
  max_ticks : Int,
) -> Unit {
  let g = Game::with_comps(comp_a, comp_b)
  let n = g.champs.length()
  let earned = Array::make(n, 0)
  let level_at : Array[Array[Int]] = Array::makei(n, _ => {
    Array::make(MAX_LEVEL + 1, -1)
  })
  let first_item = Array::make(n, -1)
  let mut first_tower = -1
  let mut first_drake = -1
  while g.winner == 0 && g.tick < max_ticks {
    let actions : Map[Int, Action] = Map([])
    for team in [TEAM_A, TEAM_B] {
      for e in baseline_team_actions(g, team, policy) {
        actions[e.0] = e.1
      }
    }
    // Before the tick: what everyone is worth, and the counters the tick can
    // move. A control ward is gold leaving without an item arriving, so the
    // ones that will land are priced here, by the rule `Game::step` applies.
    let wealth0 = Array::make(n, 0)
    let xp0 = Array::make(n, 0)
    let cs0 = Array::make(n, 0)
    let camps0 = Array::make(n, 0)
    let kills0 = Array::make(n, 0)
    let assists0 = Array::make(n, 0)
    let spend = Array::make(n, 0)
    for c in g.champs {
      wealth0[c.id] = audit_wealth(c)
      xp0[c.id] = c.xp
      cs0[c.id] = c.cs
      camps0[c.id] = c.camps
      kills0[c.id] = c.kills
      assists0[c.id] = c.assists
      match actions.get(c.id) {
        Some(PlaceControl(nd)) =>
          if c.can_act() && c.can_place_control(nd) {
            spend[c.id] = CONTROL_COST
          }
        _ => ()
      }
    }
    let log_len = g.log.length()
    g.step(actions)
    // The sources that leave no counter on a champion, read off the events,
    // per team: plates broken, epic monster gold and experience, and the
    // experience a tower kill hands the whole team.
    let plates = [0, 0, 0]
    let neutral_gold = [0, 0, 0]
    let neutral_xp = [0, 0, 0]
    let tower_xp = [0, 0, 0]
    if g.log.length() > log_len {
      for ev in g.log[g.log.length() - 1].split("; ") {
        let ev = ev.to_owned()
        for t in [TEAM_A, TEAM_B] {
          let tn = team_name(t)
          for k in 1..<=PLATES {
            if ev.contains("team \{tn} took \{k} plate(s)") {
              plates[t] += k
              self.plates_taken += k
            }
          }
          if ev.contains("team \{tn} took BARON") {
            let (bg, bx) = neutral_bounty("baron")
            neutral_gold[t] += bg
            neutral_xp[t] += bx
            self.barons += 1
          }
          if ev.contains("team \{tn} took the HERALD") {
            let (bg, bx) = neutral_bounty("herald")
            neutral_gold[t] += bg
            neutral_xp[t] += bx
            self.heralds += 1
          }
          if ev.contains("team \{tn} took the ") && ev.contains(" drake (") {
            let (bg, bx) = neutral_bounty("dragon")
            neutral_gold[t] += bg
            neutral_xp[t] += bx
            self.drakes += 1
            if first_drake < 0 {
              first_drake = g.tick
            }
          }
        }
        if ev.contains(" destroyed the ") {
          if first_tower < 0 {
            first_tower = g.tick
          }
          if ev.contains("minions destroyed") {
            self.towers_by_minions += 1
          } else {
            self.towers_by_champs += 1
            // The killer is named first, as `A_…` or `B_…`; the tick's first
            // event also carries the `tN: ` prefix.
            let t = if ev.has_prefix("A_") || ev.contains(": A_") {
              TEAM_A
            } else {
              TEAM_B
            }
            tower_xp[t] += TOWER_XP
          }
          if ev.contains("(back in") {
            self.inner_breaks += 1
          }
        }
        if ev.contains("was killed by the") {
          self.tower_kills += 1
        }
      }
    }
    for c in g.champs {
      let t = c.team
      let moved = audit_wealth(c) - wealth0[c.id] + spend[c.id]
      let trickle = c.alive() && lane_index(node_lane[c.node]) >= 0
      let paid = [
        (c.cs - cs0[c.id]) * CS_GOLD,
        (c.camps - camps0[c.id]) * CAMP_GOLD,
        (c.kills - kills0[c.id]) * KILL_GOLD,
        (c.assists - assists0[c.id]) * ASSIST_GOLD,
        if trickle {
          LANE_TRICKLE
        } else {
          0
        },
        plates[t] * PLATE_GOLD,
        0,
        neutral_gold[t],
      ]
      let mut known = 0
      for v in paid {
        known += v
      }
      // What is left is a tower kill's bounty to the champion that landed the
      // biggest blow on it, and nothing else may be.
      let rest = moved - known
      paid[6] = rest
      if TOWER_GOLD == 0 || rest % TOWER_GOLD != 0 {
        self.unaccounted_gold += if rest < 0 { -rest } else { rest }
      }
      let learned = [
        (c.cs - cs0[c.id]) * CS_XP,
        (c.camps - camps0[c.id]) * CAMP_XP,
        (c.kills - kills0[c.id]) * KILL_XP,
        (c.assists - assists0[c.id]) * (KILL_XP / 2),
        if trickle {
          CS_XP / 2
        } else {
          0
        },
        0,
        tower_xp[t],
        neutral_xp[t],
      ]
      let mut learned_sum = 0
      for v in learned {
        learned_sum += v
      }
      let stray = c.xp - xp0[c.id] - learned_sum
      self.unaccounted_xp += if stray < 0 { -stray } else { stray }
      for k in 0..<paid.length() {
        self.gold[k] += paid[k]
        self.xp[k] += learned[k]
      }
      self.control_spend += spend[c.id]
      earned[c.id] += moved
      self.kills += c.kills - kills0[c.id]
      for lv in 2..<=MAX_LEVEL {
        if level_at[c.id][lv] < 0 && c.level >= lv {
          level_at[c.id][lv] = g.tick
        }
      }
      if first_item[c.id] < 0 && c.items.iter().any(audit_completed) {
        first_item[c.id] = g.tick
      }
      if c.alive() {
        self.alive_ticks += 1
        if c.level >= MAX_LEVEL {
          self.capped_ticks += 1
        }
      } else {
        self.dead_ticks += 1
      }
    }
    for i in 0..<audit_checkpoints.length() {
      if audit_checkpoints[i] == g.tick {
        for c in g.champs {
          self.at_level[i] += c.level
          self.at_earned[i] += earned[c.id]
          self.at_items[i] += audit_wealth(c) - c.gold
          self.at_completed[i] += c.items.filter(audit_completed).length()
          self.at_samples[i] += 1
        }
      }
    }
  }
  self.games += 1
  if g.winner != 0 {
    self.nexus_kills += 1
  }
  if g.soul_team != 0 {
    self.souls += 1
  }
  self.first_tower.push(first_tower)
  self.first_drake.push(first_drake)
  for c in g.champs {
    self.champ_games += 1
    for lv in 2..<=MAX_LEVEL {
      self.level_at[lv].push(level_at[c.id][lv])
    }
    self.first_item.push(first_item[c.id])
    let held = c.items.filter(audit_completed).length()
    self.completed_held[@cmp.minimum(held, ITEM_SLOTS)] += 1
    let mut atk = 0
    let mut hp = 0
    let mut armor = 0
    let mut mr = 0
    for key in c.items {
      match item_of(key) {
        Some(it) => {
          atk += it.atk
          hp += it.hp
          armor += it.armor
          mr += it.mr
        }
        None => ()
      }
    }
    let totals = [c.attack(), c.hp_cap(), c.armor(), c.mr()]
    let parts = [atk, hp, armor, mr]
    for k in 0..<4 {
      self.stat_total[k] += totals[k]
      self.stat_items[k] += parts[k]
    }
  }
}

///|
/// Audit the given games, each an (A comp, B comp) pair.
pub fn audit_games(
  pairs : Array[(Array[String], Array[String])],
  policy : String,
  max_ticks : Int,
) -> Audit {
  let a = Audit::new()
  for p in pairs {
    a.play(p.0, p.1, policy, max_ticks)
  }
  a
}

///|
/// Audit the tournament field: every ordered pair of distinct comps once, the
/// same 72 games `--tournament` plays.
pub fn audit_tournament(policy : String, max_ticks : Int) -> Audit {
  let pairs = []
  for i in 0..<tournament_comps.length() {
    for j in 0..<tournament_comps.length() {
      if i != j {
        pairs.push((tournament_comps[i].picks, tournament_comps[j].picks))
      }
    }
  }
  audit_games(pairs, policy, max_ticks)
}

// ------------------------------------------------------------- the curves

///|
/// The inventory the audit calls "full": three of the two-component item on
/// the archetype's path, 1,650 gold. It is the ceiling of what the shop can
/// put on one champion, not something the baseline reaches.
pub fn audit_full_build(kind : String) -> Array[String] {
  if kind_of(kind).frontline {
    ["bulwark", "bulwark", "bulwark"]
  } else {
    ["edge", "edge", "edge"]
  }
}

///|
/// A game with `att` five times on side A and `def` five times on side B, all
/// at `level`, holding the full build when `full` is set.
pub fn audit_pair(att : String, def : String, level : Int, full : Bool) -> Game {
  let g = Game::with_comps([att, att, att, att, att], [def, def, def, def, def])
  g.level_all(level)
  for c in g.champs {
    if full {
      for key in audit_full_build(c.kind) {
        c.items.push(key)
      }
      c.refresh_hp()
    }
  }
  g
}

///|
/// Basic attacks one `att` needs to kill one `def`, at the setting.
pub fn audit_ttk(att : String, def : String, level : Int, full : Bool) -> Int {
  let g = audit_pair(att, def, level, full)
  let x = g.champs[0]
  let y = g.champs[5]
  let d = g.damage_to_champ(x, y)
  (y.hp + d - 1) / d
}

///|
/// Ticks a champion of `kind` lives under an enemy tower with no wave.
pub fn audit_under_tower(kind : String, level : Int, full : Bool) -> Int {
  let g = audit_pair(kind, kind, level, full)
  let c = g.champs[0]
  let d = g.tower_damage_to(c)
  (c.hp + d - 1) / d
}

///|
/// A comp's structure damage per tick, all five hitting, at the setting.
pub fn audit_siege(picks : Array[String], level : Int, full : Bool) -> Int {
  let g = Game::with_comps(picks, picks)
  g.level_all(level)
  let mut total = 0
  for c in g.champs {
    if c.team == TEAM_A {
      if full {
        for key in audit_full_build(c.kind) {
          c.items.push(key)
        }
        c.refresh_hp()
      }
      total += g.damage_to_structure(c)
    }
  }
  total
}

///|
/// How long a comp's mirror match lasts as a pure all-in teamfight on one
/// node, and how many die on each side, at the setting.
pub fn audit_mirror_fight(
  picks : Array[String],
  level : Int,
  full : Bool,
  max_ticks : Int,
) -> FightResult {
  let g = Game::with_comps(picks, picks)
  g.level_all(level)
  if full {
    for c in g.champs {
      for key in audit_full_build(c.kind) {
        c.items.push(key)
      }
      c.refresh_hp()
    }
  }
  g.place_all(RIV_BOT)
  g.simulate_fight(RIV_BOT, max_ticks)
}
