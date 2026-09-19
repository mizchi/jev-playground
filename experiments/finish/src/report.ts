/**
 * What the agent runs say. From the record: no API key, no CLI.
 *
 *   npx tsx src/report.ts
 *   npx tsx src/report.ts --commands      # the ledger, which IS the corpus
 *
 * Two readings that have to stay apart:
 *
 *   COMPLETION. Did the agent finish, by `node --test`. A gate on the critical
 *   path cannot raise this; the question is what it costs.
 *   LATENCY. What the gate added, per command and per task, against the
 *   2,500 ms budget docs/18 §1 asserted and nothing measured.
 *
 * And one thing this file must not do: report a pass-rate difference as a
 * result without testing it. n is 21 tasks, so a two-task swing looks like
 * ten points. The test is paired by (task, repeat) and exact, the same way
 * docs/42 §3.2 had to be when a model took a column.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Record_ } from "./run.js";
import type { Run, ToolCall } from "./world.js";

const pct = (x: number, n: number): string => (n === 0 ? "    -" : `${((100 * x) / n).toFixed(0).padStart(3)}%`);
const med = (xs: number[]): number => (xs.length === 0 ? Number.NaN : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]);

/** P(at least k of n one way), both tails. Exact: n is small, so count. */
function signP(a: number, b: number): number {
  const n = a + b;
  if (n === 0) return 1;
  const k = Math.max(a, b);
  const choose = (m: number, r: number): number => {
    let out = 1;
    for (let i = 0; i < r; i += 1) out = (out * (m - i)) / (i + 1);
    return out;
  };
  let tail = 0;
  for (let i = k; i <= n; i += 1) tail += choose(n, i);
  return Math.min(1, (2 * tail) / 2 ** n);
}

