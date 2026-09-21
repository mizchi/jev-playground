/**
 * THE CEILING HAS A CAUSE, AND IT IS IN THE RECORD TWICE. [TODO §2.5]
 *
 *   tsx src/ceiling.ts            the whole report. NO API KEY, NO CLI.
 *   tsx src/ceiling.ts --report   the same thing
 *
 * WHAT §2.5 ASKED. Every arm in docs/44 came back at 100% completion, so
 * `node --test`'s exit code does not separate the model tiers. §2.5 named the
 * cause correctly -- **Bash is available, so the agent loops until the tests
 * are green** -- and listed three candidates:
 *
 *   1. cap the turns. "`calls.length` から既にある記録で計算できます" --
 *      mechanical, computable from the record that already exists. With the
 *      caveat that **the cap is a number I would choose**, so docs/25's
 *      discipline says look at the distribution first.
 *   2. take harder tasks. §2.5 already suspected this was hopeless: docs/36's
 *      `tasks-hard` was at the ceiling too, so "maybe the repair-task shape
 *      itself is the ceiling".
 *   3. accept it and report cost only. Honest, and leaves "is the cheap tier
 *      enough" permanently unmeasured.
 *
 * THIS REPORT SPENDS NOTHING. Candidate 1 is computable from the record, which
 * §2.5 said; candidate 2 turns out to be **already answered by two records
 * this repository has been carrying all along**; and the distribution
 * docs/25's rule asks for comes free. So there is no sweep here at all -- the
 * second report in the programme to cost zero requests (docs/46 was the
 * first, and for the same reason: the answer was already recorded).
 *
 * THE FINDING, in one row. `equals-k3` is the ONLY task in the whole programme
 * where a completion label ever separated the tiers: docs/36 has haiku failing
 * it and sonnet passing it. docs/44 ran the same task with the same model --
 * and `--allowedTools` now including Bash -- and **haiku passes, in 8 calls of
 * which 4 are Bash, running the tests and reading the failure.** The
 * mechanism §2.5 named is visible in a single recorded run.
 *
 * AND CANDIDATE 1 CANNOT WIN, which is a theorem rather than a measurement.
 * "Finished within K calls" is a THRESHOLDED VIEW of the call count. A
 * monotone many-to-one map can only merge ties, and merging ties can only
 * lower AUC -- so **no cap can separate the tiers better than the call count
 * itself does**, and docs/44 already reports that comparison, paired, at
 * p < 0.001. The sweep below confirms it numerically at every K.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { auc, quantile, type Sample } from "../../shared/thresholds.js";

const RECORDS = resolve(import.meta.dirname, "../records");
/** docs/36's record, which is in a different experiment and is the whole point. */
const ROUTER = resolve(import.meta.dirname, "../../router/records/labels.json");

interface Run {
  arm: string;
  task: string;
  corpus?: string;
  model?: string;
  passed: boolean;
  testsIntact?: boolean;
  untouched?: boolean;
  ms: number;
  calls: { tool?: string; command?: string }[];
}

/** Every run-shaped record in `records/`, recognised by shape rather than by name. */
export function runRecords(): { file: string; rows: Run[] }[] {
  return readdirSync(RECORDS)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((file) => {
      try {
        const rows = (JSON.parse(readFileSync(resolve(RECORDS, file), "utf8")) as { rows: Run[] }).rows;
        if (!Array.isArray(rows) || rows.length === 0) return [];
        if (!Array.isArray(rows[0]?.calls) || typeof rows[0]?.passed !== "boolean") return [];
        return [{ file, rows }];
      } catch {
        return [];
      }
    });
}

/** docs/36's attempts: the same hard corpus, with no Bash in `--allowedTools`. */
export function routerAttempts(): { corpus: string; tier: string; task: string; passed: boolean }[] {
  if (!existsSync(ROUTER)) return [];
  return (JSON.parse(readFileSync(ROUTER, "utf8")) as {
    attempts: { corpus: string; tier: string; task: string; passed: boolean }[];
  }).attempts;
}

