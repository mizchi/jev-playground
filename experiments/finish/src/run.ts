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
import { catalogue } from "./catalogue.js";

const RECORDS = resolve(import.meta.dirname, "../records");
/** The default record. `--out` overrides it; see `save`. */
const DEFAULT_OUT = "runs.json";

/** Haiku for both, so the arms differ in the gate and nothing else. */
const HAIKU = "claude-haiku-4-5-20251001";
/**
 * The rung above. Needed because the model router picks it: the probe routed
 * every boundary task to sonnet, so a routed arm compared only against haiku
 * would credit the router for a model whose own pass rate was never measured.
 */
const SONNET = "claude-sonnet-5";

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

  // ------------------------------------------------- the other three components
  //
  // Added after `src/probe.ts` asked, for cents, whether each of them has
  // anything to decide on this corpus. Its answers shaped every arm below, and
  // one of them killed the arm I was about to write.

  /**
   * THE MODEL ROUTER, deciding per task from the prompt the host actually has.
   *
   * `sonnet` and `haiku` exist beside it because a router arm is unreadable
   * without both rungs it can pick: "the routed arm passed 90%" says nothing
   * unless the models it chose between have their own numbers on the same
   * tasks. docs/36 measured haiku alone, and measured it with an agent that
   * could not run tests (docs/43 §0.1), so even the haiku column here is a new
   * measurement rather than a lookup.
   */
  haiku: { name: "haiku", guard: false, model: HAIKU },
  sonnet: { name: "sonnet", guard: false, model: SONNET },
  /**
   * The router asked about the request alone -- what a host has at launch.
   *
   * KEPT DELIBERATELY, KNOWING IT CANNOT VARY. The 53 repair tasks share one
   * prompt string, so this arm asks the identical question every time and its
   * per-task answers are draws on one request, not routing. It is here because
   * that is the honest baseline for the arm below: any difference between them
   * is what the failure text bought.
   */
  router: { name: "router", guard: false, model: null, routeWith: "prompt" },
  /**
   * The router asked about the request PLUS the task's real test output.
   *
   * A host that runs the tests before dispatching has this, and the text comes
   * from `node --test` rather than from me. The probe found it changes the
   * answer on some tasks and -- unexpectedly -- in the direction of CHEAPER:
   * seeing the real failure makes the work look smaller than the bare
   * instruction "the tests are failing, fix the source" does.
   */
  routerfail: { name: "routerfail", guard: false, model: null, routeWith: "failure" },

  /**
   * THE SKILL ROUTER, over 300 skills harvested from nine real repositories.
   *
   * Three arms, because a routed arm alone measures nothing:
   *
   *   bare        no `.claude/skills/` at all. Already above.
   *   allskills   all 300 land. This is not a straw man -- it is what a host
   *               with a plugin marketplace installed does, and it costs
   *               ~22,500 tokens of descriptions in the system prompt before
   *               the agent reads a line of code.
   *   skillrouter jev picks, cap 3.
   *
   * The catalogue is not mine (`catalogue.ts`), which is the first time in this
   * programme a component has been measured against a corpus I did not write.
   * The bodies ARE missing from it, and `catalogue.ts` says what that costs.
   */
  allskills: { name: "allskills", guard: false, model: HAIKU, skills: catalogue() },
  skillrouter: { name: "skillrouter", guard: false, model: HAIKU, skills: catalogue(), routeSkills: true },

  /**
   * THE ORCHESTRATION GATE, on `PreToolUse` with `Task` allowed.
   *
   * READ `src/probe.ts`'S SECOND SECTION BEFORE READING THIS ARM'S NUMBERS.
   * The gate scores these tasks at ~0.16 against its shipped 0.50 cutoff, on
   * every task in the corpus, so it refuses every spawn. That makes this arm a
   * measurement of ONE THING: an agent that is allowed to delegate and then
   * denied. Which is worth knowing -- a denied `Task` is a wasted turn and the
   * guard's numbers show a denied tool call can cost the whole task -- but it
   * is NOT "does jev-orchestrator route work well", and no amount of running
   * it here will become that.
   *
   * `subagent` is its control: `Task` allowed, nobody gating. Without it, a
   * drop in the gated arm cannot be told apart from the cost of handing a
   * small repair task a delegation tool it should not use.
   */
  subagent: { name: "subagent", guard: false, model: HAIKU, extraTools: ["Task"] },
  orchestrated: {
    name: "orchestrated",
    guard: false,
    model: HAIKU,
    extraTools: ["Task"],
    orchestrate: true,
  },
};

export interface Record_ {
  rows: Run[];
  note: string;
}

const load = (PATH: string): Record_ =>
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
 *
 * MERGING IS NOT THE SAME AS BEING SAFE TO RUN TWICE AT ONCE. Read-then-write
 * loses rows when two sweeps share a file, which is why `--out` exists: the
 * three component sweeps run concurrently and each owns its own record.
 */
const save = (r: Record_, PATH: string): void => {
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
  const out = resolve(RECORDS, arg("out", DEFAULT_OUT));
  const all: Task[] = tasks(which).slice(0, limit);
  const record = load(out);

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
        save(record, out);
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
  console.log(`\n  ${record.rows.length} runs in ${out}\n`);
}

if (process.argv[1]?.endsWith("run.ts")) await main();
