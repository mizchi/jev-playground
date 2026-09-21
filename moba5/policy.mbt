///|
/// The two scripted baselines.
///
/// docs/02's honest limitation was that the 3v3 prototype's only opponent was
/// a passive lane bot, so "6–0 against it" meant less than it looked. Two
/// baselines here, and the strong one is written to be genuinely hard:
///
/// - **`scripted`** — lane-loyal and reactive. Pushes its own lane, fights when
///   it has the bodies, retreats when hurt, uses its ability whenever a target
///   is in front of it. The weak floor, kept because it is the 3v3 bot's
///   behaviour carried over and so makes the two games comparable.
/// - **`smart`** — plays macro. One shared plan per tick: group on the
///   objective that is actually up, or answer the lane that is actually
///   falling, and leave exactly one champion behind to hold pressure — which
///   the minion rules punish a team for forgetting. It counter-buys against
///   the damage type it can see, wards the river before a monster spawns, and
///   spends abilities on `fight.mbt`'s timing rules rather than on cooldown.
///
/// Both read only their own team's observation: the same fog of war a policy
/// under test gets.

///|
/// The team's shared intention for this tick. Computed once per team per tick,
/// because five champions acting on five private plans is how a team loses a
/// 5v5 — and because a shared plan is what the single shared observation is
/// actually for.
pub(all) struct Plan {
  /// Where each champion id should be heading. -1 means "no opinion".
  goto : Array[Int]
  /// The node the team is grouping on.
  rally : Int
  /// A one-line reason, for `--verbose` and for the report.
  why : String
  /// The lane index a single champion is being left to hold, or -1.
  hold_lane : Int
}

// ------------------------------------------------- what the map is worth
//
// One scale for the three things the plan chooses between, so the choice is
// arithmetic a reader can check rather than an order of branches a reader has
// to trust. The numbers are this bot's opinion, not the simulator's: they
// decide what the *baseline* does, and the benchmark's truths come from
// playing the situation out rather than from these.

///|
/// A tower whose lane we hold: the cheapest structure on the map, since it
/// cannot shoot back while our wave is in front of it.
pub const FREE_TOWER_VALUE = 110

///|
/// Baron: a short window of far more damage and much faster sieging. Above a
/// free tower, because the window is usually spent taking two of them.
pub const BARON_VALUE = 200

///|
/// One drake stack, on its own, before anything the soul adds.
pub const DRAKE_STACK_VALUE = 40

///|
/// A soul, whole. On this scale it is worth rather more than Baron, because
/// Baron runs out and a soul does not.
pub const SOUL_VALUE = 250

///|
/// The enemy structure a team should be sieging. A lane whose wave we already
/// hold comes first — the tower there cannot shoot us, so it is the cheapest
/// structure on the map — and among equals the lowest-health one, so the team
/// finishes what is already hurt instead of splitting across three fresh
/// towers.
pub fn Game::siege_target(self : Game, team : Int) -> Int {
  let foe = enemy_of(team)
  let mut best = -1
  let mut best_key = 1 << 28
  for s in self.structures {
    if s.team != foe || !s.alive() || !self.structure_attackable(s) {
      continue
    }
    // Holding the wave is worth more than any amount of missing tower health,
    // so it dominates the sort rather than merely nudging it.
    let key = s.hp - (if self.has_wave(team, s.lane) { 10000 } else { 0 })
    if key < best_key {
      best_key = key
      best = s.node
    }
  }
  best
}

///|
/// Our own structure most in danger, for a defensive rally. -1 when nothing is
/// under pressure.
pub fn Game::defend_target(self : Game, team : Int) -> Int {
  let (lane, _) = self.lane_under_pressure(team)
  if lane < 0 {
    return -1
  }
  self.lane_front(enemy_of(team), lanes[lane])
}

///|
/// The epic monster worth grouping for right now: one that is up, in a river
/// node, and that the team can plausibly reach. -1 when neither is up.
pub fn Game::objective_target(self : Game, team : Int) -> Int {
  let mut best = -1
  let mut best_value = -1
  for n in self.neutrals {
    if !n.alive() {
      continue
    }
    let value = self.monster_value(team, n)
    if value > best_value {
      best_value = value
      best = n.node
    }
  }
  best
}

///|
/// What `n` is worth to `team` right now, on one scale with `FREE_TOWER_VALUE`.
pub fn Game::monster_value(self : Game, team : Int, n : Neutral) -> Int {
  if n.key == "baron" {
    BARON_VALUE
  } else {
    self.drake_value(team)
  }
}

