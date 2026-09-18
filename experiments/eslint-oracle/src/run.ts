/**
 * Can Jev predict ESLint's verdict when it is given the code and the rule's
 * stated criteria, but never the rule's implementation?
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/run.ts [--arms desc,name,both] [--threshold 0.5]
 *
 * One request per (snippet, arm): the code goes in as state once, and all
 * twelve rules ride along as twelve noul questions (the fan-out pattern from
 * docs/00 -- extra questions cost their own wording and nothing else).
 *
 * Ground truth is the real linter, so nothing here depends on our opinion of
 * what the rules mean. What we control is how much of the rule Jev sees, and
 * `assertNoImplementationLeak` enforces the interesting half of that: not one
 * 48-character window of any `create()` body, and none of our own annotations
 * about the tricks, may appear in an outgoing request.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { ESLint } from "eslint";
import { Jev, noul } from "../../shared/jev.js";
import { CORPUS, type Snippet } from "./corpus.js";
import { groundTruth, assertDiscriminable, type Verdict } from "./lint.js";
import { RULE_IDS, RULE_GROUPS, RULE_SPECS, assertNoImplementationLeak } from "./rules.js";
import { ARMS, ARM_BLURB, keyFor, questionsFor, stateFor, type ArmName } from "./arms.js";
import { auc, confuse, mapLimit, mean, pct, sweep, type Pair } from "./metrics.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const THRESHOLD = Number.parseFloat(arg("threshold", "0.5"));
const CONCURRENCY = Number.parseInt(arg("concurrency", "4"), 10);
const SELECTED = arg("arms", ARMS.join(",")).split(",") as ArmName[];
/**
 * Each arm is asked this many times. Not decoration: several of the verdicts
 * below land between 0.51 and 0.59, and docs/09 already burned us on reading
 * threshold-boundary decisions as if they were stable. Repeats tell a real
 * disagreement from a coin flip, and the whole sweep costs about two cents.
 */
const REPEATS = Number.parseInt(arg("repeat", "3"), 10);

/** Everything we know about one (snippet, rule) judgement. */
interface Row {
  arm: ArmName;
  repeat: number;
  snippet: string;
  kind: Snippet["kind"];
  targeted: boolean;
  rule: string;
  group: string;
  p: number;
  truth: boolean;
  correct: boolean;
}

/** The annotations that must never reach the wire. */
const SECRETS = CORPUS.flatMap((s) => [s.note, s.id, s.kind]);

async function askAll(
  jev: Jev,
  arm: ArmName,
  truth: Map<string, Verdict>,
  repeat: number,
): Promise<Row[]> {
  const questions = questionsFor(arm);
  // One leak check per arm covers every request: only the state varies, and
  // the state is the snippet's own code, which is what we mean to send.
  assertNoImplementationLeak(JSON.stringify(questions), SECRETS);

  const perSnippet = await mapLimit(CORPUS, CONCURRENCY, async (snippet) => {
    const state = stateFor(snippet);
    assertNoImplementationLeak(JSON.stringify(state), [snippet.note, snippet.id]);
    const res = await jev.ask(state, questions);
    const verdict = truth.get(snippet.id)!;
    return RULE_IDS.map((rule, i): Row => {
      const p = noul(res.answers[keyFor(i)]);
      const t = verdict.fails[rule];
      return {
        arm,
        repeat,
        snippet: snippet.id,
        kind: snippet.kind,
        targeted: rule === snippet.target,
        rule,
        group: RULE_GROUPS[rule],
        p,
        truth: t,
        correct: p >= THRESHOLD === t,
      };
    });
  });
  return perSnippet.flat();
}

function table(label: string, pairs: Pair[]): string {
  const c = confuse(pairs, THRESHOLD);
  const s = sweep(pairs);
  const head =
    `  ${label.padEnd(30)} ${String(c.tp + c.tn).padStart(3)}/${String(c.n).padEnd(3)} ` +
    `${pct(c.accuracy).padStart(6)}`;
  // On a single-class subset (all violations, or all clean) balanced accuracy
  // and AUC are undefined, and printing 50.0% / NaN there invites misreading.
  const oneClass = c.tp + c.fn === 0 || c.fp + c.tn === 0;
  if (oneClass) return `${head}  ${c.tp + c.fn === 0 ? "(all clean)" : "(all violations)"}`;
  return (
    `${head}  bal ${pct(c.balanced).padStart(6)}  auc ${auc(pairs).toFixed(2)}  ` +
    `(majority ${pct(c.majority)}, best ${pct(s.accuracy)} @ ${s.threshold.toFixed(2)})`
  );
}

