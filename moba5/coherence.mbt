///|
/// Two questions about the same node, and whether their answers can both be
/// right.
///
/// The benchmark's clearest finding was not an accuracy number. It was that in
/// **13 of the 16 derived fight states the model answered `fight` with `false`
/// ("we do not win this") and `retreat` with `fight_now` ("swing anyway") in
/// the same request about the same node**. Accuracy per class cannot see that:
/// both answers are scored against their own truth and neither is asked
/// whether it agrees with the other.
///
/// But the finding reads two ways, and docs/56 §1.12 wrote both down:
///
/// - the model is contradicting itself, or
/// - the two questions are not asking the same thing, and "we lose the fight
///   but swinging is still the better move" is a position that exists.
///
/// The second reading is not a dodge — `fight` asks whether the enemy ends up
/// off the node, while `retreat` asks which of two openings the position score
/// prefers eight ticks later. So this file measures the gap the questions
/// themselves leave, with no API involved:
///
///  1. **How often the truth allows the pair.** Both truths are computed for
///     the same 16 states, and the 2×2 census says how often "we do not win"
///     and "fight now" are *both correct*. That is the number the model's 13
///     has to be compared against, and `Pairing::floor` says how much of it
///     the two margins force before any state is looked at.
///  2. **Where the strict truth's threshold is.** "We win outright" is one
///     reading of the question; "we do not lose the body trade" is another,
///     and `FightResult::trade_not_lost` computes it. Scoring the same
///     answers against both says whether the model's near-constant `false` is
///     wrong or is an answer to the looser question.
///
/// Everything here runs on `Game::copy` and the fixed grid, so the numbers are
/// a property of the rules, not of a run.

///|
/// One derived fight state, with every truth the coherence question needs.
pub(all) struct CoherenceRow {
  /// The scenario name the suite gives this state, so a row can be matched
  /// against a recorded run's printout.
  name : String
  bucket : String
  note : String
  /// `ask_fight`'s truth: we win outright — every one of theirs off the node,
  /// at least one of ours standing.
  win_strict : Bool
  /// The looser reading: we do not lose the body trade.
  win_relaxed : Bool
  our_deaths : Int
  their_deaths : Int
  /// `ask_retreat`'s truth, which can accept both options at once.
  retreat : String
  commit_score : Int
  away_score : Int
}

///|
/// Whether the retreat truth accepts committing. A tie accepts both, and a
/// tie is not a contradiction with anything.
pub fn CoherenceRow::commit_ok(self : CoherenceRow) -> Bool {
  truth_accepts(self.retreat, "fight_now")
}

///|
/// The combination the finding is about: the rules say we do not win this
/// fight, and the position score still prefers swinging.
pub fn CoherenceRow::truth_pairs(self : CoherenceRow) -> Bool {
  !self.win_strict && self.commit_ok()
}

///|
/// Every derived fight state, with both fight truths and the retreat truth.
///
/// Built from the same `balanced_fight_cases(FIGHT_PER_BUCKET)` the suite is
/// built from, in the same order and with the same names, so row `i` here is
/// scenario `i` there. Nothing about the model enters.
pub fn coherence_rows() -> Array[CoherenceRow] {
  let out : Array[CoherenceRow] = []
  let cases = balanced_fight_cases(FIGHT_PER_BUCKET)
  for i in 0..<cases.length() {
    let case_ = cases[i]
    let g = case_.build()
    let r = g.simulate_fight(case_.node, FIGHT_TICKS)
    let (commit, away) = g.retreat_scores(case_.node, TEAM_A, RETREAT_HORIZON)
    out.push({
      name: "fight_\{i + 1}_\{case_.bucket()}",
      bucket: case_.bucket(),
      note: case_.describe(),
      win_strict: r.winner == TEAM_A,
      win_relaxed: r.trade_not_lost(TEAM_A),
      our_deaths: r.a_deaths,
      their_deaths: r.b_deaths,
      retreat: retreat_pick(commit, away),
      commit_score: commit,
      away_score: away,
    })
  }
  out
}

// ------------------------------------------------------ counting two readings

///|
/// A 2×2 census of how two yes/no readings of the same states co-occur.
pub(all) struct Pairing {
  both : Int
  first_only : Int
  second_only : Int
  neither : Int
}

