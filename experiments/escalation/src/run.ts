/**
 * Confidence-gated escalation (docs/06 proposal A, written up as docs/07).
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/run.ts --domain chess [--games 4] [--plies 30]
 *   TYPESAFEAI_API_KEY=... npx tsx src/run.ts --domain shell
 *
 * Two questions, in order, because the second only matters if the first
 * answers yes:
 *
 *   Q1  Does low confidence actually predict a worse decision?
 *   Q2  What does the cost/quality curve look like as the gate moves?
 */
import { Jev } from "../../shared/jev.js";
import * as chess from "./chess.js";
import * as shell from "./shell.js";
import { headToHead } from "./headtohead.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const DOMAIN = arg("domain", "chess");
const GAMES = Number.parseInt(arg("games", "4"), 10);
const PLIES = Number.parseInt(arg("plies", "30"), 10);
const DEPTH = Number.parseInt(arg("depth", "3"), 10);
const TIER2_MODEL = arg("tier2-model", "claude-sonnet-5");
/** Input tokens per Jev call, for the cost column. */
const JEV_COST_PER_CALL = (1400 / 1e6) * 0.042;

function bar(value: number, max: number, width = 24): string {
  if (max <= 0) return "";
  const n = Math.round((value / max) * width);
  return "#".repeat(Math.max(0, n));
}

async function runChess() {
  const jev = new Jev();
  console.log("=".repeat(100));
  console.log(`  ESCALATION / CHESS — tier 1 Jev, tier 2 alpha-beta depth ${DEPTH}`);
  console.log(`  ${GAMES} games x ${PLIES} plies; quality = centipawns worse than the search's best`);
  console.log("=".repeat(100));
  // Validity first: escalating to a weaker decider would prove nothing.
  console.log("");
  console.log("  Q0  is tier 2 actually stronger than tier 1? (head to head, no shared yardstick)");
  for (const line of await headToHead(jev, { plies: PLIES, depth: DEPTH })) console.log(line);
  console.log("");
  const { writeFileSync, mkdirSync, existsSync, readFileSync } = await import("node:fs");
  mkdirSync("out", { recursive: true });
  const CACHE = "out/chess-positions.json";
  // Resume from whatever a previous run managed to save.
  const seed: chess.ChessRow[] =
    process.argv.includes("--resume") && existsSync(CACHE)
      ? (JSON.parse(readFileSync(CACHE, "utf8")) as chess.ChessRow[])
      : [];
  if (seed.length > 0) console.log(`  resuming with ${seed.length} positions already collected`);
  process.stdout.write("  collecting positions ");
  const rows = await chess.collect(jev, {
    games: GAMES,
    plies: PLIES,
    depth: DEPTH,
    seed,
    onRow: () => process.stdout.write("."),
    checkpoint: (r) => writeFileSync(CACHE, JSON.stringify(r, null, 2)),
  });
  console.log(` ${rows.length} positions`);

  console.log("");
  console.log("  Q1  does low confidence predict a worse move?");
  console.log("");
  console.log(`      ${"confidence".padEnd(12)} ${"n".padStart(4)} ${"mean cp loss".padStart(13)} ${"agrees".padStart(7)} ${"loss>=100".padStart(10)}`);
  const bs = chess.buckets(rows);
  const maxMean = Math.max(...bs.map((b) => b.meanLoss));
  for (const b of bs) {
    if (b.n === 0) {
      console.log(`      ${b.label.padEnd(12)} ${String(b.n).padStart(4)}            -`);
      continue;
    }
    console.log(
      `      ${b.label.padEnd(12)} ${String(b.n).padStart(4)} ${b.meanLoss.toFixed(0).padStart(13)} ` +
        `${`${b.agree}/${b.n}`.padStart(7)} ${`${b.bad}/${b.n}`.padStart(10)}  ${bar(b.meanLoss, maxMean)}`,
    );
  }

  console.log("");
  console.log("  Q2  cost/quality curve (escalated positions take the search's move)");
  console.log("");
  console.log(`      ${"gate".padStart(5)} ${"escalated".padStart(11)} ${"mean cp loss".padStart(13)} ${"bad left".padStart(9)} ${"ms/decision".padStart(12)}`);
  const sw = chess.sweep(rows);
  const baseLoss = sw[0].meanLoss;
  for (const s of sw) {
    const label = s.threshold > 1 ? "always" : s.threshold.toFixed(2);
    const delta = baseLoss > 0 ? `${((1 - s.meanLoss / baseLoss) * 100).toFixed(0)}% better` : "";
    console.log(
      `      ${label.padStart(5)} ${`${s.escalated}/${rows.length} (${(s.rate * 100).toFixed(0)}%)`.padStart(11)} ` +
        `${s.meanLoss.toFixed(0).padStart(13)} ${String(s.badMoves).padStart(9)} ${s.meanMs.toFixed(0).padStart(12)}   ${delta}`,
    );
  }

  console.log("");
  const agree = rows.filter((r) => r.jevMove === r.searchMove).length;
  console.log(`  Jev agreed with the search on ${agree}/${rows.length} positions.`);
  console.log(
    `  cost: ${jev.calls} Jev requests, ${jev.inputTokens} input tokens, ` +
      `$${((jev.inputTokens / 1e6) * 0.042).toFixed(4)}; ` +
      `search ${(rows.reduce((a, r) => a + r.searchMs, 0) / rows.length).toFixed(0)} ms/position and free.`,
  );
  console.log("");
  writeFileSync(CACHE, JSON.stringify(rows, null, 2));
  console.log(`  per-position data written to ${CACHE}`);
  if (jev.retriedCalls > 0) console.log(`  (${jev.retriedCalls} Jev calls needed a retry)`);
  console.log("");
}

