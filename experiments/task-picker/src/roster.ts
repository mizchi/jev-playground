/**
 * A task-runner roster, shaped like a real pnpm monorepo's `package.json`
 * scripts.
 *
 * The experiment mirrors docs/16: Jev is shown the task NAME and nothing else,
 * while the ground truth is defined by what the task's COMMAND actually does.
 * So `command` is the hidden implementation and the name is the spec, and a
 * task whose name oversells or undersells its command is the near-miss case.
 *
 * `tier` builds three roster sizes from one list, for the scale sweep:
 *   core (14) -> medium (53) -> large (133, package-scoped variants added).
 * The server accepts at most 255 choices (docs/00), so `large` is roughly half
 * the ceiling -- about as big as a real monorepo's script list gets.
 */
export interface Task {
  name: string;
  /** The real command. Hidden except in the `commands` arm. */
  command: string;
  /** One line of prose. Hidden except in the `descriptions` arm. */
  description: string;
  tier: "core" | "medium" | "large";
  /**
   * Set when the name and the command disagree -- the whole point of the
   * near-miss scenarios. Never sent to Jev.
   */
  misleading?: string;
}

export const TASKS: Task[] = [
  // ------------------------------------------------------------------ core
  {
    name: "dev",
    command: "vite dev --host",
    description: "Start the web app dev server with hot reload",
    tier: "core",
  },
  {
    name: "build",
    command: "tsc -b && vite build",
    description: "Type-check and bundle the web app for production",
    tier: "core",
  },
  {
    name: "test",
    command: "vitest run && playwright test",
    description: "Run the unit suite AND the browser suite (slow)",
    tier: "core",
    misleading:
      "The best-looking name for 'run the tests' also runs Playwright, so it " +
      "is the wrong answer whenever someone wants only unit tests.",
  },
  {
    name: "lint",
    command: "eslint . --max-warnings 0",
    description: "Report lint problems without fixing anything",
    tier: "core",
  },
  {
    name: "format",
    command: "prettier --write .",
    description: "Rewrite every file to the formatter's style",
    tier: "core",
  },
  {
    name: "typecheck",
    command: "tsc --noEmit",
    description: "Type-check against the default tsconfig, emitting nothing",
    tier: "core",
  },
  {
    name: "start",
    command: "node dist/server.js",
    description: "Run the already-built server from dist/",
    tier: "core",
  },
  {
    name: "clean",
    command: "rm -rf dist .turbo node_modules/.cache",
    description: "Delete build output and caches",
    tier: "core",
  },
  {
    name: "e2e",
    command: "playwright test",
    description: "Run the whole browser end-to-end suite headless",
    tier: "core",
  },
  {
    name: "db:migrate",
    command: "drizzle-kit migrate",
    description: "Apply pending database migrations",
    tier: "core",
  },
  {
    name: "db:seed",
    command: "tsx scripts/seed.ts",
    description: "Insert sample fixtures into the database",
    tier: "core",
  },
  {
    name: "release",
    command: "changeset publish",
    description: "Publish changed packages to the registry",
    tier: "core",
  },
  {
    name: "storybook",
    command: "storybook dev -p 6006",
    description: "Serve the component library browser",
    tier: "core",
  },
  {
    name: "bench",
    command: "vitest bench",
    description: "Run the micro-benchmark suite",
    tier: "core",
  },

  // ---------------------------------------------------------------- medium
  {
    name: "test:unit",
    command: "vitest run",
    description: "Run only the unit tests",
    tier: "medium",
  },
  {
    name: "test:watch",
    command: "vitest",
    description: "Re-run unit tests on every file change",
    tier: "medium",
  },
  {
    name: "test:ci",
    command: "vitest run --reporter junit --coverage",
    description: "Unit tests with coverage and JUnit output, for CI",
    tier: "medium",
  },
  {
    name: "test:coverage",
    command: "vitest run --coverage",
    description: "Unit tests with a human-readable coverage report",
    tier: "medium",
  },
  {
    name: "check",
    command: "eslint . --max-warnings 0 && tsc --noEmit && vitest run",
    description: "Lint, types and unit tests -- what CI gates on, minus the browser suite",
    tier: "medium",
    misleading:
      "The task people actually want before pushing, but the name says " +
      "nothing about lint, types or tests.",
  },
  {
    name: "ci",
    command: "npm run check && npm run build && npm run e2e",
    description: "The entire CI pipeline locally, browser suite included",
    tier: "medium",
  },
  {
    name: "precommit",
    command: "lint-staged",
    description: "Lint and format ONLY the files staged for commit",
    tier: "medium",
    misleading:
      "Sounds like the pre-push gate, but it only touches staged files and " +
      "runs no tests.",
  },
  {
    name: "verify",
    command: "tsc --noEmit -p tsconfig.strict.json",
    description: "Type-check against the strict config only",
    tier: "medium",
    misleading: "A broad-sounding name for a narrow task: strict type-check, nothing else.",
  },
  {
    name: "smoke",
    command: "playwright test --grep @smoke",
    description: "Run only the @smoke-tagged browser tests",
    tier: "medium",
  },
  {
    name: "lint:fix",
    command: "eslint . --fix",
    description: "Fix auto-fixable lint problems in place",
    tier: "medium",
  },
  {
    name: "lint:css",
    command: 'stylelint "**/*.css"',
    description: "Lint stylesheets",
    tier: "medium",
  },
  {
    name: "lint:md",
    command: 'markdownlint "**/*.md"',
    description: "Lint markdown files",
    tier: "medium",
  },
  {
    name: "build:web",
    command: "vite build --filter apps/web",
    description: "Bundle only the web app",
    tier: "medium",
  },
  {
    name: "build:api",
    command: "tsc -b apps/api",
    description: "Compile only the API service",
    tier: "medium",
  },
  {
    name: "build:docs",
    command: "typedoc --out docs/api src/index.ts",
    description: "Generate the API reference from TypeScript source",
    tier: "medium",
    misleading:
      "Looks like it builds the documentation site; it generates TypeDoc API " +
      "reference pages instead.",
  },
  {
    name: "build:storybook",
    command: "storybook build -o storybook-static",
    description: "Build the static Storybook bundle",
    tier: "medium",
  },
  {
    name: "dev:api",
    command: "tsx watch apps/api/src/main.ts",
    description: "Start only the API dev server",
    tier: "medium",
  },
  {
    name: "dev:web",
    command: "vite dev --filter apps/web",
    description: "Start only the web dev server",
    tier: "medium",
  },
  {
    name: "dev:docs",
    command: "vitepress dev docs",
    description: "Serve the documentation site with hot reload",
    tier: "medium",
  },
  {
    name: "db:reset",
    command: "drizzle-kit drop && drizzle-kit migrate && tsx scripts/seed.ts",
    description: "Drop, re-migrate and re-seed the database",
    tier: "medium",
  },
  {
    name: "db:studio",
    command: "drizzle-kit studio",
    description: "Open the database browser UI",
    tier: "medium",
  },
  {
    name: "db:generate",
    command: "drizzle-kit generate",
    description: "Write a new migration file from schema changes",
    tier: "medium",
  },
  {
    name: "e2e:headed",
    command: "playwright test --headed",
    description: "Run the browser suite with a visible browser",
    tier: "medium",
  },
  {
    name: "e2e:debug",
    command: "playwright test --debug",
    description: "Run the browser suite in the step debugger",
    tier: "medium",
  },
  {
    name: "e2e:update-snapshots",
    command: "playwright test --update-snapshots",
    description: "Accept the current rendering as the new snapshots",
    tier: "medium",
  },
  {
    name: "deploy:staging",
    command: "sst deploy --stage staging",
    description: "Deploy the current build to staging",
    tier: "medium",
  },
  {
    name: "deploy:prod",
    command: "sst deploy --stage production",
    description: "Deploy the current build to production",
    tier: "medium",
    misleading:
      "Deploys forward only. It cannot roll back, though a rollback request " +
      "reads as if this is the task.",
  },
  {
    name: "docker:build",
    command: "docker compose build",
    description: "Build the local container images",
    tier: "medium",
  },
  {
    name: "docker:up",
    command: "docker compose up -d",
    description: "Start the local service containers",
    tier: "medium",
  },
  {
    name: "docker:down",
    command: "docker compose down",
    description: "Stop the local service containers",
    tier: "medium",
  },
  {
    name: "codegen",
    command: "openapi-typescript openapi.json -o src/api.d.ts && graphql-codegen",
    description: "Regenerate every generated client: OpenAPI and GraphQL",
    tier: "medium",
  },
  {
    name: "codegen:graphql",
    command: "graphql-codegen",
    description: "Regenerate only the GraphQL types",
    tier: "medium",
  },
  {
    name: "i18n:extract",
    command: "formatjs extract 'src/**/*.tsx' --out-file lang/en.json",
    description: "Pull translatable strings out of the source",
    tier: "medium",
  },
  {
    name: "i18n:check",
    command: "formatjs verify lang/",
    description: "Check translation files for missing keys",
    tier: "medium",
  },
  {
    name: "analyze",
    command: "vite build --mode analyze && source-map-explorer dist/**/*.js",
    description: "Build and open a bundle-size breakdown",
    tier: "medium",
  },
  {
    name: "deps:check",
    command: "npm outdated",
    description: "List dependencies with newer versions available",
    tier: "medium",
  },
  {
    name: "deps:update",
    command: "npm update --save",
    description: "Bump dependencies within their ranges",
    tier: "medium",
  },
  {
    name: "audit",
    command: "npm audit --audit-level high",
    description: "Report known high-severity vulnerabilities",
    tier: "medium",
  },
  {
    name: "profile",
    command: "clinic flame -- node dist/server.js",
    description: "Record a CPU flamegraph of the server",
    tier: "medium",
  },
];

