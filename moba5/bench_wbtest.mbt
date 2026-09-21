///|
/// The benchmark's own integrity.
///
/// A scored benchmark can be wrong in ways an accuracy number will not show: a
/// truth that is not one of the offered answers scores every policy zero, and a
/// truth that is the only offered answer scores every policy one. Both look
/// like a result. These tests are what stop either from being published.

///|
/// Every ask is well formed: the truth is answerable, the classes are ones the
/// report knows how to group, and nothing is blank.
test "every benchmark ask is answerable" {
  let suite = bench_suite()
  assert_true(suite.length() >= 8)
  let mut asks = 0
  for sc in suite {
    assert_true(sc.name.length() > 0)
    assert_true(sc.note.length() > 0)
    assert_true(sc.ask_count() > 0)
    // The state is a real observation, not an empty object.
    assert_true(sc.state.stringify().length() > 400)
    for ask in sc.asks {
      asks += 1
      assert_true(ask.key.length() > 0)
      assert_true(ask.instructions.length() > 20)
      assert_true(ask.why.length() > 0)
      assert_true(bench_classes.contains(ask.class_))
      assert_true(
        ask.tier == "rules" || ask.tier == "arith" || ask.tier == "score",
      )
      assert_true(ask.truth.length() > 0)
      if ask.form == "noul" {
        assert_true(ask.truth == "true" || ask.truth == "false")
        assert_eq(ask.options.length(), 0)
      } else if ask.form == "score" {
        // A rubric with the truth naming one of its levels.
        assert_true(ask.options.length() >= 2)
        let level : Int = @string.from_str(ask.truth) catch { _ => -1 }
        assert_true(level >= 0)
        assert_true(level < ask.options.length())
      } else {
        assert_eq(ask.form, "choice")
        // At least two options, or the question answers itself.
        assert_true(ask.options.length() >= 2)
        // Descriptions, if given at all, cover every option.
        if ask.descriptions.length() > 0 {
          assert_eq(ask.descriptions.length(), ask.options.length())
          for d in ask.descriptions {
            assert_true(d.length() > 0)
          }
        }
        // Every answer the truth accepts must be one of the options, or no
        // policy could ever be marked right.
        let mut accepted = 0
        for o in ask.options {
          if truth_accepts(ask.truth, o) {
            accepted += 1
          }
        }
        assert_true(accepted >= 1)
        // And a tie must not swallow the whole option list.
        assert_true(accepted < ask.options.length())
      }
      // The floor answers in the same vocabulary, so the two columns compare.
      assert_true(ask.floor.length() > 0)
      if ask.form == "noul" {
        assert_true(ask.floor == "true" || ask.floor == "false")
      } else if ask.form == "choice" {
        assert_true(ask.options.contains(ask.floor))
      }
    }
  }
  assert_true(asks >= 20)
}

///|
/// Question names are unique within a scenario — they are the keys on the wire,
/// so a duplicate would silently drop an answer and score it as a miss.
test "question names are unique within a scenario" {
  for sc in bench_suite() {
    let seen : Array[String] = []
    for ask in sc.asks {
      assert_false(seen.contains(ask.key))
      seen.push(ask.key)
    }
  }
}

///|
/// The suite covers every class the report prints, with enough questions each
/// that a class row means something.
///
/// A class of one question reports 1.00 or 0.00 and neither is a measurement —
/// the whole reason this test exists is that the first version of the suite had
/// four such classes and the report printed them next to a class of six as if
/// they were comparable.
test "every class has enough questions to say something" {
  let suite = bench_suite()
  for name in bench_classes {
    let mut n = 0
    for sc in suite {
      for ask in sc.asks {
        if ask.class_ == name {
          n += 1
        }
      }
    }
    assert_true(n >= 5)
  }
}

