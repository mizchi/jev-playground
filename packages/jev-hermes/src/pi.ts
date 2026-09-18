/**
 * The resident agent: all five components in one extension, one budget, and
 * one request per turn.
 *
 * Loading `jev-model-router/pi`, `jev-skill-router/pi`, `jev-guard/pi`,
 * `jev-compact/pi` and `jev-orchestrator/pi` separately works and is the
 * right thing for an interactive session. This exists for the other case: an
 * agent that is always on, where the costs that do not matter for an
 * afternoon are the only costs that matter.
 *
 * Three things it does that five separate extensions cannot:
 *
 *   ONE REQUEST PER TURN. The model router, the skill router and the
 *   orchestrator all fire at `before_agent_start` and all judge the same
 *   request. Separately that is three round trips carrying three copies of
 *   the state; here it is one. See `turn.ts` for why docs/29 §4 says this
 *   should be free, and for what about it is still unmeasured.
 *
 *   ONE BUDGET. Five components each politely rate-limiting themselves is
 *   five ceilings and no ceiling. `budget.ts` holds the shared one, and it
 *   is safe to enforce because every component's no-judgment path is the
 *   host's own behaviour.
 *
 *   ONE STATUS LINE AND ONE LEDGER. `/hermes` prints what every component
 *   decided this turn and what the day has cost.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: batch the guard rail into the turn
 * request. The guard sits on the critical path of every tool call, wants one
 * attempt and a hard 2500 ms budget (docs/18 §1(3)), and fires at a moment
 * when the turn request has long since returned. Folding it in would trade
 * the one property that makes it usable for a round trip it cannot save.
 */
import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { Jev, scoreOf } from "@jev-playground/jev-core";
import {
  decide as decideModel,
  detectOverride,
  judgmentOf as modelJudgment,
  type Decision,
  type Judgment as ModelJudgment,
} from "jev-model-router";
import {
  DEFAULT_CONFIG as DEFAULT_SKILL_CONFIG,
  NONE,
  keepTop,
  keyFor as skillKey,
  prescore,
  selectFrom,
  split,
  type Pick,
  type Skill,
  type SkillRouterConfig,
} from "jev-skill-router";
import { guard, type GuardConfig, type GuardResult } from "jev-guard";
import { compact, entriesOf, totalTokens, type CompactConfig, type MessageLike } from "jev-compact";
import {
  DEFAULT_ORCHESTRATOR_CONFIG,
  brief,
  decide as decidePlan,
  gateAtFor,
  judgmentOf as planJudgment,
  type Plan,
} from "jev-orchestrator";
import { Budget, type BudgetConfig } from "./budget.js";
import { HERMES_ROUTER } from "./tiers.js";
import { askTurn, keyGroups, type TurnConfig } from "./turn.js";

const STATUS = "hermes";
const TURN_ENTRY = "hermes/turn";
const GUARD_ENTRY = "hermes/guard";
const NOTIFY_INTERVAL_MS = 60_000;

export interface HermesSettings {
  enabled?: boolean;
  budget?: Partial<BudgetConfig>;
  model?: Partial<TurnConfig["router"]> & { enabled?: boolean };
  skills?: Partial<SkillRouterConfig> & { enabled?: boolean; always?: string[]; never?: string[] };
  guard?: Partial<GuardConfig> & { enabled?: boolean };
  compact?: Partial<CompactConfig> & { enabled?: boolean; startAt?: number };
  orchestrator?: {
    enabled?: boolean;
    framing?: "cost" | "plain";
    advise?: "turn" | "tool";
    /** Null or absent takes the framing's fitted cutoff (docs/31 §8). */
    gateAt?: number | null;
  };
  /** Ask the three per-turn components in one request. See turn.ts. */
  combine?: boolean;
}

interface TurnOutcome {
  model: Decision | null;
  skills: Pick[];
  plan: Plan | null;
  ms: number;
  inputTokens: number;
  error?: string;
}

