/**
 * Fit the gate's cutoff on the 38 scenarios. From the record, no API key.
 *
 *   npx tsx src/fit.ts
 *
 * docs/37 §9 left this as homework, and the reason it is homework rather than
 * a number is worth restating: `jev-orchestrator` shipped with `gateAt: 0.5`,
 * and `experiments/hermes` then found the gate answering 0.055..0.446 across
 * eight varied turns -- ENTIRELY BELOW its own cutoff. A gate that cannot
 * reach its threshold is not strict, it is off.
 *
 * Two things make this fittable here and not there. This corpus has labels
 * (the skill's own rule over hand-set conditions, 22 multi / 16 single), and
 * it has three repeats per scenario, so the draw noise is measurable -- which
 * is what says whether a fitted margin is a margin at all.
 *
 * THE CUTOFF IS FITTED PER FRAMING, and that is the point rather than a
 * detail. docs/31 §2b measured the two wordings as strict and loose, not as
 * better and worse:
 *
 *   class                     n    cost named    cost unnamed
 *   the skill's own traps     7    6/7           4/7
 *   plainly multi             22   6/22          18/22
 *   plainly single            6    6/6           5/6
 *
 * If one wording compresses its answers into a different range than the
 * other, then a shared cutoff is not a shared policy -- it is one policy for
 * the wording it was fitted on and an accident for the other. Both are
 * recorded in the same rows (`decision` and `decisionPlain`), so this costs
 * nothing to check.
 *
 * Every number here comes from `records/orchestration.json`, which already
 * exists. Zero requests (docs/19 §4).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  advise,
  confusion,
  crossValidate,
  drawNoise,
  place,
  separation,
  type Confusion,
  type Placement,
  type Sample,
} from "../../shared/thresholds.js";
import { SCENARIOS } from "./scenarios.js";

interface Row {
  scenario: string;
  arm: string;
  repeat: number;
  decision: number;
  decisionPlain: number;
  independent: number;
  different: number;
  three: number;
  bigEnough: number;
  staySingle: number;
}

const RECORD = resolve(import.meta.dirname, "../records/orchestration.json");

/** The two framings, by the field each is recorded under. */
const FRAMINGS = [
  { name: "cost named", key: "decision" as const, note: "the strict wording; jev-orchestrator's default" },
  { name: "cost unnamed", key: "decisionPlain" as const, note: "the permissive wording" },
  // Asked from the other side. Recorded and NOT wired into the decision
  // (docs/31 §2b measured it loosest on the traps), but it has a cutoff like
  // anything else and it is free to fit, so its range is worth seeing.
  { name: "inverted", key: "staySingle" as const, note: "stay_single, inverted below" },
];

const pad = (s: string, n: number): string => s.padEnd(n);
const num = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : "  -  ");

/** The label: the skill's own rule. Checked against `topology` -- they agree on all 38. */
const LABEL = new Map(SCENARIOS.map((s) => [s.id, s.topology !== "single"]));
const TRAP = new Map(SCENARIOS.map((s) => [s.id, Boolean(s.trap)]));

function samplesFor(rows: Row[], key: "decision" | "decisionPlain" | "staySingle"): Sample[] {
  return rows.map((r) => ({
    // `stay_single` answers the opposite question, so it is inverted to be
    // comparable: high must mean "split" for every row in the same table.
    value: key === "staySingle" ? 1 - r[key] : r[key],
    positive: LABEL.get(r.scenario) ?? false,
    // The group is the SCENARIO, so `crossValidate` never puts two repeats of
    // one scenario on opposite sides of a fold and `drawNoise` can see them.
    group: r.scenario,
  }));
}

function reportRange(byFraming: Map<string, Sample[]>): void {
  console.log(`\n§1 where each wording's answers actually land\n`);
  console.log("  wording        n    min    max   mean(single)  mean(multi)   draw sd   reaches 0.5?");
  for (const { name } of FRAMINGS) {
    const s = byFraming.get(name);
    if (!s) continue;
    const values = s.map((x) => x.value);
    const pos = s.filter((x) => x.positive).map((x) => x.value);
    const neg = s.filter((x) => !x.positive).map((x) => x.value);
    const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    const max = Math.max(...values);
    console.log(
      `  ${pad(name, 14)} ${String(s.length).padStart(3)}  ${num(Math.min(...values))}  ${num(max)}   ` +
        `${num(avg(neg)).padStart(11)}  ${num(avg(pos)).padStart(11)}   ${num(drawNoise(s).sd).padStart(7)}   ` +
        (max >= 0.5 ? "yes" : "NO -- the default cutoff is above every answer"),
    );
  }
  console.log(
    "\n  This is the section docs/37 §9 needed and did not have. A wording whose\n" +
      "  answers never reach the cutoff is not a strict gate, it is a disabled one.",
  );
}

