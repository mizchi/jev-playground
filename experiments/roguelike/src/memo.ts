/**
 * docs/06 homework (a): `jevmemo` changed two things at once. Which one moved
 * the number?
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/memo.ts
 *   npx tsx src/memo.ts --games 3 --actions 200
 *   npx tsx src/memo.ts --report            # from the record, no key
 *
 * docs/34 §2.4 added the visit counts AND a goal sentence in the same arm and
 * reported mapping 48 -> 152. That number cannot say which addition did it: if
 * the sentence alone moves it, what was added was INTENT and not MEMORY.
 *
 *   jev          the glyph text, base goal. The arm the 48 came from.
 *   jevcount     + visit counts, base goal unchanged.      memory, no intent
 *   jevintent    + the sentence, no counts.                intent, no memory
 *   jevmemo      + both. The arm the 152 came from.
 *   jevmemofix   + both, counts withheld where a step cannot land.
 *
 * THE DUNGEON CANNOT BE HELD FIXED, AND I TRIED TO CLAIM OTHERWISE. This file
 * was first written to give every arm "the same seeds", on the assumption that
 * `playGame`'s `seed` selects the dungeon. It does not. `seed` is recorded and
 * fed to `rngFrom` for the RANDOM POLICY'S CHOICES; nothing passes it to
 * NetHack, which seeds itself. So every game in this experiment -- and every
 * game in docs/34 -- is an INDEPENDENT RANDOM DUNGEON, and two ten-action
 * probes here mapped 25 and 43 cells before any policy could matter.
 *
 * The only lever left is games per arm. docs/34 used three, which is why its
 * 48 against 152 carries no spread; this runs more and reports the spread, so
 * a reader can see whether the gap clears it.
 *
 * ITS OWN RECORD: `records/memo.json`, so `play.json` and the numbers docs/34
 * reports from it are left alone. (Running `run.ts --play` to diagnose this
 * file overwrote `play.json` once; it was committed, so `git checkout`
 * restored it. Diagnostics do not belong in a shared record.)
 *
 * `jevmemofix` is here because homework (b) found the reason for `jevmemo`'s
 * refusals in its own payload rather than in its results (`src/refusals.ts`):
 * a wall has never been stood on, so the sentence attached to it reads "you
 * have never stood there", while the goal says to prefer that. The memory
 * recommends walls. This arm withholds the count where the square is not
 * steppable, and the gap to `jevmemo` is what that contradiction costs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Jev } from "../../shared/jev.js";
import { heroAt } from "./nethack.js";
import { MOVE, questionFor, stateFor, type ArmName } from "./arms.js";
import { type GameRow, type Policy, playGame } from "./play.js";

const RECORDS = resolve(import.meta.dirname, "../records");
const PATH = resolve(RECORDS, "memo.json");

/** The five arms, in the order the table should read. */
const LANES: ArmName[] = ["jev", "jevcount", "jevintent", "jevmemo", "jevmemofix"];

/** Short, distinct save names -- NetHack keys its save file on this. */
const PREFIX: Record<string, string> = {
  jev: "MJ",
  jevcount: "MC",
  jevintent: "MI",
  jevmemo: "MM",
  jevmemofix: "MF",
};

interface Record_ {
  model: string;
  usage: { input: number; output: number; calls: number; ms: number };
  games: GameRow[];
}

function load(): Record_ | null {
  return existsSync(PATH) ? (JSON.parse(readFileSync(PATH, "utf8")) as Record_) : null;
}

function policyFor(jev: Jev, arm: ArmName): Policy {
  return async (screen, actions, vitals, recent, seen) => {
    const hero = heroAt(screen) ?? undefined;
    const memory = arm === "jevmemo" || arm === "jevcount" || arm === "jevmemofix" ? seen : undefined;
    const res = await jev.ask(stateFor(screen, vitals, recent, memory), questionFor(arm, actions, hero, memory, screen));
    const answer = res.answers[MOVE];
    if (answer.type !== "choice") throw new Error(`expected a choice, got ${answer.type}`);
    return { action: actions.find((a) => a.name === answer.choice) ?? null, confidence: answer.confidence };
  };
}

const VERTICAL = new Set(["j", "k"]);
const HORIZONTAL = new Set(["h", "l"]);

