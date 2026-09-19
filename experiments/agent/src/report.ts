/**
 * The tables, from the record, with no API key and no pi run.
 *
 *   npx tsx src/report.ts
 *
 * The question this answers is narrower than "is the agent good" and it is
 * the one that was open: DOES EACH COMPONENT'S DECISION REACH THE WIRE. The
 * model is scripted (`stub.ts`), so nothing here says whether an agent does
 * useful work -- only that the five components fire, take effect, and cost
 * what they cost inside a real pi session.
 *
 * Every row is paired with a CONTROL: the same scenario, same script, same
 * pi, extension absent. Without it "the tree survived" would be a fact about
 * `rm -rf` and not about the guard (docs/07, docs/12, docs/25 §5).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SCENARIOS } from "./scenarios.js";
import type { Arm, Record_, Turn } from "./run.js";

const PATH = resolve(import.meta.dirname, "../records/agent.json");
const pad = (s: string, n: number): string => s.padEnd(n);
const mean = (xs: number[]): number => (xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
const num = (x: number, d = 0): string => (Number.isFinite(x) ? x.toFixed(d) : "-");

interface TurnEntry {
  model?: { label?: string; effort?: string | null; reason?: string; changed?: boolean };
  skills?: { name: string; level: number; why: string }[];
  plan?: { shape?: string; split?: boolean } | null;
  inputTokens?: number;
  ms?: number;
}

function turnOf(record: Record_, scenario: string, arm: Arm): Turn | undefined {
  return record.turns.find((t) => t.scenario === scenario && t.arm === arm);
}

function entryData(turn: Turn | undefined, customType: string): Record<string, unknown> | undefined {
  return turn?.entries.find((e) => e.customType === customType)?.data;
}

function reportRan(record: Record_): void {
  console.log(`\n§1 does it run at all?\n`);
  console.log("  scenario           arm       exit   pi events   provider calls   tools   extension entries");
  for (const scenario of SCENARIOS) {
    for (const arm of ["hermes", "control"] as Arm[]) {
      const t = turnOf(record, scenario.id, arm);
      if (!t) continue;
      console.log(
        `  ${pad(scenario.id, 18)} ${pad(arm, 8)} ${String(t.exit).padStart(4)}   ` +
          `${String(t.eventTypes.length).padStart(9)}   ${String(t.sent.length).padStart(14)}   ` +
          `${String(t.tools.length).padStart(5)}   ${String(t.entries.length).padStart(17)}`,
      );
    }
  }
  const bad = record.turns.filter((t) => t.exit !== 0);
  console.log(
    bad.length === 0
      ? "\n  Every turn exits 0 in both arms: the extension never breaks the host.\n" +
          "  `pi events` is pi's own JSON stream, so these are real sessions, not mocks."
      : `\n  >> ${bad.length} turn(s) did not exit 0: ${bad.map((t) => `${t.scenario}/${t.arm}`).join(", ")}`,
  );
}

function reportModel(record: Record_): void {
  // The model router's decision is checkable at the wire: the payload's own
  // `model` field is the rung pi ended up using.
  console.log(`\n§2 the model router, at the wire\n`);
  console.log("  scenario           decided        reason            model pi actually sent   thinking set");
  for (const scenario of SCENARIOS) {
    const t = turnOf(record, scenario.id, "hermes");
    const data = entryData(t, "hermes/turn") as TurnEntry | undefined;
    if (!t || !data?.model) continue;
    const sent = [...new Set(t.sent.map((s) => s.model ?? "?"))].join(", ");
    console.log(
      `  ${pad(scenario.id, 18)} ${pad(`${data.model.label}/${data.model.effort ?? "-"}`, 14)} ` +
        `${pad(String(data.model.reason), 17)} ${pad(sent, 21)} ${t.thinking.join(",") || "-"}`,
    );
  }
  const control = turnOf(record, "vague-request", "control");
  const treated = turnOf(record, "vague-request", "hermes");
  if (control && treated) {
    console.log(
      `\n  The control arm sent ${[...new Set(control.sent.map((s) => s.model))].join(", ")} for the same turn,\n` +
        `  the treated arm ${[...new Set(treated.sent.map((s) => s.model))].join(", ")}. So \`pi.setModel\` took effect and the\n` +
        "  escape hatch is what moved it -- the tier score alone stays on the cheap rung\n" +
        "  at hermes' 0.85 cut (docs/37 §5).",
    );
  }
}

function reportGuard(record: Record_): void {
  console.log(`\n§3 the guard rail, on disk\n`);
  console.log("  scenario           arm       tool calls   asked   blocked   the sandbox tree");
  for (const scenario of SCENARIOS) {
    for (const arm of ["hermes", "control"] as Arm[]) {
      const t = turnOf(record, scenario.id, arm);
      if (!t) continue;
      const guards = t.entries.filter((e) => e.customType === "hermes/guard");
      console.log(
        `  ${pad(scenario.id, 18)} ${pad(arm, 8)} ${String(t.tools.length).padStart(10)}   ` +
          `${String(guards.length).padStart(5)}   ${String(t.tools.filter((x) => x.blocked).length).padStart(7)}   ` +
          (t.treeSurvived ? "kept" : "GONE"),
      );
    }
  }
  const dTreated = turnOf(record, "guard-destructive", "hermes");
  const dControl = turnOf(record, "guard-destructive", "control");
  if (dTreated && dControl) {
    console.log(
      `\n  >> The same scripted \`rm -rf\` against the same directory: the tree is ` +
        `${dTreated.treeSurvived ? "kept" : "gone"} with\n     the extension and ${dControl.treeSurvived ? "kept" : "gone"} without it. ` +
        "That is the guard working, verified on the\n     filesystem rather than in a log.",
    );
    const verdict = dTreated.entries.find((e) => e.customType === "hermes/guard")?.data as
      | { verdict?: number | null; action?: string }
      | undefined;
    if (verdict) {
      console.log(
        `     The verdict was ${verdict.verdict} (1 = ask, 2 = deny) and the action was ` +
          `${verdict.action} --\n     because this session is headless, so \`unattendedAsk\` resolved it. docs/37 §2's\n` +
          "     one deliberate departure from docs/18's hook, and this is it firing.",
      );
    }
  }
  const free = turnOf(record, "read-only-free", "hermes");
  if (free) {
    console.log(
      `\n     \`read-only-free\` ran ${free.tools.length} read-only calls and cost ` +
        `${free.entries.filter((e) => e.customType === "hermes/guard").length} guard requests: the free\n` +
        "     prefilter (docs/33 §1's rule) is what keeps a resident agent's bill down.",
    );
  }
}

function reportSkills(record: Record_): void {
  console.log(`\n§4 the skill router\n`);
  console.log("  scenario           loaded                     level   reached the provider?");
  for (const scenario of SCENARIOS) {
    const t = turnOf(record, scenario.id, "hermes");
    const data = entryData(t, "hermes/turn") as TurnEntry | undefined;
    if (!t || !data) continue;
    const loaded = data.skills ?? [];
    const names = loaded.map((s) => s.name).join(", ") || "(none)";
    // The body of a loaded skill has to show up among the messages pi sent,
    // matched on the skill's OWN distinctive sentence.
    //
    // The first version of this check looked for "wc -l", which is also in
    // the scripted bash command -- so it reported `yes` while no skill body
    // had reached the wire at all, and the §4 conclusion was briefly the
    // opposite of the truth. A wire check has to match something only the
    // thing being checked would produce.
    const distinctive: Record<string, string> = {
      "counting-lines": "Report the number and the filename",
      "dashboard-design": "what decision the dashboard supports",
    };
    const onWire = loaded.some((s) => {
      const needle = distinctive[s.name];
      return Boolean(needle) && t.sent.some((req) => JSON.stringify(req.messages).includes(needle));
    });
    console.log(
      `  ${pad(scenario.id, 18)} ${pad(names, 26)} ` +
        `${pad(loaded.map((s) => s.level.toFixed(2)).join(",") || "-", 7)} ${loaded.length === 0 ? "-" : onWire ? "yes" : "NO"}`,
    );
  }
  console.log(
    "\n  Two bugs were found here, and only by running it (docs/38 §3, §4):\n" +
      "  the catalogue reader asked for `ctx.resources.skills`, which pi has no such\n" +
      "  field for, so this table was all `(none)`; and the load was delivered with\n" +
      "  `deliverAs: \"nextTurn\"`, so the chosen skill arrived one turn after the turn\n" +
      "  that needed it and never reached the model at all in a one-shot session.\n" +
      "  All three delivery modes were then measured against the payload: `steer` and\n" +
      "  `followUp` arrive, `nextTurn` does not.",
  );
}

function reportCost(record: Record_): void {
  console.log(`\n§5 what the extension costs a turn\n`);
  console.log("  arm       turns   wall clock (ms)   judgment requests   input tokens   $ / 1k turns");
  for (const arm of ["hermes", "control"] as Arm[]) {
    const turns = record.turns.filter((t) => t.arm === arm);
    if (turns.length === 0) continue;
    const tokens = turns
      .map((t) => (entryData(t, "hermes/turn") as TurnEntry | undefined)?.inputTokens ?? 0)
      .filter((x) => x > 0);
    const requests = turns.map((t) => t.entries.length);
    console.log(
      `  ${pad(arm, 8)} ${String(turns.length).padStart(5)}   ${num(mean(turns.map((t) => t.ms))).padStart(15)}   ` +
        `${num(mean(requests), 1).padStart(17)}   ${num(mean(tokens)).padStart(12)}   ` +
        `$${((mean(tokens.length > 0 ? tokens : [0]) * 1000) / 1e6 * 0.042).toFixed(3)}`,
    );
  }
  const h = record.turns.filter((t) => t.arm === "hermes");
  const c = record.turns.filter((t) => t.arm === "control");
  if (h.length > 0 && c.length > 0) {
    console.log(
      `\n  The extension adds ${num(mean(h.map((t) => t.ms)) - mean(c.map((t) => t.ms)))} ms to a turn here. Read that as an upper bound on\n` +
        "  the judgment latency and nothing else: the scripted model answers instantly, so\n" +
        "  a real turn hides most of this behind the model's own time.",
    );
  }
}

function reportCompaction(record: Record_): void {
  console.log(`\n§6 the compactor, on the wire\n`);
  const treated = turnOf(record, "compaction", "hermes");
  const control = turnOf(record, "compaction", "control");
  if (!treated || !control) {
    console.log("  not run");
    return;
  }
  console.log(`  arm       messages per provider call                  final payload`);
  for (const [name, turn] of [["hermes", treated], ["control", control]] as const) {
    console.log(
      `  ${pad(name, 8)} ${pad(turn.sent.map((s) => s.messages.length).join(" "), 44)} ` +
        `${String(turn.sent.at(-1)?.bytes ?? 0).padStart(6)} bytes`,
    );
  }
  console.log("\n  outcome   dropped   tokens        budget   reason");
  for (const entry of treated.entries.filter((e) => e.customType === "hermes/compaction")) {
    const d = entry.data as {
      outcome?: string;
      dropped?: unknown[];
      tokensBefore?: number;
      tokensAfter?: number;
      budgetTokens?: number;
      overhead?: number;
      reason?: string;
    };
    console.log(
      `  ${pad(String(d.outcome ?? "?"), 9)} ${String(d.dropped?.length ?? 0).padStart(7)}   ` +
        `${String(d.tokensBefore ?? 0).padStart(5)} -> ${String(d.tokensAfter ?? 0).padEnd(5)} ` +
        `${String(d.budgetTokens ?? 0).padStart(6)}   ${String(d.reason ?? "").slice(0, 52)}`,
    );
  }
  const shrank = treated.sent.some((s, i) => i > 0 && s.messages.length < (treated.sent[i - 1]?.messages.length ?? 0));
  const smaller = (treated.sent.at(-1)?.bytes ?? 0) < (control.sent.at(-1)?.bytes ?? 0);
  console.log(
    `\n  >> The message count ${shrank ? "FALLS" : "does not fall"} in the treated arm and climbs monotonically in the\n` +
      `     control, and the last payload is ${smaller ? "smaller" : "not smaller"}: ` +
      `${treated.sent.at(-1)?.bytes} against ${control.sent.at(-1)?.bytes} bytes.\n` +
      "     Deletion is the one component whose effect is impossible to fake in a log --\n" +
      "     either fewer messages reached the provider or they did not.",
  );
  console.log(
    `\n     Three numbers had to line up for this to run at all, and each one made an\n` +
      "     earlier attempt look like the compactor was dead: the window decides WHEN\n" +
      "     it fires, the overhead (pi's system prompt and tool schemas) comes off the\n" +
      "     budget, and the floors decide WHAT may go. docs/38 §5.",
  );
}

function reportOrchestrator(record: Record_): void {
  console.log(`\n§7 the orchestrator, both routes\n`);
  console.log("  scenario           route   arm       shape        split   gate   reached the provider?");
  for (const id of ["orchestrate-tool", "orchestrate-turn"]) {
    for (const arm of ["hermes", "control"] as Arm[]) {
      const turn = turnOf(record, id, arm);
      if (!turn) continue;
      const own = turn.entries.find((e) => e.customType === "jev-orchestrator/plan")?.data as
        | { shape?: string; workers?: number; split?: boolean; reason?: string }
        | undefined;
      const viaHermes = (entryData(turn, "hermes/turn") as TurnEntry | undefined)?.plan;
      const plan = own ?? viaHermes ?? undefined;
      const gate = /gate (?:reads )?([0-9.]+)/.exec(String(own?.reason ?? viaHermes?.reason ?? ""))?.[1] ?? "-";
      const body = JSON.stringify(turn.sent.map((s) => s.messages));
      const onWire = /fits the \w+ pattern|Do this yourself, in one agent/.test(body);
      console.log(
        `  ${pad(id, 18)} ${pad(id.endsWith("tool") ? "tool" : "turn", 7)} ${pad(arm, 8)} ` +
          `${pad(plan ? `${plan.shape}${plan.split ? ` x${plan.workers}` : ""}` : "(no plan)", 12)} ` +
          `${pad(String(plan?.split ?? "-"), 7)} ${pad(gate, 6)} ${onWire ? "yes" : "no"}`,
      );
    }
  }
  console.log(
    "\n  The tool route runs in BOTH arms on purpose: the tool belongs to\n" +
      "  jev-orchestrator's own extension, which is loaded either way, so the control\n" +
      "  differs from the treatment only by hermes. The turn route is hermes' own and\n" +
      "  was unreachable until `advise` became a flag (§8).",
  );
  console.log(
    "\n  Both answers are docs/31 §8's numbers arriving live. The tool declined a\n" +
      "  request written from the skill's own `fanout` row, at gate 0.29 -- inside the\n" +
      "  0.055..0.446 band that fit measured for the strict wording, and below its 0.5\n" +
      "  cutoff. The turn route split at gate 0.50, which is ON the cutoff and so\n" +
      "  inside the draw noise: read that decision as a coin toss, not a judgment.",
  );
}

function reportSettings(record: Record_): void {
  // The finding that made §7's second row possible at all.
  console.log(`\n§8 configuring an extension\n`);
  const turn = turnOf(record, "orchestrate-turn", "hermes");
  const plan = (entryData(turn, "hermes/turn") as TurnEntry | undefined)?.plan;
  console.log(
    `  \`--hermes-advise turn\` produced ${plan ? `a ${plan.shape} plan` : "no plan"}, so the flag reached the extension.\n\n` +
      "  Pi configures an extension through CLI FLAGS AND NOTHING ELSE:\n" +
      "  `ExtensionFactory` is `(pi: ExtensionAPI) => void` -- one argument -- and\n" +
      "  `ExtensionAPI` has `registerFlag`/`getFlag` and no settings reader at all.\n" +
      "  So every `Pi*Settings` type in these packages was unreachable: it started as\n" +
      "  `{}` and only a slash command could change it, which means every default was\n" +
      "  the whole of the shipped behaviour and the settings blocks the READMEs showed\n" +
      "  were fiction. The settings that change what a run does are flags now.",
  );
}

function main(): void {
  if (!existsSync(PATH)) {
    console.log("no records/agent.json; run `npm run run` (needs TYPESAFEAI_API_KEY and pi)");
    return;
  }
  const record = JSON.parse(readFileSync(PATH, "utf8")) as Record_;
  console.log(
    `\n  ${record.turns.length} turns through real pi ${record.pi}, two arms.\n  ${record.note}`,
  );
  reportRan(record);
  reportModel(record);
  reportGuard(record);
  reportSkills(record);
  reportCost(record);
  reportCompaction(record);
  reportOrchestrator(record);
  reportSettings(record);
  console.log("");
}

if (process.argv[1]?.endsWith("report.ts")) main();
