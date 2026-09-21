# jev-driver

A [chaosbringer](https://github.com/mizchi/chaosbringer) `Driver` that asks Jev
what to do next over a **typed, per-operation action space**. One request per
step, no screenshot.

**Prototype.** The action space, the state it sends and the answer it reads are
pinned by 13 model-free checks. What is *not* established is that it drives an
app better than the flat picker it replaces — see [What the first runs
showed](#what-the-first-runs-showed), which is mostly a list of things that
turned out to be broken.

```ts
import { chaos, compositeDriver, weightedRandomDriver } from "chaosbringer";
import { Jev, jevDriver } from "jev-driver";

await chaos({
  baseUrl: "http://localhost:3000",
  driver: compositeDriver([
    jevDriver({ jev: new Jev(), goal: "Place an order end to end." }),
    weightedRandomDriver(),
  ]),
});
```

## Why `Driver` and not `DriverProvider`

`aiDriver` takes a `DriverProvider`, and slotting in beside
`openRouterDriverProvider` is the obvious move. It is the wrong one: a provider
is handed a candidate list and answers with an **index**, and this design has to
answer with an *operation* as well. `CLEAR` and `SELECT` also have to carry a
value, and `DriverProviderResult` has nowhere to put one.

A `Driver` sees the whole step and can return `kind: "custom"`, so the whole
shape fits **today, with no change upstream**. Three drivers in chaosbringer
already do this (`flow-driver`, `form-driver`, `auth-attack`).

Two upstream PRs shrink this package rather than enable it:

| PR | what it changes here |
| --- | --- |
| [#145](https://github.com/mizchi/chaosbringer/pull/145) (merged) | a provider now sees `type` + the geometry, and the screenshot is a thunk — so a future *provider* version of this could at least see the facts |
| [#146](https://github.com/mizchi/chaosbringer/pull/146) | `operation: "clear"` on a `select` pick replaces one `custom`, and the trace stops calling a clear an `input` |

Until #146 lands, a driver that empties a field **has to mislabel its own
action** in the trace: `ActionResult["type"]` has `"input"` and no `"clear"`.
That mislabelling is in this code, marked.

## The action space

One request carries the `operation` question and a target question for **every**
operation. The answer's operation names the one target head that is read; the
rest are thrown away. [docs/61 §4](../../docs/61-speculative-fanout.md) measured
the executed head as identical to what a sequential asker chose — not the same
argmax, the same distribution (12/12 at TV 0.000; 21/21 at mean 0.003
adversarially) — at half the requests and 53% less model wall clock.

| operation | target head | who owns the value |
| --- | --- | --- |
| `CLICK` | any control | — |
| `TYPE_TEXT` | `input` candidates | **code** (`fillValueFor`, or the crawler's own) |
| `CLEAR` | `input` candidates holding something | — (the value *is* empty) |
| `SELECT` | `index:option` pairs read off the page | **the page** |
| `DONE` | — | — |

Two constraints decide that table, and both come from what Jev is:

- **Jev answers `choice`, so it cannot write a string.** A target cannot carry a
  model-authored value. This is why `CLEAR` is an operation rather than a flag
  on a text target the way browser-use has it (`InputTextAction{clear}`): there
  is no field on a target that a choice could set.
- **No model output becomes a selector.** Every target key resolves back through
  `space.ts` to a candidate the crawler collected.

`stuck` is asked alongside, because a `choice` always names something
([docs/00](../../docs/00-api-notes.md)): with no way to say "none of these", a
dead end produces a confident click on a decoy.

## The design decisions, and where each was measured

| decision | why | report |
| --- | --- | --- |
| one request, all heads, read one | the speculation is free | [61 §4](../../docs/61-speculative-fanout.md) |
| an obstructed candidate is **told about, not removed** | removing ≡ telling for accuracy, and telling is the recoverable one | [62 §4](../../docs/62-browser-accuracy.md), [05 §3](../../docs/05-browser-chaos.md) |
| **no confidence gate of its own** | 12 of 13 dead clicks came back at ≥0.99; confidence is a property of the question's shape, so one number does not transfer between arms | [57 §4](../../docs/57-confidence-fallback.md), [62 §6.4](../../docs/62-browser-accuracy.md) |
| the goal is a **mark**, not an order | naming the target and adding no instruction reached 14.0/14 states; "find it and click it" dropped it to 10.0/14 with nearly twice the wasted steps | [58 §4.5](../../docs/58-coverage-guidance.md) |
| progress facts in the state, not a threshold in the driver | confidence does not notice a no-op until the failure is in the state; driving on a *position* fact oscillates | [57 §4](../../docs/57-confidence-fallback.md), [62 §6.5](../../docs/62-browser-accuracy.md) |

The confidence is still passed through onto the pick, so the crawler records it.
Reporting a number and gating on it are different things.

## What the first runs showed

Run against a real `ChaosCrawler` with a real key. Every one of these is a
defect this prototype had, not a property of the design — but the first three
are the reason the run is worth writing down at all.

1. **The enrichment silently read nothing.** `page.evaluate` was handed the
   reader as a *string* (the workaround the sibling experiment needs for
   `page.evaluate` closures), which fails on a locator — and the `catch`
   returned "no options, no value". So a broken read looked exactly like an
   empty field: `CLEAR` and `SELECT` vanished from the action space, the
   operation head collapsed to `CLICK,TYPE_TEXT,DONE`, and **the run still
   printed a clean table**. Same shape as [docs/59
   §3.3](../../docs/59-nl-test-generation.md), where a broken control returned a
   number rather than an error. Fixed by passing a real function, and the
   failure is now **counted** (`enrichFailed`) instead of caught.
2. **`skip` is not a stop.** The crawler re-asks a driver that skips — its
   attempt budget is three times its step budget — so an un-latched `DONE` spent
   one request per attempt to say the same thing. Eight wasted requests on one
   screen, against a package whose headline is "one request per step". Latched
   per screen.
3. **Nothing consumed `stuck`.** The first run clicked the same link eight times
   while `stuck` climbed to 0.73. The fix is the measured one — the progress
   facts went into the state, not a threshold into the driver — and the loop
   became a three-cycle instead of a fixed point. **Better, not fixed.**
4. **The bench app cannot exercise this, and the reason is upstream.** The
   sibling `experiments/browser-chaos` app routes by hash. The crawler's page
   identity ignores a fragment, so clicking its nav returns to the default route
   and the candidate list never changes — 20 steps, 20 requests, never a field.
   That is why `run-jev-driver.ts` has a second board whose *initial HTML*
   already holds one control of each kind.
5. **A `<select>` is never a candidate at all.** chaosbringer's scrape queries
   `input, textarea, [contenteditable], [role=textbox], [role=searchbox]` plus
   tags with a `role`; a bare `<select>` matches none of them. So the `SELECT`
   head can only ever be filled from a dropdown that carries an explicit
   `role`. **That is a finding for upstream, not something this package can
   work around** — the value-carrying operation the survey said everyone ships
   has no candidate to attach to.
6. **And in the published `0.9.0`, a form field's selector matches nothing.**
   This is why the counter from (1) mattered: it read `[2 unreadable]` on every
   step, and the two were the page's two `<input>`s. Dumping the selectors:

   | candidate | selector `0.9.0` builds | resolves |
   | --- | --- | --- |
   | `button "Save delivery details"` | `button:has-text("Save delivery details")` | yes |
   | `<input id="address" name="address">` | `[role="input"]:nth-of-type(1)` | **no** |

   `t.role` is carrying the crawler's own classification, not a DOM `role`
   attribute, and `:nth-of-type` counts same-tag siblings under one parent
   rather than the page-wide match index. **The consequence is not confined to
   this package**: `performActionOnTarget` does
   `locator(sel).first().isVisible().catch(() => false)`, so an unresolvable
   selector reads as "not visible" and **the step is silently skipped**. That
   is why a run where the driver chose `TYPE_TEXT` eight times recorded
   `click=6` and not one `input` action.

   Fixed on `main` and unreleased: it now builds `:nth-match([role=…], N)`,
   with a comment naming the `:nth-of-type` mistake, and adds `[name="…"]` and
   `[placeholder="…"]` branches that would match this field directly. Running
   against `main`'s build to confirm needs its workspace dependencies, which
   are newer than the published `@mizchi/*`, so that check is **unrun here**.

What is **not** measured: whether this reaches goals a flat picker does not.
Both arms exist in the runner for that comparison, and the comparison is
blocked on (5) and (6) rather than on the model — with no `<select>` candidate
and no resolvable field, every board so far collapses to `CLICK`, which is the
one operation both arms already express identically. **A run where the arms
agree is not a null result about the action space.** The next thing to do is
re-run against a released chaosbringer that carries the selector fix, not to
write more driver.

## Running it

```bash
npm --prefix packages install
npm --prefix packages/jev-driver test          # 13 checks, no key, no browser

cd experiments/browser-chaos && npm install
TYPESAFEAI_API_KEY=... npx tsx src/run-jev-driver.ts --board fields --steps 8
TYPESAFEAI_API_KEY=... npx tsx src/run-jev-driver.ts --arm flat --board fields
```

## Naming

Unpublished, and the name is not settled: on npm `jev-guard`,
`jev-model-router` and `jev-compact` are **other people's packages**, and
`@jev-playground/*` is a placeholder scope. Anything that depends on this from
outside the repo needs a name in a scope its author owns, or an inlined client
— which is what chaosbringer's own providers do (`fetch`, no vendor SDK, one
injectable for tests).
