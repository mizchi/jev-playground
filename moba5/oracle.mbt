///|
/// The position score, and the forward simulations the macro truths use.
///
/// `fight.mbt`'s truths are the rules' own outcome: "does this fight end with
/// them off the node" has an answer that needs no opinion. Macro questions —
/// which lane to answer, group or split, Baron or the nexus — do not, because
/// they are about a position several ticks from now rather than a corpse count.
/// So this file states one objective function and one horizon, out loud, and
/// every macro truth in `bench.mbt` is the argmax of THAT. A reader who
/// disagrees with the weighting can see exactly what they are disagreeing with,
/// which is the most a benchmark of this kind can honestly offer.

///|
/// How good a position is for `team`, in arbitrary but stated units:
///
/// - a destroyed nexus is worth more than everything else put together;
/// - structure health is the main currency, because it is the win condition;
/// - team power (damage times survivability) and gold are the same thing one
///   step earlier, so they are weighted well below it;
/// - objectives are counted at roughly what their buff is worth over its life.
pub fn Game::position_score(self : Game, team : Int) -> Int {
  let foe = enemy_of(team)
  if self.winner == team {
    return 1000000
  }
  if self.winner == foe {
    return -1000000
  }
  let struct_diff = self.structure_hp(team) - self.structure_hp(foe)
  let power_diff = self.team_power(team) - self.team_power(foe)
  let gold_diff = self.team_gold(team) - self.team_gold(foe)
  // A drake is a drake whichever element it is: the elements differ in when
  // they pay, not in how much, and a positional score that priced them apart
  // would be asserting a ranking the arena has not measured. The soul is
  // priced separately because it is a step rather than a stack.
  let obj = (self.drake_total(team) - self.drake_total(foe)) * 120 +
    (if self.soul_team == team { 250 } else { 0 }) -
    (if self.soul_team == foe { 250 } else { 0 }) +
    (if self.baron[team] > 0 { 200 } else { 0 }) -
    (if self.baron[foe] > 0 { 200 } else { 0 }) +
    (if self.herald[team] > 0 { 90 } else { 0 }) -
    (if self.herald[foe] > 0 { 90 } else { 0 })
  // A body that is down is a body that is not defending.
  let mut body_diff = 0
  for c in self.champs {
    if !c.alive() {
      if c.team == team {
        body_diff -= 1
      } else {
        body_diff += 1
      }
    }
  }
  struct_diff * 4 + power_diff / 8 + gold_diff / 4 + obj + body_diff * 150
}

///|
/// Play `horizon` ticks forward on a copy. `team`'s champions follow a plan
/// whose destinations are `goto` (an id-indexed array, -1 meaning "use the
/// team's own plan"); the enemy plays the strong baseline. Returns the position
/// score at the end.
///
/// The enemy playing `smart` rather than standing still is deliberate: a macro
/// answer that is only correct against an opponent who does nothing is not an
/// answer.
pub fn Game::simulate_macro(
  self : Game,
  team : Int,
  goto : Array[Int],
  horizon : Int,
) -> Int {
  let g = self.copy()
  for _t in 0..<horizon {
    if g.winner != 0 {
      break
    }
    let own = g.team_plan(team)
    let forced : Array[Int] = Array::make(10, -1)
    for i in 0..<10 {
      forced[i] = if goto[i] >= 0 { goto[i] } else { own.goto[i] }
    }
    let plan : Plan = {
      goto: forced,
      rally: own.rally,
      why: own.why,
      grouped: own.grouped,
      hold_lane: own.hold_lane,
    }
    let actions : Map[Int, Action] = Map([])
    for c in g.champs {
      if !c.can_act() {
        continue
      }
      if c.team == team {
        actions[c.id] = smart_action(g, c, plan)
      }
    }
    for e in smart_team_actions(g, enemy_of(team)) {
      actions[e.0] = e.1
    }
    g.step(actions)
  }
  g.position_score(team)
}