///|
/// The best objective in the river right now, by that value, or 0 when the
/// river is empty. What the plan weighs a free tower against.
pub fn Game::objective_value(self : Game, team : Int) -> Int {
  let mut best = 0
  for n in self.neutrals {
    if n.alive() {
      let v = self.monster_value(team, n)
      if v > best {
        best = v
      }
    }
  }
  best
}

///|
/// What the drake in the pit is worth to `team`: the stack, plus this drake's
/// share of the soul it moves us toward, plus the share it takes off theirs.
///
/// Pricing the soul share is the whole of what changed when souls arrived, and
/// it is what makes the first drake of a game worth contesting. Before it, a
/// drake was a flat stack; a flat stack loses to a free tower on any honest
/// arithmetic, the plan below took the tower every time, and the result was a
/// game in which one drake fell in 128 ticks and the soul was unreachable —
/// a mechanic that type-checked and never happened. Each drake is a quarter of
/// a soul when the race is level and all of one when it is not, which is why
/// the fourth is worth a teamfight and the first is still worth a rotation.
pub fn Game::drake_value(self : Game, team : Int) -> Int {
  if self.soul_team != 0 {
    // The soul is decided; a drake is a stack again.
    return DRAKE_STACK_VALUE
  }
  let ours = self.drakes_to_soul(team)
  let theirs = self.drakes_to_soul(enemy_of(team))
  // Denying is worth half of taking: it costs them a drake but does not put
  // one on our side of the count.
  DRAKE_STACK_VALUE + SOUL_VALUE / ours + SOUL_VALUE / (theirs * 2)
}

///|
/// The shared plan. The order of the branches IS the macro priority: a nexus
/// you can hit beats everything, then a structure about to fall, then an
/// objective that is up, then the siege.
pub fn Game::team_plan(self : Game, team : Int) -> Plan {
  let goto = Array::make(10, -1)
  let foe = enemy_of(team)
  let mut rally = -1
  let mut why = ""
  // 1. Their nexus is open: nothing else matters.
  if self.nexus_exposed(foe) {
    for s in self.structures {
      if s.team == foe && s.is_nexus() && s.alive() {
        rally = s.node
        why = "their nexus is open"
      }
    }
  }
  // 2. Something of ours is about to fall to minions.
  if rally < 0 {
    let d = self.defend_target(team)
    if d >= 0 {
      let (lane, ticks) = self.lane_under_pressure(team)
      rally = d
      why = "\{lanes[lane]} falls in \{ticks} ticks"
    }
  }
  // 3. A lane whose wave we already hold: the tower there cannot shoot us, so
  //    it is the cheapest structure on the map — unless the river holds
  //    something worth more, which `FREE_TOWER_VALUE` is there to say.
  //
  //    This used to be an unconditional branch ahead of the objective, and the
  //    comment said the free tower "beats a monster". It beat every monster:
  //    the bot holds a wave in at least one lane almost every tick, so the
  //    branch was a standing veto on the one below it, and a played game saw
  //    one drake and one Baron in 128 ticks. An order of branches cannot say
  //    "usually, but not this one"; a number can.
  if rally < 0 && self.objective_value(team) <= FREE_TOWER_VALUE {
    for lane in lanes {
      if rally >= 0 || !self.has_wave(team, lane) {
        continue
      }
      let front = self.lane_front(team, lane)
      if front >= 0 {
        rally = front
        why = "we hold the \{lane} wave"
      }
    }
  }
  // 4. An epic monster is up, we have the bodies for it, and our lanes are not
  //    bleeding. A buff bought with two towers is not a buff, it is a trade —
  //    and the minion rules make that trade real rather than rhetorical.
  if rally < 0 {
    let mut bleeding = 0
    for li in 0..<3 {
      let against = if team == TEAM_A { -self.push[li] } else { self.push[li] }
      if against >= 2 {
        bleeding += 1
      }
    }
    let o = self.objective_target(team)
    if o >= 0 && self.living(team).length() >= 3 && bleeding <= 1 {
      let monster = match self.neutral_at(o) {
        Some(m) => m.key
        None => "objective"
      }
      rally = o
      why = "\{monster} is up"
    }
  }
  // 5. Otherwise, siege together.
  if rally < 0 {
    rally = self.siege_target(team)
    why = "siege"
  }
  if rally < 0 {
    rally = base_of(foe)
    why = "push the nexus"
  }

  // Every lane the enemy is pushing and the rally is not already answering
  // gets a body, nearest first, up to two of them — so at least three still
  // group. Holding only ONE lane was this bot's largest mistake: against a
  // team that simply pushes all three, four champions standing on an objective
  // lose two towers to buy one buff, and the arithmetic of that trade is
  // firmly against them.
  let mut hold_lane = -1
  let taken = Array::make(10, false)
  for _round in 0..<2 {
    let mut pick_lane = -1
    let mut worst = 0
    for li in 0..<3 {
      let against = if team == TEAM_A { -self.push[li] } else { self.push[li] }
      if node_lane[rally] == lanes[li] || against <= worst {
        continue
      }
      // Already covered by an earlier round.
      let mut covered = false
      for c in self.champs {
        if c.team == team &&
          taken[c.id] &&
          goto[c.id] >= 0 &&
          node_lane[goto[c.id]] == lanes[li] {
          covered = true
        }
      }
      if covered {
        continue
      }
      worst = against
      pick_lane = li
    }
    if pick_lane < 0 {
      continue
    }
    let hold_node = self.lane_front(foe, lanes[pick_lane])
    if hold_node < 0 {
      continue
    }
    let mut hold_id = -1
    let mut best_d = 1 << 28
    for c in self.champs {
      if c.team != team || !c.alive() || taken[c.id] {
        continue
      }
      let d = hops(c.node, hold_node)
      if d < best_d {
        best_d = d
        hold_id = c.id
      }
    }
    if hold_id >= 0 {
      goto[hold_id] = hold_node
      taken[hold_id] = true
      if hold_lane < 0 {
        hold_lane = pick_lane
      }
    }
  }
  for c in self.champs {
    if c.team != team || !c.alive() {
      continue
    }
    if goto[c.id] < 0 {
      goto[c.id] = rally
    }
  }
  { goto, rally, why, hold_lane, }
}

