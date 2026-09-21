///|
/// Target selection, and the deterministic fight resolver the benchmark's
/// ground truth is built on.
///
/// This file is the reason the 5v5 game can be a *measurement* and not only a
/// match. Because the rules are deterministic, a situation can be played out
/// several different ways on copies of the state and the outcomes compared —
/// so for questions like "do we win this fight" or "who should we focus" there
/// is a right answer that the simulator can produce, not merely an opinion.
/// `bench.mbt` builds a scored benchmark on exactly that.

///|
/// The enemy on `node` that a basic attack can actually reach and would drop
/// soonest. The frontline guard redirects hits, so the reachable body is the
/// wall when there is one — which is why this is not simply "lowest health".
pub fn Game::focus_pick(self : Game, node : Int, team : Int) -> Champ? {
  let foes = self.champs_at(node, enemy_of(team))
  if foes.is_empty() {
    return None
  }
  let mut pick : Champ? = None
  let mut best = 1 << 28
  for f in foes {
    let real = self.guarded_target(f, node)
    if real.hp < best {
      best = real.hp
      pick = Some(f)
    }
  }
  pick
}

///|
/// The enemy worth reaching PAST a frontline: the biggest threat that a basic
/// attack cannot touch. This is what a `Nuke` is for, and picking the wall
/// instead wastes the cooldown that justifies drafting an assassin.
pub fn Game::backline_pick(self : Game, node : Int, team : Int) -> Champ? {
  let foes = self.champs_at(node, enemy_of(team))
  if foes.is_empty() {
    return None
  }
  let mut pick : Champ? = None
  let mut best = -1
  for f in foes {
    if f.frontline {
      continue
    }
    // Damage per point of effective health: what removing this body is worth.
    let value = self.raw_attack(f) * 1000 / (f.effective_hp() + 1)
    if value > best {
      best = value
      pick = Some(f)
    }
  }
  match pick {
    Some(_) => pick
    // Nothing but walls here: hit the softest of them.
    None => self.softest_at(node, team)
  }
}

///|
/// The enemy whose turn is worth removing: the one that would deal the most
/// damage next tick and is not already stunned.
pub fn Game::cc_pick(self : Game, node : Int, team : Int) -> Champ? {
  let foes = self.champs_at(node, enemy_of(team))
  let mut pick : Champ? = None
  let mut best = -1
  for f in foes {
    if f.stunned > 0 {
      continue
    }
    let value = self.raw_attack(f)
    if value > best {
      best = value
      pick = Some(f)
    }
  }
  pick
}

///|
/// The ability play that is worth making right now, or `None` to hold it.
///
/// Every branch here is a timing judgment rather than a damage calculation,
/// which is the point: a cooldown spent on a full-health target, or held
/// through the fight it would have won, is a mistake the rules permit.
pub fn Game::ability_play(self : Game, c : Champ) -> Action? {
  if !c.ability_ready() {
    return None
  }
  let foes = self.champs_at(c.node, enemy_of(c.team))
  match c.ability {
    NoAbility | Blink => None
    Nuke(_) =>
      // Worth it when it kills, or when a real fight is happening. Spending a
      // burst to chip one healthy enemy in a skirmish is how it gets wasted.
      match self.backline_pick(c.node, c.team) {
        Some(t) =>
          if self.ability_damage(c, t) >= t.hp + t.shield || foes.length() >= 2 {
            Some(Cast(c.ability, t.id))
          } else {
            None
          }
        None => None
      }
    Execute(_) =>
      // The bonus scales with missing health, so it is worth holding until the
      // target is actually hurt — unless it finishes them now.
      match self.focus_pick(c.node, c.team) {
        Some(aimed) => {
          let t = self.guarded_target(aimed, c.node)
          let missing = (t.max_hp - t.hp) * 100 / t.max_hp
          if self.ability_damage(c, t) >= t.hp + t.shield || missing >= 40 {
            Some(Cast(c.ability, aimed.id))
          } else {
            None
          }
        }
        None => None
      }
    Aoe(_) =>
      // Worth more the more of them are standing together.
      if foes.length() >= 2 {
        Some(Cast(c.ability, -1))
      } else if foes.length() == 1 &&
        self.ability_damage(c, foes[0]) >= foes[0].hp + foes[0].shield {
        Some(Cast(c.ability, -1))
      } else {
        None
      }
    Stun(_) =>
      // Crowd control deals nothing, so it only pays in a fight big enough
      // that a removed turn matters.
      if foes.length() >= 2 {
        match self.cc_pick(c.node, c.team) {
          Some(t) => Some(Cast(c.ability, t.id))
          None => None
        }
      } else {
        None
      }
    Heal(_) =>
      match self.neediest_ally(c) {
        Some(a) =>
          if a.hp * 100 < a.max_hp * 65 {
            Some(Cast(c.ability, -1))
          } else {
            None
          }
        None => None
      }
    Shield(_) =>
      // A shield absorbs the same tick it is cast, so it is worth throwing
      // BEFORE the damage rather than after — but only if a fight is on.
      match self.neediest_ally(c) {
        Some(a) =>
          if !foes.is_empty() && a.hp * 100 < a.max_hp * 85 {
            Some(Cast(c.ability, -1))
          } else if a.hp * 100 < a.max_hp * 50 {
            Some(Cast(c.ability, -1))
          } else {
            None
          }
        None => None
      }
  }
}

