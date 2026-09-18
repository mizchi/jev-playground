#!/usr/bin/env node
/**
 * Every `docs/NN-*.md#anchor` link has to point at a heading that exists.
 *
 * These reports cross-reference each other constantly, and a section that
 * gets renamed takes every link to it down silently — GitHub serves the
 * page and drops you at the top, so the only way to notice is to click.
 * One of these was shipped in this repo: docs/05 gained a note citing a
 * "`step.url` does not move with the hash" section of itself that had
 * never existed, because the fact only ever lived in a code comment.
 *
 * Two things this has to know, and without either it reports dozens of
 * false alarms rather than staying quiet — which is the better failure
 * direction, but still has to be fixed before the silence means anything:
 *
 * - `00-api-notes.md` labels its sections with explicit
 *   `<a id="...">` anchors rather than relying on the heading slug.
 * - A heading can contain a markdown link, and only its *text* is part of
 *   the slug: `## A. ... → [07](07-escalation.md)` slugs without the URL.
 *
 * No dependencies, no network. `just check-doc-anchors`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DOCS = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");

/**
 * GitHub's heading slug: lower-case, drop everything that is not a letter,
 * a number, a space, a hyphen or an underscore, then spaces to hyphens.
 * Japanese survives, which is why the anchors in these docs look the way
 * they do.
 */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} \-_]/gu, "")
    .replace(/ /g, "-");
}

/** Every anchor a file offers: heading slugs plus explicit `<a id>`s. */
function anchorsOf(text) {
  const out = new Set();
  for (const m of text.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) out.add(m[1]);
  for (const line of text.split("\n")) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    const heading = m[1]
      .replace(/<a\s+[^>]*>|<\/a>/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    out.add(slug(heading));
  }
  return out;
}

const cache = new Map();
function anchorsFor(file) {
  if (!cache.has(file)) {
    try {
      cache.set(file, anchorsOf(readFileSync(join(DOCS, file), "utf8")));
    } catch {
      cache.set(file, null); // missing file
    }
  }
  return cache.get(file);
}

let checked = 0;
const broken = [];
for (const md of readdirSync(DOCS).filter((f) => f.endsWith(".md")).sort()) {
  const text = readFileSync(join(DOCS, md), "utf8");
  // Only intra-docs links carrying an anchor. A bare `](12-comeback.md)`
  // cannot rot the same way, and external URLs are not ours to verify.
  for (const m of text.matchAll(/\]\((\d[\w.-]*\.md)#([^)]+)\)/g)) {
    const [, target, anchor] = m;
    checked += 1;
    const anchors = anchorsFor(target);
    if (anchors === null) broken.push(`${md} -> ${target} (no such file)`);
    else if (!anchors.has(anchor)) broken.push(`${md} -> ${target}#${anchor}`);
  }
}

for (const b of broken) console.error(`  broken  ${b}`);
console.log(
  `  ${checked} anchored links across docs/, ${broken.length} broken`,
);
process.exit(broken.length === 0 ? 0 : 1);
