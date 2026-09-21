#!/usr/bin/env -S npx tsx
/**
 * The orchestration gate, standalone.
 *
 *   jev-orchestrator "port the API to v2 and update all the call sites"
 *   jev-orchestrator "..." --framing plain      the permissive wording
 *   jev-orchestrator "..." --both               both wordings, one request
 *
 * `--both` is the useful one and it costs nothing extra: docs/31 §2b measured
 * the two wordings as strict and loose rather than better and worse, so
 * seeing them disagree is the signal that a request sits on the boundary.
 */
import { Jev } from "@jev-playground/jev-core";
import { DEFAULT_PLAN_CONFIG, brief, decide, judgmentOf, plan, questionsFor, stateFor } from "./plan.js";

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const opt = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
};

async function both(request: string): Promise<void> {
  // Both wordings of the gate in ONE request. The two `needs_more_than_one`
  // questions would collide on the key, so the plain one is asked under its
  // own name and read back by hand -- the only place this package assembles a
  // question set rather than calling `questionsFor`.
  const strict = questionsFor("cost");
  const loose = questionsFor("plain");
  const jev = new Jev({ timeoutMs: 15_000 });
  const res = await jev.ask(stateFor({ request, cwd: process.cwd() }), {
    ...strict,
    needs_more_than_one_plain: loose.needs_more_than_one,
  });
  const config = { ...DEFAULT_PLAN_CONFIG };
  const strictJudgment = judgmentOf(res);
  const looseJudgment = {
    ...strictJudgment,
    gate: res.answers.needs_more_than_one_plain?.type === "noul" ? res.answers.needs_more_than_one_plain.noul : Number.NaN,
  };
  const a = decide(strictJudgment, config);
  const b = decide(looseJudgment, config);
  console.log(`  cost named    gate ${strictJudgment.gate.toFixed(2)}  -> ${a.shape}${a.split ? ` x${a.workers}` : ""}`);
  console.log(`  cost unnamed  gate ${looseJudgment.gate.toFixed(2)}  -> ${b.shape}${b.split ? ` x${b.workers}` : ""}`);
  console.log(
    `\n  ${a.split === b.split ? "the two wordings agree" : "THE TWO WORDINGS DISAGREE: this request is on the boundary"}`,
  );
  console.log(`  topology: ${strictJudgment.topology} (confidence ${strictJudgment.topologyConfidence.toFixed(2)})`);
  console.log(`  ${res.usage.input_tokens} input tokens, $${((res.usage.input_tokens / 1e6) * 0.042).toFixed(5)}`);
}

async function main(): Promise<void> {
  const request = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")).join(" ");
  if (!request) {
    console.error('usage: jev-orchestrator "<the work>" [--framing cost|plain] [--both]');
    process.exit(2);
  }
  if (flag("both")) {
    await both(request);
    return;
  }
  const framing = opt("framing", DEFAULT_PLAN_CONFIG.framing) as "cost" | "plain";
  const result = await plan({ request, cwd: process.cwd() }, { config: { framing } });
  console.log(brief(result));
  if (result.judgment) {
    console.log(
      `\n  gate ${result.judgment.gate.toFixed(2)}, size ${result.judgment.size.toFixed(2)}, ` +
        `inverted ${result.judgment.staySingle.toFixed(2)} (${result.plan.agreement})`,
    );
    const ranked = Object.entries(result.judgment.probabilities)
      .sort((a, b) => b[1] - a[1])
      .map(([n, p]) => `${n} ${p.toFixed(2)}`)
      .join("  ");
    console.log(`  ${ranked}`);
  }
  if (result.plan.substituted) {
    console.log(`  substituted: ${result.plan.substituted.from} -> ${result.plan.substituted.to}`);
  }
  if (result.error) console.log(`  error: ${result.error}`);
  if (result.usage) console.log(`  ${result.usage.input} input tokens, ${result.ms} ms`);
}

await main();
