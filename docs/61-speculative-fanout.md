# 61. Speculative fan-out: asking for the target before you know the operation

`browser-use/jev-ultrafast` drives a browser with the same Jev API this repo
uses, and gets a Google Flights search done in about 7 seconds. Its central
trick is a shape, not a model: instead of one question over one flat list of
elements, it sends **one `operation` question and one target question per
operation, in the same request** — then reads only the target head that the
chosen operation names, and throws the rest away.

```
                      one Jev request
                     ┌───────────────────────────┐
page → element table → operation                 │
                     │ click_target              │
                     │ type_text_target          │
                     │ select_target, if present │
                     └─────────────┬─────────────┘
                         use the matching target
```

Two decisions, one round trip. The unused heads are answered and discarded.

This repo's own driver (`experiments/browser-chaos/src/jev-driver.ts`, and the
harness in `confidence-bench.ts`) already uses one request per step, so the
round trip is not what is on offer here. What is on offer is the **typed
split**: each head contains only elements that accept that operation, and the
`SELECT` head offers `index:option` pairs rather than elements.

So the question worth paying for is narrower than "is fan-out faster". A
fanned-out target head is answered **without knowing which operation won** —
it is conditioned on "assume the operation is CLICK, which element". A
sequential asker gets to condition on the operation as a decided fact. Nobody's
README says whether that speculation costs accuracy. That is what this measures.

- Run it: `cd experiments/browser-chaos && TYPESAFEAI_API_KEY=… npx tsx src/run-fanout.ts --select many --seeds 2 --steps 18 --verbose`
- Try to break it (§8): `npx tsx src/run-adversarial.ts --select hostile --runs 2 --steps 9 --verbose`
- No key needed: `npx tsx src/check-fanout.ts`

## 1. Four arms

| Arm | Shape | Requests per step |
|---|---|---|
| `flat` | one `pick` over every candidate; the operation is implied by the element's type | 1 |
| `flat-memo` | the same, but the caller remembers which dropdown options it has already set | 1 |
| `fanout` | `operation` + every `<op>_target`, one request; only the named head is read | 1 |
| `sequential` | `operation`, then the one `<op>_target`, the second knowing the first | 2 |

`sequential` is what makes this an experiment rather than a demo: it is the
arm that pays a round trip for a target chosen under a *decided* operation.
`fanout` is only worth having if it matches `sequential`'s decisions at
`flat`'s request count.

The board is the docs/05 shop under a new flag. `?select=1` puts a shipping
dropdown on the last checkout step and **gates `Place order` on it**, so
skipping the dropdown cannot reach `#/confirm`. `?select=many` gives the same
dropdown six real options with the wanted one last. The goal names the value:

> Buy the Widget and complete the checkout to the order confirmation. Choose
> express shipping — next-day — when a shipping method is offered.

Naming it is what makes a target gradable. "Set the dropdown" is satisfied by
any option; "choose express" is satisfied by one.

## 2. Two options: the flat shape costs one step

Three runs per arm, 14-step budget.

| arm | goal | steps | wasted | reqs | in_tok | out_tok | ms | express |
|---|---|---|---|---|---|---|---|---|
| `flat` | 3/3 | 11.0 | 0.0 | 11.0 | 11,065 | 1,617 | 1,718 | 3/3 |
| `fanout` | **3/3** | **10.0** | 0.0 | **10.0** | 15,788 | 1,858 | 1,608 | 3/3 |
| `sequential` | 3/3 | 10.0 | 0.0 | 20.0 | 17,070 | 1,434 | 3,136 | 3/3 |

Everything arrives. The flat arm's extra step is the dropdown, and reading the
trace is the point:

```
flat        step=8 SELECT@0.99 ok  select-one field "Shipping method" = standard
            step=9 SELECT@0.89 ok  select-one field "Shipping method" = express
            step=10 CLICK@0.99 ok  button "Place order"

fanout      step=8 SELECT@0.68/t1.00 ok  select-one field "Shipping method" = express
            step=9 CLICK@0.96/t0.99 ok   button "Place order"
```

