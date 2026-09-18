#!/usr/bin/env -S npx tsx
/**
 * What hermes would decide for one turn, without a Pi session.
 *
 *   jev-hermes "the auth middleware rejects valid tokens after an hour"
 *   jev-hermes "..." --skills ~/.pi/skills      with a catalogue
 *   jev-hermes "..." --compare --repeat 3       the measurement below
 *   jev-hermes --budget                         what a day would cost
 *
 * `--compare` is the one that matters. `turn.ts` combines three components'
 * questions into one request on the strength of docs/29 §4 -- width is free --
 * and that report's fan-out was many questions of ONE kind over ONE state,
 * where this is three states unioned. So the claim is untested, and this is
 * the test: ask the same turn both ways, repeatedly, and print how far each
 * answer moved against the spread between repeats of the SAME way.
 *
 * The second number is what makes the first readable. An answer that moves
 * 0.2 between combined and separate means nothing if it also moves 0.2
 * between two combined draws -- that is the lesson docs/09 and docs/36 §5.2
 * both landed on, and the reason `--repeat` defaults to 3 rather than 1.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Jev } from "@jev-playground/jev-core";
import { decide as decideModel, judgmentOf as modelJudgment } from "jev-model-router";
import {
  DEFAULT_CONFIG as DEFAULT_SKILL_CONFIG,
  NONE,
  keepTop,
  keyFor as skillKey,
  prescore,
  selectFrom,
  split,
  type Pick,
  type Skill,
} from "jev-skill-router";
import { brief, decide as decidePlan, judgmentOf as planJudgment } from "jev-orchestrator";
import { Budget, USD_PER_MTOK } from "./budget.js";
import { HERMES_ROUTER } from "./tiers.js";
import { askCombined, askSeparately, keyGroups, payloadOf, type TurnConfig, type TurnInput } from "./turn.js";

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const opt = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
};

/** A catalogue from a skills directory, the same way jev-skill-router reads one. */
function catalogueFrom(dir: string): Skill[] {
  const out: Skill[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const path = resolve(dir, name, "SKILL.md");
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    const text = readFileSync(path, "utf8");
    const described = /^description:\s*(.+)$/m.exec(text);
    out.push({
      name,
      description: described?.[1]?.trim() ?? text.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.slice(0, 200) ?? "",
      path,
      invocable: true,
      route: "judge",
    });
  }
  return out;
}

function inputFor(request: string): { input: TurnInput; config: TurnConfig; shortlist: Skill[] } {
  const dir = opt("skills");
  const all = dir ? catalogueFrom(dir) : [];
  const grouped = split(all);
  const shortlist = keepTop(
    grouped.judge,
    prescore(grouped.judge, { request }, DEFAULT_SKILL_CONFIG.prefilter),
    DEFAULT_SKILL_CONFIG.shortlist,
  );
  return {
    input: { task: request, cwd: process.cwd(), shortlist },
    config: {
      router: HERMES_ROUTER,
      framing: (opt("framing", "cost") as "cost" | "plain"),
      orchestrate: !flag("no-orchestrate"),
    },
    shortlist,
  };
}

function report(request: string): void {
  const { input, config } = inputFor(request);
  const groups = keyGroups(input, config);
  const bytes = new TextEncoder().encode(payloadOf(input, config)).length;
  console.log(`\n  one combined request: ${Object.values(groups).flat().length} questions, ${bytes} bytes`);
  for (const [name, keys] of Object.entries(groups)) {
    if (keys.length > 0) console.log(`    ${name.padEnd(13)} ${keys.length}  ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", ..." : ""}`);
  }
}

