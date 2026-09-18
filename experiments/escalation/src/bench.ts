/** How long does one position's analysis cost? Sets the experiment's budget. */
import { Chess } from "chess.js";
import { analyse } from "./search.js";

const positions: [string, string, string][] = [
  ["opening", new Chess().fen(), "e2e4"],
  [
    "middlegame",
    "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    "e1g1",
  ],
];
for (const [name, fen, cand] of positions) {
  for (const d of [2, 3]) {
    const b = new Chess(fen);
    const t0 = Date.now();
    const a = analyse(b, cand, d);
    console.log(
      `${name.padEnd(11)} depth ${d}: best=${a.bestUci} loss(${cand})=${a.loss} ` +
        `nodes=${String(a.nodes).padStart(6)} ${Date.now() - t0}ms`,
    );
  }
}
