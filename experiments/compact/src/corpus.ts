/**
 * Transcripts to compact, built by RUNNING REAL COMMANDS against this
 * repository, and the facts a continuation would need from each.
 *
 *   npx tsx src/corpus.ts        # rebuild records/corpus.json
 *
 * The whole experiment turns on where the ground truth comes from, so:
 *
 *   EVERY TOOL RESULT IS REAL OUTPUT. The transcripts are assembled here, but
 *   the bytes inside them come from `wc`, `grep`, `cat` and `npm test` run in
 *   this repository. Nothing about what a file contains is invented, so
 *   nothing about what a deletion loses is invented either.
 *
 *   THE NEEDED FACTS ARE EXTRACTED, NOT LABELLED. Each task has an `answer`
 *   function that computes the final reply FROM the captured outputs, and the
 *   facts are the substrings it pulled out to do it. "This entry was needed"
 *   is therefore a function of the data, not an opinion about it -- which is
 *   the failure docs/24 and docs/28 kept finding in hand-labelled corpora.
 *   `assemble` refuses a fact that is absent from the entry it is attributed
 *   to, and refuses one that appears TWICE anywhere in the transcript, since a
 *   duplicated fact cannot be lost and so measures nothing.
 *
 * TWO CHOICES ARE MINE, AND BOTH DECIDE THE ANSWER.
 *
 * 1. THE TASK KINDS. This is the experiment's real axis:
 *
 *      NAMED  the goal says which thing it is about ("...what is
 *             jev-compact's `dropAt` default?"). A digest of the right entry
 *             mentions `jev-compact`, so judgment CAN see which entry is
 *             load-bearing.
 *      BLIND  the goal cannot name it ("which package has the most tests?").
 *             Which entry turns out to matter is knowable only by reading all
 *             of them, which is the thing a digest does not do.
 *
 *    A resident agent faces both. On BLIND tasks no ranking has the
 *    information to beat chance, so scoring them together would let one kind
 *    carry the other. The report keeps them apart.
 *
 * 2. WHERE THE TARGET STEP SITS. `oldest` deletes from the front and the
 *    recency floor pins the back, so if every task's own steps sat at the
 *    start of its transcript, the corpus would decide the winner before a
 *    single request was sent. So each task declares `at`, a fraction of the
 *    way through, and the eight values TILE [0, 1) EVENLY. Position is a
 *    controlled variable here, not an accident, and `--positions` prints
 *    what each one turned into.
 *
 * The filler is real exploration of this repository -- the reads and greps an
 * agent accumulates around the task it was actually given. It is what makes
 * the transcripts long enough for the floors to leave room: a 13-entry
 * transcript with `keepRecent: 6` has most of itself pinned, which was the
 * first version of this file and it measured nothing.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Entry } from "../../../packages/jev-compact/src/compact.js";

const HERE = import.meta.dirname;
const REPO = resolve(HERE, "../../..");
const RECORDS = resolve(HERE, "../records");

/** One real command and what it printed. */
export interface Ran {
  label: string;
  command: string;
  output: string;
}

function run(label: string, command: string): Ran {
  let output: string;
  try {
    output = execFileSync("bash", ["-lc", command], {
      cwd: REPO,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 180_000,
    });
  } catch (err) {
    // A non-zero exit is data too -- `npm test` on a failing package is
    // exactly the kind of entry a real transcript holds.
    const e = err as { stdout?: string; stderr?: string; message?: string };
    output = `${e.stdout ?? ""}${e.stderr ?? ""}` || String(e.message);
  }
  return { label, command, output: output.trimEnd() };
}

export type Kind = "named" | "blind";

export interface Task {
  id: string;
  kind: Kind;
  goal: string;
  /** Where this task's own steps are spliced into the filler, as a fraction. */
  at: number;
  /** The task's own commands, in order. Each becomes one call/result pair. */
  steps: { label: string; command: string }[];
  /**
   * The final reply, computed from this task's own captured outputs, and the
   * substrings it needed. `from` indexes into `steps`.
   */
  answer: (ran: Ran[]) => { text: string; facts: { text: string; from: number }[] };
}

/** The capture of `re`, as it appears in the output. Throws if absent. */
function pick(output: string, re: RegExp): string {
  const m = output.match(re);
  if (!m) throw new Error(`the corpus builder's own extractor missed: ${re}`);
  return m[1];
}