async function main() {
  const truth = await groundTruth();
  assertDiscriminable(truth);

  const positives = CORPUS.filter((s) => truth.get(s.id)!.fails[s.target]).length;
  console.log("=".repeat(100));
  console.log("  ESLINT ORACLE — code + rule criteria in, pass/fail out, implementation hidden");
  console.log(
    `  ESLint ${ESLint.version} · ${RULE_IDS.length} rules · ${CORPUS.length} snippets · ` +
      `${positives}/${CORPUS.length} targeted pairs are violations · ${REPEATS} runs per arm`,
  );
  console.log("=".repeat(100));

  const jev = new Jev();
  const rows: Row[] = [];
  for (const arm of SELECTED) {
    if (!ARMS.includes(arm)) throw new Error(`unknown arm '${arm}'`);
    process.stdout.write(`\n  ${arm}: ${ARM_BLURB[arm]}\n`);
    const started = Date.now();
    for (let r = 0; r < REPEATS; r += 1) {
      const armRows = await askAll(jev, arm, truth, r);
      rows.push(...armRows);
      const targeted = armRows.filter((x) => x.targeted);
      process.stdout.write(
        `    run ${r + 1}: ${targeted.filter((x) => x.correct).length}/${targeted.length} targeted\n`,
      );
    }
    console.log(
      `  ${CORPUS.length * REPEATS} requests in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
  }

  mkdirSync("out", { recursive: true });
  writeFileSync("out/raw.jsonl", rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const pairsOf = (rs: Row[]): Pair[] => rs.map((r) => ({ p: r.p, truth: r.truth }));
  const byArm = (arm: ArmName) => rows.filter((r) => r.arm === arm);

  // ---- 1. the headline: the balanced, targeted subset -------------------
  console.log("");
  console.log("-".repeat(100));
  console.log(
    `  1. TARGETED PAIRS — each snippet judged against its own rule ` +
      `(threshold ${THRESHOLD}, ${REPEATS} runs pooled)`,
  );
  console.log("");
  for (const arm of SELECTED) {
    console.log(table(arm, pairsOf(byArm(arm).filter((r) => r.targeted))));
  }

  // ---- 2. the same pairs split by what the description can carry --------
  console.log("");
  console.log("  2. BY RULE GROUP — how much of the verdict the description could carry");
  console.log("");
  for (const group of ["lexical", "analysis", "defaulted"] as const) {
    console.log(`  ${group}:`);
    for (const arm of SELECTED) {
      const rs = byArm(arm).filter((r) => r.targeted && r.group === group);
      console.log(table(`  ${arm}`, pairsOf(rs)));
    }
  }

  // ---- 3. the near-misses: where the default option decides ------------
  console.log("");
  console.log("  3. BY CASE KIND — nearmiss = a default option or carve-out decides the verdict");
  console.log("");
  for (const kind of ["violation", "clean", "nearmiss"] as const) {
    console.log(`  ${kind}:`);
    for (const arm of SELECTED) {
      const rs = byArm(arm).filter((r) => r.targeted && r.kind === kind);
      console.log(table(`  ${arm}`, pairsOf(rs)));
    }
  }

  // ---- 4. the full matrix: the realistic gate --------------------------
  console.log("");
  console.log(`  4. FULL MATRIX — all ${CORPUS.length} snippets x ${RULE_IDS.length} rules ` +
    `(3.7% violations, so read the false positives, not the accuracy)`);
  console.log("");
  for (const arm of SELECTED) {
    const rs = byArm(arm);
    const c = confuse(pairsOf(rs), THRESHOLD);
    console.log(
      `  ${arm.padEnd(30)} ${pct(c.accuracy).padStart(6)}  ` +
        `tp ${c.tp} fp ${c.fp} fn ${c.fn} tn ${c.tn}  ` +
        `precision ${pct(c.precision)}  recall ${pct(c.recall)}  ` +
        `(always-pass scores ${pct(c.majority)})`,
    );
  }

  // ---- 5. file level: does this file pass lint at all? -----------------
  console.log("");
  console.log("  5. FILE LEVEL — predicted fail if ANY rule crosses the threshold");
  console.log("");
  for (const arm of SELECTED) {
    const rs = byArm(arm);
    // Per repeat, or the max would be taken across runs and flatter the arm.
    const filePairs: Pair[] = [];
    for (let r = 0; r < REPEATS; r += 1) {
      for (const s of CORPUS) {
        const mine = rs.filter((x) => x.repeat === r && x.snippet === s.id);
        filePairs.push({
          p: Math.max(...mine.map((x) => x.p)),
          truth: !truth.get(s.id)!.passes,
        });
      }
    }
    console.log(table(arm, filePairs));
  }

  // ---- 6. per rule, per arm -------------------------------------------
  console.log("");
  console.log("  6. PER RULE — targeted pairs only");
  console.log("");
  console.log(`  ${"rule".padEnd(24)}${SELECTED.map((a) => a.padStart(9)).join("")}   group`);
  for (const spec of RULE_SPECS) {
    const cells = SELECTED.map((arm) => {
      const rs = byArm(arm).filter((r) => r.targeted && r.rule === spec.id);
      return `${rs.filter((r) => r.correct).length}/${rs.length}`.padStart(9);
    });
    console.log(`  ${spec.id.padEnd(24)}${cells.join("")}   ${RULE_GROUPS[spec.id]}`);
  }

  // ---- 7. every miss, named, with how often it repeated ----------------
  console.log("");
  console.log(`  7. MISSES — targeted pairs Jev got wrong, over ${REPEATS} runs`);
  console.log("     n/N = wrong in n of N runs. n=N is a real disagreement with the linter;");
  console.log("     anything less is a decision sitting on the threshold.");
  for (const arm of SELECTED) {
    const targeted = byArm(arm).filter((r) => r.targeted);
    const keys = [...new Set(targeted.map((r) => `${r.snippet}|${r.rule}`))];
    const misses = keys
      .map((key) => {
        const group = targeted.filter((r) => `${r.snippet}|${r.rule}` === key);
        const wrong = group.filter((r) => !r.correct).length;
        return { group, wrong, ps: group.map((r) => r.p) };
      })
      .filter((m) => m.wrong > 0)
      .sort((a, b) => b.wrong - a.wrong);
    const always = misses.filter((m) => m.wrong === REPEATS).length;
    console.log("");
    console.log(
      `  ${arm} — ${misses.length} pair(s) missed at least once, ${always} missed every run`,
    );
    for (const m of misses) {
      const first = m.group[0];
      const snippet = CORPUS.find((s) => s.id === first.snippet)!;
      console.log(
        `    ${first.snippet.padEnd(30)} ${first.rule.padEnd(22)} ${m.wrong}/${REPEATS}  ` +
          `p ${m.ps.map((p) => p.toFixed(2)).join(" ")}  ` +
          `ESLint says ${first.truth ? "FAIL" : "pass"}  [${first.kind}]`,
      );
      if (snippet.kind === "nearmiss") console.log(`      ${snippet.note}`);
    }
  }

  // ---- 7b. how stable is any of this? ---------------------------------
  console.log("");
  console.log(`  7b. STABILITY — targeted pairs whose verdict is unanimous across ${REPEATS} runs`);
  console.log("");
  for (const arm of SELECTED) {
    const targeted = byArm(arm).filter((r) => r.targeted);
    const keys = [...new Set(targeted.map((r) => `${r.snippet}|${r.rule}`))];
    let flipped = 0;
    let spread = 0;
    for (const key of keys) {
      const group = targeted.filter((r) => `${r.snippet}|${r.rule}` === key);
      const verdicts = new Set(group.map((r) => r.p >= THRESHOLD));
      if (verdicts.size > 1) flipped += 1;
      const ps = group.map((r) => r.p);
      spread += Math.max(...ps) - Math.min(...ps);
    }
    console.log(
      `  ${arm.padEnd(10)} ${keys.length - flipped}/${keys.length} unanimous, ` +
        `${flipped} flipped  ·  mean p spread ${(spread / keys.length).toFixed(3)}`,
    );
  }

  // ---- 8. separation and cost ----------------------------------------
  console.log("");
  console.log("  8. SEPARATION — mean p(violation) on targeted pairs");
  console.log("");
  for (const arm of SELECTED) {
    const rs = byArm(arm).filter((r) => r.targeted);
    const p1 = mean(rs.filter((r) => r.truth).map((r) => r.p));
    const p0 = mean(rs.filter((r) => !r.truth).map((r) => r.p));
    const nm = rs.filter((r) => r.kind === "nearmiss");
    console.log(
      `  ${arm.padEnd(10)} violations ${p1.toFixed(3)}   clean ${p0.toFixed(3)}   ` +
        `gap ${(p1 - p0).toFixed(3)}   nearmiss mean ${mean(nm.map((r) => r.p)).toFixed(3)}`,
    );
  }

  console.log("");
  console.log(
    `  ${jev.calls} requests · ${jev.inputTokens} input tokens · ` +
      `$${((jev.inputTokens / 1e6) * 0.042).toFixed(4)} · ` +
      `${(jev.totalMs / jev.calls / 1000).toFixed(2)}s per request` +
      (jev.retriedCalls > 0 ? ` · ${jev.retriedCalls} retried` : ""),
  );
  console.log("  raw rows: out/raw.jsonl");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
