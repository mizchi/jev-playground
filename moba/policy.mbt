///|
/// The scripted baseline, and the team observation both policies are limited
/// to.
///
/// The observation is the contract of the experiment: a policy — scripted or
/// Jev — may only read what is in here, which is what the team can actually
/// see. Team vision is shared, so there is exactly one observation per team
/// per tick, and that is what makes three champions' decisions fit in one
/// request.

///|
/// What a team remembers about enemies it can no longer see. Real fog of war
/// is not just "unknown": you know where you last saw someone.
pub struct Memory {
  /// Last node each enemy champion was seen on, or -1.
  last_seen_node : Array[Int]
  /// Tick at which that sighting happened.
  last_seen_tick : Array[Int]
}

///|
pub fn Memory::new() -> Memory {
  { last_seen_node: Array::make(6, -1), last_seen_tick: Array::make(6, -1), }
}

///|
pub fn Memory::observe(self : Memory, g : Game, team : Int) -> Unit {
  for e in g.visible_enemies(team) {
    self.last_seen_node[e.id] = e.node
    self.last_seen_tick[e.id] = g.tick
  }
}

///|
/// The enemy structure in `lane` that a team should be pushing, or the enemy
/// base once both towers are down.
pub fn Game::lane_objective(self : Game, team : Int, lane : String) -> Int {
  let enemy = if team == TEAM_A { TEAM_B } else { TEAM_A }
  for s in self.structures {
    if s.team == enemy && s.alive() && !s.is_base && node_lane[s.node] == lane {
      return s.node
    }
  }
  // Nothing left in that lane: head for whatever is still standing.
  for s in self.structures {
    if s.team == enemy && s.alive() && !s.is_base {
      return s.node
    }
  }
  base_of(enemy)
}

///|
/// The one structure a smart team concentrates on: the enemy's lowest-HP
/// standing tower (finish what is already hurt), or the base once both towers
/// are down. Every champion targets the SAME node, so the team groups instead
/// of splitting one champion per lane — which is the scripted bot's main flaw.
pub fn Game::smart_objective(self : Game, team : Int) -> Int {
  let enemy = if team == TEAM_A { TEAM_B } else { TEAM_A }
  let mut best_node = -1
  let mut best_hp = 1 << 30
  for s in self.structures {
    if s.team == enemy && s.alive() && !s.is_base && s.hp < best_hp {
      best_hp = s.hp
      best_node = s.node
    }
  }
  if best_node >= 0 {
    best_node
  } else {
    base_of(enemy)
  }
}

///|
/// The scripted opponent: retreat when low, fight when it has the numbers,
/// otherwise push its own lane and farm. Deliberately a decent-but-simple
/// bot, so beating it means something and losing to it means something.
pub fn scripted_action(g : Game, c : Champ) -> Action {
  let legal = g.legal_actions(c)
  if legal.is_empty() {
    return Hold
  }
  let base = base_of(c.team)
  let enemy_team = if c.team == TEAM_A { TEAM_B } else { TEAM_A }
  let here_enemies = g.champs_at(c.node, enemy_team)
  let here_allies = g.champs_at(c.node, c.team)

  // Focus fire: hit the softest target here (lowest current HP). This is what
  // makes a durable frontline worth having — a tank draws no more fire than a
  // marksman, but survives it, so the squishies behind it live.
  fn softest() -> Champ {
    let mut pick = here_enemies[0]
    for e in here_enemies {
      if e.hp < pick.hp {
        pick = e
      }
    }
    pick
  }

  // Badly hurt (below ~35% of this champion's own max), go home unless a kill
  // is right here. Using a fraction, not a flat number, so a tank does not
  // flee at the HP a marksman fights on.
  let low = c.hp * 100 < c.max_hp * 35
  let finishable = here_enemies.filter(e => e.hp <= 15)
  if low && finishable.is_empty() {
    if legal.contains(Recall) {
      return Recall
    }
  }
  if !finishable.is_empty() {
    return AttackChamp(finishable[0].id)
  }
  if !here_enemies.is_empty() {
    // Fight with the numbers, on a health lead, or simply while healthy.
    // An earlier version backed off on an even matchup, which turned every
    // game into a lane standoff where no structure was ever touched.
    let outnumber = here_allies.length() >= here_enemies.length()
    let healthier = c.hp * here_enemies[0].max_hp >=
      here_enemies[0].hp * c.max_hp
    if outnumber || healthier || c.hp * 100 > c.max_hp * 55 {
      return AttackChamp(softest().id)
    }
    let away = step_toward(c.node, base)
    if away != c.node && legal.contains(Move(away)) {
      return Move(away)
    }
    return AttackChamp(softest().id)
  }
  // Standing under an enemy structure with nobody to fight: hit it.
  if legal.contains(AttackStructure) {
    return AttackStructure
  }
  // Walk toward this champion's objective; farm when already on the way.
  let target = g.lane_objective(c.team, c.role)
  if c.node == target {
    if legal.contains(Farm) {
      return Farm
    }
    return Hold
  }
  let next = step_toward(c.node, target)
  if next != c.node && legal.contains(Move(next)) {
    return Move(next)
  }
  if legal.contains(Farm) {
    return Farm
  }
  Hold
}