///|
/// What a champion does when it is committed to the fight on its own node:
/// the ability if it is worth it, otherwise a basic attack on the body it can
/// reach. No retreating, no macro — this is the all-in, which is what a fight
/// oracle needs to be about the fight and nothing else.
pub fn Game::fight_action(self : Game, c : Champ) -> Action {
  match self.ability_play(c) {
    Some(a) => return a
    None => ()
  }
  match self.focus_pick(c.node, c.team) {
    Some(t) => AttackChamp(t.id)
    None => Hold
  }
}

///|
/// Every champion on `node` commits to the fight there.
pub fn Game::fight_actions(self : Game, node : Int) -> Map[Int, Action] {
  let out : Map[Int, Action] = Map([])
  for c in self.champs {
    if !c.can_act() || c.node != node {
      continue
    }
    out[c.id] = self.fight_action(c)
  }
  out
}

///|
/// Like `fight_actions`, but team `team` aims every basic attack at champion
/// `focus_id` while it is still up. Abilities are still used sensibly, so the
/// comparison between focus orders is about the focus and not about throwing
/// the cooldowns away.
pub fn Game::fight_actions_focus(
  self : Game,
  node : Int,
  team : Int,
  focus_id : Int,
) -> Map[Int, Action] {
  let out : Map[Int, Action] = Map([])
  let focus = self.champs[focus_id]
  for c in self.champs {
    if !c.can_act() || c.node != node {
      continue
    }
    if c.team != team {
      out[c.id] = self.fight_action(c)
      continue
    }
    match self.ability_play(c) {
      Some(Cast(ab, tid)) =>
        // Point a single-target ability at the focus too, when it is legal.
        match ab {
          Nuke(_) | Execute(_) | Stun(_) =>
            if focus.alive() && focus.node == node {
              out[c.id] = Cast(ab, focus.id)
            } else {
              out[c.id] = Cast(ab, tid)
            }
          _ => out[c.id] = Cast(ab, tid)
        }
      _ =>
        if focus.alive() && focus.node == node {
          out[c.id] = AttackChamp(focus.id)
        } else {
          out[c.id] = self.fight_action(c)
        }
    }
  }
  out
}

///|
/// How a fight ended.
pub(all) struct FightResult {
  /// Living champions of each team still standing on the node.
  a_standing : Int
  b_standing : Int
  /// Their total remaining health.
  a_hp : Int
  b_hp : Int
  /// How many of each side died during the fight.
  a_deaths : Int
  b_deaths : Int
  ticks : Int
  /// The team left standing, or 0 if both or neither are.
  winner : Int
}

///|
/// One number for "how good was this fight for `team`". Bodies dominate
/// health, because a body is a turn every tick from here on.
pub fn FightResult::score_for(self : FightResult, team : Int) -> Int {
  let (mine, theirs, my_hp, their_hp, my_deaths, their_deaths) = if team ==
    TEAM_A {
    (
      self.a_standing,
      self.b_standing,
      self.a_hp,
      self.b_hp,
      self.a_deaths,
      self.b_deaths,
    )
  } else {
    (
      self.b_standing,
      self.a_standing,
      self.b_hp,
      self.a_hp,
      self.b_deaths,
      self.a_deaths,
    )
  }
  (mine - theirs) * 10000 +
  (their_deaths - my_deaths) * 4000 +
  (my_hp - their_hp)
}

///|
/// Play the fight on `node` out on a COPY of the game, until one side is off
/// the node or `max_ticks` pass. The live game is untouched, which is what
/// makes it safe to call this from an oracle several times over.
pub fn Game::simulate_fight(
  self : Game,
  node : Int,
  max_ticks : Int,
) -> FightResult {
  self.simulate_fight_focus(node, 0, -1, max_ticks)
}

