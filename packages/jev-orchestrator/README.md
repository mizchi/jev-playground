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

## The cost lives in the policy, not the prompt

docs/31 §2 is the reason `policy.ts` is a separate file: naming a cost *in the
prompt* moved the gate 21 points and skewed every error to one side. Naming it
*in code* cannot — a cutoff applied to an answer does not change the answer. So
the size floor, the worker cap and the gate cutoff are all applied after.

A pipeline shape (`sequential`, `handoff`) never gets more than two workers:
three workers on a pipeline is three workers waiting.

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

Two ways in, and the default is the second:

| | when |
| --- | --- |
| `before_agent_start` | the turn is starting and nothing is known yet |
| the `jev_orchestration` tool | the model has found out what the work is and asks |

The tool is the default because of [docs/36 §5](../../docs/36-routers.md): a
router that sees only the opening prompt is judging the least informative
description of the task that will ever exist. There, 21 prompts were one
identical string and the across-task spread came in *below* the draw noise.

## Limits

- 38 scenarios, written from the skill's own table. docs/31 §2b's per-class
  cells hold 4 to 22 cases each.
- The 22/22 topology figure is at the ceiling, so that corpus cannot compare
  ways of asking it — more confusable scenarios are needed.
- `gateAt` (0.5) is unfitted. `experiments/hermes` found that under the strict
  `cost` framing the gate answered 0.055–0.446 across eight varied turns —
  **entirely below 0.5**, so at this default the gate almost never fires. That
  is consistent with docs/31 §2b's 6/22 and it means the cutoff wants fitting
  against docs/31's labelled scenarios, per the framing in use.
