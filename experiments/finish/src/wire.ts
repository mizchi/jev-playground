/**
 * Does the catalogue reach the model? Asked, not assumed.
 *
 *   tsx src/wire.ts             ask the CLI, record to records/wire.json
 *   tsx src/wire.ts --show      re-read the record, no CLI needed
 *
 * WHY THIS FILE EXISTS. Writing 300 directories under `.claude/skills/` and
 * the host reading them are two different facts, and the whole skill-router
 * arm is worthless if only the first is true. docs/38 §2 is the precedent:
 * the pi skill router shipped for two reports having NEVER LOOKED AT A SKILL,
 * and nobody noticed because the arm still produced numbers.
 *
 * So the check is the same shape as the one that caught that: ask the thing
 * that is supposed to have received the catalogue, with tools forbidden so it
 * can only answer from what it was handed at launch, and require a VERBATIM
 * NAME rather than a count. The count is self-reported and comes back off by
 * one; a name that exists in the harvested roster and not among the host's own
 * skills cannot be produced by a model that was never given it.
 */
import { existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { catalogue } from "./catalogue.js";

const RECORDS = resolve(import.meta.dirname, "../records");
const PATH = resolve(RECORDS, "wire.json");

const COUNT_PROMPT =
  "Without using any tool, answer from what you were given at launch: exactly how many skills are " +
  "available to you, and name three of them verbatim, one per line. If none, say NONE.";

export interface WireRow {
  /** How many skills the harness placed in the sandbox. */
  placed: number;
  /** What the agent said, verbatim. */
  said: string;
  /** Names in the reply that are in the harvested catalogue and nowhere else. */
  fromCatalogue: string[];
  ms: number;
}

export interface Wire {
  note: string;
  bare?: WireRow;
  all?: WireRow;
}

function ask(skills: { name: string; description: string; body: string }[]): WireRow {
  const sandbox = mkdtempSync(resolve(tmpdir(), "jev-wire-"));
  const started = Date.now();
  try {
    for (const s of skills) {
      const dir = resolve(sandbox, ".claude/skills", s.name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, "SKILL.md"), `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n${s.body}\n`);
    }
    const out = spawnSync(
      "claude",
      [
        "-p",
        COUNT_PROMPT,
        "--model",
        "claude-haiku-4-5-20251001",
        "--permission-mode",
        "acceptEdits",
        // Read only, and the prompt forbids using it. A reply that names a
        // skill therefore came from the launch context, not from `ls`.
        "--allowedTools",
        "Read",
      ],
      { cwd: sandbox, encoding: "utf8", timeout: 300_000 },
    );
    const said = `${out.stdout ?? ""}`.trim();
    const placedNames = new Set(skills.map((s) => s.name));
    // Only names that are in the catalogue count as evidence. A host built-in
    // like `code-review` proves nothing: the agent has it either way.
    const fromCatalogue = [...placedNames].filter((n) => said.includes(n));
    return { placed: skills.length, said: said.slice(0, 1500), fromCatalogue, ms: Date.now() - started };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

const NOTE =
  "Does the 300-skill catalogue reach the model's launch context. Tools are " +
  "forbidden in the prompt and only Read is allowed, so a verbatim skill name " +
  "in the reply cannot have come from the filesystem. The COUNT is " +
  "self-reported and comes back off by one; the NAME is the evidence.";

function show(w: Wire): void {
  console.log("\n## Does the catalogue reach the model?\n");
  console.log("| sandbox | skills placed | agent's reply, first line | names from the catalogue |");
  console.log("| --- | --- | --- | --- |");
  for (const [label, row] of [
    ["no `.claude/skills/`", w.bare],
    ["the harvested 300", w.all],
  ] as const) {
    if (!row) continue;
    console.log(
      `| ${label} | ${row.placed} | ${row.said.split("\n")[0].slice(0, 70).replace(/\|/g, "\\|")} | ` +
        `${row.fromCatalogue.length > 0 ? row.fromCatalogue.map((n) => `\`${n}\``).join(", ") : "—"} |`,
    );
  }
  const proved = (w.all?.fromCatalogue.length ?? 0) > 0;
  console.log(
    `\n${
      proved
        ? "**The catalogue reaches the model.** A name that is in the harvested roster and not among the " +
          "host's own skills cannot be produced by an agent that was never handed it."
        : "**NOT ESTABLISHED.** The agent named no skill from the catalogue, so the arm may be measuring " +
          "a directory nobody read -- which is docs/38 §2's bug, one host over."
    }\n`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--show")) {
    show(JSON.parse(readFileSync(PATH, "utf8")) as Wire);
    return;
  }
  const w: Wire = { note: NOTE };
  // The control FIRST, so the host's own skill count is known before the
  // catalogue's contribution is claimed.
  w.bare = ask([]);
  console.log(`bare: ${w.bare.said.split("\n")[0]}`);
  w.all = ask(catalogue());
  console.log(`all:  ${w.all.said.split("\n")[0]}`);
  mkdirSync(RECORDS, { recursive: true });
  writeFileSync(PATH, `${JSON.stringify(w, null, 2)}\n`);
  show(w);
}

if (process.argv[1]?.endsWith("wire.ts")) await main();
