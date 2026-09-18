# This repository's own checks, as a task graph.
#
# Every recipe here is a command that already appears in docs/README.md's
# "走らせ方" block; this file only writes down what depends on what, and what
# each one reads. Two things use it:
#
#   just ci                  run everything (the recipes below, in order)
#   just test-lib            or any single check, prerequisites included
#
# and the task filter in experiments/task-filter, which scores these recipes
# against the current diff (docs/23 §12) and hands back a `just ...` line.
#
# Annotations, same convention as experiments/task-filter/justfile:
#
#   # @inputs   the files the recipe actually reads
#   # @cost     MEASURED seconds, from a cold run of that recipe
#              (experiments/task-filter/real/costs.json)
#   # @reset    how to clear this recipe's cache, so its cost can be measured
#              cold rather than after another recipe already did its compiling
#
# Requires the MoonBit toolchain (`moon`, 0.1.20260915+) for the MoonBit
# recipes and `node` for the rest. Nothing here needs an API key: the `replay`
# recipes re-derive the reports' numbers from committed transcripts.

# ---------------------------------------------------------------- prerequisites

# @inputs: moon.mod
# @cost: 3.8
# Fetch the MoonBit dependencies named in moon.mod
moon-deps:
    moon update

# @inputs: lib/** cmd/** moba/** report/** jevlang/** jevdsl/** moon.mod
# @cost: 12.8
# @reset: moon clean
# Compile every MoonBit package to a native binary
moon-build: moon-deps
    moon build --target native

# @inputs: experiments/eslint-plugin-jev/package.json experiments/eslint-plugin-jev/package-lock.json
# @cost: 0.5
# Install eslint-plugin-jev's dev dependencies
install-eslint-plugin:
    npm --prefix experiments/eslint-plugin-jev install

# @inputs: experiments/task-filter/package.json experiments/task-filter/package-lock.json
# @cost: 0.4
# Install the task filter's dev dependencies
install-task-filter:
    npm --prefix experiments/task-filter install

# @inputs: experiments/threshold-fit/package.json experiments/threshold-fit/package-lock.json
# @cost: 0.6
# Install the threshold component's dev dependencies
install-threshold-fit:
    npm --prefix experiments/threshold-fit install

# @inputs: experiments/otel-triage/package.json experiments/otel-triage/package-lock.json
# @cost: 0.6
# Install the triage experiment's dev dependencies
install-otel-triage:
    npm --prefix experiments/otel-triage install

# @inputs: experiments/bilingual/package.json experiments/bilingual/package-lock.json
# @cost: 0.6
# Install the translation-check experiment's dev dependencies
install-bilingual:
    npm --prefix experiments/bilingual install

# @inputs: experiments/skill-select/package.json experiments/skill-select/package-lock.json
# @cost: 0.6
# Install the skill-selection experiment's dev dependencies
install-skill-select:
    npm --prefix experiments/skill-select install

# @inputs: experiments/skill-pick/package.json experiments/skill-pick/package-lock.json
# @cost: 0.6
# Install the 461-skill roster experiment's dev dependencies
install-skill-pick:
    npm --prefix experiments/skill-pick install

# @inputs: experiments/orchestration/package.json experiments/orchestration/package-lock.json
# @cost: 0.6
# Install the multi-agent-gate experiment's dev dependencies
install-orchestration:
    npm --prefix experiments/orchestration install

# @inputs: experiments/repair/package.json experiments/repair/package-lock.json
# @cost: 0.6
# Install the repair-loop experiment's dev dependencies
install-repair:
    npm --prefix experiments/repair install

# @inputs: experiments/review/package.json experiments/review/package-lock.json
# @cost: 0.6
# Install the review experiment's dev dependencies
install-review:
    npm --prefix experiments/review install

# @inputs: experiments/roguelike/package.json experiments/roguelike/package-lock.json
# @cost: 0.6
# Install the roguelike experiment's dev dependencies
install-roguelike:
    npm --prefix experiments/roguelike install

# @inputs: experiments/tension/package.json experiments/tension/package-lock.json
# @cost: 0.6
# Install the tension experiment's dev dependencies
install-tension:
    npm --prefix experiments/tension install

# @inputs: packages/package.json packages/*/package.json packages/package-lock.json
# @cost: 2.6
# Install the publishable packages' workspace, including pi's types
install-packages:
    npm --prefix packages install

# ---------------------------------------------------------------- MoonBit checks

# @inputs: lib/** cmd/** moba/** report/** jevlang/** jevdsl/** moon.mod
# @cost: 0.9
# @reset: moon clean
# Type-check every MoonBit package without producing a binary
moon-check: moon-deps
    moon check --target native

