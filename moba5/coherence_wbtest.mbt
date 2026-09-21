///|
/// The coherence analysis's own integrity.
///
/// The analysis makes a claim about two of the benchmark's classes at once, so
/// the thing most likely to break it is the two sides drifting apart: if these
/// rows priced the retreat over a different horizon, or played the fight out
/// for a different number of ticks, "the truths disagree" would be measuring
/// the copies rather than the questions. The first test below is the one that
/// matters, and it is why `Game::retreat_scores` exists at all.

///|
/// The rows and the suite are the same states with the same truths.
test "the coherence rows carry the benchmark's own truths" {
  let rows = coherence_rows()
  let derived = []
  for sc in bench_suite() {
    if sc.name.has_prefix("fight_") {
      derived.push(sc)
    }
  }
  assert_eq(rows.length(), derived.length())
  assert_true(rows.length() >= 4 * FIGHT_PER_BUCKET)
  for i in 0..<rows.length() {
    let row = rows[i]
    let sc = derived[i]
    // Same state, in the same order.
    assert_eq(row.name, sc.name)
    assert_eq(row.note, sc.note)
    let mut seen_fight = false
    let mut seen_retreat = false
    for ask in sc.asks {
      if ask.class_ == "fight" {
        seen_fight = true
        // The strict reading IS the `fight` class's truth, not a paraphrase.
        assert_eq(ask.truth, if row.win_strict { "true" } else { "false" })
      }
      if ask.class_ == "retreat" {
        seen_retreat = true
        assert_eq(ask.truth, row.retreat)
      }
    }
    assert_true(seen_fight)
    assert_true(seen_retreat)
  }
}

///|
/// The three-option wording is the SAME decision, priced the same way.
///
/// This is what makes the wording an A/B rather than two measurements: if the
/// reworded question's truth could disagree with the two-option one about
/// whether to swing, or with the `fight` question about whether the fight is
/// won, then a model's answers moving between arms would tell us nothing about
/// the model.
test "the three-way retreat wording asks the same question" {
  let two = fight_scenarios(false)
  let three = fight_scenarios(true)
  assert_eq(two.length(), three.length())
  let mut checked = 0
  for i in 0..<two.length() {
    assert_eq(two[i].name, three[i].name)
    // Same state, and the same questions apart from the reworded one.
    assert_eq(two[i].state.stringify(), three[i].state.stringify())
    assert_eq(two[i].asks.length(), three[i].asks.length())
    let mut a_retreat = ""
    let mut b_retreat = ""
    let mut fight_truth = ""
    for ask in two[i].asks {
      if ask.class_ == "retreat" {
        a_retreat = ask.truth
      }
      if ask.class_ == "fight" {
        fight_truth = ask.truth
      }
    }
    for ask in three[i].asks {
      if ask.class_ == "retreat3" {
        b_retreat = ask.truth
      }
      // Every other question is identical to the two-option arm's.
      if ask.class_ != "retreat3" {
        let mut found = false
        for other in two[i].asks {
          if other.key == ask.key {
            found = true
            assert_eq(other.truth, ask.truth)
            assert_eq(other.instructions, ask.instructions)
          }
        }
        assert_true(found)
      }
    }
    assert_true(a_retreat.length() > 0 && b_retreat.length() > 0)
    checked += 1
    // The two arms agree about whether to swing at all.
    let a_commit = truth_accepts(a_retreat, "fight_now")
    let b_commit = truth_accepts(b_retreat, "win_and_fight") ||
      truth_accepts(b_retreat, "lose_but_fight")
    assert_eq(a_commit, b_commit)
    assert_eq(
      truth_accepts(a_retreat, "walk_away"),
      truth_accepts(b_retreat, "walk_away"),
    )
    // And the commit side is labelled by the `fight` question's own truth, so
    // the middle option means exactly "the fight is lost and swinging is
    // still better" and nothing else.
    if truth_accepts(b_retreat, "win_and_fight") {
      assert_eq(fight_truth, "true")
    }
    if truth_accepts(b_retreat, "lose_but_fight") {
      assert_eq(fight_truth, "false")
    }
    // Never both: a state is one or the other.
    assert_false(
      truth_accepts(b_retreat, "win_and_fight") &&
      truth_accepts(b_retreat, "lose_but_fight"),
    )
  }
  assert_eq(checked, 4 * FIGHT_PER_BUCKET)
}

