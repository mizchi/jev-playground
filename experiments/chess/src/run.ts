/**
 * Jev vs Claude Sonnet 5 at chess, both handed the same legal move list.
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/run.ts [--plies 60] [--white jev] [--black sonnet] [--verbose]
 *   npx tsx src/run.ts --white jev --black greedy     # no CLI calls, quick
 *
 * A chess position has at most 218 legal moves, so the whole move list always
 * fits in one Jev `choice` question (the server caps a question at 255).
 */
import { Chess } from "chess.js";
import { Jev } from "../../shared/jev.js";
import {
  bestReplyGain,
  greedyPlayer,
  jevPlayer,
  material,
  sonnetPlayer,
  type Player,
} from "./players.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const PLIES = Number.parseInt(arg("plies", "60"), 10);
const VERBOSE = process.argv.includes("--verbose");
const WHITE = arg("white", "jev");
const BLACK = arg("black", "sonnet");
const GAMES = Number.parseInt(arg("games", "1"), 10);

interface Tally {
  illegal: number;
  blunders: number;
  moves: number;
  ms: number;
  forced: number;
}

function tally(): Tally {
  return { illegal: 0, blunders: 0, moves: 0, ms: 0, forced: 0 };
}

function makePlayer(kind: string, jev: Jev, trace?: (s: string) => void): Player {
  if (kind === "jev") return jevPlayer(jev, trace);
  if (kind === "sonnet") return sonnetPlayer("claude-sonnet-5", trace);
  if (kind === "greedy") return greedyPlayer();
  throw new Error(`unknown player '${kind}' (jev | sonnet | greedy)`);
}

interface GameOutcome {
  result: string;
  reason: string;
  plies: number;
  finalMaterialWhite: number;
}

async function playGame(
  white: Player,
  black: Player,
  tw: Tally,
  tb: Tally,
): Promise<GameOutcome> {
  const board = new Chess();
  const trace = VERBOSE ? (s: string) => console.log(s) : undefined;
  void trace;
  while (!board.isGameOver() && board.history().length < PLIES) {
    const mover = board.turn() === "w" ? white : black;
    const t = board.turn() === "w" ? tw : tb;
    // How much the opponent could already win before this move, so a blunder
    // is what the move newly gives away rather than a pre-existing problem.
    const exposureBefore = bestReplyGain(board);
    const res = await mover.pick(board);
    board.move(res.uci);
    t.moves += 1;
    t.illegal += res.illegal;
    t.ms += res.ms;
    if (res.note === "forced") t.forced += 1;
    const exposureAfter = bestReplyGain(board);
    if (exposureAfter >= 3 && exposureAfter > exposureBefore) t.blunders += 1;
  }
  let result = "*";
  let reason = "ply cap";
  if (board.isCheckmate()) {
    result = board.turn() === "w" ? "0-1" : "1-0";
    reason = "checkmate";
  } else if (board.isDraw()) {
    result = "1/2-1/2";
    reason = board.isStalemate() ? "stalemate" : "draw";
  } else {
    // Adjudicate on material when the cap is hit.
    const m = material(board, "w");
    if (m >= 2) {
      result = "1-0";
      reason = `material +${m} at ply cap`;
    } else if (m <= -2) {
      result = "0-1";
      reason = `material ${m} at ply cap`;
    } else {
      result = "1/2-1/2";
      reason = `level material at ply cap`;
    }
  }
  return {
    result,
    reason,
    plies: board.history().length,
    finalMaterialWhite: material(board, "w"),
  };
}

async function main() {
  const needsJev = WHITE === "jev" || BLACK === "jev";
  const jev = needsJev ? new Jev() : (null as unknown as Jev);
  const trace = VERBOSE ? (s: string) => console.log(s) : undefined;
  const white = makePlayer(WHITE, jev, trace);
  const black = makePlayer(BLACK, jev, trace);

  console.log("=".repeat(96));
  console.log(`  CHESS — white ${white.name} vs black ${black.name}, ${GAMES} game(s), ${PLIES}-ply cap`);
  console.log("=".repeat(96));
  console.log("");

  const tw = tally();
  const tb = tally();
  const results: GameOutcome[] = [];
  for (let g = 0; g < GAMES; g += 1) {
    if (VERBOSE) console.log(`--- game ${g + 1} ---`);
    const out = await playGame(white, black, tw, tb);
    results.push(out);
    console.log(`  game ${g + 1}: ${out.result} (${out.reason}) after ${out.plies} plies`);
  }

  const row = (label: string, p: Player, t: Tally) => {
    console.log(`  ${label.padEnd(7)} ${p.name.padEnd(22)} moves ${String(t.moves).padStart(3)}   ` +
      `illegal answers ${String(t.illegal).padStart(2)}   forced ${String(t.forced).padStart(2)}   ` +
      `blunders ${String(t.blunders).padStart(2)}   ${(t.ms / Math.max(t.moves, 1) / 1000).toFixed(1)} s/move`);
    console.log(`  ${"".padEnd(7)} ${"cost:".padEnd(22)} ${p.cost()}`);
  };
  console.log("");
  row("white", white, tw);
  row("black", black, tb);
  console.log("");
  console.log(
    `  A blunder here means the move newly let the opponent win 3+ material on the`,
  );
  console.log(`  very next move (1-ply check, not an engine evaluation).`);
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
