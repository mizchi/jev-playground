///|
/// Wire protocol between the referee (which owns the game) and the two player
/// processes (which own a Jev client each). See `cmd/moba_referee` and
/// `cmd/moba_player`.
///
/// The referee holds the authoritative `Game`. Each tick it sends each team a
/// turn message containing ONLY that team's observation and that team's legal
/// moves, so a player process is structurally unable to see the other side —
/// the other team's data is never on the wire. That is the whole point of
/// running the two sides as separate processes: fog of war enforced by the
/// network boundary rather than by discipline within one process.
///
/// Messages are line-delimited JSON (`read_until("\n")`).

///|
/// A short tactical note per action, moved here from `cmd/moba` so the
/// referee and the single-process CLI describe moves identically. In the
/// spirit of the gomoku hints: hand the model what the rules already compute.
pub fn Game::describe_action(
  self : Game,
  c : Champ,
  a : Action,
) -> String {
  match a {
    Move(n) => {
      let enemy_team = if c.team == TEAM_A { TEAM_B } else { TEAM_A }
      let there = self.champs_at(n, enemy_team)
      let seen = self.vision(c.team)
      let tower = match self.structure_at(n) {
        Some(s) => {
          let side = if s.team == c.team { "our" } else { "their" }
          let kind = if s.is_base { "base" } else { "tower" }
          "; \{side} \{kind} here (hp \{s.hp})"
        }
        None => ""
      }
      let danger = if !seen[n] {
        "; NOT VISIBLE - could be walking into anything"
      } else if there.length() > 0 {
        "; \{there.length()} enemy champion(s) standing there"
      } else {
        ""
      }
      let enemy_base = base_of(enemy_team)
      "move to \{node_name(n)} (\{node_lane[n]} lane, \{hops(n, enemy_base)} hops from the enemy base)\{tower}\{danger}"
    }
    AttackChamp(id) => {
      let e = self.champs[id]
      "attack \{e.name} (hp \{e.hp}) here"
    }
    AttackStructure =>
      match self.structure_at(c.node) {
        Some(s) => {
          let kind = if s.is_base { "BASE" } else { "tower" }
          "attack the enemy \{kind} here (hp \{s.hp})"
        }
        None => "attack the structure here"
      }
    Farm => "farm here for +\{camp_gold(c.node)} gold (safe, no progress on objectives)"
    Recall => "teleport home and heal (gives up this position)"
    Hold => "stay put"
  }
}

///|
/// The legal moves for a champion, keyed by the string the player will choose
/// and echo back. The referee keeps this so it can resolve a reply without a
/// string-to-action parser: the player can only name a key it was handed.
pub fn Game::legal_action_map(
  self : Game,
  c : Champ,
) -> Map[String, Action] {
  let out : Map[String, Action] = Map([])
  for a in self.legal_actions(c) {
    out[a.to_string()] = a
  }
  out
}

///|
/// The turn message for one team: its observation, and for each of its living
/// champions the legal moves with descriptions. This is everything a player
/// needs to build its Jev request, and nothing about the other team beyond
/// what fog of war already reveals in the observation.
pub fn Game::turn_message(
  self : Game,
  team : Int,
  mem : Memory,
) -> Json {
  let champs = []
  for c in self.champs {
    if c.team != team || !c.alive() {
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
        "hp": Json(c.hp),
        "at": Json(node_name(c.node)),
        "actions": Json(actions),
      }),
    )
  }
  // Every node name, so a player can ask "where are the unseen enemies?"
  // without depending on the game package.
  let nodes = []
  for i in 0..<N_NODES {
    nodes.push(Json(node_names[i]))
  }
  Json({
    "type": Json("turn"),
    "tick": Json(self.tick),
    "team": Json(if team == TEAM_A { "A" } else { "B" }),
    "observation": self.observation(team, mem),
    "champions": Json(champs),
    "all_nodes": Json(nodes),
  })
}

///|
/// Why the game ended, for the closing message. The last log line names the
/// structure that fell; fall back to the tick cap.
pub fn Game::over_reason(self : Game) -> String {
  if self.log.length() > 0 {
    self.log[self.log.length() - 1]
  } else {
    "tick cap"
  }
}
