///|
/// Replay logging. A game writes one JSON object per line: a `meta` header,
/// then a `frame` after every tick (tick 0 is the opening state), then a
/// `result`. The format is self-contained — the map is embedded — so a replay
/// can be rendered by the TUI player here and, later, by a Web player that has
/// never seen the game package.

///|
/// The header line: who played, the two compositions, and the whole map, so
/// the file stands on its own.
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
        "team": Json(if c.team == TEAM_A { "A" } else { "B" }),
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
        "max_hp": Json(c.max_hp),
        "armor": Json(c.armor),
        "magic_resist": Json(c.mr),
      }),
    )
  }
  Json({
    "type": Json("meta"),
    "a_policy": Json(a_policy),
    "b_policy": Json(b_policy),
    "comp_a": Json(comp_a.map(x => Json::string(x))),
    "comp_b": Json(comp_b.map(x => Json::string(x))),
    "max_ticks": Json(max_ticks),
    "a_base": Json(node_names[A_BASE]),
    "b_base": Json(node_names[B_BASE]),
    "nodes": Json(nodes),
    "champions": Json(champ_kinds),
  })
}

///|
/// One tick's full state. `event` is this tick's log line (kills, structures
/// falling) with the `tN:` prefix stripped, or empty.
pub fn Game::replay_frame(self : Game) -> Json {
  let champs = []
  for c in self.champs {
    champs.push(
      Json({
        "id": Json(c.id),
        "hp": Json(c.hp),
        "at": Json(node_name(c.node)),
        "node": Json(c.node),
        "gold": Json(c.gold),
        "alive": Json(c.alive()),
        "respawn": Json(c.respawn),
        "kills": Json(c.kills),
        "deaths": Json(c.deaths),
      }),
    )
  }
  let structures = []
  for s in self.structures {
    structures.push(
      Json({
        "node": Json(s.node),
        "at": Json(node_name(s.node)),
        "team": Json(if s.team == TEAM_A { "A" } else { "B" }),
        "kind": Json(if s.is_base { "base" } else { "tower" }),
        "hp": Json(s.hp),
        "max_hp": Json(s.max_hp),
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
    "reason": Json(self.over_reason()),
  })
}
