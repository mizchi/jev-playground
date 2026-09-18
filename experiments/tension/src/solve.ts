/**
 * The ground truth: every position solved exactly.
 *
 * `value(p)` is the result with both sides playing perfectly, from the point
 * of view of the player to move: +1 win, 0 draw, -1 loss. From that comes the
 * number the whole experiment rests on:
 *
 *   criticality = 1 - (moves that preserve the value) / (legal moves)
 *
 * 0 means every move is as good as every other and the choice is free. A
 * value near 1 means one move holds and the rest throw the position away.
 * This is a property of the POSITION and the rules, computed without asking
 * anything, which is what makes it usable as a label for what confidence is
 * supposed to be tracking.
 *
 * Negamax with a memo, no alpha-beta: these games are small enough that the
 * memo does the work, and a cut-off search cannot report how many moves are
 * optimal -- it stops as soon as it knows one is. The experiment needs the
 * count, so the search stays exhaustive.
 */
import { type Move, type Position, RULES } from "./games.js";

const memo = new Map<string, number>();

function memoKey(p: Position): string {
  return `${p.game}|${p.key}|${p.player}`;
}

/** The result under perfect play, for the player to move. */
export function value(p: Position): number {
  const key = memoKey(p);
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const rules = RULES[p.game];
  const done = rules.winner(p);
  if (done !== null) {
    const v = done === -1 ? 0 : done === p.player ? 1 : -1;
    memo.set(key, v);
    return v;
  }
  const moves = rules.moves(p);
  if (moves.length === 0) {
    // No legal move and no declared winner: the rules and the solver
    // disagree, and guessing a value here would hide it.
    throw new Error(`${p.game} ${p.key}: no moves and no winner`);
  }
  let best = -1;
  for (const m of moves) {
    // The child's value is from the OTHER player's view, so negate it.
    const v = -value(rules.apply(p, m.name));
    if (v > best) best = v;
    if (best === 1) break;
  }
  // The early exit above is safe for the value but not for the optimal-move
  // count, which is why `optimal` re-walks every move instead of reusing it.
  memo.set(key, best);
  return best;
}

export interface Analysis {
  value: number;
  legal: number;
  /** Moves whose resulting position keeps the value the same. */
  optimal: number;
  /** 1 - optimal/legal: zero when the choice is free. */
  criticality: number;
  /** Which move names are optimal, for scoring what was actually played. */
  best: string[];
}

export function analyse(p: Position): Analysis {
  const rules = RULES[p.game];
  const moves = rules.moves(p);
  const v = value(p);
  const best: string[] = [];
  for (const m of moves) {
    if (-value(rules.apply(p, m.name)) === v) best.push(m.name);
  }
  return {
    value: v,
    legal: moves.length,
    optimal: best.length,
    criticality: moves.length === 0 ? 0 : 1 - best.length / moves.length,
    best,
  };
}

/** Did this move keep the position's value? The per-move label. */
export function kept(p: Position, move: string): boolean {
  return analyse(p).best.includes(move);
}

/**
 * A perfect player, for the games that need an opponent who cannot blunder.
 *
 * Ties are broken by the move's position in the rules' own enumeration, so
 * the same position always gets the same move and a game against it replays.
 */
export function perfectMove(p: Position): Move {
  const rules = RULES[p.game];
  const moves = rules.moves(p);
  const best = analyse(p).best;
  return moves.find((m) => best.includes(m.name)) ?? moves[0];
}

export function clearMemo(): void {
  memo.clear();
}

export function memoSize(): number {
  return memo.size;
}
