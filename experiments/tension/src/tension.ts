/**
 * The proposed measure, and what it is checked against.
 *
 * The hypothesis being tested, stated so it can fail: a good game keeps the
 * player unsure which move to make, and keeps the evaluation moving, and the
 * two alternate rather than settling. Written as three numbers over one
 * game's trajectory:
 *
 *   doubt      mean (1 - confidence) over the moves. How unsure, on average.
 *   swing      mean |change in the standing score| between consecutive
 *              moves by the same player. How much the reading moves.
 *   alternation  how often doubt crosses its own median, divided by how
 *              often it could. A trajectory that is unsure early and certain
 *              late crosses once; one that alternates crosses often.
 *
 * `tension` multiplies doubt by swing and weights by alternation. The
 * weighting is a CHOICE, not a finding, and it is written as one line so it
 * can be replaced:
 *
 *   tension = doubt * swing * (0.5 + 0.5 * alternation)
 *
 * None of that is worth anything unless it agrees with something computed
 * without asking. That is what `criticality` is for: the solver says, for
 * every position actually played, what fraction of the legal moves throws
 * the position away. A game whose positions are mostly critical is tight,
 * and if `tension` does not rank the games the way mean criticality does,
 * the measure is wrong -- which is the outcome this file is designed to be
 * able to report.
 */

export interface MoveRow {
  game: string;
  seed: number;
  ply: number;
  player: number;
  /** The `choice` confidence. */
  confidence: number;
  /** The `score` level, 0..4. */
  standing: number;
  /**
   * The same judgment on nine levels (0..8), asked in the same request.
   * Absent in records written before docs/06 homework (c).
   */
  standingFine?: number;
  /** From the solver, never from an answer. */
  criticality: number;
  legal: number;
  optimal: number;
  /** Did the chosen move keep the position's value? The per-move label. */
  kept: boolean;
  chosen: string;
}

export interface Trajectory {
  game: string;
  seed: number;
  plies: number;
  doubt: number;
  swing: number;
  alternation: number;
  tension: number;
  /** The solver's view of the same game, for comparison. */
  criticality: number;
  /** Share of moves that preserved the value. */
  accuracy: number;
}

export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * How often a series crosses its own median, as a share of the chances.
 *
 * Values exactly on the median are dropped rather than assigned a side: on
 * these games a long run of identical confidences is common, and counting
 * each of them as a non-crossing would drive the number toward zero for
 * reasons that have nothing to do with the game.
 */
export function alternation(xs: readonly number[]): number {
  const m = median(xs);
  const sides = xs.filter((x) => x !== m).map((x) => x > m);
  if (sides.length < 2) return 0;
  let crossings = 0;
  for (let i = 1; i < sides.length; i += 1) if (sides[i] !== sides[i - 1]) crossings += 1;
  return crossings / (sides.length - 1);
}

/**
 * Consecutive moves BY THE SAME PLAYER.
 *
 * The standing score is from the point of view of whoever is to move, so the
 * difference between ply n and ply n+1 is mostly the change of viewpoint.
 * Comparing a player with themselves two plies later is the only way the
 * number means "the position changed" rather than "it is the other side's
 * turn now".
 */
export function swingOf(rows: readonly MoveRow[], which: "standing" | "standingFine" = "standing"): number {
  const deltas: number[] = [];
  for (const player of [0, 1]) {
    const mine = rows.filter((r) => r.player === player && r[which] !== undefined);
    for (let i = 1; i < mine.length; i += 1) {
      deltas.push(Math.abs((mine[i][which] as number) - (mine[i - 1][which] as number)));
    }
  }
  return deltas.length === 0 ? 0 : mean(deltas);
}

/**
 * `swing` on the nine-level scale, rescaled onto the five-level one.
 *
 * A nine-level scale spans 0..8 and a five-level scale 0..4, so the same
 * position change reads twice as large on the finer one BEFORE any judgment
 * is involved. Comparing the raw numbers would answer "is 8 bigger than 4",
 * which needs no requests. Dividing by 2 puts them on the same footing, and
 * what is left to compare is the RANKING -- which is what docs/35 §1 reports
 * and what homework (c) asks about.
 */
export function swingFineRescaled(rows: readonly MoveRow[]): number {
  return swingOf(rows, "standingFine") / 2;
}

export function trajectoryOf(rows: readonly MoveRow[]): Trajectory {
  const doubts = rows.map((r) => 1 - r.confidence);
  const doubt = mean(doubts);
  const swing = swingOf(rows);
  const alt = alternation(doubts);
  return {
    game: rows[0].game,
    seed: rows[0].seed,
    plies: rows.length,
    doubt,
    swing,
    alternation: alt,
    tension: doubt * swing * (0.5 + 0.5 * alt),
    criticality: mean(rows.map((r) => r.criticality)),
    accuracy: rows.filter((r) => r.kept).length / rows.length,
  };
}

/**
 * Spearman's rank correlation.
 *
 * Rank rather than Pearson because the claim is about ORDER -- does the
 * measure rank the games the way the solver does -- and because five games
 * is far too few for a linear fit to mean anything.
 */
export function spearman(pairs: readonly { a: number; b: number }[]): number {
  if (pairs.length < 3) return Number.NaN;
  const rank = (xs: readonly number[]): number[] => {
    const order = xs.map((x, i) => ({ x, i })).sort((p, q) => p.x - q.x);
    const out = new Array<number>(xs.length);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && order[j + 1].x === order[i].x) j += 1;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) out[order[k].i] = avg;
      i = j + 1;
    }
    return out;
  };
  const ra = rank(pairs.map((p) => p.a));
  const rb = rank(pairs.map((p) => p.b));
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i += 1) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da === 0 || db === 0 ? Number.NaN : num / Math.sqrt(da * db);
}
