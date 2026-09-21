# jev-compact

Compact an agent's context by **deleting** spent entries, not summarising them.

```bash
npx jev-compact transcript.json --budget 40000 --baselines   # free, no key
npx jev-compact transcript.json --budget 40000 --compare
npm test                                                     # no API key
```

## Why deletion

The premise is a constraint, not a preference: **Jev cannot generate text.** It
answers questions about a state; it does not write. So compaction driven by Jev
is necessarily *selection* — keep these entries, drop those.

That turns out to be the better half of the trade, for a reason that has
nothing to do with what Jev can do:

- **A deletion is verifiable.** You can say exactly what is gone, and a test
  can assert that a named fact survived.
- **A summary is not.** It can quietly invent, drop a qualifier, or merge two
  facts into a false one, and the only way to notice is to still have the
  original — which is what was just thrown away.

`tamaratran/fast-jev-compaction` states the same rule and this package follows
it.

## What judgment is not allowed to decide

Three constraints are enforced in code, above any score:

1. **Tool-call pairing.** Dropping an assistant message that made a tool call
   while keeping its result — or the reverse — produces a conversation most
   providers reject outright. That is a validity question, not a quality one,
   so `closePairs` computes it and the policy cannot override it. It iterates
   to a fixed point, because retracting one drop can un-drop its partner.
2. **The goal survives.** The first user message is the task. Losing it is not
   recoverable from anything left behind.
3. **A recency floor.** The last few entries are the working set. A gate that
   can delete what just happened will eventually delete what the next step
   needed, and no score is worth that.

## What it asks

One `score` per candidate entry, over four ordered levels — *spent*,
*superseded*, *background*, *live* — plus one `noul` escape hatch that cancels
the whole compaction when nothing is spare yet
([docs/17 §3](../../docs/17-task-picker.md): a hatch belongs in its own
question, 18/18 against 16/18 as an extra level).

The request carries a **bounded digest** of each entry, not the entry. A
transcript is being compacted *because* it is too big to send, so a question
carrying its entry whole would fail on exactly the inputs this exists for. The
digest is head-and-tail: for a tool result the head says what was attempted and
the tail says how it ended, and "did this command fail" is most of what decides
whether its output is still needed.

So the request grows with the **number** of candidates, not their size.
`test.ts` asserts it: 50× the transcript grows the payload 1.8×, and 5,000×
grows it no further.

The level text lives in the state and is paid for once
([docs/30 §7](../../docs/30-skill-pick.md): 251 tokens per question became
118).

## Measure the free rankings first

Four orderings cost nothing, and [docs/33 §1](../../docs/33-review.md) is the
reason they are in the same module and run on the same transcript — there, the
free features already contained the answer and the paid judgment added nothing,
and that was only visible because the free version was measured first.

| ranking | what it does | facts kept (80/60/40/25% budget) |
| --- | --- | --- |
| **`overlap`** | **how much of the GOAL's vocabulary the entry contains. Drop what shares least with the task.** | **100 / 89 / 89 / 67%** |
| `oldest` | drop from the front. What nearly every agent already does. | 78 / 67 / 44 / 11% |
| `largest` | one 40,000-character file read outweighs fifty turns of talk. | 56 / 44 / 22 / 11% |
| `stale` | LRU by mention: nothing has referred to it since. | 78 / 67 / 56 / 11% |
| *(judgment)* | *the paid ranking, for comparison* | *100 / 100 / 100 / 96%* |

Measured in [docs/39](../../docs/39-compact-ranking.md): 8 transcripts of real
tool output, scored by whether the substrings their own final answers were
computed from survived the deletion.

**`overlap` was added after measuring, and it is the finding.** The other
three are the orderings that occurred to me when this package was written,
and judgment beat them by 18 to 85 points — a gap large enough that the
comparison was the more likely explanation. It was not the comparison: the
baselines were simply the wrong baselines. What judgment mostly does is
separate **the task's own work from the exploration around it** (mean AUC
0.751 per transcript), and a word count against the goal does that for free.

So the question a host faces is not "judgment or nothing", it is "judgment or
`overlap`", and the answer depends on the budget: **a tie at four fifths of
the window, 96% against 78% at a quarter** — and that is after giving
`overlap` 27% more tokens than judgment kept, since different orders overshoot
the budget differently and judgment overshoots least.

`--compare` prints whether judgment's survivors differ from theirs at all. If
`overlap` keeps the same entries, the ranking is not what is doing the work.

## Two outcomes that are not deletions

| outcome | meaning |
| --- | --- |
| `fits` | already under budget |
| `cannot-fit` | **the floors alone exceed the budget.** Deletion is the wrong tool; the host should summarise. A compactor that deleted everything droppable and still came back over budget would have spent the transcript and solved nothing. |

## On failure it defers

