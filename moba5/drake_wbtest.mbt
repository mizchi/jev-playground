///|
/// Elemental drakes and the soul.
///
/// Four elements, one rift, and a race to four. Most of what follows is
/// arithmetic — each element moves one lever and the tests state which — but
/// the last test in the file is the one that matters most and the one this
/// mechanic failed on its first try: a rule that nothing in a played game ever
/// reaches is a rule that only the tests believe in.

///|
/// The rotation: the first drake has its own element, and every drake after it
/// has the rift's. Advanced by kills, by either team.
test "the rotation gives the first drake its element and the rift the rest" {
  let g = Game::new()
  g.with_drakes(["cloud", "mountain"])
  assert_eq(g.drake_now(), "cloud")
  assert_eq(g.rift_element(), "mountain")

  // One drake down, whoever took it, and the rift's element is in the pit.
  g.drakes[drake_index(TEAM_B, "cloud")] = 1
  assert_eq(g.drakes_slain(), 1)
  assert_eq(g.drake_now(), "mountain")
  assert_eq(g.rift_element(), "mountain")

  // And it stays there, past the end of the rotation.
  g.drakes[drake_index(TEAM_A, "mountain")] = 3
  assert_eq(g.drakes_slain(), 4)
  assert_eq(g.drake_now(), "mountain")
}

///|
/// A rotation naming an element that does not exist is refused, because it
/// would leave every drake in the game worth nothing and the game would still
/// run.
test "an impossible rotation is refused rather than accepted" {
  let g = Game::new()
  let was = g.drake_now()
  g.with_drakes(["chemtech"])
  assert_eq(g.drake_now(), was)
  g.with_drakes([])
  assert_eq(g.drake_now(), was)
  // A real one is taken.
  g.with_drakes(["ocean", "infernal"])
  assert_eq(g.drake_now(), "ocean")
}

///|
/// The kill credits the element that was in the pit — read before the stack is
/// added, since the stack is what advances the rotation.
test "killing a drake banks the element that was in the pit" {
  let g = Game::with_comps(comp_by_name("classic"), comp_by_name("classic"))
  g.with_drakes(["mountain", "cloud"])
  let drake = g.neutrals[0]
  drake.spawn_in = 0
  drake.hp = 5
  g.champs[0].node = drake.node
  g.step(Map([(0, AttackNeutral)]))
  assert_eq(g.drakes_of(TEAM_A, "mountain"), 1)
  assert_eq(g.drakes_of(TEAM_A, "cloud"), 0)
  // The next one is the rift's, not another mountain.
  assert_eq(g.drake_now(), "cloud")
}

///|
/// Each element moves a different lever, and no element moves another's.
///
/// Stated as four directions rather than four numbers: the numbers are tuning
/// and will move, but an element that stops doing its own thing — or starts
/// doing somebody else's — is a broken rule.
test "the four elements move four different levers" {
  let base = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  base.level_all(6)
  // The hardest hitter on each side. A six percent change to a tank's basic
  // attack disappears into the integer division, so these directions are
  // asserted where the arithmetic has room to show them — which is a property
  // of the rounding rather than of the element, and `Game::ability_cd` says
  // the same thing about cloud.
  let attacker = biggest_hitter(base, TEAM_A)
  let victim = biggest_hitter(base, TEAM_B)

  // Infernal: damage dealt.
  let hot = base.copy()
  hot.drakes[drake_index(TEAM_A, "infernal")] = 2
  assert_true(
    hot.damage_to_champ(hot.champs[attacker.id], hot.champs[victim.id]) >
    base.damage_to_champ(attacker, victim),
  )
  // and not damage taken.
  assert_eq(
    hot.damage_to_champ(hot.champs[victim.id], hot.champs[attacker.id]),
    base.damage_to_champ(victim, attacker),
  )

  // Mountain: damage taken, by the team that holds it.
  let hard = base.copy()
  hard.drakes[drake_index(TEAM_B, "mountain")] = 2
  assert_true(
    hard.damage_to_champ(hard.champs[attacker.id], hard.champs[victim.id]) <
    base.damage_to_champ(attacker, victim),
  )
  // and it protects only its own team.
  assert_eq(
    hard.damage_to_champ(hard.champs[victim.id], hard.champs[attacker.id]),
    base.damage_to_champ(victim, attacker),
  )
  // Abilities are mitigated too, or a mage would ignore the element outright.
  let mage = 2
  assert_true(
    hard.ability_damage(hard.champs[mage], hard.champs[victim.id]) <
    base.ability_damage(base.champs[mage], base.champs[victim.id]),
  )
  // As is a tower's shot, which is read in four places and so is one function.
  assert_true(
    hard.tower_damage_to(hard.champs[victim.id]) < base.tower_damage_to(victim),
  )

  // Ocean: regeneration out of combat, and nothing in it.
  let wet = base.copy()
  wet.drakes[drake_index(TEAM_A, "ocean")] = 2
  assert_true(wet.regen_pct(TEAM_A) > base.regen_pct(TEAM_A))
  assert_eq(wet.regen_pct(TEAM_B), base.regen_pct(TEAM_B))
  assert_eq(wet.in_combat_regen_pct(TEAM_A), 0)

  // Cloud: ability uptime. It is worth nothing to the shortest cooldowns and a
  // tick to the longer ones, which the doc comment on `ability_cd` states and
  // this asserts rather than assumes.
  let fast = base.copy()
  fast.drakes[drake_index(TEAM_A, "cloud")] = 2
  let mut shortened = 0
  for c in fast.champs {
    if c.team == TEAM_A && c.ability != NoAbility {
      assert_true(fast.ability_cd(c) <= c.cooldown)
      if fast.ability_cd(c) < c.cooldown {
        shortened += 1
      }
    }
  }
  assert_true(shortened > 0)
  // Never to zero, whatever the haste.
  let silly = base.copy()
  silly.drakes[drake_index(TEAM_A, "cloud")] = 40
  for c in silly.champs {
    if c.team == TEAM_A {
      assert_true(silly.ability_cd(c) >= 1)
    }
  }
}

