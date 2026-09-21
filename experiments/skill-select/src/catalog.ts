/**
 * The corpus: mizchi's curated skill catalog, and the labels it implies.
 *
 * `mizchi/skills/skill-selector/references/catalog.md` is a real artefact --
 * 95 rows, hand-vetted, grouped by the project signal that should trigger
 * them, each row carrying a tier that says how eagerly to propose it. That
 * grouping IS the label: a row's section declares the signals, and the tier
 * legend declares the policy. Nothing here is a judgment of mine.
 *
 *   T0  always propose, whatever the project looks like
 *   T1  propose when the section's signals are present
 *   T2  only when the user explicitly asks for it
 *   T3  mention in prose, do not put in the default proposal
 *   T4  superseded; name the alternative instead
 *
 * The extractor is kept in the repo so the snapshot can be rebuilt, but the
 * report reads the COMMITTED snapshot: the catalog lives in another
 * repository and this experiment has to replay without it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Tier = "T0" | "T1" | "T2" | "T3" | "T4";

export interface Row {
  /** The skill's name as the catalog writes it. */
  skill: string;
  tier: Tier;
  /** `mizchi/skills/foo`, or `(out-of-band)`. */
  install: string;
  /** The catalog's own "Use when" prose. Curated -- see `arms.ts`. */
  useWhen: string;
  /** Heading path, e.g. "Tooling / Infra > Cloudflare". */
  section: string;
  /** The section's declared `**Signals**` line, or "" when it has none. */
  signals: string;
  /** The skill's own `description:` frontmatter, when it is in this repo. */
  description: string;
  /** Where the description came from, or "" when there is none. */
  descriptionFrom: string;
}

export interface Snapshot {
  source: { repo: string; rev: string; path: string };
  /** Every repo a description was read from, with the commit it was read at. */
  revs: Record<string, string>;
  /** Install strings whose SKILL.md could not be read, and why. */
  unresolved: { install: string; reason: string }[];
  rows: Row[];
}

const TIERS: Tier[] = ["T0", "T1", "T2", "T3", "T4"];

/** Read a SKILL.md `description:` out of the frontmatter, quotes and all. */
export function frontmatterDescription(text: string): string {
  if (!text.startsWith("---")) return "";
  const end = text.indexOf("\n---", 3);
  if (end < 0) return "";
  const front = text.slice(3, end);
  // The field is one logical line in every skill in this catalog, but it may
  // be quoted with either quote character, or written as a `|` block.
  const inline = /^description:[ \t]*(.+)$/m.exec(front);
  if (inline) {
    const raw = inline[1].trim();
    if (raw === "|" || raw === ">" || raw === "|-" || raw === ">-") {
      const after = front.slice(inline.index + inline[0].length).split("\n");
      const lines: string[] = [];
      for (const line of after) {
        if (line.trim() === "") continue;
        if (!/^\s+/.test(line)) break;
        lines.push(line.trim());
      }
      return lines.join(" ");
    }
    return raw.replace(/^['"]|['"]$/g, "").trim();
  }
  return "";
}

/**
 * Parse the catalog's tables.
 *
 * Deliberately strict: a row whose tier is not one of the five, or whose
 * table has the wrong column count, throws rather than being dropped. A
 * silently shortened corpus is the failure this experiment cannot detect
 * from its own numbers.
 */
export function parseCatalog(markdown: string): Omit<Row, "description" | "descriptionFrom">[] {
  const out: Omit<Row, "description" | "descriptionFrom">[] = [];
  const heads: string[] = [];
  let signals = "";
  let inTable = false;
  for (const line of markdown.split("\n")) {
    const heading = /^(#{2,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      heads.length = level - 2;
      heads[level - 2] = heading[2].trim();
      if (level === 2) signals = "";
      inTable = false;
      continue;
    }
    const signalLine = /^\*\*Signals\*\*:\s*(.*)$/.exec(line);
    if (signalLine) {
      signals = signalLine[1].trim();
      continue;
    }
    if (/^\|\s*T\s*\|/.test(line)) {
      inTable = true;
      continue;
    }
    if (!line.startsWith("|")) {
      if (line.trim() === "") inTable = inTable && false;
      continue;
    }
    if (/^\|[\s|:-]+\|$/.test(line)) continue;
    if (!inTable) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length !== 4) throw new Error(`catalog row has ${cells.length} cells: ${line}`);
    const tier = cells[0].replace(/\*/g, "") as Tier;
    if (!TIERS.includes(tier)) throw new Error(`unknown tier ${JSON.stringify(cells[0])}: ${line}`);
    out.push({
      skill: cells[1].replace(/`/g, "").trim(),
      tier,
      install: cells[2].replace(/`/g, "").trim(),
      useWhen: cells[3].replace(/\*\*/g, "").trim(),
      section: heads.filter((h) => h).join(" > "),
      signals,
    });
  }
  return out;
}

/**
 * Where an install string's SKILL.md lives, given a directory of clones.
 *
 * `owner/repo/sub/path` -> `<clones>/owner/repo/sub/path/SKILL.md`, falling
 * back to the repo root because two rows in this catalog point at a
 * repo-root SKILL.md rather than at a `skills/` subdirectory.
 */
export function candidatePaths(clones: string, install: string): string[] {
  const parts = install.split("/");
  if (parts.length < 2) return [];
  const repo = resolve(clones, parts[0], parts[1]);
  const sub = parts.slice(2).join("/");
  return sub ? [resolve(repo, sub, "SKILL.md"), resolve(repo, "SKILL.md")] : [resolve(repo, "SKILL.md")];
}

/**
 * Build the snapshot from a directory holding clones of the source repos.
 *
 * The catalog installs from thirteen different repositories, and not all of
 * them are public. A row whose SKILL.md cannot be read keeps an empty
 * description and is listed in `unresolved` -- the report states the count
 * rather than quietly shrinking the corpus.
 */
export function extract(clones: string, revOf: (repo: string) => string): Snapshot {
  const path = "skill-selector/references/catalog.md";
  const catalogRepo = resolve(clones, "mizchi/skills");
  const revs: Record<string, string> = { "mizchi/skills": revOf("mizchi/skills") };
  const unresolved: { install: string; reason: string }[] = [];
  const rows = parseCatalog(readFileSync(resolve(catalogRepo, path), "utf8")).map((row) => {
    let description = "";
    let descriptionFrom = "";
    if (row.install === "(out-of-band)") {
      unresolved.push({ install: `${row.skill} (out-of-band)`, reason: "not installable via public APM" });
      return { ...row, description, descriptionFrom };
    }
    for (const candidate of candidatePaths(clones, row.install)) {
      try {
        description = frontmatterDescription(readFileSync(candidate, "utf8"));
      } catch {
        continue;
      }
      if (description) {
        descriptionFrom = candidate.slice(clones.length + 1);
        const repo = row.install.split("/").slice(0, 2).join("/");
        if (!revs[repo]) revs[repo] = revOf(repo);
        break;
      }
    }
    if (!description) unresolved.push({ install: row.install, reason: "no readable SKILL.md in the clones" });
    return { ...row, description, descriptionFrom };
  });
  return { source: { repo: "mizchi/skills", rev: revs["mizchi/skills"], path }, revs, unresolved, rows };
}

export function loadSnapshot(root = resolve(import.meta.dirname, "..")): Snapshot {
  return JSON.parse(readFileSync(resolve(root, "corpus/skills.json"), "utf8")) as Snapshot;
}
