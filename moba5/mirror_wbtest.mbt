///|
/// A mirror match stays a mirror.
///
/// The cheapest test there is for an engine that is supposed to be fair, and
/// the one that finds what nothing else does. Five identical champions against
/// five identical champions, both sides on the same policy, and the state must
/// be its own mirror image every tick — if it is not, something in the rules
/// or in the resolution order favours a side, and no amount of watching games
/// would show it.
///
/// It found two bugs on the tick it was written, both in the same place and
/// both invisible from a game's outcome. `game.mbt`'s death loop has the
/// details; the short version is that a kill awards experience, experience can
/// raise a level, and a level raises health and lengthens a respawn — so a
/// champion that died at the same instant as its killer could be lifted back
/// above zero by its own kill, or come back a tick later than the champion it
/// traded with, depending only on which of them acted first. **Team A won
/// every exactly even fight.** That biases the `fight`, `focus` and `retreat`
/// truths, which is most of the benchmark.

///|
/// Every mirror matchup, for a whole game.
test "a mirror match is mirrored on every tick" {
  for comp in tournament_comps {
    let picks = comp_by_name(comp.name)
    let g = Game::with_comps(picks, picks)
    while g.winner == 0 && g.tick < 150 {
      let actions : Map[Int, Action] = Map([])
      for team in [TEAM_A, TEAM_B] {
        for e in smart_team_actions(g, team) {
          actions[e.0] = e.1
        }
      }
      g.step(actions)
      assert_eq(mirror_complaint(g), "")
    }
  }
}

///|
/// The same property under the fight resolver, which is where the benchmark's
/// truths come from.
///
/// An even fight must be a draw. `simulate_fight` used to call it for team A
/// and every `fight`-class truth derived from an even matchup inherited that.
test "an even fight is a draw whichever node it happens on" {
  for node in [RIV_TOP, RIV_BOT, node_id("mid_mid")] {
    for comp in tournament_comps {
      let picks = comp_by_name(comp.name)
      let g = Game::with_comps(picks, picks)
      g.level_all(4)
      g.place_all(node)
      let r = g.simulate_fight(node, 24)
      // Nobody wins, and the trade is level in both directions.
      assert_eq(r.winner, 0)
      assert_eq(r.a_deaths, r.b_deaths)
      assert_eq(r.a_standing, r.b_standing)
      assert_eq(r.a_hp, r.b_hp)
      assert_true(r.trade_not_lost(TEAM_A))
      assert_true(r.trade_not_lost(TEAM_B))
      // And neither side is told it wins one.
      assert_false(g.fight_is_won(node, TEAM_A, 24))
      assert_false(g.fight_is_won(node, TEAM_B, 24))
    }
  }
}

///|
/// Two champions that kill each other both die, and neither is revived by the
/// experience it earned doing it.
///
/// Stated on its own as well as through the mirror, because this is the rule
/// rather than a symmetry: a champion whose health reached zero is dead, and
/// what happens afterwards — its kill, its experience, its level — cannot undo
/// that.
test "a trade that kills both kills both" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  g.level_all(3)
  let a = g.champs[3]
  let b = g.champs[8]
  for c in g.champs {
    c.node = base_of(c.team)
  }
  a.node = RIV_TOP
  b.node = RIV_TOP
  // One blow from death, each with enough experience banked that the kill
  // will level it — which is the condition that used to bring one of them
  // back.
  let blow = g.damage_to_champ(a, b)
  a.hp = blow
  b.hp = blow
  a.xp = 3 * LEVEL_XP - KILL_XP
  b.xp = 3 * LEVEL_XP - KILL_XP
  g.step(Map([(a.id, AttackChamp(b.id)), (b.id, AttackChamp(a.id))]))
  assert_false(a.alive())
  assert_false(b.alive())
  assert_eq(a.hp, 0)
  assert_eq(b.hp, 0)
  assert_eq(a.deaths, 1)
  assert_eq(b.deaths, 1)
  // Each is credited with the kill it made, and the two come back together.
  assert_eq(a.kills, 1)
  assert_eq(b.kills, 1)
  assert_eq(a.respawn, b.respawn)
  assert_true(a.respawn > 0)
}

