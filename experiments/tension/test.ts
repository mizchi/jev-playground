/**
 * What has to hold before a request is spent.
 *
 *   npm test      # no API key
 *
 * The load-bearing ones: each game's rules are self-consistent (every legal
 * move applies, the winner is decided the same way twice, no position has
 * moves and a winner at once), the solver agrees with values that are known
 * independently, the trajectory statistics behave on trajectories built by
 * hand, and no payload carries the solver's answer.
 *
 * That last one is the whole experiment's integrity. Criticality is computed
 * from the same position that goes into the state, so a state shape that
 * leaked "one move holds here" would make the correlation in §2 an artefact.
 */
import { GAMES, type GameName, type Position, RULES } from "./src/games.js";
import { analyse, clearMemo, kept, perfectMove, value } from "./src/solve.js";
import { ARMS, LEVELS, MOVE, STANDING, payloadOf, questionsFor, stateFor } from "./src/arms.js";
import { alternation, mean, median, spearman, swingOf, trajectoryOf, type MoveRow } from "./src/tension.js";

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void): void => {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}: ${(err as Error).message}`);
  }
};
const ok = (cond: boolean, what: string): void => {
  if (!cond) throw new Error(what);
};
const eq = <T,>(a: T, b: T, what = ""): void => {
  if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const near = (a: number, b: number, tol: number, what = ""): void => {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${what} expected ${b} +/- ${tol}, got ${a}`);
};

// ------------------------------------------------------------------ the rules

check("every game's rules are internally consistent over a whole random walk", () => {
  for (const game of GAMES) {
    const rules = RULES[game];
    for (let seed = 1; seed <= 4; seed += 1) {
      let p = rules.start(seed);
      let plies = 0;
      while (plies < 90) {
        const done = rules.winner(p);
        const moves = rules.moves(p);
        if (done !== null) {
          eq(moves.length, 0, `${game}: ${p.key} is finished but offers moves`);
          break;
        }
        ok(moves.length > 0, `${game}: ${p.key} is unfinished with no moves`);
        eq(new Set(moves.map((m) => m.name)).size, moves.length, `${game}: duplicate move names at ${p.key}`);
        for (const m of moves) {
          const next = rules.apply(p, m.name);
          eq(next.player, 1 - p.player, `${game}: ${m.name} did not pass the turn`);
          ok(next.key !== p.key, `${game}: ${m.name} did not change the position`);
        }
        ok(rules.render(p).length > 0, `${game}: renders to nothing`);
        p = rules.apply(p, moves[plies % moves.length].name);
        plies += 1;
      }
      ok(plies < 90, `${game}: a game did not finish in 90 plies`);
    }
  }
});

check("an illegal move is refused rather than silently accepted", () => {
  const t = RULES.tictactoe;
  const after = t.apply(t.start(1), "r2c2");
  let threw = false;
  try {
    t.apply(after, "r2c2");
  } catch {
    threw = true;
  }
  ok(threw, "playing on a taken square was allowed");
});

check("the two tic-tac-toes disagree about who won the same board", () => {
  const line = "XXX" + "OO." + "...";
  const plain: Position = { game: "tictactoe", key: line, player: 1 };
  const inverted: Position = { game: "misere", key: line, player: 1 };
  eq(RULES.tictactoe.winner(plain), 0, "X made a line and should win the ordinary game");
  eq(RULES.misere.winner(inverted), 1, "X made a line and should LOSE the inverted game");
});

// ----------------------------------------------------------------- the solver

check("the solver reproduces values that are known independently", () => {
  clearMemo();
  // Tic-tac-toe is a draw from the empty board. This is the textbook result.
  eq(value({ game: "tictactoe", key: ".........", player: 0 }), 0, "tic-tac-toe should be a draw");
  // Nim: the first player wins exactly when the XOR of the heaps is nonzero.
  for (const heaps of [[1, 2, 3], [3, 4, 5], [1, 1, 1], [2, 2, 0], [5, 5, 5], [0, 0, 7]]) {
    const xor = heaps.reduce((a, b) => a ^ b, 0);
    const v = value({ game: "nim", key: heaps.join(","), player: 0 });
    eq(v, xor === 0 ? -1 : 1, `nim ${heaps.join(",")} (xor ${xor})`);
  }
  // A won position one move from the end.
  eq(value({ game: "tictactoe", key: "XX.OO....", player: 0 }), 1, "X to move with two in a row and a free square");
});

