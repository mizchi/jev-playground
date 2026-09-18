/**
 * The gate decides whether stage 2 runs at all, so a gate mistake is invisible
 * in the main results: the cases it stopped have no stage-2 answer to inspect.
 * This fills those in, then compares gate variants offline.
 *
 * The question it answers: the cookbook averages three noul questions, and on
 * this roster one of them separates covered from uncovered better than the
 * average does. Is the average actually earning its place?
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/gatecheck.ts
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Jev, choice, noul, type Question } from "../../shared/jev.js";
import type { SkillEntry } from "./roster.js";
import { EXCERPT_CHARS, FITS_THRESHOLD, SHORTLIST, type Trace } from "./suggest.js";

interface Row {
  request: string;
  expect: string | null;
  suggested?: string | null;
  suggestedTrace?: Trace;
  /** Filled in here: what stage 2 would have said, gate or no gate. */
  stage2?: { winner: string; bestFits: number } | null;
}

const CACHE = "out/gatecheck.json";

/** Stage 2 on its own, so gate-stopped cases can be scored too. */
async function stage2(
  jev: Jev,
  roster: SkillEntry[],
  request: string,
  names: string[],
): Promise<{ winner: string; bestFits: number }> {
  const byName = new Map(roster.map((s) => [s.name, s]));
  const criteria: Record<string, string> = {};
  const questions: Record<string, Question> = {};
  for (const name of names) {
    const s = byName.get(name);
    if (!s) continue;
    criteria[name] = `${s.description}\n\n${s.body.slice(0, EXCERPT_CHARS)}`;
    questions[`fits_${name}`] = {
      type: "noul",
      instructions: `Does ${name} do the specific thing the user's request asks for? It is described as: ${s.description}`,
    };
  }
  questions.skill = {
    type: "choice",
    instructions:
      "Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name.",
    criteria,
  };
  const res = await jev.ask({ request, recent_context: "" }, questions);
  const fits = names.map((n) => noul(res.answers[`fits_${n}`]));
  return { winner: choice(res.answers.skill).choice, bestFits: Math.max(...fits) };
}

/** Score a gate variant end to end, using the filled-in stage-2 answers. */
function scoreVariant(
  rows: Row[],
  label: string,
  passes: (t: Trace) => boolean,
): void {
  let wrong = 0;
  let covered = 0;
  let needless = 0;
  let uncovered = 0;
  for (const r of rows) {
    const t = r.suggestedTrace;
    if (!t) continue;
    let got: string | null = null;
    if (passes(t)) {
      const s2 = r.stage2;
      got = s2 && s2.bestFits >= FITS_THRESHOLD ? s2.winner : null;
    }
    if (r.expect === null) {
      uncovered += 1;
      if (got !== null) needless += 1;
    } else {
      covered += 1;
      if (got !== r.expect) wrong += 1;
    }
  }
  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "-");
  console.log(
    `  ${label.padEnd(42)} wrong ${pct(wrong, covered).padStart(6)} (${wrong}/${covered})` +
      `   needless ${pct(needless, uncovered).padStart(6)} (${needless}/${uncovered})`,
  );
}

async function main() {
  const roster = JSON.parse(readFileSync("out/roster.json", "utf8")) as SkillEntry[];
  const results = JSON.parse(readFileSync("out/results.json", "utf8")) as Row[];
  const prior = existsSync(CACHE)
    ? new Map((JSON.parse(readFileSync(CACHE, "utf8")) as Row[]).map((r) => [r.request, r]))
    : new Map<string, Row>();

  const rows: Row[] = results.map((r) => ({ ...r, stage2: prior.get(r.request)?.stage2 }));
  const need = rows.filter((r) => r.suggestedTrace && r.stage2 === undefined);
  console.log(`filling in stage 2 for ${need.length} cases that never reached it`);
  const jev = new Jev();
  for (const r of need) {
    const t = r.suggestedTrace!;
    // The shortlist is recorded only when stage 2 ran; otherwise rebuild it
    // from the ranking the gate-stopped call already produced.
    const names = t.shortlist.length > 0 ? t.shortlist : t.ranked.slice(0, SHORTLIST).map((x) => x.name);
    if (names.length === 0) {
      r.stage2 = null;
      continue;
    }
    try {
      r.stage2 = await stage2(jev, roster, r.request, names);
    } catch (err) {
      console.warn(`  failed: ${String(err).slice(0, 120)}`);
      r.stage2 = null;
    }
    writeFileSync(CACHE, JSON.stringify(rows, null, 2));
    process.stdout.write(".");
  }
  console.log("");
  console.log("");
  console.log("  gate variants, scored end to end on the same stage-2 answers:");
  console.log("");
  scoreVariant(rows, "cookbook: mean of three >= 0.30", (t) => t.gate.mean >= 0.3);
  scoreVariant(rows, "needs_procedure alone >= 0.30", (t) => t.gate.procedure >= 0.3);
  scoreVariant(rows, "acts_on_world alone >= 0.30", (t) => t.gate.acts >= 0.3);
  scoreVariant(rows, "no gate at all (fits check only)", () => true);
  scoreVariant(rows, "mean >= 0.15 (looser)", (t) => t.gate.mean >= 0.15);
  scoreVariant(rows, "procedure >= 0.30 OR acts >= 0.60", (t) => t.gate.procedure >= 0.3 || t.gate.acts >= 0.6);
  console.log("");
  console.log(`  cost: ${jev.calls} extra Jev requests, $${((jev.inputTokens / 1e6) * 0.042).toFixed(4)}`);
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
