# jev-guard

Ask Jev whether the action an agent is about to take needs permission.

This is [docs/18](../../docs/18-permission-hook.md)'s Claude Code permission
hook, ported to a library, a CLI and a Pi extension. The battery is the one
that measured **68/72 (94.4%)** against [docs/01](../../docs/01-shell-risk.md)'s
labelled corpus, at a median of **329 ms** and **$0.000032 per command**.

```bash
npx jev-guard 'rm -rf /'                        # one command, one verdict
npx jev-guard --tool write --input '{"path":"/etc/hosts"}'
npx jev-guard --replay audit.jsonl --deny 1.2   # no API key, no requests
npm test                                        # no API key
```

## What it asks

Nine questions in one request: seven atomic predicates as `noul`, a
`blast_radius` score for scope, and a `permission` score for the ordered
conclusion. The verdict is the **conservative side of two readings**, and
docs/18 §2 priced each one over the same 72 responses:

| reading | label agreement |
| --- | --- |
| the ordered score alone | 65/72 (90.3%) |
| the atomic predicates alone | 44/72 (61.1%) |
| **the conservative side of both** | **68/72 (94.4%)** |

The predicates are clearly the weaker reading on their own and still buy three
points on top of the score.

## The three properties that matter more than accuracy

This sits in front of every action an agent takes, so docs/18 §1 settled these
before measuring anything:

**It narrows, it does not widen.** `allow` is not emitted by default —
emitting it would override the permission rules the user configured, and a gate
that is wrong once in 24 should not hold that power. `allowSafe` is the opt-in.

**Failure falls through.** No key, a dead endpoint, a slow reply, malformed
JSON: every one returns `verdict: null`, meaning "no opinion, apply the host's
own rules". Failing into `allow` approves silently; failing into `deny` bricks
the agent on an outage. `test.ts` checks four such paths without a key.

**The latency budget is fixed.** One attempt, no retries — the opposite of
`experiments/shared/jev.ts`, which retries because it is collecting a corpus
offline. Here a retry only spends the budget that makes the gate usable.

## What is new, and what a resident agent forces

`ask` needs somebody to ask. docs/18's hook ran under a human, so `ask` handed
the call to the host's prompt. Pi's `tool_call` result is `{ block?, reason? }`
— **block or nothing**, with no `ask` to return — so this package resolves it:

| | what `ask` becomes |
| --- | --- |
| `ctx.hasUI` | `ctx.ui.confirm(...)`, and block if declined |
| headless | `unattendedAsk`, default **block** |

Blocking is the one place this is stricter than docs/18's hook. It costs
availability and the number is known: docs/18's corpus put 5 of 24 commands in
`ask`, so about a fifth of a shell workload stops and waits. That is the trade,
which is why it is a setting.

## The prefilter is free, and it is most of the bill

A `read` cannot destroy anything, so the gate never asks about one. That is
[docs/33 §1](../../docs/33-review.md)'s rule applied to a gate — measure what
the free features give you before paying for judgment — and for a resident
agent it is the difference that matters, because reads outnumber writes.

docs/18 §1 also says a gate should not be applied to tools it was never
calibrated on, and 94.4% is a number about **shell commands**. So every verdict
carries a `band`:

| band | asked? | note |
| --- | --- | --- |
| `read-only` | no | `read`, `grep`, `find`, `ls` |
| `shell` | yes | the surface docs/18 measured |
| `uncalibrated` | yes, and labelled | `write`, `edit`, custom tools |

`scope: "shell"` restricts it to the measured surface. The default is `writes`,
because the alternative is a gate that watches `bash rm` and not `write`.

## One wording, rewritten, and why

docs/01's `exfiltrates` question scored 23/24 on its corpus and **denied an
ordinary `git push`** the first time it ran in front of a real agent. Those 24
commands contained no legitimate outbound transfer, so the hole was invisible
to them. The criterion now says the project's own remote does not count, and
`test.ts` asserts the clause and the reason are both still there — a tidy-up
that "simplified" it back would reopen the hole.

A corpus cannot report a hole it has no case for.

## Replay

The audit log stores **raw answers**, not verdicts, so `--replay` re-reads a
recorded session at different cutoffs with no further requests. "Would stricter
cutoffs have blocked this?" is a question about a recorded run;
asking the API again answers a different one
([docs/19 §4](../../docs/19-jevlang.md)).

## Pi

`/jev-guard` shows what was asked, what was free, what was blocked, and what
the session has cost. `/jev-guard off` stops it.

**This extension ships its defaults and nothing else.** An earlier version of
this section showed a `{ "jev-guard": { ... } }` settings block, and that block
was fiction: `ExtensionFactory` is `(pi: ExtensionAPI) => void` — one argument —
and `ExtensionAPI` has no settings reader at all. Pi passes configuration to an
extension through `registerFlag`/`getFlag` and through nothing else
([docs/38 §6](../../docs/38-agent.md)). `PiGuardSettings` therefore starts as
`{}` and only the slash command can change it, so **every default is the whole
of the shipped behaviour**. To make a field configurable it has to become a
flag; none are registered here yet.

The library and the CLI take the full config, and that is what the experiments
measure.

## Limits

- The 94.4% is docs/01's 24 commands, three times. Shell only.
- `psql -c 'DROP TABLE users;'` sits on the deny boundary across runs. The
  cutoffs are unfitted: docs/25's rule is that a cutoff belongs to a corpus.
- Nothing here has been measured against `write` or `edit` calls at all.
- In pi, only the defaults are reachable (above). The one decision this costs
  is `unattendedAsk`: a headless session resolves ASK to `block`, and a host
  that wants `confirm` has no way to say so.
- `deny` has never fired inside pi. [docs/38 §7.2](../../docs/38-agent.md)
  blocked `rm -rf <sandbox>/tree` at verdict `ask`, which is the same shape as
  docs/18's `rm -rf ./node_modules`.
