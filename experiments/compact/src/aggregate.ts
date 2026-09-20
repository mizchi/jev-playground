/**
 * Superlative goals: the front-end has three stages, not two. [TODO §1.7]
 *
 *   tsx src/aggregate.ts --split      §1, free, no key: the goal-type label
 *   tsx src/aggregate.ts --narrow     §2, free, no key: why narrowing is the work
 *   tsx src/aggregate.ts              §3, one request per transcript
 *   tsx src/aggregate.ts --show       re-read the record
 *
 * WHAT §1.7 ASKED. docs/46 §3.1 split the corpus in two: a free word count
 * ranks the answer-bearing entry first when the goal NAMES what it is asking
 * about (`dropAt`, the flags, the scenarios) and falls away when the goal asks
 * for a comparison (longest, most, most-often). Neither arm is established on
 * the comparison half, and that is the half a compaction front-end most wants.
 *
 * §1.7 listed three ways to close it and doubted the first two:
 *
 *   1. label the corpus by goal type -- "**これは実行可能な述語ではなく私の
 *      分類なので、§2.1 の問題を持ち込む**" (my classification, not an
 *      executable predicate, so it drags in the written-by-me problem)
 *   2. ask for aggregation instead of ranking, assuming the candidates are
 *      already narrowed -- "**前段が 2 段になる**" (the front-end becomes two
 *      stages)
 *   3. wait for a bigger corpus
 *
 * BOTH DOUBTS WERE WRONG, IN OPPOSITE DIRECTIONS.
 *
 * §1 is better than §1.7 expected: the label IS executable. One regex for a
 * superlative, applied to the GOAL TEXT ONLY and never to the answer, splits
 * the corpus 4/4 and reproduces the hand-made split exactly. No opinion, no
 * new corpus, one line of code.
 *
 * §2 is worse than §1.7 expected: "assuming the candidates are already
 * narrowed" is doing all the work. Two free narrowings -- biggest same-shaped
 * group, and the same weighted by goal overlap -- each get 1 of 4, and every
 * failure has the same form: the right SHAPE from the wrong COMMAND. So the
 * design is three stages (detect, narrow, aggregate), the third is free
 * arithmetic, and the second is the judgment.
 *
 * §3 measures the second, because it is a far better-shaped question than the
 * ranking one: ~10 command groups instead of ~56 opaque entries, and the
 * candidates carry the command that produced them. That is docs/01's `choice`
 * shape. The free baseline is the goal's overlap with the command LABEL rather
 * than with the output.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Jev } from "../../../packages/jev-core/src/index.js";
import type { Transcript } from "./corpus.js";

const RECORDS = resolve(import.meta.dirname, "../records");
const PATH = resolve(RECORDS, "aggregate.json");

/**
 * A superlative in the goal, as one regex over the GOAL TEXT ONLY.
 *
 * Never applied to the answer, the answer's entry, or anything downstream, so
 * it cannot leak the label it is used to predict. `max`/`min` are left out
 * deliberately: they appear in source code all over this corpus and the point
 * is a predicate about the REQUEST.
 */
export const SUPERLATIVE =
  /\b(most|least|longest|shortest|biggest|smallest|largest|highest|lowest|fewest)\b/i;

export const isComparison = (goal: string): boolean => SUPERLATIVE.test(goal);

/** Abstract a line to its shape: numbers, path-like tokens, other words. */
const shapeOf = (line: string): string =>
  line
    .trim()
    .split(/\s+/)
    .map((t) => (/^[0-9][0-9.,]*$/.test(t) ? "N" : /[/.]/.test(t) ? "P" : "W"))
    .join(" ");

const vocabulary = (text: string): Set<string> =>
  new Set(text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []);

/**
 * The number a line LEADS with, or NaN.
 *
 * Anchored, and it has to be: the first version matched a bare `[0-9][0-9,]*`
 * anywhere in the line, so `ok   a 60-skill shortlist` scored 60 and
 * `* 24,000,000 is $1.008 at` scored 24,000,000 -- both of which beat the
 * planted answers and made stage 3 look worse than it is. Every measured value
 * this corpus plants in command output (`20 passed`, `661 docs/...`,
 * `30130 packages/...`, `18 #29-...`) leads with its number, because that is
 * what `wc`, `du`, `node --test` and `sort | uniq -c` print.
 */
