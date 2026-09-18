/**
 * Jev against itself, five games, one request per move.
 *
 *   npx tsx src/run.ts --replay                   # tables, no API key
 *   TYPESAFEAI_API_KEY=... npx tsx src/run.ts --play
 *   TYPESAFEAI_API_KEY=... npx tsx src/run.ts --play --games nim,misere --repeat 3
 *
 * Both sides of every game are the same arm, so a trajectory is one
 * consistent reader's uncertainty over a whole game rather than a mixture of
 * two. The solver runs alongside and never enters a request: every
 * criticality number in the output was computed by exhaustive search, and
 * every confidence number came from an answer, and nothing crosses.
 *
 * The random control plays the same games with no requests at all. Its
 * criticality profile is what a game looks like when nobody is steering,
 * which is the difference between "this game is tense" and "these players
 * wandered into tense positions".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Jev } from "../../shared/jev.js";
import { GAMES, type GameName, RULES, seeded } from "./games.js";
import { analyse } from "./solve.js";
import { ARMS, ARM_BLURB, type ArmName, MOVE, STANDING, questionsFor, stateFor } from "./arms.js";
import { type MoveRow, type Trajectory, mean, spearman, trajectoryOf } from "./tension.js";

const RECORDS = resolve(import.meta.dirname, "../records");

export interface PlayRecord {
  model: string;
  rows: (MoveRow & { arm: string })[];
  /** Games played without any request, for the criticality control. */
  control: { game: string; seed: number; plies: number; criticality: number; accuracy: number }[];
  usage: { input: number; output: number; calls: number; ms: number };
}

