/**
 * One task, one sandbox, one real agent run, one mechanical verdict.
 *
 * This is the piece docs/41 §0 and docs/42 §5 both said was missing:
 *
 *   > END-TO-END TASK QUALITY. No model generates tokens behind these
 *   > decisions here. docs/38 ran the real pi agent with a SCRIPTED model, so
 *   > all five components are verified at the wire and none of them is
 *   > verified to help an agent finish work.
 *
 * The reason it was missing was stated as "no model credentials" -- pi gets a
 * 401 from api.anthropic.com. That was the wrong conclusion from a true fact.
 * `claude -p` WORKS in this container (docs/03, 04, 07, 36, 41, 42 all used
 * it), it is a real agent with real tool access, and Claude Code exposes its
 * own hook seams. So the generating model is `claude -p` and jev is wired in
 * through `PreToolUse` -- verified by running it, not assumed.
 *
 * WHAT THE SEAMS TURNED OUT TO BE, checked against the installed CLI rather
 * than guessed:
 *
 *   guard          PreToolUse, deny/ask/allow per tool call     WIRABLE
 *   orchestration  PreToolUse with a matcher on `Task`          WIRABLE
 *   model router   --model at launch, PreModelSwitch mid-run    WIRABLE
 *   skill router   which skills exist in .claude/skills/        WIRABLE
 *   compactor      PreCompact can BLOCK or rewrite the summary
 *                  INSTRUCTIONS, and nothing more               NOT WIRABLE
 *
 * The compactor is the one that does not fit, and the reason is exact: its
 * whole design is "delete, never summarise" (docs/39), and the host's only
 * compaction seam hands a summariser different instructions. Four of five, and
 * the fifth is a statement about the host, not about the component.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const HERE = import.meta.dirname;
const REPO = resolve(HERE, "../../..");
export const SHIPPED_GATE = resolve(REPO, "hooks/jev-permission-gate.mjs");
const GATE = resolve(HERE, "gate.mjs");

export interface Task {
  id: string;
  /** Where the pristine copy lives. */
  dir: string;
  corpus: "easy" | "hard";
}

/** The 53 tasks that already carry a mechanical verdict (docs/32, docs/36). */
export function tasks(which: "easy" | "hard" | "both" = "both"): Task[] {
  const out: Task[] = [];
  const easy = resolve(REPO, "experiments/repair/tasks");
  const hard = resolve(REPO, "experiments/router/tasks-hard");
  if (which !== "hard" && existsSync(easy)) {
    for (const id of readdirSorted(easy)) out.push({ id, dir: resolve(easy, id), corpus: "easy" });
  }
  if (which !== "easy" && existsSync(hard)) {
    for (const id of readdirSorted(hard)) {
      if (id === "index.json") continue;
      out.push({ id, dir: resolve(hard, id), corpus: "hard" });
    }
  }
  return out;
}

function readdirSorted(dir: string): string[] {
  return [...readdirSync(dir)].sort((a, b) => a.localeCompare(b));
}

/**
 * `node --test` in a directory. The verdict, and the only one.
 *
 * Exit code, not a judgment and not a diff. docs/36's labels are exit codes
 * for the same reason: the moment I score this myself, what is being measured
 * is my reading of the agent's work.
 */
export function testsPass(dir: string): boolean {
  const out = spawnSync("node", ["--test"], { cwd: dir, encoding: "utf8", timeout: 120_000 });
  return out.status === 0;
}

export interface ToolCall {
  at: number;
  tool: string;
  command?: string;
  /** "fence" (the harness), "jev" (the gate under test), or "none". */
  by: "fence" | "jev" | "none";
  decision: string;
  reason?: string;
  gateMs?: number;
  gateSaidNothing?: boolean;
}

export interface Run {
  task: string;
  corpus: "easy" | "hard";
  arm: string;
  model: string;
  repeat: number;
  /** THE verdict: `node --test` exit code after the agent stopped. */
  passed: boolean;
  /** The agent edited nothing. Not the same as failing (docs/36's label.ts). */
  untouched: boolean;
  /** Wall clock for the whole agent run. */
  ms: number;
  /** Every tool call, with what the hooks did to it. */
  calls: ToolCall[];
  /** Summed latency the gate added to the critical path. */
  gateMs: number;
  /** Calls the gate stopped, and calls the harness fence stopped. */
  deniedByJev: number;
  deniedByFence: number;
  askedByJev: number;
  /** Non-zero exit or a timeout from the CLI itself, not from the fix failing. */
  error?: string;
}

export interface ArmSpec {
  name: string;
  /** Wire the shipped jev-guard into PreToolUse. */
  guard: boolean;
  /** Which model generates. The model router's decision, when it has one. */
  model: string;
}

/**
 * Run one task, once, under one arm.
 *
 * Everything the agent can reach is a throwaway copy. The prompt is the SAME
 * prompt docs/36's labelling used, verbatim from `experiments/router/src/label.ts`,
 * so a pass here and a pass there mean the same thing.
 */