check("criticality is a fraction of the legal moves, and the extremes are real", () => {
  clearMemo();
  for (const game of GAMES) {
    const rules = RULES[game];
    let p = rules.start(1);
    while (rules.winner(p) === null) {
      const a = analyse(p);
      eq(a.legal, rules.moves(p).length, `${game}: legal count disagrees with the rules`);
      ok(a.optimal >= 1 && a.optimal <= a.legal, `${game}: ${a.optimal} of ${a.legal} optimal`);
      near(a.criticality, 1 - a.optimal / a.legal, 1e-12, `${game}: criticality`);
      p = rules.apply(p, perfectMove(p).name);
    }
  }
  // The floor: in `drift` no move can ever matter, at any point of any game.
  const rules = RULES.drift;
  let p = rules.start(1);
  let plies = 0;
  while (rules.winner(p) === null) {
    eq(analyse(p).criticality, 0, `drift ply ${plies} has a move that matters`);
    p = rules.apply(p, rules.moves(p)[plies % 2].name);
    plies += 1;
  }
  ok(plies > 10, `drift ended after only ${plies} plies`);
  // The ceiling: nim from a winning position has exactly one winning move
  // when the heaps are all distinct powers of two.
  const nim = analyse({ game: "nim", key: "1,2,4", player: 0 });
  eq(nim.optimal, 1, "nim 1,2,4 should have exactly one winning move");
  ok(nim.criticality > 0.8, `nim 1,2,4 criticality was ${nim.criticality}`);
});

check("a perfect player never loses a game it starts winning", () => {
  clearMemo();
  for (const game of GAMES) {
    const rules = RULES[game];
    const start = rules.start(1);
    const want = value(start);
    let p = start;
    while (rules.winner(p) === null) p = rules.apply(p, perfectMove(p).name);
    const result = rules.winner(p)!;
    // `want` is from the STARTING player's point of view.
    const got = result === -1 ? 0 : result === start.player ? 1 : -1;
    eq(got, want, `${game}: solver said ${want}, perfect play gave ${got}`);
  }
});

check("kept() agrees with the optimal set it is derived from", () => {
  clearMemo();
  const p: Position = { game: "nim", key: "1,2,4", player: 0 };
  const a = analyse(p);
  for (const m of RULES.nim.moves(p)) eq(kept(p, m.name), a.best.includes(m.name), m.name);
  eq(a.best.length, 1, "exactly one move should hold nim 1,2,4");
});

// ------------------------------------------------------------------- the arms

check("the choice criteria are exactly the legal moves", () => {
  const p = RULES.connect3.start(1);
  const moves = RULES.connect3.moves(p);
  for (const arm of ARMS) {
    const qs = questionsFor(arm, moves);
    eq(Object.keys(qs).length, 2, `${arm} does not ask exactly two questions`);
    const move = qs[MOVE];
    ok(move.type === "choice", `${arm}: the move question is not a choice`);
    const names = Object.keys((move as { criteria: Record<string, unknown> }).criteria);
    eq(names.join("|"), moves.map((m) => m.name).join("|"), arm);
    const standing = qs[STANDING];
    ok(standing.type === "score", `${arm}: the standing question is not a score`);
    eq((standing as { criteria: unknown[] }).criteria.length, LEVELS.length, arm);
  }
});

check("jevterse gets the move names and not what they do", () => {
  const p = RULES.nim.start(1);
  const moves = RULES.nim.moves(p);
  const terse = JSON.stringify(questionsFor("jevterse", moves));
  const full = JSON.stringify(questionsFor("jev", moves));
  ok(!terse.includes("leaving heaps"), "jevterse is told the resulting position");
  ok(full.includes("leaving heaps"), "jev has lost the resulting position");
  // Both still get the rules and the board.
  for (const arm of ARMS) {
    const body = payloadOf(arm, p, [], moves);
    ok(body.includes("takes the very last object wins"), `${arm} is not told the rules`);
    ok(body.includes("heap 1"), `${arm} cannot see the position`);
  }
});

check("no payload carries the solver's answer", () => {
  clearMemo();
  for (const game of GAMES) {
    const rules = RULES[game];
    let p = rules.start(1);
    let plies = 0;
    while (rules.winner(p) === null && plies < 20) {
      const moves = rules.moves(p);
      const a = analyse(p);
      for (const arm of ARMS) {
        const body = payloadOf(arm, p, [`X: ${moves[0].name}`], moves);
        // The words the solver's verdict would be written in.
        for (const word of ["criticality", "optimal", "winning move", "best move", '"value"', "solver"]) {
          ok(!body.includes(word), `${game}/${arm} leaks "${word}"`);
        }
        // And the verdict itself, however phrased: when exactly one move
        // holds, that move's name must not be singled out anywhere.
        if (a.optimal === 1) {
          const others = moves.filter((m) => m.name !== a.best[0]);
          ok(others.length === 0 || others.some((m) => body.includes(m.name)), `${game}/${arm} names only the winning move`);
        }
      }
      p = rules.apply(p, moves[plies % moves.length].name);
      plies += 1;
    }
  }
});

check("the state describes the position and the rules, and stops there", () => {
  const p = RULES.misere.start(1);
  const body = JSON.stringify(stateFor(p, []));
  ok(body.includes("you LOSE"), "the inverted goal is not stated");
  ok(!/threat|fork|advantage|should play|strong|weak/i.test(body), "the state coaches");
  eq(JSON.stringify(stateFor(p, []).position), JSON.stringify(RULES.misere.render(p)), "the board is not passed through");
});

