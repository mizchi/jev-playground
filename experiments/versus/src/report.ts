/**
 * The head-to-head, from the record. No API key, no CLI.
 *
 *   npx tsx src/report.ts
 *
 * Two readings that have to stay apart, because conflating them is the easiest
 * way to make this report say something it did not measure:
 *
 *   ACCURACY against the corpus label. What the corpus can settle.
 *   COST and LATENCY. Measured directly, and the axis where the answer is not
 *   close.
 *
 * AND THE FIRST VERSION OF THIS SCORED JEV'S OWN FEATURE AS A FAILURE. It read
 * `guard()`'s `verdict`, which is `null` for the five commands the FREE
 * PREFILTER passes without a request, and counted five nulls as five wrong
 * answers -- 79% instead of what `action` actually said. The prefilter not
 * spending a request is the package's first move, not a missing answer. Same
 * mistake shape as docs/29 §5, which was about counting a free stage's work
 * against the judgment's score; `run.ts` says so where it scores.
 *
 * And one asymmetry stated up front rather than in the limits: JEV IS ASKED
 * NINE WAYS AND COMBINED, THE MODEL IS ASKED ONCE. `jev-guard` runs a battery
 * and takes the conservative side of two independent readings; a model cannot
 * be handed nine `noul` probabilities, so it gets the three-level ladder that
 * docs/01 fitted. That is the closest comparable shape and it is not the same
 * shape. It favours Jev on accuracy and it is what ships.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Arm, Record_, Row, TaskName } from "./run.js";

const ARMS: Arm[] = ["jev", "haiku", "sonnet"];
const TASKS: TaskName[] = ["guard", "orchestration"];

const pct = (x: number, n: number): string => (n === 0 ? "    -" : `${((100 * x) / n).toFixed(0).padStart(4)}%`);

/** Jev's published price. Output is free (docs/00). */
const JEV_PER_MTOK = 0.042;

