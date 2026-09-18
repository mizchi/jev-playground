#!/usr/bin/env -S npx tsx
/**
 * The standalone router. No Pi, no agent, no host.
 *
 *   jev-model-router "fix the failing auth test"
 *   jev-model-router --json "rewrite the scheduler to be lock-free"
 *   jev-model-router --dry-run "rename the variable"        # no request
 *   echo "the task" | jev-model-router
 *
 * Exists so the thing docs/36 measures can be run by anything that can run a
 * command -- a git hook, a CI step, another agent's shell tool -- and so the
 * package is testable without installing Pi.
 */
import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG, detectOverride, payloadOf, route, type RouterConfig } from "./route.js";

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): boolean => argv.includes(`--${name}`);
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const task = argv.filter((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--config").join(" ").trim() ||
    readStdin().trim();
  if (!task || flag("help")) {
    console.error("usage: jev-model-router [--json] [--dry-run] [--config path] \"the task\"");
    process.exit(task ? 0 : 2);
  }

  let config: Partial<RouterConfig> = {};
  const configPath = opt("config");
  if (configPath) config = JSON.parse(readFileSync(configPath, "utf8")) as Partial<RouterConfig>;
  const merged: RouterConfig = { ...DEFAULT_CONFIG, ...config };

  if (flag("dry-run")) {
    // What would be sent, and what the free paths already decide. Useful for
    // checking a config and for seeing the payload size before paying for it.
    const body = payloadOf({ task }, merged);
    console.log(
      JSON.stringify(
        {
          override: detectOverride(merged, task),
          request_bytes: new TextEncoder().encode(body).length,
          tiers: merged.tiers.map((t) => t.label),
          cuts: merged.cuts,
          payload: JSON.parse(body),
        },
        null,
        2,
      ),
    );
    return;
  }

  const result = await route({ task }, { config });
  if (flag("json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const { decision, judgment } = result;
  const effort = decision.effort ? ` · effort ${decision.effort}` : "";
  console.log(`${decision.model}${effort}`);
  console.log(`  reason ${decision.reason}${result.error ? ` · ${result.error}` : ""}`);
  if (judgment) {
    console.log(
      `  tier ${judgment.tier.toFixed(2)} (conf ${judgment.tierConfidence.toFixed(2)})` +
        `  underspecified ${judgment.underspecified.toFixed(2)}  oversized ${judgment.oversized.toFixed(2)}`,
    );
  }
  console.log(`  ${result.ms} ms${result.usage ? ` · ${result.usage.input} input tokens` : ""}`);
}

main().catch((err: unknown) => {
  console.error(String(err));
  process.exit(1);
});