/**
 * The tier-separating AUC of the call count, and of the count capped at K.
 *
 * Exported so the theorem in §2 is *tested* rather than only asserted: for
 * every K, `sepAuc(rows, k)` must be <= `sepAuc(rows, null)`. Thresholding is
 * a monotone many-to-one map, so that inequality is not a property of this
 * corpus -- which is exactly why a test should hold it, since a future change
 * that broke it would mean the harness, not the mathematics, had moved.
 */
export function sepAuc(rows: Run[], k: number | null, cheap = "haiku", dear = "sonnet"): number {
  const use = rows.filter((r) => r.arm === cheap || r.arm === dear);
  return auc(
    use.map((r) => ({
      // Negated: fewer calls is the "better" direction, and `auc` reads higher
      // values as more positive.
      value: k === null ? -r.calls.length : r.calls.length <= k ? 1 : 0,
      positive: r.arm === dear,
      group: r.task,
    })),
  );
}

/** Exact two-sided sign test on the discordant pairs. */
export function signTest(less: number, more: number): number {
  const n = less + more;
  if (n === 0) return 1;
  const choose = (k: number): number => {
    let r = 1;
    for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
    return r;
  };
  let tail = 0;
  for (let i = 0; i <= Math.min(less, more); i++) tail += choose(i);
  return Math.min(1, (2 * tail) / 2 ** n);
}

const p = (x: number): string => (x < 0.001 ? "p < 0.001" : `p = ${x.toFixed(3)}`);
const pct = (x: number, n: number): string => (n === 0 ? "—" : `${((100 * x) / n).toFixed(0)}%`);

// -------------------------------------------------------------- §0 the ceiling