///|
/// The same, with team `team` forced to focus `focus_id`. Pass `team = 0` for
/// no forced focus.
pub fn Game::simulate_fight_focus(
  self : Game,
  node : Int,
  team : Int,
  focus_id : Int,
  max_ticks : Int,
) -> FightResult {
  let g = self.copy()
  let mut ticks = 0
  for _t in 0..<max_ticks {
    let a_in = g.champs_at(node, TEAM_A).length()
    let b_in = g.champs_at(node, TEAM_B).length()
    if a_in == 0 || b_in == 0 || g.winner != 0 {
      break
    }
    let actions = if team != 0 && focus_id >= 0 {
      g.fight_actions_focus(node, team, focus_id)
    } else {
      g.fight_actions(node)
    }
    // A stunned champion has no legal action, so a tick where nobody on either
    // side can act would loop forever; `step` still advances timers, which is
    // what clears the stun.
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
  // A champion that died and respawned is off the node, so counting deaths
  // from the starting head count is both simpler and what a player means.
  let mut a_deaths = 0
  let mut b_deaths = 0
  for i in 0..<g.champs.length() {
    let before = self.champs[i]
    let after = g.champs[i]
    if after.deaths > before.deaths {
      if after.team == TEAM_A {
        a_deaths += after.deaths - before.deaths
      } else {
        b_deaths += after.deaths - before.deaths
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
/// Whether `team` wins the fight on `node` outright: it is left standing and
/// the enemy is not. A fight both sides survive is not a win.
pub fn Game::fight_is_won(
  self : Game,
  node : Int,
  team : Int,
  max_ticks : Int,
) -> Bool {
  self.simulate_fight(node, max_ticks).winner == team
}

///|
/// The looser reading of the same fight: `team` does not LOSE it — no more of
/// its bodies go down than the enemy's. A trade both sides survive counts,
/// and so does one where everybody dies.
///
/// This exists because "we win this fight" has two defensible meanings and the
/// benchmark asks only the strict one. `coherence.mbt` puts the two side by
/// side over the same states, which is the only way to tell an answer that is
/// wrong from an answer to the other question.
pub fn FightResult::trade_not_lost(self : FightResult, team : Int) -> Bool {
  if team == TEAM_A {
    self.a_deaths <= self.b_deaths
  } else {
    self.b_deaths <= self.a_deaths
  }
}

///|
/// The focus order that leaves `team` best off, chosen by playing the fight out
/// once per candidate. Returns the champion id, or -1 when there is nothing to
/// focus. This is the ground truth the `focus` benchmark class is scored
/// against.
pub fn Game::best_focus(
  self : Game,
  node : Int,
  team : Int,
  max_ticks : Int,
) -> Int {
  let foes = self.champs_at(node, enemy_of(team))
  let mut best_id = -1
  let mut best_score = -(1 << 30)
  for f in foes {
    let r = self.simulate_fight_focus(node, team, f.id, max_ticks)
    let s = r.score_for(team)
    if s > best_score {
      best_score = s
      best_id = f.id
    }
  }
  best_id
}

///|
/// The same, as the names of EVERY focus target that ties for best, joined by
/// "|". Two focus orders that end the fight in the same place are equally
/// right, and a benchmark that marked one of them wrong would be measuring the
/// order its options happened to be listed in.
pub fn Game::best_focus_names(
  self : Game,
  node : Int,
  team : Int,
  max_ticks : Int,
) -> String {
  let foes = self.champs_at(node, enemy_of(team))
  let names = []
  let scores = []
  for f in foes {
    names.push(f.name)
    scores.push(
      self.simulate_fight_focus(node, team, f.id, max_ticks).score_for(team),
    )
  }
  tied_best(names, scores)
}

///|
/// Every option tying for the highest score, joined by "|".
pub fn tied_best(options : Array[String], scores : Array[Int]) -> String {
  let mut best = -(1 << 30)
  for s in scores {
    if s > best {
      best = s
    }
  }
  let winners = []
  for i in 0..<options.length() {
    if scores[i] == best {
      winners.push(options[i])
    }
  }
  winners.join("|")
}

///|
/// The item that leaves `champ` best off in the fight that is about to happen
/// on `node`, chosen by buying each one on a copy and playing the fight out.
/// The truth for the `item` benchmark class.
pub fn Game::best_item(
  self : Game,
  champ_id : Int,
  node : Int,
  max_ticks : Int,
) -> String {
  let me = self.champs[champ_id]
  let names = []
  let scores = []
  for it in items {
    let g = self.copy()
    let c = g.champs[champ_id]
    if c.items.length() >= ITEM_SLOTS {
      continue
    }
    c.items.push(it.key)
    c.refresh_hp()
    names.push(it.key)
    scores.push(g.simulate_fight(node, max_ticks).score_for(me.team))
  }
  tied_best(names, scores)
}

///|
/// Whether diving `target_id` under its own structure kills it without costing
/// us a body. The tower's damage is part of `step`, so this is the rules'
/// answer rather than an estimate. The truth for the `dive` class.
pub fn Game::dive_is_clean(
  self : Game,
  target_id : Int,
  team : Int,
  max_ticks : Int,
) -> Bool {
  let target = self.champs[target_id]
  let node = target.node
  let before_deaths = []
  for c in self.champs {
    before_deaths.push(c.deaths)
  }
  let g = self.copy()
  let mut killed = false
  for _t in 0..<max_ticks {
    if !g.champs[target_id].alive() {
      killed = true
      break
    }
    if g.champs_at(node, team).is_empty() || g.winner != 0 {
      break
    }
    // Everyone we have there focuses the dive target; the defenders fight back.
    g.step(g.fight_actions_focus(node, team, target_id))
  }
  if !g.champs[target_id].alive() {
    killed = true
  }
  if !killed {
    return false
  }
  for c in g.champs {
    if c.team == team && c.deaths > before_deaths[c.id] {
      return false
    }
  }
  true
}
