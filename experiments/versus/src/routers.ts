/**
 * The two routers, against real models. Homework n's remaining half.
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/routers.ts --arm model
 *   TYPESAFEAI_API_KEY=... npx tsx src/routers.ts --arm skill
 *   npx tsx src/routers.ts --report                  # from the record
 *
 * docs/41 compared two of the five components and said why the other three
 * were missing: the model router's labels are exit codes, the skill router's
 * corpus is 1,036 pairs, and the compactor had no generating model. This file
 * closes the first two. `compaction.ts` closed the third.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL ROUTER'S LABEL IS NEAR-CONSTANT, AND THAT IS THE FINDING.
 *
 * `experiments/router/records/labels.json` is 54 real `claude -p` attempts
 * graded by exit code. Of the 53 tasks, 53 have a passing tier and the
 * CHEAPEST SUFFICIENT TIER IS `haiku` FOR 52 OF THEM. One task (`equals-k3`,
 * hard corpus) needed sonnet.
 *
 * So "accuracy" against that label measures almost nothing: an arm that
 * answers `haiku` unconditionally scores 52/53 = 98% and is not a router.
 * This is docs/36 §5's own warning -- "the corpus was the result" -- arriving
 * as a measurement problem. The axis that IS measurable is therefore:
 *
 *   OVER-ESCALATION. How often does the arm route above the cheapest tier
 *   that was measured to work, and what does that cost at the tiers' own
 *   price ratios (1 / 3 / 15)?
 *
 * And its counterpart, which is not symmetric in value -- docs/36 §2.3 priced
 * the two errors and they are not equal (an under-route loses the turn AND
 * the money; an over-route loses only the difference):
 *
 *   UNDER-ROUTE. Routed below a tier that was measured to fail. One task can
 *   show this at all, so it is reported by name and not as a rate.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS FAIRER HERE THAN IN docs/41, AND WHAT IS STILL NOT.
 *
 * docs/41 §1.1 had to record an asymmetry that favoured jev: `jev-guard` runs
 * a nine-question battery and the model was asked once, because you cannot
 * hand a model nine `noul` probabilities. Both router arms avoid that:
 *
 *   - The model is asked THE SAME QUESTIONS. `questionsFor(DEFAULT_CONFIG)`
 *     is three questions (tier, underspecified, oversized); the model answers
 *     all three, in the shipped `instructions` and `criteria` strings.
 *   - The answers go through THE SAME POLICY CODE. `decide()` for the model
 *     router, `selectFrom()` for the skill router -- the shipped functions,
 *     not a reimplementation here. Only the judgment source differs.
 *
 * Two asymmetries remain and both are recorded rather than argued away:
 *
 *   - A `score` answer is CONTINUOUS (docs/36 §2.2 measured 1.99 from a
 *     three-level rubric). A model asked for one of three labels returns an
 *     integer. So the model cannot land between rungs, which is most of what
 *     `cuts` is for -- and the shipped default is `cuts: null` anyway, i.e.
 *     rounding, so this run compares the two on the same rounding path.
 *   - jev's rows are REPLAYED from `experiments/router/records/asks.json` and
 *     `experiments/skill-select/records/select.json`, recorded earlier. The
 *     model's rows are made now. Nothing about either corpus changed in
 *     between, but the draws are not from the same minute.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_CONFIG,
  decide,
  questionsFor,
  stateFor,
  type Judgment,
} from "../../../packages/jev-model-router/src/route.js";
import { costOf, fitLadder, rungFor, type LadderSample } from "../../../packages/jev-core/src/ladder.js";
import { DEFAULT_SKILL_CONFIG, selectFrom, type Pick } from "../../../packages/jev-skill-router/src/route.js";
import { ARMS as ROUTER_ARMS, inputFor, taskInputs, type AskRow, type TaskInput } from "../../router/src/ask.js";
import { LEVELS, NEEDED, scoreQuestion } from "../../skill-select/src/arms.js";
import { candidates, projectText, PROJECTS } from "../../skill-select/src/projects.js";
import { loadSnapshot } from "../../skill-select/src/catalog.js";

const RECORDS = resolve(import.meta.dirname, "../records");
const PATH = resolve(RECORDS, "routers.json");
const INPUTS = resolve(RECORDS, "router-inputs.json");

export const MODELS = { haiku: "claude-haiku-4-5-20251001", sonnet: "claude-sonnet-5" } as const;
export type ModelName = keyof typeof MODELS;

export interface RouterRow {
  which: "model" | "skill";
  arm: "jev" | ModelName;
  /** A task name, or a project id. */
  item: string;
  /** The rung label the arm routed to, or the loaded skills, joined. */
  answer: string;
  /** The cheapest tier measured to work, or the project's `want` labels. */
  want: string;
  ms: number;
  /** Model-router rows: the rung index, so cost can be summed. */
  rung?: number;
  wantRung?: number;
  /** Skill-router rows: the confusion against the project's own labels. */
  hit?: number;
  miss?: number;
  extra?: number;
  loaded?: number;
  /** jev only. The CLI does not report tokens. */
  inputTokens?: number;
  /** How the shipped policy explained itself. */
  reason?: string;
  error?: string;
}

