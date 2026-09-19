# jev-skill-router

Ask [Jev](https://docs.typesafe.ai) which skills a context calls for, over a
catalogue too large to put in one request. A library, a CLI, and a
[Pi](https://pi.dev) extension, sharing one decision function.

```bash
jev-skill-router --dir ~/mizchi/skills "the Cloudflare worker fails to deploy, wrangler says the KV binding is missing"
# judged
#   load  cloudflare-deploy  2.99  judged
#   skip  frontend-ops-expert  1.19
#   skip  cloudflare-workers-cd-rollback  0.96
#   none-apply 0.36 · 520 ms · 9426 input tokens

jev-skill-router --dir ~/mizchi/skills "what is the capital of France"
# nothing-over-cutoff
#   none-apply 0.62 · 435 ms · 9424 input tokens
```

Real runs over 68 real skills. One decision is about 9,400 input tokens, so
**$0.0004 and about half a second** — and it loaded *one* skill, not three, because
the cutoff decided rather than the cap.

## Four stages, one of which costs anything

```
1. split      the catalogue's own routing        free
2. prescore   IDF-weighted lexical overlap       free
3. ask        one request over the shortlist     ~$0.0004
4. policy     a cutoff and a cap, in code        free
```

**Stage 1 exists because the catalogue often already knows.** Routing by the
catalogue's own tier before asking reached 0.70 average precision against 0.53 for
asking about everything ([docs/29 §5](../../docs/29-skill-select.md)). A skill marked
"always load" has already been decided, and a question spent on it is a question
spent rediscovering the answer.

**Stage 2 is not an optimisation, it is why the request fits.** 461 real skills are
60,358 tokens of name and description, and one question per skill costs about 270
tokens against a 65,536-token ceiling — roughly 124,000 tokens, which the server
refuses ([docs/30 §1](../../docs/30-skill-pick.md)). The only property of this stage
that matters is **recall**, because a skill it drops can never come back:

| prefilter | recall at k=60 over 461 skills |
| --- | --- |
| `overlap` (default) | **85%** |
| `firstline` | 67% |
| `random` (the control) | 22% |

That 15% is the router's hard ceiling. `--dry-run` prints the shortlist for free, and
is the first thing to look at when the router picks badly: a skill missing there was
never judged at all.

**Stage 3's shapes are measured too.** A `score` over four ordered levels rather than
a `noul` (0.56 against 0.54 AP, [docs/29 §2](../../docs/29-skill-select.md)); one
request for all of them, because width is free (99.8% of answers within 0.25 against
asking separately, for a third of the tokens,
[docs/29 §4](../../docs/29-skill-select.md#4-ファンアウトの幅は無料答えが同じ)); four
words per question with the level meanings in the state, because that took a question
from 251 tokens to 118 and doubled how many fit
([docs/30 §7](../../docs/30-skill-pick.md#7-criteria-の文字列の値段)); and "no skill
applies" as its own `noul` rather than a fifth level
([docs/17 §3](../../docs/17-task-picker.md#3-逃げ道は選択肢ではなく別の問いにする)).

**Stage 4 has a cap because precision falls as the cap rises** — P@12 dropped from
0.25 to 0.19 as k grew over the same answers ([docs/30 §5](../../docs/30-skill-pick.md)).
The cap trims what cleared the cutoff; it does not replace it. Ranking and taking the
top three would load three skills for every request, including the ones no skill is
for.

## What it will not do

- **It never loads a skill the host marked non-invocable.** That flag is a permission
  decision the user made, and a router that overrode it would be overriding the user.
  The filter is in `split()`, before the prefilter and before the policy, so no
  cutoff, cap or downstream bug can undo it — and the name and description of such a
  skill never enter a request either.
- **It does not read, execute, or follow a skill's instructions.** It returns names.
  `Skill.path` is carried through untouched for a host that wants to load them; the
  Pi extension reads them locally and never sends them back.
- **It does not throw.** Every failure path returns the catalogue's own decisions with
  `reason: "unavailable"`. "I could not pick a skill" must not become "the agent
  cannot work".

## Standalone

```ts
import { route } from "jev-skill-router";

const decision = await route(
  { request: "extract the tables from this scanned PDF" },
  [{ name: "pdf-extraction", description: "Extract tables and text from supplied PDF files." }],
);
decision.load;      // [{ skill, level, confidence, why }]
decision.reason;    // "judged" | "capped" | "nothing-over-cutoff" | "none-apply" | "unavailable"
decision.droppedBy; // { prefilter, catalogue, blocked } -- what was never asked about
```

Set `TYPESAFE_API_KEY`. `--dir` reads `<name>/SKILL.md` with YAML front matter;
`--catalogue` takes a JSON array.

## As a Pi extension

```sh
pi install npm:jev-skill-router
```

`/jev-skills` shows what was loaded, what was considered, and how much the prefilter
dropped. `src/pi.ts` is the only file importing from Pi.

**This extension ships its defaults and nothing else.** An earlier version of
this section showed a `{ "jevSkillRouter": { ... } }` settings block, and that
block was fiction: pi passes configuration to an extension through
`registerFlag`/`getFlag` and through nothing else — `ExtensionFactory` takes one
argument and `ExtensionAPI` has no settings reader
([docs/38 §6](../../docs/38-agent.md)). So `shortlist`, `maxLoad`, `loadAt` and
`always` are reachable from the library and the CLI, and in pi only through
`/jev-skills`. No flags are registered here yet.

**What leaves the machine:** the request text and the names and descriptions of
eligible skills. Not the instructions — those are read locally. Request text is not
redacted and may contain secrets.

## Limits

- **`loadAt: 2.5` is fitted, but to one catalogue.**
  [docs/29 §10](../../docs/29-skill-select.md) ran this pipeline over a
  (cutoff, cap) grid on 1,008 judged pairs from 14 projects, folds cut along
  projects: at the shipped cap of 3, 2.5 gives the best precision in the grid
  (0.844, against 0.771 for 2.0 and 0.750 for 1.5). 14 projects is small and
  [docs/25](../../docs/25-thresholds.md) is a whole report on a cutoff
  belonging to a corpus.
- **Do not fit `loadAt` without `maxLoad`.** Fitting the cutoff on its own
  moves it to 1.39 and is *strictly worse* through the pipeline — identical
  recall (0.252), precision 0.844 → 0.750 — because the cap is already
  binding, so a lower cutoff admits no extra wanted skill, only extra junk
  into the same three places. The component's own held-out balanced accuracy
  nonetheless says 1.39 beats 2.50.
- **`noneAt: 0.8` is unfitted and probably not worth its question.**
  docs/29 §10: of 14 projects exactly one (`bare-repo`) is a context no judged
  skill is for, and the free substitute — "nothing cleared `loadAt`" — picks
  out that same project at no extra question. One positive cannot place a
  cutoff. The hatch's *shape* is measured
  ([docs/17 §3](../../docs/17-task-picker.md): 18/18 against 16/18 as an extra
  level), so it stays; its value is not.
- **Recall is about a quarter, and the cutoff is not why.** 47 of 107 wanted
  skills score below 0.5. Where the score is high it is usually right (36 vs 9
  in the top band); most wanted skills never get a high score. No threshold
  moves that.
- **The prefilter's stop list is ported verbatim** from the code the 85% was measured
  with. A shorter or longer list is a different prefilter and needs its own number.
- **Precision on a real catalogue is low in absolute terms.** docs/30's best arm
  reached P@12 0.30. This package is that arm plus the catalogue routing; it is a
  shortlist worth reading, not an oracle.

MIT.
