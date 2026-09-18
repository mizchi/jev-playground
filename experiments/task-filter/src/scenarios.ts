/**
 * The corpus: twenty branches, each a real unified diff against the monorepo
 * the justfile describes.
 *
 * A scenario carries no goal sentence. docs/17 fed Jev a sentence that said
 * what the person wanted ("I want to lint only the staged files") and found
 * that repository context then changed nothing -- the sentence had already
 * said everything. Here the diff IS the request, which is the case docs/17 §8
 * left open, so the only inputs are what a pre-commit hook actually holds: a
 * branch name, a commit subject, and the patch.
 *
 * `defect` is the planted ground truth and is never shown to Jev. Its `at` is
 * the path where the failure SURFACES, which is not always a path the diff
 * touches -- a schema change surfaces in the web app, a migration surfaces in
 * the repository layer. That is the whole reason a dependency graph exists,
 * and it keeps the oracle (src/oracle.ts) a rule rather than a judgment.
 */

export type DefectKind =
  | "type"
  | "lint"
  | "format"
  | "unit"
  | "integration"
  | "migration"
  | "e2e"
  | "e2e_auth"
  | "a11y"
  | "bundle"
  | "vuln"
  | "licence"
  | "links"
  | "docs_build"
  | "infra";

export interface ChangedFile {
  path: string;
  status: "modified" | "added" | "deleted";
  added: number;
  removed: number;
  /** The patch body, as `git diff` prints it. */
  hunk: string;
}

export interface Scenario {
  id: string;
  branch: string;
  subject: string;
  files: ChangedFile[];
  /**
   * The planted failure, or null for a change that breaks nothing.
   * `at` is where it surfaces; `why` is fixture documentation only.
   */
  defect: { kind: DefectKind; at: string; why: string } | null;
  /**
   * How the diff reads, for the by-kind table:
   *   narrow   -- one suite can catch it and the rest is waste
   *   broad    -- it reaches across packages
   *   cosmetic -- it cannot change behaviour at all
   */
  shape: "narrow" | "broad" | "cosmetic";
}

