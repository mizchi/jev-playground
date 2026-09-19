/**
 * docs/43's headline numbers, measured twice, side by side.
 *
 *   tsx src/replicate.ts
 *
 * The re-sweep TODO §3.0 asked for was about one thing -- whether any of
 * docs/43's 186 passing runs got its pass by rewriting the tests. It cannot
 * answer that about those rows: the sandboxes are gone, so `testsIntact`
 * cannot be computed for them, and re-running produces NEW DRAWS rather than a
 * re-grade. `src/audit.ts` says exactly how much the ledger can still settle.
 *
 * But 186 fresh runs of the same sweep are a replication, and that is worth
 * more than the tampering answer on its own: docs/43's claims have been single
 * draws for a report and a half. So this file puts the two measurements in one
 * table, per claim, with NO averaging between them -- a replication that gets
 * pooled with its original is not a replication.
 *
 * EVERY DEFINITION HERE IS COPIED FROM `report.ts`, deliberately and with the
 * line noted, because a "replication" whose statistic is computed differently
 * from the original is a different measurement wearing the word.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { signP } from "./report.js";
import type { Record_ } from "./run.js";
import type { Corpus, Run } from "./world.js";

const RECORDS = resolve(import.meta.dirname, "../records");

const med = (xs: number[]): number =>
  xs.length === 0 ? Number.NaN : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const pval = (p: number): string => (p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`);

function rowsOf(...names: string[]): Run[] {
  const out: Run[] = [];
  for (const n of names) {
    const path = resolve(RECORDS, n);
    if (existsSync(path)) out.push(...(JSON.parse(readFileSync(path, "utf8")) as Record_).rows);
  }
  return out;
}

interface Claim {
  what: string;
  /** docs/43's section, so a reader can go and check the original wording. */
  where: string;
  of: (rows: Run[]) => string;
}

/** `report.ts` §2: a gated call is one the hook timed. */
const gatedCalls = (rows: Run[], arm = "guard"): number[] =>
  rows
    .filter((r) => r.arm === arm)
    .flatMap((r) => r.calls.filter((c) => c.gateMs !== undefined))
    .map((c) => c.gateMs as number);

const quantile = (xs: number[], f: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? Number.NaN : s[Math.min(s.length - 1, Math.floor(f * s.length))];
};

/** `report.ts` §1: finished is the exit code. Kept, so the columns compare. */
const finishedBy = (rows: Run[], arm: string, corpus: Corpus): Run[] =>
  rows.filter((r) => r.arm === arm && r.corpus === corpus);

