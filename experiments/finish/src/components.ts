/**
 * The other three components, inside a real agent. From the records: no key.
 *
 *   tsx src/components.ts
 *
 * docs/43 measured the guard end to end and left three of the four wirable
 * components unrun (TODO §1.1). This is those three, and the shape of the
 * answer is not the shape I expected going in:
 *
 *   model router          IT DECIDES, and the decision is nearly constant --
 *                         not because the router is broken but because the
 *                         corpus asks it one question 53 times. The variation
 *                         it does have comes from a confidence floor, not from
 *                         its tier judgment.
 *   skill router          IT DECIDES, over 300 skills nobody here wrote, and
 *                         the thing worth measuring turned out to be what the
 *                         CATALOGUE costs rather than what the router picks.
 *   orchestration gate    IT IS WIRED AND IT NEVER SPEAKS. The agent never
 *                         tries to delegate, so the seam carries no traffic.
 *
 * WHAT EACH READING IS ALLOWED TO CLAIM. One repeat per (task, arm) on the
 * model and skill sweeps, two on the orchestration sweep. A pass-rate gap on
 * one draw is not a result, so every comparison here is paired by task and
 * tested with the same exact sign test docs/43 §1a used -- and where the test
 * says nothing, this file says the test says nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { signP } from "./report.js";
import type { Record_ } from "./run.js";
import type { Run } from "./world.js";
import type { Probe } from "./probe.js";
import { catalogue } from "./catalogue.js";

const RECORDS = resolve(import.meta.dirname, "../records");

const pct = (x: number, n: number): string => (n === 0 ? "    -" : `${((100 * x) / n).toFixed(0).padStart(3)}%`);
const med = (xs: number[]): number =>
  xs.length === 0 ? Number.NaN : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function load(name: string): Run[] {
  const path = resolve(RECORDS, name);
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, "utf8")) as Record_).rows;
}

/**
 * DID THE AGENT FINISH THE WORK. Not the same as `node --test` exiting zero.
 *
 * Both prompts forbid touching the test files, and an agent that rewrites the
 * assertions gets a zero exit from a suite that no longer tests anything. So
 * the record keeps the two facts apart -- `passed` is the exit code, exactly
 * as docs/43 recorded it, and `testsIntact` is whether the instruction was
 * followed -- and combining them is done HERE, once, so that every table in
 * this file means the same thing by "pass".
 *
 * `testsIntact === undefined` means the row predates the check. Those are
 * counted as passes, because the alternative is to silently reclassify 186
 * recorded runs on an assumption; where such rows exist a table says so.
 */
const finished = (r: Run): boolean => r.passed && r.testsIntact !== false;

/** Rows that passed the exit code while having edited a test file. */
const tampered = (rows: Run[]): Run[] => rows.filter((r) => r.passed && r.testsIntact === false);

/**
 * Paired comparison of two arms, by (task, repeat).
 *
 * Returns the discordant counts, which is the only thing the sign test can
 * use: a task both arms pass says nothing about which arm is better.
 */
function paired(rows: Run[], a: string, b: string): { aOnly: number; bOnly: number; both: number; neither: number } {
  const key = (r: Run): string => `${r.task}/${r.repeat}`;
  const A = new Map(rows.filter((r) => r.arm === a).map((r) => [key(r), r]));
  const B = new Map(rows.filter((r) => r.arm === b).map((r) => [key(r), r]));
  let aOnly = 0;
  let bOnly = 0;
  let both = 0;
  let neither = 0;
  for (const [k, ra] of A) {
    const rb = B.get(k);
    if (!rb) continue;
    if (finished(ra) && finished(rb)) both += 1;
    else if (finished(ra)) aOnly += 1;
    else if (finished(rb)) bOnly += 1;
    else neither += 1;
  }
  return { aOnly, bOnly, both, neither };
}