`onError: "defer"` (the default) returns the transcript untouched, handing the
problem to whatever the host does when it runs out of context — usually a
summarising compaction.

That is the right default because **over-deletion is undetectable**: an entry
deleted on no judgment is gone, and nothing afterwards can notice that the fact
it carried is missing. A summary that loses the same fact is at least a known
quantity.

That asymmetry is about deleting on NO judgment, and it survives
[docs/39 §7](../../docs/39-compact-ranking.md) — but the neighbouring claim
that a summary loses facts more silently than a deletion does not. Measured
against extractive summarisers on the same transcripts, 108 fact-checks
produced no severed fragment: line-boundary cutting loses a value whole. What
deletion actually wins on is fact survival, because a summary spends the
budget on every entry and cuts the live ones too: 100/100/100/96% against
100/78/78/67% from the same requests at the same price.

`onError: "baseline"` falls back to `overlap`, for a caller whose reason for
being here is that summarisation costs too much to run at all. It trades a
silent loss for a bounded bill and should be chosen deliberately.

It fell back to `largest` until [docs/39](../../docs/39-compact-ranking.md)
measured the four: the budget is in tokens, so freeing it by deleting the big
entries is the obvious move, and it turned out to be the worst of them. The
reasoning was about how much space a deletion frees; the question was which
deletion costs least.

## Pi

```sh
pi install ./packages/jev-compact    # from the repository root
pi install ./pi/components           # or all five components at once
```

**Not from npm.** This repository's packages are unpublished, and `jev-compact`
on npm is [aleksvega/fast-jev-compaction](https://github.com/aleksvega/fast-jev-compaction)
— a different author's compactor. A local path is the only spelling that
installs this one; `pi/README.md` has the assembled form, and
`cd pi && npm run load` checks both lines above against Pi's own resolver.

Two hooks, and the claim is that the first makes the second unnecessary:

| hook | what it does |
| --- | --- |
| `context` | fires before every LLM call and returns a **subset** of the messages |
| `session_before_compact` | cancels Pi's summarisation when deletion already got under the threshold |

A summarisation is a full-price LLM call over the whole transcript; a deletion
is one $0.042/MTok request over digests. `/jev-compact` counts how many were
avoided.

Nothing is deleted from the stored session — `context` shapes only what is
*sent*, so `/jev-compact restore` puts it all back. That is what makes a wrong
deletion recoverable, and it is the difference between this and a summary.

**Configuration is flags.** Pi passes nothing else to an extension:
`ExtensionFactory` takes one argument and `ExtensionAPI` has no settings reader
([docs/38 §6](../../docs/38-agent.md)). Through `jev-hermes` the reachable ones
are `--hermes-compact-keep-recent` and `--hermes-compact-budget`; this package's
own `pi.ts` registers none, so it ships its defaults.

**The budget it is handed is approximate, and the floors are not.** Pi counts
the whole context — system prompt, tool schemas, context files, messages —
and this package can only delete messages, so a caller has to subtract the
overhead before passing a budget in. That overhead includes the disagreement
between two token estimators, and it moves as the transcript grows
([docs/38 §5](../../docs/38-agent.md) measured 2,225 / 1,984 / 2,401 / 2,490
over four calls in one session). `keepRecent` and the goal pin are exact.

## Limits

- **The ranking is measured on 8 transcripts carrying 9 facts**
  ([docs/39](../../docs/39-compact-ranking.md)), so one fact moves the score
  11 points and the 18-point margin at the tightest budget is worth 1.6 facts.
  The tasks, and where each one's needed fact sits in its transcript, are mine.
- **Scored by fact survival, not by task completion.** docs/06's TODO 11 named
  two measures and this is the second: whether substrings the answer was
  computed from are still present. The first — continue the work after
  compaction and read the exit code — needs model credentials this environment
  does not have (the same wall as [docs/38](../../docs/38-agent.md)).
- **"Needed" means needed by ONE known follow-up.** A resident agent also holds
  memory whose use is not yet known, and nothing here measures that.
- **Deletion has not been compared against summarisation**, only against other
  deletion orders. The claim that a deletion is verifiable and a summary is not
  remains a design argument.
- `dropAt` (1.5) and `nothingSpareAt` (0.8) are unfitted and deliberately
  timid. docs/25's rule is that a cutoff belongs to a corpus.
- Tokens are estimated at four characters each, because the count is the
  server's to compute. It decides how much to delete, never whether a request
  fits.
- `outcome: "deleted"` does **not** promise the budget was met. It will not
  delete an entry judgment called live to hit a number, so a run can delete
  everything it is allowed to and stay over — it says so in `reason`
  ([docs/38 §7.4](../../docs/38-agent.md) has such a run: 12 dropped,
  2282 → 1419 tokens, budget 1010).