const leadingNumber = (line: string): number => {
  const m = line.trim().match(/^([0-9][0-9,]*)\b/);
  return m ? Number.parseInt(m[1].replace(/,/g, ""), 10) : Number.NaN;
};

function corpus(): Transcript[] {
  return (JSON.parse(readFileSync(resolve(RECORDS, "corpus.json"), "utf8")) as { transcripts: Transcript[] })
    .transcripts;
}

const goalOf = (t: Transcript): string => t.entries.find((e) => e.role === "user")?.text ?? "";

/** Tool entries grouped by the command that produced them. */
export function commandGroups(t: Transcript): Map<string, { id: string; label: string; text: string }[]> {
  const groups = new Map<string, { id: string; label: string; text: string }[]>();
  for (const e of t.entries) {
    if (e.role !== "tool" || !e.label) continue;
    const cmd = e.label.split(/\s+/)[0];
    if (!groups.has(cmd)) groups.set(cmd, []);
    (groups.get(cmd) as { id: string; label: string; text: string }[]).push({
      id: e.id,
      label: e.label,
      text: e.text,
    });
  }
  return groups;
}

/** Which command group the planted answer lives in. The label for §3. */
export function answerGroup(t: Transcript): string | null {
  const want = new Set(t.facts.map((f) => f.entryId));
  for (const [cmd, es] of commandGroups(t)) if (es.some((e) => want.has(e.id))) return cmd;
  return null;
}

// ------------------------------------------------------------------- §1

function split(): void {
  const ts = corpus();
  console.log("\n# Superlative goals: three stages, not two [TODO §1.7]\n");
  console.log("## 1. The goal-type label is executable after all\n");
  console.log(
    "§1.7 assumed labelling the corpus by goal type would be *my* classification and so would drag in " +
      "[TODO §2.1](../../TODO.md)'s written-by-me problem. It does not: **one regex for a superlative, " +
      "applied to the goal text and nothing else**, reproduces the hand-made split exactly.\n",
  );
  console.log("| transcript | goal | superlative | `overlap` rank (46 §3) | jev rank |");
  console.log("| --- | --- | --- | --- | --- |");
  // The ranks are docs/46's, quoted rather than recomputed -- that report's
  // own file is where they are derived and re-deriving them here would be a
  // second implementation of the same thing.
  const RANKS: Record<string, { overlap: number; jev: number }> = {
    "most-tests": { overlap: 6, jev: 13 },
    "dropat-default": { overlap: 1, jev: 3 },
    "longest-doc": { overlap: 4, jev: 29 },
    "guard-cutoffs": { overlap: 3, jev: 1 },
    "flag-registry": { overlap: 1, jev: 1 },
    "biggest-source": { overlap: 3, jev: 1 },
    "scenario-count": { overlap: 1, jev: 2 },
    "findings-links": { overlap: 18, jev: 5 },
  };
  for (const t of ts) {
    const g = goalOf(t);
    const m = g.match(SUPERLATIVE);
    const r = RANKS[t.id];
    console.log(
      `| \`${t.id}\` | ${g.slice(0, 40)}… | ${m ? `**\`${m[1]}\`**` : "—"} | ` +
        `${r ? r.overlap : "?"} | ${r ? r.jev : "?"} |`,
    );
  }
  const comp = ts.filter((t) => isComparison(goalOf(t)));
  const plain = ts.filter((t) => !isComparison(goalOf(t)));
  const med = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  console.log(
    `\n| | n | \`overlap\` median rank | jev median rank |\n| --- | --- | --- | --- |\n` +
      `| **superlative goals** | ${comp.length} | **${med(comp.map((t) => RANKS[t.id].overlap))}** | ` +
      `**${med(comp.map((t) => RANKS[t.id].jev))}** |\n` +
      `| plain goals | ${plain.length} | ${med(plain.map((t) => RANKS[t.id].overlap))} | ` +
      `${med(plain.map((t) => RANKS[t.id].jev))} |\n`,
  );
  console.log(
    `**${comp.length} of ${ts.length} goals contain a superlative, and they are exactly the ` +
      "transcripts docs/46 §3.1 identified by hand.** So §1.7's first candidate closes for free, and " +
      "closes better than it expected: the goal type is a property of the REQUEST, which means a " +
      "front-end can branch on it before spending anything. **Both arms are several times worse on the " +
      "superlative half**, and that is now a measurable class rather than an observation about four rows.\n",
  );
}

