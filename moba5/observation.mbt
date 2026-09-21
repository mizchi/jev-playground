///|
/// The team observation, and the turn message a referee sends a player.
///
/// The observation is the contract of the experiment: a policy — scripted or
/// Jev — may only read what is in here, which is what the team can actually
/// see. Team vision is shared, so there is exactly ONE observation per team per
/// tick and FIVE champions who each need a decision from it. That ratio is the
/// whole reason this game is a good measurement of a decision model: the state
/// is paid for once and answers five questions, plus whatever team-level reads
/// ride along for free.

///|
/// What a team remembers about enemies it can no longer see. Real fog of war is
/// not just "unknown": you know where you last saw someone, and roughly how
/// stale that is.
pub struct Memory {
  /// Last node each champion id was seen on, or -1. Sized for all ten ids so
  /// it can be indexed by id directly.
  last_seen_node : Array[Int]
  last_seen_tick : Array[Int]
  /// Health each enemy had when last seen, or -1.
  last_seen_hp : Array[Int]
}

///|
pub fn Memory::new() -> Memory {
  {
    last_seen_node: Array::make(10, -1),
    last_seen_tick: Array::make(10, -1),
    last_seen_hp: Array::make(10, -1),
  }
}

///|
pub fn Memory::observe(self : Memory, g : Game, team : Int) -> Unit {
  for e in g.visible_enemies(team) {
    self.last_seen_node[e.id] = e.node
    self.last_seen_tick[e.id] = g.tick
    self.last_seen_hp[e.id] = e.hp
  }
}

// --------------------------------------------------------- derived team reads

///|
/// How much of the damage a team actually threatens is physical, in percent.
/// This is the number an itemisation decision turns on, and it is visible to
/// whoever bothers to add up what they can see — so putting it in the
/// observation hands over arithmetic, not judgment.
pub fn Game::physical_share(self : Game, team : Int) -> Int {
  let mut ad = 0
  let mut total = 0
  for c in self.champs {
    if c.team == team && c.alive() {
      let d = self.raw_attack(c)
      total += d
      if c.dmg_type == DMG_PHYSICAL {
        ad += d
      }
    }
  }
  if total == 0 {
    return 50
  }
  ad * 100 / total
}

///|
/// The same read, restricted to the enemies a team can currently see. A policy
/// that has only seen two of five enemies should itemise against those two.
pub fn Game::visible_physical_share(self : Game, team : Int) -> Int {
  let mut ad = 0
  let mut total = 0
  for c in self.visible_enemies(team) {
    let d = self.raw_attack(c)
    total += d
    if c.dmg_type == DMG_PHYSICAL {
      ad += d
    }
  }
  if total == 0 {
    return 50
  }
  ad * 100 / total
}

///|
/// A single scalar for "how strong is this team right now": damage per tick
/// times survivability, summed over living bodies. Used for the power read and
/// for tie-breaking a game that hits the tick cap.
pub fn Game::team_power(self : Game, team : Int) -> Int {
  let mut total = 0
  for c in self.champs {
    if c.team == team && c.alive() {
      total += self.raw_attack(c) * c.effective_hp() / 100
    }
  }
  total
}

///|
/// The lane whose structure is closest to falling to the enemy, and how many
/// ticks of current pressure that would take. `(-1, big)` when nothing is under
/// pressure. This is the read that decides whether a team can afford to be at
/// an objective.
pub fn Game::lane_under_pressure(self : Game, team : Int) -> (Int, Int) {
  let foe = enemy_of(team)
  let mut worst = -1
  let mut soonest = 1 << 28
  for li in 0..<3 {
    let lane = lanes[li]
    // Pressure against us is the enemy pushing: negative for team A.
    let against = if team == TEAM_A { -self.push[li] } else { self.push[li] }
    if against < PUSH_TO_TOWER {
      continue
    }
    // Only as far as minions go: a wave cannot take a nexus, so a lane whose
    // towers are already gone is not "about to fall" to minions.
    let front = self.minion_front(foe, lane)
    if front < 0 {
      continue
    }
    match self.structure_at(front) {
      Some(s) => {
        let ticks = (s.hp + MINION_DAMAGE - 1) / MINION_DAMAGE
        if ticks < soonest {
          soonest = ticks
          worst = li
        }
      }
      None => ()
    }
  }
  (worst, soonest)
}

