/**
 * The Pi extension. The ONLY file in this package that imports from Pi.
 *
 * Everything that can change a decision lives in `route.ts` and `policy.ts`,
 * which import nothing host-specific and are what `experiments/router`
 * measures. This file is wiring: read the prompt off the event, call
 * `route()`, call `pi.setModel`, show a status line. If a number in docs/36
 * disagrees with what Pi does, the bug is here and not in the policy.
 *
 * Pi gives a model router exactly the handles it needs:
 *
 *   before_agent_start   the assembled prompt, fired once per user turn
 *   ctx.modelRegistry    which models exist and which are authenticated
 *   pi.setModel          set the model for the session
 *   pi.setThinkingLevel  set the effort, clamped by Pi to the model
 *   pi.appendEntry       persist the pin so a reload does not re-ask
 *
 * `setModel` returns false when the provider is not authenticated, which is
 * the one failure this file must not swallow: a pin that silently did not take
 * is worse than no router.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { route, type RouteResult } from "./route.js";
import { DEFAULT_CONFIG, indexOfModel, type RouterConfig } from "./tiers.js";

const STATUS = "jev-model-router";
const PIN_ENTRY = "jev-model-router/pin";
const ERROR_INTERVAL_MS = 60_000;

/** What a session remembers between turns. */
interface Pin {
  model: string;
  label: string;
  effort: string | null;
  reason: string;
  at: number;
}

export interface PiSettings extends Partial<RouterConfig> {
  /**
   * `pin` decides once per session and keeps it. `turn` decides every turn.
   *
   * The two published Jev routers disagree here, and neither measured it:
   * `mejiasd3v/pi-jev-router` pins and only ever SUGGESTS a change,
   * `gargpratyush/jev-router` re-decides every turn. The disagreement is real
   * -- pinning favours prompt-cache reuse and steady behaviour, per-turn
   * routing sends the easy turns of a hard session to a cheap model -- so this
   * is a setting with a measured default rather than a hard-coded choice.
   * docs/36 §4 reports which one wins on the recorded corpus.
   */
  mode?: "pin" | "turn";
  enabled?: boolean;
}

