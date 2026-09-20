/**
 * The shared pieces, checked without a key or a network.
 *
 * The client's own retry and split paths are exercised with an injected
 * `fetch`, because the one thing that must not be discovered in production is
 * that the too-large path loops instead of splitting.
 */
import { Jev, JevTooLargeError, bytesOf, noulOf, scoreOf, rungFor, costOf, expectedCost } from "./src/index.js";

let pass = 0;
let fail = 0;
const pending: Promise<void>[] = [];
const check = (name: string, fn: () => void | Promise<void>): void => {
  const done = (err?: unknown): void => {
    if (err) {
      fail += 1;
      console.log(`  FAIL ${name}: ${(err as Error).message}`);
    } else {
      pass += 1;
      console.log(`  ok   ${name}`);
    }
  };
  try {
    const out = fn();
    if (out instanceof Promise) {
      pending.push(out.then(() => done()).catch(done));
      return;
    }
    done();
  } catch (err) {
    done(err);
  }
};
const ok = (cond: boolean, what: string): void => {
  if (!cond) throw new Error(what);
};
const eq = <T,>(a: T, b: T, what = ""): void => {
  if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

const reply = (answers: Record<string, unknown>): Response =>
  new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 10, output_tokens: 0 } }), {
    status: 200,
  });

check("a missing answer reads as NaN and not as zero", () => {
  // A router branches on these. Reading a missing noul as 0 would make it
  // "definitely not", which is a decision nobody made.
  ok(Number.isNaN(noulOf({}, "absent")), "a missing noul should be NaN");
  ok(Number.isNaN(noulOf({ a: { type: "score", score: 1 } }, "a")), "a score read as a noul should be NaN");
  eq(noulOf({ a: { type: "noul", noul: 0 } }, "a"), 0, "a real zero must survive");
  ok(Number.isNaN(scoreOf({}, "absent").score));
  eq(scoreOf({ a: { type: "score", score: 1.5, confidence: 0.9 } }, "a").score, 1.5);
});

check("a too-large request splits its questions instead of looping", async () => {
  let calls = 0;
  const seen: number[] = [];
  const jev = new Jev({
    apiKey: "test",
    fetchImpl: async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String((init as RequestInit).body)) as { questions: Record<string, unknown> };
      const n = Object.keys(body.questions).length;
      seen.push(n);
      if (n > 2) return new Response(JSON.stringify({ error_type: "max_tokens_exceeded" }), { status: 400 });
      return reply(Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: "noul", noul: 0.5 }])));
    },
  });
  const questions = Object.fromEntries(
    Array.from({ length: 4 }, (_, i) => [`q${i}`, { type: "noul" as const, instructions: "x" }]),
  );
  const res = await jev.ask({ s: 1 }, questions);
  eq(Object.keys(res.answers).length, 4, "the halves were not recombined");
  eq(res.usage.input_tokens, 20, "usage was not summed across the halves");
  ok(calls <= 7, `${calls} calls for a 4-question split suggests a loop`);
  ok(seen.includes(2), `expected a 2-question half, saw ${seen.join()}`);
  eq(jev.splitCalls > 0, true, "the split was not recorded");
});

check("a single question that is too large raises rather than splitting forever", async () => {
  const jev = new Jev({
    apiKey: "test",
    fetchImpl: async () => new Response(JSON.stringify({ error_type: "max_tokens_exceeded" }), { status: 400 }),
  });
  let caught: unknown;
  try {
    await jev.ask({ s: 1 }, { only: { type: "noul", instructions: "x" } });
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof JevTooLargeError, `expected JevTooLargeError, got ${String(caught)}`);
});

check("a 4xx that is not a size refusal is not retried", async () => {
  let calls = 0;
  const jev = new Jev({
    apiKey: "test",
    retries: 5,
    fetchImpl: async () => {
      calls += 1;
      return new Response("bad request", { status: 400 });
    },
  });
  await jev.ask({ s: 1 }, { q: { type: "noul" } }).catch(() => undefined);
  eq(calls, 1, "a plain 400 was retried");
});

check("bytesOf measures UTF-8 and not characters", () => {
  eq(bytesOf("abc"), 3);
  eq(bytesOf("日本語"), 9, "three-byte characters must count as three");
  eq(bytesOf({ a: 1 }), 7);
});

check("the ladder's rung lookup is inclusive at the cut", () => {
  eq(rungFor(0.4, [0.5, 1.5]), 0);
  eq(rungFor(0.5, [0.5, 1.5]), 1, "a score exactly on a cut belongs to the higher rung");
  eq(rungFor(2.0, [0.5, 1.5]), 2);
  eq(rungFor(1.0, []), 0, "no cuts means one rung");
});

check("under-routing costs the penalty and over-routing costs only the difference", () => {
  const rungs = [{ name: "cheap", price: 1 }, { name: "dear", price: 10 }];
  const cost = { failurePenalty: 100 };
  eq(costOf(0, { score: 0, cheapest: 1 }, rungs, cost), 101, "under-route pays the price AND the penalty");
  eq(costOf(1, { score: 0, cheapest: 0 }, rungs, cost), 10, "over-route pays only the dearer price");
  eq(costOf(0, { score: 0, cheapest: 0 }, rungs, cost), 1, "a correct cheap route pays the cheap price");
  eq(costOf(1, { score: 0, cheapest: null }, rungs, cost), 10, "an unservable task pays no penalty");
  ok(Number.isNaN(expectedCost([0.5], [], rungs, cost)), "the mean of nothing is NaN, not 0");
});

await Promise.all(pending);
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
