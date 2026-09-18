# eslint-plugin-jev

An ESLint rule whose verdict comes from a model instead of from a pattern: one
per-function review score, plus eight named defect classes, with every function
in a file asked in a single [Jev](https://typesafe.ai) request.

```
  5:8  warning  `applyDiscount` matches the review criterion `unit_or_arithmetic` (0.94, its cutoff is 0.28)  jev/quality
 13:8  warning  `increment` matches the review criterion `lost_update` (0.93, its cutoff is 0.73)             jev/quality
 36:8  warning  Jev thinks `reachable` does the wrong thing for some realistic input (misbehaves 0.78)        jev/quality
 15:8  warning  Jev would push back on `formatYen` but is not sure -- worth a human look rather than a fix    jev/quality
```

> **Status: experiment.** This is not published to npm (`"private": true`) and
> has never been run on a real repository — the numbers below come from a
> 15-file, 78-function labelled corpus. The cutoffs are *fitted to that corpus*
> and are the first thing you should retune. See [Limits](#limits).

---

## Contents

- [How it works](#how-it-works)
- [Install](#install)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Messages](#messages)
- [The named criteria](#the-named-criteria)
- [The warm pass (CLI)](#the-warm-pass-cli)
- [The cache](#the-cache)
- [`onMiss`: what happens with no cached verdict](#onmiss-what-happens-with-no-cached-verdict)
- [Cost and scale](#cost-and-scale)
- [What it catches](#what-it-catches)
- [Limits](#limits)
- [Development](#development)

## How it works

**ESLint rules are synchronous.** `context.report()` has to happen during the
traversal and no hook may return a promise, so a rule cannot await an HTTP
request. So the plugin splits into two phases:

```
  phase 1  warm pass (out of band, async)      phase 2  eslint (sync)
  ┌────────────────────────────────────┐        ┌──────────────────────────┐
  │ run the real ESLint in collector   │        │ jev/quality              │
  │ mode -> the same units the rule    │        │  Program:exit            │
  │ will look up                       │        │  hash each function      │
  │ one request per FILE, N questions  │───────▶│  look it up in the cache │
  │ per function                       │ .jev-  │  apply the gate          │
  │ -> verdicts, content-addressed     │quality │  context.report()        │
  └────────────────────────────────────┘ .json  └──────────────────────────┘
```

The cache key is `sha256(schema + rubric + functionText)`, so it is
content-addressed: edit a function and its verdict goes stale (the rule says
nothing, or reports the miss — your choice); move it to another file and the
verdict follows. The warm pass runs the real ESLint with the real plugin to
find the functions, so the keys it writes are exactly the keys the rule looks
up.

The unit of judgment is one **outermost** function (declaration, expression,
arrow, method) of at least `minLines` lines. Callbacks are skipped by default —
they are judged as part of the function they sit in.

## Install

```bash
npm install --save-dev eslint-plugin-jev   # not published; see Status above
```

From this repository:

```bash
cd experiments/eslint-plugin-jev && npm install
```

Requires ESLint >= 9 (flat config) and Node 18+. No `dependencies` — the Jev
client is 155 lines of `fetch` — and one peer dependency on `eslint`, which the
warm pass also uses, so that it finds functions the same way the rule does.

## Quick start

```bash
export TYPESAFEAI_API_KEY=...

# 1. Ask. 15 requests for 78 functions, ~$0.004.
npx jev-warm "src/**/*.js" --rubric full

# 2. Lint. No network, no API key, 31 ms for 12 files.
npx eslint src
```

`eslint.config.mjs`:

```js
import jev from "eslint-plugin-jev";

export default [
  {
    files: ["**/*.js"],
    plugins: { jev },
    rules: {
      "jev/quality": ["warn", { rubric: "full" }],
    },
  },
];
```

Or take the preset, which is `warn` with `onMiss: "silent"` and everything else
left at its default:

```js
import jev from "eslint-plugin-jev";

export default [jev.configs.recommended];
```

The preset leaves `rubric` at `vague`, so warm with `--rubric vague` (the
default) if you use it. Warming with one rubric and linting with another is a
cache full of keys nobody looks up — and because a miss is silent, it looks
exactly like clean code. If the rule suddenly reports nothing, that is the
first thing to check.

`warn`, not `error`, is deliberate: a probabilistic reviewer that can fail your
build is a probabilistic reviewer you will turn off. The measurement behind the
default is 3 false positives in 117 judgments of clean code — good enough to
read, not good enough to gate a merge on.

## Configuration

One rule, `jev/quality`. Every option:

| option | type | default | what it does |
| --- | --- | --- | --- |
| `rubric` | `"vague"` \| `"checklist"` \| `"atoms"` \| `"full"` | `"vague"` | which question set the verdict came from. **Must match the warm pass** — it is part of the cache key. |
| `reportAt` | number 0–3 | `1.5` | report when the reviewer-action score reaches this. |
| `bugAt` | number 0–1 | `0.7` | report `bug` when the generic "misbehaves" probability reaches this. |
| `unsureBelow` | number 0–1 | `0.5` | below this confidence, a report becomes `unsure` instead of `quality`. |
| `criterionAt` | `{ [name]: number }` | [see below](#the-named-criteria) | per-criterion cutoff. Merged over the defaults, so you can override one. |
| `atomAt` | number 0–1 | `0.8` | fallback cutoff for a criterion with no `criterionAt` entry. All eight shipped criteria have one, so this only matters if you add a criterion. |
| `minLines` | integer >= 1 | `3` | ignore functions shorter than this. |
| `includeCallbacks` | boolean | `false` | also judge functions passed as arguments. |
| `cache` | string | `".jev-quality.json"` | path to the verdict cache, relative to cwd. |
| `onMiss` | `"silent"` \| `"report"` \| `"ask"` | `"silent"` | [what to do with no cached verdict](#onmiss-what-happens-with-no-cached-verdict). |
| `timeout` | integer >= 100 | `30000` | ms, only meaningful with `onMiss: "ask"`. |

Unknown options are a config error (`additionalProperties: false`).

`minLines`, `includeCallbacks` and `rubric` must be the same in the rule and in
the warm pass, or the rule will look up keys nobody wrote. The warm pass takes
`--min-lines`, `--include-callbacks` and `--rubric` for exactly that reason.

### Which rubric

`rubric` decides what gets asked, which decides what you can be told:

| rubric | questions/fn | a finding tells you | caught (of 51) |
| --- | --- | --- | --- |
| `vague` | 2 | a score and "misbehaves" | 33 |
| `checklist` | 2 | same, with the criteria listed in the instructions | 34 |
| `atoms` | 8 | **which** criterion, no score | 38 |
| `full` | 10 | which criterion *and* the score | **41** |

`full` costs 3.3× the tokens of `vague` and is still one request per file. Pay
it if you want findings that say *what* is wrong; `vague` findings only say
*that* something is.

Naming the classes mostly pays on defects you cannot see from the function's own
text: 15/15 either way on locally-visible ones, 14% → 52% on the rest.

### Tuning

The gate is three tests, and the first one that passes wins:

1. any named criterion over **its own** `criterionAt` → `criterion`
2. generic "misbehaves" >= `bugAt` → `bug`
3. score >= `reportAt` → `quality`, or `unsure` if confidence < `unsureBelow`

Raise `reportAt` toward 3 and `bugAt`/`criterionAt` toward 1 for fewer, surer
findings. Confidence is *not* a gate: a low-confidence report is still a report,
it just arrives as `unsure`. Gating on confidence was measured to cost 7–11
points of recall for nothing.

```js
"jev/quality": ["warn", {
  rubric: "full",
  reportAt: 2,                                   // only "request changes" and up
  criterionAt: { unescaped_composition: 0.6 },   // the one that over-fires
}],
```

`criterionAt` is merged **per key**, so that last line raises one cutoff and
leaves the other seven at their defaults. Retuning one criterion never silently
moves the rest.

None of this costs a request: the cache stores the verdict, and the gate is
recomputed on every lint. Retune the thresholds and re-run `eslint` — you only
pay again when the code changes.

## Messages

One rule reports five different things. They all arrive as `jev/quality`, so
the `messageId` is how you tell them apart in a formatter or a report:

| messageId | fires when | means |
| --- | --- | --- |
| `criterion` | a named criterion clears its own cutoff | the only one that says **what** is wrong |
| `bug` | generic "misbehaves" >= `bugAt` | probably wrong, not merely improvable |
| `quality` | score >= `reportAt`, confidently | a reviewer would want this changed |
| `unsure` | score >= `reportAt` but confidence < `unsureBelow` | worth a human look, not a fix |
| `missing` | no cached verdict and `onMiss: "report"` | the warm pass did not cover this function |

The `criterion` message ends with "See docs/22 for what that criterion means" —
that is [docs/22](../../docs/22-code-criteria.md) in this repository, and the
table below is the short version.

The score is the reviewer action Jev picked, 0–3:

| 0 | 1 | 2 | 3 |
| --- | --- | --- | --- |
| approve as is | approve with a comment | request changes | block: looks incorrect |

## The named criteria

With `rubric: "atoms"` or `"full"`, each function is asked about eight concrete
defect classes. Each has its own cutoff, because their answers are not on the
same scale — the same probability means different things for different classes
(they range 0.20 to 0.94 on their own class):

| criterion | cutoff | covers |
| --- | --- | --- |
| `api_default` | 0.25 | a library call's default is not what the code assumes |
| `unhandled_async` | 0.57 | a promise whose rejection or value escapes |
| `boundary` | 0.58 | the edge of the input range |
| `swallows_failure` | 0.38 | a failure the caller needed to know about |
| `name_mismatch` | 0.48 | the name promises something the body does not do |
| `lost_update` | 0.73 | read-modify-write across a suspension point |
| `unescaped_composition` | 0.26 | caller text spliced into something that gets parsed |
| `unit_or_arithmetic` | 0.28 | wrong operation or wrong scale |

When several criteria fire, the one reported is the one furthest over its own
cutoff (`p / cutoff`), not the one with the highest raw probability.

Known over-firer: `unescaped_composition` answers high for essentially any
template literal, so its cutoff is low and it is the criterion most likely to
be noise on your code. Raise it, or set it above `1` to switch that criterion
off entirely:

```js
criterionAt: { unescaped_composition: 1.01 },
```

The eight overlap. Dropping any one but `api_default` and a neighbour or the
generic question still catches its class — so an incomplete list degrades
gracefully rather than opening a hole.

## The warm pass (CLI)

```bash
npx jev-warm "<glob>" [<glob>...] [options]
node src/warm.mjs "<glob>" ...              # same thing, from a checkout
```

Quote the globs — let the tool expand them, not your shell, or a `**` will
behave differently depending on the shell.

```
15 file(s), 78 function(s), 78 unique, 0 already cached, 78 to ask
  15 request(s) planned (arm: located, rubric: full)
  15 request(s), 102365 input tokens, $0.00430
  78 verdict(s) -> .jev-quality.json
```

| flag | default | what it does |
| --- | --- | --- |
| `--rubric <name>` | `vague` | `vague` \| `checklist` \| `atoms` \| `full`. Must match the rule. |
| `--cache <path>` | `.jev-quality.json` | where to write the verdicts. |
| `--concurrency <n>` | `4` | requests in flight. |
| `--model <id>` | server default | Jev model. |
| `--min-lines <n>` | `3` | must match the rule. |
| `--include-callbacks` | off | must match the rule. |
| `--force` | off | re-ask everything, ignoring cached entries. |
| `--dry-run` | off | print the batch plan and token estimate, ask nothing. |
| `--arm <name>` | `located` | how the file is presented: `located` \| `inlined` \| `solo` \| `isolated`. An experiment axis; `located` is the one to use. |

`--dry-run` is the cheap way to check a repo before spending anything:

```
  15 request(s) planned (arm: located, rubric: full)
    experiment/corpus/access.js  10 fn  ~18901 tok
    experiment/corpus/cart.js     5 fn   ~9466 tok
    ...
```

Already-cached functions are skipped, and identical function text anywhere in
the repo is one question, so re-running after a small change costs almost
nothing.

### Environment

| variable | what for |
| --- | --- |
| `TYPESAFEAI_API_KEY` | required by the warm pass and by `onMiss: "ask"`. Never read by the rule itself. |
| `TYPESAFEAI_BASE_URL` | override the API endpoint. |
| `JEV_QUALITY_CACHE` | default cache path (the `cache` option wins). |
| `JEV_QUALITY_ARM` | default arm for `onMiss: "ask"`. |
| `JEV_QUALITY_MODEL` | default model. |

## The cache

A single JSON file, by default `.jev-quality.json` next to where you run
ESLint:

```json
{
  "schema": "jev-quality-3",
  "model": "jev-latest",
  "arm": "located",
  "rubric": "full",
  "written": "2026-09-18T06:49:48.955Z",
  "entries": {
    "9c85409d9217d917da74": {
      "score": 0.75,
      "confidence": 0.59,
      "bug": 0.33,
      "atoms": { "api_default": 0.38, "boundary": 0.69, "lost_update": 0.02, "...": 0 },
      "name": "median",
      "file": "experiment/corpus/stats.js",
      "line": 8,
      "at": "2026-09-18T06:49:48.955Z"
    }
  }
}
```

`name`, `file` and `line` are there so the file is readable; only the key is
load-bearing. The score is a weighted position on the 0–3 scale, not one of the
four levels — `median` above scores 0.75, well under `reportAt`, and is reported
only because `api_default` answered 0.38 against a 0.25 cutoff.

- **Commit it or don't, but decide.** Committed, CI lints with no API key and
  reviewers see the same verdicts you did. Uncommitted, every CI run pays for a
  warm pass.
- **It is trusted input.** Anything that can edit this file can silence the
  rule, or make it report whatever it likes. Treat it like your ESLint config,
  not like a build artifact.
- **A partial entry is a miss, not a default.** An entry without the fields the
  configured rubric needs is treated as absent rather than scored as zero.
- **The cache never throws at the plugin.** Missing, unreadable, malformed,
  wrong schema — all of it becomes "no verdict", and linting continues. A
  review tool that can break `eslint` is worse than no review tool.

## `onMiss`: what happens with no cached verdict

| | setup | lint time (12 files) | when |
| --- | --- | --- | --- |
| `"silent"` *(default)* | run the warm pass first | **31 ms** | day to day. A cold cache says nothing. |
| `"report"` | run the warm pass first | 31 ms | CI, if you would rather fail than silently skip a judgment. |
| `"ask"` | none | 4327 ms (361 ms/file) | a one-off look at code you have not warmed. |

For scale, ESLint with the rule turned off is 36 ms on the same 12 files: a warm
cache costs nothing measurable. `"ask"` blocks the rule on a child process
(`execFileSync`) that makes the request and folds the answer into the cache;
it is 100× slower and fails open — any error gives back no verdicts rather
than taking down the lint run.

## Cost and scale

| | |
| --- | --- |
| a full pass, 78 functions, `full` | 15 requests, 102,365 input tokens, **$0.0043** |
| per function, `vague` (2 questions) | $0.000017 |
| per function, `full` (10 questions) | $0.000055 |
| 283 tokens per function in the `full` shape | measured, not estimated |

Two hard server-side ceilings, both measured, neither of them a question count
(1220 questions in one request is fine):

| ceiling | in practice |
| --- | --- |
| 32Ki tokens for the **state** | one file of roughly 2300 lines |
| 64Ki tokens for the **whole request** | roughly 230 functions |

The batch planner keeps every request under both, splitting a file that would
exceed them; the client also halves a batch the server rejects with
`max_tokens_exceeded`. A file too large for the state ceiling is the one thing
that cannot be split — 2300 lines in one file is the real limit.

## What it catches

Measured on 15 files / 641 lines / 78 functions, of which 22 carry a labelled
bug (each proved by a probe that *runs* the function), 5 a smell, 9 a near-miss,
and 42 are clean:

- `full` catches **41 of 51** labelled problems.
- `vague` catches 33, and its *confident* findings were 15/15 correct with 0
  false positives — high precision, low recall.
- On defects visible in the function's own text, the rubric barely matters
  (15/15 either way). On defects needing outside knowledge of a specific API's
  behaviour, naming the classes takes recall from 14% to 52%.
- 3 false positives in 117 judgments of clean code.

Full write-ups, with the method and every number:
[docs/21](../../docs/21-eslint-plugin-jev.md) (the plugin, the synchronous-rule
problem, batching, the token ceilings) and
[docs/22](../../docs/22-code-criteria.md) (what changes when you name eight
concrete defect classes, and how deep the hole is for the classes you did not
name).

## Limits

Read these before putting it in front of a team:

- **The cutoffs are fitted** to the corpus in `experiment/corpus`, and have been
  refitted once already. On your code they are a starting point, not a
  calibration. `criterionAt` is the first thing to retune.
- **It has never been run on a real repository.** Every number here comes from
  a 641-line labelled corpus.
- **It is file-scoped, not diff-scoped.** The unit is a function and the batch
  is a file; there is no "only what this PR changed" mode. On a large repo you
  warm everything once and then only re-ask what changed, but the first pass is
  the whole tree.
- **It is not deterministic, and there is no autofix.** The same function can
  come back with a different probability on a different day — which is also why
  the cache is not just a speed optimisation: it is what makes two lint runs
  agree. `--from` replay exists for the same reason.
- **`warn`, not `error`.** 3 false positives per 117 clean functions is fine for
  reading and not fine for blocking a merge.
- **A cold cache is silent by default.** That is a deliberate fail-open: if you
  need to know the judgment ran, use `onMiss: "report"` in CI.
- **JavaScript only**, as configured. Nothing is TypeScript-specific in the
  plugin, but nothing has been measured on TypeScript either.

## Development

```bash
npm install

npm test                     # 62 checks, no API key needed
npm run truth                # the labels, proved by running the code
npm run replay               # docs/21's numbers, re-derived, no API key
npm run replay:criteria      # docs/22's numbers, re-derived, no API key
npm run replay:tiers         # docs/22's addendum: the named x hard 2x2
npm run replay:loo           # docs/22's addendum: one criterion dropped at a time

export TYPESAFEAI_API_KEY=...
npm run warm -- --rubric full   # 15 requests, 78 functions, $0.004
npm run lint                    # eslint, reading the cached verdicts

npm run run -- --repeat 3       # docs/21: the 4-arm measurement (state and batching)
npm run criteria -- --repeat 3  # docs/22: the 4-rubric measurement (what we ask)
npm run loo -- --repeat 3       # docs/22 addendum: leave one criterion out
npm run bench                   # what each way around async costs
```

A `--from` replay scores with the thresholds the run was **recorded** with, so
retuning a cutoff cannot rewrite an already-published report. Add
`--current-thresholds` to see what today's defaults would have done to that same
run.

```
src/functions.mjs   AST -> the unit of judgment (one function)
src/judge.mjs       the questions, the rubrics, the gate, the token ceilings
src/cache.mjs       the verdict cache; never throws at the plugin
src/index.mjs       the ESLint plugin
src/warm.mjs        the out-of-band batched pass (and the batch planner)
src/sync-ask.mjs    the child process `onMiss: "ask"` blocks on
src/jev.mjs         zero-dependency client, splits a batch the server rejects

experiment/corpus/     15 files, 641 lines, 78 functions, labelled
experiment/labels.mjs  the labels, and a probe that RUNS the code to prove them
experiment/truth.mjs   checks the labels; spends nothing
experiment/run.mjs     the measurement, with `--from` replay
experiment/test.mjs    fail-safe paths and the gate's truth table
```

`experiment/out-run.json` is a recorded run: `npm run replay` re-derives every
number in the write-up from it with no API key and no variance. That is how the
gate was retuned after the first run
([docs/19](../../docs/19-jevlang.md#4-record--replay--確率的な言語に必須の道具)).
