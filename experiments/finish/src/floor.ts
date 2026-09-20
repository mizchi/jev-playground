/**
 * Should `minConfidence` move? Pricing a floor whose correctness label does
 * not exist. [TODO §1.4]
 *
 *   tsx src/floor.ts        the whole thing, from records, no API key
 *
 * WHAT TODO §1.4 ASKED. docs/44 §1.2 measured that the shipped
 * `minConfidence: 0.5` overrides the router's own tier judgment, always
 * upward, on a large share of tasks. §1.4 said the way to close it is docs/25's
 * `crossValidate` -- "**ただし「どの段が正しかったか」のラベルが要ります**" --
 * and noted that docs/36's tier labels were made by an agent that could not
 * run tests (docs/43 §0.1), so docs/44's `haiku`/`sonnet` arms are half of the
 * rebuild and §2.5's ceiling is the other half.
 *
 * THE LABEL IS STILL MISSING, AND THIS FILE SHOWS THAT RATHER THAN ASSERTING
 * IT. Completion came back 32/32 for haiku, 32/32 for sonnet and 32/32 for the
 * router. A label that is constant cannot order anything, so `advise()` is
 * asked about it and says so in its own words (`no-signal`, one class empty).
 * That is the honest answer to "which tier was right": on this corpus, both.
 *
 * WHAT DOES EXIST IS COST, PAIRED. Every one of the 32 tasks was run by BOTH
 * fixed arms, so for each task there is a measured `haiku calls - sonnet
 * calls`. docs/44 §1.1 already used that axis to separate the arms at
 * p < 0.001; here it becomes the label, and the floor can be priced rather
 * than judged: for every candidate value, which tasks would go to haiku, what
 * the tier-list price would be, and what those tasks measurably cost when
 * haiku actually ran them.
 *
 * That is summary.md's lesson 8.6 applied to the one threshold it had not
 * reached: **when cost is measured, "what does a miss cost" is answerable even
 * where "what is correct" is not.**
 *
 * THE SWEEP CALLS THE SHIPPED POLICY. `decide()` is imported from
 * `jev-model-router`, not reimplemented, and §0 replays all 32 recorded
 * decisions through it at the shipped floor and requires every recorded
 * `reason` back before any swept number is printed. Three harnesses in this
 * programme have lied to a judgment about the world (docs/44 §4.5b); the
 * defence that caught all three was printing the recorded column next to the
 * fresh one, so the replay check is the first thing this file does and it
 * throws rather than warns.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decide } from "../../../packages/jev-model-router/src/policy.js";
import { DEFAULT_CONFIG } from "../../../packages/jev-model-router/src/tiers.js";
import { advise, auc, crossValidate, type Sample } from "../../shared/thresholds.js";
import type { Record_ } from "./run.js";
import type { Run } from "./world.js";

const RECORDS = resolve(import.meta.dirname, "../records");

/** The shipped floor, read off the config rather than typed in again. */
export const SHIPPED = DEFAULT_CONFIG.minConfidence;

export interface Paired {
  task: string;
  /** jev's own tier score and confidence, from the routed arm's record. */
  score: number;
  confidence: number;
  /** What the router actually settled on, and why, as recorded. */
  recordedTier: string;
  recordedReason: string;
  /** Tool calls each fixed arm needed for the same task. */
  haikuCalls: number;
  sonnetCalls: number;
  haikuPassed: boolean;
  sonnetPassed: boolean;
}

export function load(): Paired[] {
  const path = resolve(RECORDS, "model.json");
  if (!existsSync(path)) throw new Error(`no ${path} -- run \`tsx src/run.ts model\` first`);
  const rows = (JSON.parse(readFileSync(path, "utf8")) as Record_).rows;
  const of = (arm: string, task: string): Run | undefined =>
    rows.find((r) => r.arm === arm && r.task === task);
  const tasks = [...new Set(rows.filter((r) => r.arm === "routerfail").map((r) => r.task))].sort();
  const out: Paired[] = [];
  for (const task of tasks) {
    const rf = of("routerfail", task);
    const h = of("haiku", task);
    const s = of("sonnet", task);
    const routed = rf?.routed;
    if (!rf || !h || !s || !routed) continue;
    if (typeof routed.tierScore !== "number" || typeof routed.tierConfidence !== "number") continue;
    out.push({
      task,
      score: routed.tierScore,
      confidence: routed.tierConfidence,
      recordedTier: routed.tier,
      recordedReason: routed.reason,
      haikuCalls: (h.calls ?? []).length,
      sonnetCalls: (s.calls ?? []).length,
      haikuPassed: h.passed === true && h.testsIntact !== false,
      sonnetPassed: s.passed === true && s.testsIntact !== false,
    });
  }
  return out;
}

