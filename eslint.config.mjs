/**
 * This repository, linted by its own plugin, against its own prose.
 *
 *   node experiments/eslint-plugin-jev/src/warm.mjs "hooks/**\/*.mjs" ... \
 *     --config eslint.config.mjs --only rules \
 *     --cache experiments/eslint-plugin-jev/experiment/out-repo-rules.json
 *   experiments/eslint-plugin-jev/node_modules/.bin/eslint .
 *
 * Only `jev/rule` is on. `jev/quality` asks a fixed question set about every
 * function and docs/21-22 already measured it on a labelled corpus; what had
 * never been measured is the other half -- a sentence, a selector, and real
 * code (docs/26).
 *
 * The plugin comes in by relative path rather than by package name: it lives
 * in this repository and there is no root package.json to install it into.
 *
 * Two blocks, because one rule is about a place rather than about a shape.
 * `fail-safe-silence` is a rule about code that RETURNS A DECISION, and
 * "is this the deciding layer?" is exactly the kind of condition docs/24 §2
 * found must not go into the sentence -- the catch block cannot show it. So
 * the scope is the file glob, the shape is the selector, and only the
 * judgment is the sentence.
 *
 * Watch the second block: ESLint does not MERGE a rule's options across
 * config blocks, the last matching one wins outright. Listing only the
 * hook rule there silently took the other seven off `hooks/**` -- the dry run
 * said 3 matches in a 655-line file and that is how it showed up. So the
 * scoped block repeats the general rules.
 */
import jev from "./experiments/eslint-plugin-jev/src/index.mjs";
import { active } from "./eslint.rules.mjs";

const CACHE = "experiments/eslint-plugin-jev/experiment/out-repo-rules.json";

/** Everything except the rule that is scoped to one file. */
const general = active.filter((r) => r.id !== "fail-safe-silence");
const hookOnly = active.filter((r) => r.id === "fail-safe-silence");

export default [
  {
    // The whole repository's real JavaScript. Not `experiment/corpus/**`:
    // those fifteen files are docs/22's planted bugs, and counting findings
    // on planted bugs is what docs/24 already did.
    ignores: ["**/node_modules/**", "experiments/eslint-plugin-jev/experiment/corpus/**"],
  },
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    plugins: { jev },
    rules: {
      "jev/rule": [
        "warn",
        {
          rules: general,
          // 2.0 is a level boundary, not a fitted number: level 1 means the
          // code satisfies the rule, so reporting it would be the rule firing
          // backwards. Per-rule `at` overrides it (docs/24 §1).
          reportAt: 2,
          unsureBelow: 0.5,
          cache: CACHE,
          // A cold cache says nothing rather than inventing a verdict.
          onMiss: "silent",
        },
      ],
    },
  },
  {
    // The hook itself, not `hooks/**`. The wider glob pulled in the hook's own
    // TEST harness, and the harness turning an unparseable response into a
    // `{parseError}` object was the one thing this rule reported in docs/26's
    // first run -- a finding about the glob, not about the code.
    files: ["hooks/jev-permission-gate.mjs"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    plugins: { jev },
    rules: {
      "jev/rule": [
        "warn",
        { rules: [...general, ...hookOnly], reportAt: 2, unsureBelow: 0.5, cache: CACHE, onMiss: "silent" },
      ],
    },
  },
];
