/**
 * The roster: every skill a selector might have to choose between.
 *
 * docs/29 measured 74 skills, and admitted the limit plainly -- 9,410 tokens
 * of descriptions fits in one request, so "the catalog does not fit in
 * context" was a name rather than a situation. This one is built to not fit.
 *
 * The sources are the ones mizchi's own `skill-finder` names as its search
 * order (Anthropic official -> registry -> VoltAgent -> Superpowers -> GitHub
 * topic), plus mizchi's own repositories. Every entry is a real published
 * skill or subagent with a real `description:`; nothing here is padding.
 *
 * Two kinds of entry, and the difference matters for reading the results:
 *
 *   catalogued   the skill is a row in `skill-selector/references/catalog.md`,
 *                so docs/29's label applies to it
 *   distractor   a real skill from one of the other sources. It is not in the
 *                catalog, so under the catalog's own policy it does not
 *                belong in a proposal -- but "not in the catalog" is not the
 *                same as "wrong", and docs/30 §5 reads the top ones instead
 *                of trusting the label.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { frontmatterDescription } from "../../skill-select/src/catalog.js";

export interface Entry {
  /** The `name:` in the frontmatter, or the directory name. */
  name: string;
  description: string;
  /** `owner/repo`, so a reader can go and look. */
  source: string;
  /** Path inside that repo. */
  path: string;
  /** A SKILL.md, or an agent definition with the same two fields. */
  kind: "skill" | "agent";
}

export interface Roster {
  revs: Record<string, string>;
  entries: Entry[];
}

/** The `name:` field, falling back to the containing directory. */
export function frontmatterName(text: string, fallback: string): string {
  if (!text.startsWith("---")) return fallback;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return fallback;
  const m = /^name:[ \t]*(.+)$/m.exec(text.slice(3, end));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : fallback;
}

/**
 * Where to look, and what counts.
 *
 * `agents` sources hold one Markdown file per subagent rather than a
 * `SKILL.md` per directory. The two fields a selector reads -- a name and a
 * description -- are the same, which is why they are in the roster; the
 * `kind` field keeps them distinguishable.
 */
export const SOURCES: { repo: string; kind: Entry["kind"]; dir?: string }[] = [
  { repo: "mizchi/skills", kind: "skill" },
  { repo: "mizchi/flaker", kind: "skill" },
  { repo: "mizchi/actrun", kind: "skill" },
  { repo: "mizchi/pkfire", kind: "skill" },
  { repo: "mizchi/similarity", kind: "skill" },
  { repo: "anthropics/skills", kind: "skill" },
  { repo: "obra/superpowers", kind: "skill" },
  { repo: "wshobson/agents", kind: "skill" },
  { repo: "VoltAgent/awesome-claude-code-subagents", kind: "agent", dir: "categories" },
];

function walk(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === ".git" || entry === "node_modules") continue;
    const path = resolve(dir, entry);
    let s;
    try {
      s = statSync(path);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(path, out, depth + 1);
    else if (entry.endsWith(".md")) out.push(path);
  }
  return out;
}

/**
 * Collect the roster from a directory of clones.
 *
 * Deduplicated by name, first source wins, so mizchi's own copy of a skill
 * beats an upstream one. A file with no `description:` is skipped: it is not
 * something a harness could select on.
 */
export function collect(clones: string, revOf: (repo: string) => string): Roster {
  const revs: Record<string, string> = {};
  const byName = new Map<string, Entry>();
  for (const source of SOURCES) {
    const root = resolve(clones, source.repo, source.dir ?? ".");
    const files = walk(root).filter((f) =>
      source.kind === "skill" ? f.endsWith("/SKILL.md") : !/\/(README|CONTRIBUTING|LICENSE|CHANGELOG)\.md$/i.test(f),
    );
    let kept = 0;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const description = frontmatterDescription(text);
      if (!description) continue;
      const parts = file.split("/");
      const fallback = source.kind === "skill" ? parts[parts.length - 2] : parts[parts.length - 1].replace(/\.md$/, "");
      const name = frontmatterName(text, fallback);
      if (byName.has(name)) continue;
      byName.set(name, {
        name,
        description,
        source: source.repo,
        path: file.slice(resolve(clones, source.repo).length + 1),
        kind: source.kind,
      });
      kept += 1;
    }
    if (kept > 0) revs[source.repo] = revOf(source.repo);
  }
  return { revs, entries: [...byName.values()] };
}

export function loadRoster(root = resolve(import.meta.dirname, "..")): Roster {
  return JSON.parse(readFileSync(resolve(root, "corpus/roster.json"), "utf8")) as Roster;
}

/** Roughly what a description costs. docs/27 measured 2.4 chars/token on JSON. */
export const CHARS_PER_TOKEN = 2.4;

export function tokensOf(entries: readonly Entry[]): number {
  return Math.round(entries.reduce((a, e) => a + e.name.length + e.description.length + 40, 0) / CHARS_PER_TOKEN);
}