// ------------------------------------------------------------ the weak floor

///|
/// The lane-loyal bot. Deliberately decent-but-simple, so beating it means
/// something and losing to it means something.
pub fn scripted_action(g : Game, c : Champ) -> Action {
  let legal = g.legal_actions(c)
  if legal.is_empty() {
    return Hold
  }
  let base = base_of(c.team)
  let foe = enemy_of(c.team)
  let here_enemies = g.champs_at(c.node, foe)
  let here_allies = g.champs_at(c.node, c.team)

  // At base with gold: buy the first thing it can afford. Buying *something*
  // is better than hoarding, and buying the RIGHT thing is what `smart` does.
  if c.node == base && c.items.length() < ITEM_SLOTS {
    for a in legal {
      if a is Buy(_) {
        return a
      }
    }
  }
  // Full pockets and no fight here: go and spend them. The weak bot's measure
  // of "full" is the cheapest thing in the shop, which is a component — it
  // buys early and badly, which is its job.
  if c.gold >= COMPONENT_COST &&
    c.items.length() < ITEM_SLOTS &&
    g.champs_at(c.node, foe).is_empty() &&
    legal.contains(Recall) {
    return Recall
  }

  // Ability on cooldown, at whatever is in front of it. This is the mistake the
  // weak bot is supposed to make: no timing at all.
  if c.ability_ready() && !here_enemies.is_empty() {
    for a in legal {
      if a is Cast(_, _) {
        return a
      }
    }
  }
  let finishable = here_enemies.filter(e => e.hp <= 20)
  let low = c.hp * 100 < c.max_hp * 35
  if low && finishable.is_empty() && legal.contains(Recall) {
    return Recall
  }
  if !finishable.is_empty() {
    return AttackChamp(finishable[0].id)
  }
  if !here_enemies.is_empty() {
    let outnumber = here_allies.length() >= here_enemies.length()
    let healthier = c.hp * here_enemies[0].max_hp >=
      here_enemies[0].hp * c.max_hp
    if outnumber || healthier || c.hp * 100 > c.max_hp * 55 {
      match g.focus_pick(c.node, c.team) {
        Some(t) => return AttackChamp(t.id)
        None => ()
      }
    }
    let away = step_toward(c.node, base)
    if away != c.node && legal.contains(Move(away)) {
      return Move(away)
    }
    match g.focus_pick(c.node, c.team) {
      Some(t) => return AttackChamp(t.id)
      None => ()
    }
  }
  // Free poke: a ranged champion chips a neighbour for nothing in return.
  if c.ranged {
    for a in legal {
      if a is Poke(_) {
        return a
      }
    }
  }
  if legal.contains(AttackStructure) {
    // A tower with no wave in front of it out-trades a single champion, so
    // clear the lane first. The weak bot only knows to do this alone; it never
    // brings friends, which is the gap `smart` closes.
    let alone = here_allies.length() < 2
    let shot = match g.structure_at(c.node) {
      Some(s) => g.tower_shoots(s, c)
      None => false
    }
    if alone && shot && legal.contains(Farm) {
      return Farm
    }
    return AttackStructure
  }
  if legal.contains(AttackNeutral) {
    return AttackNeutral
  }
  // Walk toward this champion's own lane objective; the jungler roams the
  // jungle and the river instead.
  let target = if c.role == "jungle" {
    let o = g.objective_target(c.team)
    if o >= 0 {
      o
    } else {
      g.lane_front(c.team, "mid")
    }
  } else {
    g.lane_front(c.team, if c.role == "support" { "bot" } else { c.role })
  }
  if target >= 0 && target != c.node {
    let next = step_toward_prefer(c.node, target, base_of(foe))
    if next != c.node && legal.contains(Move(next)) {
      return Move(next)
    }
  }
  if legal.contains(Farm) {
    return Farm
  }
  Hold
}