// ------------------------------------------------------------------- §2

interface Narrowed {
  transcript: string;
  method: string;
  group: string;
  members: number;
  max: string;
  hit: boolean;
}

function narrowFreely(t: Transcript): Narrowed[] {
  const goal = vocabulary(goalOf(t));
  const want = t.facts[0].text;
  const lines = new Map<string, string[]>();
  for (const e of t.entries) {
    if (e.role !== "tool") continue;
    for (const l of e.text.split("\n")) {
      if (!l.trim()) continue;
      const s = shapeOf(l);
      if (!s.includes("N")) continue;
      if (!lines.has(s)) lines.set(s, []);
      (lines.get(s) as string[]).push(l.trim());
    }
  }
  const groups = [...lines.entries()].filter(([, ls]) => ls.length >= 3);
  const pick = (chosen: [string, string[]] | undefined, method: string): Narrowed => {
    if (!chosen) return { transcript: t.id, method, group: "(none)", members: 0, max: "", hit: false };
    const max = chosen[1].reduce((a, b) => (leadingNumber(b) > leadingNumber(a) ? b : a));
    return {
      transcript: t.id,
      method,
      group: chosen[0],
      members: chosen[1].length,
      max,
      hit: max.includes(want),
    };
  };
  const biggest = [...groups].sort((a, b) => b[1].length - a[1].length)[0];
  const byOverlap = [...groups]
    .map(([s, ls]) => {
      const ov =
        ls.reduce((a, l) => {
          const w = vocabulary(l);
          let h = 0;
          for (const x of goal) if (w.has(x)) h += 1;
          return a + h / Math.max(1, goal.size);
        }, 0) / ls.length;
      return { s, ls, ov };
    })
    .sort((a, b) => b.ov - a.ov)[0];
  return [
    pick(biggest, "biggest same-shaped group"),
    pick(byOverlap ? [byOverlap.s, byOverlap.ls] : undefined, "same, weighted by goal overlap"),
  ];
}

