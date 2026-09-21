/**
 * WHICH PARTS OF THIS REPOSITORY RUN AS A PI AGENT, AND WHICH SEAM EACH TAKES.
 *
 * The six extensions live in `packages/jev-<name>/src/pi.ts` and each package is
 * already a Pi package in its own right (`pi: { extensions: ["./src/pi.ts"] }`).
 * What was missing is the assembly: one place that says *this repository, as a
 * Pi agent*, installable in one step, with the one way to get it wrong made
 * hard to reach.
 *
 * THIS FILE HOLDS WHAT EACH COMPONENT *IS*. It deliberately does NOT hold
 * which seams it registers -- `probe.ts` measures that by loading the factory
 * with a recording stub. A hand-written seam table is exactly the thing that
 * drifts from the code and then gets quoted in a report (docs/55 §6), so the
 * table in the README is printed, not typed.
 *
 * TWO PROFILES, AND THEY ARE ALTERNATIVES.
 *
 *   `components/`  the five separate extensions. One request per component per
 *                  turn, each independently switchable, which is what an
 *                  interactive session wants.
 *   `resident/`    `jev-hermes` alone. It re-implements all five INCLUDING the
 *                  guard on its own `tool_call` handler, batches the three
 *                  turn-time judgments into ONE request, and holds one shared
 *                  budget. That is what an always-on agent wants.
 *
 * Loading both double-books every seam: two gates on every tool call (two
 * confirmations, two blocks), three turn judgments where hermes already made
 * one, two deletions on every `context`. Pi's deduplication does not save you
 * -- identity is the package name, the git URL, or the resolved absolute path
 * (`pi-coding-agent/docs/packages.md`), and the two profiles are different
 * paths. So they are separate packages, `pi/` itself is deliberately NOT a
 * loadable package, and `test.ts` holds both of those in place.
 */

export interface Component {
  /** The entry filename under a profile's `extensions/`, without the suffix. */
  name: string;
  /** The workspace package that owns the code. The source of truth. */
  pkg: string;
  /** The subpath the entry imports. The same one an outside user would. */
  from: string;
  /** What it decides, in one line. */
  decides: string;
  /** Where the decision was measured. */
  doc: string;
}

/** The five separate components: `pi/components`. */
export const COMPONENTS: readonly Component[] = [
  {
    name: "jev-model-router",
    pkg: "packages/jev-model-router",
    from: "jev-model-router/pi",
    decides: "which model tier this turn needs, and pins it",
    doc: "docs/36-routers.md",
  },
  {
    name: "jev-skill-router",
    pkg: "packages/jev-skill-router",
    from: "jev-skill-router/pi",
    decides: "which skills to load for this turn, from a catalogue that never enters context",
    doc: "docs/29-skill-select.md, docs/30-skill-pick.md",
  },
  {
    name: "jev-orchestrator",
    pkg: "packages/jev-orchestrator",
    from: "jev-orchestrator/pi",
    decides: "whether to split this work, and into which topology",
    doc: "docs/31-orchestration.md, docs/53-fanout.md",
  },
  {
    name: "jev-guard",
    pkg: "packages/jev-guard",
    from: "jev-guard/pi",
    decides: "whether this tool call needs permission, and blocks or confirms",
    doc: "docs/18-permission-hook.md, docs/43-finish.md, docs/55-wild.md",
  },
  {
    name: "jev-compact",
    pkg: "packages/jev-compact",
    from: "jev-compact/pi",
    decides: "which transcript entries are spent, and deletes them from what is SENT",
    doc: "docs/39-compact-ranking.md, docs/45-floor.md, docs/48-keep.md",
  },
] as const;

/** The alternative: one extension that covers all five. `pi/resident`. */
export const RESIDENT: Component = {
  name: "hermes",
  pkg: "packages/jev-hermes",
  from: "jev-hermes/pi",
  decides: "all five, in one request per turn, under one budget",
  doc: "docs/37-hermes.md, docs/38-agent.md",
} as const;

export interface Profile {
  /** The directory under `pi/`, which is also what you hand `pi install`. */
  dir: string;
  what: string;
  /** Why you would pick this one. */
  when: string;
  components: readonly Component[];
}

export const PROFILES: readonly Profile[] = [
  {
    dir: "components",
    what: "the five separate extensions",
    when: "an interactive session: each component switchable on its own, and a failure is one component's",
    components: COMPONENTS,
  },
  {
    dir: "resident",
    what: "jev-hermes alone, which covers the same five",
    when: "an always-on agent: one request per turn, one budget, one status line",
    components: [RESIDENT],
  },
] as const;

/** Every component either profile can load. */
export const ALL: readonly Component[] = [...COMPONENTS, RESIDENT];