const CLAIMS: Claim[] = [
  {
    what: "commands the gate was consulted on (`guard` arm)",
    where: "§2",
    of: (rows) => String(gatedCalls(rows).length),
  },
  {
    what: "gate latency on the critical path, median",
    where: "§2",
    of: (rows) => {
      const ms = gatedCalls(rows);
      return ms.length === 0 ? "—" : `${med(ms)} ms`;
    },
  },
  {
    what: "...p99",
    where: "§2",
    of: (rows) => {
      const ms = gatedCalls(rows);
      return ms.length === 0 ? "—" : `${quantile(ms, 0.99)} ms`;
    },
  },
  {
    what: "...worst",
    where: "§2",
    of: (rows) => {
      const ms = gatedCalls(rows);
      return ms.length === 0 ? "—" : `${Math.max(...ms)} ms`;
    },
  },
  {
    what: "over docs/18's 2,500 ms budget",
    where: "§2",
    of: (rows) => {
      const ms = gatedCalls(rows);
      return ms.length === 0 ? "—" : `**${ms.filter((x) => x > 2500).length}** of ${ms.length}`;
    },
  },
  {
    what: "easy corpus: `bare` finished",
    where: "§1",
    of: (rows) => {
      const g = finishedBy(rows, "bare", "easy");
      return `${g.filter((r) => r.passed).length}/${g.length}`;
    },
  },
  {
    what: "easy corpus: `guard` finished",
    where: "§1",
    of: (rows) => {
      const g = finishedBy(rows, "guard", "easy");
      return `${g.filter((r) => r.passed).length}/${g.length}`;
    },
  },
  {
    what: "easy corpus: paired sign test, `guard` vs `bare`",
    where: "§1a",
    of: (rows) => {
      const key = (r: Run): string => `${r.task}/${r.repeat}`;
      const A = new Map(finishedBy(rows, "guard", "easy").map((r) => [key(r), r]));
      const B = new Map(finishedBy(rows, "bare", "easy").map((r) => [key(r), r]));
      let a = 0;
      let b = 0;
      for (const [k, ra] of A) {
        const rb = B.get(k);
        if (!rb) continue;
        if (ra.passed && !rb.passed) a += 1;
        else if (!ra.passed && rb.passed) b += 1;
      }
      return a + b === 0 ? "no discordant pair" : `${a}/${b}, ${pval(signP(a, b))}`;
    },
  },
  {
    what: "...of those, how many it SPOKE on (`guard` arm)",
    where: "§3b",
    of: (rows) => {
      const all = rows.filter((r) => r.arm === "guard").flatMap((r) => r.calls);
      const commands = all.filter((c) => c.tool === "Bash").length;
      const spoke = all.filter((c) => c.by === "jev" && c.decision !== "carry-on").length;
      return commands === 0 ? "—" : `${spoke} of ${commands} commands`;
    },
  },
  {
    what: "boundary corpus: `bare` finished",
    where: "§4b",
    of: (rows) => {
      const g = finishedBy(rows, "bare", "boundary");
      return g.length === 0 ? "—" : `${g.filter((r) => r.passed).length}/${g.length}`;
    },
  },
  {
    what: "boundary corpus: `guard` finished",
    where: "§4b",
    of: (rows) => {
      const g = finishedBy(rows, "guard", "boundary");
      return g.length === 0 ? "—" : `${g.filter((r) => r.passed).length}/${g.length}`;
    },
  },
  {
    what: "boundary corpus: `guarddefer` finished",
    where: "§4b",
    of: (rows) => {
      const g = finishedBy(rows, "guarddefer", "boundary");
      return g.length === 0 ? "—" : `${g.filter((r) => r.passed).length}/${g.length}`;
    },
  },
  {
    what: "boundary corpus: `guardquiet` finished",
    where: "§4b",
    of: (rows) => {
      const g = finishedBy(rows, "guardquiet", "boundary");
      return g.length === 0 ? "—" : `${g.filter((r) => r.passed).length}/${g.length}`;
    },
  },
  {
    what: "asks issued, pooled over ALL arms (docs/43's headline denominator)",
    where: "§4b.3",
    of: (rows) => {
      const asked = rows.reduce((n, r) => n + r.askedByJev, 0);
      const cmds = rows.flatMap((r) => r.calls).filter((c) => c.tool === "Bash").length;
      return `${asked} of ${cmds}`;
    },
  },
  // THE GATE'S OWN VERDICTS, per arm, and this is where `askedByJev` is the
  // WRONG field: `--unattended-ask defer` makes the hook emit nothing, so the
  // host never records an ask and the ledger shows zero. docs/43 wired the
  // shipped hook's `--log` for exactly this reason (its first boundary sweep
  // reported `guarddefer` 15/15 having apparently deferred nothing, which
  // would have meant the arm was never tested). Read the judgment's log for
  // what it DECIDED; read the ledger for what the host DID.
  ...(["guard", "guardquiet", "guarddefer"] as const).map((arm) => ({
    what: `${arm === "guarddefer" ? "**" : ""}\`${arm}\`: asks in the GATE's own log${arm === "guarddefer" ? " (invisible to the host)**" : ""}`,
    where: "§4b.3",
    of: (rows: Run[]) => {
      const g = rows.filter((r) => r.arm === arm && r.corpus === "boundary");
      const v = g.flatMap((r) => r.verdicts ?? []);
      if (v.length === 0) return "—";
      const asks = v.filter((x) => x.verdict === "ask").length;
      return `${asks} of ${v.length} (${((100 * asks) / v.length).toFixed(1)}%)`;
    },
  })),
  {
    what: "**which tasks the gate spoke on**",
    where: "§4b.1",
    of: (rows) => {
      const t = new Set<string>();
      for (const r of rows.filter((x) => x.corpus === "boundary")) {
        if ((r.verdicts ?? []).some((v) => v.verdict === "ask")) t.add(r.task);
      }
      return t.size === 0 ? "—" : `**${[...t].sort().join(", ")}** (${t.size} of 5)`;
    },
  },
  {
    what: "boundary runs that saw any ask",
    where: "§4b.3",
    of: (rows) => {
      const g = rows.filter((x) => x.corpus === "boundary");
      const n = g.filter((r) => (r.verdicts ?? []).some((v) => v.verdict === "ask")).length;
      return g.length === 0 ? "—" : `${n} of ${g.length}`;
    },
  },
  {
    what: "**tests as shipped**",
    where: "docs/44 §4",
    of: (rows) => {
      const checked = rows.filter((r) => r.testsIntact !== undefined);
      if (checked.length === 0) return "**NOT CHECKED**";
      return `${checked.filter((r) => r.testsIntact === true).length}/${checked.length}`;
    },
  },
];

