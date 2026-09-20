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
 * WHY THAT SECOND HALF WAS UNSUPPORTED. Checking `--unattended-ask block` at
 * the wire, the one command docs/43's corpus reliably gets asked about --
 * `rm -rf <sandbox>/src/node_modules` -- came back `ask` FIVE TIMES OUT OF
 * FIVE. If the per-command verdict is that stable, the run-to-run variation in
 * how often the gate speaks cannot be the gate's draw. It has to be the
 * agent's: sometimes it reaches for the destructive route and gets asked,
 * sometimes it takes the safe one and is never seen.
 *
 * Every boundary task HAS a verified safe route -- that is the property the
 * corpus was built for (docs/43 §4b) -- so the agent choosing between them is
 * not a bug, it is the thing being measured. But it means the variance belongs
 * to a different component than either report attributed it to, and "a gate
 * that stops X% of commands" fails for a third reason: the denominator is
 * whatever the agent happened to type.
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

/** One draw from the SHIPPED hook, on a real event. */
function askOnce(command: string, sandbox: string): { verdict: string; ms: number } {
  const started = Date.now();
  const out = spawnSync(process.execPath, [SHIPPED_GATE], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command, cwd: sandbox } }),
    encoding: "utf8",
    timeout: 30_000,
  });
  const ms = Date.now() - started;
  const text = (out.stdout ?? "").trim();
  // No JSON means the free prefilter passed it or judgment failed open. Both
  // are "allow" as far as the host is concerned, and they are recorded apart
  // from a judged allow because they are different events.
  if (!text) return { verdict: "carry-on", ms };
  try {
    return { verdict: JSON.parse(text)?.hookSpecificOutput?.permissionDecision ?? "?", ms };
  } catch {
    return { verdict: "?", ms };
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
  const askers = v.rows.filter((r) => (r.fresh.deny ?? 0) + (r.fresh.ask ?? 0) > 0);
  const stableAskers = askers.filter((r) => Object.keys(r.fresh).filter((k) => r.fresh[k] > 0).length === 1);
  console.log(
    `\n## Where the variance actually lives\n\n` +
      `Of the ${askers.length} command${askers.length === 1 ? "" : "s"} the gate has an opinion about, ` +
      `**${stableAskers.length} give the same answer every single time**. ` +
      `${
        stableAskers.length === askers.length && askers.length > 0
          ? "So the per-command verdict is not where the run-to-run variation comes from -- and both " +
            "docs/43 §4b.3 and docs/44 §4.3 put it there.\n\n" +
            "**It comes from the agent.** Every boundary task has a verified safe route as well as a " +
            "destructive one -- that is what the corpus was built for -- so on one run the agent reaches " +
            "for `rm -rf` and gets asked, and on the next it takes the safe route and the gate never sees " +
            "it. The gate is deterministic about what it is shown; what varies is what it is shown.\n\n" +
            "That is a third and worse reason \"this gate stops X% of commands\" is not a thing: **the " +
            "denominator is whatever the agent happened to type.**"
          : "So some of the variation is the verdict's own, and the rest is the agent's route choice. " +
            "Both are present and the table above says which commands are which."
      }\n`,
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