function reportAdvice(byFraming: Map<string, Sample[]>): void {
  // The component's own rule: the first thing to say is not a number, it is
  // whether a number would help (docs/25 §1).
  console.log(`\n§2 should a cutoff be fitted at all?\n`);
  console.log("  wording        verdict       AUC     gap    maxNeg  minPos   why");
  for (const { name } of FRAMINGS) {
    const s = byFraming.get(name);
    if (!s) continue;
    const a = advise(s, { range: 1 });
    console.log(
      `  ${pad(name, 14)} ${pad(a.verdict, 13)} ${num(a.separation.auc)}  ${num(a.separation.gap)}  ` +
        `${num(a.separation.maxNeg)}  ${num(a.separation.minPos)}   ${a.reason.slice(0, 60)}`,
    );
  }
}

function costOf(c: Confusion, penalty: number): number {
  // The asymmetry docs/31 §2b is about, as a loss rather than a threshold
  // (docs/25 §5). A false positive is an agent spawned that was not needed:
  // a whole extra session at full price. A false negative is work done by one
  // agent that could have been split -- which is what would have happened
  // without the gate, so it costs the difference and not a session.
  return (c.fp * penalty + c.fn) / c.n;
}

function reportFit(byFraming: Map<string, Sample[]>): void {
  const placements: Placement[] = [
    { rule: "fixed", at: 0.5 },
    { rule: "midgap" },
    { rule: "youden" },
    { rule: "quantile", q: 0.9, margin: 0.01 },
    { rule: "auto" },
  ];
  console.log(`\n§3 the fit, per wording. \`held out\` is the only column that means anything\n`);
  for (const { name, note } of FRAMINGS) {
    const s = byFraming.get(name);
    if (!s) continue;
    console.log(`  ${name} -- ${note}`);
    console.log("    placement        cutoff   in-sample bal.   held-out bal.   held-out tp/fp/fn/tn   fold cutoffs");
    for (const placement of placements) {
      const fit = place(s, placement);
      const cv = crossValidate(s, placement, { folds: 5 });
      if (!fit.fittable && cv.cutoffs.length === 0) {
        console.log(`    ${pad(cv.placement, 16)} ${pad("-", 8)} ${fit.why}`);
        continue;
      }
      const h = cv.heldOut;
      console.log(
        `    ${pad(cv.placement, 16)} ${num(fit.at).padStart(6)}   ` +
          `${num(cv.inSample.balanced).padStart(14)}   ${num(h.balanced).padStart(13)}   ` +
          `${`${h.tp}/${h.fp}/${h.fn}/${h.tn}`.padStart(20)}   ` +
          `${cv.cutoffs.map((c) => c.toFixed(2)).join(" ")}`,
      );
    }
    console.log("");
  }
  console.log(
    "  `fold cutoffs` is how far the FIT itself moves when a fifth of the corpus is\n" +
      "  withheld. A rule whose cutoffs scatter has not found a boundary, it has found\n" +
      "  the scenarios it was shown (docs/25 §2).",
  );
}

function reportByClass(byFraming: Map<string, Sample[]>, rows: Row[]): void {
  // docs/31 §2b's table, recomputed at each wording's own fitted cutoff
  // instead of at a shared 0.5. If fitting per framing is worth anything,
  // this is where it shows: the strict/loose split should narrow.
  console.log(`\n§4 docs/31 §2b's classes, at 0.5 and at each wording's own fitted cutoff\n`);
  const classes = [
    { name: "traps", of: (id: string) => TRAP.get(id) === true },
    { name: "plainly multi", of: (id: string) => LABEL.get(id) === true && TRAP.get(id) !== true },
    { name: "plainly single", of: (id: string) => LABEL.get(id) === false && TRAP.get(id) !== true },
  ];
  console.log("  wording        cutoff   traps        plainly multi   plainly single   all");
  for (const { name, key } of FRAMINGS) {
    const s = byFraming.get(name);
    if (!s) continue;
    const fitted = place(s, { rule: "youden" });
    for (const [what, at] of [["0.5", 0.5] as const, ["fitted", fitted.at] as const]) {
      const cells = classes.map((c) => {
        const mine = rows.filter((r) => c.of(r.scenario));
        const right = mine.filter((r) => {
          const value = key === "staySingle" ? 1 - r[key] : r[key];
          return (value >= at) === (LABEL.get(r.scenario) ?? false);
        }).length;
        return `${right}/${mine.length}`;
      });
      const all = rows.filter((r) => {
        const value = key === "staySingle" ? 1 - r[key] : r[key];
        return (value >= at) === (LABEL.get(r.scenario) ?? false);
      }).length;
      console.log(
        `  ${pad(what === "0.5" ? name : "", 14)} ${num(at).padStart(6)}   ` +
          `${cells[0].padStart(5)}        ${cells[1].padStart(8)}        ${cells[2].padStart(8)}   ${all}/${rows.length}`,
      );
    }
  }
}

