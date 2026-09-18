/**
 * The evaluation, in the cookbook's terms.
 *
 *   wrong loads   — on a request covered by exactly one skill, the agent
 *                   loaded a different one, or loaded nothing
 *   needless loads— on a request covered by no skill, the agent loaded one
 *
 * Three arms, all over the same requests:
 *   agent       the agent alone, seeing only truncated descriptions
 *   suggestion  the same agent plus the cookbook's one-line block
 *   oracle      the correct answer handed to the agent, as the ceiling
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/run.ts [--limit 90] [--arms agent,suggestion,oracle]
 *
 * Every arm's per-case result is cached, so a rerun costs nothing for work
 * already done and the arms can be filled in separately.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Jev } from "../../shared/jev.js";
import { decide } from "./agent.js";
import type { Case } from "./dataset.js";
import type { SkillEntry } from "./roster.js";
import { suggest, suggestionBlock, type Trace } from "./suggest.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const AGENT_MODEL = arg("agent-model", "claude-haiku-4-5-20251001");
const ARMS = arg("arms", "agent,suggestion,oracle").split(",");
const LIMIT = Number.parseInt(arg("limit", "1000"), 10);
/** Cases in flight at once; every arm is a network round trip. */
const CONCURRENCY = Number.parseInt(arg("concurrency", "5"), 10);
const RESULTS = "out/results.json";

interface Row {
  request: string;
  expect: string | null;
  agent?: string | null;
  agentMs?: number;
  agentInvalid?: boolean;
  suggested?: string | null;
  suggestedTrace?: Trace;
  assisted?: string | null;
  assistedMs?: number;
  oracle?: string | null;
}

function load(): Row[] {
  return existsSync(RESULTS) ? (JSON.parse(readFileSync(RESULTS, "utf8")) as Row[]) : [];
}

function save(rows: Row[]): void {
  mkdirSync("out", { recursive: true });
  writeFileSync(RESULTS, JSON.stringify(rows, null, 2));
}

interface Score {
  wrongLoads: number;
  coveredTotal: number;
  needlessLoads: number;
  uncoveredTotal: number;
  exact: number;
}

function score(rows: Row[], pick: (r: Row) => string | null | undefined): Score {
  let wrongLoads = 0;
  let coveredTotal = 0;
  let needlessLoads = 0;
  let uncoveredTotal = 0;
  let exact = 0;
  for (const r of rows) {
    const got = pick(r);
    if (got === undefined) continue;
    if (r.expect === null) {
      uncoveredTotal += 1;
      if (got !== null) needlessLoads += 1;
      else exact += 1;
    } else {
      coveredTotal += 1;
      if (got !== r.expect) wrongLoads += 1;
      else exact += 1;
    }
  }
  return { wrongLoads, coveredTotal, needlessLoads, uncoveredTotal, exact };
}

function pct(n: number, d: number): string {
  return d === 0 ? "   -  " : `${((n / d) * 100).toFixed(1)}%`.padStart(6);
}

function report(rows: Row[]): void {
  const arms: [string, (r: Row) => string | null | undefined][] = [
    ["agent alone", (r) => r.agent],
    ["+ suggestion", (r) => r.assisted],
    ["oracle", (r) => r.oracle],
  ];
  console.log("");
  console.log(`  ${"arm".padEnd(14)} ${"wrong loads".padStart(12)} ${"needless loads".padStart(15)} ${"exact".padStart(10)}`);
  for (const [label, pick] of arms) {
    const s = score(rows, pick);
    if (s.coveredTotal + s.uncoveredTotal === 0) continue;
    console.log(
      `  ${label.padEnd(14)} ${pct(s.wrongLoads, s.coveredTotal)} (${s.wrongLoads}/${s.coveredTotal})`.padEnd(45) +
        `${pct(s.needlessLoads, s.uncoveredTotal)} (${s.needlessLoads}/${s.uncoveredTotal})`.padEnd(20) +
        `${s.exact}/${s.coveredTotal + s.uncoveredTotal}`,
    );
  }

  // What the pipeline alone would do, before the agent sees it.
  const withSug = rows.filter((r) => r.suggested !== undefined);
  if (withSug.length > 0) {
    const s = score(withSug, (r) => r.suggested);
    console.log("");
    console.log(
      `  the suggestion on its own: wrong ${pct(s.wrongLoads, s.coveredTotal)} (${s.wrongLoads}/${s.coveredTotal})` +
        `   needless ${pct(s.needlessLoads, s.uncoveredTotal)} (${s.needlessLoads}/${s.uncoveredTotal})`,
    );
    const gate = withSug.filter((r) => r.suggestedTrace?.stoppedAt === "gate").length;
    const fits = withSug.filter((r) => r.suggestedTrace?.stoppedAt === "fits").length;
    console.log(`  stopped by the gate: ${gate}   stopped by the fits check: ${fits}`);
    // Stage 1 recall bounds what stage 2 can do.
    const covered = withSug.filter((r) => r.expect !== null && r.suggestedTrace);
    const inShortlist = covered.filter((r) => r.suggestedTrace!.shortlist.includes(r.expect!)).length;
    const top1 = covered.filter((r) => r.suggestedTrace!.ranked[0]?.name === r.expect).length;
    console.log(
      `  stage 1: right skill ranked first ${top1}/${covered.length}, in the top 3 ${inShortlist}/${covered.length}`,
    );
  }

  // Where the suggestion changed the agent's mind, for better or worse.
  const both = rows.filter((r) => r.agent !== undefined && r.assisted !== undefined);
  const fixed = both.filter((r) => r.agent !== r.expect && r.assisted === r.expect);
  const broke = both.filter((r) => r.agent === r.expect && r.assisted !== r.expect);
  console.log("");
  console.log(`  the suggestion fixed ${fixed.length} and broke ${broke.length} of ${both.length}`);
  for (const r of broke.slice(0, 8)) {
    console.log(
      `    broke: want ${String(r.expect).padEnd(30)} agent had it, then took ${String(r.assisted)}` +
        ` (suggested ${String(r.suggested)})`,
    );
  }
}