function report(): void {
  const record = load();
  if (!record) throw new Error("no records/memo.json -- run without --report first");
  const seeds = [...new Set(record.games.map((g) => g.seed))].sort((a, b) => a - b);
  console.log(`\n  docs/06 homework (a): which half of \`jevmemo\` did the work?`);
  console.log(
    `  ${record.games.length} games over ${seeds.length} independent random dungeons per arm.\n` +
      "  The dungeon is NOT controlled -- nothing passes a seed to NetHack -- so the\n" +
      "  spread below is the dungeon's, and a difference has to clear it.\n",
  );

  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  console.log("§1 the split");
  console.log("\n  arm          counts  sentence   mapped   walked   refused   illegal   turns");
  for (const arm of LANES) {
    const games = record.games.filter((g) => g.policy === arm);
    if (games.length === 0) continue;
    const has = {
      counts: arm === "jevcount" || arm === "jevmemo" || arm === "jevmemofix",
      sentence: arm === "jevintent" || arm === "jevmemo" || arm === "jevmemofix",
    };
    console.log(
      `  ${arm.padEnd(12)} ${(has.counts ? "yes" : "no").padStart(6)}  ${(has.sentence ? "yes" : "no").padStart(8)}   ` +
        `${mean(games.map((g) => g.explored)).toFixed(0).padStart(6)}   ` +
        `${mean(games.map((g) => g.visited)).toFixed(0).padStart(6)}   ` +
        `${`${((100 * games.reduce((n, g) => n + g.refused, 0)) / Math.max(1, games.reduce((n, g) => n + g.actions, 0))).toFixed(0)}%`.padStart(7)}   ` +
        `${games.reduce((n, g) => n + g.illegal, 0).toString().padStart(7)}   ` +
        `${mean(games.map((g) => g.turns)).toFixed(0).padStart(5)}`,
    );
  }

  const mapped = (arm: ArmName): number => mean(record.games.filter((g) => g.policy === arm).map((g) => g.explored));
  const spread = (arm: ArmName): string => {
    const xs = record.games.filter((g) => g.policy === arm).map((g) => g.explored);
    return xs.length === 0 ? "-" : `${Math.min(...xs)}..${Math.max(...xs)}`;
  };
  const base = mapped("jev");
  console.log("\n§2 what each addition is worth, against `jev`");
  console.log("\n  arm          mapped   range      vs jev   reading");
  for (const arm of LANES) {
    if (record.games.every((g) => g.policy !== arm)) continue;
    const m = mapped(arm);
    const gap = m - base;
    console.log(
      `  ${arm.padEnd(12)} ${m.toFixed(0).padStart(6)}   ${spread(arm).padEnd(9)}  ${`${gap > 0 ? "+" : ""}${gap.toFixed(0)}`.padStart(6)}   ` +
        (arm === "jev" ? "the baseline" : arm === "jevcount" ? "memory alone" : arm === "jevintent" ? "the sentence alone" : arm === "jevmemo" ? "both, as shipped" : "both, minus the contradiction"),
    );
  }
  console.log(
    "\n  The `range` column is the point of it: the dungeon is not controlled, so an arm\n" +
      "  whose range overlaps another's has not been shown to differ from it.",
  );
  const c = mapped("jevcount") - base;
  const i = mapped("jevintent") - base;
  const both = mapped("jevmemo") - base;
  console.log(
    `\n  >> memory alone ${c > 0 ? "+" : ""}${c.toFixed(0)}, sentence alone ${i > 0 ? "+" : ""}${i.toFixed(0)}, ` +
      `both ${both > 0 ? "+" : ""}${both.toFixed(0)}.\n` +
      (Math.abs(i) > Math.abs(c)
        ? "     THE SENTENCE IS DOING MORE THAN THE MEMORY. docs/34 §2.4 added both and\n" +
          "     credited the memory; on matched dungeons the intent carries more of it."
        : Math.abs(c) > Math.abs(i)
          ? "     The memory is doing more than the sentence, which is what docs/34 §2.4\n" +
            "     assumed -- now measured rather than assumed."
          : "     Neither half accounts for it alone, so the two interact and the arm has to\n" +
            "     be read as one change."),
  );

  console.log("\n§3 the contradiction homework (b) found, priced");
  console.log("\n  arm          refusals on vertical   on horizontal   mapped");
  for (const arm of ["jevmemo", "jevmemofix"] as ArmName[]) {
    const steps = record.games.filter((g) => g.policy === arm).flatMap((g) => g.steps);
    if (steps.length === 0) continue;
    const rate = (set: Set<string>): string => {
      const of = steps.filter((s) => set.has(s.key));
      return of.length === 0 ? "    -" : `${((100 * of.filter((s) => s.refused).length) / of.length).toFixed(0).padStart(4)}%`;
    };
    console.log(
      `  ${arm.padEnd(12)} ${rate(VERTICAL).padStart(20)}   ${rate(HORIZONTAL).padStart(13)}   ${mapped(arm).toFixed(0).padStart(6)}`,
    );
  }
  console.log(
    "\n  >> `jevmemofix` withholds the visit count where a step cannot land, so a wall no\n" +
      "     longer arrives labelled `you have never stood there` under a goal that says to\n" +
      "     prefer exactly that. If its refusals fall and its mapping holds, the\n" +
      "     contradiction was costing refusals and buying nothing.\n",
  );

  console.log("§4 where the refusals were, which the old record could not say");
  console.log("\n  arm          refusals with a wall in that direction   elsewhere");
  for (const arm of LANES) {
    const steps = record.games.filter((g) => g.policy === arm).flatMap((g) => g.steps);
    const withXY = steps.filter((s) => s.x !== undefined).length;
    if (steps.length === 0) continue;
    console.log(`  ${arm.padEnd(12)} steps ${steps.length}, carrying a position: ${withXY}`);
  }
  console.log(
    "\n  >> `StepRow` now records the hero's x/y, which is what homework (b) wanted and\n" +
      "     the old record did not have. With a position per step, a later pass can ask\n" +
      "     whether the refusals sit on the map's edge -- for free, from this record.\n",
  );

  console.log(
    `  cost: ${record.usage.calls} calls, ${record.usage.input} input tokens, ` +
      `$${((record.usage.input / 1e6) * 0.042).toFixed(4)}, ${(record.usage.ms / 1000).toFixed(0)} s\n`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--report")) {
    report();
    return;
  }
  const num = (name: string, fallback: number): number =>
    args.includes(`--${name}`) ? Number(args[args.indexOf(`--${name}`) + 1]) : fallback;
  const games = num("games", 3);
  const maxActions = num("actions", 200);
  const only = args.includes("--arms") ? (args[args.indexOf("--arms") + 1].split(",") as ArmName[]) : LANES;

  const jev = new Jev();
  const prior = load();
  const out: Record_ = {
    model: jev.model,
    games: prior && prior.model === jev.model ? prior.games.filter((g) => !only.includes(g.policy as ArmName)) : [],
    usage: { input: 0, output: 0, calls: 0, ms: 0 },
  };
  const flush = (): void => {
    out.usage = { input: jev.inputTokens, output: jev.outputTokens, calls: jev.calls, ms: jev.totalMs };
    mkdirSync(RECORDS, { recursive: true });
    writeFileSync(
      PATH,
      `{\n"model": ${JSON.stringify(out.model)},\n"usage": ${JSON.stringify(out.usage)},\n"games": [\n${out.games
        .map((g) => JSON.stringify(g))
        .join(",\n")}\n]\n}\n`,
    );
  };

  // `seed` labels the game and drives no dungeon (see the header). Arms share
  // the numbering only so the record reads tidily.
  for (const arm of only) {
    for (let g = 0; g < games; g += 1) {
      const seed = 9000 + g;
      const started = Date.now();
      const row = await playGame({
        policy: policyFor(jev, arm),
        label: arm,
        // The NetHack save name has to be short and unique per arm+seed, or
        // two arms share a save file and the second inherits the first's game.
        name: `${PREFIX[arm]}${seed}`,
        seed,
        maxActions,
        home: resolve(tmpdir(), `nh-memo-${arm}-${seed}-${process.pid}`),
      });
      out.games = out.games.filter((x) => !(x.policy === arm && x.seed === seed)).concat(row);
      flush();
      console.log(
        `  ${arm.padEnd(12)} seed ${seed}  ${((Date.now() - started) / 1000).toFixed(0).padStart(3)}s  ` +
          `mapped ${String(row.explored).padStart(3)} walked ${String(row.visited).padStart(3)} ` +
          `refused ${row.refused}/${row.actions} illegal ${row.illegal}${row.died ? " died" : ""}`,
      );
    }
  }
  flush();
  console.log(
    `\n  ${out.games.length} games in records/memo.json; ${jev.calls} calls, ` +
      `$${((jev.inputTokens / 1e6) * 0.042).toFixed(4)}`,
  );
}

await main();
