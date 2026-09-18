/**
 * The situations the picker is asked about.
 *
 * `correct` holds the accepted task names, and is EMPTY for the scenarios
 * where no task in the roster does the job -- those exist to test the closed
 * world (docs/00): `choice` always picks something, so a roster with no right
 * answer is where a confident wrong pick shows up.
 *
 * Most scenarios accept exactly one task. A few accept two, because the
 * roster genuinely contains two tasks with the same effect (`dev` and
 * `dev:web` both start the web dev server) and no name-only picker could be
 * expected to split them; run.ts reports how many those are.
 *
 * `kind`:
 *  - `direct`   -- the task name says what the goal says
 *  - `decoy`    -- a lexically closer task exists and is wrong
 *  - `lying`    -- the right task's name undersells it, or a better-named task
 *                  does something else (the `misleading` tasks in roster.ts)
 *  - `escape`   -- nothing in the roster does this
 */
export interface Scenario {
  id: string;
  kind: "direct" | "decoy" | "lying" | "escape";
  /** What the developer wants, in their own words. */
  goal: string;
  correct: string[];
  /** Repo context for the structured state. */
  changedFiles?: string[];
  lastCommand?: { command: string; exit_code: number; output_tail: string };
  /** Why this is interesting. Never sent to Jev. */
  note?: string;
}

