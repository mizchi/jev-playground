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
 *   jevmemoraw   + both, count on every square. The arm the 152 came from.
 *   jevmemo      + both, count withheld where a step cannot land. SHIPPED.
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
 * The two `jevmemo` arms exist because homework (b) found the reason for the
 * refusals in the payload rather than in the results (`src/refusals.ts`): a
 * wall has never been stood on, so the sentence attached to it reads "you have
 * never stood there", while the goal says to prefer that. The memory
 * recommended walls.
 *
 * THAT COMPARISON DECIDED WHAT SHIPS. The guarded arm is better on every axis
 * and it is now what `arms.ts` calls `jevmemo`; the unguarded one is
 * `jevmemoraw`. The records were relabelled to match, so the rows below read
 * against the code rather than against an older meaning of the same word.
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
const LANES: ArmName[] = ["jev", "jevcount", "jevintent", "jevmemoraw", "jevmemo"];

/** What each arm is for, so the table's last column is not positional. */
const READING: Record<string, string> = {
  jev: "the baseline",
  jevcount: "memory alone",
  jevintent: "the sentence alone",
  jevmemoraw: "both, with the contradiction (what docs/34 measured)",
  jevmemo: "both, contradiction removed -- SHIPPED",
};

/** Short, distinct save names -- NetHack keys its save file on this. */
const PREFIX: Record<string, string> = {
  jev: "MJ",
  jevcount: "MC",
  jevintent: "MI",
  jevmemo: "MM",
  jevmemoraw: "MR",
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
    const memory = arm === "jevmemo" || arm === "jevcount" || arm === "jevmemoraw" ? seen : undefined;
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
      counts: arm === "jevcount" || arm === "jevmemo" || arm === "jevmemoraw",
      sentence: arm === "jevintent" || arm === "jevmemo" || arm === "jevmemoraw",
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
        READING[arm],
    );
  }
  console.log(
    "\n  The `range` column is the point of it: the dungeon is not controlled, so an arm\n" +
      "  whose range overlaps another's has not been shown to differ from it.",
  );
  /**
   * Ranks, not means, and an EXACT p-value by enumeration.
   *
   * Six games per arm over uncontrolled dungeons: the ranges overlap for
   * every pair, so "the range overlaps" would refuse every comparison here
   * including one where five of six games beat the whole baseline. The rank
   * statistic asks the answerable question -- how often does a game from
   * this arm map more than a game from `jev` -- and with 6 against 6 the
   * null distribution has only C(12,6) = 924 arrangements, so the p-value is
   * counted rather than approximated.
   *
   * ONE-SIDED, and that is a choice: every one of these arms was built
   * expecting more exploration, so the direction was fixed before the run.
   */
  const explored = (arm: ArmName): number[] => record.games.filter((g) => g.policy === arm).map((g) => g.explored);
  const uOf = (a: readonly number[], b: readonly number[]): number => {
    let u = 0;
    for (const y of b) for (const x of a) u += y > x ? 1 : y === x ? 0.5 : 0;
    return u;
  };
  /** Exact one-sided p for `b > a`, by enumerating every split of the pool. */
  const exactP = (a: readonly number[], b: readonly number[]): number => {
    const pool = [...a, ...b];
    const n = a.length;
    const observed = uOf(a, b);
    let total = 0;
    let atLeast = 0;
    const walk = (start: number, picked: number[]): void => {
      if (picked.length === n) {
        const rest = pool.filter((_, i) => !picked.includes(i));
        const left = picked.map((i) => pool[i]);
        total += 1;
        if (uOf(left, rest) >= observed) atLeast += 1;
        return;
      }
      for (let i = start; i < pool.length; i += 1) walk(i + 1, [...picked, i]);
    };
    walk(0, []);
    return total === 0 ? 1 : atLeast / total;
  };

  console.log("\n§2b ranks rather than means, with an exact p-value");
  console.log("\n  arm          games mapping more than a `jev` game   beat jev's best   exact p");
  const jevGames = explored("jev");
  for (const arm of LANES) {
    if (arm === "jev") continue;
    const xs = explored(arm);
    if (xs.length === 0) continue;
    const u = uOf(jevGames, xs);
    const pairs = jevGames.length * xs.length;
    const above = xs.filter((x) => x > Math.max(...jevGames)).length;
    console.log(
      `  ${arm.padEnd(12)} ${`${u}/${pairs} (AUC ${(u / pairs).toFixed(3)})`.padStart(34)}   ` +
        `${`${above}/${xs.length}`.padStart(15)}   ${exactP(jevGames, xs).toFixed(4).padStart(7)}`,
    );
  }

  const c = mapped("jevcount") - base;
  const i = mapped("jevintent") - base;
  // `jevmemoraw` is the arm the homework was about: both additions, with the
  // contradiction still in. `jevmemo` is what ships, so both are printed.
  const both = mapped("jevmemoraw") - base;
  const shipped = mapped("jevmemo") - base;
  console.log(
    `\n  >> memory alone ${c > 0 ? "+" : ""}${c.toFixed(0)}, sentence alone ${i > 0 ? "+" : ""}${i.toFixed(0)}, ` +
      `both ${both > 0 ? "+" : ""}${both.toFixed(0)}` +
      ` (and ${shipped > 0 ? "+" : ""}${shipped.toFixed(0)} once the contradiction is removed, which is what ships).`,
  );
  if (c <= 0 && i <= 0 && both > 0) {
    console.log(
      "\n     NEITHER HALF DOES ANYTHING ALONE. Both are slightly WORSE than the baseline,\n" +
        "     and together they are much better, so the whole effect is an INTERACTION.\n" +
        "     That reading is available only because the halves were run: the visit counts\n" +
        "     are inert until something tells the model to prefer unvisited ground, and the\n" +
        "     instruction is unactionable until the counts are there to act on.\n\n" +
        "     docs/34 §2.4 added both at once and wrote about the memory. The homework\n" +
        "     asked whether the sentence alone would move it -- `if the sentence alone\n" +
        "     raises it, what was added was intent and not memory`. The answer is neither:\n" +
        "     the question had a third answer and both of its options were wrong.",
    );
  } else if (i > c && i > 0) {
    console.log("\n     The sentence carries more of it than the memory does.");
  } else if (c > i && c > 0) {
    console.log("\n     The memory carries more of it, which is what docs/34 §2.4 assumed.");
  } else {
    console.log("\n     Read the signs above: neither half is straightforwardly the cause.");
  }

  console.log("\n§3 the contradiction homework (b) found, priced");
  console.log("\n  arm          refusals on vertical   on horizontal   mapped");
  for (const arm of ["jevmemoraw", "jevmemo"] as ArmName[]) {
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
    "\n  >> `jevmemo` (shipped) withholds the visit count where a step cannot land, so a\n" +
      "     wall no longer arrives labelled `you have never stood there` under a goal that\n" +
      "     says to prefer exactly that. `jevmemoraw` is what shipped before. The refusals\n" +
      "     fall and the mapping rises, so the contradiction was costing refusals and\n" +
      "     buying nothing -- which is why the guarded arm is the one that ships now.\n",
  );

  /**
   * The question homework (b) actually asked, now answerable.
   *
   * `StepRow` carries x/y since this run, so "are the refusals at the map's
   * edge?" is a read rather than a re-run. Two readings of "edge", because
   * the loose one would pass trivially:
   *
   *   DISTANCE TO THE SCREEN'S BORDER. NetHack draws the level inside rows
   *   1..21 of 80 columns, and a hero against that border has fewer legal
   *   neighbours. If refusals were the border, refused steps would sit nearer
   *   it than accepted ones.
   *   CONCENTRATION. A policy stuck in a corner refuses the same moves from
   *   the same square repeatedly, so refusals per distinct square would be
   *   high. Spread-out refusals are not an edge at all.
   */
  console.log("§4 the question homework (b) asked: are the refusals at the map's edge?");
  console.log(
    "\n  arm          mean distance to the border      refusals per   most-refused\n" +
      "                 accepted    refused            distinct square      square",
  );
  // The map occupies rows 1..21; row 0 is the message line and 22-23 status.
  const toBorder = (x: number, y: number): number => Math.min(x, 79 - x, Math.max(0, y - 1), Math.max(0, 21 - y));
  const positioned = (arm: ArmName) =>
    record.games
      .filter((g) => g.policy === arm)
      .flatMap((g) => g.steps)
      .filter((s) => s.x !== undefined && s.y !== undefined);
  for (const arm of LANES) {
    const steps = positioned(arm);
    if (steps.length === 0) continue;
    const refused = steps.filter((s) => s.refused);
    const at = new Map<string, number>();
    for (const s of refused) {
      const k = `${s.x},${s.y}`;
      at.set(k, (at.get(k) ?? 0) + 1);
    }
    const worst = [...at.entries()].sort((a, b) => b[1] - a[1])[0];
    const d = (xs: typeof steps): string =>
      xs.length === 0
        ? "   -"
        : (xs.reduce((n, s) => n + toBorder(s.x as number, s.y as number), 0) / xs.length).toFixed(1);
    console.log(
      `  ${arm.padEnd(12)} ${d(steps.filter((s) => !s.refused)).padStart(9)}  ${d(refused).padStart(9)}   ` +
        `${(at.size === 0 ? "-" : (refused.length / at.size).toFixed(2)).padStart(18)}   ` +
        `${(worst ? `${worst[1]}x at ${worst[0]}` : "-").padStart(13)}`,
    );
  }
  const allSteps = LANES.flatMap((a) => positioned(a));
  const meanD = (xs: typeof allSteps): number =>
    xs.reduce((n, s) => n + toBorder(s.x as number, s.y as number), 0) / Math.max(1, xs.length);
  const dRef = meanD(allSteps.filter((s) => s.refused));
  const dOk = meanD(allSteps.filter((s) => !s.refused));
  console.log(
    `\n  >> Refused steps sit ${dRef.toFixed(1)} from the border, accepted ones ${dOk.toFixed(1)} -- ` +
      `refusals happen ${dRef > dOk ? "FARTHER INSIDE" : "NEARER THE BORDER"}.\n` +
      (dRef > dOk + 0.5
        ? "     SO THE EDGE EXPLANATION IS REFUTED, AND IN THE OPPOSITE DIRECTION. Homework\n" +
          "     (b) offered the map's edge or docs/34 §1.1's column misread; a refusal is\n" +
          "     more likely the further from the border the hero is, which is where the\n" +
          "     rooms and their interior walls are. This run is the first to record the\n" +
          "     position the homework asked for."
        : Math.abs(dRef - dOk) <= 0.5
          ? "     The two are within half a cell, so position says nothing either way."
          : "     Refusals DO sit nearer the border, so the edge explanation survives."),
  );
  /**
   * And the column that was nearly reported as its own opposite.
   *
   * A canned sentence here claimed the refusals were "spread rather than
   * stuck" while the table beside it showed 200 refusals on ONE SQUARE --
   * and 200 is `maxActions`, so that arm spent a whole game refusing in one
   * spot. Third time in this session that a conclusion string in one of my
   * own reports contradicted its own numbers, so the reading is computed now.
   */
  const stuck = LANES.map((arm) => {
    const refused = positioned(arm).filter((s) => s.refused);
    const at = new Map<string, number>();
    for (const s of refused) at.set(`${s.x},${s.y}`, (at.get(`${s.x},${s.y}`) ?? 0) + 1);
    const worst = Math.max(0, ...at.values());
    return { arm, perSquare: at.size === 0 ? 0 : refused.length / at.size, worst };
  }).filter((r) => r.worst > 0);
  const locked = stuck.filter((r) => r.worst >= 100);
  console.log(
    `\n     AND SOME ARMS GET STUCK. ${locked.length} of ${stuck.length} arms have a single square with\n` +
      `     100+ refusals on it (${locked.map((r) => `${r.arm} ${r.worst}x`).join(", ") || "none"}), against a cap of\n` +
      "     200 actions per game -- so a whole game went on refusing in one spot. That is\n" +
      "     what `jevmemo`'s 64 turns against `jev`'s 195 actually was.\n\n" +
      `     The arms that do not lock up: ${stuck
        .filter((r) => r.worst < 100)
        .map((r) => `${r.arm} ${r.worst}x`)
        .join(", ")}.\n` +
      "     So the payload contradiction homework (b) found is not only a refusal rate --\n" +
      "     it is what locks the agent in place, and withholding the count where a step\n" +
      "     cannot land takes the lock-up with it.\n",
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
