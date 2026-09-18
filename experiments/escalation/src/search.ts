/**
 * The tier-2 decider for chess: a small alpha-beta search.
 *
 * Deliberately not an API call. It is free, deterministic, and it doubles as
 * the measuring stick — the gap between Jev's move and the search's best move,
 * in centipawns of the search's own evaluation, is what "a worse decision"
 * means in this domain.
 *
 * Honest limit: this is a shallow engine of my own, not Stockfield-grade. It
 * is consistent and objective, which is what the comparison needs, but a
 * centipawn number from it is a proxy, not ground truth.
 */
import { Chess, type Move } from "chess.js";

const VALUE: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

/**
 * Piece-square tables, the "simplified evaluation" from the Chess
 * Programming Wiki. Written from white's point of view, rank 8 first, so they
 * line up with `board.board()`.
 *
 * These replaced a centre-bonus-plus-pawn-advance scheme that turned out to
 * be degenerate: with no mobility term, advancing any pawn was the cheapest
 * way to gain, and the engine opened a2a4 every game. A tier-2 decider that
 * plays badly makes the whole escalation question meaningless, so it is worth
 * the table.
 */
const PST: Record<string, number[][]> = {
  p: [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [50, 50, 50, 50, 50, 50, 50, 50],
    [10, 10, 20, 30, 30, 20, 10, 10],
    [5, 5, 10, 25, 25, 10, 5, 5],
    [0, 0, 0, 20, 20, 0, 0, 0],
    [5, -5, -10, 0, 0, -10, -5, 5],
    [5, 10, 10, -20, -20, 10, 10, 5],
    [0, 0, 0, 0, 0, 0, 0, 0],
  ],
  n: [
    [-50, -40, -30, -30, -30, -30, -40, -50],
    [-40, -20, 0, 0, 0, 0, -20, -40],
    [-30, 0, 10, 15, 15, 10, 0, -30],
    [-30, 5, 15, 20, 20, 15, 5, -30],
    [-30, 0, 15, 20, 20, 15, 0, -30],
    [-30, 5, 10, 15, 15, 10, 5, -30],
    [-40, -20, 0, 5, 5, 0, -20, -40],
    [-50, -40, -30, -30, -30, -30, -40, -50],
  ],
  b: [
    [-20, -10, -10, -10, -10, -10, -10, -20],
    [-10, 0, 0, 0, 0, 0, 0, -10],
    [-10, 0, 5, 10, 10, 5, 0, -10],
    [-10, 5, 5, 10, 10, 5, 5, -10],
    [-10, 0, 10, 10, 10, 10, 0, -10],
    [-10, 10, 10, 10, 10, 10, 10, -10],
    [-10, 5, 0, 0, 0, 0, 5, -10],
    [-20, -10, -10, -10, -10, -10, -10, -20],
  ],
  r: [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [5, 10, 10, 10, 10, 10, 10, 5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [0, 0, 0, 5, 5, 0, 0, 0],
  ],
  q: [
    [-20, -10, -10, -5, -5, -10, -10, -20],
    [-10, 0, 0, 0, 0, 0, 0, -10],
    [-10, 0, 5, 5, 5, 5, 0, -10],
    [-5, 0, 5, 5, 5, 5, 0, -5],
    [0, 0, 5, 5, 5, 5, 0, -5],
    [-10, 5, 5, 5, 5, 5, 0, -10],
    [-10, 0, 5, 0, 0, 0, 0, -10],
    [-20, -10, -10, -5, -5, -10, -10, -20],
  ],
  k: [
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-20, -30, -30, -40, -40, -30, -30, -20],
    [-10, -20, -20, -20, -20, -20, -20, -10],
    [20, 20, 0, 0, 0, 0, 20, 20],
    [20, 30, 10, 0, 0, 10, 30, 20],
  ],
};

/**
 * Evaluation in centipawns, from the side-to-move's point of view.
 *
 * Material, centralisation and pawn advancement only. A mobility term was the
 * obvious next addition and got taken out again: it needs a full move
 * generation at every leaf, which made collecting positions about ten times
 * slower for a term a 3-ply search does not really need.
 */
