/**
 * What has to hold before this comparison is believed.
 *
 *   npm test      # no API key
 *
 * The checks that matter are the ones that would let a WRONG comparison look
 * like a right one, because every one of them was a real risk here:
 *
 *   a fact that survives by construction (duplicated, or inside the recency
 *   floor) scores 1.0 for every ranking and inflates all of them;
 *   a ranking that deletes less scores better by doing less;
 *   a corpus whose target entries all sit early hands the result to `oldest`
 *   before a single request is sent.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dropUntilFits, pinned, rankBy, totalTokens, type Entry } from "../../packages/jev-compact/src/compact.js";
import { shortenBy } from "./src/shorten.js";
import type { Transcript } from "./src/corpus.js";
import type { Record_ } from "./src/run.js";
import { ARMS, oracleInstructions } from "./src/precompact.js";
import { keepOrderFree, keepOrderDigits, rankOfFact } from "./src/relevance.js";

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void): void => {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}: ${(err as Error).message}`);
  }
};
const ok = (cond: boolean, what: string): void => {
  if (!cond) throw new Error(what);
};
const eq = <T,>(a: T, b: T, what = ""): void => {
  if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

const FLOORS = { keepRecent: 6, keepGoal: true };
const corpusPath = resolve(import.meta.dirname, "records/corpus.json");
const corpus: Transcript[] = existsSync(corpusPath)
  ? (JSON.parse(readFileSync(corpusPath, "utf8")) as { transcripts: Transcript[] }).transcripts
  : [];

// ------------------------------------------------- the ground truth is sound

check("every fact really is in the entry it is attributed to", () => {
  ok(corpus.length > 0, "no corpus recorded; run `npm run corpus`");
  for (const t of corpus) {
    for (const f of t.facts) {
      const entry = t.entries.find((e) => e.id === f.entryId);
      ok(!!entry, `${t.id}: fact points at ${f.entryId}, which is not in the transcript`);
      ok(entry?.text.includes(f.text) === true, `${t.id}: ${JSON.stringify(f.text)} is not in ${f.entryId}`);
    }
  }
});

check("no fact appears twice, so losing it is possible", () => {
  // A fact present in two entries cannot be deleted, so it would score 1.0
  // for every ranking and quietly raise all of them.
  for (const t of corpus) {
    for (const f of t.facts) {
      const holders = t.entries.filter((e) => e.text.includes(f.text));
      eq(holders.length, 1, `${t.id}: ${JSON.stringify(f.text)} is in ${holders.map((h) => h.id).join(",")}: `);
    }
  }
});

check("no fact is inside the recency floor", () => {
  // `keepRecent` pins the end of the transcript, so a fact there survives by
  // construction. The corpus is built long enough for that not to happen; if
  // it starts happening the report says so and excludes it, but the test
  // catches it first.
  for (const t of corpus) {
    const keep = pinned(t.entries, FLOORS);
    for (const f of t.facts) {
      ok(
        !keep.has(f.entryId),
        `${t.id}: ${f.entryId} is pinned by the floors, so its fact cannot be lost and measures nothing`,
      );
    }
  }
});

check("the needed facts are spread across the transcript, not bunched early", () => {
  // `oldest` deletes from the front and the floor pins the back, so a corpus
  // whose targets all sat early would decide the winner by construction.
  const positions = corpus.map((t) => t.targetIndex / t.entries.length);
  const lo = Math.min(...positions);
  const hi = Math.max(...positions);
  ok(lo < 0.3, `the earliest target sits at ${lo.toFixed(2)} of the way through; nothing is early`);
  ok(hi > 0.6, `the latest target sits at ${hi.toFixed(2)} of the way through; nothing is late`);
  const early = positions.filter((p) => p < 0.5).length;
  ok(early >= 2 && early <= corpus.length - 2, `${early} of ${corpus.length} targets are in the first half`);
});

check("both task kinds are present and the goal never leaks the fact", () => {
  const kinds = new Set(corpus.map((t) => t.kind));
  ok(kinds.has("named") && kinds.has("blind"), "the corpus needs both kinds to be read as a split");
  for (const t of corpus) {
    for (const f of t.facts) {
      ok(!t.goal.includes(f.text), `${t.id}: the goal contains the fact, which is pinned and so unlosable`);
    }
  }
});

// -------------------------------------------- the comparison is a comparison

check("every ranking is a permutation of the same entries", () => {
  for (const t of corpus) {
    for (const baseline of ["oldest", "largest", "stale", "overlap"] as const) {
      const order = rankBy(baseline, t.entries);
      eq(order.length, t.entries.length, `${t.id}/${baseline} changed the entry count: `);
      eq(new Set(order.map((e) => e.id)).size, t.entries.length, `${t.id}/${baseline} has duplicates: `);
    }
  }
});

check("what every ranking hands back is a valid transcript", () => {
  // Pairing and the goal, checked on the actual survivors: if a ranking could
  // return something a provider rejects, its fact-survival score would be
  // measuring an unusable transcript.
  for (const t of corpus) {
    for (const baseline of ["oldest", "largest", "stale", "overlap"] as const) {
      const { keep } = dropUntilFits(t.entries, rankBy(baseline, t.entries), Math.round(t.tokens * 0.3), FLOORS);
      const uses = new Set<string>();
      const results = new Set<string>();
      for (const e of keep) {
        for (const c of e.calls ?? []) uses.add(c);
        if (e.answers) results.add(e.answers);
      }
      for (const id of uses) ok(results.has(id), `${t.id}/${baseline}: call ${id} survived without its result`);
      for (const id of results) ok(uses.has(id), `${t.id}/${baseline}: result for ${id} survived without its call`);
      ok(keep.some((e) => e.role === "user"), `${t.id}/${baseline}: the goal was dropped`);
    }
  }
});

check("a tighter budget never keeps more", () => {
  // Monotonicity. A ranking whose 25% run left more than its 80% run would
  // mean `dropUntilFits` is not doing what the comparison assumes.
  for (const t of corpus) {
    for (const baseline of ["oldest", "largest", "stale", "overlap"] as const) {
      const order = rankBy(baseline, t.entries);
      let previous = Number.POSITIVE_INFINITY;
      for (const fraction of [0.8, 0.6, 0.4, 0.25]) {
        const { keep } = dropUntilFits(t.entries, order, Math.round(t.tokens * fraction), FLOORS);
        const size = totalTokens(keep);
        ok(size <= previous, `${t.id}/${baseline}: ${fraction} kept ${size} tokens, more than the looser budget`);
        previous = size;
      }
    }
  }
});

check("the recorded jev order covers every candidate", () => {
  // A ranking that silently omitted entries would never be asked about the
  // one it would have got wrong. `maxCandidates` is raised past the
  // transcript length in `run.ts` for exactly this reason.
  const path = resolve(import.meta.dirname, "records/ranking.json");
  if (!existsSync(path)) return;
  const draws = (JSON.parse(readFileSync(path, "utf8")) as Record_).draws;
  for (const t of corpus) {
    const keep = pinned(t.entries, FLOORS);
    const candidates = t.entries.filter((e) => !keep.has(e.id)).length;
    for (const d of draws.filter((x) => x.transcript === t.id)) {
      eq(d.ranked.length, candidates, `${t.id}/r${d.repeat} ranked a different number than were candidates: `);
      for (const f of t.facts) {
        ok(
          d.ranked.some((r) => r.id === f.entryId),
          `${t.id}/r${d.repeat}: the fact-holding entry ${f.entryId} was never asked about`,
        );
      }
    }
  }
});

check("the jev order is most-spent-first", () => {
  const path = resolve(import.meta.dirname, "records/ranking.json");
  if (!existsSync(path)) return;
  const draws = (JSON.parse(readFileSync(path, "utf8")) as Record_).draws;
  for (const d of draws) {
    const levels = d.ranked.map((r) => r.level).filter((l) => Number.isFinite(l));
    for (let i = 1; i < levels.length; i += 1) {
      ok(levels[i] >= levels[i - 1], `${d.transcript}/r${d.repeat} is not sorted ascending by level`);
    }
  }
});

// ------------------------------------------------- the new free baseline

check("`overlap` keeps what the goal is about and drops what it is not", () => {
  // The unit behaviour, on a transcript small enough to reason about.
  const entries: Entry[] = [
    { id: "goal", role: "user", text: "find the retry timeout in the scheduler config", label: "goal" },
    { id: "a1", role: "assistant", text: "reading", calls: ["c1"], label: "read" },
    { id: "r1", role: "tool", text: "the scheduler config sets retry timeout to 30s", answers: "c1", label: "read" },
    { id: "a2", role: "assistant", text: "listing", calls: ["c2"], label: "ls" },
    { id: "r2", role: "tool", text: "LICENSE CHANGELOG package-lock.json coverage", answers: "c2", label: "ls" },
  ];
  const order = rankBy("overlap", entries);
  const r2 = order.findIndex((e) => e.id === "r2");
  const r1 = order.findIndex((e) => e.id === "r1");
  ok(r2 < r1, `the unrelated listing should be dropped first; got ${order.map((e) => e.id).join(",")}`);
});

check("`overlap` falls back rather than inventing an order with no goal", () => {
  const entries: Entry[] = [
    { id: "1", role: "tool", text: "x".repeat(400), label: "a" },
    { id: "2", role: "tool", text: "y".repeat(40), label: "b" },
  ];
  // No user entry at all, so no goal vocabulary.
  eq(
    rankBy("overlap", entries)
      .map((e) => e.id)
      .join(","),
    rankBy("largest", entries)
      .map((e) => e.id)
      .join(","),
    "with no goal text it should fall back to `largest`, not return input order: ",
  );
});

// ------------------------------------------------ the summarisation arms

check("every shortening arm keeps every entry", () => {
  // That is what makes it a summarisation and not a deletion wearing the
  // name. If an arm could empty an entry it would be `jev` with extra steps.
  for (const t of corpus) {
    for (const arm of ["truncate", "headtail", "jev-shorten"] as const) {
      const out = shortenBy(arm, { entries: t.entries, budgetTokens: Math.round(t.tokens * 0.3), floors: FLOORS });
      eq(out.length, t.entries.length, `${t.id}/${arm} changed the entry count: `);
      eq(new Set(out.map((e) => e.id)).size, t.entries.length, `${t.id}/${arm} lost or duplicated ids: `);
      for (const e of out) ok(e.text.length > 0, `${t.id}/${arm}: entry ${e.id} was emptied, which is a deletion`);
    }
  }
});

check("every shortening arm actually reaches its budget", () => {
  // The bug this guards cost the comparison its meaning once already: line
  // snapping makes the size a step function of the scale, and bisection
  // alone left `jev-shorten` 2,500 tokens under the 80% budget -- wasting a
  // sixth of what it was allowed and then losing by two points.
  for (const t of corpus) {
    for (const arm of ["truncate", "headtail", "jev-shorten"] as const) {
      for (const fraction of [0.8, 0.6, 0.4, 0.25]) {
        const budget = Math.round(t.tokens * fraction);
        const size = totalTokens(shortenBy(arm, { entries: t.entries, budgetTokens: budget, floors: FLOORS }));
        ok(size <= budget, `${t.id}/${arm} at ${fraction}: ${size} tokens over a budget of ${budget}`);
        ok(size >= budget * 0.9, `${t.id}/${arm} at ${fraction}: ${size} of ${budget} -- left a tenth unspent`);
      }
    }
  }
});

check("a shortening arm never touches the goal or the recent tail", () => {
  // The same floors deletion gets. Otherwise the comparison is about floors.
  for (const t of corpus) {
    const keep = pinned(t.entries, FLOORS);
    for (const arm of ["truncate", "headtail", "jev-shorten"] as const) {
      const out = shortenBy(arm, { entries: t.entries, budgetTokens: Math.round(t.tokens * 0.25), floors: FLOORS });
      const byId = new Map(out.map((e) => [e.id, e]));
      for (const e of t.entries) {
        if (!keep.has(e.id)) continue;
        eq(byId.get(e.id)?.text, e.text, `${t.id}/${arm}: pinned entry ${e.id} was shortened: `);
      }
    }
  }
});

check("a surviving deletion entry is byte-identical, a shortened one is a prefix", () => {
  // The structural difference the two actions have, stated as a test: a
  // deletion cannot corrupt what it keeps. A shortening's output must still
  // be made only of the original's bytes -- if an arm could add a character
  // it would be an abstractive summariser, which nothing here is.
  for (const t of corpus) {
    const { keep } = dropUntilFits(t.entries, rankBy("overlap", t.entries), Math.round(t.tokens * 0.4), FLOORS);
    const byId = new Map(t.entries.map((e) => [e.id, e]));
    for (const e of keep) eq(e.text, byId.get(e.id)?.text, `${t.id}: deletion altered surviving entry ${e.id}: `);
    for (const arm of ["truncate", "headtail"] as const) {
      for (const e of shortenBy(arm, { entries: t.entries, budgetTokens: Math.round(t.tokens * 0.4), floors: FLOORS })) {
        const original = byId.get(e.id)?.text ?? "";
        for (const line of e.text.split("\n")) {
          // The cut marker is the one line an extractive arm may add, and it
          // says so in words rather than pretending to be content.
          if (/^\.\.\. \d+ lines cut \.\.\.$/.test(line)) continue;
          ok(original.includes(line), `${t.id}/${arm}: entry ${e.id} contains a line not in the original`);
        }
      }
    }
  }
});


// --------------------------------------------- TODO §1.5's oracle arm
//
// The `oracle` arm is only an UPPER BOUND if it really hands over every fact
// verbatim. If it paraphrased, rounded, or dropped one, a ceiling result would
// be measuring something weaker than "the summariser was given the answer" --
// and the conclusion drawn from it ("no classifier can do better") would not
// follow. So the arm's premise is checked against the corpus rather than
// assumed.

check("the oracle arm hands over every fact of its transcript, verbatim", () => {
  const corpus = resolve(import.meta.dirname, "records/corpus.json");
  ok(existsSync(corpus), "no records/corpus.json");
  const ts = (JSON.parse(readFileSync(corpus, "utf8")) as { transcripts: Transcript[] }).transcripts;
  ok(ts.length > 0, "empty corpus");
  for (const t of ts) {
    const text = oracleInstructions(t);
    ok(t.facts.length > 0, `${t.id} has no facts, so the oracle would hand over nothing`);
    for (const f of t.facts) {
      ok(text.includes(f.text), `${t.id}: the oracle instructions do not contain "${f.text}" verbatim`);
    }
  }
});

check("the oracle arm is the only one whose text depends on the transcript", () => {
  // If a second arm gained a `build`, the draw arms would stop being controls
  // and the `plainagain` comparison that carries docs/44 §5.2 would silently
  // become something else.
  const built = ARMS.filter((a) => a.build);
  eq(built.length, 1, "exactly one arm may build per-transcript text: ");
  eq(built[0].name, "oracle", "the built arm must be `oracle`: ");
  const draws = ARMS.filter((a) => a.name === "plain" || a.name === "plainagain");
  eq(draws.length, 2, "both draw arms must exist for §5.2's control: ");
  for (const a of draws) {
    eq(a.instructions, "", `${a.name} must send no instructions at all: `);
    ok(a.build === undefined, `${a.name} must not build per-transcript text`);
  }
});

check("the general-rule arm names nothing from the corpus", () => {
  // KEEP_FACTS is about SHAPE. If it ever named a package, a number or a path
  // it would become a lookup table for the facts it is scored on, which is the
  // way that arm could most easily cheat.
  const corpus = resolve(import.meta.dirname, "records/corpus.json");
  const ts = (JSON.parse(readFileSync(corpus, "utf8")) as { transcripts: Transcript[] }).transcripts;
  const rule = ARMS.find((a) => a.name === "instructed")?.instructions ?? "";
  ok(rule.length > 0, "the instructed arm has no instructions");
  for (const t of ts) {
    for (const f of t.facts) {
      ok(!rule.includes(f.text), `KEEP_FACTS leaks the fact "${f.text}" from ${t.id}`);
    }
  }
});


// ------------------------------------------------- TODO §1.6's relevance table
//
// Two bugs happened while writing docs/46 §2 and both produced a plausible
// table rather than a crash, so both are pinned here.

check("the free orderings are given the goal they rank against", () => {
  // `rankBy("overlap")` finds the goal with `entries.find(e => e.role ===
  // "user")` and falls back to `largest` when there is none. The first version
  // of the report passed only the judged candidate set -- which excludes the
  // pinned goal turn -- so `overlap` silently BECAME `largest` and the two
  // rows came out byte-identical. The check is that they do not.
  const corpus = resolve(import.meta.dirname, "records/corpus.json");
  const ts = (JSON.parse(readFileSync(corpus, "utf8")) as { transcripts: Transcript[] }).transcripts;
  let differed = 0;
  for (const t of ts) {
    // THE GOAL TURN IS WHAT THE REAL CANDIDATE SET EXCLUDES -- it is pinned,
    // along with the recent tail. A first version of this test dropped the
    // tail and KEPT the goal, so `overlap` still found it, the fallback never
    // fired, and the test passed with the bug reintroduced. Excluding the goal
    // is the whole point.
    const candidates = new Set(t.entries.filter((e) => e.label !== "goal").slice(0, -6).map((e) => e.id));
    ok(!candidates.has("goal"), "the goal must be outside the candidate set or this test is vacuous");
    const o = keepOrderFree("overlap", t.entries as never, candidates).join(",");
    const l = keepOrderFree("largest", t.entries as never, candidates).join(",");
    if (o !== l) differed += 1;
  }
  ok(differed > 0, "`overlap` and `largest` agree on every transcript, so `overlap` is not seeing the goal");
});

check("the free orderings cover exactly the candidate set, once each", () => {
  const corpus = resolve(import.meta.dirname, "records/corpus.json");
  const ts = (JSON.parse(readFileSync(corpus, "utf8")) as { transcripts: Transcript[] }).transcripts;
  for (const t of ts) {
    const candidates = new Set(t.entries.filter((e) => e.label !== "goal").slice(0, -6).map((e) => e.id));
    for (const kind of ["overlap", "oldest", "largest", "stale"] as const) {
      const got = keepOrderFree(kind, t.entries as never, candidates);
      eq(got.length, candidates.size, `${t.id}/${kind} ranked the wrong number of entries: `);
      eq(new Set(got).size, got.length, `${t.id}/${kind} ranked an entry twice: `);
      ok(got.every((id) => candidates.has(id)), `${t.id}/${kind} ranked an entry outside the candidate set`);
    }
  }
});

check("rankOfFact is 1-based and reports a missing entry as NaN, not as last", () => {
  // Returning `order.length` for a missing entry would let an arm that cannot
  // see the fact at all score like an arm that ranked it worst, which is a
  // different claim.
  eq(rankOfFact(["a", "b", "c"], new Set(["a"]))[0], 1, "first place is rank 1: ");
  eq(rankOfFact(["a", "b", "c"], new Set(["c"]))[0], 3, "last of three is rank 3: ");
  ok(Number.isNaN(rankOfFact(["a", "b"], new Set(["z"]))[0]), "a missing entry must be NaN");
});

check("the digits ordering really does separate on digits and nothing else", () => {
  const corpus = resolve(import.meta.dirname, "records/corpus.json");
  const ts = (JSON.parse(readFileSync(corpus, "utf8")) as { transcripts: Transcript[] }).transcripts;
  const t = ts[0];
  const candidates = new Set(t.entries.map((e) => e.id));
  const order = keepOrderDigits(t.entries as never, candidates);
  const has = (id: string): boolean => /\d/.test(t.entries.find((e) => e.id === id)?.text ?? "");
  let seenWithout = false;
  for (const id of order) {
    if (!has(id)) seenWithout = true;
    else ok(!seenWithout, `${id} has a digit but sorts after an entry without one`);
  }
  ok(order.some(has) && order.some((id) => !has(id)), "the corpus must contain both kinds or the arm is vacuous");
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
