#!/usr/bin/env node
/**
 * Check every relative Markdown link in `docs/` and the repo's README files.
 *
 *   node tools/check-links.mjs
 *
 * Exists because this has gone wrong twice. Anchors for Japanese headings are
 * generated, not written, and the generation drops characters you would not
 * expect: `§2 in-sample の誤検出 0 は情報がない` keeps the Japanese and the
 * digits but loses the `§`, and a heading that itself contains a Markdown
 * link loses the brackets and the URL. docs/28 shipped with four links that
 * pointed at nothing and nobody noticed until they were clicked.
 *
 * The anchor rule implemented here is GitHub's: lowercase, drop everything
 * that is not a letter, a digit, `-`, `_` or a space, then map each space to
 * one hyphen. Repeated headings get `-1`, `-2` and so on.
 *
 * The rule that matters and is easy to get wrong: spaces are NOT collapsed.
 * `## 3. severity — 算術が完勝する` loses the em dash and keeps the two
 * spaces around it, so its anchor holds a DOUBLE hyphen. Collapsing them
 * called 100 working links broken on the first run of this file.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * GitHub's heading -> anchor transform.
 *
 * Lowercase, strip the inline markup, drop every character that is not a
 * letter, a digit, `-`, `_` or a space, then map EACH space to one hyphen.
 */
export function anchorOf(heading) {
  return heading
    .trim()
    .toLowerCase()
    // A heading may contain inline code, emphasis or a link; the anchor is
    // built from the rendered TEXT, so strip the markup first.
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1")
    .replace(/<a id="([^"]*)"><\/a>/g, "")
    .replace(/[^\p{L}\p{N}\-_ ]/gu, "")
    // One hyphen per space, NOT one per run: GitHub does not collapse them,
    // so "3. severity -- 算術" (the em dash removed, its spaces kept) becomes
    // `3-severity--算術`. Collapsing here reported 100 good links as broken.
    .replace(/ /g, "-");
}

/** Every anchor a file offers: its headings, plus explicit `<a id=...>`. */
export function anchorsOf(markdown) {
  const out = new Set();
  const seen = new Map();
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    for (const m of line.matchAll(/<a id="([^"]*)"><\/a>/g)) out.add(m[1]);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (!heading) continue;
    const base = anchorOf(heading[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** Relative links, outside fences, with their line numbers. */
function linksOf(markdown) {
  const out = [];
  let fenced = false;
  markdown.split("\n").forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:)/.test(target)) continue;
      out.push({ target, line: i + 1 });
    }
  });
  return out;
}

function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "_build") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...markdownFiles(path));
    else if (entry.endsWith(".md")) out.push(path);
  }
  return out;
}

const files = markdownFiles(ROOT);
const anchorCache = new Map();
const anchorsFor = (path) => {
  if (!anchorCache.has(path)) {
    try {
      anchorCache.set(path, anchorsOf(readFileSync(path, "utf8")));
    } catch {
      anchorCache.set(path, null);
    }
  }
  return anchorCache.get(path);
};

let broken = 0;
let checked = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const { target, line } of linksOf(text)) {
    checked += 1;
    const [pathPart, anchor] = target.split("#");
    const resolved = pathPart === "" ? file : resolve(dirname(file), pathPart);
    const anchors = anchorsFor(resolved);
    const where = `${relative(ROOT, file)}:${line}`;
    if (anchors === null) {
      // Not Markdown, or missing. A non-Markdown target only has to exist.
      try {
        statSync(resolved);
        continue;
      } catch {
        console.log(`  ${where}  no such file: ${target}`);
        broken += 1;
        continue;
      }
    }
    if (anchor && !anchors.has(decodeURIComponent(anchor))) {
      console.log(`  ${where}  no such anchor: ${target}`);
      broken += 1;
    }
  }
}

console.log(`  ${checked} relative link(s) in ${files.length} file(s), ${broken} broken`);
process.exit(broken === 0 ? 0 : 1);
