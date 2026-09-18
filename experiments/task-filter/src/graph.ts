/**
 * The task graph, built by `just` and read back as JSON.
 *
 * The point of the experiment is the division of labour between a graph and a
 * judgment, so the graph has to be real: the edges here are whatever
 * `just --dump --dump-format json` says they are, never a table we maintain.
 * Only two things are ours, and both are parsed out of the justfile's text
 * because `just` keeps just the last comment line as a recipe's doc:
 *
 *   @inputs  the file globs a turbo.json / bazel `srcs` would declare
 *   @cost    the recipe's wall-clock seconds in CI
 *
 * `graph.json` is the cached dump, committed so the experiment runs without
 * `just` installed. Regenerate with `npm run graph`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Task {
  name: string;
  /** `just`'s own edges. The only source of ordering and prerequisites. */
  deps: string[];
  /** The last comment line above the recipe. One line of prose, or null. */
  doc: string | null;
  /** The recipe body, one string per line. The hidden implementation. */
  body: string[];
  /** File globs from `# @inputs:`. What a static affected-set tool matches on. */
  inputs: string[];
  /** Seconds from `# @cost:`. */
  cost: number;
  /**
   * Shell from `# @reset:`, run before the recipe when measuring costs in
   * isolation. A build system's cache makes a task's cost depend on what ran
   * before it, so the cost table is measured with each cache cleared.
   */
  reset: string | null;
  /** `just` groups. A recipe in `meta` is an aggregate, not a goal. */
  groups: string[];
}

export interface Graph {
  tasks: Task[];
  /** Where the dump came from, so a stale cache is visible in the report. */
  source: string;
}

const META_GROUP = "meta";

// ---------------------------------------------------------------- building

/** Shape of the bits of `just --dump --dump-format json` we read. */
interface JustDump {
  recipes: Record<
    string,
    {
      name: string;
      doc: string | null;
      body: string[][];
      dependencies: { recipe: string }[];
      attributes: (string | Record<string, unknown>)[];
    }
  >;
}

interface Note {
  inputs: string[];
  cost: number;
  reset: string | null;
}

const EMPTY: Note = { inputs: [], cost: 0, reset: null };

/** `# @inputs:` / `# @cost:` / `# @reset:`, keyed by the recipe they precede. */
function annotations(justfile: string): Map<string, Note> {
  const out = new Map<string, Note>();
  let pending: Note = { ...EMPTY };
  for (const raw of justfile.split("\n")) {
    const line = raw.trim();
    const inputs = /^#\s*@inputs:\s*(.+)$/.exec(line);
    if (inputs) {
      pending.inputs = inputs[1].trim().split(/\s+/);
      continue;
    }
    const cost = /^#\s*@cost:\s*([\d.]+)$/.exec(line);
    if (cost) {
      pending.cost = Number(cost[1]);
      continue;
    }
    const reset = /^#\s*@reset:\s*(.+)$/.exec(line);
    if (reset) {
      pending.reset = reset[1].trim();
      continue;
    }
    if (line === "" || line.startsWith("#") || line.startsWith("[")) continue;
    // A recipe header: `name:` or `name: dep1 dep2`. Anything else (a variable
    // assignment, a body line) resets the pending annotations.
    const header = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(?!=)/.exec(raw);
    if (header && !raw.startsWith(" ") && !raw.startsWith("\t")) {
      if (pending.inputs.length > 0 || pending.cost > 0 || pending.reset) {
        out.set(header[1], pending);
      }
    }
    pending = { ...EMPTY };
  }
  return out;
}

function groupsOf(attrs: (string | Record<string, unknown>)[]): string[] {
  const out: string[] = [];
  for (const a of attrs) {
    if (typeof a === "object" && a !== null && typeof a.group === "string") out.push(a.group);
  }
  return out;
}

/** Run `just --dump` in `dir` and fold the annotations in. */
export function buildGraph(dir: string): Graph {
  const dump = JSON.parse(
    execFileSync("just", ["--dump", "--dump-format", "json"], {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 32 << 20,
    }),
  ) as JustDump;
  const notes = annotations(readFileSync(join(dir, "justfile"), "utf8"));
  const tasks: Task[] = Object.values(dump.recipes).map((r) => {
    const note = notes.get(r.name) ?? EMPTY;
    return {
      name: r.name,
      deps: r.dependencies.map((d) => d.recipe),
      doc: r.doc,
      body: r.body.map((line) => line.join("")),
      inputs: note.inputs,
      cost: note.cost,
      reset: note.reset,
      groups: groupsOf(r.attributes),
    };
  });
  tasks.sort((a, b) => a.name.localeCompare(b.name));
  return { tasks, source: `just --dump (${dir})` };
}