/**
 * One task through the shipped policy at a given floor.
 *
 * `underspecified`/`oversized` are 0 because the records do not keep them --
 * and §0 is what makes that safe rather than assumed: those two only matter
 * through the `escalateAt` branch, which stamps its own `reason`
 * (`underspecified`/`oversized`), and the replay reproduces all 32 recorded
 * reasons without ever hitting it. If a future sweep did escalate, §0 would
 * fail instead of quietly mispricing.
 */
export function at(p: Paired, minConfidence: number): { tier: string; reason: string } {
  const d = decide({
    config: { ...DEFAULT_CONFIG, minConfidence },
    judgment: {
      tier: p.score,
      tierConfidence: p.confidence,
      effort: Number.NaN,
      effortConfidence: Number.NaN,
      underspecified: 0,
      oversized: 0,
    },
    current: DEFAULT_CONFIG.fallback,
  });
  return { tier: d.label, reason: d.reason };
}

const med = (xs: number[]): number => {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Exact two-sided sign test on the discordant pairs. */
export function signTest(less: number, more: number): number {
  const n = less + more;
  if (n === 0) return 1;
  const c = (k: number): number => {
    let r = 1;
    for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
    return r;
  };
  const k = Math.min(less, more);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += c(i);
  return Math.min(1, (2 * tail) / 2 ** n);
}

const p = (x: number): string => (x < 0.001 ? "p < 0.001" : `p = ${x.toFixed(3)}`);

function main(): void {
  const rows = load();
  if (rows.length === 0) throw new Error("no paired tasks -- records/model.json has no routerfail rows with a judgment");

  // ------------------------------------------------------------------ §0
  console.log("\n# Should `minConfidence` move? [TODO §1.4]\n");
  console.log(
    `**${rows.length} tasks**, each run by \`haiku\`, \`sonnet\` and the routed arm, from ` +
      "`records/model.json`. No API key: every number below is a replay.\n",
  );

  console.log("## 0. The replay reproduces the record, or nothing below is worth reading\n");
  const mismatched = rows.filter((r) => at(r, SHIPPED).reason !== r.recordedReason);
  console.log(
    `Every recorded decision is put back through the shipped \`decide()\` at \`minConfidence: ${SHIPPED}\`. ` +
      `**${rows.length - mismatched.length} of ${rows.length} reasons come back identical.**`,
  );
  if (mismatched.length > 0) {
    for (const r of mismatched.slice(0, 5)) {
      console.log(`- \`${r.task}\`: recorded \`${r.recordedReason}\`, replayed \`${at(r, SHIPPED).reason}\``);
    }
    throw new Error(
      `${mismatched.length} recorded decisions do not replay -- the sweep would be pricing a different policy ` +
        "than the one that ran (docs/44 §4.5b: three harnesses lied to the judgment about the world)",
    );
  }
  console.log(
    "\nSo the swept floors below are the shipped policy with one number changed, and nothing else.\n",
  );

  // ------------------------------------------------------------------ §1
  console.log("## 1. The label §1.4 asked for does not exist, and here is the instrument saying so\n");
  const label: Sample[] = rows.map((r) => ({ value: r.confidence, positive: r.haikuPassed, group: r.task }));
  const a = advise(label);
  console.log(
    `| | haiku | sonnet |\n| --- | --- | --- |\n| completed with tests intact | ` +
      `**${rows.filter((r) => r.haikuPassed).length}/${rows.length}** | ` +
      `**${rows.filter((r) => r.sonnetPassed).length}/${rows.length}** |\n`,
  );
  console.log(
    `\`advise()\` on "was the cheap tier right", with confidence as the answer: **${a.verdict}** -- ` +
      `${a.reason}.\n\n**That is the whole of TODO §1.4's blocker, measured instead of asserted.** ` +
      "docs/25's `crossValidate` fits a cutoff against a label; a label that is constant orders nothing, " +
      "so no floor is better than any other floor by correctness. This is [§2.5](../../TODO.md)'s ceiling " +
      "arriving at §1.4, which §1.4 predicted it would.\n",
  );

  // ------------------------------------------------------------------ §2
  console.log("## 2. The label that does exist is cost, and it is paired\n");
  const deltas = rows.map((r) => r.haikuCalls - r.sonnetCalls);
  const hWorse = deltas.filter((d) => d > 0).length;
  const hBetter = deltas.filter((d) => d < 0).length;
  const same = deltas.filter((d) => d === 0).length;
  console.log(
    `| | n | median tool calls |\n| --- | --- | --- |\n| \`haiku\` | ${rows.length} | ` +
      `${med(rows.map((r) => r.haikuCalls))} |\n| \`sonnet\` | ${rows.length} | ` +
      `${med(rows.map((r) => r.sonnetCalls))} |\n| paired difference | ${rows.length} | ` +
      `**${med(deltas) >= 0 ? "+" : ""}${med(deltas)}** |\n`,
  );
  console.log(
    `\nhaiku needed **more** calls on ${hWorse} tasks, **fewer** on ${hBetter}, the same on ${same} ` +
      `(${p(signTest(hBetter, hWorse))}).\n\n**This is the rebuild §1.4 asked for.** docs/36's tier labels ` +
      "were produced by an agent that could not run the tests ([43 §0.1](../../docs/43-finish.md)); these " +
      "come from 64 runs that did, and they are paired by task so the comparison is within-task rather " +
      "than between corpora. What they cannot be is a *correctness* label -- both tiers finished " +
      "everything -- so what follows prices the floor instead of scoring it.\n",
  );

  // ------------------------------------------------------------------ §3
  console.log("## 3. What the shipped floor's own overrides bought\n");
  const bound = rows.filter((r) => r.recordedReason.startsWith("low-confidence-no-downgrade"));
  console.log(
    `The floor binds only where the score says haiku and the run started at ` +
      `\`${DEFAULT_CONFIG.fallback}\` (policy.ts's \`target < currentRung\`). ` +
      `**It bound on ${bound.length} of ${rows.length} tasks.** Each of those is a task where the router ` +
      "wanted the cheap tier and the floor kept it on the expensive one -- and haiku ran every one of them " +
      "anyway in the fixed arm, so the counterfactual is measured rather than modelled.\n",
  );
  if (bound.length > 0) {
    console.log("| task | score | confidence | haiku calls | sonnet calls | what the override avoided |");
    console.log("| --- | --- | --- | --- | --- | --- |");
    for (const r of bound) {
      const d = r.haikuCalls - r.sonnetCalls;
      console.log(
        `| \`${r.task}\` | ${r.score.toFixed(2)} | ${r.confidence.toFixed(2)} | ${r.haikuCalls} | ` +
          `${r.sonnetCalls} | ${d > 0 ? `**+${d} calls**` : d < 0 ? `${d} calls` : "nothing (tie)"} |`,
      );
    }
    const bd = bound.map((r) => r.haikuCalls - r.sonnetCalls);
    const bw = bd.filter((d) => d > 0).length;
    const bb = bd.filter((d) => d < 0).length;
    console.log(
      `\nOn the floor's own ${bound.length} decisions: haiku would have cost more on ${bw}, less on ${bb}, ` +
        `the same on ${bd.filter((d) => d === 0).length}. Median **${med(bd) >= 0 ? "+" : ""}${med(bd)} calls**, ` +
        `${p(signTest(bb, bw))}. **Completion would not have changed on any of them** ` +
        `(haiku passed ${bound.filter((r) => r.haikuPassed).length}/${bound.length}).`,
    );

    // AND THE READING THAT NUMBER INVITES IS WRONG, so the base rate goes
    // directly underneath it. 8-for-8 looks like a floor that selects well;
    // haiku cost more on most tasks in the corpus, so 8-for-8 is roughly what
    // ANY eight tasks would have given. docs/44 §1.2c is the same trap twice
    // already, and the defence that works is computing the null rather than
    // describing it.
    const baseWorse = deltas.filter((d) => d > 0).length / deltas.length;
    const asIfChance = baseWorse ** bound.length;
    console.log(
      `\n> **And this is where the tidy reading has to be checked against the base rate.** ` +
        `${bw}-for-${bound.length} in the predicted direction looks like a floor that picks its moments. ` +
        `But haiku cost more on **${deltas.filter((d) => d > 0).length} of ${deltas.length}** tasks in the ` +
        `whole corpus (${(100 * baseWorse).toFixed(0)}%), so drawing *any* ${bound.length} tasks gives ` +
        `all-${bound.length} about **${(100 * asIfChance).toFixed(0)}%** of the time. ` +
        `**${bw}-for-${bound.length} is therefore not evidence that the floor is selecting** -- it is ` +
        "consistent with the floor binding on an arbitrary subset. §5 asks the selection question " +
        "directly and answers it the same way.\n",
    );
    console.log(
      `> What the record does support: the floor is **not** buying completion (nothing was at risk), it ` +
        `is buying calls, and the ${bound.length} tasks it bound on each measurably cost more under haiku. ` +
        "docs/44 §1.2c nearly published the opposite of this in both directions -- first that the floor was " +
        "wasting money, then that it was buying turns. **Buying turns on tasks it does not appear to be " +
        "choosing** is the third statement, and it is the narrow one.\n",
    );
  }

  // ------------------------------------------------------------------ §4
  console.log("## 4. Every floor value, priced\n");
  console.log("| `minConfidence` | tasks routed to haiku | tier-list price | measured tool calls | vs shipped |");
  console.log("| --- | --- | --- | --- | --- |");
  const priceOf = (tier: string): number =>
    DEFAULT_CONFIG.tiers.find((t) => t.label === tier)?.price ?? Number.NaN;
  const callsOf = (r: Paired, tier: string): number => (tier === "haiku" ? r.haikuCalls : r.sonnetCalls);
  const shippedTotals = (() => {
    let price = 0;
    let calls = 0;
    for (const r of rows) {
      const t = at(r, SHIPPED).tier;
      price += priceOf(t);
      calls += callsOf(r, t);
    }
    return { price, calls };
  })();
  for (let f = 0; f <= 1.0001; f += 0.1) {
    const floor = Math.round(f * 100) / 100;
    let haiku = 0;
    let price = 0;
    let calls = 0;
    for (const r of rows) {
      const t = at(r, floor).tier;
      if (t === "haiku") haiku++;
      price += priceOf(t);
      calls += callsOf(r, t);
    }
    const dCalls = calls - shippedTotals.calls;
    console.log(
      `| ${floor.toFixed(2)}${floor === SHIPPED ? " **(shipped)**" : ""} | ${haiku}/${rows.length} | ` +
        `${price} | ${calls} | ${dCalls === 0 ? "—" : `${dCalls > 0 ? "+" : ""}${dCalls} calls, ` +
          `${price - shippedTotals.price > 0 ? "+" : ""}${price - shippedTotals.price} price`} |`,
    );
  }
  const floor0 = (() => {
    let price = 0;
    let calls = 0;
    let haiku = 0;
    for (const r of rows) {
      const t = at(r, 0).tier;
      if (t === "haiku") haiku++;
      price += priceOf(t);
      calls += callsOf(r, t);
    }
    return { price, calls, haiku };
  })();
  console.log(
    `\n**Removing the floor entirely** (\`minConfidence: 0\`) sends ${floor0.haiku} of ${rows.length} tasks ` +
      `to haiku instead of ${rows.filter((r) => at(r, SHIPPED).tier === "haiku").length}, ` +
      `paying **${floor0.price} instead of ${shippedTotals.price}** on the tier list ` +
      `(**${(100 * (1 - floor0.price / shippedTotals.price)).toFixed(0)}% cheaper**) and ` +
      `**${floor0.calls - shippedTotals.calls > 0 ? "+" : ""}${floor0.calls - shippedTotals.calls} tool calls** ` +
      `(${shippedTotals.calls} → ${floor0.calls}), with **completion unchanged at ` +
      `${rows.filter((r) => r.haikuPassed).length}/${rows.length}**.\n`,
  );
  // THE DIAL HAS FEWER SETTINGS THAN IT LOOKS. Outside the range the answers
  // actually occupy, the floor is a constant -- which is the other half of
  // summary.md's lesson 8.4: a threshold's live range is a property of the
  // answer distribution, not of the config.
  // Only the tasks whose score already says haiku can be affected at all --
  // the floor's guard is `target < currentRung` -- so the live range is THEIR
  // confidence range, not the corpus's.
  const eligible = rows.filter((r) => at(r, 0).tier === "haiku");
  const ec = eligible.map((r) => r.confidence);
  const distinct = new Set(
    Array.from({ length: 101 }, (_, i) => rows.filter((r) => at(r, i / 100).tier === "haiku").length),
  );
  console.log(
    `**And the dial has only ${distinct.size} distinct settings on this corpus.** The floor can only act ` +
      `on the ${eligible.length} tasks whose score already says haiku (policy.ts's \`target < currentRung\`), ` +
      `and their confidence runs **${Math.min(...ec).toFixed(2)}..${Math.max(...ec).toFixed(2)}** -- so a ` +
      `floor below ${Math.min(...ec).toFixed(2)} binds on nothing and a floor above ` +
      `${Math.max(...ec).toFixed(2)} blocks every downgrade there is. ` +
      `**The shipped ${SHIPPED} sits inside that live range**, with ${bound.length} of the ${eligible.length} ` +
      "on the blocking side -- which is [44 §1.2b](../../docs/44-components.md)'s finding stated the other " +
      "way round: the number is not a spare safety margin, it is in the middle of the traffic.\n",
  );
  console.log(
    "**The floor is a price/latency dial on this corpus, not a correctness dial.** That is a narrower " +
      "statement than either thing docs/44 §1.2 nearly said, and it is the one that survives the label " +
      "being absent. Whether the extra calls matter is a budget question the caller owns -- which is " +
      "where [25](../../docs/25-thresholds.md) says a threshold belongs when the classes do not separate.\n",
  );

  // ------------------------------------------------------------------ §5
  console.log("## 5. And what a fitted floor scores held out, on the cost label\n");
  const costLabel: Sample[] = rows.map((r) => ({
    value: r.confidence,
    positive: r.haikuCalls <= r.sonnetCalls,
    group: r.task,
  }));
  const ca = advise(costLabel);
  console.log(
    `Relabelled: positive = "haiku needed no more calls than sonnet on this task" ` +
      `(${costLabel.filter((s) => s.positive).length} of ${costLabel.length} tasks).\n\n` +
      `- \`advise()\`: **${ca.verdict}** -- ${ca.reason}\n` +
      `- AUC of confidence against that label: **${auc(costLabel).toFixed(3)}**\n`,
  );
  const cv = crossValidate(costLabel, { rule: "auto" });
  // `undefined` HERE IS A RESULT, NOT A FORMATTING GAP, so it is named rather
  // than hidden. The fitted cutoffs land at or above the top of the confidence
  // range, so the rule predicts "positive" for nothing -- precision is 0/0.
  // That is the fit answering "never route down", which §4 already priced.
  const pct = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "undefined (0/0)");
  const accOf = (c: { tp: number; tn: number; n: number }): number => (c.n === 0 ? Number.NaN : (c.tp + c.tn) / c.n);
  console.log(
    `\n\`crossValidate\` with the \`auto\` placement, folds cut along tasks:\n\n` +
      `| | n | accuracy | precision | recall | tp/fp/fn/tn |\n| --- | --- | --- | --- | --- | --- |\n` +
      `| in sample | ${cv.inSample.n} | ${pct(accOf(cv.inSample))} | ` +
      `${pct(cv.inSample.precision)} | ${pct(cv.inSample.recall)} | ` +
      `${cv.inSample.tp}/${cv.inSample.fp}/${cv.inSample.fn}/${cv.inSample.tn} |\n` +
      `| **held out** | ${cv.heldOut.n} | **${pct(accOf(cv.heldOut))}** | ` +
      `${pct(cv.heldOut.precision)} | ${pct(cv.heldOut.recall)} | ` +
      `${cv.heldOut.tp}/${cv.heldOut.fp}/${cv.heldOut.fn}/${cv.heldOut.tn} |\n`,
  );
  const maxConf = Math.max(...rows.map((r) => r.confidence));
  console.log(
    `\nFitted cutoffs, one per fold: ${cv.cutoffs.map((c) => c.toFixed(2)).join(", ")}` +
      `${cv.unfittable > 0 ? ` (${cv.unfittable} fold(s) could not support the rule)` : ""}.\n`,
  );
  console.log(
    `**The \`undefined\` precision is the answer, not a gap in the table.** The fitted cutoffs sit at ` +
      `**${Math.min(...cv.cutoffs).toFixed(2)}..${Math.max(...cv.cutoffs).toFixed(2)}** while the highest ` +
      `confidence any task got is **${maxConf.toFixed(2)}** -- so the fitted rule calls *nothing* cheap ` +
      "enough to downgrade, makes no positive predictions, and its precision is 0/0. " +
      "**A fit told to find where the cheap tier wins put the line above the data.** §4's table prices " +
      `exactly that setting: at any floor ≥ 0.70, 0 of ${rows.length} tasks route to haiku, which is the ` +
      "same recommendation arrived at from the other side.\n",
  );
  console.log(
    `**And note which column looks good.** Accuracy is ${pct(accOf(cv.inSample))} in sample while recall ` +
      `is ${pct(cv.inSample.recall)}: the rule scores well by never firing, because ` +
      `${cv.inSample.fn + cv.inSample.tn} of ${cv.inSample.n} tasks are negative. That is ` +
      "[33](../../docs/33-review.md)'s \"saying nothing takes 76.5%\" in a different corpus, and it is why " +
      "the confusion counts are printed next to the rates rather than underneath them.\n",
  );
  console.log(
    `**So confidence does not predict which tier will be cheaper** (AUC ` +
      `${auc(costLabel).toFixed(3)} -- below 0.5, i.e. very slightly backwards). ` +
      "The floor changes what gets paid; it does not know *which* tasks the cheap tier handles well. " +
      "That is [24 §2](../../docs/24-adhoc-rules.md)'s verdict, not a calibration result: " +
      "**a cutoff cannot repair an answer that does not order the classes** -- the question would have to " +
      "change, and `tierConfidence` is not a question about cost at all. It is the model's confidence in " +
      "its own *difficulty* rating, and [35](../../docs/35-tension.md) is a whole report on those being " +
      "different things.\n",
  );

  // ------------------------------------------------------------------ §6
  console.log("## 6. Honest limits\n");
  console.log(
    `- **${rows.length} tasks, one repeat each.** Per-task call counts are single draws, so §3's ` +
      `${bound.length}-for-${bound.length} is ${bound.length} coin flips from a corpus that mostly lands ` +
      "that way anyway (§3's base rate). The claim that carries is docs/44 §1.1's paired test across all " +
      `${rows.length} tasks; §3 is a subset of it and cannot be read as selection.\n` +
      "- **The cost label is a proxy and it is not the caller's cost.** Tool calls are what the record has " +
      "per task; tokens and wall clock are not paired the same way (docs/44 §1.1: wall clock does not " +
      "cross the line for the routed arm).\n" +
      "- **Completion is at the ceiling, which is the actual blocker** ([TODO §2.5](../../TODO.md)). " +
      "Bash is in the toolset, so the agent iterates until the tests are green whichever model it is. " +
      "A corpus where the cheap tier can *fail* is what would turn this back into a correctness question, " +
      "and that corpus does not exist here.\n" +
      "- **So §1.4 closes as \"do not move it on this evidence\", not as \"the floor is right\".** " +
      "What is now measured is the price of every value and the absence of a correctness signal; what " +
      "is still missing is a corpus that can tell the tiers apart at all.",
  );
}

if (process.argv[1]?.endsWith("floor.ts")) main();
