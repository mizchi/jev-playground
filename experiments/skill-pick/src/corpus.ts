/**
 * Joining the 461-entry roster to docs/29's labels.
 *
 * The labels are the catalog's tier legend applied per project, and they are
 * imported from `skill-select` rather than restated: two copies of a label
 * rule is one copy too many. What this file adds is the join, which is not
 * quite a name match -- the catalog calls one row `workers-cd-rollback`
 * while its SKILL.md says `cloudflare-workers-cd-rollback`, so the join
 * falls back to the install path's basename and the test checks that every
 * catalogued row finds its entry.
 *
 * Everything in the roster that is NOT a catalog row is a `distractor`:
 * a real published skill from one of `skill-finder`'s named sources, which
 * under the catalog's own policy does not belong in a proposal. That is a
 * label by construction and §5 reads the top ones rather than trusting it.
 */
import { loadSnapshot, type Snapshot } from "../../skill-select/src/catalog.js";
import { candidates, type Label, type Project } from "../../skill-select/src/projects.js";
import { loadRoster, type Entry, type Roster } from "./roster.js";

export interface Candidate {
  /** The roster's name, which is what the question carries. */
  name: string;
  description: string;
  source: string;
  kind: Entry["kind"];
  /** The catalog's name for it, when it is a catalog row. */
  catalogued: string | null;
  label: Label;
}

/** Catalog name -> the names its SKILL.md might use. */
function aliasesOf(snapshot: Snapshot): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of snapshot.rows) {
    const basename = row.install.split("/").at(-1) ?? "";
    const list = out.get(row.skill) ?? [];
    for (const alias of [row.skill, basename]) if (alias && !list.includes(alias)) list.push(alias);
    out.set(row.skill, list);
  }
  return out;
}

export interface Corpus {
  roster: Roster;
  snapshot: Snapshot;
  /** Catalogued names that no roster entry matches. Should be empty. */
  unmatched: string[];
}

export function loadCorpus(pickRoot?: string, selectRoot?: string): Corpus {
  const roster = loadRoster(pickRoot);
  const snapshot = loadSnapshot(selectRoot);
  const byName = new Map(roster.entries.map((e) => [e.name, e]));
  const aliases = aliasesOf(snapshot);
  const unmatched: string[] = [];
  for (const [skill, names] of aliases) {
    if (!snapshot.rows.some((r) => r.skill === skill && r.description)) continue;
    if (!names.some((n) => byName.has(n))) unmatched.push(skill);
  }
  return { roster, snapshot, unmatched };
}

/**
 * The candidate list for one project: every roster entry, labelled.
 *
 * A catalogued entry takes docs/29's label. Everything else is `no`.
 */
export function candidatesFor(corpus: Corpus, project: Project): Candidate[] {
  const labelled = new Map(candidatesFor2(corpus, project));
  return corpus.roster.entries.map((e) => {
    const found = labelled.get(e.name);
    return {
      name: e.name,
      description: e.description,
      source: e.source,
      kind: e.kind,
      catalogued: found?.catalogued ?? null,
      label: found?.label ?? "no",
    };
  });
}

/** Roster name -> {catalog name, label}, for the catalogued entries only. */
function candidatesFor2(
  corpus: Corpus,
  project: Project,
): [string, { catalogued: string; label: Label }][] {
  const byName = new Map(corpus.roster.entries.map((e) => [e.name, e]));
  const aliases = aliasesOf(corpus.snapshot);
  const out: [string, { catalogued: string; label: Label }][] = [];
  for (const c of candidates(corpus.snapshot, project)) {
    const names = aliases.get(c.skill) ?? [c.skill];
    const hit = names.find((n) => byName.has(n));
    if (hit) out.push([hit, { catalogued: c.skill, label: c.label }]);
  }
  return out;
}

export { PROJECTS } from "../../skill-select/src/projects.js";
