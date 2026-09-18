/**
 * The agent whose skill choice is being measured.
 *
 * It sees exactly what the cookbook's agent sees: the roster as name plus
 * TRUNCATED description, and a `skill_view(name)` tool it must name exactly.
 * The assisted arm gets one extra line appended after the roster — the
 * `<skill_relevance>` block — and nothing else changes.
 *
 * Driven through the `claude` CLI headless, so there is no API key needed.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SkillEntry } from "./roster.js";

const run = promisify(execFile);

export interface AgentChoice {
  /** The skill the agent decided to load, or null for none. */
  loaded: string | null;
  /** Raw reply, kept for the cases worth reading. */
  raw: string;
  ms: number;
  /** The agent named something that is not in the roster. */
  invalid: boolean;
}

function rosterText(roster: SkillEntry[]): string {
  return roster.map((s) => `- ${s.name}: ${s.index_desc}`).join("\n");
}

/**
 * One turn. `suggestion` is the cookbook's block, or undefined for the
 * unassisted baseline.
 */
export async function decide(
  roster: SkillEntry[],
  request: string,
  model: string,
  suggestion?: string,
): Promise<AgentChoice> {
  const prompt = `
You are a coding agent. Before answering the user you may load ONE skill from
your library — a documented procedure that helps with a specific kind of task.
Loading the wrong skill wastes context and misleads you, so load one only when
it genuinely fits.

Your skill library:

${rosterText(roster)}
${suggestion ? `\n${suggestion}\n` : ""}
The user's request:

${request}

Which skill do you load? Reply with ONLY the exact skill name from the list, or
the single word NONE if no skill fits. No explanation.
`.trim();
  const t0 = Date.now();
  let raw = "";
  try {
    const res = await run("claude", ["-p", "--model", model, prompt], {
      maxBuffer: 1 << 22,
      timeout: 180_000,
    });
    raw = res.stdout.trim();
  } catch (err) {
    return { loaded: null, raw: `ERROR ${String(err).slice(0, 160)}`, ms: Date.now() - t0, invalid: true };
  }
  const ms = Date.now() - t0;
  const valid = new Set(roster.map((s) => s.name));
  // The reply is meant to be a bare name; be forgiving about stray prose but
  // never invent a match.
  const cleaned = raw.replace(/[`"'*]/g, "").trim();
  if (/^none\b/i.test(cleaned)) return { loaded: null, raw, ms, invalid: false };
  if (valid.has(cleaned)) return { loaded: cleaned, raw, ms, invalid: false };
  // Look for any roster name appearing in the reply, longest first so
  // `frontend-review-ci` wins over a shorter prefix.
  const hit = [...valid]
    .sort((a, b) => b.length - a.length)
    .find((n) => cleaned.includes(n));
  if (hit) return { loaded: hit, raw, ms, invalid: false };
  if (/\bnone\b/i.test(cleaned)) return { loaded: null, raw, ms, invalid: false };
  return { loaded: null, raw, ms, invalid: true };
}
