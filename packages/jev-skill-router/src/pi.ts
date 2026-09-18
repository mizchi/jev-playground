/**
 * The Pi extension. The ONLY file in this package that imports from Pi.
 *
 * Pi hands a skill router what it needs and one thing it must respect:
 *
 *   before_agent_start   the prompt, once per user turn
 *   ctx.resources        the discovered skills, with their trust settings
 *   pi.sendMessage       inject the chosen instructions into the turn
 *
 * The thing it must respect is `disable-model-invocation`. A skill marked
 * that way is one the user has said the model may not pull in on its own, and
 * a router that loads it anyway has quietly overridden a permission decision.
 * It is filtered in `catalog.split()` as `blocked`, before the prefilter, so
 * it cannot be loaded even by a bug in the policy.
 *
 * Instructions are read from disk locally and never sent back to Jev. What
 * leaves the machine is the names and descriptions of eligible skills plus
 * the request text -- which the README states, because it is the user's to
 * know.
 */
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { route, type Skill, type SkillDecision, type SkillRouterConfig } from "./route.js";

const STATUS = "jev-skill-router";
const LOADED_ENTRY = "jev-skill-router/loaded";
const ERROR_INTERVAL_MS = 60_000;
/** A ceiling on injected text, so one enormous skill cannot eat the turn. */
const MAX_INSTRUCTION_BYTES = 50_000;

export interface PiSkillSettings extends Partial<SkillRouterConfig> {
  enabled?: boolean;
  /** Skills to always load, by name, whatever the catalogue says. */
  always?: string[];
  /** Skills never to load, by name. */
  never?: string[];
}

interface Discovered {
  name: string;
  description: string;
  path?: string;
  invocable: boolean;
}

export default function jevSkillRouter(pi: ExtensionAPI): void {
  let settings: PiSkillSettings = {};
  /** Names already in this session's context; loading twice is waste. */
  const loaded = new Set<string>();
  let lastErrorAt = 0;
  let last: SkillDecision | null = null;

  const on = (): boolean => settings.enabled !== false;

  /**
   * Pi's discovered skills, with the host's own trust settings carried over.
   *
   * Read through a narrow shape rather than Pi's own type so a change in the
   * resource model shows up here as one compile error instead of silently
   * dropping the `invocable` flag.
   */
  function discover(ctx: ExtensionContext): Discovered[] {
    const resources = (ctx as unknown as { resources?: { skills?: unknown[] } }).resources;
    const raw = Array.isArray(resources?.skills) ? resources.skills : [];
    const out: Discovered[] = [];
    for (const item of raw) {
      const s = item as Record<string, unknown>;
      const name = typeof s.name === "string" ? s.name : undefined;
      if (!name) continue;
      out.push({
        name,
        description: typeof s.description === "string" ? s.description : "",
        path: typeof s.path === "string" ? s.path : undefined,
        // Default to NOT invocable when the flag is missing. The safe default
        // for a permission flag is the restrictive one: a host that stops
        // reporting it should cost the router its automation, not cost the
        // user their setting.
        invocable: s.disableModelInvocation === false || s.modelInvocable === true,
      });
    }
    return out;
  }

  function catalogue(ctx: ExtensionContext): Skill[] {
    const always = new Set(settings.always ?? []);
    const never = new Set(settings.never ?? []);
    return discover(ctx).map((d) => ({
      name: d.name,
      description: d.description,
      path: d.path,
      invocable: d.invocable,
      route: always.has(d.name) ? "always" : never.has(d.name) ? "never" : "judge",
    }));
  }

  function instructionsFor(skill: Skill): string | null {
    if (!skill.path) return null;
    try {
      const text = readFileSync(skill.path, "utf8");
      if (new TextEncoder().encode(text).length > MAX_INSTRUCTION_BYTES) return null;
      return text;
    } catch {
      return null;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    loaded.clear();
    ctx.ui.setStatus(STATUS, on() ? "skills: none loaded" : undefined);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!on()) return;
    const skills = catalogue(ctx).filter((s) => !loaded.has(s.name));
    if (skills.length === 0) return;

    let decision: SkillDecision;
    try {
      decision = await route(
        { request: event.prompt, notes: ctx.cwd ? `working directory: ${ctx.cwd}` : undefined },
        skills,
        { config: settings },
      );
    } catch (err) {
      const now = Date.now();
      if (now - lastErrorAt > ERROR_INTERVAL_MS) {
        lastErrorAt = now;
        ctx.ui.notify(`jev-skill-router: ${String(err).slice(0, 200)}`, "warning");
      }
      return;
    }
    last = decision;
    if (decision.error && Date.now() - lastErrorAt > ERROR_INTERVAL_MS) {
      lastErrorAt = Date.now();
      ctx.ui.notify(`jev-skill-router: ${decision.error}`, "warning");
    }

    const injected: string[] = [];
    for (const pick of decision.load) {
      const text = instructionsFor(pick.skill);
      if (!text) continue;
      loaded.add(pick.skill.name);
      injected.push(pick.skill.name);
      pi.sendMessage(
        {
          customType: "jev-skill-router/skill",
          content: [{ type: "text", text }],
          // Not shown in the transcript: the user asked a question, they did
          // not ask to read a skill file. `/jev-skills` prints what was loaded.
          display: false,
          details: { skill: pick.skill.name, path: pick.skill.path, level: pick.level, why: pick.why },
        },
        { deliverAs: "nextTurn" },
      );
    }
    if (injected.length > 0) pi.appendEntry(LOADED_ENTRY, { turn: event.prompt.slice(0, 120), injected });
    ctx.ui.setStatus(
      STATUS,
      injected.length > 0 ? `skills: +${injected.join(", ")}` : `skills: none (${decision.reason})`,
    );
  });

  pi.registerCommand("jev-skills", {
    description: "Show what the skill router loaded and why",
    async handler(args, ctx) {
      const sub = String(args ?? "").trim();
      if (sub === "on" || sub === "off") {
        settings = { ...settings, enabled: sub === "on" };
        ctx.ui.notify(`jev-skill-router: ${sub}`, "info");
        return;
      }
      if (!last) {
        ctx.ui.notify("jev-skill-router: nothing routed yet", "info");
        return;
      }
      const lines = [
        `jev-skill-router: ${last.reason}${last.error ? ` (${last.error})` : ""}`,
        `none-apply ${Number.isFinite(last.noneApply) ? last.noneApply.toFixed(2) : "n/a"}`,
        ...last.load.map((p) => `  load  ${p.skill.name}  ${p.level.toFixed(2)}  ${p.why}`),
        ...last.considered.slice(0, 8).map((p) => `  skip  ${p.skill.name}  ${p.level.toFixed(2)}`),
        `  dropped by prefilter: ${last.droppedBy.prefilter.length}`,
        `  not model-invocable: ${last.droppedBy.blocked.length}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