///|
/// Count the 2×2. The two arrays are readings of the SAME states in the same
/// order; a length mismatch is a programming error and counts nothing.
pub fn pair_census(first : Array[Bool], second : Array[Bool]) -> Pairing {
  let mut both = 0
  let mut a_only = 0
  let mut b_only = 0
  let mut neither = 0
  let n = if first.length() < second.length() {
    first.length()
  } else {
    second.length()
  }
  for i in 0..<n {
    match (first[i], second[i]) {
      (true, true) => both += 1
      (true, false) => a_only += 1
      (false, true) => b_only += 1
      (false, false) => neither += 1
    }
  }
  { both, first_only: a_only, second_only: b_only, neither, }
}

///|
pub fn Pairing::total(self : Pairing) -> Int {
  self.both + self.first_only + self.second_only + self.neither
}

///|
/// How many states said yes to the first reading.
pub fn Pairing::first_total(self : Pairing) -> Int {
  self.both + self.first_only
}

///|
/// How many said yes to the second.
pub fn Pairing::second_total(self : Pairing) -> Int {
  self.both + self.second_only
}

///|
/// The smallest overlap two margins force over `n` states: there is no way to
/// answer `first` yes 14 times and `second` yes 15 times out of 16 without at
/// least 13 states saying yes to both.
///
/// This is the number that decides whether a co-occurrence count carries any
/// information at all. **A count equal to its forced overlap is a restatement
/// of how lopsided each answer was on its own** — it is not evidence about
/// the pair. Checking it is one line, and not checking it cost this report a
/// finding.
pub fn forced_overlap(first : Int, second : Int, n : Int) -> Int {
  let f = first + second - n
  if f < 0 {
    0
  } else {
    f
  }
}

///|
/// The smallest `both` these two margins allow, over every way of arranging
/// the answers.
pub fn Pairing::floor(self : Pairing) -> Int {
  forced_overlap(self.first_total(), self.second_total(), self.total())
}

///|
/// The largest `both` the margins allow: everyone who could pair, does.
pub fn Pairing::ceiling(self : Pairing) -> Int {
  let a = self.first_total()
  let b = self.second_total()
  if a < b {
    a
  } else {
    b
  }
}

// ------------------------------------------------------------- the sign test

///|
/// The exact two-tailed sign test on discordant pairs, as every other
/// experiment in this repository runs it (docs/43 §1a, docs/50, docs/53): of
/// the pairs where the two readings disagree, how surprising is it that the
/// disagreement leans this far one way, if each direction were a coin flip?
///
/// Concordant pairs carry no information about the direction and are not
/// counted, which is the whole point of the test — it assumes nothing about a
/// distribution and works at these sample sizes.
pub fn sign_test(less : Int, more : Int) -> Double {
  let n = less + more
  if n == 0 {
    return 1.0
  }
  let smaller = if less < more { less } else { more }
  // Sum C(n, 0..=smaller) as a running product, so nothing overflows.
  let mut tail = 0.0
  let mut term = 1.0
  for k in 0..<=smaller {
    if k > 0 {
      term = term * (n - k + 1).to_double() / k.to_double()
    }
    tail += term
  }
  let mut total = 1.0
  for _i in 0..<n {
    total = total * 2.0
  }
  let p = 2.0 * tail / total
  if p > 1.0 {
    1.0
  } else {
    p
  }
}

///|
/// A paired comparison of two yes/no readings of the same states: the
/// discordant counts, and what the sign test makes of them.
pub(all) struct Discordance {
  /// States the first reading says yes to and the second does not.
  first_only : Int
  second_only : Int
  agree : Int
  p : Double
}

///|
/// Compare two readings state by state. `first` is the one being tested (a
/// run's pairing); `second` is what it is tested against (the truth's).
///
/// This is `pairing_bounds` without the guessing, and it is what a per-state
/// record buys: the arrangements do not have to be enumerated because the
/// arrangement is known.
pub fn discordance(first : Array[Bool], second : Array[Bool]) -> Discordance {
  let c = pair_census(first, second)
  {
    first_only: c.first_only,
    second_only: c.second_only,
    agree: c.both + c.neither,
    p: sign_test(c.second_only, c.first_only),
  }
}

