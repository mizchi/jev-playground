/**
 * Which tool calls are worth asking about. Free, static, and first.
 *
 * docs/33 §1's lesson, applied to a gate: measure what the free features give
 * you before paying for judgment. Here the free feature is the tool's name.
 * A `read` cannot destroy anything, so a gate in front of it buys nothing and
 * costs a round trip on the agent's critical path -- and a resident agent
 * makes far more read calls than write ones, so this is most of the bill.
 *
 * The second reason is docs/18 §1's rule that a gate should not be applied to
 * tools it was never calibrated on. docs/18's 94.4% is a number about SHELL
 * COMMANDS. The same battery pointed at a `write` is a reasonable guess and
 * an unmeasured one, so `triage` reports which of the two a call is, and the
 * verdict carries that label through to the audit line. A caller who wants
 * only the measured surface sets `scope: "shell"`.
 */

/** What the free pass decided, before any request. */
export type Band =
  /** Cannot alter anything outside the agent's own context. Never asked. */
  | "read-only"
  /** A shell command: the surface docs/18 measured at 94.4%. */
  | "shell"
  /** Can alter the working tree or the outside world, and is NOT what the
   *  battery was calibrated on. Asked, and labelled. */
  | "uncalibrated";

export interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

/**
 * Pi's built-in read-only tools, by the names `ToolCallEvent` uses.
 *
 * `read`, `grep`, `find` and `ls` are the four that cannot write. They are
 * listed rather than inferred because a name-pattern rule ("anything called
 * read*") is exactly the kind of thing that silently widens when a new tool
 * appears. An unknown tool is never read-only here.
 */
export const READ_ONLY = new Set(["read", "grep", "find", "ls"]);

/** The shell tools, which is what the battery's numbers are about. */
export const SHELL = new Set(["bash", "powershell"]);

/**
 * Where the command lives in each shell tool's input.
 *
 * Pi's `BashToolInput` and `PowerShellToolInput` both carry `command`. A
 * custom tool that also calls itself `bash` and does not is the reason this
 * reads defensively rather than casting.
 */
export function commandOf(call: ToolCall): string | null {
  const raw = call.input?.command;
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

export function bandOf(call: ToolCall): Band {
  if (READ_ONLY.has(call.toolName)) return "read-only";
  if (SHELL.has(call.toolName) && commandOf(call) !== null) return "shell";
  return "uncalibrated";
}

export interface TriageConfig {
  /**
   * `shell` asks only about shell commands -- the measured surface.
   * `writes` also asks about anything that can alter the world.
   *
   * The default is `writes`, because the alternative is a gate that watches
   * `bash rm` and not `write`, which is not a safety property anyone wants.
   * It is a deliberate trade of the 94.4% provenance for coverage, and the
   * verdict says which band it came from so the two never get conflated.
   */
  scope: "shell" | "writes";
  /**
   * Tool names never asked about, beyond the read-only set. For a tool the
   * caller knows is safe and calls constantly.
   */
  skip: string[];
  /**
   * Tool names always asked about even if they look read-only. An escape
   * hatch for a custom tool whose name says nothing.
   */
  always: string[];
}

export const DEFAULT_TRIAGE: TriageConfig = { scope: "writes", skip: [], always: [] };

export interface Triage {
  band: Band;
  /** False when no request will be made. */
  ask: boolean;
  why: string;
}

export function triage(call: ToolCall, config: TriageConfig = DEFAULT_TRIAGE): Triage {
  const band = bandOf(call);
  if (config.always.includes(call.toolName)) return { band, ask: true, why: "listed in always" };
  if (config.skip.includes(call.toolName)) return { band, ask: false, why: "listed in skip" };
  if (band === "read-only") return { band, ask: false, why: "read-only tool" };
  if (band === "uncalibrated" && config.scope === "shell") {
    return { band, ask: false, why: "outside the calibrated shell scope" };
  }
  return { band, ask: true, why: band === "shell" ? "shell command" : "can alter the working tree" };
}