function narrow(): void {
  const ts = corpus().filter((t) => isComparison(goalOf(t)));
  console.log("\n## 2. And \"assuming the candidates are already narrowed\" is doing all the work\n");
  console.log(
    "§1.7's second candidate was to ask for an aggregation instead of a ranking -- \"which of these is " +
      "the largest\" -- **assuming the candidate set is already narrowed**. Two free ways to narrow it, " +
      "on the four superlative transcripts:\n",
  );
  console.log("| transcript | narrowing | group | members | its maximum | answer? |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  const all: Narrowed[] = [];
  for (const t of ts) {
    for (const n of narrowFreely(t)) {
      all.push(n);
      console.log(
        `| \`${n.transcript}\` | ${n.method} | \`${n.group.slice(0, 12)}\` | ${n.members} | ` +
          `\`${n.max.replace(/\|/g, "\\|").slice(0, 40)}\` | ${n.hit ? "**HIT**" : "miss"} |`,
      );
    }
  }
  const methods = [...new Set(all.map((n) => n.method))];
  console.log("");
  for (const method of methods) {
    const g = all.filter((n) => n.method === method);
    console.log(`- **${method}**: ${g.filter((n) => n.hit).length}/${g.length}`);
  }
  // STATE THE COMPARISON RATHER THAN A DIRECTION. A first draft of this said
  // the overlap weighting "made it worse"; both land on the same count, and
  // what actually differs is WHICH wrong group each picks. Saying "worse"
  // would have been a claim the table underneath contradicts.
  const [a, b] = methods.map((m) => all.filter((n) => n.method === m));
  const sameGroup = a.filter((x, i) => x.group === b[i]?.group).length;
  console.log(
    `\n**Both land on ${a.filter((x) => x.hit).length}/${a.length}, and they agree on the group they pick ` +
      `only ${sameGroup} of ${a.length} times** -- so the goal-overlap weighting changes which group is ` +
      "chosen without changing whether it is the right one. **Tool-output lines share almost nothing " +
      "with the goal's words**, which is docs/46 §3.1's finding arriving one level down, at the line " +
      "instead of the entry.\n",
  );
  console.log(
    "**And every miss has the same form: the right SHAPE from the wrong COMMAND.** `longest-doc` asks " +
      "about \"these reports\" and the shape `N P` pools the `wc` of docs with the `wc` of " +
      "`experiments/`, so the maximum is a source file. `findings-links` asks for a link count and gets " +
      "a `wc -l` total. `most-tests` gets `ls -l` block counts. The one hit, `biggest-source`, is the " +
      "transcript whose goal happens to be about the same files the dominant shape covers -- " +
      "**it is the corpus agreeing with the heuristic, not the heuristic working.**\n",
  );
  console.log(
    "> **So the front-end is three stages, not two:**\n>\n" +
      "> 1. **detect** that the goal is a comparison — §1, free, one regex, exact\n" +
      "> 2. **narrow** to the command whose output the goal is about — **this is the judgment**\n" +
      "> 3. **aggregate** — free arithmetic, and correct only if 2 was\n>\n" +
      "> §1.7 counted two stages and put the judgment in the wrong one.\n",
  );
  // AND THE STAGE-2 CANDIDATES, which is what makes §3 a better question than
  // the ranking one: the transcript already groups its own output by command.
  console.log("### 2.1 What stage 2 gets to choose between\n");
  console.log("| transcript | command groups | the answer's group | biggest group |");
  console.log("| --- | --- | --- | --- |");
  for (const t of ts) {
    const groups = commandGroups(t);
    const rows = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
    const want = answerGroup(t);
    console.log(
      `| \`${t.id}\` | ${rows.map(([k, v]) => `\`${k}\`:${v.length}`).join(" ")} | ` +
        `**\`${want}\`** (n=${groups.get(want ?? "")?.length ?? 0}) | \`${rows[0][0]}\` |`,
    );
  }
  console.log(
    "\n**The transcript groups its own output by command**, so stage 2 chooses between about ten labelled " +
      "candidates rather than ranking fifty-six opaque ones -- docs/01's `choice` shape. " +
      "**And the biggest group is the wrong answer on 3 of 4**, so it is not free by default.\n",
  );
  console.log(
    "**`findings-links` is a fourth case and worth naming**: its answer's group has **one** member, " +
      "because the comparison happens *inside* a single command's output (a list of link counts) rather " +
      "than across entries. **So stage 3 has to work over lines within an entry as well as across " +
      "entries**, and this corpus has exactly one example of that.\n",
  );
}

// ------------------------------------------------------------------- §3

interface Row {
  transcript: string;
  superlative: boolean;
  /** The command group the answer lives in. */
  want: string;
  /** Candidates offered, in the order they were offered. */
  candidates: string[];
  jev: { choice: string; confidence: number; probabilities: Record<string, number> } | null;
  free: string;
  biggest: string;
  ms: number;
  /** Stage 3, run inside whichever group each arm chose. */
  maxIn: Record<string, { line: string; hit: boolean }>;
  error?: string;
}

interface Record_ {
  note: string;
  rows: Row[];
}

const NOTE =
  "TODO §1.7's stage 2: which command group is the goal asking about. One `choice` " +
  "per transcript over the transcript's own command groups. The free arm is the " +
  "goal's overlap with the command LABEL; `biggest` is the largest group. The " +
  "label is the group holding `facts[].entryId`, so it is mechanical.";

/**
 * Stage 3: the maximum inside one group, by arithmetic.
 *
 * `skipTotals` exists so the report can print both numbers and say which one
 * is fitted. Without it, the two misses on the superlative half are BOTH a
 * `total` line -- `26453 total` from `wc` and `62910 total` from `du` -- and a
 * total is larger than every member by construction. Excluding it is a one-line
 * change any real implementation would make on first contact.
 *
 * But it would be a one-line change chosen AFTER seeing these four rows, which
 * is summary.md's lesson 8: a cutoff fitted on a corpus sits on the boundary of
 * the next one. So the honest output is both figures with the fitted one
 * labelled, not the better figure quoted alone.
 */
