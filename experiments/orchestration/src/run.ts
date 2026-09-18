/**
 * docs/31 -- is a documented gate better asked, or composed from its parts?
 *
 *   npx tsx src/run.ts --replay              # re-derive every table, no API key
 *   npx tsx src/run.ts --arm all --repeat 3  # 114 requests, about $0.002
 *   npx tsx src/run.ts --arm nohatch         # 38 requests: the escape hatch's price
 *
 * `multi-agent-orchestration` states its decision as a boolean over four
 * named conditions, so both readings are available from one request: the
 * whole judgment as one noul, and the four atoms combined in code. The
 * corpus fixes the four facts per scenario and the skill's own sentence
 * fixes the answer; `scenarios.ts` says how.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Jev, choice, noul } from "../../shared/jev.js";
import { drawNoise, mean, sd, separation, type Sample } from "../../shared/thresholds.js";
import {
  ARM_BLURB,
  ARMS,
  BIG_ENOUGH,
  DECISION,
  DECISION_PLAIN,
  DIFFERENT,
  INDEPENDENT,
  STAY_SINGLE,
  THREE,
  TOPOLOGY,
  questions,
  stateFor,
  type ArmName,
} from "./arms.js";
import { ruleVerdict } from "./rules.js";
import {
  CONDITION_KEYS,
  PATTERNS,
  SCENARIOS,
  goMulti,
  goMultiWithThree,
  type ConditionKey,
  type Pattern,
} from "./scenarios.js";

const HERE = import.meta.dirname;
const RECORD = resolve(HERE, "../records/orchestration.json");

const ARGS = process.argv.slice(2);
const flag = (n: string) => ARGS.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = ARGS.indexOf(`--${n}`);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d;
};

/** Where a noul becomes a yes. A level boundary, not a fitted number. */
const AT = 0.5;

interface Row {
  scenario: string;
  arm: ArmName;
  repeat: number;
  decision: number;
  decisionPlain: number;
  independent: number;
  different: number;
  three: number;
  bigEnough: number;
  topology: string;
  topologyConfidence: number;
  staySingle: number;
  ms: number;
  inputTokens: number;
}

const pad = (s: string, n: number) => s.padEnd(n);
const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "  - ");
const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : "  - ");
const rule = (n = 104) => console.log("-".repeat(n));

const readRecord = (): Row[] => (existsSync(RECORD) ? (JSON.parse(readFileSync(RECORD, "utf8")) as Row[]) : []);