///|
/// The soul goes to the first team to four, whatever the elements, and only to
/// that team.
test "the soul goes to the first team to four and to nobody else" {
  let g = Game::with_comps(comp_by_name("classic"), comp_by_name("classic"))
  g.with_drakes(["infernal", "ocean"])
  assert_eq(g.soul_team, 0)
  assert_eq(g.soul_of(TEAM_A), "")
  assert_eq(g.drakes_to_soul(TEAM_A), SOUL_STACKS)

  // Three of mixed elements is not a soul.
  g.drakes[drake_index(TEAM_A, "infernal")] = 1
  g.drakes[drake_index(TEAM_A, "ocean")] = 2
  assert_eq(g.drakes_to_soul(TEAM_A), 1)
  assert_eq(g.soul_team, 0)

  // The fourth, taken in the game rather than assigned, decides it — and the
  // soul is the RIFT's element, not the element of the drake that finished it.
  let drake = g.neutrals[0]
  drake.spawn_in = 0
  drake.hp = 5
  g.champs[0].node = drake.node
  g.step(Map([(0, AttackNeutral)]))
  assert_eq(g.soul_team, TEAM_A)
  assert_eq(g.soul_of(TEAM_A), "ocean")
  assert_eq(g.soul_of(TEAM_B), "")
  assert_eq(g.drakes_to_soul(TEAM_B), 0) // nothing left to race for

  // And team B taking four of its own afterwards does not get a second one.
  g.drakes[drake_index(TEAM_B, "ocean")] = 9
  assert_eq(g.soul_team, TEAM_A)
  assert_eq(g.soul_of(TEAM_B), "")
}

///|
/// Each soul does its own thing, and two of them change kind rather than
/// degree — which is the reason the soul is worth racing for rather than being
/// a fifth stack.
test "each soul does something its stacks cannot" {
  let base = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  base.level_all(6)

  // Infernal soul: more damage than the stacks alone.
  let inf = base.copy()
  inf.with_drakes(["infernal", "infernal"])
  inf.drakes[drake_index(TEAM_A, "infernal")] = SOUL_STACKS
  let stacks_only = inf.buff_pct(TEAM_A)
  inf.soul_team = TEAM_A
  assert_true(inf.buff_pct(TEAM_A) > stacks_only)

  // Ocean soul: regeneration that keeps working with an enemy on the node,
  // which nothing else in the game does.
  let sea = base.copy()
  sea.with_drakes(["ocean", "ocean"])
  assert_eq(sea.in_combat_regen_pct(TEAM_A), 0)
  sea.soul_team = TEAM_A
  assert_true(sea.in_combat_regen_pct(TEAM_A) > 0)
  assert_eq(sea.in_combat_regen_pct(TEAM_B), 0)

  // Cloud soul: more haste than the stacks alone, on the same champion.
  let sky = base.copy()
  sky.with_drakes(["cloud", "cloud"])
  sky.drakes[drake_index(TEAM_A, "cloud")] = 1
  let long = {
    let mut pick = -1
    let mut longest = 0
    for c in sky.champs {
      if c.team == TEAM_A && c.ability != NoAbility && c.cooldown > longest {
        longest = c.cooldown
        pick = c.id
      }
    }
    pick
  }
  assert_true(long >= 0)
  let before = sky.ability_cd(sky.champs[long])
  sky.soul_team = TEAM_A
  assert_true(sky.ability_cd(sky.champs[long]) < before)

  // Mountain soul: a shield that comes back out of combat, and does not while
  // an enemy is standing there.
  let rock = base.copy()
  rock.with_drakes(["mountain", "mountain"])
  rock.soul_team = TEAM_A
  rock.place_all(node_id("mid_mid"))
  let alone = rock.champs[0]
  alone.node = node_id("a1_top")
  alone.shield = 0
  rock.step(Map([]))
  assert_eq(alone.shield, SOUL_MOUNTAIN_SHIELD)
  // Spent in a fight, and not topped up while the fight is on.
  let held = rock.champs[1]
  held.node = node_id("mid_mid")
  held.shield = 0
  rock.step(Map([]))
  assert_eq(held.shield, 0)
  // Team B holds nothing, so nobody on it is shielded.
  assert_eq(rock.champs[5].shield, 0)
}

