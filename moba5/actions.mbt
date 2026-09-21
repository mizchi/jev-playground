///|
/// The action space, the legal-move generator, and the one-line description of
/// what each move is worth.
///
/// The design rule from docs/02 is unchanged and is the reason this is worth
/// measuring at all: **the choices a policy is offered ARE the legal moves**,
/// so an illegal action is unrepresentable rather than merely discouraged. The
/// 5v5 action space is five times richer than the 3v3 one, which is exactly
/// what makes the claim worth re-checking at this size.

///|
/// What a champion can be told to do in a tick.
pub(all) enum Action {
  /// Walk to an adjacent node.
  Move(Int)
  /// Blink two nodes at once. Only for a champion with the ability, off
  /// cooldown; this is both the escape and the surprise engage.
  Blink(Int)
  /// Hit an enemy champion standing here, by champion id.
  AttackChamp(Int)
  /// Ranged only: hit an enemy in a NEIGHBOURING node for half damage and take
  /// nothing back.
  Poke(Int)
  /// Use this champion's signature ability. The second field is the target
  /// champion id, or -1 when the ability picks its own target.
  Cast(Ability, Int)
  /// Hit the enemy tower or nexus standing here.
  AttackStructure
  /// Hit the epic monster in this river node.
  AttackNeutral
  /// Take gold and experience from the minions or camp here.
  Farm
  /// Place a ward on a node, buying vision of it and its neighbours.
  PlaceWard(Int)
  /// Buy an item. Only at base, only with the gold for it.
  Buy(String)
  /// Teleport home and start healing. Costs the tick.
  Recall
  /// Do nothing.
  Hold
} derive(Eq)

///|
/// The stable key a policy names and echoes back. It is deliberately
/// self-describing: docs/02's lesson was that anything the rules already know
/// belongs in the choice, and half of that fits in the key itself.
pub fn Action::to_string(self : Action) -> String {
  match self {
    Move(n) => "move_\{node_name(n)}"
    Blink(n) => "blink_\{node_name(n)}"
    AttackChamp(id) => "attack_champ_\{id}"
    Poke(id) => "poke_champ_\{id}"
    Cast(ab, id) =>
      if id < 0 {
        "cast_\{ab.name()}"
      } else {
        "cast_\{ab.name()}_on_\{id}"
      }
    AttackStructure => "attack_structure"
    AttackNeutral => "attack_monster"
    Farm => "farm"
    PlaceWard(n) => "ward_\{node_name(n)}"
    Buy(key) => "buy_\{key}"
    Recall => "recall"
    Hold => "hold"
  }
}

///|
/// The family an action belongs to. A report that counts these says whether a
/// policy is actually using the mechanics the 5v5 game added, or is playing the
/// 3v3 game inside it — which is a measurement in its own right.
pub fn Action::kind_name(self : Action) -> String {
  match self {
    Move(_) => "move"
    Blink(_) => "blink"
    AttackChamp(_) => "attack"
    Poke(_) => "poke"
    Cast(_, _) => "ability"
    AttackStructure => "structure"
    AttackNeutral => "objective"
    Farm => "farm"
    PlaceWard(_) => "ward"
    Buy(_) => "buy"
    Recall => "recall"
    Hold => "hold"
  }
}

///|
/// The families, in the order a report prints them.
pub let action_kinds : Array[String] = [
  "move", "blink", "attack", "poke", "ability", "structure", "objective", "farm",
  "ward", "buy", "recall", "hold",
]

///|
/// Which nodes are worth a ward from here: this node and its neighbours, kept
/// to the jungle and the river. Warding the tower you are standing on buys
/// nothing, and leaving that in the list would only pad the choice set.
pub fn ward_spots(from : Int) -> Array[Int] {
  let out : Array[Int] = []
  fn consider(n : Int) {
    let lane = node_lane[n]
    if (lane == "jungle" || lane == "river") && !out.contains(n) {
      out.push(n)
    }
  }

  consider(from)
  for n in adjacency[from] {
    consider(n)
  }
  out
}