interface Record_ {
  rows: RouterRow[];
  note: string;
}

const load = (): Record_ =>
  existsSync(PATH)
    ? (JSON.parse(readFileSync(PATH, "utf8")) as Record_)
    : {
        rows: [],
        note:
          "The model router and the skill router, asked of jev and of `claude -p`. " +
          "Same questions, same policy code, labels from docs/36 and docs/29.",
      };

const save = (r: Record_): void => {
  mkdirSync(RECORDS, { recursive: true });
  writeFileSync(PATH, `${JSON.stringify(r, null, 2)}\n`);
};

/**
 * Ask a model, with the prompt on stdin.
 *
 * `execFile`'s `input` option is SILENTLY IGNORED -- it belongs to
 * `execFileSync` -- and the child sat there until it printed "no stdin data
 * received in 3s" and exited 1. `compaction.ts` hit the same thing. stdin
 * rather than argv because the skill-router prompt is ~20,000 tokens and an
 * argv that size is a different failure on a different day.
 */
function askModel(model: ModelName, prompt: string): Promise<{ out: string; ms: number; error?: string }> {
  const t0 = Date.now();
  return new Promise((done) => {
    const child = spawn("claude", ["-p", "--model", MODELS[model]], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.stderr.on("data", (d) => {
      err += String(d);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({
        out,
        ms: Date.now() - t0,
        ...(code === 0 ? {} : { error: `exit ${code}: ${err.slice(0, 200)}` }),
      });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ out: "", ms: Date.now() - t0, error: String(e).slice(0, 200) });
    });
    child.stdin.end(prompt);
  });
}

// ------------------------------------------------------------- the model router

/**
 * The cheapest tier measured to work, per task, from the real attempts.
 *
 * `null` for a task where no attempted tier passed. There are none, and the
 * code says so rather than assuming it: a task with no passing tier has no
 * cheapest-sufficient label, and silently treating it as "the top rung" would
 * invent a label out of a failure to measure one.
 */
export function cheapestSufficient(): Map<string, { tier: string; rung: number; corpus: string }> {
  const labels = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../router/records/labels.json"), "utf8")) as {
    tiers: { label: string }[];
    attempts: { task: string; tier: string; passed: boolean; corpus: string }[];
  };
  const order = DEFAULT_CONFIG.tiers.map((t) => t.label);
  const out = new Map<string, { tier: string; rung: number; corpus: string }>();
  for (const a of labels.attempts) {
    if (!a.passed) continue;
    const rung = order.indexOf(a.tier);
    if (rung < 0) continue;
    const had = out.get(a.task);
    if (!had || rung < had.rung) out.set(a.task, { tier: a.tier, rung, corpus: a.corpus });
  }
  return out;
}

/** The shipped ladder's rubric, as the words a model is shown. */
function modelRouterPrompt(task: string): string {
  const questions = questionsFor(DEFAULT_CONFIG);
  const state = stateFor({ task }, DEFAULT_CONFIG);
  const tier = questions.tier as { instructions: string; criteria: string[] };
  const under = questions.underspecified as { instructions: string; criteria: Record<string, string> };
  const over = questions.oversized as { instructions: string; criteria: Record<string, string> };
  const names = DEFAULT_CONFIG.tiers.map((t) => t.label);
  return [
    "Answer three questions about the request below. Answer with three lines and nothing else.",
    "",
    "The situation, as JSON:",
    JSON.stringify(state, null, 1),
    "",
    `Q1. ${tier.instructions}`,
    ...tier.criteria.map((c, i) => `  ${names[i]}: ${c}`),
    `Answer line 1: "tier: <one of ${names.join("/")}>"`,
    "",
    `Q2. ${under.instructions}`,
    `  yes: ${under.criteria.true}`,
    `  no: ${under.criteria.false}`,
    'Answer line 2: "underspecified: <yes|no>"',
    "",
    `Q3. ${over.instructions}`,
    `  yes: ${over.criteria.true}`,
    `  no: ${over.criteria.false}`,
    'Answer line 3: "oversized: <yes|no>"',
  ].join("\n");
}

/**
 * The model's three answers, in the shape `decide()` takes.
 *
 * A model says "haiku"; a `score` says 0.31. So the model's tier becomes the
 * integer rung, and its yes/no becomes 1 or 0 -- which is exactly what
 * `escalateAt: 0.7` tests against, so the escape hatches fire the same way for
 * both arms. `confidence` is set to 1: the model was not asked for one, and
 * inventing a number below `minConfidence` would make the policy's
 * no-downgrade rule fire for the model and not for jev.
 */
