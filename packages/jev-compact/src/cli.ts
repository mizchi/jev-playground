#!/usr/bin/env -S npx tsx
/**
 * Compaction, standalone.
 *
 *   jev-compact transcript.json --budget 40000              judgment
 *   jev-compact transcript.json --budget 40000 --baselines   free, no key
 *   jev-compact transcript.json --budget 40000 --compare     both, side by side
 *
 * `--baselines` needs no API key and is the first thing to run. docs/33 §1:
 * measure what the free features give you before paying for judgment. If
 * `largest` keeps the same entries Jev's ranking keeps, the ranking is not
 * what is doing the work.
 *
 * The transcript is `{ "entries": [ { id, role, text, calls?, answers?,
 * label? } ] }`, or a bare array of the same.
 */
import { readFileSync } from "node:fs";
import { compact, compactBy, tokensOf, totalTokens, type Baseline, type Entry } from "./compact.js";

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const opt = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
};

const BASELINES: Baseline[] = ["oldest", "largest", "stale"];

function load(path: string): Entry[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { entries?: Entry[] } | Entry[];
  const entries = Array.isArray(raw) ? raw : raw.entries;
  if (!entries || entries.length === 0) throw new Error(`${path} has no entries`);
  return entries;
}

/** What survived, as a set of ids, so two rankings can be compared by what
 *  they KEEP rather than by their scores -- which is the only comparison that
 *  says anything about the outcome. */
function kept(entries: readonly Entry[]): string {
  return [...entries.map((e) => e.id)].sort().join(",");
}

async function main(): Promise<void> {
  const path = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"));
  if (!path) {
    console.error("usage: jev-compact <transcript.json> [--budget N] [--baselines] [--compare]");
    process.exit(2);
  }
  const entries = load(path);
  const budgetTokens = Number.parseInt(opt("budget", "60000") as string, 10);
  const config = {
    budgetTokens,
    ...(opt("drop-at") ? { dropAt: Number.parseFloat(opt("drop-at") as string) } : {}),
    ...(opt("keep-recent") ? { keepRecent: Number.parseInt(opt("keep-recent") as string, 10) } : {}),
  };

  console.log(`${entries.length} entries, ${totalTokens(entries)} estimated tokens, budget ${budgetTokens}\n`);

  const rows: { name: string; result: Awaited<ReturnType<typeof compact>> }[] = [];
  if (flag("baselines") || flag("compare")) {
    for (const b of BASELINES) rows.push({ name: b, result: compactBy(b, entries, config) });
  }
  if (!flag("baselines")) {
    const goal = entries.find((e) => e.role === "user")?.text.slice(0, 2_000) ?? "(no stated goal)";
    rows.push({ name: "judgment", result: await compact(entries, { goal, cwd: process.cwd() }, { config }) });
  }

  console.log("  ranking     outcome        kept   dropped   tokens after   requests");
  for (const { name, result } of rows) {
    console.log(
      `  ${name.padEnd(10)} ${result.outcome.padEnd(13)} ${String(result.keep.length).padStart(5)}   ` +
        `${String(result.dropped.length).padStart(7)}   ${String(result.tokensAfter).padStart(12)}   ` +
        `${result.usage ? `${result.usage.input} tok` : "free"}`,
    );
    if (result.error) console.log(`    error: ${result.error}`);
  }

  if (flag("compare") && rows.length > 1) {
    // The comparison that matters: do two rankings keep the same entries?
    // Identical survivors mean the paid ranking bought nothing here.
    const judged = rows.find((r) => r.name === "judgment");
    if (judged) {
      console.log("");
      for (const { name, result } of rows) {
        if (name === "judgment") continue;
        const same = kept(result.keep) === kept(judged.result.keep);
        const overlap = result.keep.filter((e) => judged.result.keep.some((k) => k.id === e.id)).length;
        console.log(
          `  ${name.padEnd(10)} ${same ? "KEEPS EXACTLY WHAT JUDGMENT KEPT" : `${overlap} of ${judged.result.keep.length} survivors shared`}`,
        );
      }
    }
  }

  const judged = rows.find((r) => r.name === "judgment");
  if (judged && judged.result.ranked.length > 0 && flag("ranked")) {
    console.log("\n  weakest first:");
    for (const r of judged.result.ranked.slice(0, 20)) {
      console.log(
        `    ${r.level.toFixed(2)} (conf ${r.confidence.toFixed(2)})  ${String(tokensOf(r.entry)).padStart(6)} tok  ` +
          `${(r.entry.label ?? r.entry.role).padEnd(10)} ${r.entry.text.replace(/\s+/g, " ").slice(0, 60)}`,
      );
    }
  }
}

await main();
