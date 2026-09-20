/**
 * The projects, and the labels the catalog implies for them.
 *
 * A project is described the way the harness would actually see one: a file
 * tree, the `CLAUDE.md` lines that are in force, and one paragraph of what
 * the user is asking for. Nothing else -- no section names, no tiers, no
 * skill names beyond the ones that are ALSO the signal the catalog declares
 * (`justfile` is both a file and a skill; `test.ts` checks that list rather
 * than letting it drift).
 *
 * The label comes out of the catalog's own tier legend, applied to the
 * sections whose declared signals this project has:
 *
 *   T0  want           always, whatever the project is
 *   T1  want           when the section is present or asked for
 *   T2  want           only when the ask names that activity
 *   T3  mention        when the section is present -- prose, not the proposal
 *   T4  no             always; the catalog names an alternative instead
 *
 * The one interpretive choice: five sections declare no signals at all
 * (Reliability / Flakiness, Skill authoring, dotfiles, Writing, Migration).
 * Read literally, "suggest when the section's signals are present" can never
 * fire for them, so their T1 rows are `want` only when the ask names the
 * activity. docs/29 §2 states that choice and what it costs.
 */
import { type Row, type Snapshot, type Tier } from "./catalog.js";

export type Label = "want" | "mention" | "no";

export interface Project {
  id: string;
  blurb: string;
  /** Sections whose declared signals this project has. */
  signals: string[];
  /** Sections whose activity the ask explicitly names. */
  asked: string[];
  files: string[];
  claudeMd: string[];
  intent: string;
}

const NODE = "Languages / runtimes > Node.js / TypeScript";
const MOONBIT = "Languages / runtimes > MoonBit";
const GLEAM = "Languages / runtimes > Gleam";
const BUILD = "Tooling / Infra > Build / task running";
const LINT = "Tooling / Infra > Static analysis / lint";
const CI = "Tooling / Infra > CI / GitHub Actions";
const ACTRUN = "Tooling / Infra > Local CI runner";
const CLOUDFLARE = "Tooling / Infra > Cloudflare";
const AWS = "Tooling / Infra > AWS";
const K8S = "Tooling / Infra > Kubernetes";
const RELEASE = "Tooling / Infra > Release / changelog";
const DEPS = "Tooling / Infra > Dependency management";
const SQL = "Tooling / Infra > SQL / Database";
const BROWSER = "Testing / Browser";
const FRONTEND = "Testing / Browser > Frontend review (suite)";
const FLAKY = "Reliability / Flakiness";
const FORMAL = "Formal Methods / Verification";
const AUTHORING = "Process / Meta > Skill / prompt authoring";
const DOTFILES = "Process / Meta > Personal / dotfiles";
const WRITING = "Process / Meta > Writing / publishing";
const PORTING = "Process / Meta > Migration / porting";

export const SECTION_CONSTANTS = [
  NODE, MOONBIT, GLEAM, BUILD, LINT, CI, ACTRUN, CLOUDFLARE, AWS, K8S,
  RELEASE, DEPS, SQL, BROWSER, FRONTEND, FLAKY, FORMAL, AUTHORING, DOTFILES,
  WRITING, PORTING,
];

/**
 * Skill names that legitimately appear in a project's text, because the
 * catalog declares the same token as the section's signal. Kept explicit:
 * a skill name leaking into the input any OTHER way is the leak that would
 * quietly make this experiment easy.
 *
 * `test.ts` checks both directions -- every entry is really a signal the
 * catalog declares, AND every entry is really needed by some project. A
 * speculative exemption is how a leak gets in.
 */
export const NAME_OVERLAPS = ["justfile", "actrun"];

/**
 * Section headings a project's text may contain, for the same reason: the
 * catalog's groupings are mostly technology names, and a repo with a
 * `moon.mod.json` in it is a MoonBit repo whether or not the word is written
 * down. What must never appear is the STRUCTURE -- a heading path, a tier,
 * or the `Signals` line that defines the label.
 */
export const SECTION_OVERLAPS = ["Cloudflare", "MoonBit", "Gleam", "AWS", "Kubernetes"];

const NODE_FILES = ["package.json", "pnpm-lock.yaml", "tsconfig.json", "node_modules/"];
const CI_FILES = [".github/workflows/ci.yml", ".github/workflows/release.yml"];