function completionTable(rows: Run[], arms: string[]): void {
  console.log("| arm | model | finished | tests intact | tasks | median ms | median calls |");
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  for (const arm of arms) {
    const got = rows.filter((r) => r.arm === arm);
    if (got.length === 0) continue;
    const models = [...new Set(got.map((r) => r.model))];
    const label = models.length === 1 ? models[0].replace("claude-", "").replace("-4-5-20251001", "") : "routed";
    const checked = got.filter((r) => r.testsIntact !== undefined);
    const intact = checked.filter((r) => r.testsIntact === true).length;
    console.log(
      `| \`${arm}\` | ${label} | ${pct(got.filter(finished).length, got.length)} ` +
        `(${got.filter(finished).length}/${got.length}) | ${intact}/${checked.length} | ` +
        `${new Set(got.map((r) => r.task)).size} | ` +
        `${med(got.map((r) => r.ms))} | ${med(got.map((r) => r.calls.length))} |`,
    );
  }
  // Said once per table, and said even when it is zero: "no agent cheated" is
  // a measurement, and a reader cannot tell it from "nobody checked".
  const bad = tampered(rows);
  const checked = rows.filter((r) => r.testsIntact !== undefined).length;
  if (bad.length > 0) {
    console.log(
      `\n**${bad.length} of ${checked} runs got a zero exit from \`node --test\` after editing a test file** ` +
        `(${[...new Set(bad.map((r) => `${r.arm}/${r.task}`))].slice(0, 6).join(", ")}). Those are counted as ` +
        "failures above. The prompt forbids it and the exit code cannot see it.",
    );
  } else if (checked > 0) {
    console.log(
      `\nTest files as shipped in ${checked}/${checked} runs, so every pass above is a pass on the suite the ` +
        "task shipped with -- not on one the agent rewrote.",
    );
  }
}

/**
 * Paired comparison of a per-run NUMBER, task by task, with a sign test.
 *
 * This exists because of the shape the completion tables came out in. With
 * Bash allowed the agent iterates until `node --test` is green, so nearly
 * every arm finishes nearly every task and a pass-rate column is at the
 * ceiling. A ceiling is not a null result -- it is a statement that THIS
 * measure cannot separate these arms -- and the honest next move is to measure
 * what the arms cost rather than to keep quoting a 100% that says nothing.
 *
 * The sign test is on the DIRECTION of the per-task difference, not on the
 * means, because turn counts are skewed (one run that thrashes for 40 calls
 * moves a mean and not a median) and because the pairing is the whole point:
 * the same task, the same planted bug, one thing changed.
 */
function pairedNumber(
  rows: Run[],
  a: string,
  b: string,
  of: (r: Run) => number,
): { aLess: number; bLess: number; tied: number; medianDiff: number; p: number } {
  const key = (r: Run): string => `${r.task}/${r.repeat}`;
  const A = new Map(rows.filter((r) => r.arm === a).map((r) => [key(r), r]));
  const B = new Map(rows.filter((r) => r.arm === b).map((r) => [key(r), r]));
  const diffs: number[] = [];
  for (const [k, ra] of A) {
    const rb = B.get(k);
    if (!rb) continue;
    diffs.push(of(ra) - of(rb));
  }
  const aLess = diffs.filter((d) => d < 0).length;
  const bLess = diffs.filter((d) => d > 0).length;
  return {
    aLess,
    bLess,
    tied: diffs.filter((d) => d === 0).length,
    medianDiff: med(diffs),
    p: signP(aLess, bLess),
  };
}

function costTable(rows: Run[], pairs: [string, string][], of: (r: Run) => number, unit: string): void {
  console.log(`| pair | median difference | first lower | second lower | tied | exact sign test |`);
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const [a, b] of pairs) {
    const c = pairedNumber(rows, a, b, of);
    if (c.aLess + c.bLess + c.tied === 0) continue;
    console.log(
      `| \`${a}\` vs \`${b}\` | ${c.medianDiff > 0 ? "+" : ""}${c.medianDiff.toFixed(1)} ${unit} | ` +
        `${c.aLess} | ${c.bLess} | ${c.tied} | p = ${c.p.toFixed(3)}` +
        `${c.p > 0.05 ? " -- NOT SIGNIFICANT" : " **significant**"} |`,
    );
  }
}

