/**
 * Proposal J from docs/06: given a context and a task runner holding a lot of
 * tasks, can Jev pick the right one?
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/run.ts [--repeat 3] [--roster medium]
 *                                             [--arms names,commands] [--scale]
 *
 * Built in the shape of docs/16 on purpose: Jev sees the task NAME, and the
 * ground truth is what the task's COMMAND actually does. A roster where some
 * names oversell or undersell their command is the near-miss case, and the
 * prediction from 16 is that those are where it breaks.
 *
 * Two things are measured that a plain accuracy number hides:
 *  - the closed world (docs/00). Six scenarios have NO right answer, and
 *    `choice` always picks something. Three ways out are compared: take the
 *    pick regardless, gate it on a separate noul, or offer an inline
 *    "(none of these)" option.
 *  - scale. The same scenarios run against 14, 50 and 122 tasks, since the
 *    server's ceiling is 255 choices and a monorepo gets there.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { Jev, MAX_CHOICES, noul, type Answer } from "../../shared/jev.js";
import { SCENARIOS, type Scenario } from "./scenarios.js";
import { roster, taskByName, type RosterSize } from "./roster.js";
import { ARMS, ARM_BLURB, ESCAPE, NONE, questionsFor, stateFor, type ArmName } from "./arms.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const REPEATS = Number.parseInt(arg("repeat", "3"), 10);
const ROSTER = arg("roster", "medium") as RosterSize;
const CONCURRENCY = Number.parseInt(arg("concurrency", "4"), 10);
const GATE = Number.parseFloat(arg("gate", "0.5"));
const SELECTED = arg("arms", ARMS.join(",")).split(",") as ArmName[];
const SCALE = process.argv.includes("--scale");
const NO_CONTEXT = process.argv.includes("--no-context");

interface Row {
  arm: ArmName;
  rosterSize: RosterSize;
  taskCount: number;
  repeat: number;
  scenario: string;
  kind: Scenario["kind"];
  /** What the choice question returned, verbatim. */
  pick: string;
  confidence: number;
  /** p(one of these tasks does it) from the separate noul. */
  applicable: number;
  /** Rank of the first accepted task in the probability ordering, or -1. */
  correctRank: number;
  correct: string[];
  rawOk: boolean;
  gatedOk: boolean;
  top3Ok: boolean;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function probabilities(a: Answer | undefined): Record<string, number> {
  return a?.type === "choice" ? a.probabilities : {};
}

/** The decision each escape strategy would make from one response. */
function decisions(pick: string, applicable: number): { raw: string; gated: string } {
  const inline = pick === ESCAPE ? NONE : pick;
  return {
    raw: inline,
    // The noul gate overrides the pick when it says nothing here applies.
    gated: applicable < GATE ? NONE : inline,
  };
}

function ok(decision: string, correct: string[]): boolean {
  return correct.length === 0 ? decision === NONE : correct.includes(decision);
}

async function collect(
  jev: Jev,
  arm: ArmName,
  size: RosterSize,
  repeat: number,
): Promise<Row[]> {
  const tasks = roster(size);
  if (tasks.length > MAX_CHOICES) {
    throw new Error(`${tasks.length} tasks exceeds the server's ${MAX_CHOICES} choices`);
  }
  const questions = questionsFor(arm, tasks);
  return mapLimit(SCENARIOS, CONCURRENCY, async (scenario) => {
    const state = stateFor(arm, scenario, tasks, !NO_CONTEXT);
    const res = await jev.ask(state, questions);
    const answer = res.answers.pick;
    const pick = answer?.type === "choice" ? answer.choice : "";
    const confidence = answer?.type === "choice" ? answer.confidence : 0;
    const applicable = noul(res.answers.applicable);
    const ranked = Object.entries(probabilities(answer))
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
    const correctRank = scenario.correct.length === 0
      ? -1
      : Math.min(
          ...scenario.correct.map((c) => {
            const at = ranked.indexOf(c);
            return at === -1 ? Number.POSITIVE_INFINITY : at;
          }),
        );
    const d = decisions(pick, applicable);
    return {
      arm,
      rosterSize: size,
      taskCount: tasks.length,
      repeat,
      scenario: scenario.id,
      kind: scenario.kind,
      pick,
      confidence,
      applicable,
      correctRank: Number.isFinite(correctRank) ? correctRank : -1,
      correct: scenario.correct,
      rawOk: ok(d.raw, scenario.correct),
      gatedOk: ok(d.gated, scenario.correct),
      top3Ok:
        scenario.correct.length === 0
          ? d.gated === NONE
          : Number.isFinite(correctRank) && correctRank < 3,
    };
  });
}