function main(): void {
  const path = resolve(import.meta.dirname, "../records/versus.json");
  if (!existsSync(path)) throw new Error("no records/versus.json -- run `npm run run` first");
  const rows = (JSON.parse(readFileSync(path, "utf8")) as Record_).rows;
  const of = (task: TaskName, arm: Arm): Row[] => rows.filter((r) => r.task === task && r.arm === arm);

  console.log("\n  The five components' decisions, made by jev and by two real models.");
  console.log(`  ${rows.length} rows. Labels are the corpora's own (docs/01, docs/31), not mine here.\n`);

  // ------------------------------------------------------------- §1 accuracy

  console.log("§1 accuracy against the corpus label");
  for (const task of TASKS) {
    const n = of(task, "jev").length || of(task, "haiku").length;
    if (n === 0) continue;
    console.log(`\n  ${task} (${n} items)`);
    console.log("  arm       what the host did   the gate had an opinion   median ms");
    for (const arm of ARMS) {
      const xs = of(task, arm);
      if (xs.length === 0) continue;
      const ms = [...xs.map((r) => r.ms)].sort((a, b) => a - b);
      const opined = xs.filter((r) => !r.abstained);
      const cell =
        arm === "jev" && xs.some((r) => r.abstained)
          ? `${pct(opined.filter((r) => r.correct).length, xs.length)} (${opined.filter((r) => r.correct).length}/${xs.length}, ${xs.length - opined.length} abstained)`
          : "same";
      console.log(
        `  ${arm.padEnd(8)} ${pct(xs.filter((r) => r.correct).length, xs.length)} ` +
          `(${xs.filter((r) => r.correct).length}/${xs.length})`.padEnd(11) +
          `${cell.padEnd(26)}${String(ms[Math.floor(ms.length / 2)] ?? 0).padStart(9)}`,
      );
    }
    const abst = of(task, "jev").filter((r) => r.abstained);
    if (abst.length > 0) {
      console.log(
        `\n  jev abstained on ${abst.length} of ${of(task, "jev").length}: ${abst.map((r) => r.item.slice(0, 18)).join(", ")}.\n` +
          "  `verdictOf` returns null when the ordered `permission` score comes back absent,\n" +
          "  and refuses to fall back to its weaker reading silently. `resolve()` then returns\n" +
          "  `pass`, which this report scores as `allow` -- and that is the generous reading.\n" +
          "  `pass` means THE HOST'S OWN RULES APPLY, not that jev approved anything, and a\n" +
          "  corpus cannot model the host's rules. The second column is the strict reading:\n" +
          "  on these items the gate did not decide.\n\n" +
          `  AND ONE OF THEM IS THE ONLY MISS: ${abst.filter((r) => !r.correct).map((r) => r.item).join(", ") || "none"}.\n` +
          "  So jev's single guard error is not a wrong judgment, it is an ABSENT one that\n" +
          "  defaulted permissive -- and docs/18's rule is that the conservative side is the\n" +
          "  safe one. An abstention that falls through to `pass` is the unsafe side.",
      );
    }
  }

  // ------------------------------------------- §2 where they disagree

  console.log("\n§2 the items that separate them");
  for (const task of TASKS) {
    const items = [...new Set(of(task, "jev").map((r) => r.item))];
    if (items.length === 0) continue;
    const interesting = items.filter((item) => {
      const answers = ARMS.map((a) => rows.find((r) => r.task === task && r.arm === a && r.item === item)?.answer);
      return new Set(answers.filter(Boolean)).size > 1;
    });
    console.log(`\n  ${task}: ${interesting.length} of ${items.length} items got more than one answer`);
    if (interesting.length === 0) continue;
    console.log("  item                                       want      jev       haiku     sonnet");
    for (const item of interesting) {
      const cell = (arm: Arm): string => {
        const r = rows.find((x) => x.task === task && x.arm === arm && x.item === item);
        if (!r) return "-".padEnd(9);
        return `${r.correct ? " " : "*"}${r.answer}`.padEnd(9);
      };
      const want = rows.find((x) => x.task === task && x.item === item)?.expect ?? "?";
      console.log(`  ${item.slice(0, 42).padEnd(42)} ${want.padEnd(9)} ${cell("jev")} ${cell("haiku")} ${cell("sonnet")}`);
    }
    console.log("  (* marks a wrong answer)");
  }

  // ------------------------------------------- §3 which way the errors go

  console.log("\n§3 which way the errors go, on the guard");
  console.log(
    "\n  A guard's two errors are not equal. Letting something through that should have\n" +
      "  been stopped is a different failure from stopping something harmless, and\n" +
      "  docs/18's rule is that the conservative side is the safe one.\n",
  );
  console.log("  arm       too permissive   too strict   exactly right");
  const RANK: Record<string, number> = { allow: 0, confirm: 1, block: 2 };
  for (const arm of ARMS) {
    const xs = of("guard", arm).filter((r) => RANK[r.answer] !== undefined);
    if (xs.length === 0) continue;
    const loose = xs.filter((r) => RANK[r.answer] < RANK[r.expect]).length;
    const tight = xs.filter((r) => RANK[r.answer] > RANK[r.expect]).length;
    console.log(
      `  ${arm.padEnd(8)} ${String(loose).padStart(14)} ${String(tight).padStart(12)} ${String(xs.length - loose - tight).padStart(14)}`,
    );
  }

  // ------------------------------------------------------------- §4 the cost

  console.log("\n§4 cost and latency, which is not close");
  console.log("\n  arm       median ms   total ms   input tokens   $ for this run   $ / 1,000 decisions");
  for (const arm of ARMS) {
    const xs = rows.filter((r) => r.arm === arm);
    if (xs.length === 0) continue;
    const ms = [...xs.map((r) => r.ms)].sort((a, b) => a - b);
    const tokens = xs.reduce((n, r) => n + (r.inputTokens ?? 0), 0);
    // The CLI does not report tokens, so a model's bill cannot be computed
    // from this record. Saying so is better than substituting a guess.
    const dollars = arm === "jev" ? `$${((tokens / 1e6) * JEV_PER_MTOK).toFixed(4)}` : "(not reported)";
    const per1k = arm === "jev" ? `$${((tokens / xs.length / 1e6) * JEV_PER_MTOK * 1000).toFixed(4)}` : "(not reported)";
    console.log(
      `  ${arm.padEnd(8)} ${String(ms[Math.floor(ms.length / 2)] ?? 0).padStart(9)} ` +
        `${String(xs.reduce((n, r) => n + r.ms, 0)).padStart(10)} ${String(tokens || 0).padStart(14)}   ` +
        `${dollars.padStart(14)}   ${per1k.padStart(19)}`,
    );
  }
  const jevMs = rows.filter((r) => r.arm === "jev").map((r) => r.ms);
  const medOf = (arm: Arm): number => {
    const xs = [...rows.filter((r) => r.arm === arm).map((r) => r.ms)].sort((a, b) => a - b);
    return xs[Math.floor(xs.length / 2)] ?? Number.NaN;
  };
  if (jevMs.length > 0 && Number.isFinite(medOf("haiku"))) {
    console.log(
      `\n  >> Jev's median decision is ${(medOf("haiku") / medOf("jev")).toFixed(0)}x faster than haiku's and ` +
        `${(medOf("sonnet") / medOf("jev")).toFixed(0)}x faster than sonnet's.\n` +
        "     That is the number the whole idea rests on: a guard sits on the critical path\n" +
        "     of every tool call, and docs/18 §1 gave it a 2,500 ms budget. A decision that\n" +
        "     takes eight seconds is not a guard, whatever its accuracy.",
    );
  }

  // ----------------------------------------------------- §5 what this is not

  console.log("\n§5 what this does NOT measure");
  console.log(
    "\n  - THE COMBINATION. `jev-hermes` asks all five components in ONE request per turn\n" +
      "    and docs/37 §6 measured that combining is NOT free -- 7 of 7 answers moved more\n" +
      "    between the two ways of asking than between repeats of one way. The rows above\n" +
      "    are components asked SEPARATELY, so they are an upper bound on the combined\n" +
      "    arm's accuracy, not a measurement of it.\n" +
      "  - END-TO-END TASK QUALITY. No model generates tokens behind these decisions here.\n" +
      "    docs/38 ran the real pi agent with a SCRIPTED model, so all five components are\n" +
      "    verified at the wire and none of them is verified to help an agent finish work.\n" +
      "  - THE MODELS' BILL. `claude -p` does not report tokens, so §4's dollar column is\n" +
      "    empty for them rather than guessed.\n" +
      "  - A FAIR SHAPE ON THE GUARD. Jev is asked nine ways and combined; the model is\n" +
      "    asked once, on the three-level ladder docs/01 fitted. That favours Jev.\n" +
      "  - ANY MODEL BUT THESE TWO. `claude -p` is what this container has.\n",
  );
}

main();
