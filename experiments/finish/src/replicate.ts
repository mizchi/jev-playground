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
    what: "asks issued, pooled over ALL arms (docs/43's headline denominator)",
    where: "§4b.3",
    of: (rows) => {
      const asked = rows.reduce((n, r) => n + r.askedByJev, 0);
      const cmds = rows.flatMap((r) => r.calls).filter((c) => c.tool === "Bash").length;
      return `${asked} of ${cmds}`;
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