///|
/// A copy carries the stacks, the rotation and the soul, and shares none of
/// them. Every truth in the benchmark is computed on a copy, so a rotation
/// aliased between two games would have the oracle answering about a different
/// game than the one it was asked about.
test "a copy carries the drakes and does not share them" {
  let g = Game::new()
  g.with_drakes(["cloud", "mountain"])
  g.drakes[drake_index(TEAM_B, "cloud")] = 2
  g.soul_team = TEAM_B
  let c = g.copy()
  assert_eq(c.drakes_of(TEAM_B, "cloud"), 2)
  assert_eq(c.rift_element(), "mountain")
  assert_eq(c.soul_team, TEAM_B)
  c.drakes[drake_index(TEAM_B, "cloud")] = 0
  c.soul_team = 0
  c.with_drakes(["ocean", "ocean"])
  assert_eq(g.drakes_of(TEAM_B, "cloud"), 2)
  assert_eq(g.soul_team, TEAM_B)
  assert_eq(g.rift_element(), "mountain")
}

///|
/// The description a policy reads names the element, what the stack does, and
/// whether this is the drake that ends the race.
test "the drake description names the element and the stake" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  g.with_drakes(["mountain", "cloud"])
  g.neutrals[0].spawn_in = 0
  let c = g.champs[1]
  c.node = g.neutrals[0].node
  let early = g.describe_action(c, AttackNeutral)
  assert_true(early.contains("mountain drake"))
  assert_true(early.contains("damage taken"))
  assert_true(early.contains("cloud soul"))
  assert_false(early.contains("FOURTH"))

  // Three down, and the same action is now the soul.
  g.drakes[drake_index(TEAM_A, "cloud")] = 3
  let now = g.describe_action(c, AttackNeutral)
  assert_true(now.contains("cloud drake")) // the rift's, not the opener's
  assert_true(now.contains("FOURTH"))
  assert_true(now.contains("SOUL"))

  // Once it is decided, the description stops promising it.
  g.soul_team = TEAM_B
  let after = g.describe_action(c, AttackNeutral)
  assert_true(after.contains("already gone"))
  assert_false(after.contains("FOURTH"))
}

///|
/// The baseline values the drake as a stack plus its share of the soul, so the
/// number rises as the race tightens and is symmetric about denial.
test "a drake is worth more the closer either team is to the soul" {
  let g = Game::new()
  let level = g.drake_value(TEAM_A)
  // Three of ours down: the next one is the soul.
  let ours = g.copy()
  ours.drakes[drake_index(TEAM_A, "ocean")] = 3
  assert_true(ours.drake_value(TEAM_A) > level)
  // Three of THEIRS down: the same drake, still worth more than a level race,
  // because denying is worth something even when taking is worth nothing.
  let theirs = g.copy()
  theirs.drakes[drake_index(TEAM_B, "ocean")] = 3
  assert_true(theirs.drake_value(TEAM_A) > level)
  // Taking is worth more than denying, though.
  assert_true(ours.drake_value(TEAM_A) > theirs.drake_value(TEAM_A))
  // And once the soul is gone it is a stack again, worth less than any of the
  // above and less than a free tower.
  let done = ours.copy()
  done.soul_team = TEAM_B
  assert_eq(done.drake_value(TEAM_A), DRAKE_STACK_VALUE)
  assert_true(done.drake_value(TEAM_A) < FREE_TOWER_VALUE)
  // A level race is worth more than a free tower, or the first drake of a game
  // is never contested — which is exactly what went wrong the first time.
  assert_true(level > FREE_TOWER_VALUE)
}

