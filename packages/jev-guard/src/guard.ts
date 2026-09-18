/**
 * The standalone gate: a tool call in, a verdict out, never throwing.
 *
 * docs/18 §1 settled three properties that matter more than accuracy, because
 * this sits in front of every action an agent takes. Two of them carry over
 * unchanged; the third has to be decided again for a resident agent, and the
 * answer is different.
 *
 *   IT NARROWS, IT DOES NOT WIDEN.  Unchanged. `allow` is not a decision the
 *   gate emits by default -- emitting it would override whatever the host was
 *   going to ask about, and a gate that is wrong once in 24 should not hold
 *   that power. Widening is opt-in (`allowSafe`).
 *
 *   FAILURE FALLS THROUGH.  Unchanged. No key, a dead endpoint, a slow
 *   response, a malformed reply: all of them return `verdict: null`, which
 *   means "no opinion, apply the host's own rules". Failing into `allow`
 *   approves things silently; failing into `deny` bricks the agent on an
 *   outage. docs/18 has seven such paths and tests all seven without a key.
 *
 *   THE LATENCY BUDGET IS FIXED.  Unchanged in principle, and the reason is
 *   worth restating: `experiments/shared/jev.ts` retries because it is
 *   collecting a corpus offline and one 529 costs an hour of batch. Here a
 *   retry only spends the budget that makes the gate usable, so it is one
 *   attempt and then nothing. docs/18 measured median 329 ms / p90 394 ms
 *   end-to-end including node start-up; 2500 ms leaves about six times p90.
 *
 * What is NEW, and what a resident agent forces a decision on: `ask` needs
 * somebody to ask. docs/18's gate ran under a human who was watching, so
 * `ask` handed the call to the host's prompt and the human resolved it. An
 * unattended agent has no such human, and "wait for an answer that will never
 * come" is not one of the options. See `resolve` below.
 */
import { Jev, type Answer } from "@jev-playground/jev-core";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  ALLOW,
  ASK,
  DENY,
  DEFAULT_THRESHOLDS,
  QUESTIONS,
  VERDICT_NAME,
  reasonOf,
  verdictOf,
  type Thresholds,
  type Verdict,
} from "./battery.js";
import { DEFAULT_TRIAGE, commandOf, triage, type Band, type ToolCall, type TriageConfig } from "./prefilter.js";

export interface GuardConfig extends TriageConfig {
  thresholds: Thresholds;
  /** Also emit `allow`, overriding the host's own rules. Off by default. */
  allowSafe: boolean;
  /** Hard budget for the one attempt. */
  timeoutMs: number;
  /** Branches where "affects other people" is the default assumption. */
  protectedBranches: string[];
  /**
   * Is there a human who can answer an `ask`?
   *
   * `true` is docs/18's world: `ask` becomes the host's own confirmation
   * prompt. `false` is a resident agent's, and there `ask` has to collapse
   * to one of the other two -- see `unattendedAsk`.
   */
  attended: boolean;
  /**
   * What `ask` means when nobody is there. `block` or `allow`.
   *
   * The default is `block`, and it is the one place this package is stricter
   * than docs/18's hook rather than the same. The reasoning: `ask` means the
   * gate found something it will not vouch for. With a human present,
   * deferring to them is strictly better than guessing. With nobody present,
   * deferring is not available -- the choice is between doing the thing
   * unsupervised and not doing it -- and a resident agent that quietly ran
   * every `ask` would be a gate in name only.
   *
   * It costs availability, and says so: docs/18's corpus put 5 of 24 commands
   * in `ask`, so a fifth of a shell workload stops and waits for a person.
   * That is the trade a caller is making, which is why it is a setting.
   */
  unattendedAsk: "block" | "allow";
}

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  ...DEFAULT_TRIAGE,
  thresholds: DEFAULT_THRESHOLDS,
  allowSafe: false,
  timeoutMs: 2_500,
  protectedBranches: ["main", "master", "production", "release"],
  attended: true,
  unattendedAsk: "block",
};

export interface GuardResult {
  /** Null means no opinion: the host's own rules apply unchanged. */
  verdict: Verdict | null;
  /** What the host should do, after `attended` and `allowSafe` are applied. */
  action: "block" | "confirm" | "pass";
  band: Band;
  /** True when no request was made. */
  free: boolean;
  reason: string;
  /** The raw answers, for an audit log that can be re-read at other cutoffs. */
  answers?: Record<string, Answer>;
  error?: string;
  ms: number;
  usage?: { input: number; output: number };
}

/**
 * Read the git context without spawning git.
 *
 * docs/01 found the structured state was the single biggest lever: the same
 * `rm -rf` flips from allow to deny on what the path actually is, and a
 * pattern-matching allowlist cannot see that. Reading `.git/HEAD` and
 * `.git/config` keeps it nearly free -- a `git` subprocess would cost more
 * than the API call it is feeding.
 */
