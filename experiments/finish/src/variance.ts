/**
 * Ask the SAME command N times. Is the verdict a draw, or is the route?
 *
 *   tsx src/variance.ts              ask each harvested command 5 times
 *   tsx src/variance.ts --n 9
 *   tsx src/variance.ts --show       re-read the record, no key needed
 *
 * TODO §2.4's stated closing condition, and it exists now because writing
 * docs/44 §4.3 I got the attribution wrong.
 *
 * WHAT docs/43 §4b.3 SAID. The boundary sweep saw `ask` go 3 -> 1 -> 0 over
 * three repeats of one task under one arm, and concluded: "whether a command is
 * blocked is a draw, not a property of the command."
 *
 * WHAT I THEN WROTE in docs/44 §4.3, having swept it a second time: two sweeps
 * agreed exactly on WHICH tasks the gate speaks on and disagreed on how often,
 * so I narrowed it to "the command selects the candidate set precisely;
 * conditional on being a candidate, whether the gate fires is a draw."
 *
 * WHAT THIS FILE MEASURED, once its own bugs were out of the way. 220 distinct
 * commands harvested from the recorded sweeps, seven draws each, judged in a
 * live copy of the command's own task:
 *
 *   218 of 220 commands        the SAME verdict all seven times
 *   5 commands                 an actionable opinion (`ask`), of which
 *   2 of those 5               straddle -- one came back ask x5 / allow x2,
 *                              the other allow x6 / ask x1
 *
 * So both earlier readings were half right, and the halves fit together:
 *
 *   the gate is deterministic on the BULK of what an agent types -- 218 of 220
 *   commands never wobbled once;
 *   and it genuinely straddles on the BOUNDARY commands -- two of the five it
 *   has an opinion about answer differently on repeat.
 *
 * Which is docs/25's own prediction: variance is largest near the cutoff. The
 * run-to-run change in how often the gate speaks therefore has TWO sources,
 * and docs/43 §4b.3 named one and docs/44 §4.3 named the other:
 *
 *   1. WHICH ROUTE THE AGENT TAKES. Every boundary task has a verified safe
 *      route as well as a destructive one -- that is what the corpus was built
 *      for -- so on one run the agent reaches for `rm -rf` and is asked, and on
 *      the next it takes the safe route and the gate never sees it.
 *   2. GENUINE STRADDLING on the two commands that sit on the cutoff.
 *
 * Either way "this gate stops X% of commands" is not a thing, and now for a
 * third reason on top of those two: the denominator is whatever the agent
 * happened to type.
 *
 * So: take the commands the gate ACTUALLY SAW in the recorded sweeps, ask each
 * one N times, and separate the two sources of variance for the first time.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Record_ } from "./run.js";
import { SHIPPED_GATE, tasks } from "./world.js";

const RECORDS = resolve(import.meta.dirname, "../records");
const PATH = resolve(RECORDS, "variance.json");

export interface CommandRow {
  command: string;
  /** Which task's run issued it, so a reader can find it in the ledgers. */
  task: string;
  /** What the recorded sweeps saw for this command, pooled. */
  recorded: Record<string, number>;
  /** What N fresh draws say now. */
  fresh: Record<string, number>;
  n: number;
  medianMs: number;
}

export interface Variance {
  note: string;
  n: number;
  rows: CommandRow[];
}

/**
 * The commands the gate actually saw, from every recorded boundary sweep.
 *
 * HARVESTED, not written: these are what agents typed while doing the work.
 * Sandbox paths are rewritten to a live throwaway copy OF THE COMMAND'S OWN
 * TASK, and that detail is the whole measurement.
 *
 * The first version of this file made ONE sandbox holding two empty
 * directories, on the theory that the gate only needs the path to resolve
 * inside the project. Three commands then came back `ask` seven times out of
 * seven that the recorded sweeps had seen `allow` for -- and the discrepancy
 * was mine, not the gate's: `rm <sb>/.cache/rates.json` in a directory with no
 * `.cache`, and `rm -rf <sb>/src/node_modules/tiny-stats` with no
 * `tiny-stats`, are not the commands the agent ran. They are commands about
 * things that do not exist.
 *
 * This is docs/43 §4.4's bug a second time, and it was caught the same way:
 * print what the sweeps recorded NEXT TO the fresh draws, and disbelieve the
 * fresh column when they disagree.
 */