///|
/// The sweep can fill all four buckets, and the `fight` class is balanced
/// across them.
///
/// This is the test that the first version of the class failed: seven of its
/// eight questions were won by whoever had more bodies, so the head count
/// scored 0.88 and a model's score on the class was mostly a score on
/// arithmetic. Balance makes the head count worth exactly 0.50 — and so is
/// "always answer yes", which is the other trivial strategy.
test "the fight class does not reward counting bodies" {
  let census = fight_bucket_census()
  for b in fight_buckets {
    // Every bucket has to be reachable from the grid, or the balance below is
    // quietly achieved by leaving one out.
    assert_true(census.get(b).unwrap_or(0) >= FIGHT_PER_BUCKET)
  }
  let cases = balanced_fight_cases(FIGHT_PER_BUCKET)
  assert_eq(cases.length(), FIGHT_PER_BUCKET * fight_buckets.length())
  for b in fight_buckets {
    let mut n = 0
    for c in cases {
      if c.bucket() == b {
        n += 1
      }
    }
    assert_eq(n, FIGHT_PER_BUCKET)
  }
  // And now the same thing read off the suite, which is what actually ships.
  let mut asks = 0
  let mut floor_hits = 0
  let mut truth_yes = 0
  for sc in bench_suite() {
    for ask in sc.asks {
      if ask.class_ != "fight" {
        continue
      }
      asks += 1
      if truth_accepts(ask.truth, ask.floor) {
        floor_hits += 1
      }
      if ask.truth == "true" {
        truth_yes += 1
      }
    }
  }
  assert_eq(asks, FIGHT_PER_BUCKET * 4)
  // Counting bodies: exactly half. Always saying yes: exactly half.
  assert_eq(floor_hits * 2, asks)
  assert_eq(truth_yes * 2, asks)
}

///|
/// The derived fights are not all the same fight. Balance is worth nothing if
/// the eight questions are one matchup with the health numbers moved around,
/// which is what the single-pass version of the sweep produced.
test "the derived fights span more than one matchup" {
  let cases = balanced_fight_cases(FIGHT_PER_BUCKET)
  let pairs : Array[String] = []
  let shapes : Array[String] = []
  for c in cases {
    let pair = "\{c.comp_a}|\{c.comp_b}"
    if !pairs.contains(pair) {
      pairs.push(pair)
    }
    if !shapes.contains(c.describe()) {
      shapes.push(c.describe())
    }
  }
  // Every case is a distinct situation, over at least four compositions.
  assert_eq(shapes.length(), cases.length())
  assert_true(pairs.length() >= 4)
}

///|
/// No class can be swept by a single constant answer.
///
/// The `const` column in the report is what caught this: `retreat` had five of
/// six truths reading "walk away", so answering "walk away" to everything
/// scored 0.83 and the class could not tell a model from a rubber stamp. The
/// `floor` test below does not catch it, because the floor is a heuristic that
/// actually reads the state — a constant answer is a different failure.
test "no class can be swept by one constant answer" {
  for name in bench_classes {
    let truths : Array[String] = []
    for sc in bench_suite() {
      for ask in sc.asks {
        if ask.class_ == name {
          truths.push(ask.truth)
        }
      }
    }
    assert_true(truths.length() > 0)
    let seen : Array[String] = []
    let counts : Array[Int] = []
    for t in truths {
      let mut at = -1
      for i in 0..<seen.length() {
        if seen[i] == t {
          at = i
        }
      }
      if at < 0 {
        seen.push(t)
        counts.push(1)
      } else {
        counts[at] += 1
      }
    }
    let mut best = 0
    for c in counts {
      if c > best {
        best = c
      }
    }
    // At most four answers in five may share a truth. Above that, a rubber
    // stamp beats most policies and the class stops being a measurement.
    assert_true(best * 5 <= truths.length() * 4)
  }
}

///|
/// No class is answered correctly by the floor every single time. A class the
/// heuristic sweeps is a class where the questions do not discriminate, and it
/// would report a model's 1.00 as a success rather than as an easy row.
test "no class is a free pass for the heuristic" {
  let suite = bench_suite()
  for name in bench_classes {
    let mut n = 0
    let mut hits = 0
    for sc in suite {
      for ask in sc.asks {
        if ask.class_ == name {
          n += 1
          if truth_accepts(ask.truth, ask.floor) {
            hits += 1
          }
        }
      }
    }
    assert_true(n > 0)
    assert_true(hits < n)
  }
}

///|
/// The truths are not all the same answer. A suite where every fight is winnable
/// scores "always say yes" perfectly, which is the easiest way to publish a
/// number that means nothing.
test "the truths are not degenerate" {
  let suite = bench_suite()
  let mut yes = 0
  let mut no = 0
  for sc in suite {
    for ask in sc.asks {
      if ask.form == "noul" {
        if ask.truth == "true" {
          yes += 1
        } else {
          no += 1
        }
      }
    }
  }
  assert_true(yes > 0)
  assert_true(no > 0)
  // And the heuristic floor gets some right and some wrong, so there is room
  // both to beat it and to fall short of it.
  let mut hits = 0
  let mut total = 0
  for sc in suite {
    for ask in sc.asks {
      total += 1
      if truth_accepts(ask.truth, ask.floor) {
        hits += 1
      }
    }
  }
  assert_true(hits > 0)
  assert_true(hits < total)
}

