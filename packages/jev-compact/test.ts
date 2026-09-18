/**
 * What has to hold before an agent's memory is deleted. No API key.
 *
 *   npm test
 *
 * The load-bearing checks are the STRUCTURAL ones, because they are the
 * failures no score can compensate for: a transcript that breaks tool-call
 * pairing is rejected by the provider outright, and a transcript that lost
 * its goal cannot be recovered from what is left. Judgment is allowed to be
 * wrong about what to delete; it is not allowed to produce either of those.
 */
import { Jev, type Answer } from "@jev-playground/jev-core";
import {
  DEFAULT_COMPACT_CONFIG,
  closePairs,
  compact,
  compactBy,
  digest,
  dropUntilFits,
  payloadOf,
  pinned,
  questionsFor,
  rankBy,
  stateFor,
  tokensOf,
  totalTokens,
  valid,
  entriesOf,
  type Entry,
} from "./src/compact.js";

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve()
    .then(fn)
    .then(() => {
      pass += 1;
      console.log(`  ok   ${name}`);
    })
    .catch((err: Error) => {
      fail += 1;
      console.log(`  FAIL ${name}: ${err.message}`);
    });
const ok = (cond: boolean, what: string): void => {
  if (!cond) throw new Error(what);
};
const eq = <T,>(a: T, b: T, what = ""): void => {
  if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

/** A transcript with two tool round trips and one big file read. */
function transcript(): Entry[] {
  const big = "x".repeat(40_000);
  return [
    { id: "0", role: "user", text: "Fix the failing test in src/clamp.ts", label: "user" },
    { id: "1", role: "assistant", text: "read(src/clamp.ts)", calls: ["c1"], label: "assistant" },
    { id: "2", role: "tool", text: big, answers: "c1", label: "read" },
    { id: "3", role: "assistant", text: "bash(npm test)", calls: ["c2"], label: "assistant" },
    { id: "4", role: "tool", text: "1 failing: clamp returns 11 for clamp(11,0,10)", answers: "c2", label: "bash" },
    { id: "5", role: "assistant", text: "The bound is exclusive; it should be inclusive.", label: "assistant" },
    { id: "6", role: "user", text: "go ahead", label: "user" },
    { id: "7", role: "assistant", text: "edit(src/clamp.ts)", calls: ["c3"], label: "assistant" },
    { id: "8", role: "tool", text: "ok", answers: "c3", label: "edit" },
  ];
}

const tests: Promise<void>[] = [];

// -------------------------------------------------- structural

tests.push(
  check("a call and its result are dropped together or not at all", () => {
    const t = transcript();
    // Propose dropping only the result of c1, not the assistant turn.
    const closed = closePairs(t, new Set(["2"]), new Set());
    ok(!closed.has("2") || closed.has("1"), "a tool result was dropped while its call survived");
    // Propose dropping only the assistant turn that made c1.
    const other = closePairs(t, new Set(["1"]), new Set());
    ok(!other.has("1") || other.has("2"), "a tool call was dropped while its result survived");
    // Both together is fine.
    const both = closePairs(t, new Set(["1", "2"]), new Set());
    eq(both.size, 2);
  }),
);

tests.push(
  check("a pinned result rescues the older call that produced it", () => {
    // The retraction has to propagate backwards: keeping entry 8 (recent)
    // means entry 7 cannot go, even though it is older and cheap to drop.
    const t = transcript();
    const closed = closePairs(t, new Set(["7"]), new Set(["8"]));
    eq(closed.size, 0, "the caller of a pinned result was dropped: ");
  }),
);

tests.push(
  check("the goal and the recent tail are never candidates", () => {
    const t = transcript();
    const keep = pinned(t, { keepRecent: 3, keepGoal: true });
    ok(keep.has("0"), "the goal was droppable");
    for (const id of ["6", "7", "8"]) ok(keep.has(id), `recent entry ${id} was droppable`);
    ok(!keep.has("2"), "the big middle read was pinned, so nothing can ever be freed");
    // keepGoal off is honoured, since a caller may carry the goal elsewhere.
    ok(!pinned(t, { keepRecent: 1, keepGoal: false }).has("0"), "keepGoal: false was ignored");
  }),
);

tests.push(
  check("every surviving transcript is structurally sound", () => {
    const t = transcript();
    // Try every single-entry deletion and every ranking; all must survive.
    for (const baseline of ["oldest", "largest", "stale"] as const) {
      for (const budget of [100, 1_000, 10_000, 39_000]) {
        const { keep } = dropUntilFits(t, rankBy(baseline, t), budget, DEFAULT_COMPACT_CONFIG);
        const sound = valid(keep);
        ok(sound.ok, `${baseline} at budget ${budget}: ${sound.why}`);
      }
    }
  }),
);

tests.push(
  check("deletion stops as soon as it fits, and not before", () => {
    const t = transcript();
    const before = totalTokens(t);
    // The one big entry is ~10,000 tokens of a ~10,050-token transcript, so
    // a budget just under the total is met by dropping it and its call.
    const { keep, dropped } = dropUntilFits(t, rankBy("largest", t), before - 100, DEFAULT_COMPACT_CONFIG);
    ok(totalTokens(keep) <= before - 100, "the result is still over budget");
    ok(dropped.length <= 2, `dropped ${dropped.length} entries when two would do`);
  }),
);

tests.push(
  check("a retracted drop does not count as freed space", () => {
    // The bug this guards: counting a proposal instead of the closed set
    // stops deleting too early, and the caller gets a transcript that is
    // still over budget with a result that says it succeeded.
    const t: Entry[] = [
      { id: "0", role: "user", text: "goal", label: "user" },
      { id: "1", role: "assistant", text: "a".repeat(4_000), calls: ["c1"], label: "assistant" },
      { id: "2", role: "tool", text: "b".repeat(4_000), answers: "c1", label: "read" },
      { id: "3", role: "assistant", text: "c".repeat(4_000), label: "assistant" },
      { id: "4", role: "assistant", text: "d".repeat(4_000), label: "assistant" },
      { id: "5", role: "user", text: "carry on", label: "user" },
    ];
    // Entry 2 is deliberately absent from the offered order, so entry 1's
    // drop can never close and frees nothing however often it is proposed.
    // An implementation that sized the PROPOSAL rather than the closed set
    // would count 1,000 freed tokens for it, stop one entry early, and
    // return a transcript still over budget while reporting success.
    const { keep } = dropUntilFits(t, [t[1], t[3], t[4]], 2_100, { keepRecent: 1, keepGoal: true });
    ok(totalTokens(keep) <= 2_100, `left ${totalTokens(keep)} tokens against a budget of 2,100`);
    ok(valid(keep).ok, "the survivors are unsound");
  }),
);

// -------------------------------------------------- the free baselines

tests.push(
  check("the three free rankings differ from each other", () => {
    // If they did not, there would be one baseline and not three, and the
    // comparison docs/33 §1 asks for would be vacuous.
    const t = transcript();
    const orders = new Set(["oldest", "largest", "stale"].map((b) => rankBy(b as never, t).map((e) => e.id).join(",")));
    ok(orders.size > 1, "every free ranking produced the same order");
    eq(rankBy("largest", t)[0].id, "2", "largest did not put the 40,000-character read first");
    eq(rankBy("oldest", t)[0].id, "0", "oldest did not start at the front");
  }),
);

tests.push(
  check("a transcript already under budget is left alone by every path", async () => {
    const t = transcript();
    const big = totalTokens(t) + 1;
    for (const b of ["oldest", "largest", "stale"] as const) {
      const r = compactBy(b, t, { budgetTokens: big });
      eq(r.outcome, "fits", `${b}: `);
      eq(r.dropped.length, 0, `${b}: `);
    }
    // And the paid path returns before it builds a request, so this needs no key.
    const r = await compact(t, { goal: "x" }, { config: { budgetTokens: big } });
    eq(r.outcome, "fits");
  }),
);

tests.push(
  check("a budget below the floors is reported, not attempted", () => {
    // The terminal case. Deleting everything droppable and still being over
    // budget would have spent the transcript for nothing, so it has its own
    // outcome and the host is told to summarise.
    const t = transcript();
    const r = compactBy("largest", t, { budgetTokens: 1, keepRecent: 9 });
    eq(r.outcome, "cannot-fit");
    eq(r.dropped.length, 0);
    ok(r.reason.includes("floors"), `the reason does not name the floors: ${r.reason}`);
  }),
);

// -------------------------------------------------- the request

tests.push(
  check("the request is bounded by the number of candidates, not their size", () => {
    // The whole point of digesting. A transcript is being compacted BECAUSE
    // it is too big to send, so a question carrying its entry whole would
    // fail on exactly the inputs this exists for.
    const small = transcript();
    const huge = small.map((e) => ({ ...e, text: e.text.repeat(50) }));
    const ctx = { goal: "g", recent: [] };
    const a = payloadOf(ctx, small).length;
    const b = payloadOf(ctx, huge).length;
    // The bound is `candidates x cap`, not a ratio: 50x the transcript grows
    // the payload only as far as the cap lets each digest grow, which for
    // this transcript's mostly-short entries means once and then never again.
    ok(b < a * 2, `the payload grew ${(b / a).toFixed(1)}x with 50x the transcript`);
    const cap = 400;
    const ceiling = small.length * (cap + 300) + 4_000;
    ok(b < ceiling, `${b} bytes exceeds the ${ceiling}-byte bound for ${small.length} candidates`);
    // 100x again stays under the same ceiling. Not asserted as EQUAL: a
    // two-character entry like "ok" is still under the cap at 50x, so it has
    // room to grow once more before saturating. The bound is the claim.
    const huger = small.map((e) => ({ ...e, text: e.text.repeat(5_000) }));
    const c = payloadOf(ctx, huger).length;
    ok(c < ceiling, `${c} bytes exceeds the ${ceiling}-byte bound at 5,000x`);
    ok(c - b < 500, `the payload grew another ${c - b} bytes for 100x more transcript`);
    ok(digest({ id: "x", role: "user", text: "y".repeat(10_000) }, cap).length <= cap + 5, "the digest ignored its cap");
  }),
);

tests.push(
  check("the digest keeps both ends of an entry", () => {
    // Head-and-tail, because for a tool result the head says what was
    // attempted and the tail says how it ended.
    const text = `START${"-".repeat(5_000)}END`;
    const d = digest({ id: "x", role: "tool", text }, 100);
    ok(d.startsWith("START"), "the digest lost the head");
    ok(d.endsWith("END"), "the digest lost the tail");
  }),
);

tests.push(
  check("the escape hatch is its own question, not a level", () => {
    // docs/17 §3: as a level it pulled ordinary entries into it (16/18
    // against 18/18 as a separate noul).
    const qs = questionsFor(transcript());
    eq(qs.nothing_spare.type, "noul");
    for (const [key, q] of Object.entries(qs)) {
      if (key === "nothing_spare") continue;
      eq(q.type, "score", `${key}: `);
      eq((q as { criteria: unknown[] }).criteria.length, 4, `${key}: `);
    }
  }),
);

tests.push(
  check("the level meaning is paid for once, in the state", () => {
    // docs/30 §7: 251 tokens per question became 118 by moving the shared
    // text into the state. A regression here is invisible except as a bill.
    const t = transcript();
    const state = JSON.stringify(stateFor({ goal: "g", recent: [] }));
    ok(state.includes("Spent."), "the level meaning is not in the state");
    const qs = JSON.stringify(questionsFor(t));
    ok(!qs.includes("Spent."), "the full level text is repeated in every question");
    ok(qs.includes("spent"), "the terse level labels are missing from the questions");
  }),
);

tests.push(
  check("no level, cutoff or verdict leaks into the payload", () => {
    const body = payloadOf({ goal: "Fix the failing test", recent: [] }, transcript());
    for (const word of ["dropAt", "budgetTokens", "keepRecent", "1.5", "delete this"]) {
      ok(!body.includes(word), `the payload leaks "${word}"`);
    }
  }),
);

// -------------------------------------------------- failure

tests.push(
  check("judgment failure defers by default and never deletes on a guess", async () => {
    // Over-deletion is undetectable: nothing afterwards can notice that a
    // fact is missing. So the default failure is to hand the problem back.
    const t = transcript();
    const dead = new Jev({ apiKey: "x", baseUrl: "http://127.0.0.1:1", retries: 0, timeoutMs: 200 });
    const deferred = await compact(t, { goal: "g" }, { config: { budgetTokens: 100 }, jev: dead });
    eq(deferred.outcome, "deferred");
    eq(deferred.dropped.length, 0);
    ok(Boolean(deferred.error), "a failure was not reported");
    // `baseline` is the opt-in for a caller who cannot afford to summarise.
    const fellBack = await compact(
      t,
      { goal: "g" },
      { config: { budgetTokens: 100, onError: "baseline", keepRecent: 2 }, jev: dead },
    );
    eq(fellBack.outcome, "deleted");
    ok(fellBack.dropped.length > 0, "the baseline fallback deleted nothing");
    ok(valid(fellBack.keep).ok, "the baseline fallback produced an unsound transcript");
  }),
);

tests.push(
  check("the escape hatch cancels the whole compaction", async () => {
    const t = transcript();
    const answers: Record<string, Answer> = { nothing_spare: { type: "noul", noul: 0.95 } };
    for (const e of t) {
      answers[`e_${e.id}`] = { type: "score", score: 0, confidence: 0.9, legend: {}, probabilities: {} };
    }
    const jev = new Jev({
      apiKey: "x",
      retries: 0,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ model: "jev-latest", answers, usage: { input_tokens: 10, output_tokens: 0 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    const r = await compact(t, { goal: "g" }, { config: { budgetTokens: 100 }, jev });
    eq(r.outcome, "nothing-spare");
    eq(r.dropped.length, 0, "entries were deleted although the hatch fired: ");
  }),
);

// -------------------------------------------------- the Pi mapping

tests.push(
  check("Pi's message list maps onto entries with its pairing intact", () => {
    // The mapping is where a wrong field name would silently disable pairing,
    // producing a transcript a provider rejects. Built from the real shapes
    // in @earendil-works/pi-ai: UserMessage, AssistantMessage, ToolResultMessage.
    const messages = [
      { role: "user", content: "do the thing" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
        ],
      },
      { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "file body" }] },
    ];
    const entries = entriesOf(messages);
    eq(entries.length, 3);
    eq(entries[0].role, "user");
    eq(entries[1].calls?.join(), "call_1", "the tool call id did not survive the mapping: ");
    eq(entries[2].role, "tool");
    eq(entries[2].answers, "call_1", "the tool result lost the call it answers: ");
    eq(entries[2].label, "read");
    ok(entries[1].text.includes("read("), "the tool call is invisible in the entry text");
    ok(valid(entries).ok, "the mapped transcript is already unsound");
    // A thinking block counts as text rather than vanishing, since dropping
    // an assistant turn that is "empty" only because thinking was ignored
    // would look free and not be.
    const thinking = entriesOf([{ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] }]);
    ok(tokensOf(thinking[0]) > 0, "a thinking-only turn measured as zero tokens");
  }),
);

await Promise.all(tests);
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
