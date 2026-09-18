/**
 * Build the roster the cookbook calls `hermes_roster.json`, from a checkout of
 * a skills repository instead of Hermes.
 *
 * Each entry carries the four things the pipeline needs:
 *   name        - what the agent's load tool takes, matched exactly
 *   index_desc  - the TRUNCATED description, i.e. what the agent sees in its
 *                 roster. This is the whole problem the cookbook is about:
 *                 truncation makes similar skills indistinguishable.
 *   description - the full frontmatter description
 *   body        - the opening of SKILL.md, for the stage-2 excerpt
 *
 *   npx tsx src/roster.ts [--skills-dir /home/user/mizchi/skills] [--truncate 60]
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface SkillEntry {
  name: string;
  index_desc: string;
  description: string;
  body: string;
  /** Optional tags, where the repo happens to carry them. Not used by the pipeline. */
  tags?: string[];
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

/**
 * Minimal YAML frontmatter reader — enough for `name`, `description` (which
 * may be folded over several lines) and `metadata.hermes.tags`. Not a YAML
 * parser, and does not pretend to be.
 */
function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { fm: {}, body: text };
  const fm: Record<string, string> = {};
  let key = "";
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line);
    if (kv && !line.startsWith(" ")) {
      key = kv[1];
      fm[key] = kv[2].trim();
    } else if (key && /^\s+\S/.test(line) && !/^\s*[\w-]+:/.test(line)) {
      // A folded continuation of the previous scalar.
      fm[key] = `${fm[key]} ${line.trim()}`.trim();
    }
  }
  const tags = /tags:\s*\[([^\]]*)\]/.exec(m[1]);
  if (tags) fm.__tags = tags[1];
  // Some of these files quote their scalars; the quotes are YAML syntax, not
  // part of the skill name the load tool matches on.
  for (const k of Object.keys(fm)) {
    fm[k] = fm[k].replace(/^(['"])([\s\S]*)\1$/, "$2");
  }
  return { fm, body: m[2] };
}

export function buildRoster(skillsDir: string, truncate: number): SkillEntry[] {
  const out: SkillEntry[] = [];
  for (const entry of readdirSync(skillsDir)) {
    const dir = join(skillsDir, entry);
    if (entry.startsWith(".") || !statSync(dir).isDirectory()) continue;
    const file = join(dir, "SKILL.md");
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const { fm, body } = parseFrontmatter(text);
    const description = (fm.description ?? "").replace(/\s+/g, " ").trim();
    if (!description) continue;
    const name = (fm.name ?? entry).trim();
    out.push({
      name,
      // The agent's view. Truncated exactly as the cookbook does, because
      // that truncation IS the failure mode being fixed.
      index_desc:
        description.length > truncate ? `${description.slice(0, truncate).trimEnd()}…` : description,
      description,
      body: body.replace(/\s+/g, " ").trim(),
      tags: fm.__tags ? fm.__tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = arg("skills-dir", "/home/user/mizchi/skills");
  const truncate = Number.parseInt(arg("truncate", "60"), 10);
  const roster = buildRoster(dir, truncate);
  mkdirSync("out", { recursive: true });
  writeFileSync("out/roster.json", JSON.stringify(roster, null, 2));
  console.log(`${roster.length} skills from ${dir}`);
  const truncated = roster.filter((s) => s.index_desc.endsWith("…")).length;
  console.log(`${truncated} of them have a description longer than ${truncate} chars, so the agent sees it cut`);
  console.log("");
  console.log("sample of what the agent sees:");
  for (const s of roster.slice(0, 8)) {
    console.log(`  ${s.name.padEnd(34)} ${s.index_desc}`);
  }
  console.log("");
  // The reason the cookbook exists: names that collide once truncated.
  const byPrefix = new Map<string, string[]>();
  for (const s of roster) {
    const k = s.index_desc.slice(0, 30).toLowerCase();
    byPrefix.set(k, [...(byPrefix.get(k) ?? []), s.name]);
  }
  const collisions = [...byPrefix.values()].filter((v) => v.length > 1);
  console.log(`groups sharing the first 30 chars of their visible description: ${collisions.length}`);
  for (const c of collisions.slice(0, 6)) console.log(`  ${c.join(", ")}`);
  console.log("");
  console.log("written to out/roster.json");
}
