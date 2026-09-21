#!/usr/bin/env -S npx tsx
/**
 * The gate, standalone.
 *
 *   jev-guard 'rm -rf /'                       one command, one verdict
 *   jev-guard --tool write --input '{...}'     any tool call
 *   jev-guard --replay audit.jsonl --deny 1.2  re-read a log at other cutoffs
 *
 * `--replay` needs no API key and makes no request, and it is the reason the
 * audit log stores raw answers rather than verdicts. docs/19 §4: when two
 * implementations of a probabilistic decision disagree, you cannot tell a
 * logic difference from run-to-run variation unless you can run BOTH RULES
 * OVER THE SAME ANSWERS. The same applies to a cutoff -- "would stricter
 * cutoffs have blocked this?" is a question about a recorded run, and asking
 * the API again answers a different one.
 */
import { readFileSync } from "node:fs";
import { DEFAULT_GUARD_CONFIG, VERDICT_NAME, guard, resolve, type GuardConfig } from "./guard.js";
import { reasonOf, verdictOf } from "./battery.js";
import type { Answer } from "@jev-playground/jev-core";

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const opt = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
};

function thresholdsFrom(): { ask: number; deny: number } {
  return {
    ask: Number.parseFloat(opt("ask", String(DEFAULT_GUARD_CONFIG.thresholds.ask)) as string),
    deny: Number.parseFloat(opt("deny", String(DEFAULT_GUARD_CONFIG.thresholds.deny)) as string),
  };
}

interface LoggedDecision {
  tool?: string;
  band?: string;
  verdict?: number | null;
  action?: string;
  answers?: Record<string, Answer>;
}

function replay(path: string): void {
  const thresholds = thresholdsFrom();
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  let changed = 0;
  let reread = 0;
  console.log(`re-reading ${lines.length} recorded decisions at ask ${thresholds.ask} / deny ${thresholds.deny}\n`);
  for (const line of lines) {
    let row: LoggedDecision;
    try {
      const parsed = JSON.parse(line) as LoggedDecision | { details?: LoggedDecision };
      // An entry written by `pi.appendEntry` nests the payload under
      // `details`; a row written by this CLI does not. Accept both rather
      // than making the caller reshape their log.
      row = "details" in parsed && parsed.details ? parsed.details : (parsed as LoggedDecision);
    } catch {
      continue;
    }
    if (!row.answers) continue;
    reread += 1;
    const verdict = verdictOf(row.answers, thresholds);
    if (verdict === null) continue;
    const was = row.verdict ?? null;
    const differs = was !== verdict;
    if (differs) changed += 1;
    console.log(
      `  ${differs ? "CHANGED" : "same   "} ${VERDICT_NAME[verdict].padEnd(5)}` +
        `${differs ? ` (was ${was === null ? "none" : VERDICT_NAME[was]})` : "       "}  ` +
        `${(row.tool ?? "?").padEnd(8)} ${reasonOf(row.answers, verdict, thresholds)}`,
    );
  }
  console.log(`\n  ${reread} decisions re-read, ${changed} would differ. No requests were made.`);
}

async function main(): Promise<void> {
  const replayPath = opt("replay");
  if (replayPath) {
    replay(replayPath);
    return;
  }

  const tool = opt("tool", "bash") as string;
  const rawInput = opt("input");
  const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  const input: Record<string, unknown> = rawInput
    ? (JSON.parse(rawInput) as Record<string, unknown>)
    : { command: positional.join(" ") };

  if (tool === "bash" && !input.command) {
    console.error("usage: jev-guard '<command>' | --tool <name> --input '<json>' | --replay <log>");
    process.exit(2);
  }

  const config: Partial<GuardConfig> = {
    thresholds: thresholdsFrom(),
    allowSafe: flag("allow-safe"),
    attended: !flag("unattended"),
    ...(flag("shell-only") ? { scope: "shell" as const } : {}),
    ...(opt("timeout") ? { timeoutMs: Number.parseInt(opt("timeout") as string, 10) } : {}),
  };

  const result = await guard({ toolName: tool, input, cwd: process.cwd() }, { config });
  const full = { ...DEFAULT_GUARD_CONFIG, ...config };
  console.log(
    JSON.stringify(
      {
        verdict: result.verdict === null ? null : VERDICT_NAME[result.verdict],
        action: result.action,
        // What the same verdict would mean with nobody watching. A resident
        // agent's operator is choosing between these two, so print both.
        unattended_action: resolve(result.verdict, { ...full, attended: false }),
        band: result.band,
        free: result.free,
        reason: result.reason,
        ms: result.ms,
        error: result.error,
      },
      null,
      2,
    ),
  );
  if (flag("answers") && result.answers) console.log(JSON.stringify(result.answers, null, 2));
  process.exit(result.action === "block" ? 1 : 0);
}

await main();