function reportLoss(byFraming: Map<string, Sample[]>): void {
  // docs/25 §5: when the cost of each error is known, minimise the loss and
  // the cutoff falls out -- the free parameter becomes "what is one
  // unnecessary agent worth", which an operator can actually answer.
  console.log(`\n§5 the cutoff as a function of what an unnecessary split costs\n`);
  console.log("  penalty   wording        cutoff   tp/fp/fn/tn    held-out loss   always-single   always-split");
  for (const penalty of [1, 3, 10, 30, 100]) {
    for (const { name } of FRAMINGS) {
      const s = byFraming.get(name);
      if (!s) continue;
      // Exhaustive over midpoints: the objective is piecewise constant, so
      // there is no gradient to follow (same reason as jev-core's fitLadder).
      const values = [...new Set(s.map((x) => x.value))].sort((a, b) => a - b);
      const candidates = [0, ...values.map((v, i) => (i === 0 ? v / 2 : (v + values[i - 1]) / 2)), 1.01];
      let best = { at: Number.NaN, cost: Number.POSITIVE_INFINITY };
      for (const at of candidates) {
        const cost = costOf(confusion(s, at), penalty);
        if (cost < best.cost) best = { at, cost };
      }
      // Held out with the same loss, so the number is not the fit's own score.
      const cv = crossValidate(s, { rule: "fixed", at: best.at }, { folds: 5 });
      const c = cv.heldOut;
      console.log(
        `  ${String(penalty).padStart(7)}   ${pad(name, 14)} ${num(best.at).padStart(6)}   ` +
          `${`${c.tp}/${c.fp}/${c.fn}/${c.tn}`.padStart(11)}   ` +
          `${num(costOf(cv.heldOut, penalty)).padStart(13)}   ` +
          `${num(costOf(confusion(s, 1.01), penalty)).padStart(13)}   ` +
          `${num(costOf(confusion(s, 0), penalty)).padStart(12)}` +
          (c.fp === 0 ? "   fp=0: the loss stops depending on the penalty here" : ""),
      );
    }
    console.log("");
  }
  console.log(
    "  `always-single` and `always-split` are the two no-judgment baselines. A fitted\n" +
      "  cutoff that beats neither is a gate not worth asking for (docs/07, docs/25 §5).",
  );
}

function reportMargin(byFraming: Map<string, Sample[]>): void {
  // The zero-false-positive cutoff is `max negative + margin`, which is
  // exactly the placement docs/22 §11.4 put in by hand and watched the next
  // corpus walk over. So before any of §5's numbers are believed, the margin
  // has to be measured against something -- and the repeats give the only
  // yardstick that is free: how far does the SAME scenario move when asked
  // again?
  console.log(`\n§6 is the zero-false-positive margin a margin?\n`);
  console.log("  wording        cutoff   highest 'single' answer   margin   draw sd   margin in draw sds");
  for (const { name } of FRAMINGS) {
    const s = byFraming.get(name);
    if (!s) continue;
    const sep = separation(s);
    const noise = drawNoise(s).sd;
    // The loss-minimising cutoff once the penalty is high enough to want zero
    // false positives: the first candidate above every negative.
    const values = [...new Set(s.map((x) => x.value))].sort((a, b) => a - b);
    const at = values.find((v) => v > sep.maxNeg) ?? Number.NaN;
    const margin = at - sep.maxNeg;
    console.log(
      `  ${pad(name, 14)} ${num(at).padStart(6)}   ${num(sep.maxNeg).padStart(23)}   ` +
        `${num(margin).padStart(6)}   ${num(noise).padStart(7)}   ${(margin / noise).toFixed(1).padStart(18)}`,
    );
  }
  console.log(
    "\n  >> These are NOT margins. A gap of under two draw deviations means the same\n" +
      "     scenario asked again lands on the other side of the cutoff a good part of\n" +
      "     the time -- so §5's zero-false-positive columns describe THIS record's\n" +
      "     draws and not a property of the gate. docs/22 §11.4 fitted exactly this\n" +
      "     placement by hand and the next corpus walked over it; here the next DRAW\n" +
      "     is enough.\n" +
      "     The usable cutoff is the one that throws the loudest negative away --\n" +
      "     §3's `q90+0.01` row -- which buys stability with a few false positives\n" +
      "     and has the stable fold cutoffs to show for it.",
  );
}

