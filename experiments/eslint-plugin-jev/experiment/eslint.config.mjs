/**
 * A real flat config using the plugin, so `npx eslint` is the demo.
 *
 *   node src/warm.mjs "experiment/corpus/*.js"
 *   npx eslint --config experiment/eslint.config.mjs experiment/corpus
 *
 * The rule is `warn`, not `error`: a probabilistic reviewer that can fail your
 * build is a probabilistic reviewer you will turn off. docs/21 measured 3
 * false positives in 117 judgments of clean code in this arm, which is good
 * enough to read and not good enough to gate a merge on.
 */
import jev from "../src/index.mjs";

export default [
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    plugins: { jev },
    rules: {
      "jev/quality": [
        "warn",
        {
          // The defaults, spelled out because the whole point of docs/21 is
          // where these numbers came from.
          reportAt: 1.5,
          bugAt: 0.7,
          unsureBelow: 0.5,
          cache: ".jev-quality.json",
          // A cold cache says nothing. Set "report" in CI if you would rather
          // fail than silently skip the judgment.
          onMiss: "silent",
        },
      ],
    },
  },
];