///|
/// Everything a champion may do this tick. A policy picks from exactly this
/// list.
pub fn Game::legal_actions(self : Game, c : Champ) -> Array[Action] {
  // A dead or stunned champion has no turn to take. Returning an empty list
  // rather than `[Hold]` keeps it out of the request entirely, so crowd control
  // shows up as a question that is never asked.
  if !c.can_act() {
    return []
  }
  let out : Array[Action] = []
  let foe = enemy_of(c.team)
  let seen = self.vision(c.team)
  for n in adjacency[c.node] {
    out.push(Move(n))
  }
  if c.ability == Blink && c.cd == 0 {
    for n in blink_targets(c.node) {
      out.push(Blink(n))
    }
  }
  let here = self.champs_at(c.node, foe)
  for e in here {
    if seen[e.node] {
      out.push(AttackChamp(e.id))
    }
  }
  if c.ranged {
    for e in self.champs {
      if e.team == foe &&
        e.alive() &&
        seen[e.node] &&
        adjacency[c.node].contains(e.node) {
        out.push(Poke(e.id))
      }
    }
  }
  if c.ability_ready() {
    match c.ability {
      Nuke(_) | Execute(_) | Stun(_) =>
        for e in here {
          if seen[e.node] {
            out.push(Cast(c.ability, e.id))
          }
        }
      Aoe(_) => if !here.is_empty() { out.push(Cast(c.ability, -1)) }
      Heal(_) | Shield(_) =>
        if self.neediest_ally(c) is Some(_) {
          out.push(Cast(c.ability, -1))
        }
      NoAbility | Blink => ()
    }
  }
  match self.structure_at(c.node) {
    Some(s) =>
      if s.team != c.team && self.structure_attackable(s) {
        out.push(AttackStructure)
      }
    None => ()
  }
  if self.neutral_at(c.node) is Some(_) {
    out.push(AttackNeutral)
  }
  if camp_gold(c.node) > 0 {
    out.push(Farm)
  }
  if c.wards > 0 {
    for n in ward_spots(c.node) {
      out.push(PlaceWard(n))
    }
  }
  if c.node == base_of(c.team) {
    for it in items {
      if c.can_buy(it.key) {
        out.push(Buy(it.key))
      }
    }
  }
  if c.node != base_of(c.team) {
    out.push(Recall)
  }
  out.push(Hold)
  out
}