The flat arm reaches `express` **by elimination, not by choice.** Its pick
names the element; the option has to come from a caller heuristic, which sets
`standard` first and only returns `express` on the next step because
`standard` is now the current value. It lands on the right answer because
there was only one other place to land.

`flat-memo` is not listed because on two options it cannot differ — with a
single real alternative both heuristics take the same option in the same
order, which `check-fanout.ts` pins rather than leaving to argument.

## 3. Six options: the flat shape stops arriving

Two runs per arm, 18-step budget, same goal.

| arm | goal | steps | wasted | reqs | in_tok | out_tok | ms | express |
|---|---|---|---|---|---|---|---|---|
| `flat` | **0/2** | 18.0 (budget) | **0.0** | 18.0 | 18,769 | 2,632 | 2,794 | 0/2 |
| `flat-memo` | 2/2 | 15.0 | 0.0 | 15.0 | 15,499 | 2,197 | 2,164 | 2/2 |
| `fanout` | **2/2** | **10.0** | 0.0 | **10.0** | 16,149 | 1,928 | **1,472** | 2/2 |
| `sequential` | 2/2 | 10.0 | 0.0 | 20.0 | 17,331 | 1,474 | 3,132 | 2/2 |

The flat arm burned its whole budget on one dropdown:

```
flat  step=8  SELECT@0.98 ok  … = standard
      step=9  SELECT@0.93 ok  … = economy
      step=10 SELECT@0.93 ok  … = standard
      step=11 SELECT@0.97 ok  … = economy
      …                              (ten consecutive SELECT steps)
      step=17 SELECT@0.95 ok  … = economy
```

**It does not enumerate — it oscillates.** "First option that is not the
current value" maps `"" → standard`, `standard → economy`,
`economy → standard`, so options three through six are unreachable no matter
how long the budget is. My first version of this heuristic was worse still:
it included the placeholder, so the dropdown unset itself every other step.

Both are caller bugs rather than facts about the shape, which is exactly why
`flat-memo` is in the table. Given a memory of what it has tried, the flat arm
enumerates and arrives — in five extra steps. That is the honest cost of the
flat shape on six options, and it scales with the option count: a country
picker would cost dozens.

Three things in that table are worth naming separately.

**`wasted` is 0.0 for the arm that failed.** Every one of those ten
oscillating steps changed the page, so a no-op detector — the metric docs/05
and docs/57 lean on — sees nothing wrong. An arm can be in a permanent loop
with a clean wasted-step count.

**Confidence was 0.93–0.99 the whole way down.** The flat arm was not unsure.
It was being asked an easy question ("which control matters here?") whose
answer was right, while the decision it was actually getting wrong — which
value — was never put to a model at all. docs/57 found confidence to be a poor
wasted-step detector; this is the same gap from the other side: **the model
cannot report doubt about a decision it was not asked to make.**

**The typed arms report *lower* confidence and are *more* correct.** On the
SELECT step, `flat` sits at 0.98 and `fanout` at 0.46–0.71. The typed arm is
choosing between `SELECT` and `CLICK`(Place order) — a real fork — where the
flat arm is choosing an element with an obvious answer. Confidence is a
property of the question, so **it is not comparable across arms whose question
shapes differ.** Any threshold tuned on one shape has to be retuned for the
other.

## 4. The speculation is free

This is the result the mechanism lives or dies on, and it is unambiguous:

**`fanout` and `sequential` produced identical decisions in every run of both
fixtures** — the same operation sequence, the same targets, the same step
counts. Target confidence was 0.98–1.00 in both. Operation confidence on the
hard SELECT step tracked closely too (`fanout` 0.46–0.71, `sequential`
0.46–0.69).

So a target head answered under "assume the operation is X" agreed with one
answered after X was decided, on every step where it mattered. The speculation
cost nothing measurable, and `fanout` bought:

- **half the requests** (10 vs 20 per run), and
- **53% less wall-clock in the model** (1,472 ms vs 3,132 ms on six options).