///|
pub fn scripted_team_actions(g : Game, team : Int) -> Map[Int, Action] {
  let out : Map[Int, Action] = Map([])
  for c in g.champs {
    if c.team == team && c.can_act() {
      out[c.id] = scripted_action(g, c)
    }
  }
  out
}

// ---------------------------------------------------------- the strong floor

///|
/// The item this champion should buy, given what the enemy is actually doing.
/// A counter-buy is arithmetic once the damage split is known — which is why
/// the observation hands the split over and the benchmark scores the *choice*.
pub fn Game::counter_item(self : Game, c : Champ) -> String {
  let foe = enemy_of(c.team)
  let ad_pct = self.visible_physical_share(c.team)
  // How much of the enemy's health our damage is being thrown away on: if
  // their matching resist is high, penetration beats raw attack.
  let mut resist_sum = 0
  let mut seen_n = 0
  for e in self.visible_enemies(c.team) {
    resist_sum += if c.dmg_type == DMG_PHYSICAL { e.armor() } else { e.mr() }
    seen_n += 1
  }
  if seen_n == 0 {
    for e in self.champs {
      if e.team == foe {
        resist_sum += if c.dmg_type == DMG_PHYSICAL {
          e.armor()
        } else {
          e.mr()
        }
        seen_n += 1
      }
    }
  }
  let avg_resist = if seen_n == 0 { 0 } else { resist_sum / seen_n }
  // A frontliner's job is to survive, so it buys the resist that is being
  // used against it. A carry's job is to deal damage, so it buys through.
  if c.frontline {
    if ad_pct >= 65 {
      "plate"
    } else if ad_pct <= 35 {
      "cloak"
    } else {
      "belt"
    }
  } else if avg_resist >= 45 {
    "pierce"
  } else if c.items.length() == 0 {
    "blade"
  } else if ad_pct >= 65 {
    "plate"
  } else if ad_pct <= 35 {
    "cloak"
  } else {
    "blade"
  }
}

///|
/// What this champion should actually put on the counter, given that the thing
/// it wants may cost more than it is holding.
///
/// Four steps, in the order a player takes them:
///
/// 1. the bigger item on the path, when it is affordable — `bulwark` for a
///    frontliner taking both kinds of damage, `edge` for a carry that already
///    has a sword in the bag and is half-paid for it;
/// 2. otherwise the item `counter_item` named, when THAT is affordable. This
///    step is the one worth spelling out: skipping an affordable completed
///    item to buy a component of a dearer one was the first version of this
///    function, and it cost the `item` class two of its six — the fight was
///    starting and the floor bought a hide;
/// 3. otherwise a component on the way, because a component is stats now and
///    the discount later;
/// 4. otherwise nothing, since an item off the path is a slot spent on the
///    wrong stat and the gold keeps.
pub fn Game::shop_pick(self : Game, c : Champ) -> String? {
  let want = self.counter_item(c)
  let bigger = if want == "belt" && c.frontline {
    // `belt` is the answer to a team doing both kinds of damage and `bulwark`
    // is the better one: 30 and 30 beats 45 and nothing when half of what we
    // take is the other kind, and it carries the health as well.
    "bulwark"
  } else if want == "blade" && c.count_of("sword") > 0 {
    // Already on the path and half-paid: `edge` is 18 attack where two blades
    // would be 16 for the same gold.
    "edge"
  } else {
    want
  }
  if c.can_buy(bigger) {
    return Some(bigger)
  }
  if c.can_buy(want) {
    return Some(want)
  }
  match item_of(bigger) {
    Some(it) =>
      for comp in it.builds_from {
        if c.count_of(comp) == 0 && c.can_buy(comp) {
          return Some(comp)
        }
      }
    None => ()
  }
  None
}

