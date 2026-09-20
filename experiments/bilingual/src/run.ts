/**
 * docs/28 -- do two documents in two languages say the same thing?
 *
 *   npx tsx src/run.ts --replay       # every table from the record, no API key
 *   npx tsx src/run.ts --repeat 3     # the labelled run
 *   npx tsx src/run.ts --arm withdoc --repeat 1
 *
 * The corpus is this repository's own parallel pair (`README.md` and
 * `README.ja.md` of eslint-plugin-jev, 1,244 lines), so the "equivalent" half
 * of the labels is real translation rather than something written for the
 * experiment -- and the six planted divergences are string edits, so their
 * label is by construction.
 *
 * Section 4 is the other half of the point: the same questions asked about
 * the pair as it actually is, where nothing is planted and a finding is a
 * finding.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Jev, choice, noul, score } from "../../shared/jev.js";
import { mean, sd } from "../../shared/thresholds.js";
import {
  ARMS,
  ARM_BLURB,
  CONTRADICTION,
  DIVERGENCE,
  JA_ADDS,
  JA_OMITS,
  KIND,
  NO_DIVERGENCE,
  NUMBERS_AGREE,
  SAME,
  questions,
  stateFor,
  type ArmName,
} from "./arms.js";
import { checkPair, loadCorpus, type Pair } from "./align.js";
import { MUTATIONS, buildSubjects, type Subject } from "./mutate.js";

const HERE = import.meta.dirname;
const RECORD = resolve(HERE, "../records/pairs.json");

const ARGS = process.argv.slice(2);
const flag = (n: string) => ARGS.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = ARGS.indexOf(`--${n}`);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d;
};

/** Level boundaries: 2 is "a detail differs or is missing". */
const REPORT_AT = Number(opt("at", "1.5"));

interface Row {
  id: string;
  arm: ArmName;
  repeat: number;
  mutation: string;
  verdict: "diverged" | "equivalent";
  divergence: number;
  divergenceConfidence: number;
  kind: string;
  kindConfidence: number;
  noDivergence: number;
  same: number;
  jaOmits: number;
  jaAdds: number;
  numbersAgree: number;
  contradiction: number;
  ms: number;
  inputTokens: number;
}

const pad = (s: string, n: number) => s.padEnd(n);

async function ask(jev: Jev, arm: ArmName, subject: Subject, whole: { en: string; ja: string }, repeat: number): Promise<Row> {
  const started = Date.now();
  const res = await jev.ask(stateFor(arm, subject, whole), questions());
  const d = score(res.answers[DIVERGENCE]);
  const k = choice(res.answers[KIND]);
  return {
    id: subject.id,
    arm,
    repeat,
    mutation: subject.mutation,
    verdict: subject.verdict,
    divergence: d.score,
    divergenceConfidence: d.confidence,
    kind: k.choice,
    kindConfidence: k.confidence,
    noDivergence: noul(res.answers[NO_DIVERGENCE]),
    same: noul(res.answers[SAME]),
    jaOmits: noul(res.answers[JA_OMITS]),
    jaAdds: noul(res.answers[JA_ADDS]),
    numbersAgree: noul(res.answers[NUMBERS_AGREE]),
    contradiction: noul(res.answers[CONTRADICTION]),
    ms: Date.now() - started,
    inputTokens: res.usage.input_tokens,
  };
}

