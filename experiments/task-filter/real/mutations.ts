/**
 * Real edits to this repository, applied one at a time to a clean HEAD.
 *
 * The one thing to understand about this file: **it does not say what should
 * fail.** docs/23's corpus declared a defect kind and a path, and a rule I
 * wrote decided which recipes that defect would fail -- both halves mine. Here
 * only the edit is mine. Which recipes go red is discovered by running all of
 * them (src/observe.ts), so there is no `expected` field to be wrong about,
 * and a mutation that turns out to break nothing, or to break something I did
 * not think of, is a result rather than a bug in the fixture.
 *
 * Each edit is one a person could plausibly write. Several are the exact
 * mistake a source comment warns against, which is the nearest thing to a
 * naturally occurring defect that does not require waiting for one.
 *
 * `find` must appear EXACTLY ONCE in `file`; real/observe-mutations.ts checks
 * that before applying anything.
 */

export interface Mutation {
  id: string;
  /** What a branch doing this would be called, and its commit subject. */
  branch: string;
  subject: string;
  file: string;
  find: string;
  replace: string;
  /** Why someone would write this. Never shown to Jev; documentation only. */
  rationale: string;
}

export const MUTATIONS: Mutation[] = [
  // -------------------------------------------------- the MoonBit API client
  {
    id: "lib_choice_ceiling",
    branch: "chore/raise-choice-ceiling",
    subject: "lib: raise the choice ceiling to 256",
    file: "lib/types.mbt",
    find: "pub let max_choices : Int = 255",
    replace: "pub let max_choices : Int = 256",
    rationale:
      "A plausible reading of the limit as a power of two. docs/00 measured it " +
      "at 255 against the real API, so the constant is a recorded fact.",
  },
  {
    id: "lib_wire_key",
    branch: "refactor/singular-field-names",
    subject: "lib: singularise the instructions field",
    file: "lib/types.mbt",
    find: 'obj["instructions"] = opt_json(instructions)',
    replace: 'obj["instruction"] = opt_json(instructions)',
    rationale:
      "The wire format's own trap: docs/00 records that the server accepts a " +
      "wrong shape with a 200 and silently drops it, which is why lib pins the " +
      "bytes in a test.",
  },

  // -------------------------------------------------- the two jevlang implementations
  {
    id: "jevlang_js_rounding",
    branch: "refactor/simplify-number-format",
    subject: "jevlang-js: use Math.round in formatNumber",
    file: "jevlang-js/src/interp.mjs",
    find: "const rounded = Math.trunc(v * 100 + (v < 0 ? -0.5 : 0.5));",
    replace: "const rounded = Math.round(v * 100);",
    rationale:
      "Exactly the simplification the function's own comment warns against: " +
      "Math.round breaks ties toward +Infinity, MoonBit's to_int truncates " +
      "toward zero, and they disagree on negative halves.",
  },
  {
    id: "jevlang_mbt_rounding",
    branch: "refactor/moonbit-number-format",
    subject: "jevlang: round instead of truncating in format_number",
    file: "jevlang/ast.mbt",
    find: "let rounded = (v * 100.0 + (if v < 0.0 { -0.5 } else { 0.5 })).to_int()",
    replace: "let rounded = (v * 100.0).round().to_int()",
    rationale: "The same edit on the other side of the same agreement.",
  },
  {
    id: "jevlang_threshold_default",
    branch: "fix/stricter-noul-default",
    subject: "jevlang: default the noul threshold to 0.6",
    file: "jevlang/interp.mbt",
    find: "0.5",
    replace: "0.6",
    rationale:
      "Moving a default cutoff, the kind of change docs/01 §3 says belongs in " +
      "the policy rather than the question. Whether anything pins the default " +
      "is the question.",
  },

  // -------------------------------------------------- the match-able wrapper
  {
    id: "jevdsl_confidence",
    branch: "refactor/drop-abs",
    subject: "jevdsl: drop the abs from the noul confidence",
    file: "jevdsl/dsl.mbt",
    find: "(p - 0.5).abs() * 2.0",
    replace: "(p - 0.5) * 2.0",
    rationale:
      "docs/20's whole point is that a noul's confidence is distance from a " +
      "coin flip, so p=0.1 is as confident as p=0.9. Dropping abs makes " +
      "confident falses negative.",
  },

  // -------------------------------------------------- code no test covers
  {
    id: "moba_counter_type",
    branch: "refactor/moba-scoring",
    subject: "moba: make the round counter a double",
    file: "cmd/moba/main.mbt",
    find: "  let mut result = 0\n",
    replace: "  let mut result = 0.0\n",
    rationale:
      "A type error in a CLI that no test exercises. Only the type-checker can " +
      "see it -- and moon-build is a prerequisite of the conformance check.",
  },
  {
    id: "report_signature",
    branch: "refactor/fixed-places",
    subject: "report: make the decimal places optional",
    file: "report/fmt.mbt",
    find: "pub fn fixed(v : Double, places : Int) -> String {",
    replace: "pub fn fixed(v : Double, places : Int?) -> String {",
    rationale:
      "A signature change in a helper every experiment CLI calls. Nothing " +
      "tests report/, so this is the type-checker's job or nobody's.",
  },

  // -------------------------------------------------- the permission hook
  {
    id: "hooks_policy_threshold",
    branch: "chore/stricter-gate",
    subject: "hooks: raise the policy's noul threshold",
    file: "hooks/policy.jev",
    find: "threshold noul = 0.5",
    replace: "threshold noul = 0.65",
    rationale:
      "docs/18 §6b put the gate's cutoffs in a .jev file precisely so they " +
      "could be moved without touching code. Moving one should be safe -- " +
      "unless a test pins the branch table.",
  },
  {
    id: "hooks_gate_timeout",
    branch: "fix/gate-timeout",
    subject: "hooks: shorten the gate's request timeout",
    file: "hooks/jev-permission-gate.mjs",
    find: "1500",
    replace: "150",
    rationale:
      "docs/18's budget is a few hundred milliseconds, so shortening the " +
      "timeout looks defensible. The fail-safe tests are about what happens " +
      "when it expires.",
  },

  // -------------------------------------------------- the experiments
  {
    id: "task_filter_glob",
    branch: "refactor/simpler-glob",
    subject: "task-filter: let a single star span directories",
    file: "experiments/task-filter/src/graph.ts",
    find: '      } else {\n        re += "[^/]*";\n      }',
    replace: '      } else {\n        re += ".*";\n      }',
    rationale:
      "Collapsing the two star cases into one. It is the difference between " +
      "`packages/*/package.json` matching one segment and matching any.",
  },
  {
    id: "eslint_plugin_cache_key",
    branch: "fix/cache-key-collisions",
    subject: "eslint-plugin-jev: shorten the cache key",
    file: "experiments/eslint-plugin-jev/src/cache.mjs",
    find: '"hex").slice(0, 16)',
    replace: '"hex").slice(0, 4)',
    rationale:
      "A shorter key reads better in the recorded JSON. The plugin's whole " +
      "sync path is a hash lookup, so the key is load-bearing.",
  },

  // -------------------------------------------------- changes that break nothing
  {
    id: "comment_typo",
    branch: "docs/fix-client-comment",
    subject: "lib: fix a typo in the client's header comment",
    file: "lib/client.mbt",
    find: "///|",
    replace: "///|\n/// (typo fixed: reponse -> response)",
    rationale:
      "A comment in the busiest MoonBit file. The control for docs/23's " +
      "comment_typo scenario, this time with the answer measured.",
  },
  {
    id: "readme_wording",
    branch: "docs/reword-setup",
    subject: "README: reword the setup section",
    file: "README.md",
    find: "API キーはソースコードに書かず、",
    replace: "API キーはソースコードに書かないでください。",
    rationale: "Prose only, in a file several recipes list among their inputs.",
  },
  {
    id: "docs_report_link",
    branch: "docs/fix-report-link",
    subject: "docs: fix a stale link in the index",
    file: "docs/README.md",
    find: "## 走らせ方",
    replace: "## 走らせ方\n\n<!-- リンクの整理中 -->",
    rationale:
      "Documentation only. docs-links does not exist in this repository's " +
      "graph, so the honest answer is that nothing needs to run.",
  },
];