# @inputs: lib/**
# @cost: 1.9
# @reset: moon clean
# Run the API client's tests, including the wire-format ones
test-lib: moon-deps
    moon test --target native -p lib

# @inputs: jevlang/**
# @cost: 5.3
# @reset: moon clean
# Run the MoonBit jevlang implementation's tests
test-jevlang: moon-deps
    moon test --target native -p jevlang

# @inputs: jevdsl/**
# @cost: 4.3
# @reset: moon clean
# Run the tests for the match-able wrapper around a judgment
test-jevdsl: moon-deps
    moon test --target native -p jevdsl

# ---------------------------------------------------------------- JS checks

# @inputs: jevlang-js/**
# @cost: 0.1
# Run the JS jevlang implementation's tests
test-jevlang-js:
    node jevlang-js/test.mjs

# @inputs: jevlang/** jevlang-js/** cmd/jevlang/** examples/**
# @cost: 3.9
# Check the MoonBit and JS jevlang implementations still agree on examples/*.jev
conformance: moon-build
    scripts/jevlang-conformance.sh

# @inputs: hooks/**
# @cost: 1.0
# Check that all seven of the permission hook's failure paths defer
test-hooks-failsafe:
    node hooks/test-gate.mjs --failsafe-only

# @inputs: hooks/** examples/**
# @cost: 0.1
# Check the sixteen branches of the .jev permission policy
test-hooks-policy:
    node hooks/test-gate.mjs --policy-logic

# ---------------------------------------------------------------- experiments

# @inputs: experiments/eslint-plugin-jev/**
# @cost: 2.3
# Run the ESLint plugin's unit tests
test-eslint-plugin: install-eslint-plugin
    node experiments/eslint-plugin-jev/experiment/test.mjs

# @inputs: experiments/eslint-plugin-jev/**
# @cost: 0.5
# Re-derive docs/21's numbers from the recorded run
replay-eslint-plugin: install-eslint-plugin
    npm --prefix experiments/eslint-plugin-jev run replay

# @inputs: experiments/eslint-plugin-jev/**
# @cost: 0.5
# Re-derive docs/22's four-rubric comparison from the recorded run
replay-criteria: install-eslint-plugin
    npm --prefix experiments/eslint-plugin-jev run replay:criteria

# @inputs: experiments/eslint-plugin-jev/**
# @cost: 0.5
# Re-derive docs/22's easy/hard 2x2 from the recorded run
replay-tiers: install-eslint-plugin
    npm --prefix experiments/eslint-plugin-jev run replay:tiers

# @inputs: experiments/eslint-plugin-jev/**
# @cost: 0.5
# Re-derive docs/22's leave-one-criterion-out from the recorded run
replay-loo: install-eslint-plugin
    npm --prefix experiments/eslint-plugin-jev run replay:loo

# @inputs: experiments/eslint-plugin-jev/**
# @cost: 0.3
# Re-derive docs/24's ad-hoc rule report from the recorded run
replay-rules: install-eslint-plugin
    npm --prefix experiments/eslint-plugin-jev run rules

# @inputs: experiments/task-filter/**
# @cost: 0.5
# Check the task filter's graph, oracle and request invariants
test-task-filter: install-task-filter
    npm --prefix experiments/task-filter test

# @inputs: experiments/task-filter/**
# @cost: 0.7
# Re-derive docs/23's numbers from the committed rows
replay-task-filter: install-task-filter
    npm --prefix experiments/task-filter exec -- tsx experiments/task-filter/src/run.ts --replay

# @inputs: experiments/otel-triage/** experiments/shared/**
# @cost: 0.9
# Check the telemetry simulator, the detector, and that no label reaches the state
test-otel-triage: install-otel-triage
    npm --prefix experiments/otel-triage test

# @inputs: experiments/otel-triage/** experiments/shared/**
# @cost: 0.9
# Re-derive docs/27's tables from the recorded judgments
replay-otel-triage: install-otel-triage
    npm --prefix experiments/otel-triage run demo

# @inputs: experiments/bilingual/** experiments/shared/** experiments/eslint-plugin-jev/README.md experiments/eslint-plugin-jev/README.ja.md
# @cost: 0.9
# Check that the parallel READMEs still align, and that the rules stay quiet on them
test-bilingual: install-bilingual
    npm --prefix experiments/bilingual test

# @inputs: experiments/bilingual/** experiments/shared/**
# @cost: 0.9
# Re-derive docs/28's tables from the recorded judgments
replay-bilingual: install-bilingual
    npm --prefix experiments/bilingual run demo

# @inputs: experiments/skill-select/** experiments/shared/**
# @cost: 0.5
# Check the label rule against mizchi's catalog, and that no label reaches a payload
test-skill-select: install-skill-select
    npm --prefix experiments/skill-select test

