/**
 * Rebuild `corpus/skills.json` from local clones of the catalog's source repos.
 *
 *   npx tsx src/extract.ts /home/user      # holds owner/repo clones
 *
 * Run only when the catalog upstream has changed. The committed snapshot is
 * what the report reads, so that `npm run demo` works with neither the clones
 * nor an API key.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { extract } from "./catalog.js";

const clones = process.argv[2];
if (!clones) {
  console.error("usage: tsx src/extract.ts <directory holding owner/repo clones>");
  process.exit(2);
}
const revOf = (repo: string): string => {
  try {
    return execFileSync("git", ["-C", resolve(clones, repo), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const snapshot = extract(clones, revOf);
const out = resolve(import.meta.dirname, "../corpus/skills.json");
writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`);

const withDesc = snapshot.rows.filter((r) => r.description).length;
const sections = new Set(snapshot.rows.map((r) => r.section));
const signalled = new Set(snapshot.rows.filter((r) => r.signals).map((r) => r.section));
console.log(`${snapshot.rows.length} rows, ${sections.size} sections (${signalled.size} with declared signals)`);
console.log(`${withDesc} rows have a readable SKILL.md description, ${snapshot.unresolved.length} do not`);
for (const [repo, rev] of Object.entries(snapshot.revs)) console.log(`  ${repo} @ ${rev.slice(0, 8)}`);
console.log(`-> ${out}`);