///|
/// A tie really is accepted on every member, and nothing else.
test "a tied truth accepts each of its members" {
  assert_true(truth_accepts("take_baron", "take_baron"))
  assert_false(truth_accepts("take_baron", "push_the_nexus"))
  assert_true(truth_accepts("a|b|c", "a"))
  assert_true(truth_accepts("a|b|c", "b"))
  assert_true(truth_accepts("a|b|c", "c"))
  assert_false(truth_accepts("a|b|c", "d"))
  assert_false(truth_accepts("a|b|c", "a|b"))
  assert_false(truth_accepts("a|b|c", ""))
  assert_true(truth_accepts("blade", "blade"))
  assert_false(truth_accepts("blade", "blad"))
}

///|
/// The power rubric's buckets are ordered and cover the range, so a `score`
/// answer can land on the right one.
test "the power rubric is ordered and complete" {
  assert_eq(power_rubric.length(), 5)
  assert_eq(power_level(10), 0)
  assert_eq(power_level(69), 0)
  assert_eq(power_level(71), 1)
  assert_eq(power_level(100), 2)
  assert_eq(power_level(130), 3)
  assert_eq(power_level(400), 4)
  // Monotone: a stronger team never reads as a weaker one.
  let mut last = 0
  for r in [0, 50, 80, 95, 120, 200, 500] {
    let l = power_level(r)
    assert_true(l >= last)
    last = l
  }
}

///|
/// The position score agrees with itself: a position good for one team is bad
/// for the other, and a destroyed nexus dominates everything.
test "the position score is zero-sum about the obvious cases" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  // A mirrored start is level for both.
  assert_eq(g.position_score(TEAM_A), 0)
  assert_eq(g.position_score(TEAM_B), 0)
  // Strip one of B's towers and A is ahead by exactly as much as B is behind.
  for s in g.structures {
    if s.team == TEAM_B && s.tier == 1 && s.lane == "top" {
      s.hp = 0
    }
  }
  assert_true(g.position_score(TEAM_A) > 0)
  assert_eq(g.position_score(TEAM_A), -g.position_score(TEAM_B))
  // A won game outranks any amount of map.
  let h = g.copy()
  h.winner = TEAM_B
  assert_true(h.position_score(TEAM_B) > g.position_score(TEAM_A))
  assert_true(h.position_score(TEAM_A) < 0)
}

///|
/// Building the suite must not depend on, or leave behind, any shared state:
/// two calls produce the same truths.
test "the suite is reproducible" {
  let a = bench_suite()
  let b = bench_suite()
  assert_eq(a.length(), b.length())
  for i in 0..<a.length() {
    assert_eq(a[i].name, b[i].name)
    assert_eq(a[i].ask_count(), b[i].ask_count())
    for j in 0..<a[i].asks.length() {
      assert_eq(a[i].asks[j].key, b[i].asks[j].key)
      assert_eq(a[i].asks[j].truth, b[i].asks[j].truth)
      assert_eq(a[i].asks[j].floor, b[i].asks[j].floor)
      assert_eq(a[i].asks[j].why, b[i].asks[j].why)
    }
  }
}

///|
/// An observation tells a team about its own champions and never about enemies
/// it cannot see. This is the fog of war, and it is the one property the whole
/// experiment would be worthless without.
test "an observation never leaks an unseen enemy" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("dive"))
  // Put team B somewhere team A cannot possibly see.
  for c in g.champs {
    if c.team == TEAM_B {
      c.node = B_BASE
    }
  }
  for c in g.champs {
    if c.team == TEAM_A {
      c.node = A_BASE
    }
  }
  let mem = Memory::new()
  let text = g.observation(TEAM_A, mem).stringify()
  assert_eq(g.visible_enemies(TEAM_A).length(), 0)
  // Nothing at all under the visible-enemies key. Structure health is public
  // in this game, as it is on a real client's screen, so `b_base` does appear
  // in the structures list — what must never appear is an enemy champion's
  // position, and there is exactly one place that could come from.
  assert_true(text.contains("\"enemies_visible_now\":[]"))
  // Every enemy is remembered, and every sighting is "never".
  assert_true(text.contains("\"last_seen_at\":\"never\""))
  for c in g.champs {
    if c.team == TEAM_B {
      assert_true(text.contains(c.name))
      assert_eq(mem.last_seen_node[c.id], -1)
    }
  }
  // Once they are adjacent, they are visible and the memory records it.
  g.champs[5].node = 2 // a2_top, next to a_base
  assert_eq(g.visible_enemies(TEAM_A).length(), 1)
  mem.observe(g, TEAM_A)
  assert_eq(mem.last_seen_node[5], 2)
  assert_eq(mem.last_seen_tick[5], g.tick)
}
