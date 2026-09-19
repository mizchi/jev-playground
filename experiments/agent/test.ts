/**
 * What has to hold before this harness is run or its record believed.
 *
 *   npm test      # no API key, no pi
 *
 * The first check is the one that matters most. This experiment deleted the
 * repository once: the guard scenario scripted `rm -rf /home` so the guard
 * would have something real to refuse, and the CONTROL arm -- which by
 * definition has no guard -- executed it. Everything was pushed, so the cost
 * was this directory's uncommitted half, but a rail that is not tested is not
 * a rail.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SCENARIOS } from "./src/scenarios.js";
import { assertContained, makeSandbox } from "./src/sandbox.js";
import type { Record_ } from "./src/run.js";

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void): void => {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}: ${(err as Error).message}`);
  }
};
const ok = (cond: boolean, what: string): void => {
  if (!cond) throw new Error(what);
};
const eq = <T,>(a: T, b: T, what = ""): void => {
  if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

const refuses = (command: string, sandbox: ReturnType<typeof makeSandbox>): boolean => {
  try {
    assertContained([{ calls: [{ name: "bash", input: { command } }] }], sandbox, "check");
    return false;
  } catch {
    return true;
  }
};

// --------------------------------------------------------------- the rail

check("the rail refuses the command that destroyed the repository", () => {
  const sandbox = makeSandbox("test");
  // The literal command, first. Then the near misses around it.
  for (const command of [
    "rm -rf /home",
    "rm -rf /home/user/jev-playground",
    "rm -rf /",
    "rm -rf /etc",
    "rm -rf ~",
    "rm -rf ~/work",
    "rm -rf $HOME",
    "rm -rf ${HOME}/x",
    "mv /home/user /tmp/x",
    "dd if=/dev/zero of=/dev/sda",
    "chmod -R 000 /usr",
  ]) {
    ok(refuses(command, sandbox), `the rail ALLOWED: ${command}`);
  }
});

check("the rail refuses a destructive command with no absolute path at all", () => {
  // `rm -rf ./tree` cannot be shown to be inside the sandbox from the text,
  // so it is refused. Being conservative here costs a scenario author one
  // explicit path and costs nothing else.
  const sandbox = makeSandbox("test");
  for (const command of ["rm -rf ./tree", "rm -rf tree", "rm -rf *"]) {
    ok(refuses(command, sandbox), `the rail allowed an unprovable target: ${command}`);
  }
});

check("the rail refuses anything outbound", () => {
  const sandbox = makeSandbox("test");
  for (const command of ["curl http://example.com", "git push origin main", "npm publish", "ssh host rm -rf /"]) {
    ok(refuses(command, sandbox), `the rail allowed an outbound command: ${command}`);
  }
});

check("the rail allows the sandbox's own tree", () => {
  // And it must, or the guard scenario has nothing to be destructive about.
  const sandbox = makeSandbox("test");
  ok(!refuses(`rm -rf ${sandbox.tree}`, sandbox), "the rail refused the sandbox's own tree");
  ok(!refuses("wc -l keep.txt", sandbox), "the rail refused a harmless command");
  ok(!refuses("ls -la", sandbox), "the rail refused ls");
});

check("every scenario's script passes the rail", () => {
  // The check `run.ts` makes before spawning, made here too so a bad scenario
  // fails in CI rather than at the moment it would do damage.
  for (const scenario of SCENARIOS) {
    const sandbox = makeSandbox(scenario.id);
    assertContained(scenario.script(sandbox), sandbox, scenario.id);
  }
});

check("the sandbox tree really exists, so 'gone' means something", () => {
  const sandbox = makeSandbox("test");
  ok(existsSync(sandbox.tree), "the sandbox tree was not created");
  ok(existsSync(resolve(sandbox.tree, "one.txt")), "the sandbox tree has no files in it");
});

// ----------------------------------------------------------- the scenarios

check("scenarios are distinct and each says what it is for", () => {
  eq(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length, "duplicate scenario id: ");
  for (const s of SCENARIOS) {
    ok(s.why.length > 20, `${s.id} does not say why it exists`);
    ok(s.checks.length > 0, `${s.id} names nothing to check`);
  }
});

// -------------------------------------------------------------- the record

check("the record, if present, has both arms for every scenario", () => {
  const path = resolve(import.meta.dirname, "records/agent.json");
  if (!existsSync(path)) return;
  const record = JSON.parse(readFileSync(path, "utf8")) as Record_;
  for (const scenario of new Set(record.turns.map((t) => t.scenario))) {
    for (const arm of ["hermes", "control"] as const) {
      ok(
        record.turns.some((t) => t.scenario === scenario && t.arm === arm),
        `${scenario} has no ${arm} arm, so its rows cannot be read as a comparison`,
      );
    }
  }
});

check("the guard's effect is in the record, in both directions", () => {
  const path = resolve(import.meta.dirname, "records/agent.json");
  if (!existsSync(path)) return;
  const record = JSON.parse(readFileSync(path, "utf8")) as Record_;
  const treated = record.turns.find((t) => t.scenario === "guard-destructive" && t.arm === "hermes");
  const control = record.turns.find((t) => t.scenario === "guard-destructive" && t.arm === "control");
  if (!treated || !control) return;
  // The whole claim of §3, as two booleans.
  eq(treated.treeSurvived, true, "the guard did not save the tree: ");
  eq(control.treeSurvived, false, "the control arm did not delete the tree, so it is not a control: ");
  ok(treated.tools.some((x) => x.blocked), "no tool call was recorded as blocked under the extension");
  ok(!control.tools.some((x) => x.blocked), "the control arm blocked something without an extension");
});

check("read-only tool calls cost no judgment requests", () => {
  const path = resolve(import.meta.dirname, "records/agent.json");
  if (!existsSync(path)) return;
  const record = JSON.parse(readFileSync(path, "utf8")) as Record_;
  const free = record.turns.find((t) => t.scenario === "read-only-free" && t.arm === "hermes");
  if (!free) return;
  ok(free.tools.length >= 3, `only ${free.tools.length} tool calls, so the check proves little`);
  eq(
    free.tools.filter((x) => x.blocked).length,
    0,
    "a read-only call was blocked: ",
  );
  eq(
    free.entries.filter((e) => e.customType === "hermes/guard").length,
    0,
    "a read-only call cost a guard request: ",
  );
});

check("every turn exited 0 in both arms", () => {
  const path = resolve(import.meta.dirname, "records/agent.json");
  if (!existsSync(path)) return;
  const record = JSON.parse(readFileSync(path, "utf8")) as Record_;
  for (const turn of record.turns) {
    eq(turn.exit, 0, `${turn.scenario}/${turn.arm} exited ${turn.exit}: `);
  }
});

check("the skill router's loads reach the provider", () => {
  // The §4 regression. `deliverAs: "nextTurn"` delivered a chosen skill one
  // turn late, and the first version of this check matched "wc -l" -- which
  // the scripted bash command also contains -- so it reported success while
  // nothing had arrived.
  const path = resolve(import.meta.dirname, "records/agent.json");
  if (!existsSync(path)) return;
  const record = JSON.parse(readFileSync(path, "utf8")) as Record_;
  const distinctive: Record<string, string> = {
    "counting-lines": "Report the number and the filename",
    "dashboard-design": "what decision the dashboard supports",
  };
  let checked = 0;
  for (const turn of record.turns.filter((t) => t.arm === "hermes")) {
    const data = turn.entries.find((e) => e.customType === "hermes/turn")?.data as
      | { skills?: { name: string }[] }
      | undefined;
    for (const skill of data?.skills ?? []) {
      const needle = distinctive[skill.name];
      if (!needle) continue;
      checked += 1;
      ok(
        turn.sent.some((req) => JSON.stringify(req.messages).includes(needle)),
        `${turn.scenario}: ${skill.name} was loaded but its body never reached the provider`,
      );
    }
  }
  ok(checked > 0, "no scenario loaded a skill, so this check proves nothing");
});

const record = (): Record_ | null => {
  const path = resolve(import.meta.dirname, "records/agent.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Record_;
};
const turn = (scenario: string, arm: "hermes" | "control"): Record_["turns"][number] | undefined =>
  record()?.turns.find((t) => t.scenario === scenario && t.arm === arm);

check("the compactor deleted entries and the payload got smaller", () => {
  // §6's claim, at the wire rather than in the extension's own log. The
  // extension logging `outcome: "deleted"` is necessary and not sufficient:
  // pi rebuilds the payload from its own session, so what matters is that
  // fewer messages left the process.
  const treated = turn("compaction", "hermes");
  const control = turn("compaction", "control");
  if (!treated || !control) return;
  const runs = treated.entries.filter((e) => e.customType === "hermes/compaction");
  ok(runs.length > 0, "the compactor never fired, so the scenario does not exercise it");
  const deleted = runs.filter((e) => e.data.outcome === "deleted");
  ok(deleted.length > 0, `${runs.length} compaction runs and none deleted anything`);
  for (const run of deleted) {
    const dropped = (run.data.dropped ?? []) as unknown[];
    ok(dropped.length > 0, "a run reported `deleted` with an empty drop list");
    ok(
      Number(run.data.tokensAfter) < Number(run.data.tokensBefore),
      `a deleted run left the total unchanged at ${run.data.tokensAfter} tokens`,
    );
    // `deleted` does NOT promise the budget was met: the compactor will not
    // delete an entry judgment called live just to hit a number, so a run can
    // delete all it is allowed to and still be over. It has to SAY so -- an
    // agent reading its own compaction log needs to know the budget is still
    // exceeded, and this is the one number a caller might act on.
    if (Number(run.data.tokensAfter) > Number(run.data.budgetTokens)) {
      ok(
        String(run.data.reason ?? "").includes("still over"),
        `a run stayed over budget without saying so: ${String(run.data.reason)}`,
      );
    }
  }
  const last = <T extends { messages: unknown[] }>(reqs: T[]): T | undefined => reqs[reqs.length - 1];
  const t = last(treated.sent);
  const c = last(control.sent);
  if (!t || !c) return;
  ok(
    t.messages.length < c.messages.length,
    `the final payload carried ${t.messages.length} messages and the control's ${c.messages.length}, so nothing was removed on the wire`,
  );
  eq(
    control.entries.filter((e) => e.customType === "hermes/compaction").length,
    0,
    "the control arm compacted without the extension: ",
  );
});

check("what the compactor sent is still a valid transcript", () => {
  // The failure no score can compensate for. An orphaned `tool_use` is
  // rejected by the provider outright, and a transcript that lost its goal
  // cannot be recovered from what is left -- so both are checked on the
  // payload that actually went out, not on the entry list the extension held.
  const treated = turn("compaction", "hermes");
  if (!treated) return;
  for (const req of treated.sent) {
    const uses = new Set<string>();
    const results = new Set<string>();
    for (const message of req.messages as { role: string; content: unknown }[]) {
      for (const part of (Array.isArray(message.content) ? message.content : []) as Record<string, string>[]) {
        if (part.type === "tool_use") uses.add(part.id);
        if (part.type === "tool_result") results.add(part.tool_use_id);
      }
    }
    for (const id of uses) ok(results.has(id), `a tool_use reached the provider with no result: ${id}`);
    for (const id of results) ok(uses.has(id), `a tool_result reached the provider with no call: ${id}`);
    const first = (req.messages as { role: string }[])[0];
    ok(first?.role === "user", "the first message is no longer the user's, so the goal may have been dropped");
  }
});

check("every compaction run says what it did, including the runs that deleted nothing", () => {
  // A no-deletion path that writes no entry makes a headless run look
  // identical to one where the compactor never fired at all -- which is how
  // the pair-level bug survived a full sweep (docs/38 §5).
  const treated = turn("compaction", "hermes");
  if (!treated) return;
  const outcomes = new Set(["fits", "deleted", "cannot-fit", "nothing-spare", "deferred"]);
  for (const run of treated.entries.filter((e) => e.customType === "hermes/compaction")) {
    ok(outcomes.has(String(run.data.outcome)), `unknown outcome ${String(run.data.outcome)}`);
    if (run.data.outcome === "deleted") continue;
    ok(String(run.data.reason ?? "").length > 20, `a ${String(run.data.outcome)} run gave no reason`);
  }
});

check("the orchestrator's default route records a plan, with or without hermes", () => {
  // The tool lives in jev-orchestrator's own extension, loaded in BOTH arms,
  // so a plan in both is the expected result and its absence in either is
  // the bug. The two arms judge separately, so the shapes may differ.
  for (const arm of ["hermes", "control"] as const) {
    const t = turn("orchestrate-tool", arm);
    if (!t) continue;
    const plan = t.entries.find((e) => e.customType === "jev-orchestrator/plan");
    ok(!!plan, `${arm}: the tool was called and no plan was recorded`);
    ok(typeof plan?.data.shape === "string", `${arm}: the plan has no shape`);
    ok(Number(plan?.data.workers) >= 1, `${arm}: the plan asks for ${String(plan?.data.workers)} workers`);
    ok(String(plan?.data.reason ?? "").length > 10, `${arm}: the plan does not say why`);
  }
});

check("the orchestrator's turn route is hermes' alone and reaches the provider", () => {
  // `--hermes-advise turn`: the only route that judges the opening prompt,
  // and the one that was unreachable until `advise` became a flag. Its
  // effect is a message, so the control arm having none is half the claim.
  const treated = turn("orchestrate-turn", "hermes");
  const control = turn("orchestrate-turn", "control");
  if (!treated || !control) return;
  const plan = (treated.entries.find((e) => e.customType === "hermes/turn")?.data as { plan?: Record<string, unknown> })
    ?.plan;
  ok(!!plan, "the turn route judged no plan");
  ok(plan?.split === true, `the plan did not split (${JSON.stringify(plan?.shape)}), so no brief would be sent`);
  const sent = JSON.stringify(treated.sent[0]?.messages ?? []);
  ok(sent.includes(String(plan?.shape)), `the brief never reached the provider; it sent ${sent.slice(0, 200)}`);
  ok(
    (treated.sent[0]?.messages.length ?? 0) > (control.sent[0]?.messages.length ?? 0),
    "the treated payload has no more messages than the control's, so the brief was not injected",
  );
  eq(
    control.entries.filter((e) => e.customType === "hermes/turn").length,
    0,
    "the control arm recorded a turn without the extension: ",
  );
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
