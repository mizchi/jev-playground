/**
 * Run each scenario through a real pi session and record everything.
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/run.ts
 *   npx tsx src/run.ts --scenario guard-destructive
 *
 * What is real: pi itself (0.85.1), its agent loop, its tool execution, its
 * event stream, and every judgment the hermes extension makes. What is fake is
 * the token generation -- `stub.ts` serves a scripted assistant message over
 * the Anthropic Messages API, because this environment has no model
 * credentials (`pi auth check` reports `credentials_not_configured` for
 * anthropic, google and openai).
 *
 * The CONTROL arm matters as much as the treatment: the same turns with the
 * extension absent. Every claim of the form "the extension did X" needs it,
 * or X might just be what pi does anyway (docs/07, jev-playground-moba's docs/12, docs/25 §5).
 *
 * Two operational findings worth keeping, both of which cost real time:
 *
 *   PI EXITS 1 SILENTLY IF ITS STDIN IS A PIPE. `execFile` gives it one, and
 *   the failure has no output at all -- no stdout, no stderr, no session. With
 *   `stdio: ["ignore", ...]` the identical command works. Anything spawning pi
 *   from a harness needs that, and nothing says so.
 *
 *   THE CONTROL ARM WILL ACTUALLY DO THE DANGEROUS THING. That is what makes
 *   it a control. See `sandbox.ts`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SCENARIOS, type Scenario } from "./scenarios.js";
import { assertContained, makeSandbox } from "./sandbox.js";
import { start, type Recorded } from "./stub.js";

const HERE = import.meta.dirname;
const PI = resolve(HERE, "../node_modules/.bin/pi");
const PROVIDER = resolve(HERE, "provider.ts");
const HERMES = resolve(HERE, "../../../packages/jev-hermes/src/pi.ts");
const SKILLS = resolve(HERE, "../skills");
const RECORDS = resolve(HERE, "../records");

export type Arm = "hermes" | "control";

export interface Turn {
  scenario: string;
  arm: Arm;
  /** The window the stub declared, since it decides the compaction threshold. */
  contextWindow: number;
  /** Pi's own event types, in order. The full objects are large. */
  eventTypes: string[];
  /** Tool executions pi actually ran, with whether each was blocked. */
  tools: { name: string; blocked: boolean; detail: string }[];
  /** What pi sent the provider, in order. */
  sent: Recorded[];
  /** The extension's own `appendEntry` payloads. */
  entries: { customType: string; data: Record<string, unknown> }[];
  /** Did the sandbox tree survive? The guard's effect, on disk. */
  treeSurvived: boolean;
  /** Effort levels pi was told to use. */
  thinking: string[];
  exit: number | null;
  ms: number;
  stderr: string;
}

export interface Record_ {
  turns: Turn[];
  pi: string;
  note: string;
}

/** Two tiny skills, so the skill router has a real catalogue to route over. */
function writeSkills(): void {
  const skills: [string, string, string][] = [
    [
      "counting-lines",
      "Count lines, words and characters in files, and report the totals.",
      "Use `wc -l` for lines. Report the number and the filename.",
    ],
    [
      "dashboard-design",
      "Lay out dashboards and choose which metrics belong on one screen.",
      "Ask what decision the dashboard supports before choosing charts.",
    ],
  ];
  for (const [name, description, body] of skills) {
    mkdirSync(resolve(SKILLS, name), { recursive: true });
    writeFileSync(
      resolve(SKILLS, name, "SKILL.md"),
      [`---`, `name: ${name}`, `description: ${description}`, `---`, "", body, ""].join("\n"),
    );
  }
}