///|
/// The test this mechanic needed and did not have: drakes are taken in games
/// nobody set up, and a soul is reachable.
///
/// The first version of the rules passed every test above and was still dead.
/// The baseline held a wave in some lane almost every tick, an unconditional
/// branch put that free tower ahead of any monster, and Baron spawned a fifth
/// of the way into a game and then outbid the drake for the rest of it. One
/// drake fell in 128 ticks, no team ever held two, and the soul — four
/// elements, four souls, all of the arithmetic above — could not happen.
///
/// So this asserts about played games rather than about constructed states: it
/// is the only test here that would have failed.
test "drakes are contested and a soul is reachable in a played game" {
  let pairs = []
  for i in 0..<tournament_comps.length() {
    for j in 0..<tournament_comps.length() {
      if i != j {
        pairs.push((tournament_comps[i].name, tournament_comps[j].name))
      }
    }
  }
  let mut best_stacks = 0
  let mut souls = 0
  let mut games_with_a_drake = 0
  for pair in pairs {
    let (a, b) = pair
    let g = Game::with_comps(comp_by_name(a), comp_by_name(b))
    while g.winner == 0 && g.tick < 150 {
      let actions : Map[Int, Action] = Map([])
      for team in [TEAM_A, TEAM_B] {
        for e in smart_team_actions(g, team) {
          actions[e.0] = e.1
        }
      }
      g.step(actions)
    }
    let taken = g.drakes_slain()
    if taken > 0 {
      games_with_a_drake += 1
    }
    for team in [TEAM_A, TEAM_B] {
      if g.drake_total(team) > best_stacks {
        best_stacks = g.drake_total(team)
      }
    }
    if g.soul_team != 0 {
      souls += 1
    }
  }
  // Nearly every game sees the river fought over. Not all of them: a game the
  // `classic` control loses in thirty ticks never gets there, and six of these
  // seventy-two end before the second drake spawns. Three quarters is far
  // above that and far below the standing veto this test was written to catch,
  // which produced one drake per game whatever the matchup.
  assert_true(games_with_a_drake * 4 >= pairs.length() * 3)
  // Somebody gets past a single stack, so the rotation's second element is
  // reached by play and not only by assignment.
  assert_true(best_stacks >= 2)
  // And a soul is actually awarded. It happens in two of these seventy-two,
  // which is about the rate souls happen at in the game this is modelled on
  // and is the assertion to look at first if this test ever fails: check
  // `objective_value` against `FREE_TOWER_VALUE`, and the Baron timer, before
  // touching the number.
  assert_true(souls >= 1)
}

///|
/// The champion on `team` whose basic attack is largest. A test-local helper:
/// the drake percentages are small and integer division swallows a small
/// percentage of a small number, so the tests that assert a *direction* assert
/// it where there is room for the direction to show.
fn biggest_hitter(g : Game, team : Int) -> Champ {
  let mut best = g.champs[0]
  let mut most = -1
  for c in g.champs {
    if c.team == team && g.raw_attack(c) > most {
      most = g.raw_attack(c)
      best = c
    }
  }
  best
}

///|
/// The observation carries the drake state and the rule, because a policy
/// cannot decide about a race it has not been told it is in.
///
/// Asserted against the serialised text a player actually receives rather than
/// against the functions above: the game can be right about the soul and still
/// never mention it, and a rule nobody is told is a rule nobody can play.
test "the observation says what the drakes are and what the soul would be" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("dive"))
  g.with_drakes(["mountain", "cloud"])
  g.drakes[drake_index(TEAM_A, "mountain")] = 1
  g.drakes[drake_index(TEAM_B, "cloud")] = 2
  let mem = Memory::new()
  let text = g.observation(TEAM_A, mem).stringify()
  // What each side holds, and how far either is from the soul.
  assert_true(text.contains("1 mountain"))
  assert_true(text.contains("2 cloud"))
  assert_true(text.contains("drakes_we_need_for_soul"))
  assert_true(text.contains("drakes_they_need_for_soul"))
  // The element in the pit now, which is the rift's once one is down.
  assert_true(text.contains("cloud"))
  // What every element is worth, so the choice is not a guess.
  for element in drake_kinds {
    assert_true(text.contains(element))
  }
  // And the rule, including this rift's soul by name.
  assert_true(text.contains("SOUL"))
  assert_true(text.contains("\{SOUL_STACKS} drakes"))
}
