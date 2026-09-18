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

# @inputs: docs/**
# @cost: 0.1
# Check every docs/NN-*.md#anchor still points at a heading that exists
check-doc-anchors:
    node scripts/check-doc-anchors.mjs

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

# ---------------------------------------------------------------- aggregate

# Everything that has to be green
[group('meta')]
ci: moon-check test-lib test-jevlang test-jevdsl test-jevlang-js conformance check-doc-anchors test-hooks-failsafe test-hooks-policy test-eslint-plugin replay-eslint-plugin replay-criteria replay-tiers replay-loo replay-rules test-task-filter replay-task-filter
    @echo "all green"