export function judgmentFromText(text: string): Judgment | null {
  const lower = text.toLowerCase();
  const names = DEFAULT_CONFIG.tiers.map((t) => t.label.toLowerCase());
  const tierLine = lower.match(/tier\s*[:=]\s*([a-z0-9-]+)/);
  let rung = tierLine ? names.indexOf(tierLine[1]) : -1;
  if (rung < 0) {
    // Last mention wins, the rule docs/07's tier-2 arm used and run.ts kept.
    let best = -1;
    for (let i = 0; i < names.length; i += 1) {
      const at = lower.lastIndexOf(names[i]);
      if (at >= 0 && at > best) {
        best = at;
        rung = i;
      }
    }
  }
  if (rung < 0) return null;
  const yes = (key: string): number => {
    const m = lower.match(new RegExp(`${key}\\s*[:=]\\s*(yes|no|true|false)`));
    return m && (m[1] === "yes" || m[1] === "true") ? 1 : 0;
  };
  return {
    tier: rung,
    tierConfidence: 1,
    effort: Number.NaN,
    effortConfidence: Number.NaN,
    underspecified: yes("underspecified"),
    oversized: yes("oversized"),
  };
}

/** jev's recorded `failure`-arm answers, averaged over its three repeats. */
function jevJudgments(): Map<string, { j: Judgment; ms: number; tokens: number }> {
  const asks = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../router/records/asks.json"), "utf8")) as {
    rows: AskRow[];
  };
  const byTask = new Map<string, AskRow[]>();
  for (const r of asks.rows) {
    // `failure` is the realistic arm: docs/36's `plain` is the control (the
    // prompt is identical across tasks) and `source` is the upper bound.
    if (r.arm !== "failure") continue;
    const xs = byTask.get(r.task) ?? [];
    xs.push(r);
    byTask.set(r.task, xs);
  }
  const out = new Map<string, { j: Judgment; ms: number; tokens: number }>();
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  for (const [task, xs] of byTask) {
    out.set(task, {
      j: {
        tier: mean(xs.map((x) => x.tier)),
        tierConfidence: mean(xs.map((x) => x.tierConfidence)),
        effort: mean(xs.map((x) => x.effort)),
        effortConfidence: 1,
        underspecified: mean(xs.map((x) => x.underspecified)),
        oversized: mean(xs.map((x) => x.oversized)),
      },
      ms: Math.round(mean(xs.map((x) => x.ms))),
      tokens: Math.round(mean(xs.map((x) => x.inputTokens))),
    });
  }
  return out;
}

/** The 53 tasks' text, cached: the hard corpus's baselines run `node --test`. */
function routerInputs(): TaskInput[] {
  if (existsSync(INPUTS)) return JSON.parse(readFileSync(INPUTS, "utf8")) as TaskInput[];
  const xs = taskInputs();
  mkdirSync(RECORDS, { recursive: true });
  writeFileSync(INPUTS, `${JSON.stringify(xs, null, 1)}\n`);
  return xs;
}

async function modelRouterRows(models: ModelName[], record: Record_, limit: number): Promise<void> {
  const want = cheapestSufficient();
  const jev = jevJudgments();
  const inputs = routerInputs()
    .filter((t) => want.has(t.task))
    .slice(0, limit);
  const order = DEFAULT_CONFIG.tiers.map((t) => t.label);

  for (const input of inputs) {
    const label = want.get(input.task);
    if (!label) continue;
    // Every arm is routed from the SAME starting model, because `decide()`'s
    // no-downgrade rules are relative to `current`. docs/36's own runs start
    // at the config fallback, so this does too.
    const current = DEFAULT_CONFIG.fallback;

    for (const arm of ["jev", ...models] as ("jev" | ModelName)[]) {
      if (record.rows.some((r) => r.which === "model" && r.item === input.task && r.arm === arm)) continue;
      let row: RouterRow;
      if (arm === "jev") {
        const got = jev.get(input.task);
        if (!got) continue;
        const d = decide({ config: DEFAULT_CONFIG, judgment: got.j, current });
        row = {
          which: "model",
          arm,
          item: input.task,
          answer: d.label,
          want: label.tier,
          ms: got.ms,
          rung: d.rung,
          wantRung: label.rung,
          inputTokens: got.tokens,
          reason: d.reason,
        };
      } else {
        const text = inputFor("failure", input).task;
        const got = await askModel(arm, modelRouterPrompt(text));
        const j = judgmentFromText(got.out);
        const d = decide({ config: DEFAULT_CONFIG, judgment: j, current });
        row = {
          which: "model",
          arm,
          item: input.task,
          answer: j ? d.label : "(unparsed)",
          want: label.tier,
          ms: got.ms,
          rung: j ? d.rung : undefined,
          wantRung: label.rung,
          reason: d.reason,
          ...(got.error || !j ? { error: got.error ?? got.out.slice(0, 160) } : {}),
        };
      }
      record.rows.push(row);
      save(record);
      console.log(
        `  ${input.task.padEnd(20)} ${arm.padEnd(8)} ${row.answer.padEnd(8)} want ${row.want.padEnd(7)} ` +
          `${row.rung !== undefined && row.wantRung !== undefined && row.rung > row.wantRung ? "OVER " : "     "}` +
          `${String(row.ms).padStart(7)} ms`,
      );
    }
  }
  void order;
}