async function main() {
  const roster = JSON.parse(readFileSync("out/roster.json", "utf8")) as SkillEntry[];
  const dataset = (JSON.parse(readFileSync("out/dataset.json", "utf8")) as Case[]).slice(0, LIMIT);
  console.log("=".repeat(100));
  console.log(`  SKILL SUGGESTION — ${roster.length} skills, ${dataset.length} requests, agent ${AGENT_MODEL}`);
  console.log(`  reproducing https://docs.typesafe.ai/cookbooks/skill_suggestion over mizchi/skills`);
  console.log("=".repeat(100));

  const prior = new Map(load().map((r) => [r.request, r]));
  const rows: Row[] = dataset.map((c) => prior.get(c.request) ?? { request: c.request, expect: c.expect });
  const jev = ARMS.includes("suggestion") ? new Jev() : (null as unknown as Jev);

  const cached = rows.filter((r) => r.agent !== undefined).length;
  if (cached > 0) console.log(`  ${cached} of ${rows.length} cases already cached`);

  /** Everything one case needs, so cases can be run side by side. */
  async function processCase(r: Row, index: number): Promise<void> {
    if (ARMS.includes("agent") && r.agent === undefined) {
      const d = await decide(roster, r.request, AGENT_MODEL);
      r.agent = d.loaded;
      r.agentMs = d.ms;
      r.agentInvalid = d.invalid;
    }
    if (ARMS.includes("suggestion") && r.assisted === undefined) {
      if (r.suggested === undefined) {
        try {
          const s = await suggest(jev, roster, r.request);
          r.suggested = s.names[0] ?? null;
          r.suggestedTrace = s.trace;
        } catch (err) {
          console.warn(`\n  suggest failed on case ${index}: ${String(err).slice(0, 140)}`);
        }
      }
      if (r.suggested !== undefined) {
        const d = await decide(roster, r.request, AGENT_MODEL, suggestionBlock(r.suggested ? [r.suggested] : []));
        r.assisted = d.loaded;
        r.assistedMs = d.ms;
      }
    }
    if (ARMS.includes("oracle") && r.oracle === undefined) {
      const d = await decide(roster, r.request, AGENT_MODEL, suggestionBlock(r.expect ? [r.expect] : []));
      r.oracle = d.loaded;
    }
    process.stdout.write(".");
  }

  // A plain worker pool. Every arm is a network round trip, so doing the cases
  // one after another left the machine idle for most of an hour. Saving after
  // each case is safe: JS runs one writer at a time.
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= rows.length) return;
      try {
        await processCase(rows[i], i);
      } catch (err) {
        console.warn(`\n  case ${i} failed: ${String(err).slice(0, 140)}`);
      }
      save(rows);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
  console.log("");
  report(rows);
  if (jev) {
    console.log("");
    console.log(
      `  jev: ${jev.calls} requests, ${jev.inputTokens} input tokens, ` +
        `$${((jev.inputTokens / 1e6) * 0.042).toFixed(4)}, ` +
        `${(jev.totalMs / Math.max(jev.calls, 1)).toFixed(0)} ms/request` +
        (jev.retriedCalls ? `, ${jev.retriedCalls} retried` : ""),
    );
  }
  const agentMs = rows.filter((r) => r.agentMs).map((r) => r.agentMs!);
  if (agentMs.length) {
    console.log(
      `  agent: ${(agentMs.reduce((a, b) => a + b, 0) / agentMs.length / 1000).toFixed(1)} s/turn`,
    );
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