///|
/// Everything about `g` that is not its own mirror image, or "" when it is.
///
/// `mirror_node` swaps the A and B halves of the map and leaves the two river
/// nodes alone, so champion `i` of A belongs at the mirror of champion `i` of
/// B, a lane's push belongs at zero, and the two teams' drakes and buffs
/// belong equal. Returning the complaint rather than a boolean is what makes
/// a failure readable: the assertion prints which field went first.
fn mirror_complaint(g : Game) -> String {
  let bad = []
  for i in 0..<5 {
    let x = g.champs[i]
    let y = g.champs[5 + i]
    if x.node != mirror_node(y.node) {
      bad.push("\{x.name} at \{node_name(x.node)} against \{node_name(y.node)}")
    }
    if x.hp != y.hp {
      bad.push("\{x.name} hp \{x.hp} against \{y.hp}")
    }
    if x.gold != y.gold {
      bad.push("\{x.name} gold \{x.gold} against \{y.gold}")
    }
    if x.xp != y.xp || x.level != y.level {
      bad.push("\{x.name} xp \{x.xp} against \{y.xp}")
    }
    if x.deaths != y.deaths || x.respawn != y.respawn {
      bad.push("\{x.name} respawn \{x.respawn} against \{y.respawn}")
    }
    if x.kills != y.kills || x.assists != y.assists {
      bad.push("\{x.name} kills \{x.kills} against \{y.kills}")
    }
    if x.items.join(",") != y.items.join(",") {
      bad.push(
        "\{x.name} items \{x.items.join("+")} against \{y.items.join("+")}",
      )
    }
    if x.cs != y.cs || x.cs_lost != y.cs_lost {
      bad.push("\{x.name} cs \{x.cs}/\{x.cs_lost} against \{y.cs}/\{y.cs_lost}")
    }
    if x.camps != y.camps {
      bad.push("\{x.name} camps \{x.camps} against \{y.camps}")
    }
    if x.cd != y.cd || x.stunned != y.stunned || x.shield != y.shield {
      bad.push("\{x.name} cooldown \{x.cd} against \{y.cd}")
    }
    if x.wards != y.wards {
      bad.push("\{x.name} wards \{x.wards} against \{y.wards}")
    }
  }
  for li in 0..<3 {
    if g.push[li] != 0 {
      bad.push("\{lanes[li]} push \{g.push[li]}")
    }
    if g.ripe[ripe_index(lanes[li], TEAM_A)] !=
      g.ripe[ripe_index(lanes[li], TEAM_B)] {
      bad.push("\{lanes[li]} ripe")
    }
  }
  for s in g.structures {
    if s.team != TEAM_A {
      continue
    }
    for t in g.structures {
      if t.team == TEAM_B && t.lane == s.lane && t.tier == s.tier {
        if s.hp != t.hp {
          bad.push("\{s.lane} tier \{s.tier} hp \{s.hp} against \{t.hp}")
        }
        if s.plates != t.plates || s.respawn_in != t.respawn_in {
          bad.push(
            "\{s.lane} tier \{s.tier} plates \{s.plates} against \{t.plates}",
          )
        }
      }
    }
  }
  // A camp mirrors to the other side's camp, so their timers move together in
  // a mirror match — and so do the counters that price a counter-jungle.
  for camp in g.camps {
    match g.camp_at(mirror_node(camp.node)) {
      Some(other) =>
        if camp.down_for != other.down_for {
          bad.push(
            "camp \{node_name(camp.node)} down \{camp.down_for} against \{other.down_for}",
          )
        }
      None => bad.push("camp \{node_name(camp.node)} has no mirror")
    }
  }
  if g.camps_lost[TEAM_A] != g.camps_lost[TEAM_B] {
    bad.push(
      "camps lost \{g.camps_lost[TEAM_A]} against \{g.camps_lost[TEAM_B]}",
    )
  }
  if g.drake_total(TEAM_A) != g.drake_total(TEAM_B) {
    bad.push("drakes \{g.drake_total(TEAM_A)} against \{g.drake_total(TEAM_B)}")
  }
  if g.soul_team != 0 {
    bad.push("soul to \{team_name(g.soul_team)}")
  }
  if g.baron[TEAM_A] != g.baron[TEAM_B] || g.herald[TEAM_A] != g.herald[TEAM_B] {
    bad.push("buffs")
  }
  // The wards, by kind and by mirrored node: a control ward that cleared on
  // one side and not the other is exactly the sort of thing this test is for.
  for w in g.wards_of(TEAM_A) {
    let mut matched = false
    for v in g.wards_of(TEAM_B) {
      if v.node == mirror_node(w.node) && v.kind == w.kind && v.ttl == w.ttl {
        matched = true
      }
    }
    if !matched {
      bad.push(
        "ward at \{node_name(w.node)} kind \{w.kind} ttl \{w.ttl} has no mirror",
      )
    }
  }
  if g.wards_of(TEAM_A).length() != g.wards_of(TEAM_B).length() {
    bad.push("wards on the map")
  }
  bad.join("; ")
}
