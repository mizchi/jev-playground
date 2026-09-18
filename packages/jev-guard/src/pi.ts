/**
 * The Pi extension. The ONLY file in this package that imports from Pi.
 *
 * Pi's `tool_call` hook is narrower than Claude Code's `PreToolUse`, and the
 * difference decides the shape of this file. `PreToolUse` can return
 * allow / ask / deny and the host resolves `ask` with the user. Pi's
 * `ToolCallEventResult` is `{ block?, reason?, terminate? }` -- BLOCK OR
 * NOTHING. There is no `ask` to return.
 *
 * So `ask` has to be resolved here, and there are exactly two ways:
 *
 *   with a human   `ctx.ui.confirm(...)`, and block if they decline. This is
 *                  docs/18's behaviour, moved inside the extension.
 *   without one    `ctx.hasUI` is false, so there is nobody to confirm with
 *                  and the config's `unattendedAsk` decides. Default block.
 *
 * `ctx.hasUI` is read per call rather than once, because a session can start
 * headless and later attach.
 *
 * One property this file must preserve: a THROWN error here must not become a
 * block. `guard()` is written not to throw, and the try/catch below is the
 * second line of that defence -- an exception from the gate stopping the
 * agent's work would be exactly the outage-bricks-the-agent failure docs/18
 * §1(2) rules out.
 */
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { DEFAULT_GUARD_CONFIG, guard, type GuardConfig, type GuardResult } from "./guard.js";

const STATUS = "jev-guard";
const LOG_ENTRY = "jev-guard/decision";

export interface PiGuardSettings extends Partial<GuardConfig> {
  enabled?: boolean;
  /** Log every decision to the session, for auditing. On by default: a gate
   *  whose decisions are not recorded cannot be re-read at other cutoffs. */
  audit?: boolean;
}

interface Tally {
  asked: number;
  free: number;
  blocked: number;
  confirmed: number;
  declined: number;
  failed: number;
  inputTokens: number;
  totalMs: number;
}

export default function jevGuard(pi: ExtensionAPI): void {
  let settings: PiGuardSettings = {};
  let tally: Tally = { asked: 0, free: 0, blocked: 0, confirmed: 0, declined: 0, failed: 0, inputTokens: 0, totalMs: 0 };

  const on = (): boolean => settings.enabled !== false;

  function configFor(ctx: ExtensionContext): Partial<GuardConfig> {
    // `hasUI` is the honest source for "is anyone there", and it is asked at
    // decision time rather than at session start so an attached UI counts.
    return { ...settings, attended: settings.attended ?? ctx.hasUI };
  }

  function show(ctx: ExtensionContext): void {
    const spend = (tally.inputTokens / 1e6) * 0.042;
    ctx.ui.setStatus(
      STATUS,
      on()
        ? `guard ${tally.asked} asked / ${tally.free} free` +
            (tally.blocked > 0 ? `, ${tally.blocked} blocked` : "") +
            ` ($${spend.toFixed(4)})`
        : undefined,
    );
  }

  function record(result: GuardResult, event: ToolCallEvent): void {
    if (settings.audit === false) return;
    pi.appendEntry(LOG_ENTRY, {
      tool: event.toolName,
      band: result.band,
      verdict: result.verdict,
      action: result.action,
      reason: result.reason,
      free: result.free,
      ms: result.ms,
      // The raw answers, so a recorded session can be re-read under different
      // cutoffs with no further requests (docs/19 §4).
      answers: result.answers,
      error: result.error,
      at: Date.now(),
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    tally = { asked: 0, free: 0, blocked: 0, confirmed: 0, declined: 0, failed: 0, inputTokens: 0, totalMs: 0 };
    show(ctx);
  });

  pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult> => {
    if (!on()) return {};
    let result: GuardResult;
    try {
      result = await guard(
        {
          toolName: event.toolName,
          input: event.input as Record<string, unknown>,
          cwd: ctx.cwd,
          permissionMode: undefined,
        },
        { config: configFor(ctx) },
      );
    } catch (err) {
      // See the header: a gate that throws must not block. Say so once and
      // let the call through to the host's own rules.
      ctx.ui.notify(`jev-guard: ${String(err).slice(0, 200)} (the call was not gated)`, "warning");
      return {};
    }

    if (result.free) {
      tally.free += 1;
      return {};
    }
    tally.asked += 1;
    tally.totalMs += result.ms;
    if (result.usage) tally.inputTokens += result.usage.input;
    if (result.error) tally.failed += 1;
    record(result, event);
    show(ctx);

    if (result.action === "block") {
      tally.blocked += 1;
      // `terminate` is deliberately NOT set. Pi stops the turn early only when
      // every call in the batch asks it to, and a gate that ends the turn on
      // one refusal takes a decision that belongs to the agent: the right
      // response to "not that way" is usually another way, not stopping.
      return { block: true, reason: result.reason };
    }
    if (result.action === "confirm") {
      tally.confirmed += 1;
      const allowed = await ctx.ui.confirm("jev-guard", `${describe(event)}\n\n${result.reason}`);
      if (!allowed) {
        tally.declined += 1;
        return { block: true, reason: `declined by the user: ${result.reason}` };
      }
      return {};
    }
    return {};
  });

  pi.registerCommand("jev-guard", {
    description: "Show or change the Jev guard rail for this session",
    async handler(args, ctx) {
      const [sub, value] = String(args ?? "").trim().split(/\s+/);
      if (sub === "on" || sub === "off") {
        settings = { ...settings, enabled: sub === "on" };
        show(ctx);
        ctx.ui.notify(`jev-guard: ${sub}`, "info");
        return;
      }
      if (sub === "scope" && (value === "shell" || value === "writes")) {
        settings = { ...settings, scope: value };
        ctx.ui.notify(`jev-guard: scope ${value}`, "info");
        return;
      }
      if (sub === "unattended" && (value === "block" || value === "allow")) {
        settings = { ...settings, unattendedAsk: value };
        ctx.ui.notify(`jev-guard: an unresolved ask now means ${value}`, "info");
        return;
      }
      const config = { ...DEFAULT_GUARD_CONFIG, ...settings };
      const spend = (tally.inputTokens / 1e6) * 0.042;
      ctx.ui.notify(
        [
          `jev-guard: ${on() ? "on" : "off"}, scope ${config.scope}, ` +
            `${ctx.hasUI ? "attended" : `unattended (an ask means ${config.unattendedAsk})`}`,
          `cutoffs: ask at ${config.thresholds.ask}, deny at ${config.thresholds.deny}`,
          `${tally.asked} asked, ${tally.free} free, ${tally.blocked} blocked, ` +
            `${tally.declined} declined, ${tally.failed} failed open`,
          tally.asked > 0
            ? `${(tally.totalMs / tally.asked).toFixed(0)} ms mean, ${tally.inputTokens} input tokens, $${spend.toFixed(4)}`
            : "nothing asked yet",
        ].join("\n"),
        "info",
      );
    },
  });
}

/** A one-line description of the call, for the confirmation dialog. */
function describe(event: ToolCallEvent): string {
  const input = event.input as Record<string, unknown>;
  const command = typeof input.command === "string" ? input.command : null;
  if (command) return command.length > 300 ? `${command.slice(0, 300)}...` : command;
  const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : null;
  return path ? `${event.toolName} ${path}` : event.toolName;
}
