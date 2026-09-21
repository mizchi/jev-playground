/**
 * DOES WIDENING THE ROSTER PRODUCE A CORPUS? Probed before anything is spent.
 *
 *   tsx src/widen.ts --roster    the candidate repositories, and where they came from
 *   tsx src/widen.ts             clone them, harvest, record the yield
 *   tsx src/widen.ts --report    from the record
 *
 * No API key and no agent: this only clones and counts. docs/55 named a wider
 * roster as its obvious next step, and the expensive half of that step is
 * agent runs -- so the cheap half goes first, because the answer to "is there
 * a corpus here" costs nothing and decides whether the rest is worth doing.
 *
 * WHERE THE CANDIDATES COME FROM, AND WHY NOT FROM ME. docs/55's roster was
 * defensible for exactly one reason: `experiments/skill-pick/corpus/roster.json`
 * was assembled for docs/30, **before this question existed**. Picking the
 * next nine repositories myself would throw that away -- I would be choosing a
 * corpus knowing what I wanted it to show, which is the defect docs/49 and
 * docs/53 were built to avoid.
 *
 * So the widening is a rule over a list that already exists: **the distinct
 * GitHub repositories behind the packages docs/49 harvested.** docs/49's
 * corpus is 103 npm packages found in `experiments/agent/node_modules`, and
 * which packages are there was decided by what `pi-coding-agent` and its
 * dependencies depend on. Reading each one's `repository` field gives 56
 * repositories that nobody picked for this question.
 *
 * WHAT THAT RULE CANNOT FIX, stated before the numbers: these are npm
 * LIBRARIES, and a library repository has much less reason to keep a tracked
 * checklist than a project one. docs/55's three yielding repositories were all
 * project repositories whose author keeps a `TODO.md`. So a low yield here is
 * a property of the population the rule selects, not a bug in the rule -- and
 * saying so in advance is what stops a low yield from being re-narrated as
 * something else afterwards.
 *
 * THE HARVEST RULE IS IMPORTED, NOT REIMPLEMENTED. `tasksIn` from `wild.ts` is
 * what produced docs/55's corpus, floor and tracked-file test included. A
 * second copy of that rule here would make the two yields incomparable, which
 * is the whole point of measuring this one.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { tasksIn, type Task } from "./wild.js";

const RECORDS = resolve(import.meta.dirname, "../records");
const PATH_ = resolve(RECORDS, "widen.json");
/** docs/49's harvest: the list the first widening is a rule over. */
const SCRIPTS = resolve(RECORDS, "scripts.json");
/** The account's own repository listing, filtered by rule. The second source. */
const ACCESSIBLE = resolve(import.meta.dirname, "../corpus/accessible.json");
const CLONES = resolve(tmpdir(), "jev-widen-clones");

export interface Candidate {
  /** `owner/name`. */
  repo: string;
  /** Where this candidate came from. Two rules, kept apart in the record. */
  source: "packages" | "account";
  /** For `packages`: which of docs/49's packages pointed here. Provenance. */
  via: string[];
}

export interface Probed {
  repo: string;
  source: "packages" | "account";
  via: string[];
  cloned: boolean;
  /** What the clone was at. There is no pinned revision to compare against. */
  head: string | null;
  /** Markdown files with at least one ticked box: the tracked-file rule. */
  trackedFiles: number;
  open: number;
  done: number;
  /** Sections holding both classes -- the only pairing docs/55 §5 supports. */
  matchedSections: number;
  error?: string;
}

export interface Record_ {
  note: string;
  rule: string;
  rows: Probed[];
}

const NOTE =
  "Does widening docs/55's roster produce a corpus? The candidates are the distinct GitHub " +
  "repositories behind the packages docs/49 harvested, so the list is a rule over an existing " +
  "corpus rather than a set chosen for this question. Clone and count only: no API key, no agent.";
const RULE =
  "every distinct GitHub repository named by the `repository` field of a package in " +
  "records/scripts.json (docs/49's harvest), read from the copy already in node_modules";

/**
 * The candidate roster, derived.
 *
 * Reads each harvested package's own `package.json` -- the copy docs/49
 * measured, still on disk -- and keeps whatever its `repository` field names.
 * A package with no GitHub repository is dropped and counted, because "the
 * rule produced fewer than the list" is part of the measurement.
 */