// ------------------------------------------------------------- the skill router

const LEVEL_NAMES = ["no", "mention", "on_request", "want"] as const;

/**
 * The fan-out, as one prompt.
 *
 * jev asks 74 questions in ONE request against one state (docs/29's whole
 * subject: 20,078 input tokens, 0.6 s). The comparable shape for a model is
 * one call listing the same 74 skills against the same project text, with the
 * same four-level rubric verbatim. Splitting it into 74 calls would be a
 * different cost model and would also be the arm docs/29 measured as worse.
 */
function skillRouterPrompt(project: string, skills: { skill: string; description: string }[]): string {
  const q = scoreQuestion("fanout", "", "") as { instructions: { task: string } };
  return [
    q.instructions.task,
    "",
    "The repository:",
    project,
    "",
    "Rate EVERY skill below on this four-level scale:",
    ...LEVELS.map((c, i) => `  ${LEVEL_NAMES[i]}: ${c}`),
    "",
    "The skills:",
    ...skills.map((s) => `- ${s.skill}: ${s.description.replace(/\s+/g, " ").slice(0, 300)}`),
    "",
    `Answer with exactly ${skills.length} lines and nothing else, one per skill, in the form`,
    `"<skill-name>: <one of ${LEVEL_NAMES.join("/")}>". Every skill above must appear.`,
  ].join("\n");
}

/** Parse "<name>: <level>" lines into levels, missing ones left out. */
export function levelsFromText(text: string, names: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*[-*\d.)\s]*([A-Za-z0-9_@/.-]+)\s*[:=]\s*(?:\*\*)?\s*([a-z_]+)/);
    if (!m) continue;
    const at = names.indexOf(m[1]);
    const level = LEVEL_NAMES.indexOf(m[2] as (typeof LEVEL_NAMES)[number]);
    if (at >= 0 && level >= 0) out.set(names[at], level);
  }
  return out;
}

async function skillRouterRows(models: ModelName[], record: Record_, limit: number): Promise<void> {
  const snapshot = loadSnapshot(resolve(import.meta.dirname, "../../skill-select"));
  const select = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../skill-select/records/select.json"), "utf8"),
  ) as { project: string; arm: string; skill: string; repeat: number; value: number; confidence: number; requestMs: number; requestInputTokens: number }[];
  const projects = PROJECTS.slice(0, limit);

  for (const project of projects) {
    const cands = candidates(snapshot, project).sort((a, b) => a.skill.localeCompare(b.skill));
    const names = cands.map((c) => c.skill);
    const wanted = new Set(cands.filter((c) => c.label === "want").map((c) => c.skill));

    const scoreRow = (levels: Map<string, number>): { load: Pick[]; reason: string } => {
      const picks: Pick[] = cands.map((c) => ({
        skill: { name: c.skill, description: c.description },
        level: levels.get(c.skill) ?? Number.NaN,
        confidence: 1,
        why: "judged" as const,
      }));
      // A skill the arm did not rate cannot be loaded. NaN >= loadAt is
      // false, so `selectFrom` already does the right thing; naming it here
      // so an unparsed line is never read as a `no`.
      return selectFrom(picks, Number.NaN, DEFAULT_SKILL_CONFIG);
    };

    for (const arm of ["jev", ...models] as ("jev" | ModelName)[]) {
      if (record.rows.some((r) => r.which === "skill" && r.item === project.id && r.arm === arm)) continue;
      let levels = new Map<string, number>();
      let ms = 0;
      let tokens: number | undefined;
      let error: string | undefined;
      if (arm === "jev") {
        const mine = select.filter((r) => r.project === project.id && r.arm === "fanout" && r.repeat === 0);
        if (mine.length === 0) continue;
        for (const r of mine) levels.set(r.skill, r.value);
        ms = mine[0].requestMs;
        tokens = mine[0].requestInputTokens;
      } else {
        const got = await askModel(arm, skillRouterPrompt(projectText(project), cands));
        levels = levelsFromText(got.out, names);
        ms = got.ms;
        error = got.error ?? (levels.size === 0 ? got.out.slice(0, 160) : undefined);
      }
      const { load, reason } = scoreRow(levels);
      const loaded = new Set(load.map((p) => p.skill.name));
      const hit = [...loaded].filter((n) => wanted.has(n)).length;
      record.rows.push({
        which: "skill",
        arm,
        item: project.id,
        answer: [...loaded].sort().join(",") || "(none)",
        want: [...wanted].sort().join(","),
        ms,
        hit,
        miss: wanted.size - hit,
        extra: loaded.size - hit,
        loaded: loaded.size,
        reason: `${reason}/rated ${levels.size} of ${names.length}`,
        ...(tokens ? { inputTokens: tokens } : {}),
        ...(error ? { error } : {}),
      });
      save(record);
      const last = record.rows[record.rows.length - 1];
      console.log(
        `  ${project.id.padEnd(16)} ${arm.padEnd(8)} loaded ${String(last.loaded).padStart(2)} ` +
          `hit ${last.hit}/${wanted.size} extra ${String(last.extra).padStart(2)} ` +
          `rated ${String(levels.size).padStart(2)}/${names.length} ${String(ms).padStart(7)} ms`,
      );
    }
  }
}