function maxIn(t: Transcript, cmd: string, skipTotals = false): { line: string; hit: boolean } {
  const es = commandGroups(t).get(cmd) ?? [];
  const want = t.facts[0].text;
  const lines = es.flatMap((e) => e.text.split("\n").map((l) => l.trim()).filter(Boolean));
  const numeric = lines.filter(
    (l) => Number.isFinite(leadingNumber(l)) && !(skipTotals && /^[0-9][0-9,]*\s+total\b/i.test(l)),
  );
  if (numeric.length === 0) return { line: "", hit: false };
  const line = numeric.reduce((a, b) => (leadingNumber(b) > leadingNumber(a) ? b : a));
  return { line, hit: line.includes(want) };
}

/** The free stage-2 arm: goal overlap with the command label, not its output. */
function freePick(t: Transcript): string {
  const goal = vocabulary(goalOf(t));
  const groups = [...commandGroups(t).entries()];
  let best = groups[0][0];
  let bestScore = -1;
  for (const [cmd, es] of groups) {
    const words = vocabulary([cmd, ...es.map((e) => e.label)].join(" "));
    let hits = 0;
    for (const g of goal) if (words.has(g)) hits += 1;
    if (hits > bestScore) {
      bestScore = hits;
      best = cmd;
    }
  }
  return best;
}

async function ask(t: Transcript): Promise<Row> {
  const groups = commandGroups(t);
  const candidates = [...groups.keys()];
  const want = answerGroup(t) ?? "(none)";
  const biggest = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0][0];
  /**
   * The state is the command groups with their labels, NOT their output.
   *
   * Deliberate: stage 2's question is "which command was the goal about", and
   * the output is what stage 3 reads. Sending the output would also blow the
   * state ceiling on a 27k-token transcript, and docs/29 §4 is the reason this
   * is allowed to be a small state -- an answer does not move with the width
   * of the request, so the cheap framing is the one to test.
   */
  const state = {
    goal: goalOf(t),
    commands: Object.fromEntries(
      [...groups.entries()].map(([cmd, es]) => [
        cmd,
        { ran: es.length, examples: es.slice(0, 4).map((e) => e.label) },
      ]),
    ),
  };
  const jev = new Jev({ timeoutMs: 40_000 });
  const started = Date.now();
  try {
    const res = await jev.ask(state, {
      group: {
        type: "choice",
        instructions:
          "The goal asks for one value. Which of these commands produced the output that holds it? " +
          "Choose the command whose results have to be compared or read to answer, not the commands " +
          "that were run to find your way around.",
        criteria: Object.fromEntries(candidates.map((c) => [c, `the output of the \`${c}\` calls`])),
      },
    });
    const a = res.answers.group;
    return {
      transcript: t.id,
      superlative: isComparison(goalOf(t)),
      want,
      candidates,
      jev:
        a?.type === "choice"
          ? { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities }
          : null,
      free: freePick(t),
      biggest,
      ms: Date.now() - started,
      maxIn: Object.fromEntries(
        [...new Set([want, a?.type === "choice" ? a.choice : want, freePick(t), biggest])].map((c) => [
          c,
          maxIn(t, c),
        ]),
      ),
    };
  } catch (err) {
    return {
      transcript: t.id,
      superlative: isComparison(goalOf(t)),
      want,
      candidates,
      jev: null,
      free: freePick(t),
      biggest,
      ms: Date.now() - started,
      maxIn: {},
      error: (err as Error).message.slice(0, 200),
    };
  }
}