function analyse(rows: Row[]): void {
  const corpus = loadCorpus();
  const { subjects, unplanted } = buildSubjects(corpus.pairs);
  const ratios = corpus.pairs.map((p) => p.ja.length / Math.max(1, p.en.length)).sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  const band = { lo: median * 0.8, hi: median * 1.25 };

  console.log("");
  console.log("=".repeat(104));
  console.log("  0. THE CORPUS -- this repository's own parallel README");
  console.log("");
  console.log(
    `  ${corpus.pairs.length} aligned sections, ` +
      `${corpus.enWhole.length} characters of English against ${corpus.jaWhole.length} of Japanese`,
  );
  console.log(
    `  length ratio ja/en: median ${median.toFixed(2)}, range ${ratios[0].toFixed(2)}..${ratios[ratios.length - 1].toFixed(2)}`,
  );
  console.log(
    `  labelled subjects: ${subjects.filter((s) => s.mutation === "original").length} untouched pairs + ` +
      `${subjects.filter((s) => s.mutation !== "original").length} planted edits` +
      (unplanted.length > 0 ? `  (no section matched: ${unplanted.join(", ")})` : ""),
  );
  console.log("");
  console.log(`  ${pad("mutation", 18)}${pad("label", 12)}${pad("where it landed", 34)}what it does`);
  for (const s of subjects.filter((x) => x.mutation !== "original")) {
    const m = MUTATIONS.find((x) => x.id === s.mutation)!;
    console.log(`  ${pad(s.mutation, 18)}${pad(s.verdict, 12)}${pad(`§${s.pairIndex} ${s.enTitle}`.slice(0, 32), 34)}${m.blurb}`);
  }
  console.log("");
  console.log("  The last two are what a translator is ALLOWED to do, and they carry the `equivalent`");
  console.log("  label: docs/26 measured what a corpus without the deliberate version of a shape does.");

  // ---------------------------------------------------------------- the rules
  console.log("");
  console.log("-".repeat(104));
  console.log("  1. THE DETERMINISTIC CHECK (numbers, identifiers, length ratio -- free)");
  console.log("");
  let rulesRight = 0;
  let rulesFalse = 0;
  let rulesMissed = 0;
  const perMutation = new Map<string, { flagged: number; of: number }>();
  for (const s of subjects) {
    const v = checkPair({ ...(corpus.pairs[s.pairIndex] as Pair), ja: s.ja }, band);
    const flagged = v.diverged;
    const shouldFlag = s.verdict === "diverged";
    if (flagged === shouldFlag) rulesRight += 1;
    if (flagged && !shouldFlag) rulesFalse += 1;
    if (!flagged && shouldFlag) rulesMissed += 1;
    const at = perMutation.get(s.mutation) ?? { flagged: 0, of: 0 };
    at.of += 1;
    if (flagged) at.flagged += 1;
    perMutation.set(s.mutation, at);
  }
  console.log(
    `  ${rulesRight}/${subjects.length} right, ${rulesFalse} false flags, ${rulesMissed} missed divergences`,
  );
  console.log("");
  console.log(`  ${pad("mutation", 18)}${"flagged".padStart(9)}   which check caught it`);
  for (const [mutation, v] of perMutation) {
    const s = subjects.find((x) => x.mutation === mutation)!;
    const check = checkPair({ ...(corpus.pairs[s.pairIndex] as Pair), ja: s.ja }, band);
    const why = [
      check.numbersMissing.length > 0 ? `numbers missing ${check.numbersMissing.join(",")}` : "",
      check.numbersExtra.length > 0 ? `numbers extra ${check.numbersExtra.join(",")}` : "",
      check.identifiersMissing.length > 0 ? `ids missing ${check.identifiersMissing.slice(0, 2).join(",")}` : "",
      check.identifiersExtra.length > 0 ? `ids extra ${check.identifiersExtra.slice(0, 2).join(",")}` : "",
      check.lengthRatio < band.lo || check.lengthRatio > band.hi ? `ratio ${check.lengthRatio.toFixed(2)}` : "",
    ]
      .filter((x) => x !== "")
      .join("; ");
    console.log(`  ${pad(mutation, 18)}${`${v.flagged}/${v.of}`.padStart(9)}   ${why || "nothing fired"}`);
  }
  console.log("");
  console.log("  The number check is defeated by orthography: English writes \"one request\" and Japanese");
  console.log("  writes \"1 リクエスト\", so a raw digit diff reports a difference on almost every section.");
  console.log("  `numbersIn` normalises spelled-out English numbers for exactly this reason.");

  if (rows.length === 0) return;

  // ------------------------------------------------------------------- jev
  console.log("");
  console.log("-".repeat(104));
  console.log(`  2. THE JUDGMENT (divergence >= ${REPORT_AT} reports)`);
  console.log("");
  const perArm = new Map<ArmName, Row[]>();
  for (const r of rows) {
    const at = perArm.get(r.arm);
    if (at) at.push(r);
    else perArm.set(r.arm, [r]);
  }
  console.log(
    `  ${pad("arm", 10)}${"right".padStart(9)}${"false flags".padStart(13)}${"missed".padStart(8)}` +
      `${"kind".padStart(7)}${"tokens".padStart(8)}${"ms".padStart(6)}`,
  );
  for (const arm of ARMS) {
    const mine = perArm.get(arm);
    if (!mine || mine.length === 0) continue;
    let right = 0;
    let falseFlag = 0;
    let missed = 0;
    let kind = 0;
    let kindOf = 0;
    for (const r of mine) {
      const flagged = r.divergence >= REPORT_AT;
      const should = r.verdict === "diverged";
      if (flagged === should) right += 1;
      if (flagged && !should) falseFlag += 1;
      if (!flagged && should) missed += 1;
      if (should) {
        kindOf += 1;
        if (r.kind === r.mutation) kind += 1;
      }
    }
    console.log(
      `  ${pad(arm, 10)}${`${right}/${mine.length}`.padStart(9)}${String(falseFlag).padStart(13)}` +
        `${String(missed).padStart(8)}${`${kind}/${kindOf}`.padStart(7)}` +
        `${Math.round(mean(mine.map((r) => r.inputTokens))).toString().padStart(8)}` +
        `${Math.round(mean(mine.map((r) => r.ms))).toString().padStart(6)}`,
    );
  }
  console.log("");
  console.log(`  ${ARMS.map((a) => `${a}: ${ARM_BLURB[a]}`).join("\n  ")}`);

  // --------------------------------------------------------- per mutation
  console.log("");
  console.log("-".repeat(104));
  console.log("  3. PER DIVERGENCE CLASS (mean score, and what the kind question said)");
  console.log("");
  const classes = ["original", ...MUTATIONS.map((m) => m.id)];
  for (const arm of ARMS) {
    const mine = perArm.get(arm);
    if (!mine || mine.length === 0) continue;
    console.log(`  ${arm}`);
    console.log(
      `    ${pad("class", 18)}${pad("label", 12)}${"score".padStart(7)}${"conf".padStart(7)}${"flagged".padStart(9)}` +
        `${"omits".padStart(7)}${"adds".padStart(7)}${"numbers".padStart(9)}   kind chosen`,
    );
    for (const cls of classes) {
      const mineCls = mine.filter((r) => r.mutation === cls);
      if (mineCls.length === 0) continue;
      const flagged = mineCls.filter((r) => r.divergence >= REPORT_AT).length;
      const kinds = [...new Set(mineCls.map((r) => r.kind))].join("|");
      console.log(
        `    ${pad(cls, 18)}${pad(mineCls[0].verdict, 12)}${mean(mineCls.map((r) => r.divergence)).toFixed(2).padStart(7)}` +
          `${mean(mineCls.map((r) => r.divergenceConfidence)).toFixed(2).padStart(7)}` +
          `${`${flagged}/${mineCls.length}`.padStart(9)}` +
          `${mean(mineCls.map((r) => r.jaOmits)).toFixed(2).padStart(7)}` +
          `${mean(mineCls.map((r) => r.jaAdds)).toFixed(2).padStart(7)}` +
          `${mean(mineCls.map((r) => r.numbersAgree)).toFixed(2).padStart(9)}   ${kinds.slice(0, 28)}`,
      );
    }
    console.log("");
  }

  // ------------------------------------------------------------- the real pair
  console.log("-".repeat(104));
  console.log("  4. THE PAIR AS IT ACTUALLY IS (nothing planted: the untouched sections, ranked)");
  console.log("");
  const originals = rows.filter((r) => r.mutation === "original" && r.arm === "section");
  const byId = new Map<string, Row[]>();
  for (const r of originals) {
    const at = byId.get(r.id);
    if (at) at.push(r);
    else byId.set(r.id, [r]);
  }
  const ranked = [...byId.entries()]
    .map(([id, rs]) => ({
      id,
      pairIndex: Number(id.split(":")[1]),
      score: mean(rs.map((r) => r.divergence)),
      omits: mean(rs.map((r) => r.jaOmits)),
      adds: mean(rs.map((r) => r.jaAdds)),
      numbers: mean(rs.map((r) => r.numbersAgree)),
      draws: rs.length,
    }))
    .sort((a, b) => b.score - a.score);
  console.log(
    `  ${pad("section", 34)}${"score".padStart(7)}${"omits".padStart(7)}${"adds".padStart(7)}${"numbers".padStart(9)}${"ratio".padStart(7)}`,
  );
  for (const r of ranked) {
    const p = corpus.pairs[r.pairIndex];
    console.log(
      `  ${pad(`§${r.pairIndex} ${p.enTitle}`.slice(0, 32), 34)}${r.score.toFixed(2).padStart(7)}` +
        `${r.omits.toFixed(2).padStart(7)}${r.adds.toFixed(2).padStart(7)}${r.numbers.toFixed(2).padStart(9)}` +
        `${(p.ja.length / Math.max(1, p.en.length)).toFixed(2).padStart(7)}`,
    );
  }
  console.log("");
  console.log("  These sections have the `equivalent` label by ASSUMPTION -- they are the real translation.");
  console.log("  A high row here is either a false positive or real drift, and the only way to tell is to");
  console.log("  read it. docs/28 §4 does that for the top of this list.");

  const totalTokens = rows.reduce((a, r) => a + r.inputTokens, 0);
  console.log("");
  console.log("-".repeat(104));
  console.log(
    `  ${rows.length} judgments: ${totalTokens} input tokens, $${((totalTokens / 1e6) * 0.042).toFixed(4)}, ` +
      `mean ${Math.round(mean(rows.map((r) => r.ms)))} ms (sd ${Math.round(sd(rows.map((r) => r.ms)))})`,
  );
  console.log("");
}