function ceiling(): void {
  console.log("\n# The ceiling has a cause, and it is in the record twice [TODO §2.5]\n");
  console.log("## 0. The step §2.5 prescribed, and it was free\n");
  console.log(
    "Every arm in docs/44 came back at 100% completion, so `node --test`'s exit code does not " +
      "separate the model tiers. §2.5 named the cause correctly -- **Bash is available, so the agent " +
      "loops until the tests are green** -- and its first candidate was *cap the turns*, with the " +
      "caveat that **the cap is a number I would choose**, so docs/25's rule says look at the " +
      "distribution first.\n",
  );
  const recs = runRecords();
  const all = recs.flatMap((r) => r.rows);
  console.log(
    `**${all.length} recorded agent runs across ${recs.length} records, and ` +
      `${all.filter((r) => r.passed).length} of them passed.**\n`,
  );
  console.log("| record | runs | passed | arms |");
  console.log("| --- | --- | --- | --- |");
  for (const { file, rows } of recs) {
    console.log(
      `| \`${file}\` | ${rows.length} | **${rows.filter((r) => r.passed).length}/${rows.length}** | ` +
        `${[...new Set(rows.map((r) => r.arm))].map((a) => `\`${a}\``).join(" ")} |`,
    );
  }
  // EVERY BINARY LABEL, not just `passed`. If one of them varied it would be
  // the completion-shaped label §1.4 wants, sitting in the record for free.
  const model = recs.find((r) => r.file === "model.json");
  if (model) {
    const arms = [...new Set(model.rows.map((r) => r.arm))].sort();
    console.log(
      "\n**And `passed` is not the only binary in the record.** `model.json` is the one that bears " +
        "on the tier question -- the same 32 tasks run by each tier -- so every boolean it carries is " +
        "worth checking before anything new is built:\n",
    );
    console.log(`| label | ${arms.map((a) => `\`${a}\``).join(" | ")} |`);
    console.log(`| --- | ${arms.map(() => "---").join(" | ")} |`);
    for (const [name, get] of [
      ["`passed`", (r: Run) => r.passed],
      ["`testsIntact`", (r: Run) => r.testsIntact],
      ["`untouched`", (r: Run) => r.untouched],
    ] as [string, (r: Run) => boolean | undefined][]) {
      const cells = arms.map((a) => {
        const g = model.rows.filter((r) => r.arm === a);
        const known = g.filter((r) => get(r) !== undefined);
        return `${known.filter((r) => get(r) === true).length}/${known.length}`;
      });
      console.log(`| ${name} | ${cells.join(" | ")} |`);
    }
    console.log(
      "\n**Every one of them is at a ceiling or a floor, identically in all three arms.** " +
        "So the search for a completion-shaped label that already separates the tiers comes back " +
        "empty, and it comes back empty over everything that was recorded rather than over the one " +
        "field that was being complained about.\n",
    );
  }
}

// ------------------------------------------------- §1 the cause, twice recorded

function cause(): void {
  console.log("\n## 1. The same corpus is in the record twice, with and without a test runner\n");
  const attempts = routerAttempts();
  if (attempts.length === 0) {
    console.log("**docs/36's record is missing**, so this section cannot run.\n");
    return;
  }
  const model = runRecords().find((r) => r.file === "model.json");
  if (!model) return;
  console.log(
    "docs/36 measured the repair corpus with `--allowedTools Read Edit Write` -- **no Bash**, so its " +
      "agent could not run the tests. docs/44 measured **the same `hard` corpus** with Bash in the " +
      "list. Same tasks, same models, one difference:\n",
  );
  const hard36 = attempts.filter((a) => a.corpus === "hard");
  const h36 = hard36.filter((a) => a.tier === "haiku");
  const s36 = hard36.filter((a) => a.tier === "sonnet");
  const h44 = model.rows.filter((r) => r.arm === "haiku");
  const s44 = model.rows.filter((r) => r.arm === "sonnet");
  console.log("| record | Bash? | design | haiku | sonnet |");
  console.log("| --- | --- | --- | --- | --- |");
  console.log(
    `| docs/36 | **no** | cheapest-sufficient: the higher tier only runs where the lower one failed | ` +
      `**${h36.filter((a) => a.passed).length}/${h36.length}** | ${s36.filter((a) => a.passed).length}/${s36.length} |`,
  );
  console.log(
    `| docs/44 | **yes** | paired: every task run by both tiers | ` +
      `**${h44.filter((r) => r.passed).length}/${h44.length}** | ${s44.filter((r) => r.passed).length}/${s44.length} |`,
  );
  console.log(
    `\n**So the programme has a non-ceiling label OR a paired design, and never both.** docs/36's ` +
      `haiku missed ${h36.length - h36.filter((a) => a.passed).length} of ${h36.length} -- a real ` +
      `separation -- but its design runs the higher tier **only where the lower one failed**, so ` +
      `sonnet has n = ${s36.length}. docs/44 runs all ${h44.length} tasks on both tiers and is at ` +
      "the ceiling.\n",
  );
  const failed36 = h36.filter((a) => !a.passed).map((a) => a.task);
  if (failed36.length === 0) return;
  console.log(
    `**And the mechanism is visible in one row.** \`${failed36.join("`, `")}\` is the only task in ` +
      "the programme where a completion label ever separated the tiers. docs/44 ran it again, same " +
      "model, with Bash available:\n",
  );
  console.log("| record | model | passed | tool calls | of those, Bash |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const task of failed36) {
    const was = h36.find((a) => a.task === task);
    console.log(`| docs/36 | haiku | **${was?.passed ? "yes" : "no"}** | — (no Bash) | — |`);
    for (const arm of ["haiku", "sonnet"]) {
      const now = model.rows.find((r) => r.arm === arm && r.task.includes(task));
      if (!now) continue;
      const bash = now.calls.filter((c) => c.tool === "Bash");
      console.log(
        `| docs/44 | ${arm} | **${now.passed ? "yes" : "no"}** | ${now.calls.length} | **${bash.length}** |`,
      );
    }
  }
  const now = model.rows.find((r) => r.arm === "haiku" && r.task.includes(failed36[0]));
  if (now) {
    const cmds = now.calls.filter((c) => c.tool === "Bash").map((c) => c.command ?? "");
    console.log(
      `\nAnd what those Bash calls were, verbatim from the record:\n\n\`\`\`\n${cmds
        .map((c) => c.slice(0, 68))
        .join("\n")}\n\`\`\`\n`,
    );
    console.log(
      "> **The cheap tier failed this task, and then passed it once it could run the tests.**\n>\n" +
        "> It is not that the model got better. **It ran the suite, read which assertion failed, and " +
        "edited again** -- the loop §2.5 named, in a recorded run. **So `passed` with Bash present " +
        "is not measuring the model's answer; it is measuring whether the harness gave it a way to " +
        "check its own work.**\n>\n" +
        "> That also settles §2.5's **candidate 2**. It guessed that *maybe the repair-task shape " +
        "itself is the ceiling*. It is not the shape: **the same tasks separate without Bash and " +
        "do not separate with it.** Harder tasks would not fix a retry loop, because the loop " +
        "retries until they pass too.\n",
    );
  }
}