function pct(x: number): string {
  return `${(100 * x).toFixed(1)}%`;
}

function tally(rows: Row[], key: "rawOk" | "gatedOk" | "top3Ok"): string {
  const hit = rows.filter((r) => r[key]).length;
  return `${String(hit).padStart(3)}/${String(rows.length).padEnd(3)} ${pct(
    rows.length === 0 ? 0 : hit / rows.length,
  ).padStart(6)}`;
}

async function main() {
  const inRoster = SCENARIOS.filter((s) => s.correct.length > 0);
  const escapes = SCENARIOS.filter((s) => s.correct.length === 0);
  const multi = inRoster.filter((s) => s.correct.length > 1);

  console.log("=".repeat(100));
  console.log("  TASK PICKER — can Jev choose the right task-runner task from names alone?");
  console.log(
    `  ${roster(ROSTER).length} tasks (${ROSTER}) · ${SCENARIOS.length} scenarios ` +
      `(${inRoster.length} answerable, ${escapes.length} with no right answer) · ` +
      `${REPEATS} runs per arm`,
  );
  console.log(
    `  ${multi.length} scenario(s) accept two tasks: ` +
      multi.map((s) => `${s.id}=${s.correct.join("|")}`).join(", "),
  );
  if (NO_CONTEXT) console.log("  state: GOAL + TASK LIST ONLY (no repo context)");
  console.log("=".repeat(100));

  const jev = new Jev();
  const rows: Row[] = [];

  for (const arm of SELECTED) {
    if (!ARMS.includes(arm)) throw new Error(`unknown arm '${arm}'`);
    process.stdout.write(`\n  ${arm}: ${ARM_BLURB[arm]}\n`);
    for (let r = 0; r < REPEATS; r += 1) {
      const got = await collect(jev, arm, ROSTER, r);
      rows.push(...got);
      const answerable = got.filter((x) => x.correct.length > 0);
      process.stdout.write(
        `    run ${r + 1}: ${answerable.filter((x) => x.rawOk).length}/${answerable.length} answerable\n`,
      );
    }
  }

  // The scale sweep reuses the first selected arm, so it measures roster size
  // rather than roster size crossed with presentation.
  const scaleArm = SELECTED[0];
  if (SCALE) {
    for (const size of ["core", "large"] as RosterSize[]) {
      process.stdout.write(`\n  scale: ${scaleArm} against the ${size} roster ` +
        `(${roster(size).length} tasks)\n`);
      for (let r = 0; r < REPEATS; r += 1) {
        const got = await collect(jev, scaleArm, size, r);
        rows.push(...got);
        const answerable = got.filter((x) => x.correct.length > 0);
        process.stdout.write(
          `    run ${r + 1}: ${answerable.filter((x) => x.rawOk).length}/${answerable.length} answerable\n`,
        );
      }
    }
  }

  mkdirSync("out", { recursive: true });
  writeFileSync("out/raw.jsonl", rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const primary = rows.filter((r) => r.rosterSize === ROSTER);
  const byArm = (arm: ArmName) => primary.filter((r) => r.arm === arm);
  const answerable = (rs: Row[]) => rs.filter((r) => r.correct.length > 0);
  const unanswerable = (rs: Row[]) => rs.filter((r) => r.correct.length === 0);

  console.log("");
  console.log("-".repeat(100));
  console.log("  1. ANSWERABLE SCENARIOS — top-1 pick, and whether an accepted task is in the top 3");
  console.log("");
  for (const arm of SELECTED) {
    const rs = answerable(byArm(arm));
    console.log(
      `  ${arm.padEnd(14)} top-1 ${tally(rs, "rawOk")}   top-3 ${tally(rs, "top3Ok")}` +
        `   mean confidence ${(
          rs.reduce((a, b) => a + b.confidence, 0) / Math.max(rs.length, 1)
        ).toFixed(3)}`,
    );
  }

  console.log("");
  console.log("  2. BY SCENARIO KIND — top-1 on answerable scenarios");
  console.log("");
  console.log(`  ${"".padEnd(14)}${["direct", "decoy", "lying"].map((k) => k.padStart(14)).join("")}`);
  for (const arm of SELECTED) {
    const cells = (["direct", "decoy", "lying"] as const).map((kind) => {
      const rs = byArm(arm).filter((r) => r.kind === kind);
      return `${rs.filter((r) => r.rawOk).length}/${rs.length}`.padStart(14);
    });
    console.log(`  ${arm.padEnd(14)}${cells.join("")}`);
  }

  console.log("");
  console.log(`  3. THE CLOSED WORLD — ${escapes.length} scenarios where no task fits`);
  console.log("     raw = take the pick regardless · gated = override when the noul says none");
  console.log("");
  for (const arm of SELECTED) {
    const rs = unanswerable(byArm(arm));
    const meanApplicable = rs.reduce((a, b) => a + b.applicable, 0) / Math.max(rs.length, 1);
    console.log(
      `  ${arm.padEnd(14)} raw ${tally(rs, "rawOk")}   gated ${tally(rs, "gatedOk")}` +
        `   mean p(applicable) ${meanApplicable.toFixed(3)}`,
    );
  }
  console.log("");
  console.log("     ...and what gating costs on the scenarios that DO have an answer:");
  for (const arm of SELECTED) {
    const rs = answerable(byArm(arm));
    const lost = rs.filter((r) => r.rawOk && !r.gatedOk).length;
    const meanApplicable = rs.reduce((a, b) => a + b.applicable, 0) / Math.max(rs.length, 1);
    console.log(
      `  ${arm.padEnd(14)} raw ${tally(rs, "rawOk")}   gated ${tally(rs, "gatedOk")}` +
        `   ${lost} correct pick(s) thrown away   mean p(applicable) ${meanApplicable.toFixed(3)}`,
    );
  }

  console.log("");
  console.log("  4. ALL SCENARIOS — one number per strategy");
  console.log("");
  for (const arm of SELECTED) {
    const rs = byArm(arm);
    console.log(`  ${arm.padEnd(14)} raw ${tally(rs, "rawOk")}   gated ${tally(rs, "gatedOk")}`);
  }

  if (SCALE) {
    console.log("");
    console.log(`  5. SCALE — ${scaleArm} arm, same scenarios, bigger roster`);
    console.log("");
    for (const size of ["core", "medium", "large"] as RosterSize[]) {
      const rs = rows.filter((r) => r.arm === scaleArm && r.rosterSize === size);
      if (rs.length === 0) continue;
      const a = answerable(rs);
      const u = unanswerable(rs);
      // The core roster cannot answer every scenario -- most tasks are absent.
      const reachable = a.filter((r) => r.correct.some((c) => {
        const t = taskByName(c);
        return t && roster(size).some((x) => x.name === t.name);
      }));
      console.log(
        `  ${String(rs[0].taskCount).padStart(3)} tasks (${size.padEnd(6)}) ` +
          `top-1 on reachable ${tally(reachable, "rawOk")}   ` +
          `escape gated ${tally(u, "gatedOk")}   ` +
          `mean confidence ${(a.reduce((x, y) => x + y.confidence, 0) / Math.max(a.length, 1)).toFixed(3)}`,
      );
    }
  }

  console.log("");
  console.log("  6. MISSES — answerable scenarios, what it picked instead");
  for (const arm of SELECTED) {
    const rs = answerable(byArm(arm));
    const keys = [...new Set(rs.map((r) => r.scenario))];
    const misses = keys
      .map((id) => {
        const group = rs.filter((r) => r.scenario === id);
        return { id, group, wrong: group.filter((r) => !r.rawOk).length };
      })
      .filter((m) => m.wrong > 0)
      .sort((a, b) => b.wrong - a.wrong);
    console.log("");
    console.log(`  ${arm} — ${misses.length} scenario(s) missed at least once`);
    for (const m of misses) {
      const first = m.group[0];
      const picks = [...new Set(m.group.filter((r) => !r.rawOk).map((r) => r.pick))];
      const scenario = SCENARIOS.find((s) => s.id === m.id)!;
      console.log(
        `    ${m.id.padEnd(24)} ${m.wrong}/${REPEATS}  wanted ${first.correct.join("|").padEnd(20)} ` +
          `picked ${picks.join(", ").padEnd(22)} [${first.kind}] ` +
          `conf ${(m.group.reduce((a, b) => a + b.confidence, 0) / m.group.length).toFixed(2)}`,
      );
      const picked = taskByName(picks[0]);
      if (picked?.misleading) console.log(`      picked: ${picked.misleading}`);
      if (scenario.note) console.log(`      ${scenario.note}`);
    }
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