/**
 * THE SECOND SOURCE: the account's own repository listing, filtered by rule.
 *
 * The first source -- docs/49's packages -- produced 56 repositories and not
 * one checkbox task, which is a measurement and also a dead end: npm
 * libraries do not keep tracked checklists. This one selects the population
 * that docs/55's three yielding repositories came from, and the list is still
 * not mine: `list_repos` returns what the account can see, and the filter is
 * public / non-fork / non-archived / owned by that account, minus the
 * repository this report lives in.
 *
 * `corpus/accessible.json` records only the public names. The listing also
 * returned private and internal repositories, including an employer's and
 * third parties', and writing those names into a public repository would
 * publish them.
 */
export function accountRoster(): string[] {
  if (!existsSync(ACCESSIBLE)) return [];
  return (JSON.parse(readFileSync(ACCESSIBLE, "utf8")) as { repos: string[] }).repos;
}

export function candidates(source: "packages" | "account" = "packages"): {
  rows: Candidate[];
  packages: number;
  withoutRepo: string[];
} {
  if (source === "account") {
    return {
      rows: accountRoster().map((repo) => ({ repo, source: "account" as const, via: [] })),
      packages: 0,
      withoutRepo: [],
    };
  }
  if (!existsSync(SCRIPTS)) return { rows: [], packages: 0, withoutRepo: [] };
  const harvest = JSON.parse(readFileSync(SCRIPTS, "utf8")) as { rows: { pkg: string; dir: string }[] };
  const byRepo = new Map<string, Set<string>>();
  const seen = new Set<string>();
  const withoutRepo: string[] = [];
  for (const row of harvest.rows) {
    if (seen.has(row.pkg)) continue;
    seen.add(row.pkg);
    const manifest = resolve(row.dir, "package.json");
    if (!existsSync(manifest)) {
      withoutRepo.push(row.pkg);
      continue;
    }
    let url: unknown = null;
    try {
      const json = JSON.parse(readFileSync(manifest, "utf8")) as {
        repository?: string | { url?: string };
      };
      url = typeof json.repository === "string" ? json.repository : json.repository?.url;
    } catch {
      url = null;
    }
    // The repo name may contain dots -- `bignumber.js`, `highlight.js`,
    // `long.js`. The first version of this stopped at the first dot and named
    // three repositories that do not exist; all three failed to clone, which
    // is the only reason it was visible at all. Strip a trailing `.git` and
    // any trailing path or query instead.
    const match = typeof url === "string" ? /github\.com[:/]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?]|$)/.exec(url) : null;
    if (match === null) {
      withoutRepo.push(row.pkg);
      continue;
    }
    const repo = `${match[1]}/${match[2]}`;
    if (!byRepo.has(repo)) byRepo.set(repo, new Set());
    byRepo.get(repo)?.add(row.pkg);
  }
  return {
    rows: [...byRepo]
      .map(([repo, via]) => ({ repo, source: "packages" as const, via: [...via].sort() }))
      .sort((a, b) => a.repo.localeCompare(b.repo)),
    packages: seen.size,
    withoutRepo,
  };
}

const dirFor = (repo: string): string => resolve(CLONES, repo.replace("/", "-"));

/**
 * Clone one candidate, harvest it with docs/55's own rule, and throw the
 * clone away unless it yielded something.
 *
 * Deleting on a zero yield is not tidiness -- 56 clones do not fit the disk
 * allowance this container has left, and docs/55's sweep already lost eight
 * runs to a cleanup that could not cope with what a build left behind.
 */
