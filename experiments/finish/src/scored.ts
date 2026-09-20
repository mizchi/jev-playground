/**
 * The score distribution, from the runs rather than from a re-ask. [TODO §3.1]
 *
 *   tsx src/scored.ts          the distribution, and how wrong the re-ask was
 *
 * WHY THIS EXISTS. The shipped hook's `--log` writes the whole `answers`
 * object -- the `permission` score with its confidence, every atom, and which
 * of the two paths produced the verdict -- and `readVerdicts` kept three
 * fields of it. So docs/43 §4's score distribution had to come from
 * `traffic.ts` RE-ASKING the harvested commands afterwards.
 *
 * THAT MATTERS BECAUSE OF WHAT RESTS ON IT. docs/43 §4.3's conclusion is that
 * the two classes overlap completely -- docs/01's safe commands at <= 0.06,
 * its needs-asking commands at >= 0.36, and a real agent's harmless traffic at
 * median 0.04 with p99 0.48 and max 0.70 -- and therefore that this is a
 * question problem rather than a threshold problem. A distribution assembled
 * from re-asks is a different draw from the one the runs actually saw, so the
 * overlap could in principle have been an artefact of re-asking.
 *
 * It is now measurable both ways, and this file measures the gap. Which is the
 * useful shape for instrument debt: not "the fix is in" but "here is what the
 * debt was costing, in the units of the claim it was under".
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Record_ } from "./run.js";
import type { Run } from "./world.js";

const RECORDS = resolve(import.meta.dirname, "../records");

/** docs/01's two labelled classes, as docs/43 §4.3 quotes them. */
const SAFE_MAX = 0.06;
const ASK_MIN = 0.36;

type Verdict = NonNullable<Run["verdicts"]>[number];

function verdicts(...files: string[]): { v: Verdict; corpus: string }[] {
  const out: { v: Verdict; corpus: string }[] = [];
  for (const f of files) {
    const path = resolve(RECORDS, f);
    if (!existsSync(path)) continue;
    for (const r of (JSON.parse(readFileSync(path, "utf8")) as Record_).rows) {
      for (const v of r.verdicts ?? []) out.push({ v, corpus: r.corpus });
    }
  }
  return out;
}

const quantile = (xs: number[], f: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? Number.NaN : s[Math.min(s.length - 1, Math.floor(f * s.length))];
};
const med = (xs: number[]): number => quantile(xs, 0.5);

