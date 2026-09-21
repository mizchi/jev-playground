///|
/// Replay logging. A game writes one JSON object per line: a `meta` header,
/// then a `frame` after every tick (tick 0 is the opening state), then a
/// `result`. The format is self-contained — the map, the rosters and the
/// objective rules are embedded — so a replay can be rendered by a player that
/// has never seen this package.
///
/// The 3v3 replay format is a subset of this one by design: `version` says
/// which game produced the file, so one player can read both.

///|
/// The header line: who played, both compositions, and the whole map.
pub fn Game::replay_meta(
  self : Game,
  a_policy : String,
  b_policy : String,
  comp_a : Array[String],
  comp_b : Array[String],
  max_ticks : Int,
) -> Json {
  let nodes = []
  for i in 0..<N_NODES {
    let adj = []
    for n in adjacency[i] {
      adj.push(Json(node_names[n]))
    }
    nodes.push(
      Json({
        "id": Json(i),
        "name": Json(node_names[i]),
        "lane": Json(node_lane[i]),
        "adj": Json(adj),
      }),
    )
  }
  let champ_kinds = []
  for c in self.champs {
    champ_kinds.push(
      Json({
        "id": Json(c.id),
        "name": Json(c.name),
        "team": Json(team_name(c.team)),
        "role": Json(c.role),
        "kind": Json(c.kind),
        "deals": Json(
          if c.dmg_type == DMG_PHYSICAL {
            "physical"
          } else {
            "magic"
          },
        ),
        "frontline": Json(c.frontline),
        "ranged": Json(c.ranged),
        "ability": Json(c.ability.name()),
        "ability_does": Json(c.ability.describe()),
        "cooldown": Json(c.cooldown),
        "base_hp": Json(c.base_hp),
        "base_attack": Json(c.base_attack),
        "armor": Json(c.base_armor),
        "magic_resist": Json(c.base_mr),
      }),
    )
  }
  let monsters = []
  for n in self.neutrals {
    monsters.push(
      Json({
        "monster": Json(n.key),
        "at": Json(node_name(n.node)),
        "max_hp": Json(n.max_hp),
        "first_spawn": Json(n.spawn_in),
        "respawn_ticks": Json(n.respawn_ticks),
      }),
    )
  }
  Json({
    "type": Json("meta"),
    "version": Json("moba5/1"),
    "teams": Json(5),
    "a_policy": Json(a_policy),
    "b_policy": Json(b_policy),
    "comp_a": Json(comp_a.map(x => Json::string(x))),
    "comp_b": Json(comp_b.map(x => Json::string(x))),
    "max_ticks": Json(max_ticks),
    "a_base": Json(node_names[A_BASE]),
    "b_base": Json(node_names[B_BASE]),
    "lanes": Json(lanes.map(x => Json::string(x))),
    "nodes": Json(nodes),
    "champions": Json(champ_kinds),
    "monsters": Json(monsters),
  })
}

///|
/// One tick's full state. `event` is this tick's log line with the `tN:`
/// prefix stripped, or empty.
pub fn Game::replay_frame(self : Game) -> Json {
  let champs = []
  for c in self.champs {
    champs.push(
      Json({
        "id": Json(c.id),
        "hp": Json(c.hp),
        "max_hp": Json(c.max_hp),
        "shield": Json(c.shield),
        "stunned": Json(c.stunned),
        "level": Json(c.level),
        "at": Json(node_name(c.node)),
        "node": Json(c.node),
        "gold": Json(c.gold),
        "items": Json(c.items.map(x => Json::string(x))),
        "cooldown_left": Json(c.cd),
        "alive": Json(c.alive()),
        "respawn": Json(c.respawn),
        "kills": Json(c.kills),
        "deaths": Json(c.deaths),
        "assists": Json(c.assists),
      }),
    )
  }
  let structures = []
  for s in self.structures {
    structures.push(
      Json({
        "node": Json(s.node),
        "at": Json(node_name(s.node)),
        "team": Json(team_name(s.team)),
        "lane": Json(s.lane),
        "kind": Json(s.kind_name()),
        "tier": Json(s.tier),
        "hp": Json(s.hp),
        "max_hp": Json(s.max_hp),
        "plates": Json(s.plates),
        "comes_back_in": Json(s.respawn_in),
      }),
    )
  }
  let monsters = []
  for n in self.neutrals {
    monsters.push(
      Json({
        "monster": Json(n.key),
        "node": Json(n.node),
        "up": Json(n.alive()),
        "hp": Json(n.hp),
        "spawns_in": Json(n.spawn_in),
      }),
    )
  }
  let wards = []
  for w in self.wards {
    wards.push(
      Json({
        "node": Json(w.node),
        "at": Json(node_name(w.node)),
        "team": Json(team_name(w.team)),
        "ttl": Json(w.ttl),
      }),
    )
  }
  let tag = "t\{self.tick}:"
  let mut event = ""
  if self.log.length() > 0 {
    let line = self.log[self.log.length() - 1]
    // A tick's log line is "tN: <events>"; keep only the events part. The line
    // is only pushed when something happened, so there is always a space after
    // the tag to skip.
    if line.has_prefix(tag) {
      event = "\{line[tag.length() + 1:]}"
    }
  }
  Json({
    "type": Json("frame"),
    "tick": Json(self.tick),
    "champs": Json(champs),
    "structures": Json(structures),
    "monsters": Json(monsters),
    "wards": Json(wards),
    "push": Json([Json(self.push[0]), Json(self.push[1]), Json(self.push[2])]),
    "drakes": Json({
      "A": Json(self.drake_summary(TEAM_A)),
      "B": Json(self.drake_summary(TEAM_B)),
      "next": Json(self.drake_now()),
      "soul": Json(
        match self.soul_team {
          1 => "A"
          2 => "B"
          _ => ""
        },
      ),
    }),
    "baron_ticks": Json({
      "A": Json(self.baron[TEAM_A]),
      "B": Json(self.baron[TEAM_B]),
    }),
    "herald_ticks": Json({
      "A": Json(self.herald[TEAM_A]),
      "B": Json(self.herald[TEAM_B]),
    }),
    "event": Json(event),
  })
}

///|
/// The closing line, so a player knows the outcome without replaying the rules.
pub fn Game::replay_result(self : Game, winner : Int) -> Json {
  Json({
    "type": Json("result"),
    "winner": Json(
      match winner {
        1 => "A"
        2 => "B"
        _ => "draw"
      },
    ),
    "ticks": Json(self.tick),
    "a_structure_hp": Json(self.structure_hp(TEAM_A)),
    "b_structure_hp": Json(self.structure_hp(TEAM_B)),
    "a_gold": Json(self.team_gold(TEAM_A)),
    "b_gold": Json(self.team_gold(TEAM_B)),
    "a_drakes": Json(self.drake_summary(TEAM_A)),
    "b_drakes": Json(self.drake_summary(TEAM_B)),
    "reason": Json(self.over_reason()),
  })
}