///|
/// One run's pairing against the truth's, exactly, from per-state answers.
///
/// `fight_false[i]` and `commit[i]` are what the run answered about state `i`
/// of `rows`, which is `coherence_rows()` order. A run whose answers were
/// recorded per state needs this rather than `pairing_bounds`.
pub fn pairing_exact(
  rows : Array[CoherenceRow],
  fight_false : Array[Bool],
  commit : Array[Bool],
) -> Discordance {
  let said : Array[Bool] = []
  let truth : Array[Bool] = []
  let n = if fight_false.length() < commit.length() {
    fight_false.length()
  } else {
    commit.length()
  }
  for i in 0..<n {
    if i >= rows.length() {
      break
    }
    said.push(fight_false[i] && commit[i])
    truth.push(rows[i].truth_pairs())
  }
  discordance(said, truth)
}

// -------------------------------------------- a run that recorded only totals

///|
/// What one recorded `--bench` run pinned about the derived fight states.
///
/// The run this holds printed per-question rows for `fight` but reported
/// `retreat` as a class total, so the pairing cannot be laid over the states
/// exactly. Rather than guess which state took the single `walk_away`,
/// `pairing_bounds` enumerates every arrangement the totals allow and returns
/// the range — which turns out to be narrow enough to conclude from, and is
/// honest when it is not.
pub(all) struct Recorded {
  what : String
  /// Per state, in suite order: did the model answer `false` to `fight`?
  fight_false : Array[Bool]
  /// How many of the same states got `fight_now` on `retreat`.
  commit_count : Int
  /// How many states the run reported as answering both — the 13.
  paired : Int
}

///|
/// The sign test's answer under every arrangement of a recorded run's retreat
/// total, against the truth's own pairing.
///
/// `lo_p`/`hi_p` bracket the p-value; `consistent` is false when no
/// arrangement reproduces the reported `paired`, which would mean the recorded
/// numbers disagree with each other and nothing below should be read.
pub(all) struct PairingBounds {
  arrangements : Int
  consistent : Bool
  lo_p : Double
  hi_p : Double
  /// The discordant counts at each end, as "model_only/truth_only".
  lo_at : String
  hi_at : String
}

///|
/// Enumerate the arrangements.
///
/// The model pairs a state exactly when it answered `fight` `false` there AND
/// spent one of its `commit_count` `fight_now` answers there. Which states
/// those are is not recorded, but the statistic only depends on how many of
/// the missing `walk_away` answers landed on states the TRUTH pairs and how
/// many landed on states it does not — every state within one of those groups
/// is interchangeable. So the enumeration is over those two counts, which is
/// small, and the reported `paired` pins their sum.
pub fn pairing_bounds(
  rows : Array[CoherenceRow],
  rec : Recorded,
) -> PairingBounds {
  let n = rows.length()
  // Split the states by (does the truth pair it, did the model say `false`).
  let mut a = 0 // truth pairs, model said false  — pairs unless it walked away
  let mut b = 0 // truth does not pair, model said false
  let mut c = 0 // truth pairs, model said true   — truth-only whatever happens
  for i in 0..<n {
    let t = rows[i].truth_pairs()
    let f = i < rec.fight_false.length() && rec.fight_false[i]
    if t && f {
      a += 1
    } else if !t && f {
      b += 1
    } else if t && !f {
      c += 1
    }
  }
  // Every `walk_away` that lands on a state the model said `false` to removes
  // that state from the model's pairs. The reported total pins how many did.
  let removed = a + b - rec.paired
  let walk_aways = n - rec.commit_count
  let mut arrangements = 0
  let mut lo_p = 2.0
  let mut hi_p = -1.0
  let mut lo_at = ""
  let mut hi_at = ""
  if removed >= 0 && removed <= walk_aways {
    for j in 0..<=removed {
      // j of them land on states the truth pairs, the rest on states it does
      // not; the remaining `walk_away` answers land on states the model said
      // `true` to, where they change nothing.
      let i_ = removed - j
      if j > a || i_ > b {
        continue
      }
      let model_only = b - i_
      let truth_only = c + j
      let p = sign_test(truth_only, model_only)
      arrangements += 1
      if p < lo_p {
        lo_p = p
        lo_at = "\{model_only}/\{truth_only}"
      }
      if p > hi_p {
        hi_p = p
        hi_at = "\{model_only}/\{truth_only}"
      }
    }
  }
  if arrangements == 0 {
    return {
      arrangements: 0,
      consistent: false,
      lo_p: 1.0,
      hi_p: 1.0,
      lo_at: "",
      hi_at: "",
    }
  }
  { arrangements, consistent: true, lo_p, hi_p, lo_at, hi_at, }
}

// --------------------------------------------------------------- the answers