///|
/// Play `horizon` ticks forward on a copy, with `team`'s FIRST tick forced to
/// `first` and both sides playing the strong baseline after that. This is the
/// oracle for "is this the right move right now": the opening is fixed, the
/// follow-up is not.
pub fn Game::simulate_opening(
  self : Game,
  team : Int,
  first : Map[Int, Action],
  horizon : Int,
) -> Int {
  let g = self.copy()
  for t in 0..<horizon {
    if g.winner != 0 {
      break
    }
    let actions : Map[Int, Action] = Map([])
    if t == 0 {
      for c in g.champs {
        if c.team == team && c.can_act() {
          actions[c.id] = match first.get(c.id) {
            Some(a) => a
            None => smart_action(g, c, g.team_plan(team))
          }
        }
      }
    } else {
      for e in smart_team_actions(g, team) {
        actions[e.0] = e.1
      }
    }
    for e in smart_team_actions(g, enemy_of(team)) {
      actions[e.0] = e.1
    }
    g.step(actions)
  }
  g.position_score(team)
}

///|
/// The two sides of "commit or break off", priced over `horizon` ticks: what
/// the position is worth to `team` if the bodies it has on `node` swing, and
/// what it is worth if they walk home instead.
///
/// This lives here rather than inside the question that asks it, because two
/// things need the same number: the `retreat` class's truth, and the coherence
/// analysis that puts that truth next to the `fight` class's. A second copy of
/// the pricing would make "the truths disagree" unreadable — it could always
/// be the copies disagreeing.
pub fn Game::retreat_scores(
  self : Game,
  node : Int,
  team : Int,
  horizon : Int,
) -> (Int, Int) {
  let commit = self.fight_actions(node)
  let back : Map[Int, Action] = Map([])
  for c in self.champs_at(node, team) {
    let away = step_toward(c.node, base_of(team))
    back[c.id] = if away != c.node { Move(away) } else { Hold }
  }
  (
    self.simulate_opening(team, commit, horizon),
    self.simulate_opening(team, back, horizon),
  )
}

///|
/// Which of the two prices better, as the `retreat` class's truth:
/// `"fight_now"`, `"walk_away"`, or both when they price the same.
pub fn retreat_pick(commit : Int, away : Int) -> String {
  tied_best(["fight_now", "walk_away"], [commit, away])
}

///|
/// The same, priced from the position: one call for a caller that does not
/// need the two numbers.
pub fn Game::retreat_truth(
  self : Game,
  node : Int,
  team : Int,
  horizon : Int,
) -> String {
  let (commit, away) = self.retreat_scores(node, team, horizon)
  retreat_pick(commit, away)
}

///|
/// A fight in which `champ_id`'s first action is forced and everything else is
/// the all-in. Used to price a cooldown: spend it on tick one, or hold it.
pub fn Game::simulate_fight_opening(
  self : Game,
  node : Int,
  champ_id : Int,
  first : Action?,
  max_ticks : Int,
) -> FightResult {
  let g = self.copy()
  let mut ticks = 0
  for t in 0..<max_ticks {
    let a_in = g.champs_at(node, TEAM_A).length()
    let b_in = g.champs_at(node, TEAM_B).length()
    if a_in == 0 || b_in == 0 || g.winner != 0 {
      break
    }
    let actions = g.fight_actions(node)
    if t == 0 {
      match first {
        // `None` means "explicitly do NOT use the ability this tick": fall back
        // to a basic attack so the champion is not simply idle.
        None =>
          match g.focus_pick(node, g.champs[champ_id].team) {
            Some(tg) => actions[champ_id] = AttackChamp(tg.id)
            None => actions[champ_id] = Hold
          }
        Some(a) => actions[champ_id] = a
      }
    }
    g.step(actions)
    ticks += 1
  }
  let a_left = g.champs_at(node, TEAM_A)
  let b_left = g.champs_at(node, TEAM_B)
  let mut a_hp = 0
  for c in a_left {
    a_hp += c.hp
  }
  let mut b_hp = 0
  for c in b_left {
    b_hp += c.hp
  }
  let mut a_deaths = 0
  let mut b_deaths = 0
  for i in 0..<g.champs.length() {
    let d = g.champs[i].deaths - self.champs[i].deaths
    if d > 0 {
      if g.champs[i].team == TEAM_A {
        a_deaths += d
      } else {
        b_deaths += d
      }
    }
  }
  let winner = if a_left.length() > 0 && b_left.length() == 0 {
    TEAM_A
  } else if b_left.length() > 0 && a_left.length() == 0 {
    TEAM_B
  } else {
    0
  }
  {
    a_standing: a_left.length(),
    b_standing: b_left.length(),
    a_hp,
    b_hp,
    a_deaths,
    b_deaths,
    ticks,
    winner,
  }
}