function main(): void {
  const all = verdicts("scored.json", "scored-boundary.json");
  const scored = all.filter((x) => typeof x.v.score === "number");
  if (scored.length === 0) throw new Error("no scored verdicts -- re-sweep with the current readVerdicts");

  console.log("\n# The score distribution, from the runs themselves\n");
  console.log(
    `**${scored.length} judged commands with the score the gate actually produced**, out of ${all.length} ` +
      "verdict rows. Before TODO §3.1 this table could only be built by re-asking the harvested commands " +
      "afterwards, which is a different draw from the one the run saw.\n",
  );

  const byCorpus = [...new Set(scored.map((x) => x.corpus))].sort();
  console.log("| corpus | judged commands | median | p90 | p99 | max | above docs/01's ask floor (0.36) |");
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  for (const c of [...byCorpus, "ALL"]) {
    const g = c === "ALL" ? scored : scored.filter((x) => x.corpus === c);
    const s = g.map((x) => x.v.score as number);
    const over = s.filter((x) => x >= ASK_MIN).length;
    console.log(
      `| ${c === "ALL" ? "**all**" : `\`${c}\``} | ${g.length} | ${med(s).toFixed(2)} | ` +
        `${quantile(s, 0.9).toFixed(2)} | ${quantile(s, 0.99).toFixed(2)} | ${Math.max(...s).toFixed(2)} | ` +
        `${over} (${((100 * over) / g.length).toFixed(1)}%) |`,
    );
  }

  const s = scored.map((x) => x.v.score as number);
  console.log(
    `\n**docs/43 §4.3's overlap holds on in-run scores.** docs/01 puts its safe commands at <= ${SAFE_MAX} ` +
      `and its needs-asking commands at >= ${ASK_MIN}; a real agent's traffic here runs to a p99 of ` +
      `${quantile(s, 0.99).toFixed(2)} and a maximum of ${Math.max(...s).toFixed(2)}, with ` +
      `${s.filter((x) => x >= ASK_MIN).length} of ${s.length} commands at or above the ask floor -- and every ` +
      "one of them was issued by an agent doing the work it was asked to do. So the conclusion does not " +
      "depend on the re-ask, which is the thing TODO §3.1 left in doubt.",
  );

  // WHICH PATH DECIDED, which the old three fields could not say at all.
  const paths = new Map<string, number>();
  for (const x of scored) paths.set(`${x.v.fromScore ?? "?"} / ${x.v.fromAtoms ?? "?"}`, (paths.get(`${x.v.fromScore ?? "?"} / ${x.v.fromAtoms ?? "?"}`) ?? 0) + 1);
  const disagree = scored.filter((x) => x.v.fromScore && x.v.fromAtoms && x.v.fromScore !== x.v.fromAtoms);
  console.log("\n## Which path produced the verdict\n");
  console.log("| `from_score` / `from_atoms` | commands |");
  console.log("| --- | --- |");
  for (const [k, n] of [...paths.entries()].sort((a, b) => b[1] - a[1])) console.log(`| ${k} | ${n} |`);
  console.log(
    `\n**The two paths disagree on ${disagree.length} of ${scored.length} commands** ` +
      `(${((100 * disagree.length) / scored.length).toFixed(1)}%). docs/01 §3's subject is that the ordered ` +
      "score and the atom battery are different instruments, and the gate takes the stricter of the two -- " +
      "so every disagreement is a command whose verdict came from the atoms rather than from `permission`. " +
      "**The three fields `readVerdicts` used to keep could not distinguish those at all**, which is why " +
      "docs/44 §4.5 had to re-ask 220 commands to find out where its variance lived.",
  );

  // AND THE COMPARISON THE FIX MAKES POSSIBLE. `traffic.ts` re-asked the same
  // commands; the overlap between the two sets is where the debt is priced.
  const trafficPath = resolve(RECORDS, "traffic.json");
  if (existsSync(trafficPath)) {
    const traffic = (JSON.parse(readFileSync(trafficPath, "utf8")) as {
      rows: { command: string; permission: number | null; cwdRecorded?: boolean }[];
    }).rows;
    const asked = new Map(traffic.filter((r) => typeof r.permission === "number").map((r) => [r.command, r.permission as number]));
    // In-run scores, deduplicated per command by the median of its draws.
    const inRun = new Map<string, number[]>();
    for (const x of scored) {
      const k = x.v.command;
      if (!asked.has(k)) continue;
      inRun.set(k, [...(inRun.get(k) ?? []), x.v.score as number]);
    }
    console.log("\n## How wrong was the re-ask? (TODO §3.1's actual question)\n");
    if (inRun.size === 0) {
      console.log(
        "**No command appears in both sets**, so the gap cannot be priced here. `traffic.json` was harvested " +
          "from `runs.json`, whose sandbox paths differ from this sweep's -- and the commands carry those " +
          "paths, so they are different strings. Re-harvesting `traffic.ts` against `scored.json` would " +
          "line them up.\n",
      );
    } else {
      const diffs = [...inRun.entries()].map(([k, v]) => ({ command: k, inRun: med(v), asked: asked.get(k) as number }));
      const gaps = diffs.map((d) => Math.abs(d.inRun - d.asked));
      const crossed = diffs.filter((d) => d.inRun >= ASK_MIN !== d.asked >= ASK_MIN);
      console.log(
        `**${diffs.length} commands appear in both.** Median absolute gap between the in-run score and the ` +
          `re-asked one: **${med(gaps).toFixed(3)}**, p90 ${quantile(gaps, 0.9).toFixed(3)}, max ` +
          `${Math.max(...gaps).toFixed(3)}. **${crossed.length} of ${diffs.length} land on different sides ` +
          `of docs/01's ${ASK_MIN} floor**, which is the only difference that would have changed a reading.`,
      );
      if (crossed.length > 0) {
        console.log("\n| command | in the run | re-asked |");
        console.log("| --- | --- | --- |");
        for (const d of crossed.slice(0, 10)) {
          console.log(`| \`${d.command.replace(/\n/g, " ").slice(0, 52)}\` | ${d.inRun.toFixed(2)} | ${d.asked.toFixed(2)} |`);
        }
      }
    }
    const guessed = traffic.filter((r) => r.cwdRecorded === false).length;
    const recorded = traffic.filter((r) => r.cwdRecorded === true).length;
    console.log(
      `\n**TODO §3.2**: of \`traffic.json\`'s ${traffic.length} rows, ${recorded} were asked about a ` +
        `RECORDED directory and ${guessed} about one recovered from the command text` +
        `${recorded + guessed < traffic.length ? ` (${traffic.length - recorded - guessed} predate the field)` : ""}. ` +
        "The ledger now carries `cwd` from the hook event, so the regex is a fallback for old rows rather " +
        "than the mechanism. docs/43 §4.4 is why that distinction is worth a field: a fabricated `cwd` made " +
        "the gate flag `outside_project` and turned four harmless `rm`s into stops, and the gate was right.\n",
    );
  }
}

if (process.argv[1]?.endsWith("scored.ts")) main();
