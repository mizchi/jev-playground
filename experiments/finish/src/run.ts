/**
 * The sweep. Real agent, real tools, mechanical verdict.
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/run.ts --repeats 3
 *   npx tsx src/run.ts --tasks easy --arms bare,guard
 *   npx tsx src/report.ts                       # from the record, no key
 *
 * WHAT THE ARMS ARE FOR, and why the control comes first.
 *
 * docs/37 §6 measured that combining components is not free -- 7 of 7 answers
 * moved more between two ways of asking than between repeats of one way -- so a
 * run of the combined agent alone can attribute nothing. The order is therefore
 * control, then one component, then more. This file starts with the pair that
 * carries the programme's load-bearing claim:
 *
 *   bare    the agent alone. The baseline, and the only thing that can say
 *           whether a gate costs anything.
 *   guard   the same agent with the SHIPPED `hooks/jev-permission-gate.mjs`
 *           on PreToolUse.
 *
 * AND THE QUESTION IS NOT "DOES THE GATE HELP". A gate on the critical path of
 * every tool call cannot help an agent finish; it can only subtract. docs/18 §1
 * asserted a 2,500 ms budget for it and nothing ever measured what the gate
 * costs in a real loop. So the two numbers this produces are:
 *
 *   1. PASS RATE, bare against guard. What the gate costs in completed work.
 *   2. LATENCY ON THE CRITICAL PATH, per command and per task.
 *
 * Both have been claims in this repository for 40-odd reports. Neither has been
 * a measurement until now.
 *
 * REPEATS ARE THE POINT, not a nicety. Every previous head-to-head here had to
 * admit "one draw per item" in its limits, because `claude -p` cost 8-75 s a
 * call. A task run costs about 20 s and the whole sweep fits in an hour, so
 * this is the first measurement in the programme that can say whether a gap is
 * bigger than the noise.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runOnce, tasks, type ArmSpec, type Corpus, type Run, type Task } from "./world.js";

const RECORDS = resolve(import.meta.dirname, "../records");
const PATH = resolve(RECORDS, "runs.json");

/** Haiku for both, so the arms differ in the gate and nothing else. */
const HAIKU = "claude-haiku-4-5-20251001";

export const ARMS: Record<string, ArmSpec> = {
  bare: { name: "bare", guard: false, model: HAIKU },
  guard: { name: "guard", guard: true, model: HAIKU },
  /**
   * The gate as it shipped BEFORE docs/43 §5.2, where an `ask` rationale went
   * to `systemMessage` only and the model never saw it.
   *
   * This arm exists so the fix is a measurement. Without it, "the agent now
   * knows why it was blocked" is a quotation from one probe; with it, the
   * question becomes whether knowing why changes whether the work gets done.
   */
  guardquiet: { name: "guardquiet", guard: true, model: HAIKU, gateFlags: ["quiet-ask"] },
  /**
   * The gate with `ask` resolved as "hand the decision back to the host".
   *
   * `jev-guard` has had `attended` / `unattendedAsk` since docs/18 and the
   * shipped HOOK never exposed either, so it always emitted `ask` -- which a
   * headless host turns into a refusal (docs/43 §5.1). That made the default a
   * BLOCK BY ACCIDENT, and docs/43 §4b priced it: the gate spoke on 8 of 869
   * commands a real agent needed and 2 of those 6 runs failed.
   *
   * `defer` is the variant worth measuring because it does NOT widen. The
   * gate's first principle is that it never returns `allow`, since `allow`
   * overrides the user's own permission rules; deferring hands the decision
   * back to those rules instead, which is what an ALLOW verdict already does.
   */
  guarddefer: { name: "guarddefer", guard: true, model: HAIKU, gateFlags: ["unattended-ask", "defer"] },
};

export interface Record_ {
  rows: Run[];
  note: string;
}

const load = (): Record_ =>
  existsSync(PATH)
    ? (JSON.parse(readFileSync(PATH, "utf8")) as Record_)
    : {
        rows: [],
        note:
          "Does the agent FINISH the work. `claude -p` generates, jev gates through " +
          "Claude Code's PreToolUse seam, `node --test` decides. Every tool call the " +
          "agent made is in `calls` -- that ledger is the corpus, and it is whatever " +
          "the agent did, not a scenario anyone wrote.",
      };

/**
 * Save, merging what is on disk.
 *
 * A run takes ~20 s and a sweep takes an hour, so a crash must cost the row in
 * flight and not the hour. `experiments/versus` learned this the same way.
 */
const save = (r: Record_): void => {
  mkdirSync(RECORDS, { recursive: true });
  const key = (x: Run): string => `${x.arm}/${x.task}/${x.repeat}`;
  const merged = new Map<string, Run>();
  if (existsSync(PATH)) {
    for (const x of (JSON.parse(readFileSync(PATH, "utf8")) as Record_).rows) merged.set(key(x), x);
  }
  for (const x of r.rows) merged.set(key(x), x);
  r.rows = [...merged.values()];
  writeFileSync(PATH, `${JSON.stringify(r, null, 2)}\n`);
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (name: string, dflt: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const which = arg("tasks", "easy") as Corpus | "both" | "all";
  const armNames = arg("arms", "bare,guard").split(",");
  const repeats = Number(arg("repeats", "3"));
  const limit = Number(arg("limit", "999"));
  const all: Task[] = tasks(which).slice(0, limit);
  const record = load();

  console.log(
    `\n  ${all.length} tasks (${which}) x ${armNames.length} arms x ${repeats} repeats = ` +
      `${all.length * armNames.length * repeats} agent runs\n`,
  );

  // Repeat-major so a partial sweep is a complete lower-repeat sweep rather
  // than a complete sweep of the alphabetically early tasks.
  for (let r = 0; r < repeats; r += 1) {
    for (const task of all) {
      for (const name of armNames) {
        const arm = ARMS[name];
        if (!arm) continue;
        if (record.rows.some((x) => x.arm === name && x.task === task.id && x.repeat === r)) continue;
        // The prompt comes from the TASK, not from here: the two corpora are told
        // different things and conflating them would hand the agent a diagnosis
        // on the corpus where the obstacle is not in `src/`.
        const row = await runOnce(task, arm, task.prompt, r, { timeoutMs: 420_000 });
        record.rows.push(row);
        save(record);
        const gated = row.calls.filter((c) => c.gateMs !== undefined).length;
        console.log(
          `  r${r} ${task.id.slice(0, 18).padEnd(18)} ${name.padEnd(6)} ` +
            `${row.passed ? "PASS" : "fail"} ${String(row.calls.length).padStart(3)} calls  ` +
            `gate ${String(row.gateMs).padStart(5)} ms/${gated}  ` +
            `deny ${row.deniedByJev} ask ${row.askedByJev} fence ${row.deniedByFence}  ` +
            `${String(row.ms).padStart(6)} ms${row.error ? `  ERR ${row.error.slice(0, 40)}` : ""}`,
        );
      }
    }
  }
  console.log(`\n  ${record.rows.length} runs in records/runs.json\n`);
}

if (process.argv[1]?.endsWith("run.ts")) await main();