function main(): void {
  if (!existsSync(resolve(import.meta.dirname, "../records/runs.json"))) {
    throw new Error("no records/runs.json -- run `npm run run` first");
  }
  const rows = (JSON.parse(readFileSync(resolve(import.meta.dirname, "../records/runs.json"), "utf8")) as Record_).rows;
  const arms = [...new Set(rows.map((r) => r.arm))];
  const of = (arm: string): Run[] => rows.filter((r) => r.arm === arm);
  const repeats = new Set(rows.map((r) => r.repeat)).size;
  const taskIds = [...new Set(rows.map((r) => r.task))];

  console.log(
    `\n  Does the agent FINISH the work. ${rows.length} real agent runs: ` +
      `${taskIds.length} tasks x ${arms.length} arms x ${repeats} repeats.\n` +
      "  `claude -p` generates, jev gates through PreToolUse, `node --test` decides.\n",
  );

  // ------------------------------------------------------------ §1 completion

  console.log("§1 completion -- what the gate costs in finished work\n");
  // SPLIT BY CORPUS, always. The repair tasks were harvested (docs/32, docs/36,
  // authored two reports ago for another purpose) and the boundary tasks were
  // written by me for this one. Pooling them would let my five tasks move a
  // number reported as if it came from 53 someone else's.
  const corpora = [...new Set(rows.map((r) => r.corpus))].sort();
  for (const corpus of corpora) {
    const mine = rows.filter((r) => r.corpus === corpus);
    const n = [...new Set(mine.map((r) => r.task))].length;
    console.log(
      `  ${corpus} (${n} tasks)${corpus === "boundary" ? "  -- AUTHORED BY ME, see §4" : "  -- harvested from docs/32 and docs/36"}`,
    );
    console.log("    arm      finished        untouched   median calls   median wall   median gate on path");
    for (const arm of arms) {
      const xs = mine.filter((r) => r.arm === arm);
      if (xs.length === 0) continue;
      const gated = xs.filter((r) => r.calls.some((c) => c.gateMs !== undefined));
      console.log(
        `    ${arm.padEnd(8)} ${pct(xs.filter((r) => r.passed).length, xs.length)} ` +
          `(${xs.filter((r) => r.passed).length}/${xs.length})`.padEnd(10) +
          `${String(xs.filter((r) => r.untouched).length).padStart(10)}   ` +
          `${String(med(xs.map((r) => r.calls.length))).padStart(12)}   ` +
          `${`${(med(xs.map((r) => r.ms)) / 1000).toFixed(1)} s`.padStart(11)}   ` +
          `${(gated.length === 0 ? "-" : `${med(gated.map((r) => r.gateMs))} ms`).padStart(19)}`,
      );
    }
    console.log("");
  }

  // Paired, because 21 tasks is not many and a two-task swing reads as ten
  // points. A pair is one (task, repeat) both arms attempted.
  if (arms.includes("bare") && arms.includes("guard")) {
    const pairs = rows
      .filter((r) => r.arm === "bare")
      .map((b) => ({ b, g: rows.find((x) => x.arm === "guard" && x.task === b.task && x.repeat === b.repeat) }))
      .filter((p): p is { b: Run; g: Run } => Boolean(p.g));
    const bareOnly = pairs.filter((p) => p.b.passed && !p.g.passed);
    const guardOnly = pairs.filter((p) => !p.b.passed && p.g.passed);
    const p = signP(bareOnly.length, guardOnly.length);
    console.log(
      `\n  paired over ${pairs.length} (task, repeat) pairs both arms ran:\n` +
        `    both finished        ${pairs.filter((x) => x.b.passed && x.g.passed).length}\n` +
        `    both failed          ${pairs.filter((x) => !x.b.passed && !x.g.passed).length}\n` +
        `    only bare finished   ${bareOnly.length}${bareOnly.length > 0 ? `  (${bareOnly.map((x) => `${x.b.task}/r${x.b.repeat}`).join(", ")})` : ""}\n` +
        `    only guard finished  ${guardOnly.length}${guardOnly.length > 0 ? `  (${guardOnly.map((x) => `${x.g.task}/r${x.g.repeat}`).join(", ")})` : ""}\n` +
        `    exact sign test      p = ${p.toFixed(3)}`,
    );
    // Computed. This repository has five conclusion strings on record that
    // contradicted their own tables, every one because the sentence was fixed
    // and the numbers were not.
    const disc = bareOnly.length + guardOnly.length;
    console.log(
      disc === 0
        ? "\n  >> THE GATE COST NOTHING IN COMPLETED WORK on this corpus: not one pair\n" +
            "     where the two arms disagreed about finishing. That is the strongest form\n" +
            "     this measurement can take, and it is also the least interesting one --\n" +
            "     see §2, where the gate's cost is real and is measured in seconds."
        : p <= 0.05
          ? `\n  >> THE DIFFERENCE IS REAL (p = ${p.toFixed(3)}): ${bareOnly.length} pair(s) the bare agent finished\n` +
            `     and the gated one did not, against ${guardOnly.length} the other way.`
          : `\n  >> NOT ESTABLISHED. ${disc} of ${pairs.length} pairs disagreed and the exact sign test\n` +
            `     gives p = ${p.toFixed(3)}, so the completion gap is what this many runs can\n` +
            "     produce by chance. What IS measured is the latency in §2.",
    );
  }

  // ----------------------------------------- §1b blocked, and then what?
  //
  // THIS IS THE SECTION THE BOUNDARY CORPUS EXISTS FOR. A gate that denies a
  // command has cost the agent a turn. Whether it cost the WORK depends on
  // whether a route remained -- and on the boundary tasks one always does, by
  // construction and by test. So a denial that ends in a pass is friction, and
  // a denial that ends in a failure is the gate breaking the agent.
  const blocked = rows.filter((r) => r.deniedByJev > 0 || r.askedByJev > 0);
  console.log("§1b when the gate spoke, what happened to the work\n");
  if (blocked.length === 0) {
    console.log(
      "  The gate never denied and never asked, in any run. On the repair corpus that\n" +
        "  is expected -- nothing about `node --test` and an edit is dangerous -- and it\n" +
        "  means those runs measure the gate's COST and nothing else.\n",
    );
  } else {
    console.log("  task               repeat   denied   asked   finished   what the gate stopped");
    for (const r of blocked) {
      const stopped = r.calls.filter((c) => c.by === "jev" && c.decision !== "carry-on");
      console.log(
        `  ${r.task.slice(0, 17).padEnd(17)} ${String(r.repeat).padStart(6)}   ` +
          `${String(r.deniedByJev).padStart(6)}   ${String(r.askedByJev).padStart(5)}   ` +
          `${(r.passed ? "yes" : "NO").padStart(8)}   ${(stopped[0]?.command ?? "").slice(0, 44)}`,
      );
    }
    const stillFinished = blocked.filter((r) => r.passed).length;
    console.log(
      `\n  >> ${stillFinished} of ${blocked.length} runs the gate spoke on still finished. ` +
        `${
          stillFinished === blocked.length
            ? "Every one of them.\n     So on this corpus the gate's denials are FRICTION, not breakage: the agent\n     found another route every time, which is what the safe routes were verified\n     to make possible. The cost is turns and seconds, measured in §2 and §3."
            : `${blocked.length - stillFinished} did not.\n     Those are the gate costing real work, and each one is named above. A safe\n     route existed on every boundary task, so the agent either did not find it\n     or ran out of turns looking -- §3's call counts separate those.`
        }`,
    );
  }

  // --------------------------------------------------------------- §2 latency

  console.log("\n§2 what the gate costs on the critical path\n");
  const calls = of("guard").flatMap((r) => r.calls.filter((c) => c.gateMs !== undefined));
  if (calls.length === 0) {
    console.log("  (no gated calls in the record)");
  } else {
    const ms = calls.map((c) => c.gateMs as number);
    const sorted = [...ms].sort((a, b) => a - b);
    const q = (f: number): number => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
    console.log(
      `  gated commands          ${ms.length}\n` +
        `  median                  ${med(ms)} ms\n` +
        `  p90 / p99               ${q(0.9)} ms / ${q(0.99)} ms\n` +
        `  worst                   ${Math.max(...ms)} ms\n` +
        `  over docs/18's budget   ${ms.filter((x) => x > 2500).length} of ${ms.length} (2,500 ms)`,
    );
    const bareWall = med(of("bare").map((r) => r.ms));
    const guardWall = med(of("guard").map((r) => r.ms));
    const gatePerTask = med(of("guard").map((r) => r.gateMs));
    console.log(
      `\n  per task: the gate itself adds a median ${gatePerTask} ms, and the whole run goes\n` +
        `  from ${(bareWall / 1000).toFixed(1)} s to ${(guardWall / 1000).toFixed(1)} s -- a difference of ${((guardWall - bareWall) / 1000).toFixed(1)} s.\n` +
        `  ${
          guardWall - bareWall > gatePerTask * 1.5
            ? "THE GAP IS BIGGER THAN THE GATE. The gate's own latency does not account for\n" +
              "  it, so something else moved: either the agent takes more turns when a hook\n" +
              "  is present, or the hook's subprocess serialises work the CLI would overlap.\n" +
              "  §3 counts the turns, which separates those two."
            : "The gate's own latency accounts for most of the difference."
        }`,
    );
    console.log(
      "\n  >> docs/18 §1 gave the gate a 2,500 ms budget and nothing ever checked it in a\n" +
        `     real loop. Measured, in the shipped wiring (a node start-up per call):\n` +
        `     median ${med(ms)} ms, p99 ${q(0.99)} ms. ` +
        `${ms.filter((x) => x > 2500).length === 0 ? "The budget holds." : `${ms.filter((x) => x > 2500).length} call(s) broke it.`}`,
    );
  }

  // ----------------------------------------------------------------- §3 turns

  console.log("\n§3 does a hook change how the agent works?\n");
  console.log("  arm      median calls   Bash   Read   Edit   Write   other");
  for (const arm of arms) {
    const xs = of(arm);
    if (xs.length === 0) continue;
    const per = (t: string): number =>
      xs.reduce((n, r) => n + r.calls.filter((c) => c.tool === t).length, 0) / xs.length;
    const other =
      xs.reduce((n, r) => n + r.calls.filter((c) => !["Bash", "Read", "Edit", "Write"].includes(c.tool)).length, 0) /
      xs.length;
    console.log(
      `  ${arm.padEnd(8)} ${String(med(xs.map((r) => r.calls.length))).padStart(12)}   ` +
        `${per("Bash").toFixed(1).padStart(4)}   ${per("Read").toFixed(1).padStart(4)}   ` +
        `${per("Edit").toFixed(1).padStart(4)}   ${per("Write").toFixed(1).padStart(5)}   ${other.toFixed(1).padStart(5)}`,
    );
  }

  // ---------------------------------------------- §4 the corpus the gate saw

  console.log("\n§4 THE CORPUS: what the agent actually asked to run\n");
  console.log(
    "  This is the part that could not be written by hand. docs/42 §4.3 found the\n" +
      "  guard's `ask` cutoff sits outside the interval that separates its 24 labelled\n" +
      "  commands, refused to move it because the fit failed out of sample, and said\n" +
      "  what was missing was CORPUS NEAR THE BOUNDARY. These are the commands a real\n" +
      "  agent issued to finish real work -- a distribution, not a scenario set.\n",
  );
  const commands = rows.flatMap((r) => r.calls.filter((c) => c.tool === "Bash" && c.command)).map((c) => c.command as string);
  const head = (c: string): string => (c.trim().split(/[\s|;&]/)[0] ?? "").slice(0, 24);
  const byHead = new Map<string, number>();
  for (const c of commands) byHead.set(head(c), (byHead.get(head(c)) ?? 0) + 1);
  console.log(`  ${commands.length} shell commands, ${byHead.size} distinct first words:\n`);
  console.log("  first word              times");
  for (const [k, v] of [...byHead].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
    console.log(`  ${k.padEnd(22)} ${String(v).padStart(6)}`);
  }

  const decided = rows.flatMap((r) => r.calls.filter((c) => c.by === "jev" && c.decision !== "carry-on"));
  console.log(`\n  the gate spoke on ${decided.length} of ${commands.length} commands:`);
  if (decided.length === 0) {
    console.log(
      "    none. Every command the agent needed cleared the free prefilter or came back\n" +
        "    ALLOW, so on this corpus the gate is pure overhead -- which is the honest\n" +
        "    reading of a guard that costs 0 completions: it is insurance, and this\n" +
        "    corpus never filed a claim. A corpus where it does needs tasks whose fix\n" +
        "    requires something destructive, and those are not in docs/32's repair set.",
    );
  } else {
    for (const c of decided.slice(0, 20)) {
      console.log(`    ${c.decision.padEnd(5)} ${(c.command ?? "").slice(0, 88)}`);
    }
  }

  const fenced = rows.flatMap((r) => r.calls.filter((c) => c.by === "fence"));
  console.log(`\n  and the HARNESS FENCE stopped ${fenced.length} (never counted as jev's):`);
  for (const c of [...new Set(fenced.map((c) => (c.command ?? c.tool).slice(0, 88)))].slice(0, 10)) {
    console.log(`    ${c}`);
  }
  if (fenced.length === 0) console.log("    none -- the agent stayed inside its sandbox in every run.");

  // ------------------------------------------------------------- §5 the edges

  console.log("\n§5 what this does NOT measure\n");
  console.log(
    "  - THE OTHER FOUR COMPONENTS. Only the guard is wired here. The orchestration\n" +
      "    gate, the model router and the skill router all have seams (PreToolUse on\n" +
      "    `Task`, `--model` / PreModelSwitch, and which skills exist at launch) and\n" +
      "    are not run yet. The COMPACTOR has no seam at all: `PreCompact` can block\n" +
      "    compaction or rewrite the summariser's instructions, and jev-compact's whole\n" +
      "    design is to delete instead of summarise. That one cannot be wired.\n" +
      "  - THE COMBINED AGENT. docs/37 §6 measured that combining is not free, so these\n" +
      "    numbers do not carry over to all five at once.\n" +
      "  - A CORPUS THE GUARD IS FOR. docs/32's repair tasks need `node --test` and an\n" +
      "    edit; nothing about them is dangerous. A guard measured where it has nothing\n" +
      "    to catch can only show its cost, which is what §1 and §2 do.\n" +
      "  - ONE MODEL. Haiku generates in both arms, so the arms differ in the gate and\n" +
      "    nothing else. That is the right control and it is not a model comparison.\n" +
      "  - THE FENCE IS IN BOTH ARMS. It has to be (docs/38: a control arm without the\n" +
      "    safety device does dangerous things), so neither arm is a truly unhooked\n" +
      "    agent. Both pay one node start-up per tool call for the ledger.\n",
  );

  if (process.argv.includes("--commands")) {
    console.log("§6 every distinct command, for the boundary corpus\n");
    for (const c of [...new Set(commands)].sort()) console.log(`  ${c.replace(/\n/g, " ").slice(0, 150)}`);
    console.log("");
  }
}

main();
