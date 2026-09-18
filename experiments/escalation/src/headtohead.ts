/**
 * Validity check: is tier 2 actually stronger than tier 1?
 *
 * The centipawn-loss metric in chess.ts is scored by the search's own
 * evaluation, so the search wins that comparison by construction. If
 * escalation is to mean anything, the search has to beat Jev over the board,
 * where no shared yardstick is involved.
 */
import { Chess, type Move } from "chess.js";
import { Jev, choice, type Question } from "../../shared/jev.js";
import { search } from "./search.js";

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function material(board: Chess, colour: "w" | "b"): number {
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

async function jevPick(jev: Jev, board: Chess): Promise<string> {
  const legal = board.moves({ verbose: true }) as Move[];
  const criteria: Record<string, string> = {};
  for (const m of legal) {
    const parts = [m.san];
    if (m.captured) parts.push(`captures ${m.captured.toUpperCase()}`);
    board.move(m);
    if (board.isCheckmate()) parts.push("CHECKMATE");
    else if (board.isCheck()) parts.push("gives check");
    board.undo();
    criteria[m.lan] = parts.join("; ");
  }
  const questions: Record<string, Question> = {
    move: {
      type: "choice",
      instructions:
        "Which move is best? Prefer mate, then winning material safely, then improving your position.",
      criteria,
    },
  };
  const res = await jev.ask(
    {
      game: "chess",
      you_play: board.turn() === "w" ? "white" : "black",
      fen: board.fen(),
      ascii: board.ascii(),
      in_check: board.isCheck(),
      history_san: board.history().slice(-8),
    },
    questions,
  );
  const picked = choice(res.answers.move);
  const legalSet = new Set(legal.map((m) => m.lan));
  return legalSet.has(picked.choice) ? picked.choice : legal[0].lan;
}

export async function headToHead(
  jev: Jev,
  opts: { plies: number; depth: number },
): Promise<string[]> {
  const lines: string[] = [];
  for (const jevIsWhite of [true, false]) {
    const board = new Chess();
    while (!board.isGameOver() && board.history().length < opts.plies) {
      const jevTurn = (board.turn() === "w") === jevIsWhite;
      const uci = jevTurn ? await jevPick(jev, board) : search(board, opts.depth).uci;
      if (!uci) break;
      board.move(uci);
    }
    const jevColour = jevIsWhite ? "w" : "b";
    const m = material(board, jevColour);
    let verdict: string;
    if (board.isCheckmate()) {
      verdict = (board.turn() === jevColour) ? "search wins (mate)" : "jev wins (mate)";
    } else if (board.isDraw()) {
      verdict = "draw";
    } else {
      verdict = m >= 2 ? `jev ahead ${m}` : m <= -2 ? `search ahead ${-m}` : "level";
    }
    lines.push(
      `      jev as ${jevIsWhite ? "white" : "black"}: ${verdict} after ${board.history().length} plies`,
    );
  }
  return lines;
}
