/** Does the tier-2 search actually find obvious things? Run before trusting it. */
import { Chess } from "chess.js";
import { analyse, search } from "./search.js";

const cases: [string, string][] = [
  ["start position", new Chess().fen()],
  ["mate in 1 (a1a8)", "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1"],
  ["free queen on h4", "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3"],
  ["must answer Re2", "4k3/8/8/8/8/8/4r3/4K3 w - - 0 1"],
];
for (const [name, fen] of cases) {
  const r = search(new Chess(fen), 3);
  console.log(`${name.padEnd(20)} best=${r.uci} cp=${String(r.cp).padStart(7)} nodes=${String(r.nodes).padStart(6)} ${r.ms}ms`);
}
const b = new Chess("6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1");
console.log("loss(best move) =", analyse(b, search(b, 3).uci, 3).loss);
console.log("loss(g1h1 shuffle) =", analyse(b, "g1h1", 3).loss);
