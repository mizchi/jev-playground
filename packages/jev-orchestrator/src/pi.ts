/**
 * The Pi extension. The ONLY file in this package that imports from Pi.
 *
 * Pi's extension surface has no way to SPAWN an agent, so this orchestrator
 * advises and does not dispatch. That is a smaller claim than the name
 * suggests and it is the honest one: what docs/31 measured is the DECISION
 * (which shape fits, and whether to split at all), not the execution. Nothing
 * measured says Jev can decompose work into worker assignments, so this file
 * does not pretend to.
 *
 * Two ways in, for the two occasions the question arises:
 *
 *   before_agent_start   the turn is starting and the shape is not yet
 *                        chosen. The plan is injected as a message so the
 *                        model can act on it.
 *   the `jev_orchestration` tool   the model is mid-turn, has found out what
 *                        the work actually is, and wants to ask. This is
 *                        usually the better moment, and it is the one a
 *                        prompt-only router cannot reach.
 *
 * The second exists because of what docs/36 §5 measured: a router that only
 * sees the opening prompt is routing on the least informative version of the
 * task. There, 21 prompts were one identical string and the across-task
 * spread came in BELOW the draw noise. A tool the agent calls once it has
 * read the code is asking about something that actually differs.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_PLAN_CONFIG, brief, plan, type PlanConfig, type PlanResult } from "./plan.js";

const STATUS = "jev-orchestrator";
const PLAN_ENTRY = "jev-orchestrator/plan";

export interface PiOrchestratorSettings extends Partial<PlanConfig> {
  enabled?: boolean;
  /**
   * `turn` advises at the start of every turn. `tool` only answers when the
   * model asks. `both` does both.
   *
   * The default is `tool`, and the reason is docs/36 §5: the opening prompt
   * is the least informative description of the work that will ever exist,
   * and advice given from it arrives before anyone knows what the task is.
   * A resident agent also starts a great many turns that are not work at
   * all ("what did that error say?"), and advising each one costs a request
   * to conclude `single` -- which is what it was going to do anyway.
   */
  advise?: "turn" | "tool" | "both";
}