async function once(request: string, separate: boolean): Promise<{
  tier: string;
  effort: string | null;
  skills: string[];
  shape: string;
  raw: Record<string, number>;
  tokens: number;
  requests: number;
  ms: number;
}> {
  const { input, config, shortlist } = inputFor(request);
  const answers = separate ? await askSeparately(input, config) : await askCombined(input, config);
  if (!answers.response) throw new Error(answers.error ?? "no response");
  const res = answers.response;
  const model = decideModel({
    config: config.router,
    judgment: modelJudgment(res, true),
    current: config.router.fallback,
  });
  const picks: Pick[] = shortlist.map((skill) => {
    const a = res.answers[skillKey(skill.name)];
    return {
      skill,
      level: a?.type === "score" ? a.score : Number.NaN,
      confidence: a?.type === "score" ? a.confidence : Number.NaN,
      why: "judged" as const,
    };
  });
  const noneApply = res.answers[NONE]?.type === "noul" ? res.answers[NONE].noul : Number.NaN;
  const skills = shortlist.length > 0 ? selectFrom(picks, noneApply, DEFAULT_SKILL_CONFIG).load.map((p) => p.skill.name) : [];
  const plan = config.orchestrate ? decidePlan(planJudgment(res)) : null;
  // Every numeric answer, so the comparison below is over the raw numbers and
  // not over the decisions -- a decision can agree while the number behind it
  // moved most of the way to a cutoff.
  const raw: Record<string, number> = {};
  for (const [key, a] of Object.entries(res.answers)) {
    if (a.type === "noul") raw[key] = a.noul;
    else if (a.type === "score") raw[key] = a.score;
    else raw[key] = a.confidence;
  }
  return {
    tier: model.label,
    effort: model.effort,
    skills,
    shape: plan ? `${plan.shape}${plan.split ? ` x${plan.workers}` : ""}` : "-",
    raw,
    tokens: res.usage.input_tokens,
    requests: answers.requests,
    ms: answers.ms,
  };
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

async function compare(request: string, repeats: number): Promise<void> {
  const combined = [];
  const separate = [];
  for (let i = 0; i < repeats; i += 1) {
    combined.push(await once(request, false));
    separate.push(await once(request, true));
  }
  console.log("\n  way        requests   input tokens   ms     tier    effort   shape          skills");
  for (const [name, runs] of [["combined", combined], ["separate", separate]] as const) {
    console.log(
      `  ${name.padEnd(10)} ${mean(runs.map((r) => r.requests)).toFixed(1).padStart(8)}   ` +
        `${mean(runs.map((r) => r.tokens)).toFixed(0).padStart(12)}   ${mean(runs.map((r) => r.ms)).toFixed(0).padStart(4)}   ` +
        `${runs[0].tier.padEnd(7)} ${(runs[0].effort ?? "-").padEnd(8)} ${runs[0].shape.padEnd(14)} ${runs[0].skills.join(", ") || "none"}`,
    );
  }

  // The two spreads. `within` is how much an answer moves between repeats of
  // the same way -- the draw noise. `between` is how much it moves when the
  // way changes. Only the ratio is readable.
  const keys = [...new Set([...combined.flatMap((r) => Object.keys(r.raw)), ...separate.flatMap((r) => Object.keys(r.raw))])];
  const rows: { key: string; within: number; between: number }[] = [];
  for (const key of keys) {
    const c = combined.map((r) => r.raw[key]).filter(Number.isFinite);
    const s = separate.map((r) => r.raw[key]).filter(Number.isFinite);
    if (c.length === 0 || s.length === 0) continue;
    const spread = (xs: number[]): number => (xs.length < 2 ? 0 : Math.max(...xs) - Math.min(...xs));
    rows.push({ key, within: Math.max(spread(c), spread(s)), between: Math.abs(mean(c) - mean(s)) });
  }
  rows.sort((a, b) => b.between - a.between);
  console.log("\n  answer                     |combined - separate|   draw spread within one way");
  for (const r of rows) {
    console.log(
      `  ${r.key.padEnd(26)} ${r.between.toFixed(3).padStart(21)}   ${r.within.toFixed(3).padStart(27)}` +
        (r.between > Math.max(r.within, 0.05) ? "   MOVED" : ""),
    );
  }
  const moved = rows.filter((r) => r.between > Math.max(r.within, 0.05));
  console.log(
    `\n  ${moved.length} of ${rows.length} answers moved further between the two ways than between repeats of one way.` +
      (moved.length === 0
        ? "\n  Combining is free on this turn, as docs/29 §4 predicts."
        : `\n  Combining is NOT free on this turn: ${moved.map((r) => r.key).join(", ")}.`),
  );
  const savedTokens = mean(separate.map((r) => r.tokens)) - mean(combined.map((r) => r.tokens));
  console.log(
    `  combining saves ${savedTokens.toFixed(0)} input tokens and ` +
      `${(mean(separate.map((r) => r.requests)) - mean(combined.map((r) => r.requests))).toFixed(1)} requests per turn ` +
      `($${((savedTokens / 1e6) * USD_PER_MTOK).toFixed(6)}).`,
  );
}

function budgetNote(): void {
  // What "cheap resident agent" actually costs, arithmetic rather than
  // measurement -- and labelled as such. The per-turn figure comes from a
  // real payload, the turns-per-day figure is the operator's guess.
  const { input, config } = inputFor("a representative request of about this length, naming a file and a symptom");
  const bytes = new TextEncoder().encode(payloadOf(input, config)).length;
  const perTurn = Math.ceil(bytes / 4);
  console.log(`\n  a combined turn request is ${bytes} bytes, so roughly ${perTurn} input tokens (4 bytes/token).`);
  console.log("  the token count is the server's to compute; this is an estimate, and the ledger reports the real one.\n");
  console.log("  turns/day   judgment $/day   $/month");
  for (const turns of [50, 200, 1_000, 5_000]) {
    const daily = ((perTurn * turns) / 1e6) * USD_PER_MTOK;
    console.log(`  ${String(turns).padStart(9)}   ${`$${daily.toFixed(4)}`.padStart(14)}   $${(daily * 30).toFixed(2)}`);
  }
  const b = new Budget();
  console.log(`\n  the default ceiling is ${b.allows().ok ? "not yet reached" : "reached"}; see budget.ts for what happens at it.`);
}

async function main(): Promise<void> {
  if (flag("budget")) {
    budgetNote();
    return;
  }
  const request = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")).join(" ");
  if (!request) {
    console.error('usage: jev-hermes "<request>" [--skills DIR] [--compare] [--repeat N] [--budget]');
    process.exit(2);
  }
  report(request);
  let key = true;
  try {
    new Jev();
  } catch {
    key = false;
  }
  if (!key) {
    console.log("\n  no TYPESAFE_API_KEY, so nothing was asked. The shape above needs no key.");
    return;
  }
  if (flag("compare")) {
    await compare(request, Number.parseInt(opt("repeat", "3") as string, 10));
    return;
  }
  const result = await once(request, false);
  console.log(
    `\n  tier ${result.tier}, effort ${result.effort ?? "-"}, shape ${result.shape}` +
      `\n  skills: ${result.skills.join(", ") || "none"}` +
      `\n  ${result.tokens} input tokens in ${result.requests} request, ${result.ms} ms, ` +
      `$${((result.tokens / 1e6) * USD_PER_MTOK).toFixed(6)}`,
  );
  const plan = decidePlan(null);
  void plan;
  void brief;
}

await main();