///|
/// A stronger baseline. Two disciplines the scripted bot lacks:
///
/// - **Grouping.** Every champion pushes ONE shared objective
///   (`smart_objective`) instead of its own lane, so the team concentrates
///   force — a tower falls ~3x faster and a fight is fought with the numbers.
/// - **Disciplined trading.** It commits to a fight only with a body advantage
///   or a frontline to eat the focus, and pulls out before feeding a tower or a
///   lost trade (siege-and-reset). Because it is grouped, pulling back and
///   returning together is a siege rather than a passive recall.
///
/// It plays a fair policy — only its own node's enemies and public structure
/// HP, never global vision. Used as the raised baseline in docs/12.
pub fn smart_action(g : Game, c : Champ) -> Action {
  let legal = g.legal_actions(c)
  if legal.is_empty() {
    return Hold
  }
  let base = base_of(c.team)
  let enemy_team = if c.team == TEAM_A { TEAM_B } else { TEAM_A }
  let here_enemies = g.champs_at(c.node, enemy_team)
  let here_allies = g.champs_at(c.node, c.team)
  fn softest() -> Champ {
    let mut pick = here_enemies[0]
    for e in here_enemies {
      if e.hp < pick.hp {
        pick = e
      }
    }
    pick
  }

  // Take a kill that is right here, no matter what.
  let finishable = here_enemies.filter(e => e.hp <= 15)
  if !finishable.is_empty() {
    return AttackChamp(finishable[0].id)
  }
  let low = c.hp * 100 < c.max_hp * 35
  if !here_enemies.is_empty() {
    // Commit only with a numbers edge or a frontline to soak the focus;
    // otherwise disengage rather than trade badly, and reset if low.
    let mut have_front = false
    for a in here_allies {
      if a.frontline {
        have_front = true
      }
    }
    let outnumber = here_allies.length() > here_enemies.length()
    let even_ok = here_allies.length() == here_enemies.length() &&
      c.hp * 100 > c.max_hp * 50
    if outnumber || even_ok || (have_front && c.hp * 100 > c.max_hp * 40) {
      return AttackChamp(softest().id)
    }
    if low && legal.contains(Recall) {
      return Recall
    }
    let away = step_toward(c.node, base)
    if away != c.node && legal.contains(Move(away)) {
      return Move(away)
    }
    return AttackChamp(softest().id)
  }
  // On an enemy structure: COMMIT to the break when grouped (2+ here) or nearly
  // done, even at low HP — a grouped tower dive trades bodies for a tower and
  // wins the race, which is exactly what the scripted bot is too timid to do.
  // Only reset (recall) when sieging alone and low.
  if legal.contains(AttackStructure) {
    let grouped = here_allies.length() >= 2
    let nearly = match g.structure_at(c.node) {
      Some(s) =>
        s.hp <= c.damage_to(STRUCT_ARMOR, STRUCT_MR) * here_allies.length()
      None => false
    }
    if grouped || nearly || !low {
      return AttackStructure
    }
    if legal.contains(Recall) {
      return Recall
    }
    return AttackStructure
  }
  // No fight, no structure here: reset if low, else converge on the one team
  // objective so the team breaks it together.
  if low && legal.contains(Recall) {
    return Recall
  }
  let target = g.smart_objective(c.team)
  if c.node == target {
    if legal.contains(Farm) {
      return Farm
    }
    return Hold
  }
  let next = step_toward(c.node, target)
  if next != c.node && legal.contains(Move(next)) {
    return Move(next)
  }
  if legal.contains(Farm) {
    return Farm
  }
  Hold
}

// ------------------------------------------------------------- observation