///|
/// A short tactical note per action. In the spirit of the gomoku hints and
/// docs/02's fourth lesson: hand the model what the rules already compute, so
/// the judgment left over is the one actually worth measuring.
pub fn Game::describe_action(self : Game, c : Champ, a : Action) -> String {
  let foe = enemy_of(c.team)
  let enemy_base = base_of(foe)
  fn node_note(n : Int) -> String {
    let seen = self.vision(c.team)
    let there = self.champs_at(n, foe)
    let tower = match self.structure_at(n) {
      Some(s) => {
        let side = if s.team == c.team { "our" } else { "their" }
        "; \{side} \{s.kind_name()} here (hp \{s.hp})"
      }
      None => ""
    }
    let monster = match self.neutral_at(n) {
      Some(m) => "; \{m.key} is up here (hp \{m.hp})"
      None => ""
    }
    let danger = if !seen[n] {
      "; NOT VISIBLE - could be walking into anything"
    } else if there.length() > 0 {
      "; \{there.length()} enemy champion(s) standing there"
    } else {
      ""
    }
    "(\{node_lane[n]}, \{hops(n, enemy_base)} hops from their nexus)\{tower}\{monster}\{danger}"
  }

  match a {
    Move(n) => "move to \{node_name(n)} \{node_note(n)}"
    Blink(n) => "BLINK two nodes to \{node_name(n)} \{node_note(n)}"
    AttackChamp(id) => {
      let e = self.champs[id]
      let real = self.guarded_target(e, c.node)
      let d = self.damage_to_champ(c, real)
      if real.id == e.id {
        "attack \{e.name} (\{e.kind}, hp \{e.hp}) here for about \{d}"
      } else {
        "attack \{e.name}, but their frontline \{real.name} (hp \{real.hp}) will soak it — about \{d} into the wall instead"
      }
    }
    Poke(id) => {
      let e = self.champs[id]
      let real = self.guarded_target(e, e.node)
      let d = self.damage_to_champ(c, real) / 2
      "poke \{e.name} (hp \{e.hp}) in \{node_name(e.node)} from here for about \{if d < 1 { 1 } else { d }} and take nothing back"
    }
    Cast(ab, id) => {
      let head = "cast \{ab.name()}: \{ab.describe()}"
      if id < 0 {
        match ab {
          Heal(_) | Shield(_) =>
            match self.neediest_ally(c) {
              Some(t) =>
                "\{head} — \{t.name} is lowest (hp \{t.hp}/\{t.max_hp}), about \{ability_support(c)}"
              None => head
            }
          _ => {
            let n = self.champs_at(c.node, foe).length()
            "\{head} — \{n} enemy champion(s) here"
          }
        }
      } else {
        let e = self.champs[id]
        "\{head} — on \{e.name} (\{e.kind}, hp \{e.hp}), about \{self.ability_damage(c, e)}"
      }
    }
    AttackStructure =>
      match self.structure_at(c.node) {
        Some(s) => {
          let head = "attack the enemy \{s.kind_name()} here (hp \{s.hp}) for about \{self.damage_to_structure(c)}"
          if self.tower_shoots(s, c) {
            "\{head}; WE HAVE NO WAVE HERE, so it will shoot back for \{self.tower_damage_to(c)} a tick — about \{self.ticks_under_tower(c)} tick(s) before it kills this champion"
          } else {
            "\{head}; our minion wave is holding this lane, so it cannot shoot us"
          }
        }
        None => "attack the structure here"
      }
    AttackNeutral =>
      match self.neutral_at(c.node) {
        Some(m) =>
          if m.key == "baron" {
            "attack the baron here (hp \{m.hp}/\{m.max_hp}) for about \{self.raw_attack(c)}; killing it gives +\{BARON_ATK_PCT}% attack and +\{BARON_STRUCT_PCT}% siege for \{BARON_TICKS} ticks, team-wide"
          } else {
            let element = self.drake_now()
            let need = self.drakes_to_soul(c.team)
            // What the stack is worth, and then whether it is the one that
            // ends the race — a policy that is told only the stack is being
            // asked to decide about the drake without being told what the
            // drake is for.
            let soul = if self.soul_team != 0 {
              "the soul is already gone, so this is the stack and nothing more"
            } else if need <= 1 {
              "THIS IS OUR FOURTH: taking it gives us the \{self.rift_element()} SOUL — \{soul_reward(self.rift_element())}"
            } else if self.drakes_to_soul(enemy_of(c.team)) <= 1 {
              "they are one drake from the \{self.rift_element()} soul, so taking this one denies it for now"
            } else {
              "\{need} more of any element after this would give us the \{self.rift_element()} soul"
            }
            "attack the \{element} drake here (hp \{m.hp}/\{m.max_hp}) for about \{self.raw_attack(c)}; killing it gives \{drake_reward(element)}, and \{soul}"
          }
        None => "attack the monster here"
      }
    Farm => {
      let lane = node_lane[c.node]
      if lane_index(lane) >= 0 {
        let ripe = self.ripe_here(c.node, c.team)
        let pay = if ripe == 0 {
          "nothing is low enough to last-hit here right now, so this pays 0 gold"
        } else {
          "last-hit \{ripe} minion(s) for +\{ripe * CS_GOLD} gold and +\{ripe * CS_XP} xp"
        }
        "\{pay}, and SHOVE the \{lane} lane wave one step toward them\{if self.has_wave(c.team, lane) { " (we already hold this lane)" } else { " — this is how a tower here becomes attackable without it shooting back" }}"
      } else {
        "farm here for +\{camp_gold(c.node)} gold and +\{camp_xp(c.node)} xp (a jungle camp: safe, but no lane pressure)"
      }
    }
    PlaceWard(n) =>
      "ward \{node_name(n)} — vision of it and its neighbours for \{WARD_TTL} ticks (\{c.wards} ward(s) left)"
    Buy(key) =>
      match item_of(key) {
        Some(it) => {
          let price = c.price_of(key)
          let full = item_total_cost(key)
          let head = if price < full {
            // The discount is the point of having bought the component, so it
            // is stated rather than left for the reader to work out.
            "buy \{it.key} for \{price} (\{full} from nothing; the component in hand covers the rest)"
          } else {
            "buy \{it.key} for \{price}"
          }
          let slots = if it.builds_from.is_empty() {
            ""
          } else {
            "; consumes \{it.builds_from.join(" + ")}"
          }
          "\{head}\{slots}: \{it.note}"
        }
        None => "buy \{key}"
      }
    Recall => "teleport home and heal (gives up this position)"
    Hold => "stay put"
  }
}

///|
/// The legal moves for a champion keyed by the string the policy will choose
/// and echo back. A referee keeps this so it can resolve a reply without a
/// string-to-action parser: the policy can only name a key it was handed.
pub fn Game::legal_action_map(self : Game, c : Champ) -> Map[String, Action] {
  let out : Map[String, Action] = Map([])
  for a in self.legal_actions(c) {
    out[a.to_string()] = a
  }
  out
}
