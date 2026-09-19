# jev-hermes

A resident Pi agent whose model, skills, permissions, memory and orchestration
are all decided by Jev — on **one request per turn** and **one shared budget**.

```bash
npx jev-hermes "the auth middleware rejects valid tokens after an hour"
npx jev-hermes --budget                       # what a day costs
npx jev-hermes "..." --compare --repeat 3     # the measurement below
npm test                                      # no API key
```

Loading the five components separately works and is the right thing for an
interactive session. This exists for the other case: an agent that is always
on, where the costs that do not matter for an afternoon are the only costs that
matter.

| component | package |
| --- | --- |
| model + reasoning depth | [jev-model-router](../jev-model-router) |
| skill selection | [jev-skill-router](../jev-skill-router) |
| guard rail | [jev-guard](../jev-guard) |
| memory compaction | [jev-compact](../jev-compact) |
| orchestration | [jev-orchestrator](../jev-orchestrator) |

## What it costs

A combined turn request is about **1,300 input tokens** measured, at
$0.042/MTok with output free:

| turns/day | judgment $/day | $/month |
| --- | --- | --- |
| 50 | $0.0022 | $0.07 |
| 200 | $0.0088 | $0.26 |
| 1,000 | $0.0438 | $1.32 |
| 5,000 | $0.219 | $6.58 |

The guard rail is charged separately and only for calls that can alter
something — reads are free, and for a resident agent reads are most of the
traffic.

## The ladder: escalation, not routing

The caller's requirement was to switch between Sonnet and Opus and the depth of
reasoning by difficulty. [docs/36 §5](../../docs/36-routers.md) measured what
happens if you do that naively: on 53 repair tasks, 52 needed only the cheapest
tier, a fitted cost ladder recovered nothing but the constant, and at a high
failure penalty **every arm was worse than doing nothing** on held-out tasks
(1.81 fitted, 3.54 held out, 2.89 always-cheap, 1.04 for a perfect router).

So the two axes are treated differently:

- **Tier is escalation.** Two rungs, one cut at **0.85** on a 0..1 ladder. A
  middling tier score stays on Sonnet. Opus is reached by a decisively top
  score or by an escape hatch.
- **Effort is the primary dial.** It is free to move and it does not invalidate
  the prompt cache, where switching models does — a resident agent that changes
  model mid-session pays to rebuild the cache and then pays the dearer rate.
  docs/36 §5's cost table is about the tier axis; the effort axis is the one
  whose wrong answers are cheap.

## One request per turn, and why that needed measuring

Three components fire at `before_agent_start` and judge the same request.
Separately that is three round trips carrying three copies of the state; here
it is one. The reason to expect that to be free is
[docs/29 §4](../../docs/29-skill-select.md) — 74 questions together against the
same 74 one at a time gave 99.8% of answers within 0.25 for a third of the
tokens.

But that fan-out was many questions of one *kind* over one *state*, and this is
three states unioned. **So it was measured** (`experiments/hermes`, 8 turns ×
4 repeats × 2 ways, 64 draws, $0.0039) and the answer is not the comfortable
one:

| | |
| --- | --- |
| tokens saved | **18%** (1,582 → 1,292 per turn), one request instead of two |
| answers that moved more between the two ways than between repeats of one way | **7 of 7** |
| turns whose *decision* agreed | **5 of 8** |

Combining is **not** free. The shift is small (0.024–0.058) but systematic, and
the draw noise it is measured against is tiny (0.006–0.022). It only matters at
a cutoff — and all three decision disagreements were cutoff crossings, not
movement.

Latency is not the saving: the separate path runs its requests concurrently, so
what is bought is tokens and rate-limit headroom.

## What that measurement found by accident

`underspecified` separates the extremes cleanly — 0.060 for "rename the
variable `res` to `response`", 0.954 for "make the dashboard better" — and puts
**six of eight turns in 0.606–0.729**. The model router's escape-hatch cutoff
was a hard-coded **0.70**, sitting in the middle of that cluster, so most
traffic landed within one draw-deviation of the boundary and two of the three
disagreements above were this hatch flipping.

