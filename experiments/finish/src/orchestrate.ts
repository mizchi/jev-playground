/**
 * The orchestration gate, behind one line of JSON, for `gate.mjs` to spawn.
 *
 * Why a driver and not the shipped CLI: `packages/jev-orchestrator/src/cli.ts`
 * prints for a human ("cost named  gate 0.62  -> single"), and a hook that
 * parses that is a hook that breaks when someone improves the wording. This
 * calls the same shipped `plan()` and prints the decision as data.
 *
 *   tsx orchestrate.ts "<the work>"
 *   -> {"shape":"single","workers":1,"split":false,"gate":0.31,"ms":412,...}
 *
 * `tsx` and not `node --experimental-strip-types`, and the reason is a fact
 * about this repository rather than a preference: the packages import each
 * other with `.js` specifiers pointing at `.ts` files, and Node's own type
 * stripping does not rewrite the extension. Every other experiment that
 * touches `packages/` runs under tsx for the same reason.
 *
 * Why a subprocess at all, when `runOnce` could hold the router in memory: the
 * gate has to answer INSIDE a `PreToolUse` hook, which the host runs as its own
 * process. Measuring it any other way measures a deployment that does not
 * exist. The cost of that is a Node start-up per `Task` call, and it is in the
 * `ms` the row records, because that is what a user wiring this up pays.
 *
 * Fails open, loudly in the JSON and quietly to the host: a gate that throws in
 * front of an agent stops work that judgment was only advising on.
 */
import { plan } from "../../../packages/jev-orchestrator/src/plan.js";

async function main(): Promise<void> {
  const request = process.argv.slice(2).join(" ").trim();
  if (!request) {
    console.log(JSON.stringify({ error: "no request", shape: "single", workers: 1, split: false }));
    return;
  }
  try {
    const res = await plan({ request });
    console.log(
      JSON.stringify({
        shape: res.plan.shape,
        workers: res.plan.workers,
        split: res.plan.split,
        reason: res.plan.reason,
        agreement: res.plan.agreement,
        gate: res.judgment ? res.judgment.gate : null,
        staySingle: res.judgment ? res.judgment.staySingle : null,
        size: res.judgment ? res.judgment.size : null,
        topology: res.judgment ? res.judgment.topology : null,
        ms: res.ms,
        ...(res.usage ? { inputTokens: res.usage.input } : {}),
        ...(res.error ? { error: res.error.slice(0, 300) } : {}),
      }),
    );
  } catch (err) {
    // `plan()` documents itself as never throwing. If it does anyway, the hook
    // must still get a parseable "carry on" rather than an empty stdout it
    // would have to guess about.
    console.log(
      JSON.stringify({ error: String(err).slice(0, 300), shape: "single", workers: 1, split: false, gate: null }),
    );
  }
}

await main();