export const PROJECTS: Project[] = [
  {
    id: "ts-cf-e2e",
    blurb: "TS web app on Cloudflare with Playwright E2E and GitHub Actions",
    signals: [NODE, CLOUDFLARE, BROWSER, CI],
    asked: [],
    files: [...NODE_FILES, ...CI_FILES, "wrangler.toml", "playwright.config.ts", "e2e/login.spec.ts", "src/index.ts", "vite.config.ts"],
    claudeMd: ["package manager: pnpm", "node: 24"],
    intent:
      "新規の TypeScript Web アプリを立ち上げる。Vite + React のフロントを Cloudflare Workers に deploy し、" +
      "E2E は Playwright、CI は GitHub Actions で回す。この構成に必要な skill を揃えてほしい。",
  },
  {
    id: "moonbit-lib",
    blurb: "MoonBit library published to npm, built with just",
    signals: [MOONBIT, BUILD, CI],
    asked: [],
    files: ["moon.mod.json", "moon.pkg.json", "_build/", ".mooncakes/", "justfile", "src/lib.mbt", ...CI_FILES],
    claudeMd: ["task runner: just", "target: js"],
    intent:
      "MoonBit で書いたライブラリを js target でビルドして npm に出している。" +
      "コードレビューとビルド周りを手伝ってほしい。",
  },
  {
    id: "d1-worker",
    blurb: "Cloudflare Worker over D1 with a sqlc query catalog",
    signals: [NODE, CLOUDFLARE, SQL],
    asked: [],
    files: [...NODE_FILES, "wrangler.toml", "sqlc.yaml", "db/schema.sql", "db/queries/user.sql", "db/queries/order.sql", "src/worker.ts"],
    claudeMd: ["database: Cloudflare D1"],
    intent:
      "D1 の上に載っている Worker のクエリカタログを整備したい。スキーマとクエリの安全性を見てほしい。",
    },
  {
    id: "frontend-review",
    blurb: "React app whose owner wants the structured weekly review pass",
    signals: [NODE, BROWSER, CI, FRONTEND],
    asked: [FRONTEND],
    files: [...NODE_FILES, ...CI_FILES, "playwright.config.ts", "e2e/smoke.spec.ts", "src/App.tsx", "src/store/atoms.ts"],
    claudeMd: ["framework: React 19", "state: Jotai"],
    intent:
      "React アプリに対して、構造化されたレビューパス (CI / hygiene / deps / testing / security / state / performance) を" +
      "毎週まわす体制を作りたい。まずレビュー観点を一通り揃えてほしい。",
  },
  {
    id: "aws-ecs",
    blurb: "ECS/Fargate service released by tag, OIDC from Actions",
    signals: [AWS, CI, RELEASE],
    asked: [],
    files: [...CI_FILES, ".github/workflows/deploy.yml", "CHANGELOG.md", "task-definition.json", "Dockerfile"],
    claudeMd: ["cloud: AWS", "deploy: ECS Fargate"],
    intent:
      "ECS Fargate のサービスを GitHub Actions から OIDC で deploy している。リリースは version tag 駆動で、" +
      "changelog も自動生成したい。認証周りのロール設計を含めて整えてほしい。",
  },
  {
    id: "gleam-api",
    blurb: "Gleam HTTP service in a devbox environment",
    signals: [GLEAM, BUILD],
    asked: [],
    files: ["gleam.toml", "manifest.toml", ".gleam_version", "devbox.json", "src/app.gleam", "test/app_test.gleam"],
    claudeMd: ["dev env: devbox"],
    intent: "Gleam の HTTP サービスを Erlang target で書いている。実装レビューと開発環境の再現性を見てほしい。",
  },
  {
    id: "flaky-suite",
    blurb: "Node test suite that is red at random, and the owner says so",
    signals: [NODE, CI],
    asked: [FLAKY],
    files: [...NODE_FILES, ...CI_FILES, "src/queue.ts", "test/queue.test.ts"],
    claudeMd: ["test runner: vitest"],
    intent:
      "CI のテストがランダムに落ちる。落ちるテストを検出して隔離する仕組みを入れて、履歴を残したい。" +
      "フレーキーテストの運用を継続的にやりたい。",
  },
  {
    id: "dup-hunt",
    blurb: "TypeScript monorepo where the ask is duplicate-code detection",
    signals: [NODE, LINT],
    asked: [LINT],
    files: [...NODE_FILES, "sgconfig.yml", "packages/api/src/index.ts", "packages/web/src/index.ts"],
    claudeMd: ["lint: structural rules that ESLint cannot express"],
    intent:
      "TypeScript の monorepo で同じようなコードが増えてきた。重複コードを機械的に検出したい。" +
      "ESLint では書けないリポジトリ固有のルールも足したい。",
  },
  {
    id: "article-draft",
    blurb: "Writing a post, no code project attached",
    signals: [],
    asked: [WRITING],
    files: ["drafts/otel-on-workers.md", "drafts/assets/diagram.png"],
    claudeMd: [],
    intent: "技術記事の下書きを書いている。公開前に文章として通るか、再現手順が揃っているかを見てほしい。",
  },
  {
    id: "k8s-crd",
    blurb: "TS operator generating CRDs from a typed schema",
    signals: [NODE, K8S],
    asked: [],
    files: [...NODE_FILES, "k8s/crd/widget.yaml", "k8s/deployment.yaml", "src/schema.ts", "src/gen-crd.ts"],
    claudeMd: ["schema: zod"],
    intent: "zod のスキーマから Kubernetes の CRD を生成している。生成物が正しいか見てほしい。",
  },
  {
    id: "dep-audit",
    blurb: "Yearly dependency sweep on a Node service",
    signals: [NODE, DEPS, CI],
    asked: [],
    files: [...NODE_FILES, ...CI_FILES, "src/server.ts"],
    claudeMd: [],
    intent:
      "pnpm outdated が大量に出ていて、security alert も溜まっている。まとめて更新したい。" +
      "年次のメンテナンスとしてやる。",
  },
  {
    id: "formal-config",
    blurb: "Config consistency question, asked in formal-methods language",
    signals: [NODE, FORMAL],
    asked: [],
    files: [...NODE_FILES, "config/prod.yaml", "config/staging.yaml", "src/authz.ts"],
    claudeMd: [],
    intent:
      "authz の設定とコードが一致しているか確かめたい。TLA+ か Z3 のような形式手法で、" +
      "設定の整合性と認可の健全性を検証できないか。",
  },
  {
    id: "act-local",
    blurb: "Wants to run the Actions workflows locally",
    signals: [NODE, CI, ACTRUN],
    asked: [ACTRUN],
    files: [...NODE_FILES, ...CI_FILES, "actrun.toml", "src/cli.ts"],
    claudeMd: [],
    intent:
      "GitHub Actions の workflow を手元で回して確認したい。ローカル実行が落ちたときの原因も追いたい。",
  },
  {
    id: "bare-repo",
    blurb: "A repo with almost no signal: the negative control",
    signals: [],
    asked: [],
    files: ["README.md", "LICENSE", "notes/scratch.txt"],
    claudeMd: [],
    intent: "まだ何も決まっていないリポジトリ。とりあえず中身を整理したい。",
  },
];