export default function jevOrchestrator(pi: ExtensionAPI): void {
  let settings: PiOrchestratorSettings = {};
  let latest: PlanResult | null = null;
  let asked = 0;
  let inputTokens = 0;

  const on = (): boolean => settings.enabled !== false;
  const advise = (): "turn" | "tool" | "both" => settings.advise ?? "tool";

  function show(ctx: ExtensionContext): void {
    if (!on()) {
      ctx.ui.setStatus(STATUS, undefined);
      return;
    }
    const p = latest?.plan;
    ctx.ui.setStatus(
      STATUS,
      p ? `${p.shape}${p.split ? ` x${p.workers}` : ""} (${asked} asked)` : `orchestrator idle (${advise()})`,
    );
  }

  async function ask(request: string, ctx: ExtensionContext, files?: string[]): Promise<PlanResult> {
    const result = await plan({ request, cwd: ctx.cwd, files }, { config: settings });
    asked += 1;
    if (result.usage) inputTokens += result.usage.input;
    latest = result;
    pi.appendEntry(PLAN_ENTRY, {
      request: request.slice(0, 500),
      shape: result.plan.shape,
      workers: result.plan.workers,
      split: result.plan.split,
      reason: result.plan.reason,
      agreement: result.plan.agreement,
      framing: settings.framing ?? DEFAULT_PLAN_CONFIG.framing,
      // The whole `choice` distribution, so a recorded session can be re-read
      // under a different set of unavailable patterns without asking again.
      judgment: result.judgment,
      error: result.error,
      ms: result.ms,
      at: Date.now(),
    });
    show(ctx);
    return result;
  }

  pi.on("session_start", async (_event, ctx) => {
    latest = null;
    asked = 0;
    inputTokens = 0;
    show(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!on() || (advise() !== "turn" && advise() !== "both")) return {};
    const result = await ask(event.prompt, ctx);
    // Say nothing when the answer is "just do it". A note on every turn
    // saying one agent suffices is noise, and a resident agent's turns are
    // overwhelmingly that case.
    if (!result.plan.split) return {};
    return {
      message: {
        customType: "jev-orchestrator",
        content: brief(result),
        display: true,
        details: { plan: result.plan, judgment: result.judgment },
      },
    };
  });

  pi.registerTool({
    name: "jev_orchestration",
    label: "orchestration shape",
    description:
      "Ask whether a piece of work should be split across several agents, and which shape fits. " +
      "Call this once you know what the work actually involves, not at the start of a turn. " +
      "Returns one of eight named patterns, or advice to do it yourself in one agent.",
    promptSnippet: "jev_orchestration: ask whether work should be split across agents, and how",
    parameters: Type.Object({
      request: Type.String({
        description: "The work to judge, described as the person asking for it would describe it.",
      }),
      files: Type.Optional(Type.Array(Type.String(), { description: "Files already known to be involved." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!on()) {
        return {
          content: [{ type: "text", text: "jev-orchestrator is off for this session." }],
          isError: false,
          details: undefined,
        };
      }
      const result = await ask(params.request, ctx, params.files);
      const lines = [brief(result)];
      if (result.judgment) {
        const ranked = Object.entries(result.judgment.probabilities)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([name, p]) => `${name} ${p.toFixed(2)}`)
          .join(", ");
        // The runners-up are included because the top `choice` was 22/22 at
        // telling the eight patterns apart, and where it is uncertain the
        // distribution says so more usefully than the single answer does.
        if (ranked) lines.push(`shapes considered: ${ranked}`);
        if (result.plan.agreement === "disagree") {
          lines.push("note: asked the other way round, the same judgment came back the other way. Treat this as close.");
        }
      }
      if (result.error) lines.push(`judgment unavailable (${result.error}); the advice above is the default, not a decision`);
      // `details` is required by `AgentToolResult` and carries the machine-
      // readable plan beside the sentence, so a host that renders tool
      // results itself does not have to parse the prose back.
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        isError: false,
        details: { plan: result.plan, judgment: result.judgment },
      };
    },
  });

  pi.registerCommand("jev-orchestrator", {
    description: "Show or change how Jev advises on splitting work",
    async handler(args, ctx) {
      const [sub, value] = String(args ?? "").trim().split(/\s+/);
      if (sub === "on" || sub === "off") {
        settings = { ...settings, enabled: sub === "on" };
        show(ctx);
        ctx.ui.notify(`jev-orchestrator: ${sub}`, "info");
        return;
      }
      if (sub === "framing" && (value === "cost" || value === "plain")) {
        settings = { ...settings, framing: value };
        ctx.ui.notify(
          `jev-orchestrator: framing ${value} -- ` +
            (value === "cost"
              ? "strict; catches the documented traps and refuses some work that should be split"
              : "permissive; splits more, including some that should not be"),
          "info",
        );
        return;
      }
      if (sub === "advise" && (value === "turn" || value === "tool" || value === "both")) {
        settings = { ...settings, advise: value };
        ctx.ui.notify(`jev-orchestrator: advising on ${value}`, "info");
        return;
      }
      const config = { ...DEFAULT_PLAN_CONFIG, ...settings };
      ctx.ui.notify(
        [
          `jev-orchestrator: ${on() ? "on" : "off"}, advise on ${advise()}, framing ${config.framing}`,
          `gate at ${config.gateAt}, size floor ${config.minSize}, at most ${config.maxWorkers} workers`,
          config.unavailable.length > 0 ? `this host cannot run: ${config.unavailable.join(", ")}` : "every pattern available",
          latest
            ? `last: ${latest.plan.shape}${latest.plan.split ? ` x${latest.plan.workers}` : ""} -- ${latest.plan.reason}`
            : "nothing judged yet",
          `${asked} asked, ${inputTokens} input tokens, $${((inputTokens / 1e6) * 0.042).toFixed(4)}`,
        ].join("\n"),
        "info",
      );
    },
  });
}
