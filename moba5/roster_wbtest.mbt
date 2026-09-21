///|
/// The roster's own claims.
///
/// A roster is easy to get wrong in a way no game ever shows: two archetypes
/// that read as different choices but are the same numbers, a role with only
/// one option so the draft never happens there, or a growth rate that claims a
/// timing window and does not produce one. These tests are what make the
/// claims checkable.

///|
/// Every role a team drafts has at least two archetypes to choose between.
///
/// `bot` had exactly one for the whole of docs/56, so a bot pick was not a
/// decision and no report could say a policy drafted it well or badly.
test "every role can be drafted two ways" {
  for role in roles {
    let options : Array[String] = []
    for key, k in kinds {
      // `any` fits everywhere and would paper over an empty role.
      if k.slot == role {
        options.push(key)
      }
    }
    assert_true(options.length() >= 2)
  }
}

///|
/// Two archetypes in the same role are actually different.
///
/// Distinct keys with identical numbers would make a role read as a choice and
/// score as a coin flip, so the test asks for a difference in something a
/// policy could reason from rather than in a decimal.
test "archetypes in the same role differ in more than a decimal" {
  for role in roles {
    let picks : Array[Kind] = []
    for _, k in kinds {
      if k.slot == role {
        picks.push(k)
      }
    }
    for i in 0..<picks.length() {
      for j in (i + 1)..<picks.length() {
        let a = picks[i]
        let b = picks[j]
        // At least one of: a different ability, a different damage type, a
        // different range, a different role in the line, or a growth rate far
        // enough apart to move the level curve.
        let differs = a.ability != b.ability ||
          a.dmg_type != b.dmg_type ||
          a.ranged != b.ranged ||
          a.frontline != b.frontline ||
          (a.growth - b.growth) * (a.growth - b.growth) >= 16
        assert_true(differs)
      }
    }
  }
}

///|
/// The growth rates buy a timing window rather than a ranking.
///
/// This is the claim `bully` exists to make: it wins the level-1 trade against
/// `marksman` and loses the level-6 one, on the rules' own arithmetic. If the
/// ordering were the same at both ends, "when do we fight" would have no answer
/// beyond "whenever", and the `power` class would be reading a constant.
test "the bot laners swap places between level one and level six" {
  let g = Game::with_comps(
    ["classic", "classic", "classic", "bully", "classic"],
    ["classic", "classic", "classic", "marksman", "classic"],
  )
  let bully = g.champs[3]
  let marksman = g.champs[8]
  assert_eq(bully.kind, "bully")
  assert_eq(marksman.kind, "marksman")
  // Level 1: the bully hits harder.
  assert_eq(bully.level, 1)
  assert_eq(marksman.level, 1)
  assert_true(bully.attack() > marksman.attack())
  // Level 6: the marksman does.
  for c in [bully, marksman] {
    c.xp = (MAX_LEVEL - 1) * LEVEL_XP
    c.level = MAX_LEVEL
    c.refresh_hp()
  }
  assert_true(marksman.attack() > bully.attack())
}

///|
/// Growth is the archetype's, not the game's.
///
/// `Champ::attack` used one rate for everybody, so this checks the field is
/// actually threaded through construction and `copy` rather than defaulted —
/// a copy that lost it would make every simulated fight disagree with the live
/// one, quietly, since the oracle plays fights out on copies.
test "a copy keeps its growth rate" {
  let g = Game::with_comps(comp_by_name("late"), comp_by_name("early"))
  let c = g.copy()
  assert_eq(c.champs.length(), g.champs.length())
  for i in 0..<g.champs.length() {
    assert_eq(c.champs[i].growth, g.champs[i].growth)
    assert_eq(c.champs[i].growth, kind_of(g.champs[i].kind).growth)
    // And the derived number follows it at a level where it matters.
    c.champs[i].level = MAX_LEVEL
    g.champs[i].level = MAX_LEVEL
    assert_eq(c.champs[i].attack(), g.champs[i].attack())
  }
}

///|
/// The two new compositions sit on opposite sides of the level curve.
///
/// They exist to give the draft a timing axis, so the test asks that they
/// actually have one: more attack at level 1 for `early`, more growth for
/// `late`. Which of them WINS is not asserted — that is what the arena
/// measures, and asserting it here would be tuning the roster to a
/// pre-decided answer.
test "the early and late comps differ in timing, not just in name" {
  let mut early : Comp? = None
  let mut late : Comp? = None
  for c in tournament_comps {
    if c.name == "early" {
      early = Some(c)
    }
    if c.name == "late" {
      late = Some(c)
    }
  }
  let e = early.unwrap()
  let l = late.unwrap()
  assert_true(e.base_attack() > l.base_attack())
  assert_true(l.mean_growth() > e.mean_growth())
}