// ------------------------------------------------------- the statistics

check("mean and median behave, including on an even count", () => {
  near(mean([1, 2, 3, 4]), 2.5, 1e-12);
  near(median([1, 2, 3, 4]), 2.5, 1e-12);
  near(median([3, 1, 2]), 2, 1e-12);
  ok(Number.isNaN(mean([])), "mean of nothing should be NaN rather than 0");
});

check("alternation is 1 for a sawtooth and 0 for a single crossing", () => {
  near(alternation([0, 1, 0, 1, 0, 1]), 1, 1e-12, "a sawtooth alternates every step");
  near(alternation([0, 0, 0, 1, 1, 1]), 1 / 5, 1e-12, "one crossing out of five chances");
  eq(alternation([0.5, 0.5, 0.5, 0.5]), 0, "a flat series cannot cross its own median");
  eq(alternation([1]), 0, "a single point has no chances");
});

check("swing compares a player with themselves, not with the opponent", () => {
  const row = (ply: number, player: number, standing: number): MoveRow => ({
    game: "nim",
    seed: 1,
    ply,
    player,
    confidence: 0.5,
    standing,
    criticality: 0,
    legal: 2,
    optimal: 2,
    kept: true,
    chosen: "x",
  });
  // X reads 4,4,4 while O reads 0,0,0: a huge gap between sides, no swing.
  const steady = [row(0, 0, 4), row(1, 1, 0), row(2, 0, 4), row(3, 1, 0), row(4, 0, 4), row(5, 1, 0)];
  eq(swingOf(steady), 0, "a constant reading for each side is not a swing");
  // Now X's own reading moves by 2 each time.
  const moving = [row(0, 0, 4), row(1, 1, 0), row(2, 0, 2), row(3, 1, 0), row(4, 0, 4), row(5, 1, 0)];
  near(swingOf(moving), 1, 1e-12, "X moved 2 then 2, O moved 0 then 0: mean of 2,2,0,0");
});

check("tension is zero when nothing moves, and rises when both parts do", () => {
  const make = (confidences: number[], standings: number[]): MoveRow[] =>
    confidences.map((c, i) => ({
      game: "nim",
      seed: 1,
      ply: i,
      player: i % 2,
      confidence: c,
      standing: standings[i],
      criticality: 0,
      legal: 2,
      optimal: 2,
      kept: true,
      chosen: "x",
    }));
  const flat = trajectoryOf(make([1, 1, 1, 1, 1, 1], [2, 2, 2, 2, 2, 2]));
  eq(flat.tension, 0, "certain choices and a steady reading is no tension");
  const tense = trajectoryOf(make([0.2, 0.9, 0.2, 0.9, 0.2, 0.9], [0, 4, 4, 0, 0, 4]));
  ok(tense.tension > flat.tension, "an alternating trajectory should not score below a flat one");
  ok(tense.doubt > 0.4 && tense.swing > 1, `doubt ${tense.doubt} swing ${tense.swing}`);
  // Doubt alone is not tension: unsure the whole way with a frozen reading.
  const unsureButStill = trajectoryOf(make([0.2, 0.2, 0.2, 0.2, 0.2, 0.2], [2, 2, 2, 2, 2, 2]));
  eq(unsureButStill.tension, 0, "swing of zero has to zero the product");
});

check("spearman ranks, and is not fooled by a monotone transform", () => {
  const xs = [1, 2, 3, 4, 5];
  near(spearman(xs.map((x) => ({ a: x, b: x }))), 1, 1e-12);
  near(spearman(xs.map((x) => ({ a: x, b: -x }))), -1, 1e-12);
  // A monotone but very non-linear map still ranks perfectly.
  near(spearman(xs.map((x) => ({ a: x, b: Math.exp(x) }))), 1, 1e-12);
  ok(Number.isNaN(spearman([{ a: 1, b: 2 }])), "two points cannot be ranked");
  ok(Number.isNaN(spearman(xs.map((x) => ({ a: x, b: 7 })))), "a constant has no ranking");
});

// -------------------------------------------------------- the recorded run

check("the games differ in criticality, so the ranking has something to rank", () => {
  clearMemo();
  const profile = new Map<GameName, number>();
  for (const game of GAMES) {
    const rules = RULES[game];
    const crits: number[] = [];
    let p = rules.start(1);
    let plies = 0;
    while (rules.winner(p) === null && plies < 40) {
      crits.push(analyse(p).criticality);
      p = rules.apply(p, perfectMove(p).name);
      plies += 1;
    }
    profile.set(game, mean(crits));
  }
  const values = [...profile.values()];
  ok(Math.max(...values) - Math.min(...values) > 0.3, `the games' criticality spans only ${JSON.stringify([...profile])}`);
  eq(profile.get("drift"), 0, "drift must be exactly zero or it is not a floor");
  ok(profile.get("nim")! > 0.2, `nim's criticality was only ${profile.get("nim")}`);
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
