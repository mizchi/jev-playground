/**
 * The gate variants in gatecheck.ts are scored on the SUGGESTION. What the
 * cookbook actually reports is the agent's behaviour, so this closes the loop:
 * recompute the suggestion under a different gate from data already collected,
 * then re-run only the agent turn.
 *
 * No new Jev calls — the gate scores live in each case's trace and the stage-2
 * answers are in gatecheck's cache, so the whole variant is free on that side.
 *
 *   npx tsx src/gatearm.ts [--gate procedure|none|mean015] [--concurrency 5]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { decide } from "./agent.js";
import type { SkillEntry } from "./roster.js";
import { FITS_THRESHOLD, suggestionBlock, type Trace } from "./suggest.js";

interface Row {
  request: string;
  expect: string | null;
  agent?: string | null;
  assisted?: string | null;
  suggestedTrace?: Trace;
  stage2?: { winner: string; bestFits: number } | null;
  /** This variant's suggestion and what the agent then did. */
  variantSuggested?: string | null;
  variantAssisted?: string | null;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const GATE = arg("gate", "procedure");
const CONCURRENCY = Number.parseInt(arg("concurrency", "5"), 10);
const AGENT_MODEL = arg("agent-model", "claude-haiku-4-5-20251001");
const CACHE = `out/gatearm-${GATE}.json`;

const GATES: Record<string, (t: Trace) => boolean> = {
  procedure: (t) => t.gate.procedure >= 0.3,
  none: () => true,
  mean015: (t) => t.gate.mean >= 0.15,
  cookbook: (t) => t.gate.mean >= 0.3,
};

function pct(n: number, d: number): string {
  return d === 0 ? "-" : `${((n / d) * 100).toFixed(1)}%`;
}

async function main() {
  const gate = GATES[GATE];
  if (!gate) throw new Error(`unknown gate '${GATE}' (${Object.keys(GATES).join(" | ")})`);
  const roster = JSON.parse(readFileSync("out/roster.json", "utf8")) as SkillEntry[];
  const results = JSON.parse(readFileSync("out/results.json", "utf8")) as Row[];
  const stage2 = new Map(
    (JSON.parse(readFileSync("out/gatecheck.json", "utf8")) as Row[]).map((r) => [r.request, r.stage2]),
  );
  const prior = existsSync(CACHE)
    ? new Map((JSON.parse(readFileSync(CACHE, "utf8")) as Row[]).map((r) => [r.request, r]))
    : new Map<string, Row>();

  const rows: Row[] = results.map((r) => ({
    ...r,
    stage2: stage2.get(r.request),
    variantSuggested: prior.get(r.request)?.variantSuggested,
    variantAssisted: prior.get(r.request)?.variantAssisted,
  }));

  // The suggestion under the new gate, straight from cached numbers.
  for (const r of rows) {
    if (r.variantSuggested !== undefined) continue;
    const t = r.suggestedTrace;
    if (!t) {
      r.variantSuggested = null;
      continue;
    }
    const s2 = r.stage2;
    r.variantSuggested =
      gate(t) && s2 && s2.bestFits >= FITS_THRESHOLD ? s2.winner : null;
  }
  writeFileSync(CACHE, JSON.stringify(rows, null, 2));

  const need = rows.filter((r) => r.variantAssisted === undefined);
  console.log("=".repeat(100));
  console.log(`  GATE VARIANT '${GATE}' — agent ${AGENT_MODEL}, ${need.length} turns to run`);
  console.log("=".repeat(100));

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= rows.length) return;
      const r = rows[i];
      if (r.variantAssisted === undefined) {
        try {
          const d = await decide(
            roster,
            r.request,
            AGENT_MODEL,
            suggestionBlock(r.variantSuggested ? [r.variantSuggested] : []),
          );
          r.variantAssisted = d.loaded;
        } catch (err) {
          console.warn(`\n  case ${i} failed: ${String(err).slice(0, 120)}`);
          r.variantAssisted = null;
        }
        writeFileSync(CACHE, JSON.stringify(rows, null, 2));
      }
      process.stdout.write(".");
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
  console.log("");

  const arms: [string, (r: Row) => string | null | undefined][] = [
    ["agent alone", (r) => r.agent],
    ["+ cookbook gate", (r) => r.assisted],
    [`+ '${GATE}' gate`, (r) => r.variantAssisted],
  ];
  console.log("");
  for (const [label, pick] of arms) {
    let wrong = 0;
    let covered = 0;
    let needless = 0;
    let uncovered = 0;
    for (const r of rows) {
      const got = pick(r);
      if (got === undefined) continue;
      if (r.expect === null) {
        uncovered += 1;
        if (got !== null) needless += 1;
      } else {
        covered += 1;
        if (got !== r.expect) wrong += 1;
      }
    }
    console.log(
      `  ${label.padEnd(20)} wrong ${pct(wrong, covered).padStart(6)} (${wrong}/${covered})` +
        `   needless ${pct(needless, uncovered).padStart(6)} (${needless}/${uncovered})`,
    );
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
