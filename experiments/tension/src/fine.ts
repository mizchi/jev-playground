/**
 * docs/06 homework (c): is `swing` measuring the game, or the scale?
 *
 *   npx tsx src/fine.ts        # from records/fine.json, no API key
 *
 * `swing` is the mean absolute change in the `standing` score between a
 * player's consecutive moves, and docs/35 §1 ranks five games by it. The
 * score has five levels. If the ranking moves when the scale gets finer, the
 * statistic is about the SCALE.
 *
 * HOW THIS AVOIDS THE OBVIOUS CONFOUND. Both scales are asked IN THE SAME
 * REQUEST, about the same position, with identical `instructions` and with
 * every fifth level of the nine worded verbatim as the corresponding one of
 * the five (`test.ts` checks both). So the comparison is resolution and
 * nothing else. A second run would have re-played the games -- the chooser
 * would have made different moves and the trajectories being compared would
 * be different trajectories.
 *
 * AND THE ONE THAT IS NOT A CONFOUND BUT ARITHMETIC. Nine levels span 0..8
 * and five span 0..4, so the same change reads twice as large on the finer
 * scale before any judgment is involved. `swingFineRescaled` divides by two.
 * Comparing the raw numbers would answer "is 8 bigger than 4".
 *
 * `records/fine.json` is its own file: re-running in place would have been a
 * fresh set of draws for `standing` too, so docs/35's published figures would
 * have moved for a reason that has nothing to do with this question.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GAMES } from "./games.js";
import { mean, spearman, swingOf, swingFineRescaled, trajectoryOf, type MoveRow } from "./tension.js";

const RECORDS = resolve(import.meta.dirname, "../records");

interface Rec {
  model: string;
  usage: { input: number; output: number; calls: number; ms: number };
  rows: (MoveRow & { arm: string })[];
}

function main(): void {
  const path = resolve(RECORDS, "fine.json");
  if (!existsSync(path)) throw new Error("no records/fine.json -- run `src/run.ts --play --record fine.json`");
  const record = JSON.parse(readFileSync(path, "utf8")) as Rec;
  const rows = record.rows.filter((r) => r.arm === "jev");
  const withFine = rows.filter((r) => r.standingFine !== undefined).length;

  console.log("\n  docs/06 homework (c): does `swing` depend on the scale's resolution?");
  console.log(`  ${rows.length} plies, ${withFine} carrying both scales, asked in the same request.\n`);

  // ------------------------------------------------ do the two scales agree

  const pairs = rows
    .filter((r) => r.standingFine !== undefined)
    .map((r) => ({ a: r.standing, b: (r.standingFine as number) / 2 }));
  console.log("§1 are the two scales reading the same thing at all?");
  console.log(
    `\n  spearman(five-level, nine-level rescaled) = ${spearman(pairs).toFixed(3)} over ${pairs.length} plies`,
  );
  const diffs = pairs.map((p) => Math.abs(p.a - p.b));
  console.log(
    `  mean |difference| after rescaling: ${mean(diffs).toFixed(3)} on a 0..4 scale ` +
      `(worst ${Math.max(...diffs).toFixed(2)})\n`,
  );
  console.log(
    "  >> A high correlation here is the precondition, not the result. If the two scales\n" +
      "     disagreed about the positions themselves there would be nothing to say about\n" +
      "     what `swing` measures.\n",
  );

  // ------------------------------------------------------- the ranking itself

  const seeds = (game: string): number[] => [...new Set(rows.filter((r) => r.game === game).map((r) => r.seed))];
  const perGame = GAMES.map((game) => {
    const trajectories = seeds(game).map((seed) => rows.filter((r) => r.game === game && r.seed === seed));
    return {
      game,
      games: trajectories.length,
      swing5: mean(trajectories.map((t) => swingOf(t))),
      swing9: mean(trajectories.map((t) => swingFineRescaled(t))),
      swing9raw: mean(trajectories.map((t) => swingOf(t, "standingFine"))),
      criticality: mean(trajectories.map((t) => trajectoryOf(t).criticality)),
    };
  });

  console.log("§2 the ranking docs/35 §1 reports, computed both ways");
  console.log(
    "\n  game        games   swing (5 levels)      swing (9, rescaled)   solver crit\n" +
      "                          mean [range]          mean [range]",
  );
  const band = (game: string, which: "standing" | "standingFine"): string => {
    const xs = seeds(game).map((seed) => {
      const t = rows.filter((r) => r.game === game && r.seed === seed);
      return which === "standing" ? swingOf(t) : swingFineRescaled(t);
    });
    return `${mean(xs).toFixed(3)} [${Math.min(...xs).toFixed(2)}..${Math.max(...xs).toFixed(2)}]`;
  };
  for (const g of perGame) {
    console.log(
      `  ${g.game.padEnd(11)} ${String(g.games).padStart(5)}   ${band(g.game, "standing").padEnd(21)} ` +
        `${band(g.game, "standingFine").padEnd(21)} ${g.criticality.toFixed(3).padStart(11)}`,
    );
  }

  const rank = (key: "swing5" | "swing9"): string[] =>
    [...perGame].sort((a, b) => b[key] - a[key]).map((g) => g.game);
  const r5 = rank("swing5");
  const r9 = rank("swing9");
  console.log(`\n  ranked by the five-level swing:  ${r5.join(" > ")}`);
  console.log(`  ranked by the nine-level swing:  ${r9.join(" > ")}`);
  const rho = spearman(perGame.map((g) => ({ a: g.swing5, b: g.swing9 })));
  console.log(`  spearman between the two rankings: ${rho.toFixed(3)}`);
  const same = r5.join("|") === r9.join("|");
  // A swap between two games whose own ranges overlap is not a reordering, it
  // is two games that were never ordered. docs/25's rule, applied to a rank.
  const swapped: string[] = [];
  for (let i = 0; i < r5.length; i += 1) if (r5[i] !== r9[i]) swapped.push(r5[i]);
  const overlaps = (a: string, b: string): boolean => {
    const xs = (game: string) => seeds(game).map((seed) => swingOf(rows.filter((r) => r.game === game && r.seed === seed)));
    const [A, B] = [xs(a), xs(b)];
    return Math.min(...A) <= Math.max(...B) && Math.min(...B) <= Math.max(...A);
  };
  if (same) {
    console.log(
      "\n  >> THE RANKING IS IDENTICAL. Doubling the resolution did not reorder the games,\n" +
        "     so `swing` on this corpus is not an artefact of a five-level scale.",
    );
  } else {
    const pairsSwapped = [...new Set(swapped)];
    const allOverlap = pairsSwapped.length >= 2 && overlaps(pairsSwapped[0], pairsSwapped[1]);
    console.log(
      `\n  >> The order changed, at ${pairsSwapped.join(" / ")}.` +
        (allOverlap
          ? "\n     BUT THEIR PER-GAME RANGES OVERLAP, so they were never ordered to begin with.\n" +
            "     The honest statement is not `the scale reordered them` but `six games per\n" +
            "     game is not enough to order these two at all`, on either scale."
          : "\n     Their per-game ranges do NOT overlap, so this is a real reordering: `swing`\n" +
            "     is reading the scale as well as the game, and docs/35 §1's order is a fact\n" +
            "     about a five-level score."),
    );
  }

  // ------------------------------- which parts of the order actually hold

  console.log("\n§2b which adjacent pairs are separated by more than their own spread?");
  console.log("\n  pair                       5 levels   9 levels");
  const xsOf = (game: string, which: "standing" | "standingFine"): number[] =>
    seeds(game).map((seed) => {
      const t = rows.filter((r) => r.game === game && r.seed === seed);
      return which === "standing" ? swingOf(t) : swingFineRescaled(t);
    });
  const separated = (a: string, b: string, which: "standing" | "standingFine"): boolean => {
    const [A, B] = [xsOf(a, which), xsOf(b, which)];
    return Math.min(...A) > Math.max(...B) || Math.min(...B) > Math.max(...A);
  };
  let held = 0;
  let total = 0;
  for (let i = 0; i + 1 < r5.length; i += 1) {
    const [a, b] = [r5[i], r5[i + 1]];
    const five = separated(a, b, "standing");
    const nine = separated(a, b, "standingFine");
    total += 1;
    if (five && nine) held += 1;
    console.log(
      `  ${`${a} > ${b}`.padEnd(26)} ${(five ? "yes" : "OVERLAP").padStart(8)}   ${(nine ? "yes" : "OVERLAP").padStart(8)}`,
    );
  }
  console.log(
    `\n  >> ${held} of ${total} adjacent pairs are separated on BOTH scales. Those are the only\n` +
      "     parts of docs/35 §1's order this corpus establishes; the rest is a tie being\n" +
      "     printed in an order. Six games per game-type is the limit here, not the scale.\n",
  );

  // ----------------------------------------- and what the finer scale is doing

  console.log("\n§3 what the extra levels are used for");
  console.log("\n  scale        distinct values seen   at the extremes   in the middle band");
  for (const [label, get, span] of [
    ["5 levels", (r: MoveRow) => r.standing, 4],
    ["9 levels", (r: MoveRow) => r.standingFine, 8],
  ] as [string, (r: MoveRow) => number | undefined, number][]) {
    const vals = rows.map(get).filter((v): v is number => v !== undefined);
    if (vals.length === 0) continue;
    const distinct = new Set(vals.map((v) => v.toFixed(2))).size;
    const extreme = vals.filter((v) => v <= span * 0.125 || v >= span * 0.875).length;
    const middle = vals.filter((v) => v > span * 0.375 && v < span * 0.625).length;
    console.log(
      `  ${label.padEnd(12)} ${String(distinct).padStart(20)}   ` +
        `${`${((100 * extreme) / vals.length).toFixed(0)}%`.padStart(15)}   ` +
        `${`${((100 * middle) / vals.length).toFixed(0)}%`.padStart(18)}`,
    );
  }
  console.log(
    "\n  >> `score` returns a CONTINUOUS answer over the levels (docs/00), so neither\n" +
      "     scale is limited to its own integers and 'distinct values' is close to the\n" +
      "     ply count either way. The bands are the real question: if the nine-level\n" +
      "     answers pile into the middle, the four added levels bought resolution the\n" +
      "     judgment is not using.\n",
  );

  console.log(
    `  cost: ${record.usage.calls} requests, ${record.usage.input} input tokens, ` +
      `$${((record.usage.input / 1e6) * 0.042).toFixed(4)} -- the nine-level question rode along in ` +
      "requests that were being sent anyway.\n",
  );
}

main();