///|
/// How many ticks a champion can stand on the structure at its own node before
/// that structure kills it. The tower's damage is mitigated by armor, and it
/// does not fire at all at a champion whose team holds the lane, so this is the
/// number that decides who walks in first — arithmetic the rules already do.
/// 99 means the structure is not a threat to this champion at all.
pub fn Game::ticks_under_tower(self : Game, c : Champ) -> Int {
  let s = match self.structure_at(c.node) {
    Some(s) => s
    None => return 99
  }
  if s.team == c.team || !self.tower_shoots(s, c) {
    return 99
  }
  let per_tick = self.tower_damage_to(c)
  if per_tick <= 0 {
    return 99
  }
  (c.hp + c.shield + per_tick - 1) / per_tick
}

///|
/// Which of `team`'s champions at `node` can hold a dive longest. The truth for
/// the "who walks in first" question, as the names of everyone who ties.
pub fn Game::best_diver_names(self : Game, node : Int, team : Int) -> String {
  let names = []
  let scores = []
  for c in self.champs_at(node, team) {
    names.push(c.name)
    scores.push(self.ticks_under_tower(c))
  }
  tied_best(names, scores)
}

///|
/// Our team's power as a percentage of theirs, and which rubric level that
/// falls in. The rubric is the one the `power` benchmark class is scored
/// against, so the buckets live next to the number they bucket.
pub let power_rubric : Array[String] = [
  "We lose a straight fight badly", "We are behind, but it is close", "About even",
  "We are ahead", "We win a straight fight comfortably",
]

///|
pub fn Game::power_ratio(self : Game, team : Int) -> Int {
  let theirs = self.team_power(enemy_of(team))
  if theirs <= 0 {
    return 400
  }
  self.team_power(team) * 100 / theirs
}

///|
pub fn power_level(ratio : Int) -> Int {
  if ratio < 70 {
    0
  } else if ratio < 92 {
    1
  } else if ratio <= 110 {
    2
  } else if ratio <= 145 {
    3
  } else {
    4
  }
}

///|
/// The ward that reveals the most enemies from where this champion stands:
/// each spot is warded on a copy and the visible enemies counted. The truth
/// for the vision half of the `brush` class.
///
/// Ties are joined, and they are common — two spots that reveal the same two
/// champions really are the same answer, and letting the option order pick
/// between them would mark a correct read wrong.
pub fn Game::best_ward(self : Game, team : Int, from : Int) -> String {
  let names = []
  let scores = []
  for n in ward_spots(from) {
    let g = self.copy()
    g.wards.push({ node: n, team, kind: WARD_STEALTH, ttl: WARD_TTL, })
    names.push(node_name(n))
    scores.push(g.visible_enemies(team).length())
  }
  tied_best(names, scores)
}

///|
/// Nodes `team` cannot see that could be holding an enemy: the brush, minus
/// the ones it has vision of. Arithmetic over the vision mask, and the whole
/// of what the brush rule costs a team without wards.
pub fn Game::blind_brush(self : Game, team : Int) -> Array[Int] {
  let seen = self.vision(team)
  let out = []
  for n in brush_nodes {
    if !seen[n] {
      out.push(n)
    }
  }
  out
}
