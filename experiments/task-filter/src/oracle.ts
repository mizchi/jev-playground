/**
 * The ground truth, and the reason it is a rule rather than an opinion.
 *
 * docs/17's honest limit was that the same person wrote the roster and the
 * labels. Here nothing is labelled by hand: a scenario plants a defect of a
 * KIND at a PATH, this file says which kinds each recipe can catch and over
 * which paths, and the failing set falls out of the two. So the question the
 * experiment asks is never "did Jev agree with me" but:
 *
 *     does the run set contain a task that would actually go red?
 *
 * None of this is ever shown to Jev. A recipe's name and its one line of prose
 * are the spec; what it can catch is the hidden behaviour, the same split
 * docs/16 and docs/17 used.
 */
import { matchesAny, type TaskGraph } from "./graph.js";
import type { DefectKind, Scenario } from "./scenarios.js";

interface Catches {
  kinds: DefectKind[];
  /** The paths this task's checking actually covers. */
  scope: string[];
}

export const CATCHES: Record<string, Catches> = {
  // Builds run the compiler, so they catch type errors in what they compile.
  // This is why selecting a browser suite can catch a type error it never
  // looks for: `e2e-web` pulls `build-web` in through the graph.
  "build-shared": { kinds: ["type"], scope: ["packages/shared/**"] },
  "build-ui": { kinds: ["type"], scope: ["packages/ui/**"] },
  "build-web": { kinds: ["type"], scope: ["web/**", "packages/*/src/**"] },
  "build-api": { kinds: ["type"], scope: ["api/**", "packages/*/src/**"] },

  "typecheck-web": { kinds: ["type"], scope: ["web/**", "packages/*/src/**"] },
  "typecheck-api": { kinds: ["type"], scope: ["api/**", "packages/*/src/**"] },
  lint: { kinds: ["lint"], scope: ["**/*.ts", "**/*.tsx"] },
  "fmt-check": { kinds: ["format"], scope: ["**"] },

  "test-shared": { kinds: ["unit"], scope: ["packages/shared/**"] },
  "test-ui": { kinds: ["unit"], scope: ["packages/ui/**"] },
  "test-web-unit": { kinds: ["unit"], scope: ["web/**"] },
  "test-api-unit": { kinds: ["unit"], scope: ["api/**"] },
  // Only a real database and a real cache see these.
  "test-api-integration": { kinds: ["integration", "migration"], scope: ["api/**"] },
  // Catches a migration that will not apply, not one the code has outlived.
  "db-migrate": { kinds: ["migration"], scope: ["api/migrations/**"] },

  "e2e-web": { kinds: ["e2e"], scope: ["web/**", "api/**"] },
  "e2e-auth": { kinds: ["e2e_auth"], scope: ["web/**", "api/**"] },
  a11y: { kinds: ["a11y"], scope: ["web/**", "packages/ui/**"] },
  "bundle-size": { kinds: ["bundle"], scope: ["web/**", "packages/ui/**"] },

  audit: { kinds: ["vuln"], scope: ["pnpm-lock.yaml"] },
  "license-check": { kinds: ["licence"], scope: ["pnpm-lock.yaml"] },

  "docs-links": { kinds: ["links"], scope: ["docs/**", "README.md"] },
  "docs-build": { kinds: ["docs_build"], scope: ["docs/**", "packages/*/src/**"] },
  "infra-validate": { kinds: ["infra"], scope: ["infra/**"] },
  "infra-plan": { kinds: ["infra"], scope: ["infra/**"] },
};

/** Which tasks go red on this scenario. Empty when the change breaks nothing. */
export function failingTasks(graph: TaskGraph, scenario: Scenario): Set<string> {
  const out = new Set<string>();
  const defect = scenario.defect;
  if (!defect) return out;
  for (const task of graph.tasks) {
    const c = CATCHES[task.name];
    if (!c) continue;
    if (!c.kinds.includes(defect.kind)) continue;
    if (!matchesAny(defect.at, c.scope)) continue;
    out.add(task.name);
  }
  return out;
}

/**
 * A scenario nothing can catch would score every strategy the same, so the
 * corpus is checked for that rather than trusted.
 */
export function unwinnable(graph: TaskGraph, scenarios: Scenario[]): Scenario[] {
  return scenarios.filter((s) => s.defect !== null && failingTasks(graph, s).size === 0);
}
