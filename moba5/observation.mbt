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
          "minions_killed": Json(c.cs),
          "minions_let_die": Json(c.cs_lost),
          "minions_ripe_here": Json(self.ripe_here(c.node, c.team)),
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
        "plates_left": Json(s.plates),
        "comes_back_in": Json(s.respawn_in),
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
        "minions_we_could_last_hit": Json(
          self.ripe[ripe_index(lanes[li], team)],
        ),
        "minions_they_could_last_hit": Json(
          self.ripe[ripe_index(lanes[li], foe)],
        ),
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
        "element": Json(if n.key == "dragon" { self.drake_now() } else { "" }),
        "reward": Json(
          match n.key {
            "baron" =>
              "+\{BARON_ATK_PCT}% attack and +\{BARON_STRUCT_PCT}% structure damage for \{BARON_TICKS} ticks, whole team"
            "herald" =>
              "+\{HERALD_STRUCT_PCT}% structure damage for \{HERALD_TICKS} ticks, whole team; leaves the map at tick \{HERALD_GONE_TICK}"
            _ => drake_reward(self.drake_now())
          },
        ),
        "visible": Json(seen[n.node]),
      }),
    )
  }

  let our_wards = []
  for w in self.wards_of(team) {
    our_wards.push(
      Json({
        "at": Json(node_name(w.node)),
        "kind": Json(if w.kind == WARD_CONTROL { "control" } else { "stealth" }),
        "expires_in": Json(w.ttl),
      }),
    )
  }
  // Their wards, but only the ones we can see — which is the point of the
  // sweep: you cannot clear what you have not found.
  let their_wards = []
  for w in self.wards_of(foe) {
    if seen[w.node] {
      their_wards.push(
        Json({
          "at": Json(node_name(w.node)),
          "kind": Json(
            if w.kind == WARD_CONTROL {
              "control"
            } else {
              "stealth"
            },
          ),
          "expires_in": Json(w.ttl),
        }),
      )
    }
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
  // Both jungles, with the timers. A camp a policy cannot see the clock on is
  // a camp it cannot plan a route around, and the enemy's timers are the whole
  // of a counter-jungle: you cross when theirs is up and yours is not.
  let camp_rows = []
  for camp in self.camps {
    camp_rows.push(
      Json({
        "at": Json(node_name(camp.node)),
        "side": Json(if camp.side == team { "ours" } else { "theirs" }),
        "up_now": Json(camp.up()),
        "comes_back_in": Json(camp.down_for),
        "visible": Json(seen[camp.node]),
      }),
    )
  }
  let element_rows = []
  for element in drake_kinds {
    element_rows.push(
      Json({
        "element": Json(element),
        "one_stack": Json(drake_reward(element)),
        "we_hold": Json(self.drakes_of(team, element)),
        "they_hold": Json(self.drakes_of(foe, element)),
      }),
    )
  }
  let brush_list = []
  for n in brush_nodes {
    brush_list.push(Json(node_names[n]))
  }

  Json({
    "game": Json(
      "5v5 MOBA: three lanes (top/mid/bot), a jungle each side, and a river with two epic monsters",
    ),
    "objective": Json(
      "Destroy the enemy nexus. A nexus can only be attacked once BOTH towers in at least one of its lanes are down; an inner tower cannot be attacked while its own lane's outer tower stands, and it comes back up \{INHIB_TICKS} ticks after it falls, closing the lane again.",
    ),
    "rules": Json(
      "One action per champion per tick. Moving is one node; a blink is two. Ranged champions can poke an adjacent node for half damage and take nothing back. Abilities have cooldowns; a stun removes the target's next turn outright. Recalling teleports home, heals, and restocks wards; out of combat a champion regenerates slowly on the spot. Gold buys items at base, experience buys levels, and both raise your stats.",
    ),
    "last_hit_rule": Json(
      "Gold from a minion goes to whoever lands the killing blow. Each lane brings one more minion low per tick for each side, up to \{CS_RIPE_CAP}; `Farm` in a lane takes every minion that is low RIGHT NOW for \{CS_GOLD} gold and \{CS_XP} xp each, and farming a lane with nothing low pays nothing. Anything left low at the end of a tick is finished by our own wave and paid to nobody — so a tick spent poking, trading or rotating costs exactly the gold that was sitting there, and `minions_let_die` counts what that has come to.",
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
    "their_wards_we_can_see": Json(their_wards),
    "team_reads": Json({
      "our_total_level": Json(self.team_level(team)),
      "their_total_level_if_seen": Json(self.team_level(foe)),
      "our_gold_earned": Json(self.team_gold(team)),
      "their_damage_is_physical_pct": Json(self.visible_physical_share(team)),
      "our_drakes": Json(self.drake_summary(team)),
      "their_drakes": Json(self.drake_summary(foe)),
      "drakes_we_need_for_soul": Json(self.drakes_to_soul(team)),
      "drakes_they_need_for_soul": Json(self.drakes_to_soul(foe)),
      "our_baron_ticks_left": Json(self.baron[team]),
      "their_baron_ticks_left": Json(self.baron[foe]),
      "our_herald_ticks_left": Json(self.herald[team]),
      "their_herald_ticks_left": Json(self.herald[foe]),
      "camps_of_ours_they_took": Json(self.camps_lost[team]),
      "camps_of_theirs_we_took": Json(self.camps_lost[foe]),
      "our_camps_up_now": Json(self.camps_up(team).length()),
      "their_camps_up_now": Json(self.camps_up(foe).length()),
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
    "jungle": Json(camp_rows),
    "ward_rule": Json(
      "Two kinds of ward. A STEALTH ward is one of the \{WARD_CHARGES} charges a champion carries, restocked free at base, and sees its node and neighbours for \{WARD_TTL} ticks. A CONTROL ward costs \{CONTROL_COST} gold from the same pocket that buys items, sees for \{CONTROL_TTL} ticks, and **destroys the enemy's wards**: every enemy ward on its node or a neighbour is gone the moment it lands, and an enemy stealth ward placed in that range afterwards is destroyed at the end of that tick. An enemy control ward placed later clears yours in turn, so a contested node belongs to whoever paid last. This is the only way in the game to take vision away rather than only add it — a stealth ward next to their ward adds your read without removing theirs.",
    ),
    "jungle_rule": Json(
      "The four jungle nodes each hold a camp, and each camp belongs to the side of the map it sits in. `farm` on a camp that is up takes it WHOLE — \{CAMP_GOLD} gold and \{CAMP_XP} xp at once, not a trickle — and it is then gone for \{CAMP_RESPAWN} ticks. Farming a camp that is down pays nothing. Standing in the jungle earns nothing at all by itself: unlike a lane there is no passive income there, so a champion in the jungle is either taking a camp or wasting the tick. Taking a camp on THEIR side is a counter-jungle: it pays you the same and denies them that camp for the same \{CAMP_RESPAWN} ticks — and their half of the jungle is brush next to their lanes, so it is the walk that costs you, not the camp.",
    ),
    "plating_rule": Json(
      "Every outer tower starts with \{PLATES} plates. Champion damage takes them off one at a time — \{PLATE_GOLD} gold each to every champion on the team that broke it — and pays whether or not the tower falls, so chipping a tower is worth a tick even when finishing it is not. Minion damage takes no plates. All plating falls off at tick \{PLATE_TICKS}, so this is an early-game source of gold and then it is gone.",
    ),
    "inhibitor_rule": Json(
      "An inner tower is the gate to its team's nexus, and it comes back \{INHIB_TICKS} ticks after it falls. While it is down that lane pushes itself toward the team that broke it, and their nexus can be attacked through it; when it comes back up the lane closes again. So breaking one starts a clock rather than winning a lane, and the question is what you do with the ticks.",
    ),
    "drake_rule": Json(
      "Every drake is one of four elements and gives its element's stack permanently to whoever kills it. The element of the drake in the pit now is under objectives; the first drake of the game has its own element and every drake after it has the rift's, so the soul at stake never changes. The first team to \{SOUL_STACKS} drakes of any elements takes the \{self.rift_element()} SOUL: \{soul_reward(self.rift_element())}. Nobody gets a second one, so the fourth drake is the one worth a teamfight and the enemy's fourth is worth denying.",
    ),
    "drake_elements": Json(element_rows),
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
