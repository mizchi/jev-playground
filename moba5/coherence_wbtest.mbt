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
/// EVERY three-option wording is the SAME decision, priced the same way.
///
/// This is what makes the wordings an A/B rather than several measurements: if
/// a reworded question's truth could disagree with the two-option one about
/// whether to swing, or with the `fight` question about whether the fight is
/// won, then a model's answers moving between arms would tell us nothing about
/// the model. The variants differ in prose and in one case in option order,
/// and this test is what says so.
test "every three-way retreat wording asks the same question" {
  for wording in retreat3_wordings {
    check_three_way(wording)
  }
}

///|
fn check_three_way(wording : RetreatWording) -> Unit raise {
  let two = fight_scenarios(TwoWay)
  let three = fight_scenarios(wording)
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
      // The reworded question keeps its key, its class and its instructions,
      // so only the options and their prose differ.
      if ask.class_ == "retreat3" {
        assert_eq(ask.key, "commit_or_disengage_3")
        assert_eq(ask.options.length(), 3)
        assert_eq(ask.descriptions.length(), 3)
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
/// The wordings differ in the way each is supposed to differ.
///
/// The previous test says the arms ask the same question; this one says they
/// ask it differently, which is the other half of an A/B. A copy-paste that
/// left two arms identical would make the experiment report "the wording does
/// not matter" for free, and nothing in the numbers would show it.
test "the wordings differ in the way each is meant to" {
  fn opts_of(w : RetreatWording) -> (Array[String], Array[String]) {
    retreat3_options(w)
  }

  fn spread(descs : Array[String]) -> Int {
    let mut lo = 1 << 28
    let mut hi = 0
    for d in descs {
      if d.length() < lo {
        lo = d.length()
      }
      if d.length() > hi {
        hi = d.length()
      }
    }
    hi - lo
  }

  let (plain_opts, plain_descs) = opts_of(ThreePlain)
  // Every arm offers the same three options, so only the prose and the order
  // can differ.
  for w in retreat3_wordings {
    let (o, d) = opts_of(w)
    assert_eq(o.length(), 3)
    assert_eq(d.length(), 3)
    for name in plain_opts {
      assert_true(o.contains(name))
    }
    for s in d {
      assert_true(s.length() > 20)
    }
  }
  // `ThreeReordered` is the SAME sentences in a different order: every option
  // keeps the description it had, so the arm changes order and nothing else.
  let (re_opts, re_descs) = opts_of(ThreeReordered)
  assert_true(re_opts != plain_opts)
  for i in 0..<plain_opts.length() {
    let mut found = false
    for k in 0..<re_opts.length() {
      if re_opts[k] == plain_opts[i] {
        found = true
        assert_eq(re_descs[k], plain_descs[i])
      }
    }
    assert_true(found)
  }
  // And it moves the middle meaning out of the middle, which is the confound
  // it exists to separate.
  assert_eq(plain_opts[1], "lose_but_fight")
  assert_true(re_opts[1] != "lose_but_fight")
  // `ThreeFlat` and `ThreeTilted` reword the middle option.
  for w in [ThreeFlat, ThreeTilted] {
    let (o, d) = opts_of(w)
    for i in 0..<o.length() {
      if o[i] == "lose_but_fight" {
        assert_true(d[i] != plain_descs[1])
      }
    }
  }
  // `ThreeFlat` is flat: its three descriptions are closer in length than the
  // baseline's, where walking away is described in half the words the two
  // swings get.
  let (_, flat_descs) = opts_of(ThreeFlat)
  assert_true(spread(flat_descs) < spread(plain_descs))
  assert_true(
    plain_descs[2].length() * 2 <
    plain_descs[0].length() + plain_descs[1].length(),
  )
  // And the asymmetry that matters is not length but argument: in the baseline
  // exactly one option's prose says it is worth more than the alternative, and
  // it is the middle one. That sentence is what the 73% might be a property
  // of, so the variants move it.
  let mut plain_args = 0
  for i in 0..<plain_opts.length() {
    if plain_descs[i].contains("worth more") {
      plain_args += 1
      assert_eq(plain_opts[i], "lose_but_fight")
    }
  }
  assert_eq(plain_args, 1)
  // `ThreeFlat` gives the argument to nobody.
  for d in flat_descs {
    assert_false(d.contains("worth more"))
  }
  // `ThreeTilted` gives it to walking away instead — the same sentence shape,
  // on the option that loses it in the baseline.
  let (tilt_opts, tilt_descs) = opts_of(ThreeTilted)
  let mut tilt_args = 0
  for i in 0..<tilt_opts.length() {
    if tilt_descs[i].contains("worth more") {
      tilt_args += 1
      assert_eq(tilt_opts[i], "walk_away")
    }
  }
  assert_eq(tilt_args, 1)
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
