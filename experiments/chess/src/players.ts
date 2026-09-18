/**
 * The players. All three get the same position and the same legal move list,
 * so the only thing under comparison is how a move gets picked out of it.
 *
 * The interesting asymmetry is structural. Jev is handed the legal moves AS
 * the choice criteria, so whatever comes back is legal. Sonnet is handed the
 * same list as text and has to name one, which it can get wrong — and the
 * rate at which it does is one of the measurements.
 */
import { Chess, type Move } from "chess.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Jev, choice, score, type Question } from "../../shared/jev.js";

const run = promisify(execFile);

export interface MoveResult {
  uci: string;
  /** Requests/attempts spent, including retries after an illegal answer. */
  attempts: number;
  /** Answers that named a move outside the legal list. */
  illegal: number;
  ms: number;
  note?: string;
}

export interface Player {
  readonly name: string;
  pick(board: Chess): Promise<MoveResult>;
  cost(): string;
}

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** Material from the side-to-move's point of view, in pawns. */
export function material(board: Chess, colour: "w" | "b"): number {
  let total = 0;
  for (const row of board.board()) {
    for (const sq of row) {
      if (!sq) continue;
      const v = PIECE_VALUE[sq.type] ?? 0;
      total += sq.color === colour ? v : -v;
    }
  }
  return total;
}

/** The most material the opponent can win with one capture, in pawns. */
export function bestReplyGain(board: Chess): number {
  const me = board.turn();
  let best = 0;
  for (const m of board.moves({ verbose: true }) as Move[]) {
    if (!m.captured) continue;
    const gain = PIECE_VALUE[m.captured] ?? 0;
    // Subtract what we lose if the square is defended — a 1-ply trade check,
    // not a search, which is all a blunder counter needs.
    board.move(m);
    const recapture = (board.moves({ verbose: true }) as Move[])
      .filter((r) => r.to === m.to && r.captured)
      .map((r) => PIECE_VALUE[r.captured!] ?? 0)
      .reduce((a, b) => Math.max(a, b), 0);
    board.undo();
    const net = gain - recapture;
    if (net > best) best = net;
  }
  void me;
  return best;
}

/**
 * A short note per move, so the model is not asked to re-derive what the
 * rules already tell us: what is captured, whether it checks, whether the
 * destination is defended.
 */
function describeMove(board: Chess, m: Move): string {
  const parts: string[] = [m.san];
  if (m.captured) parts.push(`captures ${m.captured.toUpperCase()} (+${PIECE_VALUE[m.captured]})`);
  if (m.promotion) parts.push(`promotes to ${m.promotion.toUpperCase()}`);
  board.move(m);
  if (board.isCheckmate()) parts.push("CHECKMATE");
  else if (board.isCheck()) parts.push("gives check");
  if (board.isStalemate()) parts.push("stalemate");
  // What the opponent can win right after this move.
  const exposure = bestReplyGain(board);
  board.undo();
  if (exposure >= 3) parts.push(`lets the opponent win ${exposure} material`);
  else if (exposure > 0) parts.push(`lets the opponent win ${exposure}`);
  return parts.join("; ");
}

/**
 * Jev: one request, a choice over the legal moves plus two reads that ride
 * along on a state that is already being sent.
 */
export function jevPlayer(jev: Jev, trace?: (s: string) => void): Player {
  return {
    name: `jev(${jev.model})`,
    async pick(board) {
      const legal = board.moves({ verbose: true }) as Move[];
      const criteria: Record<string, string> = {};
      for (const m of legal) criteria[m.lan] = describeMove(board, m);
      const colour = board.turn() === "w" ? "white" : "black";
      const state = {
        game: "chess",
        you_play: colour,
        fen: board.fen(),
        move_number: board.moveNumber(),
        ascii: board.ascii(),
        in_check: board.isCheck(),
        material_balance_for_you: material(board, board.turn()),
        opponent_can_win_now: bestReplyGain(board),
        history_san: board.history().slice(-8),
      };
      const questions: Record<string, Question> = {
        move: {
          type: "choice",
          instructions:
            "Which move is best? Prefer mate, then winning material safely, then improving your position. Do not leave a piece where the opponent wins it for free.",
          criteria,
        },
        // Ordered, so a score rather than a choice (docs/01).
        standing: {
          type: "score",
          instructions: "How is your position going?",
          criteria: ["Losing badly", "Slightly worse", "Equal", "Slightly better", "Winning"],
        },
      };
      const t0 = Date.now();
      const res = await jev.ask(state, questions);
      const ms = Date.now() - t0;
      const picked = choice(res.answers.move);
      const legalSet = new Set(legal.map((m) => m.lan));
      const ok = legalSet.has(picked.choice);
      const st = score(res.answers.standing);
      trace?.(
        `  jev ${colour} m${board.moveNumber()} -> ${picked.choice}@${picked.confidence.toFixed(2)} ` +
          `standing=${st.score.toFixed(2)}/4 (${legal.length} legal, ${ms}ms)`,
      );
      return {
        uci: ok ? picked.choice : legal[0].lan,
        attempts: 1,
        illegal: ok ? 0 : 1,
        ms,
      };
    },
    cost() {
      return (
        `${jev.calls} requests, ${jev.inputTokens} input tokens, ` +
        `${(jev.totalMs / Math.max(jev.calls, 1)).toFixed(0)} ms/move, ` +
        `$${((jev.inputTokens / 1e6) * 0.042).toFixed(4)}`
      );
    },
  };
}

