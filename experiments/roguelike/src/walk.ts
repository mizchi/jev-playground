/**
 * Baseline games, and the screens the perception questions are asked about.
 *
 *   npx tsx src/walk.ts --games 4 --actions 300
 *
 * No API key, no requests. This produces two things: the numbers the
 * judgment arm has to beat, and a corpus of real NetHack screens with
 * mechanically-derived ground truth attached -- which is why it runs first.
 * Screens from a random walker and screens from an explorer look different
 * (one barely leaves the first room), so both policies contribute.
 *
 * Games run one at a time. NetHack's level-lock files are shared per user,
 * so two concurrent games would fight over them.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { available, type Screen } from "./nethack.js";
import { type GameRow, greedyPolicy, playGame, randomPolicy, rngFrom } from "./play.js";

export interface ScreenRow {
  game: number;
  turn: number;
  policy: string;
  rows: string[];
}

export interface WalkRecord {
  bin: string;
  games: GameRow[];
  screens: ScreenRow[];
}

export function baseline(
  policy: "random" | "greedy",
  seed: number,
  maxActions: number,
  onScreen?: (screen: Screen, turn: number) => void,
): Promise<GameRow> {
  return playGame({
    policy: policy === "random" ? randomPolicy(rngFrom(seed)) : greedyPolicy(),
    label: policy,
    name: `${policy === "random" ? "Rnd" : "Grd"}${seed}`,
    seed,
    maxActions,
    home: resolve(tmpdir(), `nh-${policy}-${seed}-${process.pid}`),
    onScreen,
  });
}

export function summarise(row: GameRow): string {
  return (
    `T:${row.turns} in ${row.actions} actions, ` +
    `${row.refused} refused (${((100 * row.refused) / Math.max(1, row.actions)).toFixed(0)}%), ` +
    `Dlvl ${row.maxDlvl}, Xp ${row.xp}, $${row.gold}, HP ${row.hp}, ` +
    `mapped ${row.explored}, walked ${row.visited}${row.died ? ", died" : ""}`
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (name: string, dflt: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  if (!available()) {
    console.error(`no NetHack at ${process.env.NETHACK_BIN ?? "/usr/games/nethack"}, or no tmux`);
    console.error("install it with `apt-get install -y nethack-console`");
    process.exit(2);
  }
  const games = Number(arg("games", "4"));
  const maxActions = Number(arg("actions", "300"));
  const every = Number(arg("every", "10"));
  const policies = arg("policy", "random,greedy").split(",") as ("random" | "greedy")[];
  const out: WalkRecord = { bin: process.env.NETHACK_BIN ?? "/usr/games/nethack", games: [], screens: [] };
  for (const policy of policies) {
    for (let g = 0; g < games; g += 1) {
      const seed = 1000 * (policy === "random" ? 1 : 2) + g;
      const index = out.games.length;
      let last = -1;
      const row = await baseline(policy, seed, maxActions, (screen, turn) => {
        if (turn - last < every) return;
        last = turn;
        out.screens.push({ game: index, turn, policy, rows: screen.rows.map((r) => r.replace(/\s+$/, "")) });
      });
      out.games.push(row);
      console.log(`  ${policy} seed ${seed}: ${summarise(row)}`);
    }
  }
  const dir = resolve(import.meta.dirname, "../records");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, "walk.json");
  writeFileSync(
    path,
    `{\n"bin": ${JSON.stringify(out.bin)},\n"games": [\n${out.games
      .map((g) => JSON.stringify(g))
      .join(",\n")}\n],\n"screens": [\n${out.screens.map((s) => JSON.stringify(s)).join(",\n")}\n]\n}\n`,
  );
  console.log(`  ${out.screens.length} screens -> ${path}`);
}

if (process.argv[1]?.endsWith("walk.ts")) {
  main().catch((err: unknown) => {
    console.error(String(err));
    process.exit(1);
  });
}