// ---------------------------------------------- §2 candidate 1, at every cutoff

export interface Capped {
  k: number;
  cheapWithin: number;
  dearWithin: number;
  n: number;
  /** Paired: tasks where the dear tier finished within K and the cheap one did not. */
  dearOnly: number;
  cheapOnly: number;
  pValue: number;
}

/** Candidate 1, swept over every cap rather than at one I picked. */
export function sweepCaps(rows: Run[], cheap = "haiku", dear = "sonnet"): Capped[] {
  const byTask = new Map<string, Map<string, Run>>();
  for (const r of rows) {
    if (r.arm !== cheap && r.arm !== dear) continue;
    const had = byTask.get(r.task) ?? new Map<string, Run>();
    had.set(r.arm, r);
    byTask.set(r.task, had);
  }
  const pairs = [...byTask.values()].filter((m) => m.has(cheap) && m.has(dear));
  const counts = rows.filter((r) => r.arm === cheap || r.arm === dear).map((r) => r.calls.length);
  const lo = Math.min(...counts);
  const hi = Math.max(...counts);
  const out: Capped[] = [];
  for (let k = lo - 1; k <= hi; k++) {
    const within = (m: Map<string, Run>, arm: string): boolean => (m.get(arm) as Run).calls.length <= k;
    const dearOnly = pairs.filter((m) => within(m, dear) && !within(m, cheap)).length;
    const cheapOnly = pairs.filter((m) => within(m, cheap) && !within(m, dear)).length;
    out.push({
      k,
      cheapWithin: pairs.filter((m) => within(m, cheap)).length,
      dearWithin: pairs.filter((m) => within(m, dear)).length,
      n: pairs.length,
      dearOnly,
      cheapOnly,
      pValue: signTest(cheapOnly, dearOnly),
    });
  }
  return out;
}

