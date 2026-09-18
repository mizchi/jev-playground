/**
 * Reproduce the guardrails cookbook's table, then check the part the cookbook
 * does not: whether the routing holds up on messages it never saw.
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/run.ts [--policy strict] [--probe]
 *
 * `--probe` adds the extra messages in probes.ts, which exist to attack the
 * design rather than demonstrate it: benign requests that look alarming,
 * hostile ones that look benign, and the fiction framing that the cookbook's
 * own `novelist_poison` case says should pass.
 */
import { Jev } from "../../shared/jev.js";
import { CASES } from "./cases.js";
import { PROBES } from "./probes.js";
import { POLICIES, screen, type Decision } from "./screen.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const POLICY_NAME = arg("policy", "strict");
const WITH_PROBES = process.argv.includes("--probe");

const TAG: Record<Decision, string> = {
  pass: "[  pass  ]",
  review: "[ review ]",
  block: "[ BLOCK  ]",
  support: "[support ]",
};

async function main() {
  const jev = new Jev();
  const policy = POLICIES[POLICY_NAME];
  if (!policy) throw new Error(`unknown policy '${POLICY_NAME}'`);

  console.log("=".repeat(100));
  console.log(`  GUARDRAILS — policy ${POLICY_NAME} (review ${policy.review_threshold}, ` +
    `act ${policy.action_threshold}, severity blocks at ${policy.severity_block})`);
  console.log(`  reproducing https://docs.typesafe.ai/cookbooks/llm_guardrails`);
  console.log("=".repeat(100));

  for (const side of ["input", "output"] as const) {
    const group = CASES.filter((c) => c.side === side);
    console.log("");
    console.log(`  ${side.toUpperCase()}  ${side === "input" ? "(user messages)" : "(model replies)"}`);
    let agree = 0;
    for (const c of group) {
      const r = await screen(jev, c.message, side, policy);
      const ok = r.decision === c.expect;
      if (ok) agree += 1;
      const driver = r.driver ?? c.reportedKey;
      console.log(
        `  ${TAG[r.decision]} ${c.id.padEnd(24)} ${driver}=${(r.hazards[driver] ?? 0).toFixed(2)} ` +
          `sev=${r.severity.toFixed(1)}  ${ok ? " " : "≠"} cookbook: ${c.expect} ` +
          `(${c.reportedKey}=${c.reportedValue.toFixed(2)} sev=${c.reportedSeverity.toFixed(1)})`,
      );
    }
    console.log(`  → same decision as the cookbook on ${agree}/${group.length}`);
  }

  if (WITH_PROBES) {
    console.log("");
    console.log("  " + "-".repeat(96));
    console.log("  PROBES — messages the cookbook never ran, to find where the routing breaks");
    console.log("");
    let right = 0;
    const wrong: string[] = [];
    for (const p of PROBES) {
      const r = await screen(jev, p.message, p.side, policy);
      const ok = r.decision === p.expect;
      if (ok) right += 1;
      else wrong.push(`${p.id}: wanted ${p.expect}, got ${r.decision} (${p.why})`);
      const top = Object.entries(r.hazards).sort((a, b) => b[1] - a[1])[0];
      console.log(
        `  ${TAG[r.decision]} ${p.id.padEnd(26)} ${top[0]}=${top[1].toFixed(2)} sev=${r.severity.toFixed(1)}` +
          `  ${ok ? " " : "≠"} want ${p.expect}`,
      );
    }
    console.log("");
    console.log(`  → ${right}/${PROBES.length} routed as intended`);
    for (const w of wrong) console.log(`     miss: ${w}`);
  }

  console.log("");
  console.log(
    `  cost: ${jev.calls} requests, ${jev.inputTokens} input tokens, ` +
      `$${((jev.inputTokens / 1e6) * 0.042).toFixed(5)}, ` +
      `${(jev.totalMs / Math.max(jev.calls, 1)).toFixed(0)} ms/message` +
      (jev.retriedCalls ? `, ${jev.retriedCalls} retried` : ""),
  );
  console.log("  (one request screens a whole message: 4 hazards and a severity score)");
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