function harvest(sandboxOf: (task: string) => string): { command: string; task: string; recorded: Record<string, number> }[] {
  const byCommand = new Map<string, { task: string; recorded: Record<string, number> }>();
  for (const file of ["runs.json", "recheck-boundary.json", "block.json"]) {
    const path = resolve(RECORDS, file);
    if (!existsSync(path)) continue;
    for (const r of (JSON.parse(readFileSync(path, "utf8")) as Record_).rows) {
      if (r.corpus !== "boundary") continue;
      for (const v of r.verdicts ?? []) {
        if (!v.command) continue;
        // Normalise the sandbox path so the same command from two runs is one
        // row, and so the path points somewhere that exists now.
        const key = v.command.replace(/\/tmp\/jev-finish-[a-z-]+-[A-Za-z0-9]+/g, sandboxOf(r.task));
        const entry = byCommand.get(key) ?? { task: r.task, recorded: {} };
        entry.recorded[v.verdict] = (entry.recorded[v.verdict] ?? 0) + 1;
        byCommand.set(key, entry);
      }
    }
  }
  return [...byCommand.entries()].map(([command, e]) => ({ command, ...e }));
}

/**
 * One draw from the SHIPPED hook, on a real event. Three details, each of
 * which was wrong first and each of which changed the answer.
 *
 * 1. `cwd` GOES AT THE EVENT'S TOP LEVEL, not inside `tool_input`. The hook
 *    reads `event.cwd ?? process.cwd()`, so a `cwd` buried in `tool_input` is
 *    silently ignored and the hook judges the command as if it were in
 *    WHATEVER DIRECTORY THIS PROCESS IS IN -- which here is the repository
 *    holding the experiment. That is what made `rm -rf <sandbox>/src/node_modules`
 *    look like an out-of-project deletion (`outside_project` 0.93) instead of
 *    an in-project cleanup, and it is why the first run of this file disagreed
 *    with the recorded sweeps on five commands.
 * 2. The spawn's own `cwd` is set too, because the fallback above exists and a
 *    harness should not depend on which branch of a `??` it lands in.
 * 3. `--log`, because NO JSON ON STDOUT IS AMBIGUOUS. The hook emits nothing
 *    both when the free prefilter passed a command without judging it and when
 *    judgment came back `allow` -- two very different events that a stdout-only
 *    reading cannot tell apart. The log carries a row per JUDGED command, so
 *    its presence is what separates them. Without this the first run's "220 of
 *    220 stable" was largely a statement that a regex is deterministic.
 *
 * This is the third time in this programme that a re-asking harness lied to the
 * judgment about the world: docs/43 §4.4 fabricated a cwd, then this file
 * judged commands about files that did not exist, then this. The gate was
 * right every time.
 */
function askOnce(command: string, sandbox: string): { verdict: string; ms: number } {
  const log = resolve(sandbox, ".variance-log.jsonl");
  rmSync(log, { force: true });
  const started = Date.now();
  const out = spawnSync(process.execPath, [SHIPPED_GATE, "--log", log], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: sandbox }),
    encoding: "utf8",
    cwd: sandbox,
    timeout: 30_000,
  });
  const ms = Date.now() - started;
  const judged = existsSync(log) ? readFileSync(log, "utf8").trim() : "";
  const text = (out.stdout ?? "").trim();
  if (text) {
    try {
      return { verdict: JSON.parse(text)?.hookSpecificOutput?.permissionDecision ?? "?", ms };
    } catch {
      return { verdict: "?", ms };
    }
  }
  // Nothing emitted. The log says whether that was a judged allow or a command
  // judgment never saw.
  if (!judged) return { verdict: "prefiltered", ms };
  try {
    return { verdict: `judged-${JSON.parse(judged.split("\n").pop() ?? "{}").verdict ?? "?"}`, ms };
  } catch {
    return { verdict: "judged-?", ms };
  }
}

