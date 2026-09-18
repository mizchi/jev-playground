/**
 * Domain 2: chess, where tier 2 is the alpha-beta search in ./search.ts.
 *
 * For every position Jev decides, three things get recorded: the move it
 * chose, its confidence, and how much worse that move is than the search's
 * best in centipawns. That makes Q1 directly answerable — group by
 * confidence, look at the mean loss — and lets the Q2 curve be computed
 * offline, since escalating a position means taking the search's move and
 * therefore zero loss on it.
 */
import { Chess, type Move } from "chess.js";
import { Jev, choice, type Question } from "../../shared/jev.js";
import { analyse } from "./search.js";

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** The most material the side to move can win with one capture, net of recapture. */
function bestReplyGain(board: Chess): number {
  let best = 0;
  for (const m of board.moves({ verbose: true }) as Move[]) {
    if (!m.captured) continue;
    const gain = PIECE_VALUE[m.captured] ?? 0;
    board.move(m);
    const recapture = (board.moves({ verbose: true }) as Move[])
      .filter((r) => r.to === m.to && r.captured)
      .map((r) => PIECE_VALUE[r.captured!] ?? 0)
      .reduce((a, b) => Math.max(a, b), 0);
    board.undo();
    const net = gain - recapture;
    if (net > best) best = net;
  }
  return best;
}

function describeMove(board: Chess, m: Move): string {
  const parts: string[] = [m.san];
  if (m.captured) parts.push(`captures ${m.captured.toUpperCase()} (+${PIECE_VALUE[m.captured]})`);
  if (m.promotion) parts.push(`promotes to ${m.promotion.toUpperCase()}`);
  board.move(m);
  if (board.isCheckmate()) parts.push("CHECKMATE");
  else if (board.isCheck()) parts.push("gives check");
  const exposure = bestReplyGain(board);
  board.undo();
  if (exposure > 0) parts.push(`lets the opponent win ${exposure}`);
  return parts.join("; ");
}

/** One Jev decision on a position, plus what it cost in quality. */
export interface ChessRow {
  fen: string;
  ply: number;
  legal: number;
  jevMove: string;
  confidence: number;
  searchMove: string;
  /** Centipawns worse than the search's best. 0 when they agree. */
  loss: number;
  jevMs: number;
  searchMs: number;
}

async function jevMove(
  jev: Jev,
  board: Chess,
): Promise<{ uci: string; confidence: number; ms: number }> {
  const legal = board.moves({ verbose: true }) as Move[];
  const criteria: Record<string, string> = {};
  for (const m of legal) criteria[m.lan] = describeMove(board, m);
  const questions: Record<string, Question> = {
    move: {
      type: "choice",
      instructions:
        "Which move is best? Prefer mate, then winning material safely, then improving your position. Do not leave a piece where the opponent wins it for free.",
      criteria,
    },
  };
  const state = {
    game: "chess",
    you_play: board.turn() === "w" ? "white" : "black",
    fen: board.fen(),
    move_number: board.moveNumber(),
    ascii: board.ascii(),
    in_check: board.isCheck(),
    opponent_can_win_now: bestReplyGain(board),
    history_san: board.history().slice(-8),
  };
  const t0 = Date.now();
  const res = await jev.ask(state, questions);
  const ms = Date.now() - t0;
  const picked = choice(res.answers.move);
  const legalSet = new Set(legal.map((m) => m.lan));
  return {
    uci: legalSet.has(picked.choice) ? picked.choice : legal[0].lan,
    confidence: picked.confidence,
    ms,
  };
}

/**
 * Collect positions by letting Jev play both sides against the search's
 * opponent-of-record. Jev's move is the one played, so the trajectory is the
 * one a tier-1-only system would actually walk — which is the right
 * distribution of positions to measure the gate on.
 */
