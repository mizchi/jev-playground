# jev-orchestrator

Ask Jev whether work should be split across several agents, and which of eight
shapes fits.

```bash
npx jev-orchestrator "port the API to v2 and update all the call sites"
npx jev-orchestrator "..." --both     # both wordings, one request
npm test                              # no API key
```

This is [docs/31](../../docs/31-orchestration.md)'s gate. That report set out to
find whether a documented boolean rule is better **asked** or **composed**, and
three of its findings decide this package's design.

## 1. Composing buys nothing

The [multi-agent-orchestration](https://github.com/mizchi/skills/tree/main/multi-agent-orchestration)
skill writes its rule as `(1 or 2) and (4)` over four named conditions. Both
routes were measured over 38 scenarios against the skill's own labels:

| | agreement |
| --- | --- |
| composed: four `noul`s, boolean in code | 30/38 |
| asked: one `noul` | **30/38** |

A tie. So this asks one question, because the four-question version has four
more ways to be wrong for no measured gain.

## 2. The wording is a 21-point dial — and it is not a ranking

The same decision, with the second worker's cost stated first, scored 22/38;
with the cost sentence deleted, 30/38. But the per-class breakdown shows the two
are not better and worse, they are **strict and loose**:

| class | n | cost named | cost unnamed |
| --- | --- | --- | --- |
| the skill's own traps | 7 | **6/7** | 4/7 |
| plainly multi | 22 | 6/22 | **18/22** |
| plainly single | 6 | **6/6** | 5/6 |

docs/31's conclusion: *if a false positive (an unnecessary split) is expensive,
name the cost first. If a false negative is expensive, do not.*

So `framing` is a setting, and its default here is **`cost`**. A resident
agent's expensive error is the unnecessary fan-out — every spurious worker is a
full-price session — and keeping a cheap agent cheap is what this is for.

> **Read the cutoff section below before taking the 21 points at face value.**
> Both columns above were scored at a shared 0.5, and the two wordings answer
> on different scales. Give each its own cutoff and the gap narrows to 8
> points: most of the dial was the threshold, not the wording.

`--both` asks both wordings in one request. When they disagree, the request is
on the boundary, and that is more useful than either answer alone.

## 3. Condition 3 is not a reason to spawn

The skill says so in bold. Putting it into the rule loses **4/4** on the cases
written to test exactly that. Asking directly never introduces it — a rule you
do not build cannot acquire a term the documentation forbids — and `test.ts`
asserts no question in the payload mentions a mechanical check at all.

## The topology is the strongest measurement in the repo

Eight patterns as `choice` criteria, taken from the skill's own table:
**22/22, zero confusions between patterns.** What gets mixed up is only the
"do not split at all" side, which is what the gate is for.

All eight stay in the question even when the host cannot run them, because
removing an option changes the question and the 22/22 was over all eight.
A pattern the host cannot run is **substituted afterwards** from the same
answer's probability distribution, at no extra request.

## The two wordings cannot share a cutoff

docs/31 §8 fitted the gate's cutoff on the same 38 scenarios, from the record,
with no new requests. The finding was not the number but the reason there have
to be two:

| wording | min | max | mean(single) | mean(multi) | draw sd |
| --- | --- | --- | --- | --- | --- |
| cost named | 0.090 | 0.780 | 0.208 | 0.406 | 0.012 |
| cost unnamed | 0.110 | 0.950 | 0.320 | 0.665 | 0.013 |

**The two answer on different scales.** Read at a shared 0.5, the compressed
one merely *looks* strict — which is a large part of what §2b measured as a
framing effect. Give each its own cutoff and the plain-agreement gap between
them narrows from 20 points (66 vs 89 of 114) to 8 (84 vs 93).

So `GATE_AT` is `{ cost: 0.5, plain: 0.73 }`, and `gateAt: null` (the default)
resolves from the framing. The shipped 0.5 was right — because it is the
`cost` wording's zero-false-positive point on this corpus, not because it is a
round number. The same 0.5 applied to `plain` is the **worst** of the nine
configurations measured: held-out loss 1.167 against 0.579 for doing nothing.

Six of those nine lost to always-single. A gate has to be compared against
doing the cheap thing, which is docs/36 §5's lesson arriving in a second
component.

## The cost lives in the policy, not the prompt

docs/31 §2 is the reason `policy.ts` is a separate file: naming a cost *in the
prompt* moved the gate 21 points and skewed every error to one side. Naming it
*in code* cannot — a cutoff applied to an answer does not change the answer. So
the size floor, the worker cap and the gate cutoff are all applied after.

A pipeline shape (`sequential`, `handoff`) never gets more than two workers:
three workers on a pipeline is three workers waiting.

**The size floor is off by default**, and that is docs/31 §9's result rather
than a simplification. `minSize` is a veto *behind* the gate, and §8 put the
gate at its zero-false-positive point — so everything reaching the veto is a
genuine multi and every veto destroys a correct decision: 4 of 18 under `cost`
and 9 of 33 under `plain`, with none caught. Sweeping the two together finds a
better in-sample cell (gateAt 0.4 with minSize 0.3, loss 0.368 against 0.421),
but cross-validating that *selection* costs 0.842 — worse than every fixed
option and worse than doing nothing. Turn the floor on for a gate you have
reason to think has false positives; this one does not.

## What it does not do

**It advises; it does not dispatch.** Pi's extension surface has no way to spawn
an agent, and what docs/31 measured is the *decision*, not the execution.
Nothing measured says Jev can decompose work into worker assignments, so the
brief names a shape and says outright that the division of labour is the
caller's.

The inverted `stay_single` framing is asked, recorded, and deliberately **not
wired into the decision**: docs/31 §2b measured it as the loosest reading of all
on the skill's own traps (3/7 against the gate's 6/7), so letting it veto would
replace the strictest signal with the weakest. A disagreement between the two is
surfaced instead.