export function probe(c: Candidate): Probed {
  const dir = dirFor(c.repo);
  const row: Probed = {
    repo: c.repo,
    source: c.source,
    via: c.via,
    cloned: false,
    head: null,
    trackedFiles: 0,
    open: 0,
    done: 0,
    matchedSections: 0,
  };
  mkdirSync(CLONES, { recursive: true });
  if (!existsSync(resolve(dir, ".git"))) {
    const out = spawnSync(
      "git",
      ["clone", "--depth", "1", "-q", `https://github.com/${c.repo}.git`, dir],
      { encoding: "utf8", timeout: 180_000 },
    );
    if (out.status !== 0) {
      row.error = `clone: ${(out.stderr ?? "").trim().slice(0, 160) || `exit ${out.status}`}`;
      return row;
    }
  }
  row.cloned = true;
  const head = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" });
  row.head = head.status === 0 ? (head.stdout ?? "").trim() || null : null;
  // docs/55's harvest rule, imported. `rev` is the head, because nothing
  // pinned these.
  const tasks: Task[] = tasksIn(c.repo, row.head ?? "unknown", dir);
  row.open = tasks.filter((t) => t.state === "open").length;
  row.done = tasks.filter((t) => t.state === "done").length;
  row.trackedFiles = new Set(tasks.map((t) => t.file)).size;
  const key = (t: Task): string => `${t.file}\u0000${t.section}`;
  const openSections = new Set(tasks.filter((t) => t.state === "open").map(key));
  const doneSections = new Set(tasks.filter((t) => t.state === "done").map(key));
  row.matchedSections = [...openSections].filter((k) => doneSections.has(k)).length;
  if (row.open === 0 && row.done === 0) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
    } catch (err) {
      row.error = `cleanup: ${String(err).slice(0, 120)}`;
    }
  }
  return row;
}

/**
 * DROP EVERY ROW THE RULE NO LONGER NAMES. The record is *defined* as the
 * rule's rows, so a row outside them is not data, it is residue.
 *
 * This is not hypothetical tidying, and it is here because the resume path
 * below carries every prior row forward and only adds the missing ones -- so
 * a name the rule stops producing stays in the record for good.
 *
 * The first `candidates` stopped at the first dot in a repository name (see
 * there) and produced four wrong ones. Three do not exist and failed to
 * clone, which is the only reason the bug was found at all. The fourth,
 * `dcodeIO/protobuf`, EXISTS: it cloned, harvested clean, and sat in the
 * record as an ordinary-looking row -- 57 rows for a rule that selects 56 --
 * for a repository the rule never named. **Clone failure does not detect this
 * class of bug.** Re-deriving the roster and diffing it against the record
 * does, so that is what runs on every load.
 */
export function reconcile(
  rows: Probed[],
  source: "packages" | "account",
): { rows: Probed[]; dropped: string[] } {
  const rule = new Set(candidates(source).rows.map((c) => c.repo));
  const dropped: string[] = [];
  const kept = rows.filter((r) => {
    if (r.source !== source || rule.has(r.repo)) return true;
    dropped.push(r.repo);
    return false;
  });
  return { rows: kept, dropped };
}

function load(): Record_ {
  if (!existsSync(PATH_)) return { note: NOTE, rule: RULE, rows: [] };
  const rec = JSON.parse(readFileSync(PATH_, "utf8")) as Record_;
  let rows = rec.rows;
  for (const source of ["packages", "account"] as const) {
    const r = reconcile(rows, source);
    rows = r.rows;
    // Never silent: a dropped row changes every count in the report.
    for (const repo of r.dropped) {
      process.stderr.write(`  DROPPED ${repo} -- not named by the \`${source}\` rule\n`);
    }
  }
  return { ...rec, rows };
}