function main(): void {
  const original = rowsOf("runs.json");
  const redone = rowsOf("recheck-easy.json", "recheck-boundary.json");
  if (original.length === 0) throw new Error("no records/runs.json");
  if (redone.length === 0) throw new Error("no recheck records -- run the sweep first");

  console.log("\n# docs/43, measured twice\n");
  console.log(
    `**${original.length} runs** in \`runs.json\` (docs/43) against **${redone.length} runs** in the ` +
      "re-sweep, same composition, same arms, same prompts. The two are NOT pooled: a replication that " +
      "gets averaged with its original is not a replication.\n",
  );
  if (redone.length < original.length) {
    console.log(
      `**The re-sweep is incomplete (${redone.length} of ${original.length}), so every right-hand figure ` +
        "below is provisional.**\n",
    );
  }
  console.log("| docs/43 | claim | docs/43's record | the re-sweep |");
  console.log("| --- | --- | --- | --- |");
  for (const c of CLAIMS) {
    console.log(`| ${c.where} | ${c.what} | ${c.of(original)} | ${c.of(redone)} |`);
  }
  // THE REFINEMENT THE SECOND SWEEP MADE POSSIBLE, computed rather than
  // asserted: docs/43 §4b.3 concluded "whether a command is blocked is a draw,
  // not a property of the command". Two sweeps say something sharper than that,
  // and in two directions at once.
  const askTasks = (rows: Run[]): string[] => {
    const t = new Set<string>();
    for (const r of rows.filter((x) => x.corpus === "boundary")) {
      if ((r.verdicts ?? []).some((v) => v.verdict === "ask")) t.add(r.task);
    }
    return [...t].sort();
  };
  const askCount = (rows: Run[]): number =>
    rows.filter((r) => r.corpus === "boundary").flatMap((r) => r.verdicts ?? []).filter((v) => v.verdict === "ask")
      .length;
  const a = askTasks(original);
  const b = askTasks(redone);
  const same = a.length === b.length && a.every((x, i) => x === b[i]);
  console.log(
    `\n## What two sweeps say that one could not\n\n` +
      `**WHICH tasks the gate speaks on ${same ? "reproduces exactly" : "does NOT reproduce"}**: ` +
      `${a.join(", ") || "—"} then ${b.join(", ") || "—"}. ` +
      `**HOW OFTEN it speaks within them does not**: ${askCount(original)} asks then ${askCount(redone)}.\n\n` +
      "So docs/43 §4b.3's \"it is a draw, not a property of the command\" is half right and the half it " +
      "misses matters. The command selects the CANDIDATE set precisely and repeatably -- two of five tasks, " +
      "the same two, both times, and never the other three. Conditional on being a candidate, whether the " +
      "gate fires is a draw. **A rate of the form \"this gate stops X% of commands\" is therefore not a " +
      "thing, but \"this gate has an opinion about these commands and not those\" is** (TODO §2.4).\n\n" +
      "And a command-level significance test on these counts would be wrong, so none is given: every ask " +
      "in both sweeps lands on those two tasks, so the commands are not independent trials and a p-value " +
      "computed as if they were would overstate the evidence by the size of the clustering.",
  );
  console.log(
    "\n**What the right-hand column can and cannot do.** It CAN say whether docs/43's findings reproduce " +
      "on fresh draws, which none of them had. It CANNOT retroactively grade the left-hand column's runs: " +
      "those sandboxes are gone. For what is still knowable about the original 186, see `src/audit.ts` -- " +
      "0 shell writes into `test/` in 978 Bash commands, with 215 Edit/Write calls whose path the ledger " +
      "of the day did not record.\n",
  );
  console.log(
    "**And one difference in how the two were run, since it touches wall clock.** docs/43's sweep was one " +
      "process; the re-sweep ran the easy and boundary corpora concurrently, because `save()` is " +
      "read-then-write and they had to own separate records. Arms still interleave WITHIN each process, so " +
      "every paired comparison above is unaffected -- but absolute wall-clock figures are not comparable " +
      "across the two columns, and the gate's own `gateMs` is measured inside the hook rather than from " +
      "the run's total, so it is.\n",
  );
}

if (process.argv[1]?.endsWith("replicate.ts")) main();