## Pi

```sh
pi install ./packages/jev-orchestrator   # from the repository root
pi install ./pi/components               # or all five components at once
```

**Not from npm** — this repository's packages are unpublished and `npm:jev-orchestrator`
is a 404, so a local path is the only spelling that installs it. `pi/README.md`
has the assembled form; `cd pi && npm run load` checks both lines above.
The `pi -e` form further down loads it for **one run** without installing.

Two ways in, and the default is the second:

| | when |
| --- | --- |
| `before_agent_start` | the turn is starting and nothing is known yet |
| the `jev_orchestration` tool | the model has found out what the work is and asks |

The tool is the default because of [docs/36 §5](../../docs/36-routers.md): a
router that sees only the opening prompt is judging the least informative
description of the task that will ever exist. There, 21 prompts were one
identical string and the across-task spread came in *below* the draw noise.

Which route runs is a **flag**, because pi passes configuration to an
extension through `registerFlag`/`getFlag` and through nothing else
([docs/38 §6](../../docs/38-agent.md), which found that while trying to reach
the other route):

```sh
pi -e .../jev-orchestrator/src/pi.ts --jev-advise turn --jev-framing cost
```

Both routes are exercised inside a real pi session in
[docs/38 §7.5](../../docs/38-agent.md): the tool declined a request written
from the skill's own `fanout` row at gate 0.29, and the turn route split at
gate 0.50 — which is *on* the cutoff, so read that one decision as a coin
toss.

## Limits

- 38 scenarios, written from the skill's own table. docs/31 §2b's per-class
  cells hold 4 to 22 cases each.
- The 22/22 topology figure is at the ceiling, so that corpus cannot compare
  ways of asking it — more confusable scenarios are needed.
- The cutoffs are fitted on 38 scenarios with 5 folds, which is small. The
  `plain` figure of 0.73 in particular comes from a placement rule whose fold
  cutoffs held still (0.70–0.73), not from a wide gap — all three wordings
  come back `overlapping`, so no cutoff here is both sound and complete.
- The fit is in the **asymmetric** regime (a false positive costing ~10× a
  false negative). If errors are symmetric, `plain` at 0.5 is the better
  configuration and these defaults are wrong for you; set `gateAt`.
- Inside pi this has produced **two** live decisions (docs/38 §7.5), one of
  them on the cutoff. That is evidence the wiring works and no evidence about
  judgment quality.
- Pi has no API for spawning an agent, so this advises and never dispatches.
  Nothing here measures whether jev can decompose work into worker
  assignments — docs/31 measured the *decision*.
