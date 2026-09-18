# eslint-plugin-jev

An ESLint rule whose verdict comes from Jev: a per-function review score,
every function in a file asked in one request.

Write-ups with the numbers: [docs/21](../../docs/21-eslint-plugin-jev.md) (the plugin, the
synchronous-rule problem, batching) and [docs/22](../../docs/22-code-criteria.md) (what changes
when you name eight concrete defect classes instead of asking one vague question, and how deep
the hole is for the classes you did not name).

```bash
npm install

npm test                     # 59 checks, no API key needed
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

A `--from` replay scores with the thresholds the run was RECORDED with, so retuning a
cutoff cannot rewrite an already-published report. Add `--current-thresholds` to see what
today's defaults would have done to that same run.

## What it reports

One rule, `jev/quality`, with four messages, because a team wants to switch
them on separately:

| message | fires when | means |
| --- | --- | --- |
| `criterion` | a NAMED criterion clears its own cutoff | the only one that says WHAT is wrong |
| `jev/bug` | the generic `misbehaves` noul >= 0.7 | probably wrong, not merely improvable |
| `jev/quality` | reviewer-action score >= 1.5, confidently | a reviewer would want this changed |
| `jev/unsure` | score >= 1.5 but confidence < 0.5 | worth a human look, not a fix |

```
  8:8  warning  `median` matches the review criterion `api_default` (0.35, its cutoff is 0.22)
```

`rubric` picks the question set. `vague` is docs/21's two questions per
function; `full` adds the eight named criteria (10 questions per function,
still one request per file). docs/22 measured 41/51 caught for `full` against
33/51 for `vague`, at the same false-positive count — and the cutoffs are
**per criterion**, because their answers are not on the same scale (0.20 to
0.94 on their own class).

Naming the classes only pays on defects you cannot see from the function's own
text: docs/22's addendum measured 15/15 either way on visible ones and 14% →
52% on the rest. And the eight criteria overlap — drop any one but
`api_default` and a neighbour or the generic noul still catches its class.

`criterionAt` is fitted, and has been refitted once already; it is the first
thing to retune on your code.

## The one hard problem

**ESLint rules are synchronous.** `context.report()` has to happen during the
traversal and no hook may return a promise, so a rule cannot await an HTTP
request. Three ways out, and the plugin does all three so the cost of each is
visible:

| | setup | lint time (12 files) |
| --- | --- | --- |
| warm cache (default) | run `warm.mjs` first | **31 ms** |
| `onMiss: "ask"` | none | 4327 ms — a blocking child per file |
| `onMiss: "report"` | none | 31 ms, and CI fails on a cold cache |

## Layout

```
src/functions.mjs   AST -> the unit of judgment (one function)
src/judge.mjs       the questions, the rubric, the gate, the token ceilings
src/cache.mjs       the verdict cache; never throws at the plugin
src/index.mjs       the ESLint plugin
src/warm.mjs        the out-of-band batched pass (and the batch planner)
src/sync-ask.mjs    the child process `onMiss: "ask"` blocks on
src/jev.mjs         zero-dependency client, splits a batch the server rejects

experiment/corpus/  12 files, 56 functions, labelled
experiment/labels.mjs  the labels, and a probe that RUNS the code to prove them
experiment/truth.mjs   checks the labels; spends nothing
experiment/run.mjs     the measurement, with `--from` replay
experiment/test.mjs    fail-safe paths and the gate's truth table
```

`experiment/out-run.json` is a recorded run: `npm run replay` re-derives every
number in the write-up from it with no API key and no variance. That is how
the gate was retuned after the first run
([docs/19](../../docs/19-jevlang.md#4-record--replay--確率的な言語に必須の道具)).