function report(rec: Record_, only?: "packages" | "account"): void {
  const rows = only ? rec.rows.filter((r) => r.source === only) : rec.rows;
  console.log("\n## Widening docs/55's roster: what the rules yield\n");
  console.log("**Two rules, kept apart**, because they select different populations:\n");
  console.log("| source | the rule | repositories |");
  console.log("| --- | --- | --- |");
  const pkgRows = rec.rows.filter((r) => r.source === "packages");
  const accRows = rec.rows.filter((r) => r.source === "account");
  console.log(
    `| \`packages\` | the GitHub repositories behind docs/49's harvested npm packages | ${pkgRows.length} |`,
  );
  console.log(
    `| \`account\` | public, non-fork, non-archived repositories in the account's own listing | ${accRows.length} |`,
  );
  console.log("");
  if (rows.length === 0) {
    console.log("**Nothing probed yet.** Run without `--report`.\n");
    return;
  }
  for (const [name, set] of [["packages", pkgRows], ["account", accRows]] as const) {
    if (set.length === 0 || (only !== undefined && only !== name)) continue;
    const y = set.filter((r) => r.open + r.done > 0);
    console.log(
      `**\`${name}\`: ${y.length} of ${set.length} repositories yield any checkbox task**` +
        ` (${set.filter((r) => r.open > 0).length} with an open one, ` +
        `${set.filter((r) => r.matchedSections > 0).length} with a section holding both classes).\n`,
    );
  }
  const cloned = rows.filter((r) => r.cloned);
  const yielded = rows.filter((r) => r.open + r.done > 0);
  const withOpen = rows.filter((r) => r.open > 0);
  const withMatched = rows.filter((r) => r.matchedSections > 0);
  console.log("| | repositories |");
  console.log("| --- | --- |");
  console.log(`| probed | **${rows.length}** |`);
  console.log(`| cloned | ${cloned.length} |`);
  console.log(`| any checkbox task at all | **${yielded.length}** |`);
  console.log(`| at least one \`- [ ]\` | **${withOpen.length}** |`);
  console.log(`| a section holding BOTH classes | **${withMatched.length}** |`);
  console.log(
    `\n**${rows.reduce((n, r) => n + r.open, 0)} open and ${rows.reduce((n, r) => n + r.done, 0)} done items** ` +
      `over ${cloned.length} clones, in ${rows.reduce((n, r) => n + r.trackedFiles, 0)} tracked files.\n`,
  );
  if (yielded.length > 0) {
    console.log("| repository | tracked files | `- [ ]` | `- [x]` | matched sections | via |");
    console.log("| --- | --- | --- | --- | --- | --- |");
    for (const r of yielded.sort((a, b) => b.open - a.open || b.done - a.done)) {
      console.log(
        `| \`${r.repo}\` | ${r.trackedFiles} | **${r.open}** | ${r.done} | ${r.matchedSections} | ` +
          `${r.via.slice(0, 3).map((v) => `\`${v}\``).join(" ")}${r.via.length > 3 ? ` +${r.via.length - 3}` : ""} |`,
      );
    }
    console.log("");
  }
  const failed = rows.filter((r) => r.error !== undefined);
  if (failed.length > 0) {
    console.log(`**${failed.length} did not probe cleanly:**\n`);
    for (const r of failed) console.log(`- \`${r.repo}\`: ${r.error}`);
    console.log("");
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const source = argv.includes("--source")
    ? (argv[argv.indexOf("--source") + 1] as "packages" | "account")
    : "packages";
  const { rows, packages, withoutRepo } = candidates(source);
  if (argv.includes("--roster")) {
    console.log(
      source === "account"
        ? `\n  ${rows.length} repositories from the account listing, filtered by rule\n`
        : `\n  ${packages} packages -> ${rows.length} repositories (${withoutRepo.length} without one)\n`,
    );
    for (const c of rows) console.log(`  ${c.repo.padEnd(44)} via ${c.via.slice(0, 4).join(", ")}`);
    console.log("");
    return;
  }
  if (argv.includes("--report")) {
    report(load(), argv.includes("--source") ? source : undefined);
    return;
  }
  const had = load().rows;
  const done = new Set(had.filter((r) => r.source === source).map((r) => r.repo));
  const todo = rows.filter((c) => !done.has(c.repo));
  if (todo.length === 0) {
    console.log(`\n  all ${rows.length} repositories are already probed.\n`);
    // Persist whatever `load` reconciled away, so a dropped row does not come
    // back in the next report.
    writeFileSync(PATH_, `${JSON.stringify({ note: NOTE, rule: RULE, rows: had }, null, 2)}\n`);
    report({ note: NOTE, rule: RULE, rows: had });
    return;
  }
  process.stderr.write(`  ${had.length} probed, ${todo.length} to go\n`);
  const out: Probed[] = [...had];
  for (const c of todo) {
    const row = probe(c);
    out.push(row);
    process.stderr.write(
      `  ${row.error ? "FAIL" : row.open + row.done > 0 ? "YIELD" : "none "} ` +
        `${row.repo.padEnd(42)} open ${String(row.open).padStart(3)} done ${String(row.done).padStart(4)} ` +
        `${row.error ?? ""}\n`,
    );
    mkdirSync(RECORDS, { recursive: true });
    writeFileSync(PATH_, `${JSON.stringify({ note: NOTE, rule: RULE, rows: out }, null, 2)}\n`);
  }
  report({ note: NOTE, rule: RULE, rows: out }, source);
}

if (process.argv[1]?.endsWith("widen.ts")) await main();
