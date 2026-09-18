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

Three orderings cost nothing, and [docs/33 §1](../../docs/33-review.md) is the
reason they are in the same module and run on the same transcript — there, the
free features already contained the answer and the paid judgment added nothing,
and that was only visible because the free version was measured first.

| ranking | what it does |
| --- | --- |
| `oldest` | drop from the front. What nearly every agent already does. |
| `largest` | one 40,000-character file read outweighs fifty turns of talk. |
| `stale` | LRU by mention: nothing has referred to it since. |

`--compare` prints whether judgment's survivors differ from theirs at all. If
`largest` keeps the same entries, the ranking is not what is doing the work.

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

`onError: "baseline"` falls back to `largest`, for a caller whose reason for
being here is that summarisation costs too much to run at all. It trades a
silent loss for a bounded bill and should be chosen deliberately.

## Pi

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

## Limits

- **Nothing here is measured yet.** The structural constraints are tested; the
  ranking is not. The experiment recorded as TODO item 11 in
  [docs/06](../../docs/06-ideas.md) is the one to run: task completion by exit
  code, plus a string-match check that facts extracted before compaction
  survived it, against the three free baselines.
- `dropAt` (1.5) and `nothingSpareAt` (0.8) are unfitted and deliberately
  timid. docs/25's rule is that a cutoff belongs to a corpus.
- Tokens are estimated at four characters each, because the count is the
  server's to compute. It decides how much to delete, never whether a request
  fits.
