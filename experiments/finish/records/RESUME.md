# Unfinished work in this directory, so it cannot be silently forgotten

## `widened.json` is hidden from `git status` and MUST be un-hidden

`experiments/finish/records/widened.json` is being written by a running sweep —
one rewrite per run, 32 runs. It is a tracked file, so every run made the
working tree dirty, and committing each version would have put ~28 full copies
of a record that grows to roughly 90,000 lines into the history.

So it is hidden:

```sh
git update-index --skip-worktree experiments/finish/records/widened.json
```

**This is a debt, not a fix.** Until it is undone, the file's real contents are
invisible to `git status`, `git diff` and `git stash`, and a checkout that
touches it will refuse or behave oddly. When the sweep finishes:

```sh
git update-index --no-skip-worktree experiments/finish/records/widened.json
git add experiments/finish/records/widened.json
# commit the finished record
```

`git ls-files -v experiments/finish/records/widened.json` prints `S` while the
flag is set and `H` once it is cleared. The last pushed checkpoint holds 4 of
32 runs, so a container death before the sweep ends costs the runs after that
and nothing already reported.

## What is still owed once the record is full

- `docs/56-widen.md` §3 — a marked placeholder. The numbers go in from
  `tsx src/wild.ts --sweep widened --report`, never typed by hand.
- §4.1's paired comparison and the `--instruments` table, both of which read
  the record and need all 32 rows to be worth reading.
- A row in `docs/README.md`, which summarises a result and so cannot be
  written before there is one.
- **The fence's `/tmp` gap** (`harnessReach`, docs/56 limits): the fence
  covers `/home/` and `/root/` while the harness keeps its clone trees and
  every sandbox under `/tmp`. Measured at 12 reads and 0 writes. NOT fixed
  during the sweep, because an instrument that differs between arms is this
  experiment's own named confound — it is fixed after, uniformly.