///|
/// The strong baseline. Acts on the team plan, fights only when the fight is
/// worth it, and spends abilities, wards and gold on purpose.
pub fn smart_action(g : Game, c : Champ, plan : Plan) -> Action {
  let legal = g.legal_actions(c)
  if legal.is_empty() {
    return Hold
  }
  let base = base_of(c.team)
  let foe = enemy_of(c.team)
  let here_enemies = g.champs_at(c.node, foe)
  let here_allies = g.champs_at(c.node, c.team)

  // At base: buy the counter-item, or a component on the way to it, and only
  // then walk back out.
  if c.node == base {
    let want = match g.shop_pick(c) {
      Some(k) => k
      None => ""
    }
    for a in legal {
      if a == Buy(want) {
        return a
      }
    }
  }

  // A kill that is right here, taken before anything else.
  let finishable = here_enemies.filter(e => {
    let real = g.guarded_target(e, c.node)
    real.id == e.id && g.damage_to_champ(c, e) >= e.hp + e.shield
  })
  if !finishable.is_empty() {
    return AttackChamp(finishable[0].id)
  }
  let low = c.hp * 100 < c.max_hp * 35
  if !here_enemies.is_empty() {
    // Commit with a numbers edge, with a wall to soak the focus, or when the
    // simulator says this fight is ours. Otherwise disengage rather than trade
    // badly — a lost 5v5 is the fastest way to lose the game.
    let mut have_front = false
    for a in here_allies {
      if a.frontline {
        have_front = true
      }
    }
    let outnumber = here_allies.length() > here_enemies.length()
    let even_ok = here_allies.length() == here_enemies.length() &&
      c.hp * 100 > c.max_hp * 50
    let winnable = here_allies.length() >= 2 &&
      here_enemies.length() >= 2 &&
      g.fight_is_won(c.node, c.team, 12)
    if outnumber ||
      even_ok ||
      winnable ||
      (have_front && c.hp * 100 > c.max_hp * 40) {
      match g.ability_play(c) {
        Some(a) => if legal.contains(a) { return a }
        None => ()
      }
      match g.focus_pick(c.node, c.team) {
        Some(t) => return AttackChamp(t.id)
        None => ()
      }
    }
    // Losing this one: a support still shields on the way out, and a ranged
    // champion still pokes as it backs off.
    match g.ability_play(c) {
      Some(Cast(Shield(p), t)) =>
        if legal.contains(Cast(Shield(p), t)) {
          return Cast(Shield(p), t)
        }
      Some(Cast(Heal(p), t)) =>
        if legal.contains(Cast(Heal(p), t)) {
          return Cast(Heal(p), t)
        }
      _ => ()
    }
    if low && legal.contains(Recall) {
      return Recall
    }
    let away = step_toward(c.node, base)
    if away != c.node && legal.contains(Move(away)) {
      return Move(away)
    }
    match g.focus_pick(c.node, c.team) {
      Some(t) => return AttackChamp(t.id)
      None => ()
    }
  }

  // No fight here. Remember the poke that is available: it used to be taken
  // straight away, but a poke is no longer free, and whether the wave is worth
  // more than the poke is decided below — once the plan has had its say about
  // where this champion should be standing.
  let poke : Action? = {
    let mut found = None
    for a in legal {
      if a is Poke(_) {
        found = Some(a)
        break
      }
    }
    found
  }

  // Reset while there is no fight to lose by leaving — and go home to SPEND,
  // too. Gold sitting in a champion's pocket is a stat it does not have; the
  // trip costs a few ticks and buys a permanent edge.
  //
  // Not off a live objective, though. The gold will still be there in three
  // ticks and the monster will not, and this was the other half of why the
  // river went unfought: a jungler standing on the drake with enough gold for
  // an item recalled, bought, walked back, and recalled again, so the trace
  // read as ten ticks of commuting past a monster nobody touched.
  let on_objective = g.neutral_at(c.node) is Some(_)
  if low && !on_objective && legal.contains(Recall) {
    return Recall
  }
  // Go home when there is something to buy, rather than when the pocket holds
  // one item's worth. Since the shop grew tiers those are different questions:
  // a champion with 200 gold and a sword in the bag can afford the blade that
  // sword builds into, and a champion with 340 and three completed items can
  // afford nothing at all.
  if !on_objective && g.shop_pick(c) is Some(_) && legal.contains(Recall) {
    return Recall
  }

  // Ward the river before the next monster spawns, so the objective fight
  // starts with vision instead of a guess.
  if c.wards > 0 {
    for n in neutral_soon(g) {
      if g.has_ward(c.team, n) {
        continue
      }
      for a in legal {
        if a == PlaceWard(n) {
          return a
        }
      }
    }
  }

  // What is under our feet is only worth hitting if the plan wants us here.
  // Attacking whatever happens to be on this node regardless is how five
  // champions with one plan turn back into five champions with five: a team
  // told to answer top lane would stand on the dragon and take the dragon,
  // because the dragon was there.
  let target = plan.goto[c.id]
  let at_target = target < 0 || target == c.node
  if at_target && legal.contains(AttackNeutral) {
    // Only with enough bodies that the enemy cannot simply steal it off us.
    if here_allies.length() >= 2 || g.neutral_at(c.node) is Some(_) {
      return AttackNeutral
    }
  }
  if at_target && legal.contains(AttackStructure) {
    let grouped = here_allies.length() >= 3
    let nearly = match g.structure_at(c.node) {
      Some(s) => s.hp <= g.damage_to_structure(c) * here_allies.length()
      None => false
    }
    let shot = match g.structure_at(c.node) {
      Some(s) => g.tower_shoots(s, c)
      None => false
    }
    // Shove the lane before touching the tower: without a wave the tower wins
    // the trade, and with one it does not fire at all. Three bodies can eat a
    // tower's damage long enough to break it outright, and a nearly-dead
    // structure is worth finishing whatever it costs.
    if shot && !grouped && !nearly && legal.contains(Farm) {
      return Farm
    }
    if grouped || nearly || !shot || !low {
      return AttackStructure
    }
  }
  if target >= 0 && target != c.node {
    // A blink is worth it when it saves a whole move toward where we are going.
    for a in legal {
      match a {
        Blink(n) => if hops(n, target) + 1 < hops(c.node, target) { return a }
        _ => ()
      }
    }
    let next = step_toward_prefer(c.node, target, base_of(foe))
    if next != c.node && legal.contains(Move(next)) {
      return Move(next)
    }
  }
  // The plan is satisfied, so now the lane's economy decides. Standing in a
  // lane and spending the tick on anything but the wave leaves the low minions
  // to our own side at `CS_GOLD` each, so take the gold when there is gold on
  // the floor and poke when there is not.
  //
  // The order matters, and getting it wrong was instructive: checking this
  // BEFORE the movement above made every champion standing in a lane farm
  // instead of rotating, so `simulate_macro` scored every plan identically
  // (1197 against 1197 against 1197) and two macro questions became questions
  // whose every answer was correct. A baseline that ignores the plan is not a
  // baseline for a plan.
  if g.ripe_here(c.node, c.team) > 0 && legal.contains(Farm) {
    return Farm
  }
  match poke {
    Some(a) => return a
    None => ()
  }
  if legal.contains(Farm) {
    return Farm
  }
  Hold
}

///|
/// River nodes whose monster is up or about to be, worth a ward. Vision on the
/// pit before the timer is the cheapest macro advantage in the game.
pub fn neutral_soon(g : Game) -> Array[Int] {
  let out = []
  for n in g.neutrals {
    if n.alive() || n.spawn_in <= 2 {
      out.push(n.node)
    }
  }
  out
}

///|
pub fn smart_team_actions(g : Game, team : Int) -> Map[Int, Action] {
  let plan = g.team_plan(team)
  let out : Map[Int, Action] = Map([])
  for c in g.champs {
    if c.team == team && c.can_act() {
      out[c.id] = smart_action(g, c, plan)
    }
  }
  out
}

///|
/// Dispatch a named baseline policy for a whole team. `jev` is handled by the
/// CLI, which owns the client; anything unknown falls back to `scripted`.
pub fn baseline_team_actions(
  g : Game,
  team : Int,
  policy : String,
) -> Map[Int, Action] {
  if policy == "smart" {
    smart_team_actions(g, team)
  } else {
    scripted_team_actions(g, team)
  }
}
