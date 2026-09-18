# jev-model-router

Ask [Jev](https://docs.typesafe.ai) how capable a model a request needs, then route to it.
A library, a CLI, and a [Pi](https://pi.dev) extension, sharing one decision function.

```bash
jev-model-router "rename the variable foo to bar in src/util.ts"
# claude-haiku-4-5-20251001 · effort low
#   reason rounded
#   tier 0.00 (conf 1.00)  underspecified 0.10  oversized 0.03
#   477 ms · 738 input tokens

jev-model-router "the scheduler deadlocks about once an hour under load and only in production; find out why and fix it"
# claude-opus-5 · effort high
#   reason rounded
#   tier 1.99 (conf 0.99)  underspecified 0.60  oversized 0.57
#   369 ms · 750 input tokens
```

Those two are real runs. One decision is about 740 input tokens, so **$0.00003 and
under half a second**.

## The design, and what measured it

Every shape here comes from a measurement in
[this repository's reports](../../docs/README.md), because each had a plausible
alternative that measured worse.

| Decision | Why | Source |
| --- | --- | --- |
| The tier ladder is a **`score`**, not a `choice` | The same decision asked as a `choice` got 14/24 however the thresholds were bent; as a `score` over the same ladder, 23/24. A `choice`'s confidence answers "which of these two labels", not "how far up" | [docs/01 §3](../../docs/01-shell-risk.md#3-順序のある結論は-score-で聞く) |
| Effort is a **second `score` in the same request** | Width is free: 74 questions in one request against 74 separate requests agreed within 0.25 on 99.8% of answers, for a third of the tokens | [docs/29 §4](../../docs/29-skill-select.md#4-ファンアウトの幅は無料答えが同じ) |
| "Too vague" and "too big" are **separate `noul`s**, not rungs | As an extra option inside the choice, an escape hatch caught 16/18 and pulled answerable-but-hard cases into itself; as its own question, 18/18 | [docs/17 §3](../../docs/17-task-picker.md#3-逃げ道は選択肢ではなく別の問いにする) |
| The task is in the **state**, the rubric in the **questions** | Shared text in the state halved the per-question cost (251 → 118 tokens); a question's own subject moved into the state dropped agreement to 53% | [docs/30 §7](../../docs/30-skill-pick.md#7-criteria-の文字列の値段), [docs/29 §4](../../docs/29-skill-select.md#4-ファンアウトの幅は無料答えが同じ) |
| Low confidence may send work **up, never down** | Confidence used as a gate cost 11 points; used to route, it pays | [docs/21 §7](../../docs/21-eslint-plugin-jev.md#7-confidence-をゲートにすると-11-ポイント損する) |

`gargpratyush/jev-router`, the closest prior art, asks a `choice` here. That is the
shape docs/01 measured as the worse one, so this package asks a `score` and
[docs/36](../../docs/36-routers.md) keeps the disagreement measurable rather than
settling it by assertion.

## The cutoffs are fitted, and the penalty is yours to name

A `score` answer is **continuous** — a three-level rubric returns 1.99, not 2 — so
"which rung is this" is a real question. The two ways of being wrong do not cost the
same:

- **under-route**: the model cannot do the task. The turn is lost *and* paid for.
- **over-route**: a cheaper model would have done. The cost is the price difference.

So cutoffs are placed where expected cost is lowest, not mid-gap, with
`failurePenalty` as an explicit parameter. **It has no default.** A code-review
router and a production-deploy router disagree about it by orders of magnitude, and
a default would hide that disagreement inside a library.

```ts
import { fitLadder, crossValidateLadder } from "@jev-playground/jev-core";

const fit = fitLadder(samples, rungs, { failurePenalty: 50 });
const honest = crossValidateLadder(samples, rungs, { failurePenalty: 50 });
// honest.heldOutCost is the number to report; fit.cost is fitted to its own samples
```

Until you have run that, `cuts: null` makes the router **round the score**, which
assumes the rubric's own levels are the right boundaries — the assumption
[docs/25](../../docs/25-thresholds.md) exists to disprove. `reason: "rounded"` versus
`reason: "fitted"` says which you are getting.

## Standalone

```ts
import { route } from "jev-model-router";

const { decision, judgment } = await route({ task: "fix the failing auth test" });
decision.model;   // "claude-haiku-4-5-20251001"
decision.effort;  // "low"
decision.reason;  // "rounded"
```

`route()` never throws. A missing key, a timeout, a 429, a malformed response: each
returns the configured fallback with `reason: "unavailable"` and the error text
alongside. The caller is an agent about to do work, and an exception here stops work
that judgment was only advising on.

Set `TYPESAFE_API_KEY`. `--dry-run` prints the exact payload and its byte size
without spending anything.

## As a Pi extension

```sh
pi install npm:jev-model-router
```

Add to `~/.pi/agent/settings.json`:

```json
{
  "jevModelRouter": {
    "mode": "pin",
    "tiers": [
      { "model": "claude-haiku-4-5-20251001", "label": "haiku", "price": 1, "says": "a small fast model is enough: ..." },
      { "model": "claude-opus-5", "label": "opus", "price": 15, "says": "the strongest model is needed: ..." }
    ],
    "fallback": "claude-opus-5",
    "cuts": [0.5]
  }
}
```

`/jev-model` shows the ladder, the pin and the cutoffs. `/jev-model mode turn`
re-decides every turn; `/jev-model unpin` re-routes once.

**`mode` is an open question, not a recommendation.** The two published Jev routers
disagree: `mejiasd3v/pi-jev-router` pins per session and only ever *suggests* a
change, `gargpratyush/jev-router` re-decides every turn. Neither measured it.
Pinning favours prompt-cache reuse; per-turn routing sends the easy turns of a hard
session somewhere cheap. `pin` is the default because it is the safer of two
unmeasured options, and docs/36 §4 reports which one wins once measured.

`src/pi.ts` is the only file that imports from Pi. Everything that can change a
decision is in `route.ts` and `policy.ts`, which import nothing host-specific — so
what the experiments measure is what ships.

## Limits

- **The tier rubric is three sentences I wrote.** Different wording is a different
  router. docs/24 measured that a criterion's phrasing can move a whole corpus.
- **`downgradeMaxContextTokens` is inherited untested** from
  `gargpratyush/jev-router`. The reasoning (a cheaper model rebuilds the prompt
  cache) is plausible and unmeasured.
- **Nothing here checks that the chosen model succeeded.** The router predicts;
  `experiments/router` is where the prediction meets `node --test`.
- `detectOverride` is a regex over the request. It catches "use opus for this" and
  not "could you possibly switch over to the opus model".

MIT.