const PACKAGES = [
  "jev-compact",
  "jev-guard",
  "jev-hermes",
  "jev-model-router",
  "jev-orchestrator",
  "jev-skill-router",
];

const DOCS = [
  "18-permission-hook",
  "25-thresholds",
  "29-skill-select",
  "31-orchestration",
  "33-review",
  "34-roguelike",
  "36-routers",
  "37-hermes",
  "38-agent",
];

/**
 * The surrounding work. Real commands over this repository, none of which
 * carries any task's answer -- `assemble` enforces that by rejecting a fact
 * that turns up in more than one entry.
 */
const FILLER: { label: string; command: string }[] = [
  { label: "ls repo", command: "ls -la" },
  { label: "ls docs", command: "ls docs/" },
  { label: "ls packages", command: "ls -la packages/" },
  { label: "ls experiments", command: "ls experiments/" },
  { label: "git log", command: "git log --oneline -20" },
  { label: "git status", command: "git status --short" },
  { label: "read README", command: "head -80 docs/README.md" },
  { label: "read practice", command: "head -70 docs/practice.md" },
  { label: "read summary", command: "head -70 docs/summary.md" },
  { label: "read ideas", command: "sed -n '340,380p' docs/06-ideas.md" },
  { label: "grep TODO", command: "grep -rn 'TODO' docs/*.md | head -25" },
  { label: "grep noul", command: "grep -rn 'noul' packages/jev-core/src/*.ts | head -25" },
  { label: "wc experiments", command: "wc -l experiments/*/src/*.ts | tail -30" },
  // `wc -l docs/*.md` was here and the duplicate guard caught it: it prints
  // the same "661 docs/31-orchestration.md" line that `longest-doc`'s answer
  // is extracted from, so that fact could not be lost and the task would have
  // scored 1.0 for every ranking.
  { label: "grep anchors", command: "grep -c '](' docs/*.md | tail -20" },
  { label: "read thresholds", command: "head -60 experiments/shared/thresholds.ts" },
  { label: "list records", command: "ls -la experiments/*/records/ 2>/dev/null | head -30" },
  { label: "read core", command: "head -70 packages/jev-core/src/index.ts" },
  { label: "grep score", command: "grep -rn 'score(' packages/*/src/*.ts | head -25" },
  { label: "npm ls", command: "cd packages && npm ls --depth=0 2>&1 | head -20" },
  { label: "tsc version", command: "npx tsc --version && node --version" },
  { label: "read gitignore", command: "cat .gitignore 2>/dev/null || echo none" },
  { label: "count files", command: "find . -name '*.ts' -not -path '*/node_modules/*' | wc -l" },
];