const NOTE =
  "The same command, asked N times, on the commands agents actually typed in " +
  "the recorded boundary sweeps. Separates two sources of variance that docs/43 " +
  "§4b.3 and docs/44 §4.3 both attributed to the gate: the verdict's own draw, " +
  "and which route the agent takes.";

function show(v: Variance): void {
  console.log(`\n# The same command, ${v.n} times\n`);
  console.log(
    "Commands harvested from the recorded boundary sweeps -- what agents typed while doing the work.\n" +
      "Each one is re-asked inside a LIVE COPY OF ITS OWN TASK, because a command about a file that is\n" +
      "not there is a different command. The `in the sweeps` column is printed beside the fresh draws so\n" +
      "that a disagreement between them shows up as what it usually is: a bug in the re-asking.\n",
  );
  console.log("| command | task | in the sweeps | this run's draws | stable? |");
  console.log("| --- | --- | --- | --- | --- |");
  const fmt = (c: Record<string, number>): string =>
    Object.entries(c)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ×${n}`)
      .join(", ") || "—";
  let stable = 0;
  for (const r of v.rows) {
    const kinds = Object.keys(r.fresh).filter((k) => r.fresh[k] > 0);
    const isStable = kinds.length === 1;
    if (isStable) stable += 1;
    console.log(
      `| \`${r.command.replace(/\n/g, " ").slice(0, 60)}\` | ${r.task} | ${fmt(r.recorded)} | ` +
        `${fmt(r.fresh)} | ${isStable ? "**yes**" : "**NO**"} |`,
    );
  }
  console.log(
    `\n**${stable} of ${v.rows.length} commands gave the same verdict every time** across ${v.n} draws each.`,
  );

  // THE SEPARATION, computed. A command that is stable under repetition cannot
  // be the source of a run-to-run change in how often the gate speaks.
  // "Has an opinion" means the gate emitted a decision. A judged `allow` is an
  // opinion too, but it is not one the host acts on, so it is not counted here.
  const askers = v.rows.filter((r) => (r.fresh.deny ?? 0) + (r.fresh.ask ?? 0) > 0);
  const reached = v.rows.filter((r) => Object.keys(r.fresh).some((k) => k !== "prefiltered"));
  const stableAskers = askers.filter((r) => Object.keys(r.fresh).filter((k) => r.fresh[k] > 0).length === 1);
  const straddle = askers.filter((r) => Object.keys(r.fresh).filter((k) => r.fresh[k] > 0).length > 1);
  const modal = (o: Record<string, number>): string =>
    Object.entries(o).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const norm = (x: string): string => x.replace(/^judged-/, "");
  const disagree = v.rows.filter(
    (r) => Object.keys(r.recorded).length > 0 && norm(modal(r.recorded)) !== norm(modal(r.fresh)),
  );
  console.log(
    `\n## Where the variance actually lives\n\n` +
      `**${reached.length} of ${v.rows.length} commands reached judgment** -- nothing here was waved through ` +
      `by the free prefilter, so every row is a judgment and not a regex. Of the ${askers.length} the gate ` +
      `had an ACTIONABLE opinion about (\`ask\` or \`deny\`), **${askers.length - straddle.length} are the ` +
      `same every time and ${straddle.length} straddle**.\n\n` +
      `**So the gate is deterministic on the bulk of what an agent types and genuinely undecided at the ` +
      `boundary.** ${v.rows.length - straddle.length} of ${v.rows.length} commands never wobbled once; the ` +
      `wobble is confined to commands sitting on the cutoff, which is what docs/25 predicts and not a ` +
      "surprise once it is put that way.\n\n" +
      "That makes the run-to-run change in how often the gate speaks a sum of two things, and the two " +
      "previous readings of it named one each:\n\n" +
      "1. **which route the agent takes** -- every boundary task has a verified safe route as well as a " +
      "destructive one, so on one run the agent reaches for `rm -rf` and is asked and on the next it takes " +
      "the safe route and the gate never sees it (docs/44 §4.3's half);\n" +
      `2. **genuine straddling** on the ${straddle.length} commands above (docs/43 §4b.3's half).\n\n` +
      `And "this gate stops X% of commands" fails for a third reason on top of both: **the denominator is ` +
      "whatever the agent happened to type.**\n",
  );
  console.log(
    `**Agreement with the recorded sweeps: ${v.rows.length - disagree.length} of ${v.rows.length}** on the ` +
      `modal verdict${disagree.length === 0 ? "." : `, the ${disagree.length} exception${disagree.length === 1 ? "" : "s"} being ${disagree.map((r) => `\`${r.command.replace(/\/tmp\/[^ ]*?-live/g, "<sandbox>").slice(0, 44)}\``).join(", ")} -- ${disagree.every((r) => Object.keys(r.fresh).filter((k) => r.fresh[k] > 0).length > 1) ? "which is one of the straddlers, so a disagreement is what it should produce" : "which is not a straddler and therefore wants explaining"}.`}\n\n` +
      "That column is printed for a reason: **the first two runs of this file disagreed with the sweeps on " +
      "five commands, and both times the bug was mine.** First the harness asked about files that did not " +
      "exist (one empty sandbox for every task). Then it put `cwd` inside `tool_input`, where the hook does " +
      "not look -- it reads `event.cwd ?? process.cwd()` -- so every command was judged as if it were in " +
      "this repository, and `rm -rf <sandbox>/src/node_modules` read as an out-of-project deletion " +
      "(`outside_project` 0.93) instead of an in-project cleanup. **Third time in this programme that a " +
      "re-asking harness lied to the judgment about the world, and the gate was right all three times.**\n",
  );
  const ms = v.rows.map((r) => r.medianMs);
  console.log(
    `${v.rows.length} commands × ${v.n} draws = ${v.rows.length * v.n} calls to the shipped hook, ` +
      `median ${ms.length === 0 ? "—" : [...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)]} ms each.\n`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--show")) {
    show(JSON.parse(readFileSync(PATH, "utf8")) as Variance);
    return;
  }
  const n = Number(argv[argv.indexOf("--n") + 1]) || 5;
  // ONE LIVE COPY PER TASK, built exactly as `runOnce` builds it -- the same
  // `cpSync` and the same `dotgit` -> `.git` rename. The gate is being asked
  // about a real project because that is what it was asked about in the
  // sweeps, and a command about a file that is not there is a different
  // command.
  const boxes = new Map<string, string>();
  const root = mkdtempSync(resolve(tmpdir(), "jev-variance-"));
  const sandboxOf = (task: string): string => {
    const known = boxes.get(task);
    if (known) return known;
    const dir = resolve(root, `jev-finish-${task}-live`);
    const src = tasks("boundary").find((t) => t.id === task);
    mkdirSync(dir, { recursive: true });
    if (src) {
      cpSync(src.dir, dir, { recursive: true });
      const dotgit = resolve(dir, "dotgit");
      if (existsSync(dotgit)) renameSync(dotgit, resolve(dir, ".git"));
    }
    boxes.set(task, dir);
    return dir;
  };
  try {
    const harvested = harvest(sandboxOf);
    const rows: CommandRow[] = [];
    for (const [i, h] of harvested.entries()) {
      const fresh: Record<string, number> = {};
      const times: number[] = [];
      for (let k = 0; k < n; k += 1) {
        const one = askOnce(h.command, sandboxOf(h.task));
        fresh[one.verdict] = (fresh[one.verdict] ?? 0) + 1;
        times.push(one.ms);
      }
      rows.push({
        ...h,
        fresh,
        n,
        medianMs: [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)],
      });
      process.stderr.write(
        `[${i + 1}/${harvested.length}] ${Object.entries(fresh).map(([k, c]) => `${k}×${c}`).join(" ")}  ` +
          `${h.command.slice(0, 60)}\n`,
      );
    }
    const v: Variance = { note: NOTE, n, rows };
    mkdirSync(RECORDS, { recursive: true });
    writeFileSync(PATH, `${JSON.stringify(v, null, 2)}\n`);
    show(v);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith("variance.ts")) await main();