async function main(): Promise<void> {
  if (flag("replay")) {
    if (!existsSync(RECORD)) throw new Error(`no ${RECORD}; run without --replay first`);
    analyse(JSON.parse(readFileSync(RECORD, "utf8")) as Row[]);
    return;
  }
  const corpus = loadCorpus();
  const { subjects } = buildSubjects(corpus.pairs);
  const whole = { en: corpus.enWhole, ja: corpus.jaWhole };
  const repeats = Number(opt("repeat", "3"));
  const only = opt("arm", "");
  const arms = only ? [only as ArmName] : [...ARMS];
  const jev = new Jev();
  const rows: Row[] = [];
  console.log(`  ${subjects.length} subjects x ${arms.length} arm(s) x ${repeats} repeat(s)`);
  for (const arm of arms) {
    for (let r = 0; r < repeats; r += 1) {
      for (const s of subjects) rows.push(await ask(jev, arm, s, whole, r));
      console.log(`    ${arm} run ${r + 1}: ${subjects.length} subjects`);
    }
  }
  const previous = existsSync(RECORD) && !flag("fresh") ? (JSON.parse(readFileSync(RECORD, "utf8")) as Row[]) : [];
  const kept = previous.filter((p) => !arms.includes(p.arm));
  writeFileSync(RECORD, JSON.stringify([...kept, ...rows], null, 2) + "\n");
  analyse([...kept, ...rows]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