// -------------------------------------------------------------------- reporting

/**
 * jev's score put through a ladder fitted WITHOUT the task being scored.
 *
 * The shipped default is `cuts: null`, and docs/36 §2.3 is explicit that this
 * means rounding the score, that rounding assumes the rubric's own levels are
 * the right boundaries, and that docs/25 spent a report showing that
 * assumption wrong more often than not. So "jev over-escalates" measured on
 * the default is measuring the DEFAULT, and this row separates the two.
 *
 * Leave-one-out rather than `fitLadder` on everything, because cuts fitted on
 * a task and then scored on that task are the in-sample optimum:
 * `experiments/router`'s own §4 shows 1.81 in-sample against 3.54 held out at
 * penalty 100, which is a factor of two of self-congratulation.
 *
 * `null` when the corpus cannot support a fit at all (fewer than two distinct
 * cheapest-sufficient rungs), rather than a table row that looks fitted.
 */
function fittedLeaveOneOut(penalty: number): Map<string, number> | null {
  const want = cheapestSufficient();
  const asks = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../router/records/asks.json"), "utf8")) as {
    rows: AskRow[];
  };
  const samples: LadderSample[] = asks.rows
    .filter((r) => r.arm === "failure" && Number.isFinite(r.tier) && want.has(r.task))
    .map((r) => ({ score: r.tier, cheapest: want.get(r.task)?.rung ?? null, group: r.task }));
  if (new Set(samples.map((s) => s.cheapest)).size < 2) return null;
  const rungs = DEFAULT_CONFIG.tiers.map((t) => ({ name: t.label, price: t.price }));
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const out = new Map<string, number>();
  for (const task of new Set(samples.map((s) => s.group as string))) {
    const others = samples.filter((s) => s.group !== task);
    // A held-out fold with only one distinct label left cannot fit a ladder,
    // and `fitLadder` says so rather than returning cuts. Skipping the task is
    // the honest handling: it is not a rung this arm chose.
    if (new Set(others.map((s) => s.cheapest)).size < 2) continue;
    const fit = fitLadder(others, rungs, { failurePenalty: penalty });
    if (!fit.fitted) continue;
    out.set(task, rungFor(mean(samples.filter((s) => s.group === task).map((s) => s.score)), fit.cuts));
  }
  return out.size > 0 ? out : null;
}