**Tokens are close to a wash, not a win.** `fanout` sends more input per step
than `flat` — 1.43× on two options, because the extra heads' criteria are on
the wire. Per *run* on six options it comes in under `flat` (16,149 vs 18,769)
and under `sequential` (17,331, which sends the whole state twice), but
**`flat-memo` is cheaper than all of them at 15,499**: fifteen steps of a
one-question request beat ten steps of a four-question one. Output tokens are
where the speculation shows up plainly — 1,928 against `sequential`'s 1,474,
because heads nobody read still got answered.

So `fanout` is not bought with tokens and does not save them either. What it
buys over `flat-memo` is **five fewer steps**: five fewer actions taken against
the real application, five fewer browser round trips, and a third less
wall-clock. On a real app, steps are the expensive unit — each one is a
mutation that can fail, race, or need undoing.

## 5. What came back with it

Two things worth having independently of the fan-out.

**`validateChoice`.** `shared/jev.ts`'s `choice()` returns
`{ choice: "", confidence: 0 }` for anything it does not recognise, and every
caller in this repo then reads that as an invalid index and skips the step —
silently. jev-ultrafast's `validate_choice` is the better contract, and its
checks are cheap: the distribution has to cover exactly the offered keys, sum
to 1, and put its mass on the key that was returned. The last one is the one
that would otherwise never be caught — an answer whose `choice` is not its own
argmax means the answer and its reasoning point at different elements.
`check-fanout.ts` runs eleven rejection cases against it, including that a tie
is a real answer and not a rejection.

**Lazy validation.** Only the head the operation names is validated.
jev-ultrafast's comment says why — "unused target heads cannot cause an
action" — and it is load-bearing: validating all of them lets a malformed
answer on a head nobody was going to read abort a decision that was sound.

## 6. Already upstream, from the other direction