function show(rec: Record_): void {
  console.log("\n## 3. Stage 2, measured: which command is the goal about?\n");
  console.log(
    "One `choice` per transcript over **the transcript's own command groups**, with the labels but not " +
      "the output in the state (stage 3 reads the output). The label is the group holding " +
      "`facts[].entryId`. The free arm is the goal's overlap with the command **labels**; `biggest` is " +
      "the largest group, which §2.1 showed is wrong 3 times in 4.\n",
  );
  console.log("| transcript | superlative | answer's group | **jev** | conf | free (labels) | biggest |");
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  const ok = (a: string, b: string): string => (a === b ? `**${a}** ✓` : `${a}`);
  for (const r of rec.rows) {
    console.log(
      `| \`${r.transcript}\` | ${r.superlative ? "**yes**" : "—"} | \`${r.want}\` | ` +
        `${r.jev ? ok(r.jev.choice, r.want) : `ERR`} | ${r.jev ? r.jev.confidence.toFixed(2) : "—"} | ` +
        `${ok(r.free, r.want)} | ${ok(r.biggest, r.want)} |`,
    );
  }
  const scored = rec.rows.filter((r) => r.jev);
  const hit = (pick: (r: Row) => string): number => scored.filter((r) => pick(r) === r.want).length;
  const comp = scored.filter((r) => r.superlative);
  const hitIn = (rs: Row[], pick: (r: Row) => string): number => rs.filter((r) => pick(r) === r.want).length;
  console.log(
    `\n| arm | all ${scored.length} | superlative ${comp.length} | plain ${scored.length - comp.length} |\n` +
      "| --- | --- | --- | --- |\n" +
      `| **jev** | **${hit((r) => r.jev?.choice ?? "")}/${scored.length}** | ` +
      `**${hitIn(comp, (r) => r.jev?.choice ?? "")}/${comp.length}** | ` +
      `${hitIn(
        scored.filter((r) => !r.superlative),
        (r) => r.jev?.choice ?? "",
      )}/${scored.length - comp.length} |\n` +
      `| free (command labels) | ${hit((r) => r.free)}/${scored.length} | ` +
      `${hitIn(comp, (r) => r.free)}/${comp.length} | ` +
      `${hitIn(
        scored.filter((r) => !r.superlative),
        (r) => r.free,
      )}/${scored.length - comp.length} |\n` +
      `| biggest group | ${hit((r) => r.biggest)}/${scored.length} | ` +
      `${hitIn(comp, (r) => r.biggest)}/${comp.length} | ` +
      `${hitIn(
        scored.filter((r) => !r.superlative),
        (r) => r.biggest,
      )}/${scored.length - comp.length} |\n`,
  );

  // STAGE 3, inside whichever group each arm picked. This is the number that
  // matters: stage 2 being right is only useful if stage 3 then lands.
  //
  // RECOMPUTED FROM THE CORPUS, not read off the record. The record's own
  // `maxIn` was written by whichever version of `leadingNumber` ran the sweep,
  // and the first one matched a number anywhere in the line rather than at the
  // start -- so the stored values were wrong and a `--show` would have
  // faithfully replayed them. Stage 3 is free arithmetic over `corpus.json`,
  // so there is no reason to trust a stored copy of it.
  const ts = corpus();
  const stage3 = (transcript: string, cmd: string): { line: string; hit: boolean } | undefined => {
    const t = ts.find((x) => x.id === transcript);
    return t === undefined || cmd === "" ? undefined : maxIn(t, cmd);
  };
  console.log("\n### 3.1 And stage 3 inside the group each arm chose\n");
  console.log("| transcript | inside the CORRECT group | inside jev's choice | inside the free choice |");
  console.log("| --- | --- | --- | --- |");
  const mark = (m: { line: string; hit: boolean } | undefined): string =>
    m === undefined
      ? "—"
      : m.line === ""
        ? "no numeric line"
        : m.hit
          ? `**HIT** \`${m.line.slice(0, 26)}\``
          : `miss \`${m.line.slice(0, 26)}\``;
  for (const r of rec.rows.filter((x) => x.superlative)) {
    console.log(
      `| \`${r.transcript}\` | ${mark(stage3(r.transcript, r.want))} | ` +
        `${mark(stage3(r.transcript, r.jev?.choice ?? ""))} | ${mark(stage3(r.transcript, r.free))} |`,
    );
  }
  const sup = rec.rows.filter((x) => x.superlative);
  const oracleHits = sup.filter((r) => stage3(r.transcript, r.want)?.hit).length;
  console.log(
    `\n**Given the correct group, free arithmetic lands on the planted answer ${oracleHits} of ` +
      `${sup.length} times.** That is stage 3's ceiling, and §1.7's second candidate was implicitly ` +
      `assuming it was ${sup.length}/${sup.length}.`,
  );
  const missed = sup.filter((r) => !stage3(r.transcript, r.want)?.hit);
  if (missed.length > 0) {
    const lines = missed.map((r) => stage3(r.transcript, r.want)?.line ?? "");
    const allTotals = lines.every((l) => /^[0-9][0-9,]*\s+total\b/i.test(l));
    console.log(
      `\n${missed.map((r) => `\`${r.transcript}\``).join(", ")} ${missed.length === 1 ? "does" : "do"} not ` +
        `land even inside the right group. **And ${allTotals ? "both misses are the same thing" : "the misses differ"}**: ` +
        `${lines.map((l) => `\`${l.slice(0, 20)}\``).join(" and ")} -- ` +
        (allTotals
          ? "`wc` and `du` each print a **total**, and a total is larger than every member by " +
            "construction.\n"
          : "\n"),
    );
    if (allTotals) {
      const fitted = sup.filter((r) => {
        const t = ts.find((x) => x.id === r.transcript);
        return t !== undefined && maxIn(t, r.want, true).hit;
      }).length;
      console.log(
        `> **Excluding total lines takes it to ${fitted}/${sup.length}** -- one line of code, and the ` +
          "line any real implementation would write on first contact with `wc`.\n>\n" +
          "> **But it is a line chosen after seeing these four rows**, which is " +
          "[summary.md](../../docs/summary.md)'s lesson 8: a rule fitted on a corpus sits on the boundary " +
          `of the next one. **So the number to carry forward is ${oracleHits}/${sup.length}, not ` +
          `${fitted}/${sup.length}** -- the second one is quoted here to show what the failure costs, ` +
          "not to claim it is fixed.\n",
      );
    }
  }
  const errs = rec.rows.filter((r) => r.error);
  if (errs.length > 0) {
    console.log(
      `\n**${errs.length} of ${rec.rows.length} requests failed** and are excluded: ` +
        `${errs.map((r) => `${r.transcript} (${r.error?.slice(0, 60)})`).join("; ")}.`,
    );
  }
  // THE NUMBER THE DESIGN LIVES ON: all three stages, as a caller would run
  // them. Stage 2 being 3/4 and stage 3 being 2/4 do not multiply -- they have
  // to be composed on the same rows, because a stage-2 miss and a stage-3 miss
  // can land on the same transcript.
  console.log("\n### 3.2 The three stages composed, which is what a caller gets\n");
  console.log("| transcript | 1. detected | 2. jev's group | 3. its maximum | end to end |");
  console.log("| --- | --- | --- | --- | --- |");
  let e2e = 0;
  let e2eFitted = 0;
  for (const r of sup) {
    const t = ts.find((x) => x.id === r.transcript);
    const pick = r.jev?.choice ?? "";
    const got = t !== undefined && pick !== "" ? maxIn(t, pick) : undefined;
    const gotFitted = t !== undefined && pick !== "" ? maxIn(t, pick, true) : undefined;
    if (got?.hit) e2e += 1;
    if (gotFitted?.hit) e2eFitted += 1;
    console.log(
      `| \`${r.transcript}\` | ✓ | ${pick === r.want ? `\`${pick}\` ✓` : `\`${pick}\` ✗ (want \`${r.want}\`)`} | ` +
        `${got === undefined || got.line === "" ? "no numeric line" : `\`${got.line.slice(0, 22)}\``} | ` +
        `${got?.hit ? "**HIT**" : "miss"} |`,
    );
  }
  console.log(
    `\n**End to end: ${e2e} of ${sup.length}** on the superlative half ` +
      `(${e2eFitted}/${sup.length} with the fitted total-exclusion). ` +
      "**The two stages' scores do not multiply** -- `longest-doc` and `biggest-source` pass stage 2 and " +
      "fail stage 3 on the same line, `findings-links` fails stage 2 -- so the composed number is the " +
      "only one a caller would experience.\n\n" +
      `> **And that is the honest state of the comparison half: ${e2e}/${sup.length}.** ` +
      "docs/46 §3 left it at \"neither arm is established\"; this says why, and locates the two failures " +
      "in different stages. **It does not fix either one.**\n",
  );

  // AND THE ONE THAT STILL MISSES AFTER THE FITTED FIX IS THE SHARPEST ROW IN
  // THE FILE, so it gets its own paragraph rather than being folded into a
  // count. Command-level grouping is not a fine enough narrowing.
  const stillMissing = sup.filter((r) => {
    const t = ts.find((x) => x.id === r.transcript);
    return t !== undefined && !maxIn(t, r.want, true).hit;
  });
  if (stillMissing.length > 0) {
    console.log("\n### 3.3 Why one of them misses even with the fitted fix, and what that means\n");
    for (const r of stillMissing) {
      const t = ts.find((x) => x.id === r.transcript);
      if (t === undefined) continue;
      const es = commandGroups(t).get(r.want) ?? [];
      const got = maxIn(t, r.want, true);
      console.log(
        `\`${r.transcript}\` asks about **"${goalOf(t).slice(0, 44)}…"**. Its \`${r.want}\` group has ` +
          `${es.length} calls, and excluding totals the maximum is \`${got.line.slice(0, 44)}\` while the ` +
          `planted answer is \`${t.facts[0].text}\`.\n`,
      );
      console.log("| the group's calls | |");
      console.log("| --- | --- |");
      for (const e of es.slice(0, 12)) console.log(`| \`${e.label}\` | |`);
      console.log("");
    }
    console.log(
      "> **The command group is right and still too coarse.** The `wc` calls cover two different file " +
        "sets -- the reports and `experiments/` -- and the goal restricts to one of them (\"these " +
        "reports\"). The planted answer is the maximum *within the goal's scope* and the second largest " +
        "overall.\n>\n" +
        "> **So stage 2 has a sub-stage: group by command AND by argument scope.** " +
        "That is also why §2's shape-based narrowing pooled the same two sets -- it was the same mistake " +
        "one level up. **This is not measured here**; it is what §1.7's successor has to measure, and it " +
        "is a narrower thing to ask than anything in §1.7's three candidates.\n",
    );
  }

  console.log("\n## 4. Honest limits\n");
  console.log(
    `- **${rec.rows.length} transcripts, ${sup.length} of them superlative, one draw each.** ` +
      "§1.7's third candidate (wait for a bigger corpus) is untouched and is still the binding one: " +
      `${sup.length} rows cannot separate arms that differ by one row.\n` +
      "- **§1 is the durable part.** The goal-type predicate is one regex on the request, it reproduces " +
      "the hand-made split exactly, and it costs nothing -- so a front-end can branch on it whatever " +
      "happens to the rest of this file.\n" +
      "- **§2's narrowing failures are the durable part after that.** They do not depend on n: " +
      "\"right shape, wrong command\" is a structural objection to shape-based narrowing, and it is why " +
      "the design has three stages.\n" +
      "- **Stage 3's ceiling is measured here and it is not 4/4.** Even handed the correct command " +
      "group, arithmetic does not always land -- so \"narrow, then take the max\" is not sufficient even " +
      "with a perfect narrower.\n" +
      `- **The composed pipeline is ${e2e}/${sup.length}, and that is the number to quote** (§3.2). ` +
      "Stage 2's score and stage 3's score do not multiply; they have to be composed on the same rows.\n" +
      "- **§3.3's scoping failure is not measured, only located.** Grouping by command is too coarse " +
      "when one command was run over two different sets of arguments, and this corpus has one example. " +
      "Whether a judgment can pick the argument scope is the next question, not an answer here.\n" +
      "- **`--show` recomputes stage 3 rather than reading it from the record**, because the first " +
      "version of `leadingNumber` matched a number anywhere in the line and the stored values were " +
      "wrong. Derived arithmetic does not belong in a record when the inputs are in one already.\n" +
      "- **Still one corpus, written by me** ([TODO §2.1](../../TODO.md)). The superlative regex removes " +
      "my judgment from the LABEL, not from the transcripts.",
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--split")) {
    split();
    return;
  }
  if (argv.includes("--narrow")) {
    split();
    narrow();
    return;
  }
  if (argv.includes("--show")) {
    if (!existsSync(PATH)) throw new Error(`no ${PATH} -- run without --show first`);
    split();
    narrow();
    show(JSON.parse(readFileSync(PATH, "utf8")) as Record_);
    return;
  }
  split();
  narrow();
  const rows: Row[] = [];
  for (const t of corpus()) {
    const row = await ask(t);
    rows.push(row);
    process.stderr.write(
      `${t.id.padEnd(16)} want ${row.want.padEnd(8)} jev ${(row.jev?.choice ?? "ERR").padEnd(8)} ` +
        `free ${row.free.padEnd(8)} ${row.ms} ms${row.error ? `  ${row.error.slice(0, 60)}` : ""}\n`,
    );
    mkdirSync(RECORDS, { recursive: true });
    writeFileSync(PATH, `${JSON.stringify({ note: NOTE, rows }, null, 2)}\n`);
  }
  show({ note: NOTE, rows });
}

if (process.argv[1]?.endsWith("aggregate.ts")) await main();
