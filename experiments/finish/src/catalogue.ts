/**
 * The skill catalogue the routed arm chooses from, and it is not mine.
 *
 * 461 entries harvested from nine real repositories by
 * `experiments/skill-pick` (`corpus/roster.json`), each at a pinned revision,
 * with name and description as their authors wrote them. 300 are skills:
 * `wshobson/agents` 183, `mizchi/skills` 69, `anthropics/skills` 20,
 * `obra/superpowers` 14, and 14 across four small repositories.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. TODO §2.1 is about the one thing that
 * keeps going wrong in this programme: a corpus I write measures my writing.
 * The boundary tasks in `../tasks/` are mine and every number from them says
 * so. This catalogue is not, and it is the only part of the skill router's
 * measurement that is not -- so it is worth being exact about which parts
 * still are:
 *
 *   the catalogue          harvested. Real names, real descriptions.
 *   which skills are for
 *   a repair task          NOT LABELLED. Nobody judged these 461 against
 *                          "fix a failing test in a small node project", so
 *                          there is no ground truth for precision here and
 *                          none is reported. The end-to-end verdict is the
 *                          exit code, which needs no label.
 *   the bodies             ABSENT from the roster, which carries name,
 *                          description, source and path only. See `bodyFor`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Skill } from "./world.js";

const HERE = import.meta.dirname;
const ROSTER = resolve(HERE, "../../skill-pick/corpus/roster.json");

interface Entry {
  name: string;
  description: string;
  source: string;
  path: string;
  kind: string;
}

/**
 * What goes in a `SKILL.md` body, given that the roster has no bodies.
 *
 * The honest options were: invent bodies, or say what is missing. Inventing
 * them would put 461 pieces of my writing in front of the agent and call the
 * result a measurement of someone else's catalogue.
 *
 * So the body IS the provenance, and the arm is only interpretable because of
 * what the host does with these files: Claude Code puts every skill's NAME AND
 * DESCRIPTION in the system prompt at launch and reads a body only if the
 * agent invokes that skill. The catalogue's cost -- which is what the "load
 * everything" arm measures -- is therefore paid in full from the real
 * descriptions, before any body is touched. A run where the agent invokes one
 * of these gets a stub instead of instructions, and that is recorded rather
 * than papered over: `report.ts` counts Skill invocations, and if any arm
 * shows them the result is not readable and says so.
 */
function bodyFor(e: Entry): string {
  return [
    `Harvested from \`${e.source}\` at \`${e.path}\` for a measurement of skill routing.`,
    "",
    "THIS IS NOT THE REAL SKILL. The roster this came from carries names and",
    "descriptions only, so the instructions are not here. If you have loaded",
    "this file looking for help, it has none: do the work directly.",
  ].join("\n");
}

/**
 * The catalogue, as skills.
 *
 * `kind: "skill"` only, which is 300 of the 461. The other 161 are subagent
 * definitions from `VoltAgent/awesome-claude-code-subagents`, which a host
 * loads through a different mechanism (`.claude/agents/`) and which would
 * confound the arm: a catalogue of agents in front of an agent changes what it
 * can DELEGATE, not just what it knows, and delegation is the orchestration
 * gate's variable.
 */
export function catalogue(limit?: number): Skill[] {
  const raw = JSON.parse(readFileSync(ROSTER, "utf8")) as { entries: Entry[] };
  const skills = raw.entries
    .filter((e) => e.kind === "skill" && e.name && e.description)
    // A stable order, so two sweeps place the same catalogue. Sorted by name
    // rather than by roster order, because roster order is harvest order and
    // would change if a source were re-fetched.
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({
      name: e.name,
      // The description is what a router reads and what the host puts in the
      // system prompt, so it is passed through EXACTLY, except for the one
      // thing that would corrupt the file: a newline inside YAML front matter.
      description: e.description.replace(/\s+/g, " ").trim(),
      body: bodyFor(e),
    }));
  return limit ? skills.slice(0, limit) : skills;
}