async function runOne(scenario: Scenario, arm: Arm): Promise<Turn> {
  const sandbox = makeSandbox(scenario.id);
  const script = scenario.script(sandbox);
  // Before anything is spawned, and for BOTH arms.
  assertContained(script, sandbox, scenario.id);

  const stub = await start(script);
  const cwd = mkdtempSync(resolve(tmpdir(), `pi-${scenario.id}-`));
  for (const [name, body] of Object.entries(scenario.files ?? {})) {
    writeFileSync(resolve(cwd, name), body);
  }
  const sessionDir = mkdtempSync(resolve(tmpdir(), "pi-session-"));
  const args = [
    "-p",
    "--mode",
    "json",
    "--session-dir",
    sessionDir,
    "-e",
    PROVIDER,
    ...(arm === "hermes" ? ["-e", HERMES] : []),
    // A scenario may need another extension -- `orchestrate-tool` needs
    // jev-orchestrator's own, because that is where the tool is registered
    // and hermes does not register it. Loaded in BOTH arms so the control
    // differs only by hermes.
    ...(scenario.extensions ?? []).flatMap((path) => ["-e", resolve(HERE, path)]),
    "--skill",
    SKILLS,
    "--provider",
    "stub",
    "--model",
    "claude-sonnet-5",
    "--approve",
    // Flags a scenario needs. Only meaningful in the hermes arm, since they
    // are hermes' own (docs/38 §6: pi configures an extension through flags
    // and nothing else).
    ...(arm === "hermes" ? (scenario.flags ?? []) : []),
    scenario.prompt,
  ];
  const started = Date.now();
  const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(PI, args, {
      cwd,
      env: {
        ...process.env,
        PI_STUB_URL: stub.url,
        ...(scenario.contextWindow ? { PI_STUB_CONTEXT: String(scenario.contextWindow) } : {}),
      },
      // See the header: a piped stdin makes pi exit 1 with no output at all.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
  const ms = Date.now() - started;

  const events: Record<string, unknown>[] = [];
  for (const line of out.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* pi may print a non-JSON line */
    }
  }
  // The extension's `appendEntry` records arrive as `entry_appended` events.
  // Read from the stream rather than the session file, whose path is
  // project-scoped and not a harness's business to guess.
  const entries: Turn["entries"] = [];
  for (const event of events) {
    if (event.type !== "entry_appended") continue;
    const entry = event.entry as { customType?: string; data?: Record<string, unknown> } | undefined;
    // `hermes/*` and `jev-orchestrator/*`: the second is the standalone
    // extension's own record, which `orchestrate-tool` is about.
    if (entry?.customType?.startsWith("hermes/") || entry?.customType?.startsWith("jev-orchestrator/")) {
      entries.push({ customType: entry.customType, data: entry.data ?? {} });
    }
  }
  const tools: Turn["tools"] = [];
  for (const event of events) {
    if (event.type !== "tool_execution_end") continue;
    const detail = JSON.stringify(event).slice(0, 400);
    tools.push({
      name: String((event.toolName as string) ?? (event.name as string) ?? "?"),
      // A blocked call comes back as an error whose text is the gate's reason.
      blocked: /jev rates this|declined by the user|block/i.test(detail),
      detail,
    });
  }
  const thinking = events
    .filter((e) => e.type === "thinking_level_changed")
    .map((e) => String((e.level as string) ?? (e.thinkingLevel as string) ?? "?"));

  await stub.close();
  return {
    scenario: scenario.id,
    arm,
    contextWindow: scenario.contextWindow ?? 200_000,
    eventTypes: events.map((e) => String(e.type)),
    tools,
    sent: stub.requests,
    entries,
    treeSurvived: existsSync(sandbox.tree),
    thinking,
    exit: out.code,
    ms,
    stderr: out.stderr.slice(0, 1500),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = args.includes("--scenario") ? args[args.indexOf("--scenario") + 1] : "";
  const arms: Arm[] = args.includes("--hermes-only") ? ["hermes"] : ["hermes", "control"];
  writeSkills();
  mkdirSync(RECORDS, { recursive: true });
  const path = resolve(RECORDS, "agent.json");
  const record: Record_ = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record_)
    : {
        turns: [],
        pi: "0.85.1",
        note: "pi is real; the model is a scripted local endpoint (src/stub.ts). No model credentials exist here.",
      };

  for (const scenario of SCENARIOS) {
    if (only && scenario.id !== only) continue;
    for (const arm of arms) {
      record.turns = record.turns.filter((t) => !(t.scenario === scenario.id && t.arm === arm));
      const turn = await runOne(scenario, arm);
      record.turns.push(turn);
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
      console.log(
        `  ${scenario.id.padEnd(18)} ${arm.padEnd(8)} exit=${turn.exit} ${String(turn.ms).padStart(6)} ms  ` +
          `sent=${turn.sent.length} tools=${turn.tools.length} blocked=${turn.tools.filter((t) => t.blocked).length} ` +
          `entries=${turn.entries.length} tree=${turn.treeSurvived ? "kept" : "gone"}` +
          (turn.exit !== 0 ? `  STDERR ${turn.stderr.slice(0, 100)}` : ""),
      );
    }
  }
  console.log(`\n  ${record.turns.length} turns in records/agent.json`);
  void readdirSync;
}

if (process.argv[1]?.endsWith("run.ts")) await main();