export const SCENARIOS: Scenario[] = [
  // ------------------------------------------------- 1. a type error in web
  {
    id: "web_type_break",
    branch: "feat/cart-v2-payload",
    subject: "web: return the v2 cart payload from the client",
    shape: "narrow",
    defect: {
      kind: "type",
      at: "web/src/hooks/useCart.ts",
      why: "the caller still reads .items, which CartV2 renames to .lines",
    },
    files: [
      {
        path: "web/src/api/client.ts",
        status: "modified",
        added: 4,
        removed: 4,
        hunk: `@@ -12,10 +12,10 @@ import type { Cart, CartV2 } from "@acme/shared";

-export async function fetchCart(id: string): Promise<Cart> {
+export async function fetchCart(id: string): Promise<CartV2> {
   const res = await fetch(\`/api/carts/\${id}\`, { headers: authHeaders() });
   if (!res.ok) throw new ApiError(res.status, "cart");
-  return (await res.json()) as Cart;
+  return (await res.json()) as CartV2;
 }`,
      },
    ],
  },

  // ------------------------------------------------- 2. a unit bug in shared
  {
    id: "shared_rounding_bug",
    branch: "fix/vat-rounding",
    subject: "shared: round VAT half-up instead of half-even",
    shape: "narrow",
    defect: {
      kind: "unit",
      at: "packages/shared/src/money.ts",
      why: "the existing table test pins half-even for 2.345",
    },
    files: [
      {
        path: "packages/shared/src/money.ts",
        status: "modified",
        added: 3,
        removed: 6,
        hunk: `@@ -41,12 +41,9 @@ export function withVat(amount: Minor, rate: Rate): Minor {

 export function round(value: number): number {
-  const floor = Math.floor(value);
-  const diff = value - floor;
-  if (diff > 0.5) return floor + 1;
-  if (diff < 0.5) return floor;
-  return floor % 2 === 0 ? floor : floor + 1;
+  // Finance asked for the rule everyone expects: .5 always goes up.
+  return Math.floor(value + 0.5);
 }`,
      },
    ],
  },

  // ------------------------------------------------- 3. the auth flow only
  {
    id: "auth_cookie_regression",
    branch: "chore/shorten-session",
    subject: "api: shorten the session cookie to 15 minutes",
    shape: "narrow",
    defect: {
      kind: "e2e_auth",
      at: "api/src/auth/session.ts",
      why: "the sign-in spec waits 20 minutes of fake time and expects to stay signed in",
    },
    files: [
      {
        path: "api/src/auth/session.ts",
        status: "modified",
        added: 2,
        removed: 2,
        hunk: `@@ -8,8 +8,8 @@ const COOKIE = "acme_sid";

 export function issue(res: Response, user: UserId): void {
-  // Two weeks, refreshed on every request.
-  setCookie(res, COOKIE, sign(user), { maxAge: 14 * 24 * 3600, httpOnly: true });
+  // Security review asked for a short window.
+  setCookie(res, COOKIE, sign(user), { maxAge: 15 * 60, httpOnly: true });
 }`,
      },
    ],
  },

  // ------------------------------------------------- 4. a migration the code outlives
  {
    id: "migration_drops_column",
    branch: "feat/drop-legacy-total",
    subject: "api: drop orders.legacy_total",
    shape: "narrow",
    defect: {
      kind: "integration",
      at: "api/src/repo/orders.ts",
      why: "the repository still SELECTs legacy_total, which only a real database notices",
    },
    files: [
      {
        path: "api/migrations/0042_drop_legacy_total.sql",
        status: "added",
        added: 3,
        removed: 0,
        hunk: `@@ -0,0 +1,3 @@
+-- The column has been written-but-never-read since the v3 pricing rollout.
+ALTER TABLE orders DROP COLUMN legacy_total;
+`,
      },
    ],
  },

  // ------------------------------------------------- 5. a vulnerable bump
  {
    id: "lockfile_vuln",
    branch: "chore/bump-tar",
    subject: "deps: bump the transitive tar to 6.1.9",
    shape: "narrow",
    defect: {
      kind: "vuln",
      at: "pnpm-lock.yaml",
      why: "6.1.9 is the range with the path-traversal advisory",
    },
    files: [
      {
        path: "pnpm-lock.yaml",
        status: "modified",
        added: 4,
        removed: 4,
        hunk: `@@ -8814,10 +8814,10 @@ packages:

-  /tar@6.2.1:
-    resolution: {integrity: sha512-8m4b0s...}
+  /tar@6.1.9:
+    resolution: {integrity: sha512-kb5Zx1...}
     engines: {node: '>=10'}
     dependencies:
-      minipass: 5.0.0
+      minipass: 3.3.6
     dev: true`,
      },
    ],
  },

  // ------------------------------------------------- 6. a licence that is not allowed
  {
    id: "lockfile_licence",
    branch: "feat/pdf-export",
    subject: "deps: add a PDF renderer for the invoice export",
    shape: "narrow",
    defect: {
      kind: "licence",
      at: "pnpm-lock.yaml",
      why: "the new renderer is AGPL-3.0, which the allowed list rejects",
    },
    files: [
      {
        path: "pnpm-lock.yaml",
        status: "modified",
        added: 6,
        removed: 0,
        hunk: `@@ -5120,6 +5120,12 @@ packages:

+  /pdf-forge@4.2.0:
+    resolution: {integrity: sha512-Qb9vTt...}
+    engines: {node: '>=18'}
+    dependencies:
+      fontkit: 2.0.2
+    dev: false
+`,
      },
      {
        path: "api/package.json",
        status: "modified",
        added: 1,
        removed: 0,
        hunk: `@@ -18,6 +18,7 @@
     "fastify": "4.26.2",
+    "pdf-forge": "4.2.0",
     "pg": "8.11.5",`,
      },
    ],
  },

  // ------------------------------------------------- 7. accessibility only
  {
    id: "ui_aria_removed",
    branch: "feat/icon-button-tooltip",
    subject: "ui: replace the icon button's label with a tooltip",
    shape: "narrow",
    defect: {
      kind: "a11y",
      at: "packages/ui/src/IconButton.tsx",
      why: "a tooltip is not an accessible name, so the axe rule fails",
    },
    files: [
      {
        path: "packages/ui/src/IconButton.tsx",
        status: "modified",
        added: 3,
        removed: 3,
        hunk: `@@ -14,9 +14,9 @@ export function IconButton({ icon, label, onClick }: Props) {
   return (
-    <button aria-label={label} onClick={onClick} className={styles.icon}>
-      <Icon name={icon} />
-    </button>
+    <Tooltip content={label}>
+      <button onClick={onClick} className={styles.icon}><Icon name={icon} /></button>
+    </Tooltip>
   );
 }`,
      },
    ],
  },

  // ------------------------------------------------- 8. bundle budget only
  {
    id: "bundle_moment",
    branch: "feat/report-date-ranges",
    subject: "web: format report ranges with moment",
    shape: "narrow",
    defect: {
      kind: "bundle",
      at: "web/src/routes/reports.tsx",
      why: "moment plus its locales is 230 kB over the route's budget",
    },
    files: [
      {
        path: "web/src/routes/reports.tsx",
        status: "modified",
        added: 3,
        removed: 1,
        hunk: `@@ -1,8 +1,10 @@
+import moment from "moment";
 import { useReports } from "../hooks/useReports";

 function range(from: Date, to: Date): string {
-  return \`\${from.toISOString().slice(0, 10)} - \${to.toISOString().slice(0, 10)}\`;
+  return \`\${moment(from).format("ll")} - \${moment(to).format("ll")}\`;
 }`,
      },
    ],
  },

  // ------------------------------------------------- 9. a dead documentation link
  {
    id: "docs_dead_link",
    branch: "docs/split-deploy-guide",
    subject: "docs: split the deploy guide in two",
    shape: "narrow",
    defect: {
      kind: "links",
      at: "docs/guide/deploy.md",
      why: "./rollback.md moved to ../operations/rollback.md and three links still point at the old path",
    },
    files: [
      {
        path: "docs/guide/deploy.md",
        status: "modified",
        added: 2,
        removed: 8,
        hunk: `@@ -60,14 +60,8 @@ Promote the release once the smoke checks pass.

-## Rolling back
-
-Roll back with the previous release's tag; the runbook walks through it.
-See [the rollback runbook](./rollback.md) for the exact commands, and
-[the incident template](./rollback.md#incident) for the write-up.
-
-If the rollback fails, page the on-call engineer listed in
-[the rotation](./rollback.md#rotation).
+## Rolling back
+
+Rolling back now lives in [the operations guide](./rollback.md).`,
      },
      {
        path: "docs/operations/rollback.md",
        status: "added",
        added: 42,
        removed: 0,
        hunk: `@@ -0,0 +1,42 @@
+# Rolling back a release
+
+Roll back with the previous release's tag.
+... (42 lines moved out of the deploy guide)`,
      },
    ],
  },

  // ------------------------------------------------- 10. infrastructure only
  {
    id: "infra_instance_size",
    branch: "chore/right-size-workers",
    subject: "infra: move the workers to c7g.large",
    shape: "narrow",
    defect: {
      kind: "infra",
      at: "infra/main.tf",
      why: "the instance type is not available in one of the two configured AZs, which only the plan resolves",
    },
    files: [
      {
        path: "infra/main.tf",
        status: "modified",
        added: 2,
        removed: 2,
        hunk: `@@ -84,8 +84,8 @@ resource "aws_launch_template" "worker" {

-  instance_type = "m6i.large"
-  # Graviton migration tracked in INFRA-812.
+  instance_type = "c7g.large"
+  # Graviton migration, INFRA-812.
   image_id      = data.aws_ami.worker.id`,
      },
    ],
  },

  // ------------------------------------------------- 11. the schema, surfacing in web
  {
    id: "schema_nonnull",
    branch: "feat/require-display-name",
    subject: "api: make User.displayName non-null",
    shape: "broad",
    defect: {
      kind: "type",
      at: "web/src/pages/Profile.tsx",
      why: "codegen drops the null branch and the page still guards with ?? '(anonymous)'",
    },
    files: [
      {
        path: "api/schema.graphql",
        status: "modified",
        added: 1,
        removed: 1,
        hunk: `@@ -22,7 +22,7 @@ type User {
   id: ID!
-  displayName: String
+  displayName: String!
   email: String!`,
      },
      {
        path: "api/src/resolvers/user.ts",
        status: "modified",
        added: 1,
        removed: 1,
        hunk: `@@ -30,7 +30,7 @@ export const userResolvers = {
-    displayName: (u: UserRow) => u.display_name,
+    displayName: (u: UserRow) => u.display_name ?? u.email.split("@")[0],`,
      },
    ],
  },

  // ------------------------------------------------- 12. lint only
  {
    id: "lint_console",
    branch: "fix/log-request-ids",
    subject: "web: log the request id when a call fails",
    shape: "narrow",
    defect: {
      kind: "lint",
      at: "web/src/utils/log.ts",
      why: "no-console is an error and the unused ApiError import trips no-unused-vars",
    },
    files: [
      {
        path: "web/src/utils/log.ts",
        status: "modified",
        added: 4,
        removed: 1,
        hunk: `@@ -1,7 +1,10 @@
+import { ApiError } from "../api/errors";
 import { reporter } from "./reporter";

 export function logFailure(requestId: string, err: unknown): void {
-  reporter.capture(err, { requestId });
+  console.log("request failed", requestId, err);
+  reporter.capture(err, { requestId });
 }`,
      },
    ],
  },

  // ------------------------------------------------- 13. formatting only
  {
    id: "unformatted_edit",
    branch: "fix/health-probe-timeout",
    subject: "api: give the health probe a 2s timeout",
    shape: "narrow",
    defect: {
      kind: "format",
      at: "api/src/routes/health.ts",
      why: "hand-edited with three-space indentation and a 118-column line",
    },
    files: [
      {
        path: "api/src/routes/health.ts",
        status: "modified",
        added: 5,
        removed: 3,
        hunk: `@@ -10,9 +10,11 @@ export function healthRoutes(app: App): void {
   app.get("/healthz", async (_req, reply) => {
-    const db = await pingDatabase();
-    const cache = await pingCache();
-    return reply.send({ db, cache });
+   const db = await pingDatabase({ timeoutMs: 2000 });
+   const cache = await pingCache({ timeoutMs: 2000 });
+   return reply.send({ db, cache, checkedAt: new Date().toISOString(), version: process.env.RELEASE ?? "dev" });
   });
 }`,
      },
    ],
  },

  // ------------------------------------------------- 14. a web unit bug
  {
    id: "web_unit_offbyone",
    branch: "fix/pagination-last-page",
    subject: "web: stop the pager one page early",
    shape: "narrow",
    defect: {
      kind: "unit",
      at: "web/src/hooks/usePagination.ts",
      why: "the suite asserts 4 pages for 31 items at 10 per page",
    },
    files: [
      {
        path: "web/src/hooks/usePagination.ts",
        status: "modified",
        added: 1,
        removed: 1,
        hunk: `@@ -18,7 +18,7 @@ export function usePagination(total: number, perPage: number) {
-  const pages = Math.ceil(total / perPage);
+  const pages = Math.floor(total / perPage);
   const clamp = (n: number) => Math.min(Math.max(n, 1), pages);`,
      },
    ],
  },

  // ------------------------------------------------- 15. the browser suite only
  {
    id: "e2e_testid_rename",
    branch: "refactor/checkout-testids",
    subject: "web: rename the checkout test ids to kebab-case",
    shape: "narrow",
    defect: {
      kind: "e2e",
      at: "web/src/components/Checkout.tsx",
      why: "the browser specs select data-testid=submitOrder, which nothing else references",
    },
    files: [
      {
        path: "web/src/components/Checkout.tsx",
        status: "modified",
        added: 2,
        removed: 2,
        hunk: `@@ -52,10 +52,10 @@ export function Checkout({ cart }: Props) {
   return (
     <form onSubmit={submit}>
-      <TotalRow data-testid="cartTotal" value={cart.total} />
-      <button data-testid="submitOrder" type="submit">Pay</button>
+      <TotalRow data-testid="cart-total" value={cart.total} />
+      <button data-testid="submit-order" type="submit">Pay</button>
     </form>
   );
 }`,
      },
    ],
  },

  // ------------------------------------------------- 16. a comment, in the hottest file
  {
    id: "comment_typo",
    branch: "docs/fix-money-comment",
    subject: "shared: fix a typo in the money docs",
    shape: "cosmetic",
    defect: null,
    files: [
      {
        path: "packages/shared/src/money.ts",
        status: "modified",
        added: 2,
        removed: 2,
        hunk: `@@ -1,10 +1,10 @@
 /**
- * Money is always minor units (cents). Never a float, never a string.
- * Convertions happen at the edges only.
+ * Money is always minor units (cents). Never a float, never a string.
+ * Conversions happen at the edges only.
  */
 export type Minor = number & { readonly __minor: unique symbol };`,
      },
    ],
  },

  // ------------------------------------------------- 17. a badge
  {
    id: "readme_badge",
    branch: "docs/ci-badge",
    subject: "README: point the badge at the renamed workflow",
    shape: "cosmetic",
    defect: null,
    files: [
      {
        path: "README.md",
        status: "modified",
        added: 1,
        removed: 1,
        hunk: `@@ -1,6 +1,6 @@
 # acme

-[![build](https://github.com/acme/acme/actions/workflows/build.yml/badge.svg)](https://github.com/acme/acme/actions/workflows/build.yml)
+[![ci](https://github.com/acme/acme/actions/workflows/ci.yml/badge.svg)](https://github.com/acme/acme/actions/workflows/ci.yml)`,
      },
    ],
  },

  // ------------------------------------------------- 18. a test, and nothing else
  {
    id: "test_only_case",
    branch: "test/pagination-edges",
    subject: "web: cover the single-page pager",
    shape: "narrow",
    defect: null,
    files: [
      {
        path: "web/tests/usePagination.test.ts",
        status: "modified",
        added: 8,
        removed: 0,
        hunk: `@@ -24,6 +24,14 @@ describe("usePagination", () => {
     expect(result.current.pages).toBe(4);
   });

+  it("keeps a single page when everything fits", () => {
+    const { result } = renderHook(() => usePagination(7, 10));
+    expect(result.current.pages).toBe(1);
+    expect(result.current.next()).toBe(1);
+  });
+
   it("clamps below one", () => {`,
      },
    ],
  },

  // ------------------------------------------------- 19. a removal that looks dangerous
  {
    id: "dead_export_removed",
    branch: "chore/drop-legacy-formatter",
    subject: "shared: drop the unused legacy formatter",
    shape: "broad",
    defect: null,
    files: [
      {
        path: "packages/shared/src/index.ts",
        status: "modified",
        added: 0,
        removed: 1,
        hunk: `@@ -8,7 +8,6 @@ export { withVat, round } from "./money";
 export type { Minor, Rate } from "./money";
-export { formatLegacyTotal } from "./legacy";`,
      },
      {
        path: "packages/shared/src/legacy.ts",
        status: "deleted",
        added: 0,
        removed: 24,
        hunk: `@@ -1,24 +0,0 @@
-// Superseded by withVat() in the v3 pricing rollout; no importers remain.
-export function formatLegacyTotal(minor: number): string {
-  ...
-}`,
      },
    ],
  },

  // ------------------------------------------------- 20. a dev-only script
  {
    id: "dev_script_tweak",
    branch: "chore/dev-port",
    subject: "web: move the dev server to port 5174",
    shape: "cosmetic",
    defect: null,
    files: [
      {
        path: "web/package.json",
        status: "modified",
        added: 1,
        removed: 1,
        hunk: `@@ -5,7 +5,7 @@
   "scripts": {
-    "dev": "vite dev --host --port 5173",
+    "dev": "vite dev --host --port 5174",
     "build": "vite build",`,
      },
    ],
  },
];

export const WITH_DEFECT = SCENARIOS.filter((s) => s.defect !== null);
export const NO_DEFECT = SCENARIOS.filter((s) => s.defect === null);

export function changedPaths(s: Scenario): string[] {
  return s.files.map((f) => f.path);
}
