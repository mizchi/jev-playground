/**
 * The tables, from the record, with no API key.
 *
 *   npx tsx src/report.ts
 *
 * The structure is docs/36 §5.2's, because the question has the same shape:
 * two numbers, and only their ratio is readable.
 *
 *   WITHIN   how far an answer moves between two draws of the SAME way.
 *            The draw noise. Free, and it is the yardstick.
 *   BETWEEN  how far its mean moves when the way changes.
 *
 * `between` alone says nothing. §5.2 had to publish a correction over exactly
 * this: a multiplier computed on 21 tasks turned out to be a 21-task artefact
 * on the full 53.
 *
 * §3 is the one that decides whether to ship the combined path, and it is not
 * §2. An answer may move less than the draw noise and still cross a cutoff,
 * and a cutoff crossing is a different decision. That is docs/25's whole
 * subject and docs/09's two mismatches were both this.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decide as decideModel, type Judgment as ModelJudgment } from "../../../packages/jev-model-router/src/route.js";
import { decide as decidePlan, type Judgment as PlanJudgment, type Pattern } from "../../../packages/jev-orchestrator/src/plan.js";
import { HERMES_ROUTER } from "../../../packages/jev-hermes/src/tiers.js";
import { TURNS } from "./requests.js";
import { WAYS, type Draw, type Record_, type Way } from "./run.js";

const PATH = resolve(import.meta.dirname, "../records/combine.json");

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]): number => {
  if (xs.length < 2) return Number.NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

/** The questions, not the derived confidences or per-option probabilities. */
const ANSWERS = ["tier", "effort", "underspecified", "oversized", "needs_more_than_one", "stay_single", "big_enough"];

function drawsFor(record: Record_, turn: string, way: Way): Draw[] {
  return record.draws.filter((d) => d.turn === turn && d.way === way && !d.error);
}

function reportCost(record: Record_): void {
  console.log("\n§1 what combining saves\n");
  console.log("  way        draws   requests/turn   input tokens/turn   ms");
  for (const way of WAYS) {
    const mine = record.draws.filter((d) => d.way === way && !d.error);
    if (mine.length === 0) continue;
    console.log(
      `  ${way.padEnd(10)} ${String(mine.length).padStart(5)}   ` +
        `${mean(mine.map((d) => d.requests)).toFixed(1).padStart(13)}   ` +
        `${mean(mine.map((d) => d.inputTokens)).toFixed(0).padStart(17)}   ` +
        `${mean(mine.map((d) => d.ms)).toFixed(0).padStart(4)}`,
    );
  }
  const c = record.draws.filter((d) => d.way === "combined" && !d.error);
  const s = record.draws.filter((d) => d.way === "separate" && !d.error);
  if (c.length === 0 || s.length === 0) return;
  const saved = mean(s.map((d) => d.inputTokens)) - mean(c.map((d) => d.inputTokens));
  console.log(
    `\n  combining saves ${saved.toFixed(0)} input tokens and ` +
      `${(mean(s.map((d) => d.requests)) - mean(c.map((d) => d.requests))).toFixed(1)} requests per turn: ` +
      `${((100 * saved) / mean(s.map((d) => d.inputTokens))).toFixed(0)}% of the tokens, at $${((saved / 1e6) * 0.042).toFixed(6)} a turn.`,
  );
  console.log(
    "  The latency is not the saving: the separate path runs its requests concurrently,\n" +
      "  so what is bought is tokens and rate-limit headroom, not wall clock.",
  );
}