/**
 * The large tier is generated, because that is how monorepo rosters actually
 * get big: the same verbs repeated per package. Every generated task is
 * package-scoped, so it never competes with a repo-wide scenario.
 */
const PACKAGES = [
  "web", "api", "worker", "shared", "ui", "cli", "docs", "mobile", "sdk", "infra",
];
const VERBS: Array<[string, string, string]> = [
  ["build", "tsc -b", "Compile"],
  ["test", "vitest run --dir", "Unit-test"],
  ["test:watch", "vitest --dir", "Watch the unit tests of"],
  ["lint", "eslint", "Lint"],
  ["typecheck", "tsc --noEmit -p", "Type-check"],
  ["clean", "rm -rf", "Clear build output for"],
  ["dev", "tsx watch", "Start the dev server for"],
  ["build:watch", "tsc -b --watch", "Rebuild on change"],
];

for (const pkg of PACKAGES) {
  for (const [verb, cmd, prose] of VERBS) {
    TASKS.push({
      name: `${pkg}:${verb}`,
      command: `${cmd} packages/${pkg}`,
      description: `${prose} the ${pkg} package only`,
      tier: "large",
    });
  }
}

export type RosterSize = "core" | "medium" | "large";

export function roster(size: RosterSize): Task[] {
  const keep: Record<RosterSize, Task["tier"][]> = {
    core: ["core"],
    medium: ["core", "medium"],
    large: ["core", "medium", "large"],
  };
  return TASKS.filter((t) => keep[size].includes(t.tier));
}

export function taskByName(name: string): Task | undefined {
  return TASKS.find((t) => t.name === name);
}
