/**
 * Turn out/chess-positions.json into the markdown tables docs/07 quotes, so
 * the numbers in the report are generated rather than retyped.
 *
 *   npx tsx src/summarise.ts [--bins 0.2,0.4,0.6,0.8]
 */
import { readFileSync } from "node:fs";
import { buckets, sweep, type ChessRow } from "./chess.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const rows = JSON.parse(readFileSync("out/chess-positions.json", "utf8")) as ChessRow[];
const edges = arg("bins", "0.2,0.4,0.6,0.8").split(",").map(Number);

/** Spearman rank correlation between confidence and loss. */
function spearman(xs: number[], ys: number[]): number {
  const rank = (v: number[]) => {
    const order = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array(v.length).fill(0);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) r[order[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

const conf = rows.map((r) => r.confidence);
const loss = rows.map((r) => r.loss);
const rho = spearman(conf, loss);
const medianLoss = [...loss].sort((a, b) => a - b)[Math.floor(loss.length / 2)];

console.log(`positions: ${rows.length}`);
console.log(`agreement with the search: ${rows.filter((r) => r.jevMove === r.searchMove).length}/${rows.length}`);
console.log(`mean cp loss: ${(loss.reduce((a, b) => a + b, 0) / rows.length).toFixed(0)}   median: ${medianLoss}`);
console.log(`Spearman rho(confidence, cp loss) = ${rho.toFixed(3)}  (negative = low confidence predicts a worse move)`);
console.log("");

console.log("| confidence | n | mean cp loss | agrees with search | loss >= 100 |");
console.log("| --- | --- | --- | --- | --- |");
for (const b of buckets(rows, edges)) {
  if (b.n === 0) continue;
  console.log(`| ${b.label} | ${b.n} | ${b.meanLoss.toFixed(0)} | ${b.agree}/${b.n} | ${b.bad}/${b.n} |`);
}
console.log("");

console.log("| gate | escalated | mean cp loss | same budget, random | bad moves left | ms/decision |");
console.log("| --- | --- | --- | --- | --- | --- |");
for (const s of sweep(rows)) {
  const label = s.threshold > 1 ? "always" : s.threshold.toFixed(2);
  console.log(
    `| ${label} | ${s.escalated}/${rows.length} (${(s.rate * 100).toFixed(0)}%) | ` +
      `**${s.meanLoss.toFixed(0)}** | ${s.randomMeanLoss.toFixed(0)} | ${s.badMoves} | ${s.meanMs.toFixed(0)} |`,
  );
}
console.log("");

// The cases worth eyeballing: confident and wrong, and unconfident but right.
const confidentlyWrong = rows.filter((r) => r.confidence >= 0.6 && r.loss >= 100);
const unconfidentlyRight = rows.filter((r) => r.confidence < 0.3 && r.loss === 0);
console.log(`confident (>=0.60) but lost >=100cp: ${confidentlyWrong.length}`);
for (const r of confidentlyWrong.slice(0, 6)) {
  console.log(`  conf ${r.confidence.toFixed(2)} ply ${r.ply} played ${r.jevMove} search wanted ${r.searchMove} loss ${r.loss}`);
}
console.log(`unconfident (<0.30) but matched the search: ${unconfidentlyRight.length}`);