///|
/// Everything `team` is allowed to know this tick, as JSON. Enemy champions
/// appear only when visible; otherwise they show up under
/// `enemies_last_known` with how stale the sighting is.
pub fn Game::observation(self : Game, team : Int, mem : Memory) -> Json {
  let enemy_team = if team == TEAM_A { TEAM_B } else { TEAM_A }
  let seen = self.vision(team)
  let enemy_base = base_of(enemy_team)
  let own_base = base_of(team)

  let allies = []
  for c in self.champs {
    if c.team != team {
      continue
    }
    if c.alive() {
      allies.push(
        Json({
          "id": Json(c.id),
          "name": Json(c.name),
          "lane": Json(c.role),
          "kind": Json(c.kind),
          "deals": Json(
            if c.dmg_type == DMG_PHYSICAL {
              "physical"
            } else {
              "magic"
            },
          ),
          "frontline": Json(c.frontline),
          "hp": Json(c.hp),
          "max_hp": Json(c.max_hp),
          "armor": Json(c.armor),
          "magic_resist": Json(c.mr),
          "at": Json(node_name(c.node)),
          "gold": Json(c.gold),
          "hops_to_enemy_base": Json(hops(c.node, enemy_base)),
          "hops_to_home": Json(hops(c.node, own_base)),
        }),
      )
    } else {
      allies.push(
        Json({
          "id": Json(c.id),
          "name": Json(c.name),
          "lane": Json(c.role),
          "kind": Json(c.kind),
          "dead_for_ticks": Json(c.respawn),
        }),
      )
    }
  }

  let visible = []
  for e in self.visible_enemies(team) {
    // Enemy archetype and resists are visible when the champion is: this is
    // what lets a team notice "they are all physical, focus armor" or "their
    // carry has low magic resist".
    visible.push(
      Json({
        "id": Json(e.id),
        "name": Json(e.name),
        "kind": Json(e.kind),
        "deals": Json(
          if e.dmg_type == DMG_PHYSICAL {
            "physical"
          } else {
            "magic"
          },
        ),
        "frontline": Json(e.frontline),
        "hp": Json(e.hp),
        "armor": Json(e.armor),
        "magic_resist": Json(e.mr),
        "at": Json(node_name(e.node)),
      }),
    )
  }

  // Fog of war: what we knew, and how old it is.
  let remembered = []
  for e in self.champs {
    if e.team != team && e.alive() && !seen[e.node] {
      let node = mem.last_seen_node[e.id]
      if node >= 0 {
        remembered.push(
          Json({
            "name": Json(e.name),
            "last_seen_at": Json(node_name(node)),
            "ticks_ago": Json(self.tick - mem.last_seen_tick[e.id]),
          }),
        )
      } else {
        remembered.push(
          Json({ "name": Json(e.name), "last_seen_at": Json("never") }),
        )
      }
    }
  }

  let structures = []
  for s in self.structures {
    structures.push(
      Json({
        "at": Json(node_name(s.node)),
        "kind": Json(if s.is_base { "base" } else { "tower" }),
        "side": Json(if s.team == team { "ours" } else { "theirs" }),
        "hp": Json(s.hp),
      }),
    )
  }

  let visible_nodes = []
  for i in 0..<N_NODES {
    if seen[i] {
      visible_nodes.push(Json(node_names[i]))
    }
  }

  Json({
    "game": Json("3v3 MOBA, two lanes and a jungle"),
    "objective": Json(
      "Destroy the enemy base. Both enemy towers must fall before the base can be attacked.",
    ),
    "rules": Json(
      "One move per tick to an adjacent node. Standing on an enemy tower takes damage every tick. Recalling teleports home and heals. Gold from farming and kills adds damage.",
    ),
    "tick": Json(self.tick),
    "you_are": Json(if team == TEAM_A { "team A" } else { "team B" }),
    "your_base": Json(node_name(own_base)),
    "enemy_base": Json(node_name(enemy_base)),
    "enemy_base_attackable": Json(self.base_exposed(enemy_team)),
    "our_base_attackable": Json(self.base_exposed(team)),
    "your_champions": Json(allies),
    "enemies_visible_now": Json(visible),
    "enemies_last_known": Json(remembered),
    "structures": Json(structures),
    "nodes_you_can_see": Json(visible_nodes),
    "map": Json(
      "a_base-{a_top,a_bot,a_jg}; a_top-m_top-b_top-b_base; a_bot-m_bot-b_bot-b_base; a_jg-m_jg-b_jg-b_base; m_jg also touches m_top and m_bot",
    ),
  })
}
