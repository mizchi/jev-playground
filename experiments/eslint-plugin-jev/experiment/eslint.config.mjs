/**
 * A real flat config using the plugin, so `npx eslint` is the demo.
 *
 *   node src/warm.mjs "experiment/corpus/*.js" --rubric full
 *   node src/warm.mjs "experiment/corpus/*.js" --rules experiment/rules.mjs --only rules
 *   npx eslint --config experiment/eslint.config.mjs experiment/corpus
 *
 * Both rules are on, and they are different kinds of thing:
 *
 *   jev/quality  a fixed question set, asked about every function
 *   jev/rule     rules that do not exist yet, one sentence each, matched by a
 *                selector -- the only part written as code
 *
 * The rules are `warn`, not `error`: a probabilistic reviewer that can fail
 * your build is a probabilistic reviewer you will turn off. docs/21 measured 3
 * false positives in 117 judgments of clean code in this arm, which is good
 * enough to read and not good enough to gate a merge on.
 */
import jev from "../src/index.mjs";
import { rules } from "./rules.mjs";

export default [
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    plugins: { jev },
    rules: {
      "jev/quality": [
        "warn",
        {
          // The defaults, spelled out because the whole point of docs/21 and
          // docs/22 is where these numbers came from.
          //
          // `full` asks the eight named criteria alongside the score and the
          // generic noul: 10 questions per function instead of 2, 3.3x the
          // tokens, and the reason to pay it is that a finding comes back with
          // a NAME. docs/22 measured 41/51 caught against 33/51 for `vague`.
          rubric: "full",
          reportAt: 1.5,
          bugAt: 0.7,
          unsureBelow: 0.5,
          cache: ".jev-quality.json",
          // A cold cache says nothing. Set "report" in CI if you would rather
          // fail than silently skip the judgment.
          onMiss: "silent",
        },
      ],
      "jev/rule": [
        "warn",
        {
          // The rules come from one module, imported here and passed to the
          // warm pass with `--rules`, because the sentence is part of the
          // cache key and two copies would drift.
          rules,
          // 2.0 is a level boundary: level 1 means the code SATISFIES the
          // rule, so reporting it would be the rule firing backwards.
          reportAt: 2,
          unsureBelow: 0.5,
          cache: ".jev-quality.json",
          onMiss: "silent",
        },
      ],
    },
  },
];
