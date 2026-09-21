# `moba5/` — a 5v5 MOBA, and a benchmark the simulator scores

The 3v3 prototype in [`../moba/`](../moba/) is unchanged and still the subject
of [docs/02](../docs/02-moba.md), [10](../docs/10-jev-vs-jev.md),
[11](../docs/11-synergy.md) and [12](../docs/12-comeback.md). This is a separate
package: the same idea at the size the genre is played at, with the mechanics
that make it a game of decisions, and — the actual point — with **ground truth**,
so a policy's answers can be marked instead of only its wins counted.

The report is [docs/56](../docs/56-moba5.md).

```bash
moon run --target native cmd/moba5 -- --bench --dry   # the suite and the floor, no API key
moon run --target native cmd/moba5 -- --bench         # score a model against the same answers
moon run --target native cmd/moba5 -- --arena         # 5v5 teamfight round-robin, no API key
moon run --target native cmd/moba5 -- --tournament    # whole-game round-robin, no API key
moon run --target native cmd/moba5 -- --draft         # rank comps from raw stats
moon run --target native cmd/moba5 -- --coherence --from-answers moba5/runs/wording.jsonl
                                                      # the fight and retreat truths side by side, no API key
moon run --target native cmd/moba5 -- --from-answers moba5/runs/wording.jsonl
                                                      # the retreat question as two options and as three, no API key
moon run --target native cmd/moba5 -- --wording --repeat 3 --answers moba5/runs/wording.jsonl
                                                      # ask both wordings again (96 requests)
moon run --target native cmd/moba5 -- --a jev --b smart --max-ticks 40
moon test --target native -p moba5                    # 52 tests, no API key
```

## The files

| file | what is in it |
| --- | --- |
| `map.mbt` | The 23-node map: three lanes, a jungle each side, a river with two objectives. Distances, blink range, ward spots, and the forward-preferring tie-break in `step_toward_prefer` |
| `champions.mbt` | The roster (archetypes, abilities, range), the five-item shop, and the named compositions |
| `game.mbt` | State and one tick of resolution: simultaneous combat, the frontline guard, crowd control, shields, levels, items, objectives, minion pressure, wards, the wave rule, `Game::copy` |
| `actions.mbt` | The twelve action families, the legal-move generator, and the one-line description of what each move is worth |
| `observation.mbt` | The fog-of-war observation a team is allowed to read, and the turn message a referee would send |
| `policy.mbt` | The two scripted baselines: `scripted` (lane-loyal) and `smart` (one shared plan per tick) |
| `fight.mbt` | Target selection, the ability-timing rules, and the deterministic fight resolver |
| `oracle.mbt` | `position_score`, the forward simulations the macro truths use, and the tower arithmetic |
| `bench.mbt` | The fifteen written scenarios and their questions, each with the answer the simulator produced and the heuristic floor's answer |
| `fightset.mbt` | The `fight` class, swept rather than written: 540 staged fights played out and filed by whether the head count predicted the outcome, then taken evenly from four buckets |
| `coherence.mbt` | Two questions about the same node, put side by side: how often the rules allow "we do not win" *and* "swing anyway", a looser reading of winning, and the sign test — including `forced_overlap`, which says how much of a co-occurrence count its two margins already forced |
| `runs/wording.jsonl` | One recorded run's answers, one line per question, so the analyses above re-derive with no API key |
| `replay.mbt` | Self-contained JSON-lines replay (`version: "moba5/1"`) |

## The one rule everything turns on

> **A structure does not shoot a champion whose own team holds that lane's
> minion wave** — the minions are what it shoots instead.

A champion alone under a tower with no wave loses that trade every time; the
same champion behind a wave takes the tower down. Farming a lane shoves its
wave, so `Farm` is a strategic action and not a gold trickle, and "clear the
wave, then hit the tower" becomes the correct procedure rather than a habit.
Minions strip towers but never touch a nexus, so closing a game always takes
champions standing in the enemy base.

## Three tiers of ground truth

Every benchmark question says which one it uses, because they are not equally
strong:

| tier | what it means |
| --- | --- |
| `rules` | The simulator played the situation out. The answer is the rules' own outcome |
| `arith` | Exact arithmetic the rules define (ticks survivable under a tower, team power) |
| `score` | The argmax of `position_score` over a stated horizon, with the enemy on the strong baseline. A stated objective, not a fact |

Where the simulator cannot separate two options, the truth carries both
(`"a|b"`, see `truth_accepts`) and either is marked correct — otherwise the
benchmark would be measuring the order the options happened to be listed in.

## Tests

`moon test --target native -p moba5` covers three things, and the second and
third exist because the first kind of bug is not the kind that bites:

- **the mechanics** (`game_wbtest.mbt`) — mutual lethals, the frontline guard
  and the burst that ignores it, a stun that must not expire on the tick it
  lands, shields absorbing before health, the wave rule, item and level maths;
- **the map** (`map_wbtest.mbt`) — that the map is the *same map* for both
  teams under the A↔B relabelling, that both teams start in mirrored positions
  equidistant from each objective, and that a step toward a target always
  closes the distance. Two side-advantage bugs were found here, and neither was
  visible from watching a game;
- **the benchmark itself** (`bench_wbtest.mbt`) — that every truth is one of
  the offered answers, that the offered answers are not *all* correct, that
  question names are unique within a scenario, that the floor gets some
  right and some wrong, and that **no class can be swept by one constant
  answer**. Any of those missing produces a table that prints fine
  and means nothing;
- **the coherence analysis** (`coherence_wbtest.mbt`) — that its rows carry the
  benchmark's own `fight` and `retreat` truths rather than a second copy of the
  pricing, that every reworded three-option question is the same question with
  the same oracle, **that the rewordings differ in the way each is meant to**,
  that the sign test matches values worked out by hand, and that a count equal
  to its forced overlap is recognised as one. The forced-overlap check is what
  turned the report's "13 of 16 contradict" into a weaker and correct claim;
  the two wording checks are the halves of an A/B — one says the arms ask the
  same question, the other says they ask it differently, and without the
  second a copy-paste would report "the wording does not matter" for free.