function reportSpread(record: Record_): void {
  console.log("\n§2 do the answers move? within one way against between the two\n");
  console.log("  answer                 within (draw sd)   between (|mean diff|)   ratio   turns over");
  for (const key of ANSWERS) {
    const withins: number[] = [];
    const betweens: number[] = [];
    let over = 0;
    let turns = 0;
    for (const turn of TURNS) {
      const c = drawsFor(record, turn.id, "combined").map((d) => d.answers[key]).filter(Number.isFinite);
      const s = drawsFor(record, turn.id, "separate").map((d) => d.answers[key]).filter(Number.isFinite);
      if (c.length < 2 || s.length < 2) continue;
      turns += 1;
      // Pooled within-way spread: both ways' own noise, averaged. Using only
      // one way's would make the yardstick depend on which way happened to be
      // steadier on that turn.
      const within = mean([sd(c), sd(s)]);
      const between = Math.abs(mean(c) - mean(s));
      withins.push(within);
      betweens.push(between);
      if (between > within) over += 1;
    }
    if (turns === 0) continue;
    const w = mean(withins);
    const b = mean(betweens);
    console.log(
      `  ${key.padEnd(22)} ${w.toFixed(3).padStart(16)}   ${b.toFixed(3).padStart(21)}   ` +
        `${(b / w).toFixed(2).padStart(5)}   ${String(over).padStart(2)}/${turns}`,
    );
  }
  console.log(
    "\n  `ratio` under 1 means the two ways differ by less than repeated draws of one way do.\n" +
      "  `turns over` counts the turns where the gap beat that turn's own noise.",
  );
}