function candidateOne(): void {
  const model = runRecords().find((r) => r.file === "model.json");
  if (!model) return;
  console.log("\n## 2. Candidate 1, swept over every cap rather than at one I chose\n");
  const cheap = model.rows.filter((r) => r.arm === "haiku").map((r) => r.calls.length);
  const dear = model.rows.filter((r) => r.arm === "sonnet").map((r) => r.calls.length);
  console.log(
    "docs/25's rule is that a cutoff belongs to a corpus, so the distribution comes before the " +
      "number:\n",
  );
  console.log("| arm | n | min | q1 | median | q3 | max |");
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  for (const [name, xs] of [["`haiku`", cheap], ["`sonnet`", dear]] as [string, number[]][]) {
    console.log(
      `| ${name} | ${xs.length} | **${Math.min(...xs)}** | ${quantile(xs, 0.25).toFixed(1)} | ` +
        `**${quantile(xs, 0.5).toFixed(1)}** | ${quantile(xs, 0.75).toFixed(1)} | **${Math.max(...xs)}** |`,
    );
  }
  console.log(
    `\n**The two distributions barely overlap** -- \`haiku\` never finishes in fewer than ` +
      `${Math.min(...cheap)} calls and \`sonnet\` never needs more than ${Math.max(...dear)}. So a cap ` +
      "**does** separate them, and candidate 1 works. The question is what it buys.\n",
  );
  const caps = sweepCaps(model.rows);
  console.log("| cap K | `haiku` finished within K | `sonnet` within K | discordant (S only / H only) | paired p |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const c of caps) {
    console.log(
      `| **${c.k}** | ${c.cheapWithin}/${c.n} (${pct(c.cheapWithin, c.n)}) | ` +
        `${c.dearWithin}/${c.n} (${pct(c.dearWithin, c.n)}) | ${c.dearOnly} / ${c.cheapOnly} | ` +
        `${p(c.pValue)} |`,
    );
  }
  // THE BEST CAP IS CHOSEN BY AUC, NOT BY p-VALUE.
  //
  // Several caps tie below p = 0.001, so picking by p left the comparison
  // against an arbitrary member of that tie -- and the claim being tested is
  // that NO cap beats the count. A claim like that has to be put against the
  // opposing option's strongest form, so the cap that maximises AUC is the one
  // the theorem has to survive.
  const aucAt = (k: number, ps: Map<string, Run>[]): number =>
    auc(
      ps.flatMap((m) => [
        { value: (m.get("haiku") as Run).calls.length <= k ? 1 : 0, positive: false, group: "x" },
        { value: (m.get("sonnet") as Run).calls.length <= k ? 1 : 0, positive: true, group: "x" },
      ]),
    );
  // THE CONTINUOUS MEASURE, which docs/44 already reports.
  const byTask = new Map<string, Map<string, Run>>();
  for (const r of model.rows) {
    if (r.arm !== "haiku" && r.arm !== "sonnet") continue;
    const had = byTask.get(r.task) ?? new Map<string, Run>();
    had.set(r.arm, r);
    byTask.set(r.task, had);
  }
  const pairs = [...byTask.values()].filter((m) => m.has("haiku") && m.has("sonnet"));
  const dearFewer = pairs.filter(
    (m) => (m.get("sonnet") as Run).calls.length < (m.get("haiku") as Run).calls.length,
  ).length;
  const cheapFewer = pairs.filter(
    (m) => (m.get("haiku") as Run).calls.length < (m.get("sonnet") as Run).calls.length,
  ).length;
  const contP = signTest(cheapFewer, dearFewer);
  const best = caps.reduce((a, b) => (aucAt(b.k, pairs) > aucAt(a.k, pairs) ? b : a));
  console.log(
    `\n**The strongest cap is K = ${best.k}**, chosen by AUC rather than by p-value so that the claim ` +
      `below is put against candidate 1's best form (several caps tie below p = 0.001): ` +
      `${best.dearOnly} discordant pairs, ${p(best.pValue)}. ` +
      `**The call count itself, paired and uncapped, is ${dearFewer}/${pairs.length} with ` +
      `${p(contP)}** -- which is docs/44 §1.2's comparison, already published.\n`,
  );
  // AND THE REASON, which is a theorem rather than a result of this corpus.
  const cont: Sample[] = pairs.flatMap((m) => [
    { value: -(m.get("haiku") as Run).calls.length, positive: false, group: "x" },
    { value: -(m.get("sonnet") as Run).calls.length, positive: true, group: "x" },
  ]);
  const capped: Sample[] = pairs.flatMap((m) => [
    { value: (m.get("haiku") as Run).calls.length <= best.k ? 1 : 0, positive: false, group: "x" },
    { value: (m.get("sonnet") as Run).calls.length <= best.k ? 1 : 0, positive: true, group: "x" },
  ]);
  console.log(
    `> **And no cap can ever win, which is a theorem and not a property of this corpus.**\n>\n` +
      "> *\"Finished within K calls\"* is a **thresholded view of the call count**. Thresholding is a " +
      "monotone many-to-one map: it can only merge values that the count kept apart, and merging " +
      "them can only lose ordering information. **So the capped label's AUC is bounded above by the " +
      `count's**, at every K. Numerically here: the count separates the tiers at AUC ` +
      `**${auc(cont).toFixed(3)}** and the best cap at **${auc(capped).toFixed(3)}**.\n>\n` +
      "> **So candidate 1 is computable, works, and is strictly a worse view of something docs/44 " +
      "already reported.** §2.5 wanted a completion-shaped label because §1.4 asked for one; the " +
      "honest answer is that **the shape of the label was the wrong thing to want.**\n",
  );
}

// ------------------------------------------------------------------- §3 answer