function report(): void {
  if (!existsSync(PATH)) throw new Error("no records/routers.json -- run without --report first");
  const rows = (JSON.parse(readFileSync(PATH, "utf8")) as Record_).rows;
  const ARMS: ("jev" | ModelName)[] = ["jev", "haiku", "sonnet"];
  const med = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Number.NaN;

  const model = rows.filter((r) => r.which === "model");
  if (model.length > 0) {
    const n = model.filter((r) => r.arm === "jev").length;
    console.log(`\n§1 the model router: over-escalation on ${n} tasks whose label is a real exit code\n`);
    console.log(
      "  The label barely varies -- 52 of 53 tasks pass at `haiku`, the cheapest\n" +
        "  rung -- so accuracy here would flatter any arm that answers `haiku`.\n" +
        "  What varies is how often an arm goes UP anyway, and what that costs at\n" +
        "  the tiers' own price ratios (haiku 1, sonnet 3, opus 15).\n",
    );
    const priceOf = (rung: number): number => DEFAULT_CONFIG.tiers[rung]?.price ?? Number.NaN;
    const tasks = [...new Set(model.map((r) => r.item))];
    const wantRung = new Map(model.map((r) => [r.item, r.wantRung as number]));

    /**
     * Every arm as a task -> rung map, so the free baselines and the fitted
     * ladder sit in the same table as the judgments. A baseline kept out of
     * the table is a baseline nobody compares against.
     */
    const rungsOf = new Map<string, Map<string, number>>();
    for (const arm of ARMS) {
      const xs = model.filter((r) => r.arm === arm && r.rung !== undefined);
      if (xs.length > 0) rungsOf.set(arm, new Map(xs.map((r) => [r.item, r.rung as number])));
    }
    // The free baselines docs/36 §4 measured. `always-haiku` is the one that
    // matters: it costs nothing, and on this corpus no fitted ladder beat it
    // held out. Any judgment that does not beat it is not paying for itself.
    rungsOf.set("always-haiku (free)", new Map(tasks.map((t) => [t, 0])));
    rungsOf.set("always-sonnet (free)", new Map(tasks.map((t) => [t, 1])));
    // jev's score, put through a ladder fitted WITHOUT the task being scored.
    // The shipped default is `cuts: null` (rounding), which docs/36 §2.3 calls
    // the pre-calibration default on purpose. This row is what calibration
    // buys, and it is leave-one-out so it is not the in-sample optimum.
    for (const penalty of [5, 20, 100]) {
      const loo = fittedLeaveOneOut(penalty);
      if (loo) rungsOf.set(`jev+cuts@${penalty}`, loo);
    }

    const rungsList = DEFAULT_CONFIG.tiers.map((t) => ({ name: t.label, price: t.price }));
    /**
     * The oracle over a GIVEN task set, not over all 53.
     *
     * Because the fitted rows cannot score every task (see below), an oracle
     * computed once over 53 is not the ceiling for a row scored over 52. The
     * first version of this table did exactly that and printed a fitted arm at
     * 1.00 against an oracle of 1.04 -- an arm beating the oracle, which is
     * impossible and was purely a denominator mismatch.
     */
    const oracleOver = (xs: string[]): number =>
      xs.reduce((a, t) => a + priceOf(wantRung.get(t) as number), 0) / xs.length;

    console.log("  arm                      n   over-escalated   under-routed   token bill   per task @5/@20/@100");
    for (const [arm, map] of rungsOf) {
      const xs = tasks.filter((t) => map.has(t) && wantRung.has(t));
      if (xs.length === 0) continue;
      const over = xs.filter((t) => (map.get(t) as number) > (wantRung.get(t) as number));
      const under = xs.filter((t) => (map.get(t) as number) < (wantRung.get(t) as number));
      const bill = xs.reduce((a, t) => a + priceOf(map.get(t) as number), 0);
      const unparsed = model.filter((r) => r.arm === arm && r.rung === undefined).length;
      // jev-core's own `costOf`, at the three penalties docs/36 §4 reports.
      // `failurePenalty` has no default by design -- a code-review router and
      // a deploy router disagree about it by orders of magnitude -- so all
      // three show rather than one being picked here.
      const at = (penalty: number): string =>
        (
          xs.reduce(
            (a, t) =>
              a +
              costOf(map.get(t) as number, { score: Number.NaN, cheapest: wantRung.get(t) as number }, rungsList, {
                failurePenalty: penalty,
              }),
            0,
          ) / xs.length
        ).toFixed(2);
      console.log(
        `  ${arm.padEnd(21)} ${String(xs.length).padStart(3)}   ` +
          `${`${over.length} (${((100 * over.length) / xs.length).toFixed(0)}%)`.padStart(14)}   ` +
          `${String(under.length).padStart(12)}   ${`${(bill / oracleOver(xs) / xs.length).toFixed(2)}x`.padStart(10)}   ` +
          `${at(5)} / ${at(20)} / ${at(100)}` +
          `${unparsed > 0 ? `   (${unparsed} unparsed)` : ""}`,
      );
    }
    console.log(
      "\n  `n` IS THE COLUMN TO READ SECOND. `token bill` is the chosen rungs' token\n" +
        "  cost over the oracle's, on that row's own n; the last three are jev-core's\n" +
        "  `costOf` with a failed turn priced at 5, 20 and 100. Read `n` because the\n" +
        `  jev+cuts rows CANNOT SCORE ALL ${tasks.length} TASKS, and the reason is the whole\n` +
        "  problem with this corpus: leave-one-out removes `equals-k3`, and with it\n" +
        "  gone every remaining task has the same label, so no ladder can be fitted\n" +
        "  for the one task the ladder exists for. Their n is the easy 52, whose\n" +
        `  oracle is ${oracleOver(tasks.filter((t) => (wantRung.get(t) as number) === 0)).toFixed(2)} -- so 1.00x there means "tied with the oracle on the tasks\n` +
        '  where the oracle says haiku", which is what `always-haiku` does for free.',
    );

    // ------------------------------------------------- does any arm SEE it?
    //
    // The tables above price the decisions. This one asks whether the judgment
    // carries the signal at all: of the 53 tasks, one actually needed sonnet,
    // so an arm whose score is informative should rank THAT task high. With a
    // single positive the null is exact and small -- the positive is equally
    // likely to sit in any of the 53 positions -- so the p-value is counted,
    // not approximated, the same way docs/40's permutation test was.
    const positives = tasks.filter((t) => (wantRung.get(t) as number) > 0);
    if (positives.length > 0) {
      console.log("\n  and the question underneath all of it: does any arm's score SEE the hard task?\n");
      console.log("  arm                    AUC   the hard task's rank   exact p (one-sided)");
      const jevScore = jevJudgments();
      const scored: [string, Map<string, number>][] = [
        ["jev (raw `tier` score)", new Map([...jevScore].map(([t, v]) => [t, v.j.tier]))],
        ...[...rungsOf].map(([arm, m]) => [arm, m] as [string, Map<string, number>]),
      ];
      const best: { arm: string; auc: number; p: number }[] = [];
      for (const [arm, map] of scored) {
        const pos = positives.filter((t) => map.has(t));
        const neg = tasks.filter((t) => map.has(t) && (wantRung.get(t) as number) === 0);
        if (pos.length !== 1 || neg.length === 0) continue;
        const p0 = map.get(pos[0]) as number;
        const below = neg.filter((t) => (map.get(t) as number) < p0).length;
        const tied = neg.filter((t) => (map.get(t) as number) === p0).length;
        const auc = (below + 0.5 * tied) / neg.length;
        // Under the null the positive's position among the n+1 slots is
        // uniform, so P(at least `below` negatives beneath it) is exact.
        const p = (neg.length + 1 - below) / (neg.length + 1);
        best.push({ arm, auc, p });
        console.log(
          `  ${arm.padEnd(21)} ${auc.toFixed(3).padStart(6)}   ` +
            `${`${below + 1} of ${neg.length + 1}${tied > 0 ? ` (${tied} tied)` : ""}`.padStart(20)}   ` +
            `${p.toFixed(3).padStart(8)}`,
        );
      }
      // COMPUTED, not written. Five conclusion strings in this repo's reports
      // have contradicted their own tables, every one of them because the
      // sentence was fixed and the numbers were not (docs/40 lists them).
      const top = best.slice().sort((a, b) => b.auc - a.auc)[0];
      const separating = best.filter((b) => b.p <= 0.05);
      if (top) {
        console.log(
          `\n  >> Best AUC is ${top.auc.toFixed(3)} (${top.arm}), and ${
            separating.length === 0
              ? "NO ARM reaches p <= 0.05"
              : `${separating.length} arm(s) reach p <= 0.05: ${separating.map((s) => s.arm).join(", ")}`
          }.`,
        );
        if (separating.length === 0) {
          console.log(
            "     So the fitted ladder's row above is not the judgment being calibrated\n" +
              "     into usefulness -- with no arm ranking the hard task above chance, a\n" +
              "     ladder fitted on this corpus can only be learning to answer `haiku`\n" +
              "     always, which `always-haiku` does for free. On THIS corpus the model\n" +
              "     router has nothing to sell, and that is a statement about the corpus\n" +
              "     as much as about the router: one positive cannot show separation even\n" +
              "     if it were there, because the smallest p this test can return is\n" +
              `     ${(1 / (tasks.length - positives.length + 1)).toFixed(3)}.`,
          );
        }
      }
    }

    const hard = model.filter((r) => (r.wantRung ?? 0) > 0);
    if (hard.length > 0) {
      console.log("\n  the one task a cheap answer cannot have:\n");
      console.log("  task                 want      jev       haiku     sonnet");
      for (const item of [...new Set(hard.map((r) => r.item))]) {
        const cell = (arm: "jev" | ModelName): string => {
          const r = model.find((x) => x.arm === arm && x.item === item);
          if (!r) return "-".padEnd(9);
          const wrong = r.rung !== undefined && r.wantRung !== undefined && r.rung < r.wantRung;
          return `${wrong ? "*" : " "}${r.answer}`.padEnd(9);
        };
        console.log(
          `  ${item.padEnd(20)} ${(hard.find((r) => r.item === item)?.want ?? "?").padEnd(9)} ` +
            `${cell("jev")} ${cell("haiku")} ${cell("sonnet")}`,
        );
      }
      console.log("  (* marks an under-route: the tier that was measured to FAIL on this task)");
    }

    console.log("\n  why each arm went up, by the shipped policy's own `reason`:\n");
    for (const arm of ARMS) {
      const xs = model.filter((r) => r.arm === arm);
      if (xs.length === 0) continue;
      const counts = new Map<string, number>();
      for (const r of xs) counts.set(r.reason ?? "?", (counts.get(r.reason ?? "?") ?? 0) + 1);
      console.log(
        `  ${arm.padEnd(8)} ${[...counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`,
      );
    }
  }

  const skill = rows.filter((r) => r.which === "skill");
  if (skill.length > 0) {
    const n = skill.filter((r) => r.arm === "jev").length;
    console.log(`\n§2 the skill router: the same 74-wide fan-out, on ${n} projects\n`);
    console.log(
      "  One request per project, 74 skills rated in it, then the SHIPPED\n" +
        "  `selectFrom` (loadAt 2.5, maxLoad 3) decides what loads. Labels are\n" +
        "  docs/29's, derived from the catalogue's own tier legend.\n",
    );
    console.log("  arm       loaded/project   wanted-found   precision   recall   rated all 74   median ms");
    for (const arm of ARMS) {
      const xs = skill.filter((r) => r.arm === arm);
      if (xs.length === 0) continue;
      const hit = xs.reduce((a, r) => a + (r.hit ?? 0), 0);
      const loaded = xs.reduce((a, r) => a + (r.loaded ?? 0), 0);
      const want = xs.reduce((a, r) => a + (r.hit ?? 0) + (r.miss ?? 0), 0);
      const full = xs.filter((r) => /rated (\d+) of \1$/.test(r.reason ?? "")).length;
      console.log(
        `  ${arm.padEnd(8)} ${(loaded / xs.length).toFixed(2).padStart(14)}   ` +
          `${`${hit}/${want}`.padStart(12)}   ` +
          `${(loaded === 0 ? "-" : `${((100 * hit) / loaded).toFixed(0)}%`).padStart(9)}   ` +
          `${(want === 0 ? "-" : `${((100 * hit) / want).toFixed(0)}%`).padStart(6)}   ` +
          `${`${full}/${xs.length}`.padStart(12)}   ${String(med(xs.map((r) => r.ms))).padStart(9)}`,
      );
    }
    console.log(
      "\n  `rated all 74` is the column to read first. A router that answers about\n" +
        "  60 of the 74 skills it was asked about has not made a cheaper decision,\n" +
        "  it has made a partial one -- and a skill it never rated cannot load,\n" +
        "  which lowers `loaded/project` for a reason that is not judgment.",
    );
    console.log("\n  per project:\n");
    console.log("  project          arm      loaded   hit   miss   extra   rated   ms");
    for (const item of [...new Set(skill.map((r) => r.item))]) {
      for (const arm of ARMS) {
        const r = skill.find((x) => x.arm === arm && x.item === item);
        if (!r) continue;
        const rated = (r.reason ?? "").match(/rated (\d+) of (\d+)/);
        console.log(
          `  ${(arm === "jev" ? item : "").padEnd(16)} ${arm.padEnd(8)} ${String(r.loaded).padStart(6)}   ` +
            `${String(r.hit).padStart(3)}   ${String(r.miss).padStart(4)}   ${String(r.extra).padStart(5)}   ` +
            `${(rated ? `${rated[1]}/${rated[2]}` : "-").padStart(5)}   ${String(r.ms).padStart(7)}`,
        );
      }
    }
  }

  console.log(
    "\n§3 what this does not measure\n\n" +
      "  - THE MODEL ROUTER'S ACCURACY. The corpus cannot carry that measurement:\n" +
      "    52 of 53 labels are the cheapest rung. §1 measures over-escalation, which\n" +
      "    is the axis the corpus does support, and docs/36 §5 predicted this.\n" +
      "  - THE VALUE OF AN UNDER-ROUTE. One task in the corpus fails at haiku, so\n" +
      "    the error whose price docs/36 §2.3 called the expensive one is measured on\n" +
      "    a denominator of one.\n" +
      "  - REPEATS. One draw per arm per item. docs/25's rule says a small gap needs\n" +
      "    the draw noise measured first; jev's side is cheap enough to repeat and\n" +
      "    the CLI's side is not.\n" +
      "  - EFFORT. `decide()` returns an effort level too and no corpus here labels\n" +
      "    it, so it is recorded and not scored.\n",
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (name: string, dflt: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  if (argv.includes("--report")) {
    report();
    return;
  }
  const which = arg("arm", "model,skill").split(",");
  // Filtered against `MODELS` rather than cast: a typo in `--models` would
  // otherwise reach `spawn` as `--model undefined` and come back as a row
  // with an error, which looks like a measurement.
  const models = arg("models", "haiku,sonnet")
    .split(",")
    .filter((m): m is ModelName => m in MODELS);
  const limit = Number(arg("limit", "999"));
  const record = load();
  if (which.includes("model")) {
    console.log("\n  the model router, over-escalation against real exit codes\n");
    await modelRouterRows(models, record, limit);
  }
  if (which.includes("skill")) {
    console.log("\n  the skill router, the 74-wide fan-out\n");
    await skillRouterRows(models, record, limit);
  }
  report();
}

if (!argv0IsTest()) void main();

/** So `test.ts` can import the parsers without running the whole thing. */
function argv0IsTest(): boolean {
  return process.argv.some((a) => a.endsWith("test.ts") || a === "--test");
}

void ROUTER_ARMS;
void NEEDED;