/** Mean of a scenario's repeats, per arm. */
function averaged(rows: Row[], arm: ArmName): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const s of SCENARIOS) {
    const mine = rows.filter((r) => r.arm === arm && r.scenario === s.id);
    if (mine.length === 0) continue;
    const avg = (pick: (r: Row) => number) => mean(mine.map(pick));
    // The topology is a class, so it takes the majority rather than a mean.
    const counts = new Map<string, number>();
    for (const r of mine) counts.set(r.topology, (counts.get(r.topology) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    out.set(s.id, {
      ...mine[0],
      decision: avg((r) => r.decision),
      decisionPlain: avg((r) => r.decisionPlain),
      independent: avg((r) => r.independent),
      different: avg((r) => r.different),
      three: avg((r) => r.three),
      bigEnough: avg((r) => r.bigEnough),
      topology: top,
      topologyConfidence: avg((r) => r.topologyConfidence),
      staySingle: avg((r) => r.staySingle),
      ms: avg((r) => r.ms),
      inputTokens: avg((r) => r.inputTokens),
    });
  }
  return out;
}

// -------------------------------------------------------------------- sections

function sectionCorpus(): void {
  console.log("\n  0. THE CORPUS\n");
  const multi = SCENARIOS.filter((s) => goMulti(s.conditions));
  const disagree = SCENARIOS.filter((s) => goMulti(s.conditions) !== goMultiWithThree(s.conditions));
  const byTop = new Map<string, number>();
  for (const s of SCENARIOS) byTop.set(s.topology, (byTop.get(s.topology) ?? 0) + 1);
  console.log(`  ${SCENARIOS.length} scenarios: ${multi.length} the gate sends to more than one worker, ${SCENARIOS.length - multi.length} it keeps single`);
  console.log(`  topologies: ${[...byTop].sort().map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`  ${SCENARIOS.filter((s) => s.trap).length} are rows of the skill's own "Common mistakes" table`);
  console.log(`  ${disagree.length} are built so that admitting condition 3 into the rule changes the answer`);
  console.log("");
  console.log(`  ${pad("condition", 12)} ${pad("true", 5)} ${pad("false", 6)}  what it is`);
  const labels: Record<ConditionKey, string> = {
    independent: "(1) parts that can run in parallel",
    different: "(2) workers would differ in information, tools or permissions",
    three: "(3) artifacts checkable mechanically -- NOT in the rule",
    bigEnough: "(4) large enough that another worker's cost is small",
  };
  for (const key of CONDITION_KEYS) {
    const t = SCENARIOS.filter((s) => s.conditions[key]).length;
    console.log(`  ${pad(key, 12)} ${pad(String(t), 5)} ${pad(String(SCENARIOS.length - t), 6)}  ${labels[key]}`);
  }
}

function sectionRules(): void {
  console.log("\n  1. THE FREE BASELINE (keywords, no API)\n");
  let right = 0;
  let topRight = 0;
  const trapWrong: string[] = [];
  for (const s of SCENARIOS) {
    const v = ruleVerdict(s);
    const want = goMulti(s.conditions);
    if (v.multi === want) right += 1;
    else if (s.trap) trapWrong.push(s.id);
    if (v.topology === s.topology) topRight += 1;
  }
  const traps = SCENARIOS.filter((s) => s.trap);
  console.log(`  gate: ${right}/${SCENARIOS.length} (${pct(right / SCENARIOS.length)})`);
  console.log(`  topology: ${topRight}/${SCENARIOS.length} (${pct(topRight / SCENARIOS.length)})`);
  console.log(`  on the ${traps.length} "Common mistakes" rows it gets ${traps.length - trapWrong.length}/${traps.length} right`);
  if (trapWrong.length > 0) console.log(`    wrong on: ${trapWrong.join(", ")}`);
  console.log("");
  console.log("  The traps are requests that use the words while being stay-single. A keyword rule");
  console.log("  reads \"three agents, three worktrees\" as three agents. That is the point of them.");
}

interface GateScore {
  right: number;
  falseMulti: string[];
  falseSingle: string[];
}

function gateScore(pick: (id: string) => boolean | undefined): GateScore {
  let right = 0;
  const falseMulti: string[] = [];
  const falseSingle: string[] = [];
  for (const s of SCENARIOS) {
    const got = pick(s.id);
    if (got === undefined) continue;
    const want = goMulti(s.conditions);
    if (got === want) right += 1;
    else if (got) falseMulti.push(s.id);
    else falseSingle.push(s.id);
  }
  return { right, falseMulti, falseSingle };
}

function sectionGate(rows: Row[]): void {
  const all = averaged(rows, "all");
  if (all.size === 0) return;
  console.log("\n  2. ASKED, OR COMPOSED?\n");
  const direct = gateScore((id) => {
    const r = all.get(id);
    return r === undefined ? undefined : r.decision >= AT;
  });
  const composed = gateScore((id) => {
    const r = all.get(id);
    if (r === undefined) return undefined;
    return (r.independent >= AT || r.different >= AT) && r.bigEnough >= AT;
  });
  const withThree = gateScore((id) => {
    const r = all.get(id);
    if (r === undefined) return undefined;
    return (r.independent >= AT || r.different >= AT || r.three >= AT) && r.bigEnough >= AT;
  });
  const hatch = gateScore((id) => {
    const r = all.get(id);
    return r === undefined ? undefined : r.staySingle < AT;
  });
  const n = all.size;
  const line = (name: string, g: GateScore, note: string) =>
    console.log(
      `  ${pad(name, 24)} ${pad(`${g.right}/${n}`, 8)} ${pad(pct(g.right / n), 6)} ` +
        `${pad(`+${g.falseMulti.length} / -${g.falseSingle.length}`, 12)} ${note}`,
    );
  console.log(`  ${pad("reading", 24)} ${pad("right", 8)} ${pad("", 6)} ${pad("over / under", 12)} how the answer was got`);
  line("direct (cost named)", direct, "one noul, cost of a second worker stated first");
  const plain = gateScore((id) => {
    const r = all.get(id);
    return r === undefined ? undefined : r.decisionPlain >= AT;
  });
  line("direct (plain)", plain, "the same decision with nothing named");
  line("composed (1|2)&4", composed, "the skill's rule over four atomic nouls");
  line("composed (1|2|3)&4", withThree, "the same four answers, condition 3 admitted");
  line("stay_single inverted", hatch, "the escape hatch read as the decision");
  console.log("");
  console.log("  `+` is sent to more than one worker when the skill says single; `-` is the reverse.");
  console.log("");
  if (direct.falseMulti.length + direct.falseSingle.length > 0) {
    console.log(`  direct is wrong on: ${[...direct.falseMulti.map((x) => `+${x}`), ...direct.falseSingle.map((x) => `-${x}`)].join(", ")}`);
  }
  if (composed.falseMulti.length + composed.falseSingle.length > 0) {
    console.log(`  composed is wrong on: ${[...composed.falseMulti.map((x) => `+${x}`), ...composed.falseSingle.map((x) => `-${x}`)].join(", ")}`);
  }

  // Which reading is right WHERE. The aggregate hides that the three
  // readings fail on different classes of scenario.
  console.log("\n  2b. THE SAME FOUR READINGS, BY CLASS OF SCENARIO\n");
  const classes: { name: string; of: typeof SCENARIOS }[] = [
    { name: "traps (the skill's own)", of: SCENARIOS.filter((s) => s.trap) },
    {
      name: "condition-3-only",
      of: SCENARIOS.filter((s) => goMulti(s.conditions) !== goMultiWithThree(s.conditions)),
    },
    {
      name: "plain multi",
      of: SCENARIOS.filter((s) => goMulti(s.conditions)),
    },
    {
      name: "plain single",
      of: SCENARIOS.filter(
        (s) => !goMulti(s.conditions) && !s.trap && goMulti(s.conditions) === goMultiWithThree(s.conditions),
      ),
    },
  ];
  const readings: { name: string; pick: (r: Row) => boolean }[] = [
    { name: "direct (cost)", pick: (r) => r.decision >= AT },
    { name: "direct (plain)", pick: (r) => r.decisionPlain >= AT },
    { name: "(1|2)&4", pick: (r) => (r.independent >= AT || r.different >= AT) && r.bigEnough >= AT },
    { name: "(1|2|3)&4", pick: (r) => (r.independent >= AT || r.different >= AT || r.three >= AT) && r.bigEnough >= AT },
    { name: "stay_single", pick: (r) => r.staySingle < AT },
  ];
  console.log(`  ${pad("class", 24)} ${pad("n", 4)} ${readings.map((x) => pad(x.name, 15)).join("")}`);
  for (const cls of classes) {
    const cells = readings.map((reading) => {
      let right = 0;
      let n = 0;
      for (const s of cls.of) {
        const r = all.get(s.id);
        if (r === undefined) continue;
        n += 1;
        if (reading.pick(r) === goMulti(s.conditions)) right += 1;
      }
      return pad(n === 0 ? "-" : `${right}/${n}`, 15);
    });
    console.log(`  ${pad(cls.name, 24)} ${pad(String(cls.of.length), 4)} ${cells.join("")}`);
  }
  console.log("");
  console.log("  The classes overlap by construction: a trap and a condition-3-only are both singles.");
  console.log("  What the columns show is that the aggregate hides the shape -- the cost-framed noul");
  console.log("  is perfect on everything the skill keeps single and useless on everything it splits.");
}

function sectionConditions(rows: Row[]): void {
  const all = averaged(rows, "all");
  if (all.size === 0) return;
  console.log("\n  3. THE FOUR CONDITIONS, ONE AT A TIME\n");
  const key: Record<ConditionKey, (r: Row) => number> = {
    independent: (r) => r.independent,
    different: (r) => r.different,
    three: (r) => r.three,
    bigEnough: (r) => r.bigEnough,
  };
  console.log(
    `  ${pad("condition", 12)} ${pad("right", 7)} ${pad("", 6)} ${pad("true mean", 10)} ${pad("false mean", 11)} ${pad("gap", 6)} AUC`,
  );
  for (const k of CONDITION_KEYS) {
    const samples: Sample[] = [];
    let right = 0;
    let n = 0;
    for (const s of SCENARIOS) {
      const r = all.get(s.id);
      if (r === undefined) continue;
      const v = key[k](r);
      samples.push({ value: v, positive: s.conditions[k], group: s.id });
      n += 1;
      if (v >= AT === s.conditions[k]) right += 1;
    }
    const sep = separation(samples);
    const yes = samples.filter((x) => x.positive).map((x) => x.value);
    const no = samples.filter((x) => !x.positive).map((x) => x.value);
    console.log(
      `  ${pad(k, 12)} ${pad(`${right}/${n}`, 7)} ${pad(pct(right / n), 6)} ` +
        `${pad(`${num(mean(yes))} ±${num(sd(yes))}`, 10)} ${pad(`${num(mean(no))} ±${num(sd(no))}`, 11)} ` +
        `${pad(num(sep.gap), 6)} ${num(sep.auc, 3)}`,
    );
  }
  console.log("");
  console.log("  A composed gate is only as good as its worst atom, and the boolean says which ones");
  console.log("  matter: an error in (4) flips every answer, an error in (1) only flips the ones");
  console.log("  where (2) is also false.");
}

function sectionThree(rows: Row[]): void {
  const all = averaged(rows, "all");
  if (all.size === 0) return;
  const disagree = SCENARIOS.filter((s) => goMulti(s.conditions) !== goMultiWithThree(s.conditions));
  if (disagree.length === 0) return;
  console.log("\n  4. WHAT THE BOLD SENTENCE IS WORTH\n");
  console.log('  The skill says: "**3 is not a reason to spawn.**" These scenarios have condition 3,');
  console.log("  no condition 1 or 2, and enough size for condition 4 -- so the two readings differ.\n");
  console.log(`  ${pad("scenario", 16)} ${pad("(1)", 6)} ${pad("(2)", 6)} ${pad("(3)", 6)} ${pad("(4)", 6)} ${pad("rule", 6)} ${pad("+3", 5)} direct`);
  for (const s of disagree) {
    const r = all.get(s.id);
    if (r === undefined) continue;
    const composed = (r.independent >= AT || r.different >= AT) && r.bigEnough >= AT;
    const three = (r.independent >= AT || r.different >= AT || r.three >= AT) && r.bigEnough >= AT;
    console.log(
      `  ${pad(s.id, 16)} ${pad(num(r.independent), 6)} ${pad(num(r.different), 6)} ${pad(num(r.three), 6)} ` +
        `${pad(num(r.bigEnough), 6)} ${pad(composed ? "multi" : "single", 6)} ${pad(three ? "multi" : "single", 5)} ${num(r.decision)}`,
    );
  }
  console.log("");
  console.log("  Every one of them should be `single`. The `rule` column is the skill's boolean; `+3`");
  console.log("  is what a reader who took condition 3 as a reason would get; `direct` is the noul.");
}

function sectionTopology(rows: Row[]): void {
  for (const arm of ARMS) {
    const avg = averaged(rows, arm);
    if (avg.size === 0) continue;
    console.log(`\n  5${arm === "all" ? "" : "b"}. THE TOPOLOGY CHOICE (arm: ${arm})\n`);
    // Only the scenarios the gate sends to more than one worker have a
    // topology to be right about; the rest are scored on the escape hatch.
    const multi = SCENARIOS.filter((s) => s.topology !== "single");
    const single = SCENARIOS.filter((s) => s.topology === "single");
    let right = 0;
    let n = 0;
    const wrong: string[] = [];
    for (const s of multi) {
      const r = avg.get(s.id);
      if (r === undefined) continue;
      n += 1;
      if (r.topology === s.topology) right += 1;
      else wrong.push(`${s.id}: ${s.topology} -> ${r.topology}`);
    }
    console.log(`  on the ${n} that have a topology: ${right}/${n} (${pct(right / n)})`);
    for (const w of wrong) console.log(`     ${w}`);
    if (arm === "all") {
      let hatchRight = 0;
      let hatchN = 0;
      for (const s of single) {
        const r = avg.get(s.id);
        if (r === undefined) continue;
        hatchN += 1;
        if (r.staySingle >= AT) hatchRight += 1;
      }
      console.log("");
      console.log(`  on the ${hatchN} the skill keeps single, \`stay_single\` fires ${hatchRight}/${hatchN} (${pct(hatchRight / hatchN)})`);
      const falseHatch = multi.filter((s) => (avg.get(s.id)?.staySingle ?? 0) >= AT).map((s) => s.id);
      console.log(`  and on the ${n} that have a topology it fires anyway on ${falseHatch.length}${falseHatch.length > 0 ? `: ${falseHatch.join(", ")}` : ""}`);
    } else {
      // Without the hatch, what does the choice say about the stay-singles?
      const forced = new Map<string, number>();
      for (const s of single) {
        const r = avg.get(s.id);
        if (r === undefined) continue;
        forced.set(r.topology, (forced.get(r.topology) ?? 0) + 1);
      }
      console.log("");
      console.log("  with no escape hatch, the stay-single scenarios are forced into:");
      for (const [p, c] of [...forced].sort((a, b) => b[1] - a[1])) console.log(`     ${pad(p, 14)} ${c}`);
      // docs/21 §7's question: does the confidence know it was forced?
      const conf = (of: typeof SCENARIOS) =>
        of.map((s) => avg.get(s.id)?.topologyConfidence).filter((x): x is number => x !== undefined);
      const real = conf(multi);
      const forcedConf = conf(single);
      console.log("");
      console.log(
        `  confidence on the ${real.length} real ones ${num(mean(real))} ±${num(sd(real))}, ` +
          `on the ${forcedConf.length} forced ones ${num(mean(forcedConf))} ±${num(sd(forcedConf))}`,
      );
      const sep = separation([
        ...real.map((v) => ({ value: v, positive: true })),
        ...forcedConf.map((v) => ({ value: v, positive: false })),
      ]);
      console.log(`  AUC of confidence as a "was this a real choice" detector: ${num(sep.auc, 3)}`);
      console.log("  A choice always answers. Whether its confidence admits to having been forced is");
      console.log("  the only thing that could substitute for the separate question -- docs/21 §7.");
    }
  }
}

function sectionConfusion(rows: Row[]): void {
  const avg = averaged(rows, "all");
  if (avg.size === 0) return;
  console.log("\n  6. WHICH PATTERNS GET CONFUSED\n");
  const labels = [...PATTERNS, "single"] as const;
  console.log(`  ${pad("want \\ got", 14)} ${labels.map((l) => pad(l.slice(0, 5), 6)).join("")}`);
  for (const want of labels) {
    const mine = SCENARIOS.filter((s) => s.topology === want);
    if (mine.length === 0) continue;
    const counts = new Map<string, number>();
    for (const s of mine) {
      const r = avg.get(s.id);
      if (r === undefined) continue;
      // A stay-single whose hatch fired counts as "single", which is what
      // the tool would do with it.
      const got = want === "single" && r.staySingle >= AT ? "single" : r.topology;
      counts.set(got, (counts.get(got) ?? 0) + 1);
    }
    console.log(`  ${pad(want, 14)} ${labels.map((l) => pad(String(counts.get(l) ?? ""), 6)).join("")}`);
  }
  console.log("");
  console.log("  The skill names three confusions itself: handoff against agent-as-tool, supervisor");
  console.log("  against dynamic DAG, and fan-out against debate. docs/31 §6 reads what happened.");
}

function sectionNoise(rows: Row[]): void {
  const mine = rows.filter((r) => r.arm === "all");
  const repeats = new Set(mine.map((r) => r.repeat)).size;
  if (repeats < 2) return;
  console.log("\n  7. ASKING AGAIN\n");
  const fields: [string, (r: Row) => number][] = [
    ["decision", (r) => r.decision],
    ["decisionPlain", (r) => r.decisionPlain],
    ["independent", (r) => r.independent],
    ["different", (r) => r.different],
    ["three", (r) => r.three],
    ["bigEnough", (r) => r.bigEnough],
    ["staySingle", (r) => r.staySingle],
  ];
  console.log(`  ${repeats} draws of each scenario.\n`);
  console.log(`  ${pad("question", 13)} ${pad("within-scenario sd", 19)} ${pad("max spread", 11)} crossings of ${AT}`);
  for (const [name, pick] of fields) {
    const samples: Sample[] = mine.map((r) => ({ value: pick(r), positive: true, group: r.scenario }));
    const noise = drawNoise(samples);
    let crossings = 0;
    for (const s of SCENARIOS) {
      const vs = mine.filter((r) => r.scenario === s.id).map(pick);
      if (vs.length < 2) continue;
      if (vs.some((v) => v >= AT) && vs.some((v) => v < AT)) crossings += 1;
    }
    console.log(
      `  ${pad(name, 13)} ${pad(num(noise.sd, 3), 19)} ${pad(num(noise.maxSpread, 3), 11)} ${crossings}/${SCENARIOS.length}`,
    );
  }
  // The topology is a class, so the question is whether it changed at all.
  let flipped = 0;
  for (const s of SCENARIOS) {
    const tops = new Set(mine.filter((r) => r.scenario === s.id).map((r) => r.topology));
    if (tops.size > 1) flipped += 1;
  }
  console.log(`  ${pad("topology", 13)} ${pad("(a class)", 19)} ${pad("", 11)} ${flipped}/${SCENARIOS.length} changed between draws`);
  console.log("");
  console.log("  A crossing is a scenario whose answer changed side between draws -- the only kind of");
  console.log("  noise that reaches a decision. docs/29 and docs/30 both listed this as unmeasured.");
}

// ------------------------------------------------------------------ collection

async function collect(arms: ArmName[], repeats: number): Promise<Row[]> {
  const jev = new Jev();
  const fresh: Row[] = [];
  for (const arm of arms) {
    for (let r = 0; r < repeats; r += 1) {
      for (const s of SCENARIOS) {
        const started = Date.now();
        const res = await jev.ask(stateFor(s), questions(arm));
        const ms = Date.now() - started;
        const top = choice(res.answers[TOPOLOGY]);
        fresh.push({
          scenario: s.id,
          arm,
          repeat: r,
          decision: noul(res.answers[DECISION]),
          decisionPlain: noul(res.answers[DECISION_PLAIN]),
          independent: noul(res.answers[INDEPENDENT]),
          different: noul(res.answers[DIFFERENT]),
          three: noul(res.answers[THREE]),
          bigEnough: noul(res.answers[BIG_ENOUGH]),
          topology: top.choice,
          topologyConfidence: top.confidence,
          staySingle: noul(res.answers[STAY_SINGLE]),
          ms,
          inputTokens: res.usage.input_tokens,
        });
        process.stderr.write(`\r  ${arm} ${fresh.length}/${SCENARIOS.length * repeats * arms.length}`);
      }
    }
  }
  process.stderr.write("\n");
  const kept = readRecord().filter((r) => !arms.includes(r.arm) || r.repeat >= repeats);
  const all = [...kept, ...fresh];
  writeFileSync(RECORD, `[\n${all.map((r) => `  ${JSON.stringify(r)}`).join(",\n")}\n]\n`);
  console.log(
    `  ${jev.calls} calls, ${jev.inputTokens} input tokens, $${((jev.inputTokens / 1e6) * 0.042).toFixed(4)}, ` +
      `${Math.round(jev.totalMs / jev.calls)} ms mean` + (jev.retriedCalls > 0 ? `, ${jev.retriedCalls} retried` : ""),
  );
  return all;
}

async function main(): Promise<void> {
  console.log("=".repeat(104));
  console.log("  A DOCUMENTED GATE: BETTER ASKED, OR COMPOSED FROM ITS PARTS? (docs/31)");
  rule();
  let rows = readRecord();
  if (ARGS.includes("--arm")) {
    const arms = opt("arm", "all").split(",") as ArmName[];
    for (const a of arms) if (!ARMS.includes(a)) throw new Error(`unknown arm ${a}`);
    rows = await collect(arms, Number(opt("repeat", "1")));
  }
  sectionCorpus();
  rule();
  sectionRules();
  if (rows.length > 0) {
    rule();
    sectionGate(rows);
    rule();
    sectionConditions(rows);
    rule();
    sectionThree(rows);
    rule();
    sectionTopology(rows);
    rule();
    sectionConfusion(rows);
    rule();
    sectionNoise(rows);
  }
  rule();
  const tokens = rows.reduce((a, r) => a + r.inputTokens, 0);
  console.log(
    `  ${rows.length} recorded requests: ${tokens} input tokens, $${((tokens / 1e6) * 0.042).toFixed(4)}, ` +
      `${num(mean(rows.map((r) => r.ms)), 0)} ms mean`,
  );
  void ARM_BLURB;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