/** The decisions each way's answers produce, per turn. */
function decisionsOf(draws: Draw[]): { tier: string; effort: string; shape: string } {
  // Averaged over the repeats, so one outlying draw does not read as a
  // disagreement about the way. The point of §3 is which SIDE of a cutoff the
  // way lands on, which is a property of its centre, not of its tails.
  const avg = (key: string): number => {
    const xs = draws.map((d) => d.answers[key]).filter(Number.isFinite);
    return xs.length > 0 ? mean(xs) : Number.NaN;
  };
  const judgment: ModelJudgment = {
    tier: avg("tier"),
    tierConfidence: avg("tier__confidence"),
    effort: avg("effort"),
    effortConfidence: avg("effort__confidence"),
    underspecified: avg("underspecified"),
    oversized: avg("oversized"),
  };
  const model = decideModel({ config: HERMES_ROUTER, judgment, current: HERMES_ROUTER.fallback });
  // The topology label is taken by majority over the draws, since it is a
  // label and not a number; the probabilities are averaged for the runner-up
  // substitution the policy may do.
  const counts = new Map<string, number>();
  for (const d of draws) if (d.topology) counts.set(d.topology, (counts.get(d.topology) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const probabilities: Record<string, number> = {};
  for (const d of draws) {
    for (const [key, value] of Object.entries(d.answers)) {
      if (key.startsWith("topology__p_")) {
        const name = key.slice("topology__p_".length);
        probabilities[name] = (probabilities[name] ?? 0) + value / draws.length;
      }
    }
  }
  const planJudgment: PlanJudgment = {
    gate: avg("needs_more_than_one"),
    topology: top as Pattern | null,
    topologyConfidence: avg("topology__confidence"),
    probabilities,
    staySingle: avg("stay_single"),
    size: avg("big_enough"),
  };
  const plan = decidePlan(planJudgment);
  return {
    tier: model.label,
    effort: model.effort ?? "-",
    shape: `${plan.shape}${plan.split ? ` x${plan.workers}` : ""}`,
  };
}

function reportDecisions(record: Record_): void {
  console.log("\n§3 do the DECISIONS agree? the only question that decides anything\n");
  console.log("  turn                 combined                     separate                     agree");
  let agree = 0;
  let total = 0;
  const disagreements: string[] = [];
  for (const turn of TURNS) {
    const c = drawsFor(record, turn.id, "combined");
    const s = drawsFor(record, turn.id, "separate");
    if (c.length === 0 || s.length === 0) continue;
    total += 1;
    const a = decisionsOf(c);
    const b = decisionsOf(s);
    const same = a.tier === b.tier && a.effort === b.effort && a.shape === b.shape;
    if (same) agree += 1;
    else {
      const which = [
        a.tier !== b.tier ? `tier ${a.tier}/${b.tier}` : "",
        a.effort !== b.effort ? `effort ${a.effort}/${b.effort}` : "",
        a.shape !== b.shape ? `shape ${a.shape}/${b.shape}` : "",
      ].filter(Boolean);
      disagreements.push(`${turn.id}: ${which.join(", ")}`);
    }
    const show = (d: { tier: string; effort: string; shape: string }): string =>
      `${d.tier}/${d.effort} ${d.shape}`.padEnd(27);
    console.log(`  ${turn.id.padEnd(20)} ${show(a)}  ${show(b)}  ${same ? "yes" : "NO"}`);
  }
  console.log(`\n  ${agree}/${total} turns decide the same thing both ways.`);
  for (const d of disagreements) console.log(`    ${d}`);
  if (disagreements.length > 0) {
    console.log(
      "\n  A disagreement here does NOT mean the answers moved a lot -- §2 is where that is.\n" +
        "  It means an answer landed on the other side of a cutoff, which is docs/25's subject.",
    );
  }
}

function reportBoundaries(record: Record_): void {
  // Which disagreements are boundary effects rather than real movement. An
  // answer sitting within its own draw noise of a cutoff will cross it on
  // some draws whatever the way, and calling that a difference between the
  // ways is the mistake this section exists to prevent.
  console.log("\n§4 how close is each decision to its cutoff?\n");
  const cuts: [string, number, string][] = [
    ["tier", HERMES_ROUTER.cuts?.[0] ?? Number.NaN, "sonnet | opus"],
    ["underspecified", 0.7, "escalate"],
    ["oversized", 0.7, "escalate"],
    ["needs_more_than_one", 0.5, "single | split"],
    ["big_enough", 0.5, "size floor"],
  ];
  console.log("  turn                 answer                  value    cutoff   gap    draw sd   within noise?");
  for (const turn of TURNS) {
    const all = [...drawsFor(record, turn.id, "combined"), ...drawsFor(record, turn.id, "separate")];
    if (all.length < 2) continue;
    for (const [key, cut, what] of cuts) {
      const xs = all.map((d) => d.answers[key]).filter(Number.isFinite);
      if (xs.length < 2 || !Number.isFinite(cut)) continue;
      const m = mean(xs);
      const spread = sd(xs);
      const gap = Math.abs(m - cut);
      if (gap > spread * 2) continue;
      console.log(
        `  ${turn.id.padEnd(20)} ${`${key} (${what})`.padEnd(23)} ${m.toFixed(3).padStart(5)}   ` +
          `${cut.toFixed(2).padStart(6)}   ${gap.toFixed(3)}  ${spread.toFixed(3).padStart(7)}   ${gap < spread ? "YES" : "close"}`,
      );
    }
  }
  console.log(
    "\n  Only rows within two draw-deviations of a cutoff are listed; anything else is not a\n" +
      "  boundary case. A `YES` means the answer is closer to its cutoff than one draw of noise,\n" +
      "  so which side it lands on is not a property of the way it was asked.",
  );
}

function main(): void {
  if (!existsSync(PATH)) {
    console.log("no records/combine.json; run `npm run run` (needs TYPESAFE_API_KEY)");
    return;
  }
  const record = JSON.parse(readFileSync(PATH, "utf8")) as Record_;
  const turns = new Set(record.draws.map((d) => d.turn)).size;
  const repeats = new Set(record.draws.map((d) => d.repeat)).size;
  console.log(
    `\n  ${record.draws.length} draws: ${turns} turns x ${repeats} repeats x ${WAYS.length} ways` +
      `  ·  cuts ${JSON.stringify(record.config.cuts)}, framing ${record.config.framing}`,
  );
  const failed = record.draws.filter((d) => d.error);
  if (failed.length > 0) console.log(`  ${failed.length} draws failed and are excluded`);
  reportCost(record);
  reportSpread(record);
  reportDecisions(record);
  reportBoundaries(record);
  console.log("");
}

if (process.argv[1]?.endsWith("report.ts")) main();
