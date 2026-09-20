/**
 * Rebuild `corpus/roster.json` from local clones.
 *
 *   npx tsx src/collect.ts /home/user
 *
 * Run only when a source repo has changed. The committed roster is what the
 * report and the CLI read, so both work without the clones.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SOURCES, collect, tokensOf } from "./roster.js";

const clones = process.argv[2];
if (!clones) {
  console.error("usage: tsx src/collect.ts <directory holding owner/repo clones>");
  console.error(`sources: ${SOURCES.map((s) => s.repo).join(", ")}`);
  process.exit(2);
}
const revOf = (repo: string): string => {
  try {
    return execFileSync("git", ["-C", resolve(clones, repo), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const roster = collect(clones, revOf);
const out = resolve(import.meta.dirname, "../corpus/roster.json");
writeFileSync(out, `${JSON.stringify(roster, null, 2)}\n`);

const bySource = new Map<string, number>();
for (const e of roster.entries) bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1);
for (const s of SOURCES) {
  const n = bySource.get(s.repo) ?? 0;
  console.log(`  ${String(n).padStart(4)}  ${s.repo}${n === 0 ? "  (not cloned)" : ` @ ${roster.revs[s.repo]?.slice(0, 8)}`}`);
}
console.log(`  ${roster.entries.length} entries, about ${tokensOf(roster.entries)} tokens of name + description`);
console.log(`-> ${out}`);