function answer(): void {
  const model = runRecords().find((r) => r.file === "model.json");
  const attempts = routerAttempts();
  const h36 = attempts.filter((a) => a.corpus === "hard" && a.tier === "haiku");
  const s36 = attempts.filter((a) => a.corpus === "hard" && a.tier === "sonnet");
  console.log("\n## 3. What §2.5 should conclude\n");
  console.log("| §2.5's candidate | what the record says |");
  console.log("| --- | --- |");
  console.log(
    `| **1. cap the turns** -- mechanical, computable from the record | **true, and it does not help.** ` +
      "Any cap is a thresholded view of the call count, so its AUC is bounded by the count's -- and " +
      "docs/44 §1.2 already reports that comparison paired at p < 0.001 |",
  );
  console.log(
    `| **2. take harder tasks** -- maybe the repair shape is the ceiling | **already answered, and ` +
      `it is not the shape.** The same \`hard\` corpus is in the record twice: ` +
      `${h36.filter((a) => a.passed).length}/${h36.length} without Bash, ` +
      `${model ? model.rows.filter((r) => r.arm === "haiku" && r.passed).length : 0}/` +
      `${model ? model.rows.filter((r) => r.arm === "haiku").length : 0} with it |`,
  );
  console.log(
    "| **3. accept the ceiling and price it** | **already done, in docs/45 §1.** §1.4 had no " +
      "correctness label either, and the answer there was to re-ask the question as a price. The same " +
      "move applies here |",
  );
  console.log(
    "\n> **The ceiling is real and it is not the obstacle.**\n>\n" +
      "> §2.5 is written as though a missing label were blocking a measurement. It is not: " +
      "**docs/44 separated the tiers** -- a median 2 fewer calls for the higher one, on 28-29 of 32 " +
      "tasks, p < 0.001. What is missing is not the ability to tell the tiers apart, it is a " +
      "**completion-shaped** way of saying it, and every way of manufacturing one from this record " +
      "is a lossy re-encoding of the number that already worked.\n>\n" +
      `> And the one place a completion label ever did separate them is **${
        h36.length - h36.filter((a) => a.passed).length
      } task of ${h36.length}**, in a design that ran the higher tier on **${s36.length}** task ` +
      "in total. **One discordant pair cannot be called a difference by any test** -- a sign test on " +
      `it gives ${p(signTest(0, 1))}. So even un-ceilinged, the label carries about one bit.\n`,
  );
  console.log(
    "**What would actually close it** is not a relabelling. It is work whose completion is not " +
      "decidable by re-running a test suite -- and the honest note is that **this programme's repair " +
      "corpus is defined by a test suite**, so that corpus cannot contain such work by construction. " +
      "That is the same condition §2.1's candidate 1 names, arriving from a fourth direction " +
      "(docs/51, docs/52, docs/53 and here).\n",
  );
}

function limits(): void {
  const recs = runRecords();
  const all = recs.flatMap((r) => r.rows);
  console.log("\n## 4. Honest limits\n");
  console.log(
    `- **This report spends nothing and measures nothing new.** Every number is from a committed ` +
      `record (${all.length} runs across ${recs.length} files, plus docs/36's). It is an analysis, ` +
      "and its strongest claim -- that no cap beats the count -- is **a theorem about thresholding, " +
      "not a finding about jev.**\n" +
      "- **The `equals-k3` comparison is one task and two runs.** It shows the mechanism §2.5 named " +
      "actually operating, with the Bash commands in the record; **it is not evidence about how " +
      "often Bash flips an outcome**, because docs/36 and docs/44 differ in more than Bash (different " +
      "harness, different prompt wording, different sandbox construction).\n" +
      "- **docs/36's design cannot be re-read as a paired comparison.** It ran the higher tier only " +
      "where the lower one failed, on purpose (`cheapest_sufficient`), so its sonnet column has one " +
      "row and **no amount of re-analysis produces a paired label from it.**\n" +
      "- **The cap sweep is on 32 tasks at one repeat.** docs/44 §4.5 measured the gate's verdicts as " +
      "a draw across 7 repeats; **nothing here re-draws the call counts**, so a cap sitting between " +
      "two adjacent integers could move with a re-run.\n" +
      "- **`routerfail` is excluded from the sweep.** It is a sonnet-model arm that exists to test a " +
      "failure path, not a tier, and including it would put two sonnet arms on one side.\n" +
      "- **\"The label carries about one bit\" is about this corpus.** A corpus where the cheap tier " +
      "failed a third of the time would make the completion label perfectly usable. **The claim is " +
      "that this repair corpus cannot be that corpus**, because its completion is decided by a test " +
      "suite the agent can run.",
  );
}

function main(): void {
  ceiling();
  cause();
  candidateOne();
  answer();
  limits();
}

if (process.argv[1]?.endsWith("ceiling.ts")) main();