/**
 * Claude Sonnet 5, driven through the `claude` CLI in headless mode. Gets the
 * same FEN, the same board and the same legal move list, and has to name one.
 * Up to three attempts, because naming an illegal move is a failure mode this
 * interface has and the choice interface does not.
 */
export function sonnetPlayer(model = "claude-sonnet-5", trace?: (s: string) => void): Player {
  let calls = 0;
  let totalMs = 0;
  let illegalTotal = 0;
  return {
    name: `claude(${model})`,
    async pick(board) {
      const legal = board.moves({ verbose: true }) as Move[];
      const legalList = legal.map((m) => `${m.lan} (${m.san})`).join(", ");
      const colour = board.turn() === "w" ? "white" : "black";
      const t0 = Date.now();
      let attempts = 0;
      let illegal = 0;
      let complaint = "";
      while (attempts < 3) {
        attempts += 1;
        const prompt =
          `You are playing chess as ${colour}. Position (FEN): ${board.fen()}\n\n` +
          `${board.ascii()}\n\n` +
          `Move ${board.moveNumber()}. ${board.isCheck() ? "You are in check.\n" : ""}` +
          `Legal moves: ${legalList}\n\n${complaint}` +
          `Reply with exactly one move in UCI long algebraic form (e.g. e2e4, g1f3, e7e8q) ` +
          `and nothing else. No explanation.`;
        let out = "";
        try {
          const res = await run("claude", ["-p", "--model", model, prompt], {
            maxBuffer: 1 << 22,
            timeout: 180_000,
          });
          out = res.stdout.trim();
        } catch (err) {
          complaint = "";
          continue;
        }
        calls += 1;
        // Take the last UCI-looking token: the model sometimes adds a word.
        const matches = out.match(/\b[a-h][1-8][a-h][1-8][qrbn]?\b/g);
        const guess = matches ? matches[matches.length - 1] : "";
        const legalSet = new Set(legal.map((m) => m.lan));
        if (guess && legalSet.has(guess)) {
          const ms = Date.now() - t0;
          totalMs += ms;
          illegalTotal += illegal;
          trace?.(
            `  ${model} ${colour} m${board.moveNumber()} -> ${guess} ` +
              `(${legal.length} legal, ${attempts} attempt(s), ${ms}ms)`,
          );
          return { uci: guess, attempts, illegal, ms };
        }
        illegal += 1;
        complaint = guess
          ? `Your previous answer "${guess}" is not in the legal move list. Pick one that is.\n`
          : `Your previous answer did not contain a UCI move. Reply with only the move.\n`;
      }
      // Out of attempts: take the first legal move so the game continues, and
      // record it.
      const ms = Date.now() - t0;
      totalMs += ms;
      illegalTotal += illegal;
      trace?.(`  ${model} ${colour} FAILED to name a legal move in 3 tries; forced ${legal[0].lan}`);
      return { uci: legal[0].lan, attempts, illegal, ms, note: "forced" };
    },
    cost() {
      return (
        `${calls} CLI calls, ${(totalMs / Math.max(calls, 1) / 1000).toFixed(1)} s/move, ` +
        `${illegalTotal} illegal answers`
      );
    },
  };
}

/** A cheap non-model baseline: take the best 1-ply material swing. */
export function greedyPlayer(seed = 1): Player {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    name: "greedy",
    async pick(board) {
      const legal = board.moves({ verbose: true }) as Move[];
      let best = legal[0];
      let bestScore = -Infinity;
      for (const m of legal) {
        board.move(m);
        const s = board.isCheckmate() ? 1000 : -material(board, board.turn()) - bestReplyGain(board) * 0.9;
        board.undo();
        const jitter = rnd() * 0.01;
        if (s + jitter > bestScore) {
          bestScore = s + jitter;
          best = m;
        }
      }
      return { uci: best.lan, attempts: 0, illegal: 0, ms: 0 };
    },
    cost() {
      return "free";
    },
  };
}
