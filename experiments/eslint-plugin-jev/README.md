# eslint-plugin-jev

An ESLint rule whose verdict comes from Jev: a per-function review score,
every function in a file asked in one request.

Write-up with the numbers: [docs/21-eslint-plugin-jev.md](../../docs/21-eslint-plugin-jev.md).

```bash
npm install

npm test                     # 40 checks, no API key needed
npm run truth                # the labels, proved by running the code

export TYPESAFEAI_API_KEY=...
npm run warm                 # 12 requests, 56 functions, $0.001
npm run lint                 # eslint, reading the cached verdicts

npm run run -- --repeat 3    # the 4-arm measurement
npm run replay               # re-derive every number, no API key
npm run bench                # what each way around async costs
```

## What it reports

One rule, `jev/quality`, with three messages, because a team wants to switch
them on separately:

| message | fires when | means |
| --- | --- | --- |
| `jev/bug` | the atomic `misbehaves` noul >= 0.7 | probably wrong, not merely improvable |
| `jev/quality` | reviewer-action score >= 1.5, confidently | a reviewer would want this changed |
| `jev/unsure` | score >= 1.5 but confidence < 0.5 | worth a human look, not a fix |

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