function readRecord(): PlayRecord | null {
  const path = resolve(RECORDS, "play.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as PlayRecord) : null;
}

/**
 * One game, both sides played by the same arm.
 *
 * The solver is consulted BEFORE the move is chosen, so the criticality and
 * the optimal set describe the position that was actually asked about. Doing
 * it afterwards would describe the position that resulted, which is a
 * different question and an easy mistake to make silently.
 */
async function selfPlay(jev: Jev, arm: ArmName, game: GameName, seed: number): Promise<MoveRow[]> {
  const rules = RULES[game];
  let p = rules.start(seed);
  const history: string[] = [];
  const rows: MoveRow[] = [];
  for (let ply = 0; ply < 80; ply += 1) {
    if (rules.winner(p) !== null) break;
    const moves = rules.moves(p);
    if (moves.length === 0) break;
    const truth = analyse(p);
    const res = await jev.ask(stateFor(p, history), questionsFor(arm, moves));
    const move = res.answers[MOVE];
    const standing = res.answers[STANDING];
    if (move.type !== "choice" || standing.type !== "score") throw new Error("unexpected answer shapes");
    const chosen = moves.find((m) => m.name === move.choice);
    if (!chosen) throw new Error(`${game}: chose ${move.choice}, which is not legal here`);
    rows.push({
      game,
      seed,
      ply,
      player: p.player,
      confidence: move.confidence,
      standing: standing.score,
      criticality: truth.criticality,
      legal: truth.legal,
      optimal: truth.optimal,
      kept: truth.best.includes(chosen.name),
      chosen: chosen.name,
    });
    history.push(`${p.player === 0 ? "X" : "O"}: ${chosen.name}`);
    p = rules.apply(p, chosen.name);
  }
  return rows;
}

/** The same games with a uniform chooser. No requests. */
function controlGame(game: GameName, seed: number): { game: string; seed: number; plies: number; criticality: number; accuracy: number } {
  const rules = RULES[game];
  const rng = seeded(seed * 7919 + 13);
  let p = rules.start(seed);
  const crits: number[] = [];
  let kept = 0;
  let plies = 0;
  while (rules.winner(p) === null && plies < 80) {
    const moves = rules.moves(p);
    if (moves.length === 0) break;
    const truth = analyse(p);
    const move = moves[Math.floor(rng() * moves.length)];
    crits.push(truth.criticality);
    if (truth.best.includes(move.name)) kept += 1;
    p = rules.apply(p, move.name);
    plies += 1;
  }
  return { game, seed, plies, criticality: mean(crits), accuracy: plies === 0 ? 0 : kept / plies };
}

async function play(games: GameName[], repeat: number, arms: ArmName[]): Promise<void> {
  const jev = new Jev();
  const prior = readRecord();
  const keep = prior && prior.model === jev.model ? prior : null;
  const out: PlayRecord = {
    model: jev.model,
    rows: (keep?.rows ?? []).filter((r) => !(arms.includes(r.arm as ArmName) && games.includes(r.game as GameName))),
    control: keep?.control ?? [],
    usage: { input: 0, output: 0, calls: 0, ms: 0 },
  };
  const flush = (): void => {
    out.usage = { input: jev.inputTokens, output: jev.outputTokens, calls: jev.calls, ms: jev.totalMs };
    mkdirSync(RECORDS, { recursive: true });
    writeFileSync(
      resolve(RECORDS, "play.json"),
      `{\n"model": ${JSON.stringify(out.model)},\n"usage": ${JSON.stringify(out.usage)},\n` +
        `"control": [\n${out.control.map((c) => JSON.stringify(c)).join(",\n")}\n],\n` +
        `"rows": [\n${out.rows.map((r) => JSON.stringify(r)).join(",\n")}\n]\n}\n`,
    );
  };
  for (const game of games) {
    for (let r = 0; r < repeat; r += 1) {
      const seed = 100 + r;
      if (!out.control.some((c) => c.game === game && c.seed === seed)) out.control.push(controlGame(game, seed));
      for (const arm of arms) {
        const rows = await selfPlay(jev, arm, game, seed);
        out.rows.push(...rows.map((row) => ({ ...row, arm })));
        const t = trajectoryOf(rows);
        console.log(
          `  ${arm.padEnd(9)} ${game.padEnd(10)} seed ${seed}: ${t.plies} plies, ` +
            `doubt ${t.doubt.toFixed(3)} swing ${t.swing.toFixed(2)} alt ${t.alternation.toFixed(2)} ` +
            `-> tension ${t.tension.toFixed(4)} | solver crit ${t.criticality.toFixed(3)} kept ${(100 * t.accuracy).toFixed(0)}%`,
        );
        flush();
      }
    }
  }
  console.log(`  ${jev.calls} requests, ${jev.inputTokens} input tokens -> records/play.json`);
}

// ------------------------------------------------------------------ reporting

/**
 * The inverted board, scored under both rule sets.
 *
 * `misere` came back with doubt ANTI-correlated with its own criticality,
 * which needs an explanation rather than a shrug. The obvious candidate: the
 * position is a familiar tic-tac-toe grid and the doubt is tracking the
 * ordinary game, not the inverted one it was told to play. That is
 * checkable without asking anything further -- the games are deterministic
 * given their move list, so every board can be replayed out of the record
 * and handed to the solver TWICE, once under each rule set.
 *
 * If doubt correlates with the ordinary game's criticality on a board where
 * it anti-correlates with the inverted game's, the picture is beating the
 * stated rule.
 */
function crossRules(rec: PlayRecord): void {
  const arms = [...new Set(rec.rows.map((r) => r.arm))];
  console.log(`\n§2.1 the inverted board -- the same positions scored under both rule sets\n`);
  console.log("  arm        moves   doubt~misere crit   doubt~ordinary crit   the two criticalities");
  for (const arm of arms) {
    const pairs: { doubt: number; mine: number; other: number }[] = [];
    for (const seed of [...new Set(rec.rows.map((r) => r.seed))]) {
      const rows = rec.rows
        .filter((r) => r.arm === arm && r.game === "misere" && r.seed === seed)
        .sort((a, b) => a.ply - b.ply);
      if (rows.length === 0) continue;
      let p = RULES.misere.start(seed);
      for (const row of rows) {
        // The same board read under the other rules. Only the goal differs,
        // so the position is transplanted by key rather than re-derived.
        const asOrdinary = { game: "tictactoe" as const, key: p.key, player: p.player };
        const other = RULES.tictactoe.winner(asOrdinary) === null ? analyse(asOrdinary).criticality : Number.NaN;
        if (!Number.isNaN(other)) pairs.push({ doubt: 1 - row.confidence, mine: row.criticality, other });
        p = RULES.misere.apply(p, row.chosen);
      }
    }
    if (pairs.length < 6) continue;
    const rMine = spearman(pairs.map((x) => ({ a: x.doubt, b: x.mine })));
    const rOther = spearman(pairs.map((x) => ({ a: x.doubt, b: x.other })));
    const rBetween = spearman(pairs.map((x) => ({ a: x.mine, b: x.other })));
    const fmt = (x: number): string => (Number.isNaN(x) ? "n/a" : x.toFixed(3));
    console.log(
      `  ${arm.padEnd(10)} ${String(pairs.length).padStart(5)}   ${fmt(rMine).padStart(16)}   ` +
        `${fmt(rOther).padStart(19)}   ${fmt(rBetween).padStart(20)}`,
    );
  }
}

function report(rec: PlayRecord): void {
  const arms = [...new Set(rec.rows.map((r) => r.arm))];
  console.log(`\n§0 the games -- solved exactly, so every label below is computed and not asked\n`);
  console.log("  game        blurb");
  for (const g of GAMES) console.log(`  ${g.padEnd(11)} ${RULES[g].blurb}`);

  for (const arm of arms) {
    const rows = rec.rows.filter((r) => r.arm === arm);
    if (rows.length === 0) continue;
    console.log(`\n§1 trajectories -- ${arm} (${ARM_BLURB[arm as ArmName] ?? arm})\n`);
    console.log("  game        games plies  doubt  swing   alt   tension   solver crit   kept   legal");
    const perGame: { game: string; tension: number; doubt: number; swing: number; criticality: number }[] = [];
    for (const game of GAMES) {
      const mine = rows.filter((r) => r.game === game);
      if (mine.length === 0) continue;
      const seeds = [...new Set(mine.map((r) => r.seed))];
      const ts: Trajectory[] = seeds.map((s) => trajectoryOf(mine.filter((r) => r.seed === s)));
      const avg = (f: (t: Trajectory) => number): number => mean(ts.map(f));
      perGame.push({
        game,
        tension: avg((t) => t.tension),
        doubt: avg((t) => t.doubt),
        swing: avg((t) => t.swing),
        criticality: avg((t) => t.criticality),
      });
      console.log(
        `  ${game.padEnd(11)} ${String(seeds.length).padStart(5)} ${avg((t) => t.plies).toFixed(0).padStart(5)}  ` +
          `${avg((t) => t.doubt).toFixed(3)}  ${avg((t) => t.swing).toFixed(2)}  ${avg((t) => t.alternation).toFixed(2)}   ` +
          `${avg((t) => t.tension).toFixed(4)}        ${avg((t) => t.criticality).toFixed(3)}   ` +
          `${(100 * avg((t) => t.accuracy)).toFixed(0).padStart(3)}%   ${mean(mine.map((r) => r.legal)).toFixed(1).padStart(5)}`,
      );
    }
    // Each part of the measure against the solver, separately, because the
    // whole point of writing `tension` as one line was to be able to find out
    // that a part of it is doing the work and the rest is noise.
    console.log(`\n  the check: does the measure rank the games the way the solver does? (${perGame.length} games)`);
    for (const [label, pick] of [
      ["doubt alone", (g: (typeof perGame)[number]) => g.doubt],
      ["swing alone", (g: (typeof perGame)[number]) => g.swing],
      ["tension = doubt * swing * (0.5 + 0.5*alt)", (g: (typeof perGame)[number]) => g.tension],
    ] as const) {
      const r = spearman(perGame.map((g) => ({ a: pick(g), b: g.criticality })));
      console.log(`    Spearman(${label}, solver criticality) = ${Number.isNaN(r) ? "n/a" : r.toFixed(3)}`);
    }
    // Per-move, which is the sharper test: a game-level correlation over five
    // points can be luck, and there are hundreds of moves.
    console.log(`\n§2 per move -- ${arm}: is doubt higher where the solver says the choice matters?\n`);
    const buckets = [
      { name: "free (crit = 0)", hit: (c: number) => c === 0 },
      { name: "some (0 < crit < 0.5)", hit: (c: number) => c > 0 && c < 0.5 },
      { name: "tight (crit >= 0.5)", hit: (c: number) => c >= 0.5 },
    ];
    console.log("  criticality bucket        n   mean doubt   mean legal   kept the value");
    for (const b of buckets) {
      const mine = rows.filter((r) => b.hit(r.criticality));
      if (mine.length === 0) continue;
      console.log(
        `  ${b.name.padEnd(22)} ${String(mine.length).padStart(4)}   ` +
          `${mean(mine.map((r) => 1 - r.confidence)).toFixed(3)}        ` +
          `${mean(mine.map((r) => r.legal)).toFixed(1).padStart(4)}          ` +
          `${((100 * mine.filter((r) => r.kept).length) / mine.length).toFixed(0).padStart(3)}%`,
      );
    }
    const rhoMove = spearman(rows.map((r) => ({ a: 1 - r.confidence, b: r.criticality })));
    console.log(`\n  Spearman(doubt, criticality) over ${rows.length} moves = ${Number.isNaN(rhoMove) ? "n/a" : rhoMove.toFixed(3)}`);
    const rhoLegal = spearman(rows.map((r) => ({ a: 1 - r.confidence, b: r.legal })));
    console.log(`  Spearman(doubt, number of legal moves) = ${Number.isNaN(rhoLegal) ? "n/a" : rhoLegal.toFixed(3)}  <- the confound`);
    // Pooling across games cannot separate the two: nim has both the most
    // options and the most critical positions, `drift` has the fewest of
    // each. WITHIN one game the option count barely moves, so a correlation
    // that survives here is about criticality and not about arity.
    console.log("\n  the same correlation inside each game, where the option count hardly varies:");
    console.log("  game          moves   legal range   doubt~crit   doubt~legal");
    for (const game of GAMES) {
      const mine = rows.filter((r) => r.game === game);
      if (mine.length < 6) continue;
      const legals = mine.map((r) => r.legal);
      const within = spearman(mine.map((r) => ({ a: 1 - r.confidence, b: r.criticality })));
      const withinLegal = spearman(mine.map((r) => ({ a: 1 - r.confidence, b: r.legal })));
      console.log(
        `  ${game.padEnd(13)} ${String(mine.length).padStart(5)}   ` +
          `${`${Math.min(...legals)}-${Math.max(...legals)}`.padStart(11)}   ` +
          `${(Number.isNaN(within) ? "n/a" : within.toFixed(3)).padStart(10)}   ` +
          `${(Number.isNaN(withinLegal) ? "n/a" : withinLegal.toFixed(3)).padStart(11)}`,
      );
    }
  }

  crossRules(rec);

  if (rec.control.length > 0) {
    console.log(`\n§3 the control -- the same games played by a uniform chooser, no requests\n`);
    console.log("  game        games plies   solver crit   kept");
    for (const game of GAMES) {
      const mine = rec.control.filter((c) => c.game === game);
      if (mine.length === 0) continue;
      console.log(
        `  ${game.padEnd(11)} ${String(mine.length).padStart(5)} ${mean(mine.map((c) => c.plies)).toFixed(0).padStart(5)}   ` +
          `${mean(mine.map((c) => c.criticality)).toFixed(3)}         ${(100 * mean(mine.map((c) => c.accuracy))).toFixed(0)}%`,
      );
    }
  }
  if (rec.usage.calls > 0) {
    console.log(
      `\n  ${rec.usage.calls} requests, ${rec.usage.input} input tokens, ` +
        `$${((rec.usage.input / 1e6) * 0.042).toFixed(4)}, ${(rec.usage.ms / rec.usage.calls).toFixed(0)} ms per move`,
    );
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (name: string, dflt: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  if (argv.includes("--replay") || argv.length === 0) {
    const rec = readRecord();
    if (!rec) console.log("no records yet; run with --play");
    else report(rec);
    return;
  }
  if (argv.includes("--play")) {
    await play(
      arg("games", GAMES.join(",")).split(",") as GameName[],
      Number(arg("repeat", "2")),
      arg("arms", "jev").split(",") as ArmName[],
    );
  }
}

if (process.argv[1]?.endsWith("run.ts")) {
  main().catch((err: unknown) => {
    console.error(String(err));
    process.exit(1);
  });
}

export { ARMS };