export default function hermes(pi: ExtensionAPI): void {
  let settings: HermesSettings = {};
  let budget = new Budget();
  let jev: Jev | null = null;
  let jevFailed = false;
  const loadedSkills = new Set<string>();
  let lastTurn: TurnOutcome | null = null;
  let lastGuard: GuardResult | null = null;
  let guardTally = { asked: 0, free: 0, blocked: 0, declined: 0 };
  let compaction: { at: number; keep: Set<string>; dropped: number; before: number; after: number } | null = null;
  let summarisationsAvoided = 0;
  let notifiedAt = 0;

  const on = (): boolean => settings.enabled !== false;
  const enabled = (key: "model" | "skills" | "guard" | "compact" | "orchestrator"): boolean =>
    on() && settings[key]?.enabled !== false;

  function client(): Jev | null {
    if (jev || jevFailed) return jev;
    try {
      jev = new Jev({ timeoutMs: 10_000 });
    } catch {
      // No key. Every component's safe path is the host's own behaviour, so
      // this is a working configuration and not an error -- it just means
      // hermes adds nothing. Said once, below.
      jevFailed = true;
    }
    return jev;
  }

  function complain(ctx: ExtensionContext, message: string): void {
    const now = Date.now();
    if (now - notifiedAt < NOTIFY_INTERVAL_MS) return;
    notifiedAt = now;
    ctx.ui.notify(`hermes: ${message}`, "warning");
  }

  function show(ctx: ExtensionContext): void {
    if (!on()) {
      ctx.ui.setStatus(STATUS, undefined);
      return;
    }
    const parts: string[] = [];
    const m = lastTurn?.model;
    if (m) parts.push(`${m.label}${m.effort ? `/${m.effort}` : ""}`);
    if (lastTurn && lastTurn.skills.length > 0) parts.push(`+${lastTurn.skills.length} skill`);
    if (lastTurn?.plan?.split) parts.push(lastTurn.plan.shape);
    if (guardTally.blocked > 0) parts.push(`${guardTally.blocked} blocked`);
    if (compaction) parts.push(`-${compaction.dropped}e`);
    const t = budget.totals();
    parts.push(`$${t.usd.toFixed(4)}`);
    ctx.ui.setStatus(STATUS, parts.join(" "));
  }

  /**
   * The skills Pi discovered, with this session's routing applied.
   *
   * Read off `before_agent_start`'s `systemPromptOptions`, which is the only
   * place pi 0.85.1 offers them. This originally read `ctx.resources.skills`,
   * which does not exist on `ExtensionContext` at all -- so the catalogue was
   * empty on every turn and the skill router never ran. docs/38 §3 found it
   * by running the extension inside a real pi session and noticing that
   * `skills: []` came back even for a request written to match a catalogued
   * skill exactly.
   *
   * Note `filePath`: pi's `Skill` has no `path`, and the old reader asked for
   * one, so even a populated catalogue would have loaded nothing.
   */
  function catalogue(options: BuildSystemPromptOptions | undefined): Skill[] {
    const always = new Set(settings.skills?.always ?? []);
    const never = new Set(settings.skills?.never ?? []);
    const out: Skill[] = [];
    for (const skill of options?.skills ?? []) {
      if (loadedSkills.has(skill.name)) continue;
      out.push({
        name: skill.name,
        description: skill.description,
        path: skill.filePath,
        invocable: !skill.disableModelInvocation,
        route: always.has(skill.name) ? "always" : never.has(skill.name) ? "never" : "judge",
      });
    }
    return out;
  }

  function runnableModels(ctx: ExtensionContext): string[] {
    try {
      const models = ctx.modelRegistry.getAvailable().filter((m) => ctx.modelRegistry.hasConfiguredAuth(m));
      const scope = ctx.scopedModels;
      // An EMPTY scope means everything, not nothing.
      if (scope.length === 0) return models.map((m) => m.id);
      const ids = new Set(scope.map((s) => s.model.id));
      return models.filter((m) => ids.has(m.id)).map((m) => m.id);
    } catch {
      return [];
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    budget = new Budget(settings.budget ?? {});
    jev = null;
    jevFailed = false;
    loadedSkills.clear();
    lastTurn = null;
    lastGuard = null;
    guardTally = { asked: 0, free: 0, blocked: 0, declined: 0 };
    compaction = null;
    summarisationsAvoided = 0;
    show(ctx);
  });

  // ------------------------------------------------------------ the turn

  pi.on("before_agent_start", async (event, ctx) => {
    if (!on()) return {};
    const router = { ...HERMES_ROUTER, ...settings.model };
    const skillConfig = { ...DEFAULT_SKILL_CONFIG, ...settings.skills };
    const wantsOrchestration = enabled("orchestrator") && (settings.orchestrator?.advise ?? "tool") === "turn";

    // A tier the user named outright outranks judgment and costs nothing to
    // detect. docs/23 §5's rule: what code can decide, code decides.
    const override = enabled("model") ? detectOverride(router, event.prompt) : null;

    // The free half of the skill router, before any request: the catalogue's
    // own routing, then IDF-weighted lexical overlap (docs/29 §5, docs/30 §3).
    const all = enabled("skills") ? catalogue(event.systemPromptOptions) : [];
    const grouped = split(all);
    const shortlist = enabled("skills")
      ? keepTop(
          grouped.judge,
          prescore(grouped.judge, { request: event.prompt }, skillConfig.prefilter),
          skillConfig.shortlist,
        )
      : [];

    const askAnything = (enabled("model") && !override) || shortlist.length > 0 || wantsOrchestration;
    const allowed = budget.allows();
    if (askAnything && !allowed.ok) {
      budget.stopped();
      complain(ctx, `${allowed.why}; running on the host's own defaults until it clears`);
    }

    let outcome: TurnOutcome = { model: null, skills: [], plan: null, ms: 0, inputTokens: 0 };
    const config: TurnConfig = {
      router,
      framing: settings.orchestrator?.framing ?? "cost",
      orchestrate: wantsOrchestration,
    };

    if (askAnything && allowed.ok && client()) {
      const answers = await askTurn(
        {
          task: event.prompt,
          cwd: ctx.cwd,
          contextTokens: (() => {
            try {
              return ctx.getContextUsage()?.tokens ?? 0;
            } catch {
              return 0;
            }
          })(),
          shortlist,
        },
        config,
        { jev: client() ?? undefined, combine: settings.combine },
      );
      const input = answers.response?.usage.input_tokens ?? 0;
      // Counted once per REQUEST the turn actually made, so the ledger
      // shows the difference between the combined and separate paths.
      for (let i = 0; i < Math.max(1, answers.requests); i += 1) {
        budget.spent("turn", i === 0 ? input : 0, i === 0 ? answers.ms : 0, i === 0 && Boolean(answers.error));
      }
      outcome = { model: null, skills: [], plan: null, ms: answers.ms, inputTokens: input, error: answers.error };

      if (answers.response) {
        const res = answers.response;
        // Each component's OWN reader, over the merged answer map. The keys
        // are disjoint (asserted in test.ts), so this is exactly what each
        // would have read from its own request.
        if (enabled("model")) {
          const judgment: ModelJudgment = modelJudgment(res, Boolean(router.effort && router.effort.length >= 2));
          outcome.model = decideModel({
            config: router,
            judgment,
            current: ctx.model?.id ?? router.fallback,
            available: runnableModels(ctx),
            contextTokens: 0,
          });
        }
        if (shortlist.length > 0) {
          const picks: Pick[] = shortlist.map((skill) => {
            const { score, confidence } = scoreOf(res.answers, skillKey(skill.name));
            return { skill, level: score, confidence, why: "judged" as const };
          });
          const noneApply = res.answers[NONE]?.type === "noul" ? res.answers[NONE].noul : Number.NaN;
          outcome.skills = selectFrom(picks, noneApply, skillConfig).load;
        }
        if (wantsOrchestration) {
          // The cutoff comes from the FRAMING (docs/31 §8: the two wordings
          // answer on different scales, so `plain` at 0.5 is the worst of the
          // nine configurations measured). `plan()` does this resolution for
          // its own callers; here `decide()` is called directly, so it is done
          // here -- and explicitly, rather than through a cast that would hide
          // which config field ended up in force.
          outcome.plan = decidePlan(planJudgment(res), {
            ...DEFAULT_ORCHESTRATOR_CONFIG,
            gateAt: gateAtFor(config.framing, settings.orchestrator?.gateAt),
          });
        }
      } else if (enabled("model")) {
        // No judgment: the model router's own no-judgment path, which returns
        // the fallback rung and says so.
        outcome.model = decideModel({
          config: router,
          judgment: null,
          current: ctx.model?.id ?? router.fallback,
          available: runnableModels(ctx),
        });
      }
    } else if (override && enabled("model")) {
      outcome.model = decideModel({
        config: router,
        judgment: null,
        current: ctx.model?.id ?? router.fallback,
        available: runnableModels(ctx),
        override,
      });
    }

    // The catalogue's "always" set loads whatever judgment said, including
    // when judgment never ran. That is the skill router's own rule and it is
    // what makes the no-judgment path equal to the host's own behaviour.
    const always: Pick[] = grouped.always.map((skill) => ({ skill, level: Number.NaN, confidence: Number.NaN, why: "always" }));
    const toLoad = [...always, ...outcome.skills];

    if (outcome.model) await applyModel(ctx, outcome.model);
    for (const pick of toLoad) {
      const text = instructionsFor(pick.skill);
      if (!text) continue;
      loadedSkills.add(pick.skill.name);
      pi.sendMessage(
        {
          customType: "hermes/skill",
          content: [{ type: "text", text }],
          display: false,
          details: { skill: pick.skill.name, level: pick.level, why: pick.why },
        },
        // `steer`, not `nextTurn`. A skill is context for the turn that
        // asked for it, and `before_agent_start` fires before that turn
        // runs -- so `nextTurn` delivers it one turn too late and a
        // single-turn session never sees it at all.
        //
        // This shipped as `nextTurn` and docs/38 §4 caught it by checking
        // the provider's payload for the skill's own text: the router chose
        // `counting-lines` correctly at level 2.98 and the body never
        // reached the model. All three modes were then measured against the
        // wire -- `steer` and `followUp` both arrive, `nextTurn` does not.
        { deliverAs: "steer" },
      );
    }
    outcome.skills = toLoad;
    lastTurn = outcome;
    pi.appendEntry(TURN_ENTRY, {
      prompt: event.prompt.slice(0, 200),
      combined: settings.combine !== false,
      model: outcome.model,
      skills: toLoad.map((p) => ({ name: p.skill.name, level: p.level, why: p.why })),
      plan: outcome.plan,
      inputTokens: outcome.inputTokens,
      ms: outcome.ms,
      error: outcome.error,
      at: Date.now(),
    });
    show(ctx);

    if (outcome.plan?.split) {
      return {
        message: {
          customType: "hermes/orchestration",
          content: brief({ plan: outcome.plan, judgment: null, ms: outcome.ms }),
          display: true,
          details: { plan: outcome.plan },
        },
      };
    }
    return {};
  });

  async function applyModel(ctx: ExtensionContext, decision: Decision): Promise<void> {
    if (!decision.changed) {
      if (decision.effort) {
        // Effort is free to move and does not invalidate the prompt cache,
        // so it is set even on a turn where the model stays put. See tiers.ts:
        // this is the axis docs/36 §5 leaves alone.
        try {
          pi.setThinkingLevel(decision.effort as never);
        } catch {
          /* Pi clamps to what the model supports. */
        }
      }
      return;
    }
    const target = (() => {
      try {
        return ctx.modelRegistry.getAvailable().find((m) => m.id === decision.model);
      } catch {
        return undefined;
      }
    })();
    if (!target) {
      complain(ctx, `${decision.model} is not runnable here; leaving the model alone`);
      return;
    }
    const ok = await pi.setModel(target);
    if (!ok) {
      // A pin that silently did not take is worse than no router at all.
      complain(ctx, `${decision.model} was chosen but its provider is not logged in`);
      return;
    }
    if (decision.effort) {
      try {
        pi.setThinkingLevel(decision.effort as never);
      } catch {
        /* as above */
      }
    }
  }

  function instructionsFor(skill: Skill): string | null {
    if (!skill.path) return null;
    try {
      // Read only for what is being loaded. The catalogue carries names and
      // descriptions; a skill's own text never reaches a request, because it
      // is the host that loads the instructions, not the router.
      const text = readFileSync(skill.path, "utf8");
      return new TextEncoder().encode(text).length > 64_000 ? null : text;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ the guard

  pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult> => {
    if (!enabled("guard")) return {};
    const config: Partial<GuardConfig> = { ...settings.guard, attended: settings.guard?.attended ?? ctx.hasUI };
    let result: GuardResult;
    try {
      // The prefilter runs inside `guard()` and is free, so the budget is
      // consulted AFTER it: a ceiling must not stop read-only calls being
      // waved through, and those are most of a resident agent's traffic.
      result = await guard(
        { toolName: event.toolName, input: event.input as Record<string, unknown>, cwd: ctx.cwd },
        { config, jev: budget.allows().ok ? (client() ?? undefined) : new Jev({ apiKey: "", retries: 0 }) },
      );
    } catch (err) {
      // A gate that throws must not block. docs/18 §1(2).
      complain(ctx, `the guard failed (${String(err).slice(0, 120)}); the call was not gated`);
      return {};
    }
    if (result.free) {
      guardTally.free += 1;
      return {};
    }
    guardTally.asked += 1;
    if (result.usage) budget.spent("guard", result.usage.input, result.ms, Boolean(result.error));
    else if (result.error) budget.spent("guard", 0, result.ms, true);
    lastGuard = result;
    pi.appendEntry(GUARD_ENTRY, {
      tool: event.toolName,
      band: result.band,
      verdict: result.verdict,
      action: result.action,
      reason: result.reason,
      answers: result.answers,
      ms: result.ms,
      at: Date.now(),
    });
    show(ctx);

    if (result.action === "block") {
      guardTally.blocked += 1;
      return { block: true, reason: result.reason };
    }
    if (result.action === "confirm") {
      const allowed = await ctx.ui.confirm("hermes guard", result.reason);
      if (!allowed) {
        guardTally.declined += 1;
        return { block: true, reason: `declined by the user: ${result.reason}` };
      }
    }
    return {};
  });

  // ------------------------------------------------------------ the memory

  pi.on("context", async (event, ctx) => {
    if (!enabled("compact")) return {};
    const messages = event.messages as unknown as MessageLike[];
    if (compaction && compaction.at === messages.length) {
      return { messages: messages.filter((_, i) => compaction?.keep.has(String(i))) as typeof event.messages };
    }
    const usage = (() => {
      try {
        return ctx.getContextUsage();
      } catch {
        return undefined;
      }
    })();
    const window = usage?.contextWindow ?? 0;
    const budgetTokens =
      settings.compact?.budgetTokens ?? (window > 0 ? Math.floor(window * (settings.compact?.startAt ?? 0.7)) : 60_000);
    // A null token count means Pi declined to say; unknown pressure is no
    // pressure, because deleting on a guess is the one thing this must not do.
    if (usage?.tokens == null || usage.tokens <= budgetTokens) return {};
    const allowed = budget.allows();
    if (!allowed.ok) {
      budget.stopped();
      // Deferring hands the problem to Pi's own summarising compaction, which
      // is exactly what would happen without hermes installed.
      return {};
    }
    const entries = entriesOf(messages);
    const result = await compact(
      entries,
      { goal: entries.find((e) => e.role === "user")?.text.slice(0, 2_000) ?? "(no stated goal)", cwd: ctx.cwd },
      { config: { ...settings.compact, budgetTokens }, jev: client() ?? undefined },
    );
    if (result.usage) budget.spent("compact", result.usage.input, result.ms, Boolean(result.error));
    if (result.dropped.length === 0) {
      if (result.outcome === "cannot-fit") complain(ctx, result.reason);
      return {};
    }
    compaction = {
      at: messages.length,
      keep: new Set(result.keep.map((e) => e.id)),
      dropped: result.dropped.length,
      before: result.tokensBefore,
      after: result.tokensAfter,
    };
    pi.appendEntry("hermes/compaction", {
      dropped: result.dropped.map((e) => ({ id: e.id, label: e.label })),
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      ranked: result.ranked.map((r) => ({ id: r.entry.id, level: r.level, confidence: r.confidence })),
      reason: result.reason,
      at: Date.now(),
    });
    show(ctx);
    return { messages: messages.filter((_, i) => compaction?.keep.has(String(i))) as typeof event.messages };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!enabled("compact") || event.reason === "manual") return {};
    if (!compaction) return {};
    const kept = compaction.after;
    const window = (() => {
      try {
        return ctx.getContextUsage()?.contextWindow ?? 0;
      } catch {
        return 0;
      }
    })();
    const budgetTokens =
      settings.compact?.budgetTokens ?? (window > 0 ? Math.floor(window * (settings.compact?.startAt ?? 0.7)) : 60_000);
    if (kept > budgetTokens) return {};
    summarisationsAvoided += 1;
    show(ctx);
    return { cancel: true };
  });

  // ------------------------------------------------------------ reporting

  pi.registerCommand("hermes", {
    description: "What Jev decided this turn, and what the day has cost",
    async handler(args, ctx) {
      const [sub, value] = String(args ?? "").trim().split(/\s+/);
      if (sub === "on" || sub === "off") {
        settings = { ...settings, enabled: sub === "on" };
        show(ctx);
        ctx.ui.notify(`hermes: ${sub}`, "info");
        return;
      }
      if (["model", "skills", "guard", "compact", "orchestrator"].includes(sub) && (value === "on" || value === "off")) {
        const key = sub as "model" | "skills" | "guard" | "compact" | "orchestrator";
        settings = { ...settings, [key]: { ...settings[key], enabled: value === "on" } };
        ctx.ui.notify(`hermes: ${key} ${value}`, "info");
        show(ctx);
        return;
      }
      const t = budget.totals();
      const m = lastTurn?.model;
      const lines = [
        `hermes: ${on() ? "on" : "off"}` +
          (jevFailed ? " -- no API key, so every component is on the host's own defaults" : ""),
        "",
        `model        ${m ? `${m.label}${m.effort ? ` / ${m.effort}` : ""} (${m.reason})` : "not routed"}`,
        `skills       ${lastTurn && lastTurn.skills.length > 0 ? lastTurn.skills.map((p) => p.skill.name).join(", ") : "none loaded"}`,
        `guard        ${guardTally.asked} asked, ${guardTally.free} free, ${guardTally.blocked} blocked, ${guardTally.declined} declined` +
          (lastGuard ? `\n             last: ${lastGuard.reason}` : ""),
        `memory       ${compaction ? `${compaction.dropped} entries deleted, ${compaction.before} -> ${compaction.after} tokens` : "nothing deleted"}` +
          (summarisationsAvoided > 0 ? `, ${summarisationsAvoided} summarisation${summarisationsAvoided === 1 ? "" : "s"} avoided` : ""),
        `orchestrator ${lastTurn?.plan ? `${lastTurn.plan.shape}${lastTurn.plan.split ? ` x${lastTurn.plan.workers}` : ""} -- ${lastTurn.plan.reason}` : "not asked"}`,
        "",
        budget.line(),
      ];
      for (const { component, row, usd } of budget.byComponent()) {
        lines.push(
          `  ${component.padEnd(8)} ${String(row.requests).padStart(5)} requests  ${String(row.inputTokens).padStart(9)} tok  ` +
            `$${usd.toFixed(4)}  ${row.requests > 0 ? `${(row.totalMs / row.requests).toFixed(0)} ms mean` : ""}`,
        );
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  void totalTokens;
}