async function runShell() {
  const jev = new Jev();
  console.log("=".repeat(100));
  console.log(`  ESCALATION / SHELL — tier 1 Jev score+threshold, tier 2 ${TIER2_MODEL}`);
  console.log(`  ${shell.CORPUS.length} labelled commands from docs/01 (hand-written tier 1 alone: 23/24)`);
  console.log("=".repeat(100));
  process.stdout.write("  collecting ");
  const rows = await shell.collect(jev, TIER2_MODEL, () => process.stdout.write("."));
  console.log(` ${rows.length} commands`);

  const t1 = rows.filter((r) => r.tier1 === r.expect).length;
  const t2 = rows.filter((r) => r.tier2 === r.expect).length;
  console.log("");
  console.log(`  tier 1 alone (Jev):        ${t1}/${rows.length}`);
  console.log(`  tier 2 alone (${TIER2_MODEL}): ${t2}/${rows.length}`);

  console.log("");
  console.log("  Q1  does low confidence predict a wrong verdict?");
  console.log("");
  console.log(`      ${"confidence".padEnd(12)} ${"n".padStart(4)} ${"tier1 right".padStart(12)} ${"tier2 right".padStart(12)}`);
  for (const b of shell.buckets(rows)) {
    if (b.n === 0) {
      console.log(`      ${b.label.padEnd(12)} ${String(b.n).padStart(4)}            -`);
      continue;
    }
    console.log(
      `      ${b.label.padEnd(12)} ${String(b.n).padStart(4)} ${`${b.t1ok}/${b.n}`.padStart(12)} ${`${b.t2ok}/${b.n}`.padStart(12)}`,
    );
  }

  console.log("");
  console.log("  Q2  cost/quality curve");
  console.log("");
  console.log(`      ${"gate".padStart(6)} ${"escalated".padStart(11)} ${"correct".padStart(8)} ${"ms/decision".padStart(12)}`);
  for (const s of shell.sweep(rows, JEV_COST_PER_CALL)) {
    const label = s.threshold > 1 ? "always" : s.threshold.toFixed(2);
    console.log(
      `      ${label.padStart(6)} ${`${s.escalated}/${rows.length} (${(s.rate * 100).toFixed(0)}%)`.padStart(11)} ` +
        `${`${s.correct}/${rows.length}`.padStart(8)} ${s.meanMs.toFixed(0).padStart(12)}`,
    );
  }

  console.log("");
  console.log("  where the two tiers disagree:");
  for (const r of rows) {
    if (r.tier1 === r.tier2) continue;
    const who = r.tier1 === r.expect ? "tier1 right" : r.tier2 === r.expect ? "tier2 right" : "both wrong";
    console.log(
      `      conf ${r.confidence.toFixed(2)}  ${r.command.slice(0, 42).padEnd(44)} ` +
        `want ${r.expect.padEnd(7)} t1 ${r.tier1.padEnd(7)} t2 ${r.tier2.padEnd(7)} ${who}`,
    );
  }
  console.log("");
  console.log(
    `  cost: ${jev.calls} Jev requests ($${((jev.inputTokens / 1e6) * 0.042).toFixed(4)}), ` +
      `tier 2 mean ${(rows.reduce((a, r) => a + r.tier2Ms, 0) / rows.length / 1000).toFixed(1)} s/call ` +
      `vs tier 1 ${(rows.reduce((a, r) => a + r.tier1Ms, 0) / rows.length).toFixed(0)} ms/call.`,
  );
  console.log("");
}

async function main() {
  if (DOMAIN === "chess" || DOMAIN === "both") await runChess();
  if (DOMAIN === "shell" || DOMAIN === "both") await runShell();
  if (!["chess", "shell", "both"].includes(DOMAIN)) {
    console.error(`unknown domain '${DOMAIN}' (chess | shell | both)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