///|
/// Every number the analysis concludes, computed once so the printout and the
/// tests cannot drift apart.
pub(all) struct CoherenceReport {
  n : Int
  /// The truth's own 2×2: "we do not win outright" against "the score prefers
  /// committing".
  truth : Pairing
  /// The same with the relaxed reading of winning.
  truth_relaxed : Pairing
  /// The recorded run's margins over the same states, and the overlap they
  /// force before any state is looked at.
  model_false : Int
  model_commit : Int
  model_paired : Int
  model_forced : Int
  /// How many of the run's pairs the truth cannot allow, at least: it allows
  /// `truth.both` pairs in total, and the run cannot have found more of them
  /// than exist. The second number is the same bound under the looser reading
  /// of winning, so the bound cannot be blamed on the threshold.
  model_pairs_unallowed : Int
  model_pairs_unallowed_relaxed : Int
  /// The sign test over every arrangement the run's totals permit.
  bounds : PairingBounds
  /// Out of `n`: the run's `fight` answers scored against each definition, and
  /// what answering `false` to everything scores against each.
  strict_hits : Int
  relaxed_hits : Int
  strict_const : Int
  relaxed_const : Int
  /// How many states the two definitions agree about.
  strict_relaxed_agree : Int
}

///|
/// Run the whole analysis. No API, no randomness: `rows` come from the grid.
pub fn coherence_report(rec : Recorded) -> CoherenceReport {
  let rows = coherence_rows()
  let n = rows.length()
  let no_win = []
  let no_win_relaxed = []
  let commit = []
  for r in rows {
    no_win.push(!r.win_strict)
    no_win_relaxed.push(!r.win_relaxed)
    commit.push(r.commit_ok())
  }
  let truth = pair_census(no_win, commit)
  let truth_relaxed = pair_census(no_win_relaxed, commit)
  let mut model_false = 0
  for b in rec.fight_false {
    if b {
      model_false += 1
    }
  }
  let mut strict_hits = 0
  let mut relaxed_hits = 0
  let mut strict_const = 0
  let mut relaxed_const = 0
  let mut agree = 0
  for i in 0..<n {
    let said_no = i < rec.fight_false.length() && rec.fight_false[i]
    if said_no != rows[i].win_strict {
      strict_hits += 1
    }
    if said_no != rows[i].win_relaxed {
      relaxed_hits += 1
    }
    if !rows[i].win_strict {
      strict_const += 1
    }
    if !rows[i].win_relaxed {
      relaxed_const += 1
    }
    if rows[i].win_strict == rows[i].win_relaxed {
      agree += 1
    }
  }
  fn floor_at(allowed : Int) -> Int {
    let u = rec.paired - allowed
    if u < 0 {
      0
    } else {
      u
    }
  }

  {
    n,
    truth,
    truth_relaxed,
    model_false,
    model_commit: rec.commit_count,
    model_paired: rec.paired,
    model_forced: forced_overlap(model_false, rec.commit_count, n),
    model_pairs_unallowed: floor_at(truth.both),
    model_pairs_unallowed_relaxed: floor_at(truth_relaxed.both),
    bounds: pairing_bounds(rows, rec),
    strict_hits,
    relaxed_hits,
    strict_const,
    relaxed_const,
    strict_relaxed_agree: agree,
  }
}

///|
/// The run docs/56 §4 reported, as the printout pinned it.
///
/// Provenance, because this is the one thing in `moba5/` that is a measurement
/// rather than a property of the rules: `--bench --repeat 5` against
/// `jev-latest`, the run whose table docs/56 §4 prints. `fight` answered
/// `false` in 14 of the 16 derived states — every one except the two named
/// here, both of which sit in the `count_wrong_win` bucket. `retreat` answered
/// `fight_now` in 21 of its 22 questions, 15 of the 16 here, and the printout
/// did not say which state took the `walk_away`; `pairing_bounds` covers that.
///
/// Answers from a later run belong beside this one rather than replacing it —
/// the model is probabilistic and one run is one draw.
pub let recorded_run : Recorded = {
  what: "--bench --repeat 5, jev-latest, the run in docs/56 §4",
  fight_false: [
    true, true, true, true, // count_right_win
     true, true, true, true, // count_wrong_loss
     true, true, false, false, // count_wrong_win: fight_11 and fight_12 said "true"
     true, true, true, true, // count_right_loss
  ],
  commit_count: 15,
  paired: 13,
}