export async function runOnce(
  task: Task,
  arm: ArmSpec,
  prompt: string,
  repeat: number,
  opts: { timeoutMs?: number } = {},
): Promise<Run> {
  const sandbox = mkdtempSync(resolve(tmpdir(), `jev-finish-${task.id}-`));
  const logPath = resolve(sandbox, ".finish-log.jsonl");
  const started = Date.now();
  const row: Run = {
    task: task.id,
    corpus: task.corpus,
    arm: arm.name,
    model: arm.model,
    repeat,
    passed: false,
    untouched: true,
    ms: 0,
    calls: [],
    gateMs: 0,
    deniedByJev: 0,
    deniedByFence: 0,
    askedByJev: 0,
  };
  try {
    cpSync(task.dir, sandbox, { recursive: true });
    const before = sourceOf(sandbox);
    writeFileSync(logPath, "");

    // The hook is registered for EVERY tool, not only Bash: the ledger has to
    // count Read and Edit too or "how many turns did it take" is a count of
    // shell commands. jev's gate inside it only looks at commands, which is
    // what it ships for.
    mkdirSync(resolve(sandbox, ".claude"), { recursive: true });
    writeFileSync(
      resolve(sandbox, ".claude/settings.json"),
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `node ${GATE}`, timeout: 25 }] }],
          },
        },
        null,
        2,
      )}\n`,
    );

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      FINISH_LOG: logPath,
      FINISH_SANDBOX: sandbox,
      JEV_GATE: arm.guard ? "1" : "0",
      JEV_GATE_BIN: SHIPPED_GATE,
    };

    const res = await claude(prompt, arm.model, sandbox, env, opts.timeoutMs ?? 600_000);
    if (res.error) row.error = res.error;

    row.calls = readLedger(logPath);
    row.gateMs = row.calls.reduce((n, c) => n + (c.gateMs ?? 0), 0);
    row.deniedByJev = row.calls.filter((c) => c.by === "jev" && c.decision === "deny").length;
    row.askedByJev = row.calls.filter((c) => c.by === "jev" && c.decision === "ask").length;
    row.deniedByFence = row.calls.filter((c) => c.by === "fence").length;
    row.untouched = sourceOf(sandbox) === before;
    row.passed = testsPass(sandbox);
  } finally {
    row.ms = Date.now() - started;
    rmSync(sandbox, { recursive: true, force: true });
  }
  return row;
}

function readLedger(path: string): ToolCall[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ToolCall];
      } catch {
        return [];
      }
    });
}

/** Every file under src/, concatenated. For the `untouched` flag. */
function sourceOf(dir: string): string {
  const src = resolve(dir, "src");
  if (!existsSync(src)) return "";
  return readdirSync(src)
    .sort()
    .map((f) => {
      try {
        return readFileSync(resolve(src, f), "utf8");
      } catch {
        return "";
      }
    })
    .join("\0");
}

/**
 * `claude -p` in the sandbox. Three flags, and every one of them was wrong
 * first.
 *
 * 1. `--permission-mode acceptEdits`, NOT `bypassPermissions`.
 *    `bypassPermissions` is a valid choice the CLI accepts and it does not
 *    grant edits here: the agent diagnosed the bug correctly and then replied
 *    "The system is asking for permission to write the file. Please approve" --
 *    with NO hook installed at all, so this was never the gate's doing. The
 *    first version of this harness read that as `passed: false` and would have
 *    reported a 0% baseline as a measurement.
 *
 * 2. THE PROMPT GOES IMMEDIATELY AFTER `-p`, not on stdin. With
 *    `--allowedTools Read Edit Write Bash` trailing, a prompt placed later is
 *    swallowed as one more value of `--allowedTools` and the CLI exits with
 *    "Input must be provided either through stdin or as a prompt argument".
 *    docs/36's `label.ts` got this right; copying its argv order was the fix.
 *
 * 3. `--allowedTools` MUST INCLUDE Bash, and this is where this experiment
 *    departs from docs/36 on purpose. That run allowed `Read Edit Write` and
 *    nothing else, so ITS AGENT COULD NEVER RUN THE TESTS -- it diagnosed and
 *    edited blind. Two consequences. A gate over tool calls has nothing to
 *    gate without Bash, so the guard could not be measured at all; and docs/36's
 *    "52 of 53 tasks pass at haiku" was produced by a strictly weaker agent
 *    than a real one, which is one more reason docs/42 §2.4 concluded the thing
 *    to doubt there was the label.
 */
function claude(
  prompt: string,
  model: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ out: string; error?: string }> {
  return new Promise((done) => {
    const child = spawn(
      "claude",
      [
        "-p",
        prompt,
        "--model",
        model,
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Read",
        "Edit",
        "Write",
        "Bash",
      ],
      { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.stderr.on("data", (d) => {
      err += String(d);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({
        out,
        ...(timedOut ? { error: `timeout after ${timeoutMs} ms` } : {}),
        ...(!timedOut && code !== 0 ? { error: `exit ${code}: ${err.slice(0, 200)}` } : {}),
      });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ out: "", error: String(e).slice(0, 200) });
    });

  });
}