# @inputs: experiments/skill-select/** experiments/shared/**
# @cost: 1.8
# Re-derive docs/29's tables from the recorded judgments
replay-skill-select: install-skill-select
    npm --prefix experiments/skill-select run demo

# @inputs: experiments/skill-pick/** experiments/skill-select/** experiments/shared/**
# @cost: 0.5
# Check the roster join, the prefilter tie-break, and that no label reaches a payload
test-skill-pick: install-skill-pick
    npm --prefix experiments/skill-pick test

# @inputs: experiments/skill-pick/** experiments/skill-select/** experiments/shared/**
# @cost: 7.4
# Re-derive docs/30's tables from the recorded judgments
replay-skill-pick: install-skill-pick
    npm --prefix experiments/skill-pick run demo

# @inputs: experiments/skill-pick/**
# @cost: 0.7
# The tool itself, stage 1 only: a shortlist for this repository with no API key
pick-skills DIR=".": install-skill-pick
    npx --prefix experiments/skill-pick tsx experiments/skill-pick/src/pick.ts {{DIR}} --stage1-only

# @inputs: experiments/orchestration/** experiments/shared/**
# @cost: 0.4
# Check that the two corpus labels agree, and that the gate never reaches a payload
test-orchestration: install-orchestration
    npm --prefix experiments/orchestration test

# @inputs: experiments/orchestration/** experiments/shared/**
# @cost: 0.4
# Re-derive docs/31's tables from the recorded judgments
replay-orchestration: install-orchestration
    npm --prefix experiments/orchestration run demo

# @inputs: experiments/repair/** experiments/shared/**
# @cost: 1.2
# Check the repair corpus: every task starts red and the recorded truth is not stale
test-repair: install-repair
    npm --prefix experiments/repair test

# @inputs: experiments/repair/** experiments/shared/**
# @cost: 0.5
# Re-derive docs/32's tables from the recorded judgments
replay-repair: install-repair
    npm --prefix experiments/repair run demo

# @inputs: experiments/repair/**
# @cost: 55.0
# Re-measure which candidate edits actually turn each suite green (305 node --test runs)
repair-truth: install-repair
    npm --prefix experiments/repair run truth

# @inputs: experiments/review/** experiments/repair/** experiments/shared/**
# @cost: 0.7
# Check the review corpus: every green base is green and the truth is not stale
test-review: install-review
    npm --prefix experiments/review test

# @inputs: experiments/review/** experiments/shared/**
# @cost: 0.6
# Re-derive docs/33's tables from the recorded judgments
replay-review: install-review
    npm --prefix experiments/review run demo

# @inputs: experiments/review/** experiments/repair/**
# @cost: 45.0
# Re-measure which diffs keep each suite green, plus coverage and similarity
review-truth: install-review
    npm --prefix experiments/review run truth

# @inputs: experiments/roguelike/** experiments/shared/**
# @cost: 1.1
# Check the NetHack harness: glyphs, geometry, action sets, probe truths.
# The live-game check is skipped when nethack-console is not installed
test-roguelike: install-roguelike
    npm --prefix experiments/roguelike test

# @inputs: experiments/roguelike/** experiments/shared/**
# @cost: 0.6
# Re-derive docs/34's tables from the recorded screens and games
replay-roguelike: install-roguelike
    npm --prefix experiments/roguelike run demo

# @inputs: experiments/roguelike/**
# @cost: 900.0
# Re-record the baseline games and the screen corpus. Needs nethack-console
roguelike-walk: install-roguelike
    npm --prefix experiments/roguelike run walk -- --games 3 --actions 500 --every 12

# @inputs: experiments/tension/** experiments/shared/**
# @cost: 0.6
# Check the game rules, the exhaustive solver and the trajectory statistics
test-tension: install-tension
    npm --prefix experiments/tension test

# @inputs: experiments/tension/** experiments/shared/**
# @cost: 0.6
# Re-derive docs/35's tables from the recorded self-play
replay-tension: install-tension
    npm --prefix experiments/tension run demo

# @inputs: experiments/router/package.json experiments/router/package-lock.json
# @cost: 0.6
# Install the router evaluation's dev dependencies
install-router:
    npm --prefix experiments/router install

# @inputs: experiments/router/** experiments/repair/** experiments/review/** packages/**
# @cost: 4.0
# Check the router corpus: the prompt hides the answer, the composed tasks
# parse and fail, and each arm sees only what its name says
test-router: install-router
    npm --prefix experiments/router test

# @inputs: experiments/router/** packages/**
# @cost: 0.6
# Re-derive docs/36 §5's tables from the recorded labels and judgments
replay-router: install-router
    npm --prefix experiments/router run demo

# @inputs: experiments/router/** experiments/review/**
# @cost: 90.0
# Re-compose the harder corpus from review's recorded breaking edits
router-harder: install-router
    npm --prefix experiments/router exec -- tsx src/harder.ts