// ------------------------------------------------------------- the observation

///|
/// Everything `team` is allowed to know this tick, as JSON. Enemy champions
/// appear only when visible; otherwise they show up under `enemies_last_known`
/// with how stale the sighting is.
pub fn Game::observation(self : Game, team : Int, mem : Memory) -> Json {
  let foe = enemy_of(team)
  let seen = self.vision(team)
  let enemy_base = base_of(foe)
  let own_base = base_of(team)

  let allies = []
  for c in self.champs {
    if c.team != team {
      continue
    }
    if c.alive() {
      let ability = Json({
        "name": Json(c.ability.name()),
        "does": Json(c.ability.describe()),
        "ready": Json(c.cd == 0 && c.ability != NoAbility),
        "ticks_until_ready": Json(c.cd),
      })
      allies.push(
        Json({
          "id": Json(c.id),
          "name": Json(c.name),
          "role": Json(c.role),
          "kind": Json(c.kind),
          "level": Json(c.level),
          "deals": Json(
            if c.dmg_type == DMG_PHYSICAL {
              "physical"
            } else {
              "magic"
            },
          ),
          "attack_range": Json(if c.ranged { "ranged" } else { "melee" }),
          "frontline": Json(c.frontline),
          "hp": Json(c.hp),
          "max_hp": Json(c.max_hp),
          "shield": Json(c.shield),
          "stunned_for": Json(c.stunned),
          "attack": Json(self.raw_attack(c)),
          "armor": Json(c.armor()),
          "magic_resist": Json(c.mr()),
          "penetration": Json(c.pen()),
          "ability": ability,
          "at": Json(node_name(c.node)),
          "gold": Json(c.gold),
          "items": Json(c.items.map(x => Json::string(x))),
          "item_slots_free": Json(ITEM_SLOTS - c.items.length()),
          "wards_in_hand": Json(c.wards),
          "kills": Json(c.kills),
          "deaths": Json(c.deaths),
          "assists": Json(c.assists),
          "hops_to_enemy_nexus": Json(hops(c.node, enemy_base)),
          "hops_to_home": Json(hops(c.node, own_base)),
        }),
      )
    } else {
      allies.push(
        Json({
          "id": Json(c.id),
          "name": Json(c.name),
          "role": Json(c.role),
          "kind": Json(c.kind),
          "level": Json(c.level),
          "dead_for_ticks": Json(c.respawn),
        }),
      )
    }
  }

  // Enemy archetype, level and resists are visible when the champion is: this
  // is what lets a team notice "they are all physical, buy armor" or "their
  // carry is two levels down".
  let visible = []
  for e in self.visible_enemies(team) {
    visible.push(
      Json({
        "id": Json(e.id),
        "name": Json(e.name),
        "kind": Json(e.kind),
        "level": Json(e.level),
        "deals": Json(
          if e.dmg_type == DMG_PHYSICAL {
            "physical"
          } else {
            "magic"
          },
        ),
        "attack_range": Json(if e.ranged { "ranged" } else { "melee" }),
        "frontline": Json(e.frontline),
        "hp": Json(e.hp),
        "max_hp": Json(e.max_hp),
        "shield": Json(e.shield),
        "attack": Json(self.raw_attack(e)),
        "armor": Json(e.armor()),
        "magic_resist": Json(e.mr()),
        "ability": Json(e.ability.name()),
        "ability_does": Json(e.ability.describe()),
        "items": Json(e.items.map(x => Json::string(x))),
        "at": Json(node_name(e.node)),
      }),
    )
  }

  let remembered = []
  for e in self.champs {
    if e.team == team || !e.alive() || seen[e.node] {
      continue
    }
    let node = mem.last_seen_node[e.id]
    if node >= 0 {
      remembered.push(
        Json({
          "name": Json(e.name),
          "kind": Json(e.kind),
          "last_seen_at": Json(node_name(node)),
          "ticks_ago": Json(self.tick - mem.last_seen_tick[e.id]),
          "hp_when_seen": Json(mem.last_seen_hp[e.id]),
        }),
      )
    } else {
      remembered.push(
        Json({
          "name": Json(e.name),
          "kind": Json(e.kind),
          "last_seen_at": Json("never"),
        }),
      )
    }
  }
  // A dead enemy is not a mystery — everyone gets a death notification.
  let enemy_dead = []
  for e in self.champs {
    if e.team != team && !e.alive() {
      enemy_dead.push(
        Json({
          "name": Json(e.name),
          "kind": Json(e.kind),
          "respawns_in": Json(e.respawn),
        }),
      )
    }
  }

  let structures = []
  for s in self.structures {
    structures.push(
      Json({
        "at": Json(node_name(s.node)),
        "lane": Json(s.lane),
        "kind": Json(s.kind_name()),
        "side": Json(if s.team == team { "ours" } else { "theirs" }),
        "hp": Json(s.hp),
        "max_hp": Json(s.max_hp),
        "attackable_now": Json(s.alive() && self.structure_attackable(s)),
      }),
    )
  }

  // Lane state: which way the minions are going, and what that is worth. The
  // arithmetic is given; the judgment (is this worth leaving an objective for)
  // is not.
  let lane_rows = []
  for li in 0..<3 {
    let ours = if team == TEAM_A { self.push[li] } else { -self.push[li] }
    let verdict = if ours >= PUSH_TO_TOWER {
      "our minions are hitting their structure"
    } else if ours <= -PUSH_TO_TOWER {
      "their minions are hitting OUR structure"
    } else if ours > 0 {
      "we are slightly ahead"
    } else if ours < 0 {
      "they are slightly ahead"
    } else {
      "even"
    }
    lane_rows.push(
      Json({
        "lane": Json(lanes[li]),
        "push": Json(ours),
        "state": Json(verdict),
        "we_hold_the_wave_here": Json(self.has_wave(team, lanes[li])),
        "they_hold_the_wave_here": Json(self.has_wave(foe, lanes[li])),
        "our_front_target": Json(
          match self.lane_front(team, lanes[li]) {
            -1 => "nothing left"
            n => node_name(n)
          },
        ),
        "their_front_target": Json(
          match self.lane_front(foe, lanes[li]) {
            -1 => "nothing left"
            n => node_name(n)
          },
        ),
        "lane_open_for_them": Json(self.lane_open(team, lanes[li])),
        "lane_open_for_us": Json(self.lane_open(foe, lanes[li])),
      }),
    )
  }

  let objectives = []
  for n in self.neutrals {
    objectives.push(
      Json({
        "monster": Json(n.key),
        "at": Json(node_name(n.node)),
        "up_now": Json(n.alive()),
        "spawns_in": Json(n.spawn_in),
        "hp": Json(if n.alive() { n.hp } else { 0 }),
        "max_hp": Json(n.max_hp),
        "reward": Json(
          if n.key == "baron" {
            "+\{BARON_ATK_PCT}% attack and +\{BARON_STRUCT_PCT}% structure damage for \{BARON_TICKS} ticks, whole team"
          } else {
            "a permanent +\{DRAGON_ATK_PCT}% attack stack, whole team"
          },
        ),
        "visible": Json(seen[n.node]),
      }),
    )
  }

  let our_wards = []
  for w in self.wards_of(team) {
    our_wards.push(
      Json({ "at": Json(node_name(w.node)), "expires_in": Json(w.ttl) }),
    )
  }

  let visible_nodes = []
  let blind_nodes = []
  for i in 0..<N_NODES {
    if seen[i] {
      visible_nodes.push(Json(node_names[i]))
    } else {
      blind_nodes.push(Json(node_names[i]))
    }
  }
  let (worst_lane, worst_ticks) = self.lane_under_pressure(team)
  let brush_list = []
  for n in brush_nodes {
    brush_list.push(Json(node_names[n]))
  }

  Json({
    "game": Json(
      "5v5 MOBA: three lanes (top/mid/bot), a jungle each side, and a river with two epic monsters",
    ),
    "objective": Json(
      "Destroy the enemy nexus. A nexus can only be attacked once BOTH towers in at least one of its lanes are down; an inner tower cannot be attacked while its own lane's outer tower stands.",
    ),
    "rules": Json(
      "One action per champion per tick. Moving is one node; a blink is two. Ranged champions can poke an adjacent node for half damage and take nothing back. Abilities have cooldowns; a stun removes the target's next turn outright. Recalling teleports home, heals, and restocks wards; out of combat a champion regenerates slowly on the spot. Gold buys items at base, experience buys levels, and both raise your stats.",
    ),
    "minion_rule": Json(
      "Farming a lane shoves its wave one step toward the enemy. A structure does NOT shoot a champion whose own team holds that lane's wave — the minions are what it shoots instead — so a champion alone under a tower with no wave loses that trade, and the same champion behind a wave takes the tower down. A wave shoved far enough chips the enemy TOWER on its own, but minions never damage a nexus: closing the game needs champions standing in their base. A lane both teams have left drifts back to even.",
    ),
    "tick": Json(self.tick),
    "you_are": Json("team \{team_name(team)}"),
    "your_base": Json(node_name(own_base)),
    "enemy_base": Json(node_name(enemy_base)),
    "their_nexus_attackable": Json(self.nexus_exposed(foe)),
    "our_nexus_attackable": Json(self.nexus_exposed(team)),
    "your_champions": Json(allies),
    "enemies_visible_now": Json(visible),
    "enemies_last_known": Json(remembered),
    "enemies_dead": Json(enemy_dead),
    "structures": Json(structures),
    "lanes": Json(lane_rows),
    "objectives": Json(objectives),
    "our_wards": Json(our_wards),
    "team_reads": Json({
      "our_total_level": Json(self.team_level(team)),
      "their_total_level_if_seen": Json(self.team_level(foe)),
      "our_gold_earned": Json(self.team_gold(team)),
      "their_damage_is_physical_pct": Json(self.visible_physical_share(team)),
      "our_dragon_stacks": Json(self.dragons[team]),
      "their_dragon_stacks": Json(self.dragons[foe]),
      "our_baron_ticks_left": Json(self.baron[team]),
      "their_baron_ticks_left": Json(self.baron[foe]),
      "lane_in_most_danger": Json(
        if worst_lane < 0 {
          "none"
        } else {
          lanes[worst_lane]
        },
      ),
      "ticks_until_that_structure_falls": Json(
        if worst_lane < 0 {
          -1
        } else {
          worst_ticks
        },
      ),
    }),
    "nodes_you_can_see": Json(visible_nodes),
    "nodes_you_are_blind_to": Json(blind_nodes),
    "map": Json(
      "Each lane runs a_base - a2_LANE - a1_LANE - mid_LANE - b1_LANE - b2_LANE - b_base. a_jg_top and a_jg_bot touch team A's lanes and the river; b_jg_top and b_jg_bot do the same for team B. riv_top (Baron) touches mid_top, mid_mid and both top jungles; riv_bot (Dragon) touches mid_bot, mid_mid and both bottom jungles.",
    ),
    "brush_rule": Json(
      "The four jungle nodes are BRUSH. Standing next to a brush shows you nothing inside it, and standing IN one shows you the nodes around it as normal — so a champion waiting in a brush is invisible to everyone outside it, and can see who is walking past. A ward placed in a brush is the only way to watch it from outside. Every node listed under nodes_you_are_blind_to could be holding enemies; a brush next to a lane you are pushing is where they would be.",
    ),
    "brush_nodes": Json(brush_list),
  })
}

