#!/usr/bin/env -S npx tsx
/**
 * The standalone skill router. No Pi, no agent, no host.
 *
 *   jev-skill-router --catalogue skills.json "extract the tables from this PDF"
 *   jev-skill-router --dir ~/.claude/skills "set up a Cloudflare worker"
 *   jev-skill-router --dir ~/.claude/skills --dry-run "..."   # prefilter only, no request
 *
 * `--dry-run` is the free half of the router: the catalogue split and the
 * lexical prefilter, with the shortlist it would have asked about. It costs
 * nothing and it is what to look at first when the router picks badly --
 * docs/30 §3 measured the prefilter's recall ceiling at 85%, so a skill
 * missing from the dry run was never judged at all.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DEFAULT_SKILL_CONFIG, keepTop, prescore, route, split, type Skill } from "./route.js";

/**
 * Read a directory of `<name>/SKILL.md` files.
 *
 * The description comes from YAML front matter when present and from the
 * first non-heading line otherwise, which is what the real catalogues in
 * docs/29 looked like: of 74 skills across nine repositories, the front
 * matter was there most of the time and not always.
 */
/** `<dir>/foo/SKILL.md` names the skill `foo`; `<dir>/foo.md` names it `foo`. */
function nameFromPath(file: string): string {
  const parts = file.split(/[\\/]/);
  const base = parts[parts.length - 1];
  return base === "SKILL.md" ? (parts[parts.length - 2] ?? base) : basename(base, ".md");
}

function fromDir(dir: string): Skill[] {
  const out: Skill[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    throw new Error(`cannot read ${dir}: ${String(err)}`);
  }
  // `<name>/SKILL.md` first, and FLAT `*.md` only when that found nothing.
  // Not both: a real catalogue directory also holds a README.md and often a
  // CLAUDE.md, and reading those as skills put "CLAUDE" and "README" into
  // every request against mizchi/skills -- two entries of pure noise in the
  // shortlist, and two questions paid for.
  const nested: string[] = [];
  const flat: string[] = [];
  for (const entry of entries) {
    const sub = join(dir, entry);
    try {
      if (statSync(sub).isDirectory()) {
        const candidate = join(sub, "SKILL.md");
        if (statSync(candidate).isFile()) nested.push(candidate);
      } else if (entry.endsWith(".md") && entry !== "README.md" && entry !== "CLAUDE.md" && entry !== "AGENTS.md") {
        flat.push(sub);
      }
    } catch {
      /* unreadable entry, or a directory with no SKILL.md */
    }
  }
  for (const file of nested.length > 0 ? nested : flat) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const field = (key: string): string | undefined => {
      if (!front) return undefined;
      const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(front[1]);
      return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
    };
    const body = text.replace(/^---[\s\S]*?---\r?\n/, "");
    const firstLine = body.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() ?? "";
    out.push({
      name: field("name") ?? nameFromPath(file),
      description: field("description") ?? firstLine,
      path: file,
      invocable: field("disable-model-invocation") !== "true",
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): boolean => argv.includes(`--${name}`);
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const valueFlags = new Set(["catalogue", "dir", "shortlist", "max-load", "load-at"]);
  const words: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (valueFlags.has(a.slice(2))) i += 1;
      continue;
    }
    words.push(a);
  }
  const request = words.join(" ").trim();
  if (!request || flag("help")) {
    console.error('usage: jev-skill-router (--dir DIR | --catalogue FILE) [--dry-run] [--json] "the request"');
    process.exit(request ? 0 : 2);
  }

  const cataloguePath = opt("catalogue");
  const dir = opt("dir");
  if (!cataloguePath && !dir) {
    console.error("need --dir or --catalogue");
    process.exit(2);
  }
  const skills: Skill[] = cataloguePath
    ? (JSON.parse(readFileSync(cataloguePath, "utf8")) as Skill[])
    : fromDir(resolve(dir!));
  if (skills.length === 0) {
    console.error("the catalogue is empty");
    process.exit(2);
  }

  const config = {
    ...DEFAULT_SKILL_CONFIG,
    ...(opt("shortlist") ? { shortlist: Number(opt("shortlist")) } : {}),
    ...(opt("max-load") ? { maxLoad: Number(opt("max-load")) } : {}),
    ...(opt("load-at") ? { loadAt: Number(opt("load-at")) } : {}),
  };
  const ctx = { request };

  if (flag("dry-run")) {
    const parts = split(skills);
    const scores = prescore(parts.judge, ctx, config.prefilter);
    const shortlist = keepTop(parts.judge, scores, config.shortlist);
    const byName = new Map(scores.map((s) => [s.name, s]));
    console.log(
      `${skills.length} skills: ${parts.always.length} always, ${parts.never.length} never, ` +
        `${parts.blocked.length} not invocable, ${parts.judge.length} judgeable`,
    );
    console.log(`shortlist ${shortlist.length} of ${parts.judge.length} (prefilter ${config.prefilter}):`);
    for (const s of shortlist.slice(0, 20)) {
      const p = byName.get(s.name);
      console.log(`  ${(p?.score ?? 0).toFixed(2).padStart(6)}  ${s.name}  ${(p?.hits ?? []).join(" ")}`);
    }
    const cut = parts.judge.length - shortlist.length;
    if (cut > 0) console.log(`  (${cut} never reach a question -- docs/30 §3 put this stage's recall ceiling at 85%)`);
    return;
  }

  const decision = await route(ctx, skills, { config });
  if (flag("json")) {
    console.log(JSON.stringify(decision, null, 2));
    return;
  }
  console.log(`${decision.reason}${decision.error ? `  (${decision.error})` : ""}`);
  for (const p of decision.load) console.log(`  load  ${p.skill.name}  ${p.level.toFixed(2)}  ${p.why}`);
  for (const p of decision.considered.slice(0, 6)) console.log(`  skip  ${p.skill.name}  ${p.level.toFixed(2)}`);
  console.log(
    `  none-apply ${Number.isFinite(decision.noneApply) ? decision.noneApply.toFixed(2) : "n/a"} · ` +
      `${decision.ms} ms${decision.usage ? ` · ${decision.usage.input} input tokens` : ""}`,
  );
}

main().catch((err: unknown) => {
  console.error(String(err));
  process.exit(1);
});