export const SCENARIOS: Scenario[] = [
  // ---------------------------------------------------------------- direct
  {
    id: "format_after_merge",
    kind: "direct",
    goal: "A big merge left formatting inconsistent. Rewrite every file to the formatter's style.",
    correct: ["format"],
    changedFiles: ["apps/web/src/App.tsx", "packages/shared/src/index.ts"],
  },
  {
    id: "dev_server",
    kind: "direct",
    goal: "I want a browser that reloads as I edit the React components.",
    correct: ["dev", "dev:web"],
    note: "Two tasks genuinely do this; both accepted.",
  },
  {
    id: "typecheck_only",
    kind: "direct",
    goal: "Type-check the repo without producing any output files.",
    correct: ["typecheck"],
  },
  {
    id: "run_e2e",
    kind: "direct",
    goal: "Run the whole browser end-to-end suite headless.",
    correct: ["e2e"],
  },
  {
    id: "clean_stale",
    kind: "direct",
    goal: "My dist folder is stale. Delete the build output and caches.",
    correct: ["clean"],
  },
  {
    id: "publish",
    kind: "direct",
    goal: "Publish the changed packages to the npm registry.",
    correct: ["release"],
    changedFiles: [".changeset/brave-pans-hug.md"],
  },
  {
    id: "component_browser",
    kind: "direct",
    goal: "Serve the component library browser so I can look at the design system.",
    correct: ["storybook"],
  },
  {
    id: "seed_db",
    kind: "direct",
    goal: "My local database is empty but already migrated. Insert the sample fixtures.",
    correct: ["db:seed"],
  },
  {
    id: "watch_tests",
    kind: "direct",
    goal: "Re-run the unit tests automatically every time I save a file.",
    correct: ["test:watch"],
  },
  {
    id: "outdated_deps",
    kind: "direct",
    goal: "List which dependencies have newer versions available.",
    correct: ["deps:check"],
  },
  {
    id: "docker_up",
    kind: "direct",
    goal: "Start the local service containers in the background.",
    correct: ["docker:up"],
  },
  {
    id: "apply_migrations",
    kind: "direct",
    goal: "Apply the two pending database migrations to my local database.",
    correct: ["db:migrate"],
    lastCommand: {
      command: "npm run dev:api",
      exit_code: 1,
      output_tail: "error: relation \"memberships\" does not exist",
    },
  },

  // ----------------------------------------------------------------- decoy
  {
    id: "autofix_lint",
    kind: "decoy",
    goal: "ESLint reports 40 problems and most are auto-fixable. Fix them in place.",
    correct: ["lint:fix"],
    lastCommand: {
      command: "npm run lint",
      exit_code: 1,
      output_tail: "40 problems (12 errors, 28 warnings), 31 potentially fixable",
    },
    note: "`lint` is the lexically closest task and is exactly the wrong one.",
  },
  {
    id: "graphql_only",
    kind: "decoy",
    goal:
      "The GraphQL schema changed. Regenerate only the GraphQL types -- leave the " +
      "OpenAPI client alone.",
    correct: ["codegen:graphql"],
    changedFiles: ["packages/shared/schema.graphql"],
    note: "`codegen` does both and is the shorter, more obvious name.",
  },
  {
    id: "coverage_report",
    kind: "decoy",
    goal:
      "I want to see which lines the unit tests miss, locally. I do not need a " +
      "JUnit file.",
    correct: ["test:coverage"],
    note: "`test:ci` also produces coverage, but bundles the CI reporter.",
  },
  {
    id: "wipe_db",
    kind: "decoy",
    goal:
      "My local database is in a broken half-migrated state. Wipe it completely and " +
      "get back to a fresh seeded database in one step.",
    correct: ["db:reset"],
    note: "`db:migrate` and `db:seed` are each half of the answer.",
  },
  {
    id: "watch_browser",
    kind: "decoy",
    goal: "Run the end-to-end tests with a visible browser so I can watch them run.",
    correct: ["e2e:headed"],
    note: "`e2e:debug` also shows a browser, but stops on every step.",
  },
  {
    id: "api_only_dev",
    kind: "decoy",
    goal: "Start only the API dev server. The web app is already running in another terminal.",
    correct: ["dev:api"],
  },
  {
    id: "api_reference",
    kind: "decoy",
    goal: "Generate the API reference pages from the TypeScript source.",
    correct: ["build:docs"],
    note: "`dev:docs` serves the docs site; the name that fits is build:docs.",
  },
  {
    id: "vuln_scan",
    kind: "decoy",
    goal: "Check the dependency tree for known high-severity vulnerabilities.",
    correct: ["audit"],
    note: "`deps:check` is about versions, not vulnerabilities.",
  },
  {
    id: "accept_snapshots",
    kind: "decoy",
    goal:
      "I intentionally changed the button styling and the Playwright snapshots now " +
      "differ. Accept the new rendering as correct.",
    correct: ["e2e:update-snapshots"],
    changedFiles: ["packages/ui/src/Button.css"],
  },
  {
    id: "bundle_grew",
    kind: "decoy",
    goal: "The production bundle grew by 200 KB. Find out what is taking the space.",
    correct: ["analyze"],
    note: "`build` and `build:web` produce the bundle but tell you nothing.",
  },

  // ----------------------------------------------------------------- lying
  {
    id: "pre_push_gate",
    kind: "lying",
    goal:
      "Before I push, run exactly what CI gates on -- lint, types and unit tests. " +
      "I do not want to wait for the browser suite.",
    correct: ["check"],
    note:
      "`test` looks right but runs Playwright too; `ci` adds the build and e2e; " +
      "`precommit` only touches staged files. The right answer is named `check`.",
  },
  {
    id: "unit_only",
    kind: "lying",
    goal: "Run only the unit tests. Nothing else, and definitely not the browser suite.",
    correct: ["test:unit"],
    note: "`test` is the obvious name and runs playwright as well.",
  },
  {
    id: "full_pipeline",
    kind: "lying",
    goal:
      "Reproduce the entire CI pipeline locally, including the production build and " +
      "the browser suite.",
    correct: ["ci"],
    note: "`check` stops short of build and e2e.",
  },
  {
    id: "strict_types",
    kind: "lying",
    goal: "Type-check the codebase against the strict tsconfig, not the default one.",
    correct: ["verify"],
    note: "`typecheck` is the default config; the strict one hides behind `verify`.",
  },
  {
    id: "staged_only",
    kind: "lying",
    goal: "Lint and format just the files I have staged for commit, nothing else.",
    correct: ["precommit"],
    note: "`lint`, `lint:fix` and `format` all run over the whole repo.",
  },
  {
    id: "smoke_only",
    kind: "lying",
    goal: "Run just the smoke-tagged browser tests, not the full suite.",
    correct: ["smoke"],
  },
  {
    id: "regen_all_clients",
    kind: "lying",
    goal: "Regenerate every generated client -- the OpenAPI types and the GraphQL types both.",
    correct: ["codegen"],
    note: "`codegen:graphql` is the more specific-looking name and does half the job.",
  },
  {
    id: "run_built_server",
    kind: "lying",
    goal:
      "I already ran the build. Now run the compiled server from dist, not a dev server.",
    correct: ["start"],
    note: "`dev` and `dev:api` are dev servers; `start` is the built one.",
  },

  // ---------------------------------------------------------------- escape
  {
    id: "add_dependency",
    kind: "escape",
    goal: "Add `zod` to the web package's dependencies.",
    correct: [],
  },
  {
    id: "rename_component",
    kind: "escape",
    goal: "Rename the `UserCard` component to `MemberCard` across the whole repo.",
    correct: [],
  },
  {
    id: "open_pr",
    kind: "escape",
    goal: "Open a pull request for my current branch.",
    correct: [],
  },
  {
    id: "bisect_regression",
    kind: "escape",
    goal: "Find which commit introduced the regression in the checkout flow.",
    correct: [],
  },
  {
    id: "rollback_prod",
    kind: "escape",
    goal: "Roll back the production deployment to yesterday's release.",
    correct: [],
    note: "`deploy:prod` exists and deploys forward only -- the tempting wrong pick.",
  },
  {
    id: "write_new_test",
    kind: "escape",
    goal: "Write a new end-to-end test for the password reset flow.",
    correct: [],
    note: "The roster runs tests; none of it writes one.",
  },
];