// ---------------------------------------------------------- the turn message

///|
/// The turn message for one team: its observation, and for each champion that
/// can act the legal moves with descriptions. This is everything a player needs
/// to build its request, and nothing about the other team beyond what fog of
/// war already reveals. Champions that are dead or stunned are absent — the
/// question is simply not asked.
pub fn Game::turn_message(self : Game, team : Int, mem : Memory) -> Json {
  let champs = []
  for c in self.champs {
    if c.team != team || !c.can_act() {
      continue
    }
    let actions : Map[String, Json] = Map([])
    for a in self.legal_actions(c) {
      actions[a.to_string()] = Json::string(self.describe_action(c, a))
    }
    champs.push(
      Json({
        "id": Json(c.id),
        "name": Json(c.name),
        "role": Json(c.role),
        "kind": Json(c.kind),
        "level": Json(c.level),
        "hp": Json(c.hp),
        "max_hp": Json(c.max_hp),
        "at": Json(node_name(c.node)),
        "actions": Json(actions),
      }),
    )
  }
  let nodes = []
  for i in 0..<N_NODES {
    nodes.push(Json(node_names[i]))
  }
  Json({
    "type": Json("turn"),
    "tick": Json(self.tick),
    "team": Json(team_name(team)),
    "observation": self.observation(team, mem),
    "champions": Json(champs),
    "all_nodes": Json(nodes),
  })
}
