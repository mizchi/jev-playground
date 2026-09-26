/**
 * Render every generation prompt this study sends, verbatim, to disk, so the
 * generation step is a file-in, file-out job anyone (or any model) can redo.
 *
 *   data/prompts/brief/<id>.txt     BRIEF_PROMPT with the human post (gitignored:
 *                                   it contains the post)
 *   data/prompts/mirror/<id>.txt    SYSTEM_PROMPT + the writer prompt, built from
 *                                   the brief ALONE (committed)
 *   data/prompts/reword/<id>.txt    the LAMP rewording prompt with the mirror
 *                                   (gitignored: the LAMP text is the release's,
 *                                   and the release's prompts/ are all rights reserved)
 *
 * Every template is read from the pinned release, never retyped here.
 * Also writes records/corpus.json (ids, companies, lengths; no text), which
 * is all src/eval.ts needs besides the Jev records.
 *
 *   npx tsx src/prompts.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { DATA, RECORDS, REL, buildIndex, humans, pythonConstant, pythonString } from "./corpus.js";

const BRIEF = pythonConstant("study_b/extract_briefs.py", "BRIEF_PROMPT");
const MIRROR_SYSTEM = pythonString("study_b/generate_mirrors.py", "SYSTEM_PROMPT");
const REWORD_SYSTEM = pythonString("code/r7_lamp_rewrite.py", "SYSTEM_PROMPT");
const LAMP = readFileSync(resolve(REL, "prompts/lamp_rewrite.md"), "utf8").split("-->", 2)[1].trim();

export interface Brief {
  doc_id: string;
  prompt: string;
  target_words: number;
}

/** The release strips em/en dashes from briefs (normalize_brief, fix 2). */
export function cleanBrief(s: string): string {
  return s.replace(/[—–]/g, " - ").trim();
}

/** generate_mirrors.build_prompt: one paragraph plus the word-count sentence. */
export function mirrorPrompt(b: Brief): string {
  return `${b.prompt.trim()}\n\nYour article must be approximately ${b.target_words} words long.\nWrite only the article, beginning with a title line.`;
}

function write(kind: string, id: string, body: string): void {
  mkdirSync(resolve(DATA, "prompts", kind), { recursive: true });
  writeFileSync(resolve(DATA, "prompts", kind, `${id}.txt`), body);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let n = { brief: 0, mirror: 0, reword: 0 };
  for (const h of humans()) {
    // Function replacements: a string replacement expands `$'`, `$&`, `` $` `` inside
    // the post ("$5 per seat" stays, but "$'" pastes the rest of the template).
    write("brief", h.doc_id, BRIEF.replace("{title}", () => h.title).replace("{text}", () => h.text));
    n.brief += 1;
    const briefPath = resolve(DATA, "briefs", `${h.doc_id}.txt`);
    if (existsSync(briefPath)) {
      const b: Brief = {
        doc_id: h.doc_id,
        prompt: cleanBrief(readFileSync(briefPath, "utf8")),
        // extract_briefs.py: round(words / 100) * 100, floor 100
        target_words: Math.round(h.manifest_words / 100) * 100 || 100,
      };
      write("mirror", h.doc_id, `[system]\n${MIRROR_SYSTEM}\n\n[user]\n${mirrorPrompt(b)}\n`);
      n.mirror += 1;
    }
    const mirrorPath = resolve(DATA, "mirrors", `${h.doc_id}.md`);
    if (existsSync(mirrorPath)) {
      write("reword", h.doc_id, `[system]\n${REWORD_SYSTEM}\n\n[user]\n${LAMP.replace("{POST}", () => readFileSync(mirrorPath, "utf8").trim())}\n`);
      n.reword += 1;
    }
  }
  writeFileSync(resolve(RECORDS, "corpus.json"), `${JSON.stringify(buildIndex(), null, 1)}\n`);
  console.log(n, "+ records/corpus.json");
}
