#!/usr/bin/env node
/**
 * Every link in docs/ resolves. No network, no key.
 *
 *   node scripts/check-doc-links.mjs
 *
 * WHY THIS IS A FILE AND NOT A ONE-LINER I RAN ONCE. Writing docs/50 and
 * docs/51 broke links three separate ways, and each one was invisible in the
 * rendered page:
 *
 *   a report cited `01-permission.md` and `44-lessons.md`, which are guesses at
 *   filenames -- the real ones are `01-shell-risk.md` and `44-components.md`;
 *   renaming a heading ("... 13 本" -> "... 14 本") silently orphaned the two
 *   anchors pointing at it, in a DIFFERENT file;
 *   docs/40 had carried a broken anchor for three uses and nobody noticed.
 *
 * AND THE CHECK ITSELF WAS WRONG TWICE, which is the more useful half. The
 * first version built GitHub's slug by keeping anything in the CJK range, so
 * it kept `、` (which GitHub strips) and reported working anchors as broken.
 * The second version only knew markdown headings, so it reported 55 broken
 * cross-file anchors that are all explicit `<a id="...">` -- a scary number
 * produced entirely by the instrument. Both times the docs were right.
 *
 * So the slug rule below is the one GitHub actually uses (drop punctuation and
 * symbols, keep letters/numbers/marks, space -> hyphen, lowercase), and both
 * anchor forms are collected.
 */
import { readFileSync, readdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const DOCS = resolve(import.meta.dirname, "..", "docs");

/** GitHub's heading slug: lowercase, drop punctuation and symbols, spaces to hyphens. */
function slug(heading) {
  const text = heading.trim().replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").toLowerCase();
  let out = "";
  for (const ch of text) {
    if (ch === " ") out += "-";
    else if (ch === "-" || /\p{L}|\p{N}|\p{M}/u.test(ch)) out += ch;
    // everything else is dropped WITHOUT a hyphen, which is the case that
    // caught me: `では、gate` becomes `ではgate`, not `では-gate`.
  }
  return out;
}

/** Both anchor forms a heading can define. */
function anchorsOf(source) {
  const found = new Set();
  // Explicit, which docs/00 and docs/06 use for stable English anchors.
  for (const m of source.matchAll(/<a\s+id="([^"]+)"\s*>/g)) found.add(m[1]);
  for (const m of source.matchAll(/^#{1,6}\s+(.*)$/gm)) {
    // A heading that opens with an explicit anchor still gets its slug from
    // the visible text, so strip the tag before slugging.
    found.add(slug(m[1].replace(/<a\s+id="[^"]+"\s*><\/a>/g, "")));
  }
  return found;
}

const files = readdirSync(DOCS).filter((f) => f.endsWith(".md"));
const anchors = new Map(files.map((f) => [f, anchorsOf(readFileSync(join(DOCS, f), "utf8"))]));

let broken = 0;
let checked = 0;
for (const file of files.sort()) {
  const source = readFileSync(join(DOCS, file), "utf8");
  for (const m of source.matchAll(/\]\((?!https?:|mailto:)([^)#\s]*)(#[^)\s]*)?\)/g)) {
    const [, target, hash] = m;
    checked += 1;
    const path = target ? normalize(join(DOCS, target)) : join(DOCS, file);
    if (target && !existsSync(path)) {
      console.log(`  BROKEN FILE   ${file} -> ${target}`);
      broken += 1;
      continue;
    }
    if (!hash) continue;
    const key = relative(DOCS, path);
    // A link into a non-doc file (../TODO.md, ../README.md) is checked for
    // existence above; its anchors are out of scope here.
    if (!anchors.has(key)) continue;
    if (!anchors.get(key).has(hash.slice(1))) {
      console.log(`  BROKEN ANCHOR ${file} -> ${target}${hash}`);
      broken += 1;
    }
  }
}

console.log(`\n  ${checked} links checked in ${files.length} files, ${broken} broken`);
process.exit(broken === 0 ? 0 : 1);