Two changes came out of it: the cutoff became `escalateAt` in `RouterConfig`
(default still 0.7, so nothing else changed), and hermes sets **0.85**, which
puts the vague turn above and all six of the cluster below with about 0.12 of
margin each side. Eight unlabelled turns is not a corpus, so that is a cutoff
moved *out of a noise band* rather than fitted to a label.

## The budget, and why a hard ceiling is safe

"Resident" changes what a cost is. A component measured at $0.000032 per
decision is free for an afternoon and not obviously free for a month of an
agent that never stops, because the number that matters is decisions per day
and nobody knows it in advance. So the ledger is shared and it has a ceiling
(24M input tokens/day ≈ $1.01, a round number rather than a measurement).

What happens at the ceiling is the careful part: **every component's
no-judgment path is the host's own behaviour**, by construction.

| component | with no judgment |
| --- | --- |
| model router | stays on the current model |
| skill router | loads the catalogue's `always` set and nothing else |
| guard rail | emits no verdict; the host's permission rules apply |
| compactor | defers; the host's summarising compaction runs |
| orchestrator | one agent |

That list is not luck — each component was built that way — and it is the
property that makes stopping safe. A future component without it must not be
added to this ledger.

## What it deliberately does not batch

The guard rail. It sits on the critical path of every tool call, wants one
attempt and a hard 2,500 ms budget
([docs/18 §1](../../docs/18-permission-hook.md)), and fires long after the turn
request returned. Folding it in would trade the one property that makes it
usable for a round trip it cannot save.

## Pi

Configuration is **flags**, because pi has no other mechanism:
`ExtensionFactory` is `(pi: ExtensionAPI) => void` — one argument — and
`ExtensionAPI` exposes `registerFlag`/`getFlag` and no settings reader at all.
An earlier version of this section showed a `{ "jev-hermes": { ... } }` block
and it was fiction ([docs/38 §6](../../docs/38-agent.md), which found it while
trying to turn the orchestrator on).

```sh
pi -e .../jev-hermes/src/pi.ts \
   --hermes-advise turn \              # orchestrator: judge the opening prompt
   --hermes-compact-keep-recent 2 \    # deletion floor, entries
   --hermes-compact-budget 40000 \     # message budget, tokens
   --hermes-unattended-ask block \     # what ASK means with no human present
   --hermes-off                        # disable every jev component
```

`--hermes-advise turn` is the flag that made the orchestrator's other route
reachable at all; `--hermes-compact-keep-recent` is what let a short test
transcript have anything droppable in it. Both are measured in
[docs/38 §7](../../docs/38-agent.md).

`/hermes` prints what every component decided this turn and what the day has
cost, per component. `/hermes guard off` disables one.

## Limits

- The combine measurement is 8 turns × 4 repeats, unlabelled. It compares two
  ways of asking, which needs no ground truth — but it says nothing about
  whether either way is *right*.
- Under the strict `cost` framing the orchestration gate answered 0.055–0.446
  across all eight turns, entirely below its 0.5 default, so **it almost never
  fires**. Consistent with docs/31 §2b's 6/22 on plainly-multi cases. The
  cutoff is now fitted against docs/31's 38 labelled scenarios
  ([docs/31 §8](../../docs/31-orchestration.md)) and is per-framing.
- `jev-compact`'s ranking is untested; only its structural constraints are.
  [docs/38 §7.4](../../docs/38-agent.md) verified deletion at the wire — the
  payload got smaller and tool-call pairing survived — which says the mechanism
  works, not that it deletes the right things. The comparison against the free
  `oldest`/`largest`/`stale` rankings has not been run.
- The message budget handed to the compactor is **approximate by
  construction**: pi's token count and `jev-compact`'s differ, and the
  difference is absorbed into `overhead`, which moves as the transcript grows
  (2,225 / 1,984 / 2,401 / 2,490 over four calls). The floors are exact and are
  what actually protects the transcript.
- No resident agent has actually been left running on this. Every number above
  is either from a labelled corpus in `docs/`, from 64 draws over invented
  turns, or from 18 one-turn pi sessions against a scripted model
  ([docs/38](../../docs/38-agent.md)); the per-day figures are arithmetic over
  an assumed turn count. **Nothing here is evidence about task quality** —
  there was no model in the loop.
