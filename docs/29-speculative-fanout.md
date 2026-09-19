# 29. Speculative fan-out: asking for the target before you know the operation

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
| `flat` | **0/2** | 18.0 (budget) | **0.0** | 18.0 | 18,769 | 2,632 | 2,533 | 0/2 |
| `flat-memo` | 2/2 | 15.0 | 0.0 | 15.0 | 15,499 | 2,197 | 2,059 | 2/2 |
| `fanout` | **2/2** | **10.0** | 0.0 | **10.0** | 16,196 | 1,938 | **1,324** | 2/2 |
| `sequential` | 2/2 | 10.0 | 0.0 | 20.0 | 17,331 | 1,474 | 3,043 | 2/2 |

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
and docs/25 lean on — sees nothing wrong. An arm can be in a permanent loop
with a clean wasted-step count.

**Confidence was 0.93–0.99 the whole way down.** The flat arm was not unsure.
It was being asked an easy question ("which control matters here?") whose
answer was right, while the decision it was actually getting wrong — which
value — was never put to a model at all. docs/25 found confidence to be a poor
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
- **56% less wall-clock in the model** (1,324 ms vs 3,043 ms on six options).

The token picture is more interesting than a straight loss. `fanout` sends
more input than `flat` per step, because the extra heads' criteria are on the
wire — 1.43× on two options. But per *run* on six options it sends **less than
every other arm**: 16,196 in, against 18,769 for `flat`, 15,499 for
`flat-memo` (which is cheaper per run only because it needs 15 steps rather
than 18), and 17,331 for `sequential` (which sends the whole state twice).
The unused heads cost less than the extra steps they remove. Output tokens are
where the speculation shows up honestly: 1,938 against `sequential`'s 1,474,
because heads nobody read still got answered.

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
`coveredBy` / `isObstructed` pair that docs/25 §6 landed in chaosbringer
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

## 8. Limits

One task, one fixture, one dropdown. Two runs per arm on the six-option board
and three on the two-option one; the prompts are identical across runs, so
these measure decision stability and not prompt diversity — the model's
sampled probabilities moved a little between runs and no decision followed.

The `flat` failure is a caller-heuristic bug, and `flat-memo` is in the table
precisely so the headline does not rest on it. The claim that survives is
`flat-memo` vs `fanout`: five extra steps on six options, scaling with option
count.

Nothing here tests more than one dropdown on a screen, a target head near the
255-choice limit in `shared/jev.ts`, or the case the fan-out should be worst
at — a page where the operation is genuinely ambiguous and the right target
differs sharply per operation. That last one is the experiment that would
actually try to break the speculation, and it has not been run.