const RANK: Record<Label, number> = { no: 0, mention: 1, want: 2 };

/** The label for one catalog row under one project. */
export function labelForRow(row: Row, project: Project): Label {
  const present = project.signals.includes(row.section) || project.asked.includes(row.section);
  const asked = project.asked.includes(row.section);
  const byTier: Record<Tier, Label> = {
    T0: "want",
    T1: present ? "want" : "no",
    T2: asked ? "want" : "no",
    T3: present ? "mention" : "no",
    T4: "no",
  };
  return byTier[row.tier];
}

export interface Candidate {
  skill: string;
  description: string;
  /** Every row the catalog has for this skill: one skill can be listed twice. */
  rows: Row[];
  label: Label;
}

/**
 * The candidate list for a project: one entry per SKILL, not per row.
 *
 * `ts2moonbit-migration` is in the catalog twice (T1 under MoonBit, T3 under
 * Migration), so a skill's label is the most eager one any of its rows
 * implies. Only skills whose own `description:` could be read are
 * candidates -- that string is what a harness actually has.
 */
export function candidates(snapshot: Snapshot, project: Project): Candidate[] {
  const bySkill = new Map<string, Row[]>();
  for (const row of snapshot.rows) {
    if (!row.description) continue;
    const rows = bySkill.get(row.skill) ?? [];
    rows.push(row);
    bySkill.set(row.skill, rows);
  }
  return [...bySkill].map(([skill, rows]) => {
    let label: Label = "no";
    for (const row of rows) {
      const l = labelForRow(row, project);
      if (RANK[l] > RANK[label]) label = l;
    }
    return { skill, description: rows[0].description, rows, label };
  });
}

/** The project as text, which is all any arm gets to see. */
export function projectText(project: Project): string {
  const lines = [
    "files:",
    ...project.files.map((f) => `  ${f}`),
    ...(project.claudeMd.length > 0 ? ["CLAUDE.md:", ...project.claudeMd.map((l) => `  ${l}`)] : []),
    "request:",
    `  ${project.intent}`,
  ];
  return lines.join("\n");
}