export const TASKS: Task[] = [
  {
    id: "most-tests",
    kind: "blind",
    at: 0.05,
    goal: "run every package's test suite and tell me which package has the most tests, with the count.",
    steps: PACKAGES.map((p) => ({ label: `test ${p}`, command: `cd packages && npm --prefix ${p} test 2>&1` })),
    answer: (ran) => {
      const counts = ran.map((r) => Number(pick(r.output, /(\d+) passed/)));
      const best = counts.indexOf(Math.max(...counts));
      return {
        text: `${PACKAGES[best]} has the most, with ${counts[best]} tests passing.`,
        facts: [{ text: `${counts[best]} passed`, from: best }],
      };
    },
  },
  {
    id: "dropat-default",
    kind: "named",
    at: 0.18,
    goal: "read the source of every package and tell me what jev-compact's `dropAt` default is.",
    steps: PACKAGES.map((p) => ({ label: `read ${p}`, command: `cat packages/${p}/src/*.ts | head -300` })),
    answer: (ran) => {
      const i = PACKAGES.indexOf("jev-compact");
      const value = pick(ran[i].output, /dropAt:\s*([\d.]+)/);
      return { text: `jev-compact's \`dropAt\` default is ${value}.`, facts: [{ text: `dropAt: ${value}`, from: i }] };
    },
  },
  {
    id: "longest-doc",
    kind: "blind",
    at: 0.31,
    goal: "measure these reports and tell me which is the longest, in lines.",
    steps: DOCS.map((d) => ({ label: `wc ${d}`, command: `wc -l docs/${d}.md && head -25 docs/${d}.md` })),
    answer: (ran) => {
      const lines = ran.map((r) => Number(pick(r.output, /^\s*(\d+)\s/)));
      const best = lines.indexOf(Math.max(...lines));
      return {
        text: `docs/${DOCS[best]}.md is the longest, at ${lines[best]} lines.`,
        facts: [{ text: `${lines[best]} docs/${DOCS[best]}.md`, from: best }],
      };
    },
  },
  {
    id: "guard-cutoffs",
    kind: "named",
    at: 0.44,
    goal: "look through the packages and tell me the exact cutoffs jev-guard's permission battery ships with.",
    steps: PACKAGES.map((p) => ({
      label: `grep ${p}`,
      command: `grep -rn "THRESHOLDS\\|DEFAULT_.*=\\s*{" packages/${p}/src/ | head -30`,
    })),
    answer: (ran) => {
      const i = PACKAGES.indexOf("jev-guard");
      const line = ran[i].output.split("\n").find((l) => /Thresholds = \{/.test(l));
      if (!line) throw new Error("no cutoff line in jev-guard");
      return { text: `jev-guard ships: ${line.trim()}`, facts: [{ text: line.trim().slice(-40), from: i }] };
    },
  },
  {
    id: "flag-registry",
    kind: "named",
    at: 0.57,
    goal: "check each package's pi extension and tell me exactly which flags jev-orchestrator registers.",
    steps: PACKAGES.map((p) => ({
      label: `pi.ts ${p}`,
      command: `cat packages/${p}/src/pi.ts 2>/dev/null | head -140 || echo "no pi.ts"`,
    })),
    answer: (ran) => {
      const i = PACKAGES.indexOf("jev-orchestrator");
      const flags = [...ran[i].output.matchAll(/registerFlag\("([^"]+)"/g)].map((m) => m[1]);
      if (flags.length === 0) throw new Error("no flags found in jev-orchestrator");
      return {
        text: `jev-orchestrator registers ${flags.join(" and ")}.`,
        facts: flags.map((f) => ({ text: `registerFlag("${f}"`, from: i })),
      };
    },
  },
  {
    id: "biggest-source",
    kind: "blind",
    at: 0.7,
    goal: "size up the packages' sources and tell me which single file is the biggest, in bytes.",
    steps: PACKAGES.map((p) => ({ label: `du ${p}`, command: `wc -c packages/${p}/src/*.ts && head -40 packages/${p}/src/*.ts` })),
    answer: (ran) => {
      let best = { size: -1, line: "", from: -1 };
      for (const [i, r] of ran.entries()) {
        for (const line of r.output.split("\n")) {
          const m = line.match(/^\s*(\d+)\s+(\S+\.ts)$/);
          if (m && Number(m[1]) > best.size) best = { size: Number(m[1]), line: line.trim(), from: i };
        }
      }
      return { text: `the biggest is ${best.line.split(/\s+/)[1]} at ${best.size} bytes.`, facts: [{ text: best.line, from: best.from }] };
    },
  },
  {
    id: "scenario-count",
    kind: "named",
    at: 0.83,
    goal: "read the agent harness and tell me how many scenarios it has and what the last one's id is.",
    steps: [
      { label: "scenarios", command: "cat experiments/agent/src/scenarios.ts" },
      { label: "run", command: "cat experiments/agent/src/run.ts | head -110" },
      { label: "stub", command: "cat experiments/agent/src/stub.ts | head -110" },
      { label: "sandbox", command: "cat experiments/agent/src/sandbox.ts | head -110" },
      { label: "provider", command: "cat experiments/agent/src/provider.ts" },
      { label: "harness test", command: "cat experiments/agent/test.ts | head -110" },
    ],
    answer: (ran) => {
      const ids = [...ran[0].output.matchAll(/^\s+id: "([^"]+)"/gm)].map((m) => m[1]);
      if (ids.length === 0) throw new Error("no scenario ids");
      return {
        text: `${ids.length} scenarios; the last is \`${ids[ids.length - 1]}\`.`,
        facts: [{ text: `id: "${ids[ids.length - 1]}"`, from: 0 }],
      };
    },
  },
  {
    id: "findings-links",
    kind: "blind",
    at: 0.93,
    goal: "count the cross-references in findings.md and tell me which report it points at most often.",
    steps: [
      { label: "links", command: "grep -o '#[0-9][0-9]-[^)]*' docs/findings.md | sort | uniq -c | sort -rn | head -30" },
      ...DOCS.slice(0, 5).map((d) => ({ label: `scan ${d}`, command: `sed -n '1,50p' docs/${d}.md` })),
    ],
    answer: (ran) => {
      const top = ran[0].output.trim().split("\n")[0]?.trim();
      if (!top) throw new Error("no link counts");
      return { text: `the most-referenced is ${top}.`, facts: [{ text: top, from: 0 }] };
    },
  },
];

export interface Transcript {
  id: string;
  kind: Kind;
  goal: string;
  entries: Entry[];
  answer: string;
  /** Substrings a continuation needs, and the entry each lives in. */
  facts: { text: string; entryId: string }[];
  tokens: number;
  /** Where the task's own steps were spliced in, as declared and as built. */
  at: number;
  targetIndex: number;
}

/**
 * Assemble one transcript: the goal, then a call/result pair per step, with
 * the task's own steps spliced into the filler at `at`.
 */
function assemble(task: Task, own: Ran[], filler: Ran[]): Transcript {
  const cut = Math.round(task.at * filler.length);
  const ordered: { ran: Ran; own: boolean }[] = [
    ...filler.slice(0, cut).map((ran) => ({ ran, own: false })),
    ...own.map((ran) => ({ ran, own: true })),
    ...filler.slice(cut).map((ran) => ({ ran, own: false })),
  ];
  const entries: Entry[] = [{ id: "goal", role: "user", text: task.goal, label: "goal" }];
  /** Where each of the task's OWN steps ended up, by its index in `steps`. */
  const resultIdOfOwn: string[] = [];
  for (const [i, slot] of ordered.entries()) {
    const callId = `c${i}`;
    entries.push({ id: `a${i}`, role: "assistant", text: `I'll ${slot.ran.label}.`, calls: [callId], label: slot.ran.label });
    entries.push({ id: `r${i}`, role: "tool", text: slot.ran.output, answers: callId, label: slot.ran.label });
    if (slot.own) resultIdOfOwn.push(`r${i}`);
  }
  const { text, facts } = task.answer(own);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const resolved = facts.map((f) => {
    const entryId = resultIdOfOwn[f.from];
    const entry = byId.get(entryId);
    if (!entry?.text.includes(f.text)) {
      throw new Error(`${task.id}: fact ${JSON.stringify(f.text)} is not in ${entryId}`);
    }
    return { text: f.text, entryId };
  });
  // A fact present in two entries cannot be lost, so it would score 1.0 for
  // every ranking and quietly inflate all of them.
  for (const f of resolved) {
    const holders = entries.filter((e) => e.text.includes(f.text));
    if (holders.length !== 1) {
      throw new Error(
        `${task.id}: fact ${JSON.stringify(f.text)} appears in ${holders.length} entries ` +
          `(${holders.map((h) => h.id).join(", ")}); a duplicated fact cannot be lost, so it measures nothing`,
      );
    }
  }
  const targetIndex = entries.findIndex((e) => e.id === resolved[0].entryId);
  return {
    id: task.id,
    kind: task.kind,
    goal: task.goal,
    entries,
    answer: text,
    facts: resolved,
    tokens: entries.reduce((s, e) => s + Math.ceil(e.text.length / 4), 0),
    at: task.at,
    targetIndex,
  };
}

async function main(): Promise<void> {
  // The filler is run ONCE and shared, so a difference between transcripts is
  // the task and not the day's `git log`.
  console.log(`  running ${FILLER.length} filler commands...`);
  const filler = FILLER.map((s) => run(s.label, s.command));
  const transcripts: Transcript[] = [];
  for (const task of TASKS) {
    const own = task.steps.map((s) => run(s.label, s.command));
    const t = assemble(task, own, filler);
    transcripts.push(t);
    console.log(
      `  ${t.id.padEnd(16)} ${t.kind.padEnd(6)} ${String(t.entries.length).padStart(3)} entries ` +
        `${String(t.tokens).padStart(6)} tokens  at=${t.at.toFixed(2)} -> index ${t.targetIndex}/${t.entries.length}  ` +
        `${t.facts.length} fact(s) in ${t.facts.map((f) => f.entryId).join(",")}`,
    );
  }
  mkdirSync(RECORDS, { recursive: true });
  writeFileSync(resolve(RECORDS, "corpus.json"), `${JSON.stringify({ transcripts }, null, 2)}\n`);
  console.log(`\n  ${transcripts.length} transcripts in records/corpus.json`);
}

if (process.argv[1]?.endsWith("corpus.ts")) await main();