export async function collect(
  jev: Jev,
  opts: {
    games: number;
    plies: number;
    depth: number;
    onRow?: (r: ChessRow) => void;
    /** Called after every row so a crash keeps the positions already paid for. */
    checkpoint?: (rows: ChessRow[]) => void;
    /** Resume: positions already collected, kept and extended. */
    seed?: ChessRow[];
  },
): Promise<ChessRow[]> {
  const rows: ChessRow[] = [...(opts.seed ?? [])];
  // Each position costs a Jev call and a full search, so a transient API
  // failure two thirds of the way through must not throw the lot away.
  for (let g = 0; g < opts.games; g += 1) {
    const board = new Chess();
    // A different opening move per game, so the positions are not all the
    // same game replayed.
    const openings = ["e2e4", "d2d4", "g1f3", "c2c4"];
    if (g > 0) board.move(openings[g % openings.length]);
    while (!board.isGameOver() && board.history().length < opts.plies) {
      let jm: { uci: string; confidence: number; ms: number };
      try {
        jm = await jevMove(jev, board);
      } catch (err) {
        // The client already retried. Give up on this game, keep the rest.
        opts.onRow?.({ ...rows[rows.length - 1], jevMove: "ABORTED" } as ChessRow);
        console.warn(`\n  game ${g + 1} stopped at ply ${board.history().length}: ${String(err).slice(0, 120)}`);
        break;
      }
      // One search per position gives both the best move and Jev's loss.
      const an = analyse(board, jm.uci, opts.depth);
      const row: ChessRow = {
        fen: board.fen(),
        ply: board.history().length,
        legal: board.moves().length,
        jevMove: jm.uci,
        confidence: jm.confidence,
        searchMove: an.bestUci,
        loss: Number.isFinite(an.loss) ? an.loss : 0,
        jevMs: jm.ms,
        searchMs: an.ms,
      };
      rows.push(row);
      opts.onRow?.(row);
      opts.checkpoint?.(rows);
      board.move(jm.uci);
    }
  }
  return rows;
}

/** Q1: does low confidence predict a worse move? */
export function buckets(rows: ChessRow[], edges = [0.2, 0.4, 0.6, 0.8]) {
  const lo = [0, ...edges];
  const hi = [...edges, 1.01];
  return lo.map((l, i) => {
    const inB = rows.filter((r) => r.confidence >= l && r.confidence < hi[i]);
    const losses = inB.map((r) => r.loss);
    const mean = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
    const agree = inB.filter((r) => r.jevMove === r.searchMove).length;
    const bad = inB.filter((r) => r.loss >= 100).length;
    return {
      label: `${l.toFixed(2)}-${Math.min(hi[i], 1).toFixed(2)}`,
      n: inB.length,
      meanLoss: mean,
      agree,
      bad,
    };
  });
}

/**
 * Q2: the curve. Escalating a position means playing the search's move, so
 * its loss becomes zero. Computed offline over the collected positions.
 *
 * This is a per-position measure: it does not model how escalating early
 * changes which positions come later. Real games at selected thresholds are
 * the check on that.
 */
export function sweep(rows: ChessRow[]) {
  const thresholds = [0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01];
  const totalAll = rows.reduce((a, r) => a + r.loss, 0);
  return thresholds.map((t) => {
    const escalated = rows.filter((r) => r.confidence < t);
    const kept = rows.filter((r) => r.confidence >= t);
    const totalLoss = kept.reduce((a, r) => a + r.loss, 0);
    const searchMs = escalated.reduce((a, r) => a + r.searchMs, 0);
    const jevMs = rows.reduce((a, r) => a + r.jevMs, 0);
    const rate = escalated.length / rows.length;
    // The control the whole claim rests on. Escalating ANY subset of this
    // size removes some loss, so the gate is only worth something if it
    // beats picking that many positions at random — where the expected
    // remaining loss is just (1 - rate) of the total.
    const randomMeanLoss = (totalAll * (1 - rate)) / rows.length;
    return {
      threshold: t,
      escalated: escalated.length,
      rate,
      meanLoss: totalLoss / rows.length,
      randomMeanLoss,
      badMoves: kept.filter((r) => r.loss >= 100).length,
      meanMs: (jevMs + searchMs) / rows.length,
    };
  });
}