/**
 * The cached dump, so a run needs no `just` on PATH. `cache` defaults to a
 * graph.json beside the justfile, but can point elsewhere -- the graph of the
 * repository root is cached under this experiment rather than at the root.
 */
export function loadGraph(dir: string, cache = join(dir, "graph.json")): Graph {
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8")) as Graph;
  return buildGraph(dir);
}

export function writeGraph(dir: string, cache = join(dir, "graph.json")): Graph {
  const g = buildGraph(dir);
  writeFileSync(cache, JSON.stringify(g, null, 2) + "\n");
  return g;
}

/** The directory of this experiment, wherever it was checked out. */
export const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");

// ---------------------------------------------------------------- queries

export class TaskGraph {
  readonly tasks: Task[];
  readonly byName: Map<string, Task>;
  readonly source: string;

  constructor(graph: Graph) {
    this.tasks = graph.tasks;
    this.source = graph.source;
    this.byName = new Map(graph.tasks.map((t) => [t.name, t]));
    for (const t of this.tasks) {
      for (const d of t.deps) {
        if (!this.byName.has(d)) throw new Error(`${t.name} depends on unknown ${d}`);
      }
    }
  }

  task(name: string): Task {
    const t = this.byName.get(name);
    if (!t) throw new Error(`unknown task '${name}'`);
    return t;
  }

  /** Aggregates like `ci` are not goals; they exist to name the whole set. */
  isMeta(name: string): boolean {
    return this.task(name).groups.includes(META_GROUP);
  }

  /**
   * The tasks a person would actually ask for: no non-meta recipe depends on
   * them. Prerequisites (`install`, `build-web`) are excluded on purpose --
   * nobody asks "is it worth running install?", the closure answers that.
   */
  goals(): Task[] {
    const needed = new Set<string>();
    for (const t of this.tasks) {
      if (this.isMeta(t.name)) continue;
      for (const d of t.deps) needed.add(d);
    }
    return this.tasks.filter((t) => !this.isMeta(t.name) && !needed.has(t.name));
  }

  /** Every prerequisite of `names`, plus `names`. What actually gets run. */
  closure(names: Iterable<string>): Set<string> {
    const out = new Set<string>();
    const walk = (name: string) => {
      if (out.has(name)) return;
      out.add(name);
      for (const d of this.task(name).deps) walk(d);
    };
    for (const n of names) walk(n);
    return out;
  }

  /** Tasks that depend on `names`, transitively. Meta recipes never count. */
  dependents(names: Iterable<string>): Set<string> {
    const reverse = new Map<string, string[]>();
    for (const t of this.tasks) {
      if (this.isMeta(t.name)) continue;
      for (const d of t.deps) reverse.set(d, [...(reverse.get(d) ?? []), t.name]);
    }
    const out = new Set<string>();
    const walk = (name: string) => {
      for (const up of reverse.get(name) ?? []) {
        if (out.has(up)) continue;
        out.add(up);
        walk(up);
      }
    };
    for (const n of names) walk(n);
    return out;
  }

  /** Machine seconds: what the run set costs if nothing runs in parallel. */
  serialCost(names: Iterable<string>): number {
    let total = 0;
    for (const n of names) total += this.task(n).cost;
    return total;
  }

  /**
   * Wall-clock seconds with unlimited parallelism: the longest dependency
   * chain through the run set. The graph is what makes this answerable, and it
   * is the number a person waiting on CI actually feels.
   */
  criticalPath(names: Iterable<string>): number {
    const set = new Set(names);
    const memo = new Map<string, number>();
    const depth = (name: string): number => {
      const hit = memo.get(name);
      if (hit !== undefined) return hit;
      let best = 0;
      for (const d of this.task(name).deps) {
        if (!set.has(d)) continue;
        best = Math.max(best, depth(d));
      }
      const total = best + this.task(name).cost;
      memo.set(name, total);
      return total;
    };
    let longest = 0;
    for (const n of set) longest = Math.max(longest, depth(n));
    return longest;
  }

  /** Topological order, so a printed run plan is a runnable one. */
  ordered(names: Iterable<string>): string[] {
    const set = new Set(names);
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = (name: string) => {
      if (seen.has(name) || !set.has(name)) return;
      seen.add(name);
      for (const d of this.task(name).deps) visit(d);
      out.push(name);
    };
    for (const n of [...set].sort()) visit(n);
    return out;
  }
}

// ---------------------------------------------------------------- globs

/**
 * `web/**`, `**\/*.ts`, `packages/*\/package.json`. A `*` stops at a slash and
 * `**` does not; that is the whole of it.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:[^/]+/)*"; // zero or more whole path segments
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}