`jev-ultrafast`'s README lists "resolve current geometry and reject covered
controls before input" among the things that make it work, and its
`browser.py` refuses to act when `!e.contains(document.elementFromPoint(x,y))`.
That is the same mechanism as this repo's `probes.ts` geometry pass and the
`coveredBy` / `isObstructed` pair that docs/57 §6 landed in chaosbringer
([#143](https://github.com/mizchi/chaosbringer/pull/143)) — arrived at
independently, on the same evidence, and it is a useful corroboration that the
description of a control cannot tell you whether a click on it lands.

Its `fingerprint` guard is the same idea as chaosbringer's per-step candidate
refresh ([#142](https://github.com/mizchi/chaosbringer/pull/142)): a decision
is bound to the observation it was made on, and a page that moved underneath
invalidates it rather than being clicked anyway.

## 7. What to adopt

1. **Split the action space by operation, and make the target the thing you
   execute.** This is the whole finding. A target that names an element leaves
   the caller guessing a value, and on anything wider than a two-option
   dropdown the guess either costs a step per option or never terminates.
2. **Fan the heads out into one request rather than asking in sequence.** It
   is free here: identical decisions, half the requests, half the model
   wall-clock.
3. **Put `DONE`/`BLOCKED` in the operation head** rather than beside it as a
   `noul`. They then compete with real actions under one distribution, and
   `stuck`-style side questions stop being needed.
4. **Port `validateChoice`, and validate lazily.** A silent skip on a
   malformed answer is the worst available behaviour.
5. **Do not compare confidences across question shapes.** The better arm here
   reported roughly half the confidence of the worse one.

## 8. Trying to break the speculation

§4's evidence was weak in two specific ways, and both are now closed.

It **only ever read the winning head** — the losing heads were answered and
discarded unmeasured, and on the next step a loser becomes the winner. And the
**board was easy**: the operation was obvious at almost every step, so there
was little for speculation to get wrong.

`?select=hostile` contests it. Every head carries a trap that is attractive on
its own terms:

| head | trap | correct |
|---|---|---|
| `TYPE_TEXT` | "Promo code (optional)", empty | "Recipient name (required)", empty |
| `SELECT` | a whole second dropdown, "Gift wrap" | shipping set to `express` — **1 of 9 targets** |
| `CLICK` | "Apply promo code", "Back to delivery" | the gated "Place order" |

All three operations are genuinely needed, in no fixed order, so the operation
head is contested rather than obvious. Both traps *succeed* when taken — they
are busywork, not errors, so nothing downstream notices. `?select=twin` adds a
near-duplicate of the one button that works ("Place order and subscribe to
restock alerts"), which passes the same gate and reaches the same confirmation:
a trap invisible to "goal reached".

`run-adversarial.ts` spends five requests per step — one fan-out with **every**
head read, one operation head asked *alone*, and one conditioned target head
per operation. The fan-out answer is what executes; the rest are observations
beside it.

### It did not break

45 head comparisons across four fixtures:

| | n | agree | mean TV |
|---|---|---|---|
| head the operation **named** | 21 | **100%** | 0.003 |
| head answered for nothing | 24 | 100% | 0.105 |

On `hostile` and `twin`, where more than one head existed, the used head's TV
was **exactly 0.000**; the 0.003 is the slot boards, where CLICK is the only
head and it came in at 0.008–0.015.

On every head that executed, the speculative answer was identical to the
conditioned one — not merely the same argmax, **the same distribution, TV
exactly 0.000**. Goal 2/2 on both fixtures, in the minimum three steps, with
**0 traps executed** and the twin taken 0/2.

The operation head was not perturbed either. Asked alone, with nothing else in
the request, it chose the same operation on **every step of every fixture** —
15/15 — at mean TV 0.005–0.037, so the co-presence of three more questions does
not move it.

Goal reached 7/7 across the four boards, and **0 traps executed anywhere**.

### Why it holds, and when it could not

The mechanism is visible in one line of the trace:

```
step=0  op=SELECT@0.55   *SELECT spec=10:6@1.00 cond=10:6@1.00 agree tv=0.00
```

**The uncertainty lives in the operation, not in the target.** At step 0 all
three operations are independently required, so which to do *first* is
genuinely near-arbitrary (0.55) — while *given* an operation, which target it
means is determinate (1.00). Speculation is free because the target question
is the easy half of the decision.

That also says what it would take to break it: **two equally good targets for
the same operation, where only one is correct.** The twin was an attempt at
exactly that and failed — the CLICK head named the plain "Place order" at
confidence 1.00 in every run and never reached for the near-duplicate, because
the goal ("do not add anything that is not required") settles it.

Which is a principled limit and not a budget one, and it cuts both ways: if the
goal determines the answer the model gets it, and if the goal does *not*
determine it then there is no wrong answer for a disagreement to be. §8.1
threads that needle — the discriminator is on the page and absent from the
goal — and the model still gets it.

In all 12 used-head observations the used head sat at confidence 1.00 — which
§8.1 goes after directly.

### 8.1 A discriminator the goal does not name

`?slots=1` removes the thing that settled every earlier trap. Four buttons and
nothing else — no field, no dropdown — so the operation is CLICK by
construction and the whole contest moves inside one head. Three of the four
slots are full, and **that fact appears only in the line of text above each
button**: not in the button's accessible name, so the target criteria cannot
carry it, and not in the goal, which says to reserve a slot without saying
which. A full slot is refused by the app, so a wrong pick is wrong by outcome.

`?slots=hard` takes away adjacency too: one capacity table at the top of the
page keyed by slot code, buttons labelled only `Reserve S1`…`Reserve S6`, and
the table reports capacity and bookings rather than a verdict. A correct pick
needs a join by code and one subtraction.

| board | goal | steps | used-head confidence | agree | traps |
|---|---|---|---|---|---|
| `slots` | 2/2 | 2 | 0.90–0.94 | 4/4 | 0 |
| `slots-hard` | 2/2 | 2 | **0.95–0.97** | 4/4 | 0 |

Both solved in the minimum two steps, picking `Reserve Wed 09:00` and
`Reserve S4` every run, with speculative and conditioned heads agreeing at TV
0.008–0.015. **So a discriminator the goal does not mention is handled**, and
making the join harder made the model *more* confident, not less: explicit
capacity numbers beat prose adjacency.

### 8.2 The uncertain used head is not constructible here

Four boards, and the used head never came in below 0.90:

| board | what was contested | operation conf. | used-head conf. |
|---|---|---|---|
| `hostile` | all three operations needed, in any order | **0.55–0.83** | 1.00 |
| `twin` | a near-duplicate of the working button | 0.78–0.83 | 1.00 |
| `slots` | 1 of 4 buttons, discriminator in adjacent prose | 0.91–0.97 | 0.90–0.94 |
| `slots-hard` | 1 of 6 buttons, discriminator behind a join | 0.92–0.97 | 0.95–0.97 |

**Every attempt to make the used head unsure moved the uncertainty into the
operation head instead.** The two never overlapped: where the operation was
genuinely open (`hostile` at 0.55) its target was certain, and where the target
was hard to find (`slots-hard`) the operation was easy.

There is a structural reason. A target head contains only elements that accept
its operation, so "which of these same-type controls" is a strictly narrower
question than "what should happen next" — and narrowing is what the typed split
does. Uncertainty about *what to do* does not decompose into uncertainty about
*which element*.

That is an empirical failure to construct rather than a proof, and it is
the honest limit of this section. But it also means the practically important
version of the question **is** answered: when a decision is genuinely
uncertain, the uncertainty lands in the operation head, and the target head
stays reliable — 20/20 used-head observations at ≥0.90, agreeing with their
conditioned counterparts every time.

### What the run actually caught: a bug in the port

Before the fix, the SELECT head disagreed on 4 of 12 comparisons. Reading them
was the point of the exercise:

```
step=1  SELECT  spec=10:1@0.71  cond=10:1@0.54   agree   spec-trap cond-trap
step=2  SELECT  spec=10:1@0.59  cond=14:1@0.41   DISAGREE
```

With shipping already on `express`, `actionSpace` skips the current value and
renumbers — so **`10:1` was the placeholder**, `"Choose a shipping method…"`.
Both arms were naming "unset the shipping method" at 0.4–0.7 confidence, and at
step 1 they *agreed* on it. It never executed only because the operation head
did not pick SELECT on those steps, which is luck rather than safety.

An empty-valued `<option>` is a placeholder, not a value; offering it as a
target is offering to throw away a satisfied requirement. `defaultOption` and
`untriedOption` had always skipped it — `actionSpace` not skipping it was an
inconsistency inside one file rather than a decision. jev-ultrafast's own
`action_space` offers every option, so it has the same hole.

With the placeholder dropped, **every disagreement went away**: 18/18 agreement
on each fixture. So all measured divergence between speculative and conditioned
heads was caused by my action space, not by speculating.

The residual 67% SELECT trap rate in both arms is target availability and
nothing else: on steps 1 and 2 `express` is already set, so it is excluded from
the head and no correct SELECT target exists — both arms pick the gift wrap,
identically. 4 of 6 comparisons, which is exactly 67%.

## 9. Limits

One task, one fixture, one dropdown. Two runs per arm on the six-option board
and three on the two-option one; the prompts are identical across runs, so
these measure decision stability and not prompt diversity — the model's
sampled probabilities moved a little between runs and no decision followed.

The `flat` failure is a caller-heuristic bug, and `flat-memo` is in the table
precisely so the headline does not rest on it. The claim that survives is
`flat-memo` vs `fanout`: five extra steps on six options, scaling with option
count.

§8 ran four boards at 1–2 runs each, 45 head comparisons. The decisions were
stable across runs, but that is stability and not prompt diversity — and 45
comparisons cannot distinguish "speculation is free" from "speculation is free
better than 98% of the time".

Two things §8 set out to test are closed: a discriminator absent from the goal
(§8.1) and the uncertain used head (§8.2, not constructible across four
attempts). What remains:

- **A target head near the 255-choice limit** in `shared/jev.ts`. The largest
  here was 9. A country picker would be 200+, and nothing says the speculative
  and conditioned answers stay together at that width.
- **More than one head at the same width.** `hostile` had 3/2/9 targets; an
  action space with three heads of 50 each is a different request shape.
- **A page that changes under the decision.** Every board here is static
  between observation and action. jev-ultrafast guards this with a page
  `fingerprint` and re-observes on a mismatch; this harness re-probes each
  step but never races anything.
- **A second model.** Everything here is `jev-latest`. That the target
  question is the narrower half is an argument about question shape, but its
  answers came from one model.