/**
 * The table that should decide the configuration.
 *
 * §5 minimised the loss freely and, above penalty 10, landed on the
 * zero-false-positive cutoff -- which §6 then showed is 0.8 draw deviations
 * above the loudest negative and therefore not a cutoff at all. So the loss
 * is recomputed here over only the placements whose FOLD CUTOFFS held still
 * in §3, which is the honest version of the same question.
 */
function reportConfig(byFraming: Map<string, Sample[]>): void {
  const stable: { label: string; placement: Placement }[] = [
    { label: "0.5 (shipped)", placement: { rule: "fixed", at: 0.5 } },
    { label: "q90+0.01", placement: { rule: "quantile", q: 0.9, margin: 0.01 } },
    { label: "auto+0.01", placement: { rule: "auto" } },
  ];
  console.log(`\n§7 held-out loss at the STABLE cutoffs only -- the configuration table\n`);
  for (const penalty of [1, 3, 10]) {
    console.log(`  an unnecessary split costs ${penalty}x a missed one`);
    console.log("    wording        placement       cutoff   tp/fp/fn/tn    held-out loss   vs always-single");
    let best = { what: "", loss: Number.POSITIVE_INFINITY };
    const lines: string[] = [];
    for (const { name } of FRAMINGS) {
      const s = byFraming.get(name);
      if (!s) continue;
      const nothing = costOf(confusion(s, 1.01), penalty);
      for (const { label, placement } of stable) {
        const cv = crossValidate(s, placement, { folds: 5 });
        const fit = place(s, placement);
        if (cv.heldOut.n === 0) continue;
        const loss = costOf(cv.heldOut, penalty);
        if (loss < best.loss) best = { what: `${name} @ ${num(fit.at)}`, loss };
        const c = cv.heldOut;
        lines.push(
          `    ${pad(name, 14)} ${pad(label, 15)} ${num(fit.at).padStart(6)}   ` +
            `${`${c.tp}/${c.fp}/${c.fn}/${c.tn}`.padStart(11)}   ${num(loss).padStart(13)}   ` +
            (loss < nothing ? `${num(nothing - loss)} better` : `${num(loss - nothing)} WORSE`),
        );
      }
    }
    for (const line of lines) console.log(line);
    console.log(`    -> ${best.what}, loss ${num(best.loss)}\n`);
  }
  console.log(
    "  `vs always-single` is the whole point: a gate that loses to doing nothing is\n" +
      "  not a gate worth a request (docs/07, docs/36 §5's held-out ladder).",
  );
}

function main(): void {
  if (!existsSync(RECORD)) {
    console.log("no records/orchestration.json; run `npx tsx src/run.ts --arm all --repeat 3`");
    return;
  }
  const all = JSON.parse(readFileSync(RECORD, "utf8")) as Row[];
  // The `all` arm is the one that carries both wordings in the same request.
  const rows = all.filter((r) => r.arm === "all" && Number.isFinite(r.decision));
  const scenarios = new Set(rows.map((r) => r.scenario));
  const repeats = new Set(rows.map((r) => r.repeat));
  console.log(
    `\n  ${rows.length} recorded judgments: ${scenarios.size} scenarios x ${repeats.size} repeats` +
      `  ·  ${[...LABEL.values()].filter(Boolean).length} multi / ${[...LABEL.values()].filter((v) => !v).length} single` +
      `, ${[...TRAP.values()].filter(Boolean).length} traps  ·  no requests made`,
  );

  const byFraming = new Map<string, Sample[]>();
  for (const { name, key } of FRAMINGS) byFraming.set(name, samplesFor(rows, key));

  reportRange(byFraming);
  reportAdvice(byFraming);
  reportFit(byFraming);
  reportByClass(byFraming, rows);
  reportLoss(byFraming);
  reportMargin(byFraming);
  reportConfig(byFraming);
  console.log("");
}

if (process.argv[1]?.endsWith("fit.ts")) main();