///|
/// Neither reading is vacuous: the truth allows the pair somewhere and refuses
/// it somewhere. If it allowed the pair everywhere the finding would be
/// meaningless, and if it allowed it nowhere the question would not need
/// asking.
test "the truth allows the pair, but not always" {
  let rep = coherence_report(recorded_run)
  assert_true(rep.truth.both > 0)
  assert_true(rep.truth.both < rep.n)
  // The same holds under the looser reading of winning, so the bound the
  // report draws from `both` does not depend on which reading is used.
  assert_true(rep.truth_relaxed.both > 0)
  assert_true(rep.truth_relaxed.both < rep.n)
  // Both margins are away from the edges, so the count is not a margin in
  // disguise.
  assert_true(rep.truth.first_total() > 0 && rep.truth.first_total() < rep.n)
  assert_true(rep.truth.second_total() > 0 && rep.truth.second_total() < rep.n)
  // The truth's own co-occurrence carries information: it is strictly inside
  // what its margins force.
  assert_true(rep.truth.both > rep.truth.floor())
  assert_true(rep.truth.both < rep.truth.ceiling())
}

///|
/// The check that cost this report a finding: a co-occurrence count that
/// equals its forced overlap says nothing the two margins did not already say.
test "a lopsided pair of answers forces its own overlap" {
  // Hand cases first, so the formula is readable.
  assert_eq(forced_overlap(14, 15, 16), 13)
  assert_eq(forced_overlap(8, 7, 16), 0)
  assert_eq(forced_overlap(16, 16, 16), 16)
  assert_eq(forced_overlap(0, 9, 16), 0)
  // And the recorded run, whose 13 is exactly its floor.
  let rep = coherence_report(recorded_run)
  assert_eq(rep.model_paired, rep.model_forced)
  // Which is not true of the truth's own 4.
  assert_true(rep.truth.both > rep.truth.floor())
}

///|
/// The sign test, against values worked out by hand. `sign_test(less, more)`
/// is the exact two-tailed binomial tail at p = 0.5 over the discordant pairs.
test "the sign test matches the numbers by hand" {
  // 2 / 2^7
  assert_eq(sign_test(0, 7), 0.015625)
  // 2 / 2^9
  assert_eq(sign_test(0, 9), 0.00390625)
  // 2 * (1 + 11) / 2^11
  assert_eq(sign_test(1, 10), 0.01171875)
  // No discordant pairs says nothing.
  assert_eq(sign_test(0, 0), 1.0)
  // Nor does one, however it falls — docs/43 §4b made the same point.
  assert_eq(sign_test(0, 1), 1.0)
  // An even split is as unsurprising as it gets, and the tail is clipped at 1.
  assert_eq(sign_test(5, 5), 1.0)
  assert_eq(sign_test(3, 3), 1.0)
  // Symmetric in its arguments: the test is two-tailed.
  assert_eq(sign_test(2, 9), sign_test(9, 2))
}

///|
/// The recorded run's totals agree with each other, so the arrangements the
/// bounds enumerate are not empty and the range is narrow enough to read.
test "the recorded run's totals are consistent with each other" {
  let rep = coherence_report(recorded_run)
  assert_true(rep.bounds.consistent)
  assert_true(rep.bounds.arrangements > 0)
  assert_eq(rep.model_false, 14)
  assert_eq(rep.n, 16)
  // Every arrangement of the one unrecorded answer lands on the same side of
  // the conventional cutoff, which is the only reason a run that recorded
  // class totals can be concluded from at all.
  assert_true(rep.bounds.hi_p < 0.05)
  assert_true(rep.bounds.lo_p <= rep.bounds.hi_p)
}

///|
/// The relaxed reading is a different question, and the difference is real:
/// it is the death counts alone, and it separates at least one state from the
/// strict reading. (Not every strict win is a relaxed win as a matter of
/// arithmetic — winning outright with four of five down against three is both
/// a win and a lost trade — so this is the grid's property, not a theorem.)
test "the relaxed fight truth is a different reading of the same fights" {
  let rows = coherence_rows()
  let mut differ = 0
  for r in rows {
    assert_eq(r.win_relaxed, r.our_deaths <= r.their_deaths)
    if r.win_strict != r.win_relaxed {
      differ += 1
    }
  }
  assert_true(differ > 0)
  let rep = coherence_report(recorded_run)
  assert_eq(rep.strict_relaxed_agree, rep.n - differ)
  // The strict reading is the one the class is balanced for: half the states.
  assert_eq(rep.strict_const * 2, rep.n)
  // The relaxed one is not, so the run's score against it has to be read
  // against its own constant answer rather than against 0.50.
  assert_true(rep.relaxed_const * 2 != rep.n)
}