export default function jevModelRouter(pi: ExtensionAPI): void {
  let settings: PiSettings = {};
  let config: RouterConfig = DEFAULT_CONFIG;
  let pin: Pin | null = null;
  let lastErrorAt = 0;
  let warnedNoKey = false;

  const mode = (): "pin" | "turn" => settings.mode ?? "pin";
  const on = (): boolean => settings.enabled !== false;

  function apply(settingsIn: unknown): void {
    settings = (settingsIn && typeof settingsIn === "object" ? settingsIn : {}) as PiSettings;
    config = { ...DEFAULT_CONFIG, ...settings };
  }

  /**
   * Models this session can actually run: available, authenticated, and inside
   * the session's scope if a scope is configured.
   *
   * Two Pi details are load-bearing. `scopedModels` is EMPTY when no scoping
   * is configured -- it means "everything", not "nothing" -- so it can only
   * ever narrow the registry's list, never define it. And `hasConfiguredAuth`
   * is asked here rather than discovered from `setModel` returning false,
   * because by then the router has already told the user which tier it picked.
   */
  function runnable(ctx: ExtensionContext): Model<Api>[] {
    let models: Model<Api>[];
    try {
      models = ctx.modelRegistry.getAvailable().filter((m) => ctx.modelRegistry.hasConfiguredAuth(m));
    } catch {
      return [];
    }
    const scope = ctx.scopedModels;
    if (scope.length === 0) return models;
    const ids = new Set(scope.map((s) => s.model.id));
    return models.filter((m) => ids.has(m.id));
  }

  function report(ctx: ExtensionContext, result: RouteResult): void {
    const { decision } = result;
    const effort = decision.effort ? ` ${decision.effort}` : "";
    ctx.ui.setStatus(STATUS, `jev: ${decision.label}${effort} (${decision.reason})`);
    if (!result.error) return;
    // One complaint a minute. A dead endpoint must not fill the transcript,
    // and the router has already fallen back by the time we are here.
    const now = Date.now();
    if (now - lastErrorAt < ERROR_INTERVAL_MS) return;
    lastErrorAt = now;
    ctx.ui.notify(`jev-model-router: ${result.error}`, "warning");
  }

  async function put(ctx: ExtensionContext, result: RouteResult): Promise<void> {
    const { decision } = result;
    const target = runnable(ctx).find((m) => m.id === decision.model);
    if (!target) {
      // `decide()` already clamped to the list this function produced, so
      // arriving here means the list changed under us -- a /login expiring
      // mid-session, or a scope edit. Leave the model alone and say so.
      ctx.ui.notify(`jev-model-router: ${decision.model} is no longer runnable; leaving the model alone`, "warning");
      return;
    }
    const ok = await pi.setModel(target);
    if (!ok) {
      // Not authenticated. Saying so is the whole point: a pin that did not
      // take would otherwise look like a pin that did.
      ctx.ui.notify(
        `jev-model-router: ${decision.model} chosen but its provider is not logged in; the previous model stays`,
        "warning",
      );
      return;
    }
    if (decision.effort) {
      try {
        pi.setThinkingLevel(decision.effort as never);
      } catch {
        /* Pi clamps and may reject a level this model has no setting for. */
      }
    }
    pin = {
      model: decision.model,
      label: decision.label,
      effort: decision.effort,
      reason: decision.reason,
      at: Date.now(),
    };
    pi.appendEntry(PIN_ENTRY, pin);
    report(ctx, result);
  }

  pi.on("session_start", async (_event, ctx) => {
    apply(undefined);
    pin = null;
    ctx.ui.setStatus(STATUS, on() ? `jev: ${mode()}, not yet routed` : undefined);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!on()) return;
    if (mode() === "pin" && pin) {
      const effort = pin.effort ? ` ${pin.effort}` : "";
      ctx.ui.setStatus(STATUS, `jev: ${pin.label}${effort} (pinned)`);
      return;
    }
    const usage = (() => {
      try {
        return ctx.getContextUsage();
      } catch {
        return undefined;
      }
    })();
    const current = ctx.model?.id;
    let result: RouteResult;
    try {
      result = await route(
        {
          task: event.prompt,
          contextTokens: usage?.tokens ?? 0,
          cwd: ctx.cwd,
        },
        { config: settings, current, available: runnable(ctx).map((m) => m.id) },
      );
    } catch (err) {
      // `route` is written not to throw. If it did anyway, the agent still
      // has to run, so this path exists and says so once.
      if (!warnedNoKey) {
        warnedNoKey = true;
        ctx.ui.notify(`jev-model-router: ${String(err).slice(0, 200)}`, "warning");
      }
      return;
    }
    await put(ctx, result);
  });

  pi.registerCommand("jev-model", {
    description: "Show or change how Jev routes models for this session",
    async handler(args, ctx) {
      const [sub, value] = String(args ?? "").trim().split(/\s+/);
      if (sub === "off" || sub === "on") {
        settings = { ...settings, enabled: sub === "on" };
        ctx.ui.notify(`jev-model-router: ${sub}`, "info");
        ctx.ui.setStatus(STATUS, on() ? `jev: ${mode()}` : undefined);
        return;
      }
      if (sub === "mode" && (value === "pin" || value === "turn")) {
        settings = { ...settings, mode: value };
        ctx.ui.notify(`jev-model-router: mode ${value}`, "info");
        return;
      }
      if (sub === "unpin") {
        pin = null;
        ctx.ui.notify("jev-model-router: pin cleared; the next turn routes afresh", "info");
        return;
      }
      const ladder = config.tiers
        .map((t, i) => `${i === indexOfModel(config, pin?.model ?? "") ? "*" : " "} ${t.label} (${t.model})`)
        .join("\n");
      const cuts = config.cuts ? config.cuts.map((c) => c.toFixed(2)).join(", ") : "none fitted; scores are rounded";
      ctx.ui.notify(
        [
          `jev-model-router: ${on() ? mode() : "off"}`,
          pin ? `pinned to ${pin.label}${pin.effort ? ` ${pin.effort}` : ""} (${pin.reason})` : "not pinned",
          `cuts: ${cuts}`,
          ladder,
        ].join("\n"),
        "info",
      );
    },
  });
}