# @inputs: packages/**
# @cost: 1.0
# Check the five components: question shapes, the policies' totality, the cost
# ladder, the guard's fail-safe paths, the compactor's structural constraints.
# No API key, no network, no pi
test-packages: install-packages
    npm --prefix packages/jev-core test
    npm --prefix packages/jev-model-router test
    npm --prefix packages/jev-skill-router test
    npm --prefix packages/jev-guard test
    npm --prefix packages/jev-compact test
    npm --prefix packages/jev-orchestrator test
    npm --prefix packages/jev-hermes test

# @inputs: packages/**
# @cost: 3.4
# Type-check every component against pi's real extension API
typecheck-packages: install-packages
    packages/node_modules/.bin/tsc --noEmit --strict --target es2023 --module nodenext \
      --moduleResolution nodenext --skipLibCheck \
      packages/jev-core/src/*.ts packages/jev-model-router/src/*.ts packages/jev-skill-router/src/*.ts \
      packages/jev-guard/src/*.ts packages/jev-compact/src/*.ts packages/jev-orchestrator/src/*.ts \
      packages/jev-hermes/src/*.ts

# @inputs: experiments/hermes/package.json
# @cost: 8.0
# Install the combine measurement's dev dependencies
install-hermes:
    npm --prefix experiments/hermes install

# @inputs: experiments/hermes/** packages/**
# @cost: 1.0
# Check the combine record: the turns differ, both ways ask the same questions,
# the record is balanced and stores raw answers.
test-hermes: install-hermes
    npm --prefix experiments/hermes test

# @inputs: experiments/hermes/** packages/**
# @cost: 1.0
# One request per turn against three: the tables, from the record, no API key.
replay-hermes: install-hermes
    npm --prefix experiments/hermes run demo

# @inputs: docs/** README.md experiments/**/README*.md packages/**/README.md
# @cost: 0.1
# Every relative Markdown link and heading anchor across the repository
check-links:
    node tools/check-links.mjs

# @inputs: eslint.config.mjs eslint.rules.mjs hooks/** jevlang-js/** experiments/eslint-plugin-jev/**
# @cost: 0.7
# Lint this repository against its own prose conventions (docs/26), from the
# committed verdicts -- no API key: a cold entry is silent, not a failure
lint-repo-rules: install-eslint-plugin
    experiments/eslint-plugin-jev/node_modules/.bin/eslint .

# @inputs: experiments/eslint-plugin-jev/** eslint.rules.mjs
# @cost: 0.6
# Re-derive docs/26's three tables from the recorded verdicts
replay-repo-rules: install-eslint-plugin
    node experiments/eslint-plugin-jev/experiment/rules-report.mjs --cache experiments/eslint-plugin-jev/experiment/out-repo-rules.json --rules eslint.rules.mjs
    node experiments/eslint-plugin-jev/experiment/rules-report.mjs --cache experiments/eslint-plugin-jev/experiment/out-repo-drafts.json --rules experiments/eslint-plugin-jev/experiment/repo-drafts.mjs
    node experiments/eslint-plugin-jev/experiment/rules-report.mjs --cache experiments/eslint-plugin-jev/experiment/out-repo-corpus.json --rules experiments/eslint-plugin-jev/experiment/repo-drafts.mjs

# @inputs: experiments/threshold-fit/** experiments/shared/**
# @cost: 0.6
# Check the cutoff-fitting component: placements, folds, calibration
test-threshold-fit: install-threshold-fit
    npm --prefix experiments/threshold-fit test

# @inputs: experiments/threshold-fit/** experiments/shared/** experiments/task-filter/** experiments/eslint-plugin-jev/experiment/**
# @cost: 13.5
# Re-derive docs/25's numbers from the other experiments' recorded runs
replay-threshold-fit: install-threshold-fit
    npm --prefix experiments/threshold-fit run report

# ---------------------------------------------------------------- aggregate

# Everything that has to be green
[group('meta')]
ci: moon-check test-lib test-jevlang test-jevdsl test-jevlang-js conformance test-hooks-failsafe test-hooks-policy test-eslint-plugin replay-eslint-plugin replay-criteria replay-tiers replay-loo replay-rules lint-repo-rules replay-repo-rules test-task-filter replay-task-filter test-threshold-fit replay-threshold-fit test-otel-triage replay-otel-triage test-bilingual replay-bilingual test-skill-select replay-skill-select test-skill-pick replay-skill-pick test-orchestration replay-orchestration test-repair replay-repair test-review replay-review test-roguelike replay-roguelike test-tension replay-tension test-packages typecheck-packages test-router replay-router test-hermes replay-hermes check-links
    @echo "all green"