export function evaluate(board: Chess): number {
  if (board.isCheckmate()) return -100000;
  if (board.isDraw()) return 0;
  const me = board.turn();
  let cp = 0;
  const rows = board.board();
  for (let r = 0; r < 8; r += 1) {
    for (let f = 0; f < 8; f += 1) {
      const sq = rows[r][f];
      if (!sq) continue;
      const sign = sq.color === me ? 1 : -1;
      cp += sign * (VALUE[sq.type] ?? 0);
      // The tables are written from white's side, so mirror the rank for
      // black.
      const table = PST[sq.type];
      if (table) cp += sign * table[sq.color === "w" ? r : 7 - r][f];
    }
  }
  return cp;
}

/** Captures and promotions first: most of alpha-beta's value is ordering. */
function ordered(board: Chess): Move[] {
  const moves = board.moves({ verbose: true }) as Move[];
  return moves.sort((a, b) => {
    const av = (a.captured ? VALUE[a.captured] : 0) + (a.promotion ? 800 : 0);
    const bv = (b.captured ? VALUE[b.captured] : 0) + (b.promotion ? 800 : 0);
    return bv - av;
  });
}

let nodes = 0;

function negamax(board: Chess, depth: number, alpha: number, beta: number): number {
  nodes += 1;
  if (board.isGameOver()) {
    if (board.isCheckmate()) return -100000 + (10 - depth);
    return 0;
  }
  if (depth === 0) return evaluate(board);
  let best = -Infinity;
  let a = alpha;
  for (const m of ordered(board)) {
    board.move(m);
    const value = -negamax(board, depth - 1, -beta, -a);
    board.undo();
    if (value > best) best = value;
    if (best > a) a = best;
    if (a >= beta) break;
  }
  return best;
}

export interface SearchResult {
  /** Best move in UCI long algebraic. */
  uci: string;
  /** Score of the best move, in centipawns for the side to move. */
  cp: number;
  nodes: number;
  ms: number;
}

export function search(board: Chess, depth = 3): SearchResult {
  const t0 = Date.now();
  nodes = 0;
  let bestMove = "";
  let best = -Infinity;
  const moves = ordered(board);
  // Checkmate or stalemate: there is nothing to choose. Callers check
  // `isGameOver()` first, but returning -Infinity from here would poison a
  // centipawn comparison, so say so explicitly.
  if (moves.length === 0) {
    return { uci: "", cp: board.isCheckmate() ? -100000 : 0, nodes: 0, ms: 0 };
  }
  for (const m of moves) {
    board.move(m);
    const value = -negamax(board, depth - 1, -Infinity, Infinity);
    board.undo();
    if (value > best) {
      best = value;
      bestMove = m.lan;
    }
  }
  return { uci: bestMove, cp: best, nodes, ms: Date.now() - t0 };
}

/**
 * One search that answers both questions at once: what the best move is, and
 * how much worse some candidate move is.
 *
 * Doing this as two calls to `search` doubled the cost of the whole
 * experiment for no reason — every legal move is already being scored here.
 */
export interface Analysis {
  bestUci: string;
  bestCp: number;
  /** Score of the candidate move, or NaN when it was not legal. */
  candidateCp: number;
  /** Centipawns worse than the best move. Always >= 0, or NaN. */
  loss: number;
  nodes: number;
  ms: number;
}

export function analyse(board: Chess, candidateUci: string, depth = 3): Analysis {
  const t0 = Date.now();
  nodes = 0;
  const moves = ordered(board);
  if (moves.length === 0) {
    return {
      bestUci: "",
      bestCp: board.isCheckmate() ? -100000 : 0,
      candidateCp: NaN,
      loss: NaN,
      nodes: 0,
      ms: 0,
    };
  }
  let bestUci = "";
  let bestCp = -Infinity;
  let candidateCp = Number.NaN;
  for (const m of moves) {
    board.move(m);
    const value = -negamax(board, depth - 1, -Infinity, Infinity);
    board.undo();
    if (m.lan === candidateUci) candidateCp = value;
    if (value > bestCp) {
      bestCp = value;
      bestUci = m.lan;
    }
  }
  const raw = bestCp - candidateCp;
  return {
    bestUci,
    bestCp,
    candidateCp,
    loss: Number.isFinite(raw) ? Math.max(0, raw) : Number.NaN,
    nodes,
    ms: Date.now() - t0,
  };
}