function signLine(rows: Run[], a: string, b: string): void {
  const p = paired(rows, a, b);
  const n = p.aOnly + p.bOnly;
  const verdict =
    n === 0
      ? "**no discordant pair at all**: every task went the same way in both arms, so this corpus cannot separate them"
      : `p = ${signP(p.aOnly, p.bOnly).toFixed(3)}${signP(p.aOnly, p.bOnly) > 0.05 ? " -- NOT SIGNIFICANT" : ""}`;
  console.log(
    `| \`${a}\` vs \`${b}\` | ${p.both} | ${p.aOnly} | ${p.bOnly} | ${p.neither} | ${verdict} |`,
  );
}

// ---------------------------------------------------------------------------

function modelRouter(): void {
  const rows = load("model.json");
  const probe = existsSync(resolve(RECORDS, "probe.json"))
    ? (JSON.parse(readFileSync(resolve(RECORDS, "probe.json"), "utf8")) as Probe)
    : null;

  console.log("\n## 1. The model router\n");
  if (rows.length === 0) {
    console.log("No `records/model.json`. Run `--arms haiku,sonnet,routerfail`.\n");
    return;
  }
  const corpus = [...new Set(rows.map((r) => r.corpus))].join("+");
  console.log(
    `${rows.length} agent runs on the **${corpus}** corpus. The routed arm is asked about the request ` +
      "plus the task's real `node --test` output, because the request alone is one string shared by " +
      "53 tasks -- see §1.2.\n",
  );
  completionTable(rows, ["haiku", "sonnet", "routerfail"]);

  console.log("\n### 1.1 Did the dearer rung finish more work?\n");
  console.log("| pair | both passed | first only | second only | neither | exact sign test |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  signLine(rows, "sonnet", "haiku");
  signLine(rows, "routerfail", "haiku");
  signLine(rows, "routerfail", "sonnet");

  const PAIRS: [string, string][] = [
    ["sonnet", "haiku"],
    ["routerfail", "haiku"],
  ];
  console.log("\nAnd what the rungs cost on the tasks they both finished:\n");
  costTable(rows, PAIRS, (r) => r.calls.length, "calls");
  console.log("");
  costTable(rows, PAIRS, (r) => r.ms / 1000, "s");

  // WHAT THE ROUTER SPENT. Computed from the rows' own recorded decisions, not
  // from the arm's name: a routed row carries the tier jev picked.
  const routed = rows.filter((r) => r.arm === "routerfail" && r.routed);
  const tiers = new Map<string, number>();
  for (const r of routed) tiers.set(r.routed!.tier, (tiers.get(r.routed!.tier) ?? 0) + 1);
  const PRICE: Record<string, number> = { haiku: 1, sonnet: 3, opus: 15 };
  const bill = [...tiers.entries()].reduce((n, [t, c]) => n + (PRICE[t] ?? 0) * c, 0);
  const allHaiku = routed.length * PRICE.haiku;
  console.log(
    `\nThe routed arm picked ${[...tiers.entries()].map(([t, c]) => `${t} on ${c}`).join(", ")} of its ` +
      `${routed.length} runs. On the tier list's own relative prices that is ${bill} against ` +
      `${allHaiku} for haiku throughout -- **${(bill / allHaiku).toFixed(1)}x the cost**.`,
  );
  const pass = (arm: string): number => {
    const g = rows.filter((r) => r.arm === arm);
    return g.length === 0 ? Number.NaN : g.filter(finished).length / g.length;
  };
  const dh = pass("routerfail") - pass("haiku");
  console.log(
    `It finished ${(100 * pass("routerfail")).toFixed(0)}% against haiku's ${(100 * pass("haiku")).toFixed(0)}%: ` +
      `${dh > 0 ? "+" : ""}${(100 * dh).toFixed(0)} points for that multiple.`,
  );

  // THE FINDING THAT DID NOT COME FROM THE AGENT RUNS AT ALL.
  if (probe) {
    console.log("\n### 1.2 Where the router's answers actually come from\n");
    const g = probe.rows.map((r) => r.onFailure).filter(Boolean) as NonNullable<Probe["rows"][0]["onFailure"]>[];
    const onPrompt = probe.rows.map((r) => r.onPrompt).filter(Boolean) as typeof g;
    const scoreSaysHaiku = g.filter((x) => x.score < 0.5).length;
    const gotHaiku = g.filter((x) => x.tier === "haiku").length;
    const heldUp = g.filter((x) => x.reason.includes("low-confidence-no-downgrade")).length;
    const belowFloor = g.filter((x) => x.confidence < 0.5).length;
    console.log(`All ${probe.rows.length} tasks, judged offline (\`records/probe.json\`), no agent running:\n`);
    // Stated as a count of DISTINCT tiers, not as "how many matched the first
    // row": the second is the same number when the answer is constant and
    // quietly misleading when it is not.
    const distinct = [...new Set(onPrompt.map((x) => x.tier))];
    console.log("| | n | of | share |");
    console.log("| --- | --- | --- | --- |");
    console.log(
      `| distinct tiers the REQUEST ALONE produced | ${distinct.length} (${distinct.join(", ")}) | ` +
        `3 rungs | — |`,
    );
    console.log(`| the TIER SCORE said haiku (below 0.5) | ${scoreSaysHaiku} | ${g.length} | ${pct(scoreSaysHaiku, g.length)} |`);
    console.log(`| ...and haiku is what it got | ${gotHaiku} | ${g.length} | ${pct(gotHaiku, g.length)} |`);
    console.log(
      `| ...held at sonnet by \`minConfidence\` instead | ${heldUp} | ${g.length} | ${pct(heldUp, g.length)} |`,
    );
    console.log(
      `| confidence below the shipped \`minConfidence: 0.5\` | ${belowFloor} | ${g.length} | ${pct(belowFloor, g.length)} |`,
    );
    const cf = g.map((x) => x.confidence).sort((a, b) => a - b);
    const sc = g.map((x) => x.score).sort((a, b) => a - b);
    console.log(
      `\nTier score ${sc[0].toFixed(2)}..${sc[sc.length - 1].toFixed(2)} (median ${med(sc).toFixed(2)}); ` +
        `confidence ${cf[0].toFixed(2)}..${cf[cf.length - 1].toFixed(2)} (median ${med(cf).toFixed(2)}).`,
    );
    const FLOOR = 0.5;
    console.log(
      "\n**TWO THIRDS OF THE CONFIDENCE DISTRIBUTION SITS UNDER THE FLOOR.** `minConfidence: 0.5` exists to stop a " +
        `low-confidence judgment moving DOWN the ladder, and here the median confidence is ${med(cf).toFixed(2)} ` +
        `and the maximum ${cf[cf.length - 1].toFixed(2)} -- so the maximum is ` +
        `${cf[cf.length - 1] > FLOOR ? "above" : "BELOW"} the floor and the median is ` +
        `${(FLOOR - med(cf)).toFixed(2)} under it. The rule is not a guard against the occasional unsure ` +
        `answer: it is binding on ${pct(belowFloor, g.length).trim()} of them, and it only ever fires in the ` +
        "expensive direction.",
    );
    // THE SHAPE, THREE TIMES, AND THE THIRD ONE IS THE FIELD'S OWN CITATION.
    // `tiers.ts` says of this field: "docs/21 §7's lesson". docs/21 §7 is the
    // report where gating on `confidence >= 0.5` cost 7-11 points BECAUSE the
    // confidence distribution sat on top of the cutoff (0.54..0.57 for both
    // classes), and whose stated conclusion is "use confidence for routing,
    // not as a gate". In fairness `minConfidence` IS routing -- it changes the
    // rung rather than suppressing a report -- so this is not an inversion of
    // its source. What repeats is the MECHANISM, and it now has three
    // instances in shipped defaults.
    console.log("\n| | cutoff | where the answers actually land |");
    console.log("| --- | --- | --- |");
    console.log("| docs/21 §7, reporting gate | confidence 0.50 | 0.54..0.57, **the same for both classes** |");
    console.log("| docs/37 §7, `escalateAt` | 0.70 | 6 of 8 in 0.606..0.729 |");
    console.log(
      `| **here, \`minConfidence\`** | ${FLOOR.toFixed(2)} | **${cf[0].toFixed(2)}..${cf[cf.length - 1].toFixed(2)}, ` +
        `median ${med(cf).toFixed(2)}** |`,
    );
    console.log(
      "\ndocs/25 is the tool for FITTING a cutoff; all three of these are the step before it -- **look at " +
        "where the answers land before placing the number**. Three shipped defaults, three placed without it.",
    );
    const both = probe.rows.filter((r) => r.onPrompt && r.onFailure);
    const disagree = both.filter((r) => r.onPrompt!.tier !== r.onFailure!.tier).length;
    const cheaper = both.filter((r) => r.onFailure!.score < r.onPrompt!.score).length;
    const drops = both.map((r) => r.onPrompt!.score - r.onFailure!.score);

    // THE FREE CONTROL, and it is the reason the paragraph below is a result
    // rather than a hunch. The 53 repair tasks share `REPAIR_PROMPT` verbatim,
    // so `onPrompt` across them is 53 draws on ONE request -- a direct
    // measurement of this question's draw noise, at no extra cost. It is the
    // control docs/25 says every threshold claim needs and that most of this
    // programme's claims have had to do without.
    const identical = probe.rows.filter((r) => r.corpus !== "boundary" && r.onPrompt).map((r) => r.onPrompt!.score);
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = (xs: number[]): number => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
    const noise = sd(identical);
    console.log(
      `\n**The same request, ${identical.length} times: score ${Math.min(...identical).toFixed(2)}..` +
        `${Math.max(...identical).toFixed(2)}, sd ${noise.toFixed(3)}.** The repair tasks share one prompt ` +
        "string, so this column is a free measurement of the question's own reproducibility -- and on this " +
        "question the router is very nearly deterministic. Which means the row below is not noise.",
    );
    console.log(
      `\nAdding the real test output changed the tier on ${disagree} of ${both.length} tasks, lowered the tier ` +
        `score on ${cheaper} of ${both.length}, and the paired drop is ${mean(drops).toFixed(2)} on average ` +
        `(sd ${sd(drops).toFixed(2)}) on a 0..2 ladder -- **${(mean(drops) / noise).toFixed(0)}x the draw noise ` +
        `measured just above**, with ${drops.filter((d) => d > 2 * noise).length} of ${drops.length} tasks ` +
        "beyond two of those deviations.",
    );
    // A SECOND, INDEPENDENT DRAW, for free. The probe judged every task in its
    // own process, hours before the sweep, and the sweep's routed arm judged
    // them again at launch. Two separate sessions, two separate requests, the
    // same tasks -- so the agreement between them is a reproducibility check
    // that costs nothing and that no other component in this programme has.
    const byTask = new Map(both.map((r) => [r.task, r.onFailure!.tier]));
    const sweepRouted = rows.filter((r) => r.arm === "routerfail" && r.routed && byTask.has(r.task));
    if (sweepRouted.length > 0) {
      const agree = sweepRouted.filter((r) => byTask.get(r.task) === r.routed!.tier).length;
      console.log(
        `\nAnd the decision reproduces ACROSS SESSIONS: the probe judged these tasks in its own process and ` +
          `the sweep's routed arm judged them again at launch -- **${agree} of ${sweepRouted.length} agree per ` +
          `task**. Two independent requests, hours apart. So the constancy above is a property of the question, ` +
          "not of one lucky draw.",
      );
    }
    console.log(
      "\n**So seeing the actual failure makes the work look SMALLER**, and that is the opposite of what I " +
        "expected to write here: an instruction to go fix unspecified failing tests reads as more open-ended " +
        "than one concrete failing assertion does. It also points the cheap way -- a host that runs the tests " +
        "before dispatching gets a cheaper answer for one `node --test`, and the direction of the error is the " +
        "recoverable one, because the cheap rung is the one you can retry from.",
    );
  }
}

function skillRouter(): void {
  const rows = load("skills.json");
  console.log("\n## 2. The skill router\n");
  if (rows.length === 0) {
    console.log("No `records/skills.json`. Run `--arms haiku,allskills,skillrouter`.\n");
    return;
  }
  const corpus = [...new Set(rows.map((r) => r.corpus))].join("+");
  const cat = rows.find((r) => r.skillsLoaded)?.skillsLoaded?.catalogue ?? 0;
  // WHAT THE CATALOGUE COSTS, in the one unit that is knowable exactly. The
  // host puts every skill's name and description in the system prompt at
  // launch, so this is paid before the agent reads a line of code -- and it is
  // measured from the catalogue itself rather than inferred from the runs.
  const chars = catalogue().reduce((n, s) => n + s.name.length + s.description.length, 0);
  console.log(
    `${rows.length} agent runs on the **${corpus}** corpus, over a catalogue of ${cat} skills harvested from ` +
      "nine real repositories (`src/catalogue.ts`). **The catalogue is the first corpus in this programme " +
      "I did not write.** All three arms run haiku, so they differ in what is in front of the agent and " +
      "in nothing else.\n",
  );
  console.log(
    `The \`allskills\` arm's price is exact and paid up front: ${chars.toLocaleString()} characters of names ` +
      `and descriptions, about **${Math.round(chars / 4 / 1000)}k tokens** in the system prompt before the agent ` +
      "reads a line of code. That is the number the two comparisons below are trying to find a cost for.\n",
  );
  completionTable(rows, ["haiku", "allskills", "skillrouter"]);

  console.log("\n### 2.1 What the catalogue costs, and whether routing recovers it\n");
  console.log("| pair | both passed | first only | second only | neither | exact sign test |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  signLine(rows, "allskills", "haiku");
  signLine(rows, "skillrouter", "haiku");
  signLine(rows, "skillrouter", "allskills");

  const PAIRS: [string, string][] = [
    ["allskills", "haiku"],
    ["skillrouter", "haiku"],
    ["skillrouter", "allskills"],
  ];
  console.log(
    "\nCompletion is at the ceiling, so the readable question is what the catalogue costs the agent " +
      "that has it in front of it:\n",
  );
  costTable(rows, PAIRS, (r) => r.calls.length, "calls");
  console.log("");
  costTable(rows, PAIRS, (r) => r.ms / 1000, "s");

  // THE STRONGEST SIGNAL IN THIS SWEEP, named as such and not claimed. The
  // catalogue arm costs turns in a consistent direction and misses the line;
  // saying "not significant" and moving on would hide that, and saying "the
  // catalogue costs a turn" would be claiming it. Both numbers, then.
  const turns = pairedNumber(rows, "allskills", "haiku", (r) => r.calls.length);
  if (turns.aLess + turns.bLess > 0) {
    console.log(
      `\n**The catalogue arm's turn count is the one thing here that nearly separates.** \`allskills\` used more ` +
        `tool calls than \`haiku\` on ${turns.bLess} tasks and fewer on ${turns.aLess}, ${turns.tied} tied, ` +
        `median ${turns.medianDiff > 0 ? "+" : ""}${turns.medianDiff.toFixed(1)} -- exact p = ` +
        `${turns.p.toFixed(3)}. ${
          turns.p <= 0.05
            ? "**Significant**, so 23k tokens of skill descriptions cost this agent a turn."
            : "**That misses the line, so it is not a result.** The direction is what a reader should take from " +
              "it, and the way to settle it is more repeats rather than more prose: the pairing is already " +
              "task-by-task, so what is missing is draws."
        }`,
    );
  }

  const routed = rows.filter((r) => r.arm === "skillrouter" && r.skillsLoaded);
  const loads = routed.map((r) => r.skillsLoaded!.loaded.length);
  const freq = new Map<string, number>();
  for (const r of routed) for (const s of r.skillsLoaded!.loaded) freq.set(s, (freq.get(s) ?? 0) + 1);
  const asked = routed.map((r) => r.skillsLoaded!.considered);
  const toks = routed.map((r) => r.skillsLoaded!.inputTokens ?? 0).filter(Boolean);
  const total = loads.reduce((a, b) => a + b, 0);
  const some = loads.filter((n) => n > 0).length;
  console.log(
    `\nThe router loaded ${total} skill${total === 1 ? "" : "s"} across ${routed.length} runs ` +
      `(${some} run${some === 1 ? "" : "s"} got at least one; cap 3, cutoff 2.5), asking about a median of ` +
      `${med(asked)} of the ${cat} per run for a median ${med(toks)} input tokens and ` +
      `${med(routed.map((r) => r.skillsLoaded!.ms))} ms.`,
  );
  if (freq.size > 0) {
    console.log("\n| skill it chose | runs |");
    console.log("| --- | --- |");
    for (const [n, c] of [...freq.entries()].sort((a, b) => b[1] - a[1])) console.log(`| \`${n}\` | ${c} |`);
    // COMPUTED, not asserted. The first version of this paragraph said "every
    // one of them is a debugging skill" while its own table listed
    // `modern-javascript-patterns` -- the same failure mode as the seven
    // canned conclusions docs/41-43 had to correct, and for the same reason:
    // a sentence written once does not update when the table under it does.
    const DEBUG = /debug|diagnos|troubleshoot|root-?cause|bisect/i;
    const dbg = [...freq.keys()].filter((n) => DEBUG.test(n));
    console.log(
      `\n${dbg.length} of the ${freq.size} distinct skills it chose name debugging (${dbg.join(", ") || "none"}), ` +
        `out of ${cat} available. Nobody labelled these 300 against "fix a failing test", so **that is not a ` +
        "precision figure** -- there is no ground truth here and none is claimed. It is the router's behaviour, " +
        "and the end-to-end verdict above needs no label.",
    );
  }

  // WHAT THE ROUTER'S TRADE ACTUALLY IS, in the two units that are known
  // exactly. Worth stating because both arms' costs are real and they are
  // denominated in DIFFERENT MODELS' input tokens, which is the whole reason a
  // cheap judgment model can be worth asking at all.
  if (toks.length > 0) {
    const saved = chars / 4 - (3 * chars) / 4 / catalogue().length;
    console.log(
      `\nSo the trade is measured on both sides: the router spends a median **${med(toks).toLocaleString()} ` +
        "input tokens of jev** ($0.042/MTok, docs/00) per run to avoid putting **~" +
        `${Math.round(saved / 1000)}k input tokens of the GENERATING model** in the system prompt. It pays ` +
        `whenever the generating model's input price is more than ${(med(toks) / saved).toFixed(2)}x jev's, ` +
        "which is every model there is. **That is an argument about prices, not a measurement of quality** -- " +
        "the quality question is the table above, and the table above says this corpus cannot separate them.",
    );
  }

  // The thing the arm can be wrong about, checked rather than assumed.
  const invoked = rows.filter((r) => r.calls.some((c) => c.tool === "Skill" || c.tool === "SlashCommand")).length;
  console.log(
    `\n**Did any agent open one of these skills?** ${invoked} of ${rows.length} runs. ` +
      (invoked === 0
        ? "None, so the stub bodies (`src/catalogue.ts`) were never read and the catalogue's whole effect " +
          "here is the descriptions the host puts in the system prompt at launch -- which is the real cost " +
          "and the one this sweep can price."
        : "**SO THIS SWEEP IS NOT CLEANLY READABLE**: the roster carries no bodies, so an agent that opened " +
          "one got a stub where instructions should be. Those runs measure a broken skill, not a routed one."),
  );
}

function orchestration(): void {
  const rows = load("orch.json");
  console.log("\n## 3. The orchestration gate\n");
  if (rows.length === 0) {
    console.log("No `records/orch.json`. Run `--arms subagent,orchestrated`.\n");
    return;
  }
  const corpus = [...new Set(rows.map((r) => r.corpus))].join("+");
  console.log(
    `${rows.length} agent runs on the **${corpus}** corpus, with \`Task\` in \`--allowedTools\` so the agent ` +
      "*can* delegate, and the shipped `jev-orchestrator` on `PreToolUse` with a `Task` matcher in the " +
      "gated arm.\n",
  );
  completionTable(rows, ["subagent", "orchestrated"]);
  console.log("");
  costTable(rows, [["orchestrated", "subagent"]], (r) => r.calls.length, "calls");
  console.log("");
  costTable(rows, [["orchestrated", "subagent"]], (r) => r.ms / 1000, "s");

  const spawns = rows.reduce((n, r) => n + (r.spawns?.length ?? 0), 0);
  const taskCalls = rows.reduce((n, r) => n + r.calls.filter((c) => c.tool === "Task").length, 0);
  const calls = rows.reduce((n, r) => n + r.calls.length, 0);
  console.log(
    `\n### 3.1 The seam carried no traffic\n\n` +
      `**${taskCalls} \`Task\` calls in ${calls} tool calls across ${rows.length} runs.** The agent had the ` +
      "tool and never used it. So the gate was consulted " +
      `${spawns} times, and every number in the table above is the cost of wiring a gate that never spoke.\n`,
  );
  if (taskCalls === 0) {
    console.log(
      "This is the same failure docs/43 §3 hit with the guard, one component over, and worse: the guard at " +
        "least spoke on 12 of 978 commands. Here the denominator is zero. **The component is verified " +
        "wirable and its cost on a corpus it has no work in is verified to be nil; nothing about whether it " +
        "routes work well is measured, and nothing here could measure it.**\n",
    );
    console.log(
      "What IS established, and by what:\n\n" +
        "| claim | how |\n| --- | --- |\n" +
        "| the hook reaches the gate and a refused split denies the spawn, with the gate's own reason | " +
        "`test.ts`, a synthetic `Task` event at the wire |\n" +
        "| a dead driver fails open and the row says so rather than reading as an allow | `test.ts` |\n" +
        "| the gate would refuse every spawn on this corpus | `records/probe.json`: 0 of 58 above the " +
        "shipped 0.50 cutoff, mean 0.15 |\n" +
        "| the agent never asks to spawn | this sweep |\n",
    );
    console.log(
      "And the gate refusing is the RIGHT answer: a one-file bug fix does not want a subagent. " +
        "The component agrees with the corpus, the agent agrees with both, and a measurement where " +
        "everyone agrees has no information in it.\n",
    );
  }
}

function limits(): void {
  console.log("\n## 4. What these three numbers are not\n");
  console.log(
    "- **ONE DRAW PER (task, arm)** on the model and skill sweeps, two on the orchestration sweep.\n" +
      "  Every comparison above is paired and tested; where the test says nothing, the table says so.\n" +
      "  docs/43 §4b.3 measured the same arm on the same task going 3 -> 1 -> 0 on a different axis, so\n" +
      "  one draw is genuinely not much.\n" +
      "- **THE ROUTER'S CORPUS ASKS IT ONE QUESTION.** 53 of the 58 tasks share `REPAIR_PROMPT` verbatim.\n" +
      "  §1.2's finding about `minConfidence` is about the router's policy and holds regardless; the\n" +
      "  end-to-end pass rates are a comparison of two models on repair tasks that happens to be routed.\n" +
      "- **THE SKILL BODIES ARE STUBS.** The roster carries names and descriptions only. §2.1 checks\n" +
      "  whether any agent opened one; the arm is readable exactly while that count is zero.\n" +
      "- **NOTHING ABOUT ORCHESTRATION QUALITY.** See §3.1. The seam works and the corpus has no work\n" +
      "  for it.\n" +
      "- **THE COMPACTOR IS STILL NOT WIRABLE.** `PreCompact` can block compaction or rewrite the\n" +
      "  summariser's instructions, and `jev-compact` deletes rather than summarises (docs/39). Four of\n" +
      "  five components are now wired and measured; the fifth is a fact about the host.\n" +
      "- **NOT THE COMBINED AGENT.** docs/37 §6 measured that combining is not free, so none of this\n" +
      "  carries over to all four at once.\n" +
      "- **THE FENCE AND THE LEDGER ARE IN EVERY ARM.** Both pay one node start-up per tool call, so no\n" +
      "  arm here is a truly unhooked agent.\n",
  );
}

function main(): void {
  console.log("\n# The other three components, inside a real agent\n");
  modelRouter();
  skillRouter();
  orchestration();
  limits();
}

if (process.argv[1]?.endsWith("components.ts")) main();