export function gitContext(cwd: string): { branch?: string; remote?: string } {
  const out: { branch?: string; remote?: string } = {};
  try {
    const head = readFileSync(join(cwd, ".git", "HEAD"), "utf8").trim();
    out.branch = head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : "(detached)";
  } catch {
    return out;
  }
  try {
    const config = readFileSync(join(cwd, ".git", "config"), "utf8");
    const remote = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/s.exec(config);
    if (remote) out.remote = remote[1];
  } catch {
    /* A worktree, or a repo with no remote. The branch alone is still useful. */
  }
  return out;
}

export interface GuardInput extends ToolCall {
  cwd: string;
  /** The agent's own one-line description of why, when the host has one. */
  intent?: string | null;
  /** The host's permission mode, verbatim. Part of the state, not a rule. */
  permissionMode?: string;
}

/**
 * What one request carries. Exported so a test can assert what is in it
 * without a key -- in particular that nothing is in it that should not be.
 */
export function stateFor(input: GuardInput, config: GuardConfig): Record<string, unknown> {
  const git = gitContext(input.cwd);
  const command = commandOf(input);
  return {
    what: "an action a coding agent is about to take",
    tool: input.toolName,
    ...(command !== null ? { command } : { tool_input: input.input }),
    intent: input.intent ?? null,
    cwd: input.cwd,
    project: basename(input.cwd),
    permission_mode: input.permissionMode ?? "default",
    ...git,
    on_protected_branch: git.branch ? config.protectedBranches.includes(git.branch) : null,
    protected_branches: config.protectedBranches,
  };
}

/**
 * Turn a verdict into what the host should do.
 *
 * Pure and total, and separate from the request on purpose: an `ask` that
 * becomes a block on an unattended agent is a POLICY decision, and policy
 * decisions belong somewhere a test can reach without a key.
 */
export function resolve(verdict: Verdict | null, config: GuardConfig): GuardResult["action"] {
  if (verdict === null) return "pass";
  if (verdict === DENY) return "block";
  if (verdict === ASK) {
    if (config.attended) return "confirm";
    return config.unattendedAsk === "block" ? "block" : "pass";
  }
  // ALLOW. `pass` and not "approve": the gate adds nothing here, and saying
  // `allow` out loud would override the host's own rules (docs/18 §1(1)).
  return "pass";
}

/** The free verdict: what the prefilter alone decided. */
export function freeResult(band: Band, why: string, ms = 0): GuardResult {
  return { verdict: null, action: "pass", band, free: true, reason: why, ms };
}

export async function guard(
  input: GuardInput,
  opts: { config?: Partial<GuardConfig>; jev?: Jev } = {},
): Promise<GuardResult> {
  const config: GuardConfig = { ...DEFAULT_GUARD_CONFIG, ...opts.config };
  const started = Date.now();
  const pass = triage(input, config);
  if (!pass.ask) return freeResult(pass.band, pass.why);

  let jev: Jev;
  try {
    // retries 0 is the whole of docs/18 §1(3). Do not "improve" this.
    jev = opts.jev ?? new Jev({ retries: 0, timeoutMs: config.timeoutMs });
  } catch (err) {
    return { ...freeResult(pass.band, "no judgment available", Date.now() - started), free: false, error: String(err) };
  }

  try {
    const res = await jev.ask(stateFor(input, config), QUESTIONS);
    const verdict = verdictOf(res.answers, config.thresholds);
    if (verdict === null) {
      return {
        ...freeResult(pass.band, "the ordered score was missing from the answer", Date.now() - started),
        free: false,
        answers: res.answers,
      };
    }
    const emitted = !config.allowSafe && verdict === ALLOW ? null : verdict;
    return {
      verdict: emitted,
      action: resolve(emitted, config),
      band: pass.band,
      free: false,
      reason:
        reasonOf(res.answers, verdict, config.thresholds) +
        (pass.band === "uncalibrated" ? ". NOTE: this tool is outside the surface docs/18 measured" : ""),
      answers: res.answers,
      ms: Date.now() - started,
      usage: { input: res.usage.input_tokens, output: res.usage.output_tokens },
    };
  } catch (err) {
    return {
      ...freeResult(pass.band, "judgment failed; the host's own rules apply", Date.now() - started),
      free: false,
      error: String(err).slice(0, 300),
    };
  }
}

export { ALLOW, ASK, DENY, VERDICT_NAME };
export type { Band, Thresholds, ToolCall, TriageConfig, Verdict };
export { DEFAULT_THRESHOLDS, PREDICATES, QUESTIONS, atomicRule, permissionGate, reasonOf, verdictOf } from "./battery.js";
export { DEFAULT_TRIAGE, READ_ONLY, SHELL, bandOf, commandOf, triage } from "./prefilter.js";
