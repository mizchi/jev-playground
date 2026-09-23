#!/usr/bin/env node
/**
 * Every link in the repository's markdown resolves. No network, no key.
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
 *
 * AND THE THIRD MISTAKE WAS SCOPE. It read `docs/` only, so `pi/README.md`,
 * the package READMEs and the root `README.md` -- 276 links -- were never
 * checked at all. A blind spot reports zero broken links for exactly the same
 * reason a working one does. Adding them found nothing broken, which is the
 * outcome that makes the widening free rather than the one that makes it
 * unnecessary.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
/** Not ours to check: dependencies, build output, and package caches. */
const SKIP = new Set(["node_modules", ".git", "_build", ".mooncakes", ".openseek", "out"]);

/**
 * GitHub's heading slug: lowercase, drop punctuation and symbols, spaces to
 * hyphens.
 *
 * `_` IS KEPT, and that is the second time this rule has been wrong in the
 * same direction. The docblock above records the first: the CJK range was
 * kept too eagerly, so `、` survived and working anchors were reported broken.
 * This one dropped the underscore, so `## 6. \`browser_find\` を…` slugged to
 * `6-browserfind-…` while GitHub produces `6-browser_find-…` -- and docs/62's
 * own §6 link plus docs/README.md's link to it were reported broken **when
 * both were correct**.
 *
 * BOTH OF THIS FILE'S BUGS WERE ALREADY SOLVED NEXT DOOR.
 * `scripts/check-doc-anchors.mjs` keeps `_` in its character class and blanks
 * code spans, and its docblock names the code-span case explicitly ("link
 * syntax inside a code span or a fenced block is documentation, not a link").
 * This script was written to widen that one's job past `docs/`, and it
 * reimplemented the rules instead of reusing them -- so it shipped without two
 * corrections its sibling had already made, and reported three correct links
 * as broken. Two checkers with divergent slug rules is the actual defect here;
 * they agree again now, and a test pins the cases.
 *
 * github-slugger strips `!`-`,`, `.`, `/`, `:`-`@`, `[`-`^`, a backtick and
 * `{`-`~`. `_` is 0x5F, one past `^` (0x5E) and one before the backtick
 * (0x60), so it falls in none of those ranges and survives.
 *
 * A checker that reports a correct anchor as broken is worse than no checker:
 * the fix everybody reaches for is editing the link to match the tool, which
 * breaks the link on GitHub while turning the report green.
 */
function slug(heading) {
  const text = heading.trim().replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").toLowerCase();
  let out = "";
  for (const ch of text) {
    if (ch === " ") out += "-";
    else if (ch === "-" || ch === "_" || /\p{L}|\p{N}|\p{M}/u.test(ch)) out += ch;
    // everything else is dropped WITHOUT a hyphen, which is the case that
    // caught me: `では、gate` becomes `ではgate`, not `では-gate`.
  }
  return out;
}

/**
 * Blank out inline code spans, so prose ABOUT a link is not read as one.
 *
 * `findings.md` documents this very script with the sentence "同一ファイル内の
 * `](#…)` を一切検査していなかった" -- a link-shaped string inside backticks,
 * describing the bug this checker was written to fix. The checker then parsed
 * its own example and reported `#…` as a broken anchor.
 *
 * Replaced with spaces of the same length rather than removed, so nothing
 * downstream shifts and a code span can never glue its neighbours into a new
 * false match.
 */
function withoutCodeSpans(source) {
  return source.replace(/`+[^`\n]*`+/g, (run) => " ".repeat(run.length));
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

/** Every markdown file in the repository, by absolute path. */
function markdown(dir, depth = 0) {
  if (depth > 4) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const p = join(dir, entry);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...markdown(p, depth + 1));
    else if (entry.endsWith(".md")) out.push(p);
  }
  return out;
}

const files = markdown(REPO).sort();
// Keyed by absolute path, because the links now come from several directories
// and `docs/44-components.md` is not a unique name once `pi/README.md` and
// `packages/jev-guard/README.md` are in the set too.
const anchors = new Map(files.map((f) => [f, anchorsOf(readFileSync(f, "utf8"))]));

let broken = 0;
let checked = 0;
for (const file of files) {
  // Code spans blanked: a link inside backticks is prose about a link.
  const source = withoutCodeSpans(readFileSync(file, "utf8"));
  const here = dirname(file);
  const name = relative(REPO, file);
  // A LINK THIS FILE CANNOT SEE IS WORSE THAN A LINK IT GETS WRONG.
  //
  // The scan below stops a target at whitespace (`[^)#\s]*`), so
  // `](#a b)` never matches and is skipped in silence -- counted as nothing,
  // reported as nothing. `check-doc-anchors.mjs` uses `[^)]+` and catches it.
  // docs/64 shipped with exactly that: a space where a hyphen belonged in its
  // own section link, reported by the sibling and invisible here. That is the
  // same divergence between these two scripts as the underscore in `slug()`,
  // in the other direction.
  //
  // A markdown destination containing a space is not a link at all unless it
  // is bracketed, so the text renders literally and the reader gets no
  // navigation -- which is why this counts as broken rather than as a warning.
  // At the time it was added the repository had no such target and no link
  // titles (`](x "T")` would look the same), so it starts at zero and can only
  // catch what arrives later.
  for (const m of source.matchAll(/\]\((?!https?:|mailto:)([^)]*\s[^)]*)\)/g)) {
    console.log(`  MALFORMED     ${name} -> (${m[1]}) -- whitespace in a link target`);
    broken += 1;
  }
  for (const m of source.matchAll(/\]\((?!https?:|mailto:)([^)#\s]*)(#[^)\s]*)?\)/g)) {
    const [, target, hash] = m;
    checked += 1;
    const path = target ? normalize(join(here, target)) : file;
    if (target && !existsSync(path)) {
      console.log(`  BROKEN FILE   ${name} -> ${target}`);
      broken += 1;
      continue;
    }
    if (!hash) continue;
    // A link into a file that is not markdown is checked for existence above;
    // its anchors are out of scope.
    if (!anchors.has(path)) continue;
    if (!anchors.get(path).has(hash.slice(1))) {
      console.log(`  BROKEN ANCHOR ${name} -> ${target}${hash}`);
      broken += 1;
    }
  }
}

console.log(`\n  ${checked} links checked in ${files.length} files, ${broken} broken`);
process.exit(broken === 0 ? 0 : 1);
