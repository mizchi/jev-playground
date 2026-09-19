/**
 * The compactor against a real model -- and the invention measurement
 * docs/39 §7 could not make.
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/compaction.ts
 *   npx tsx src/compaction.ts --report        # from the record, no key
 *
 * This is docs/06's homework (n) for the compactor, and it happens to be
 * homework (i) as well, because the compactor is THE ONE COMPONENT WHOSE
 * COMPARATOR HAS TO GENERATE TEXT. docs/39 §7 compared deletion against
 * EXTRACTIVE summarisers and said plainly what it could not reach:
 *
 *   > 捏造(抽象的要約が別の値を書く) —— 未測定(生成モデルが無い)
 *
 * The `claude` CLI works here, so it is reachable now. Two model arms, because
 * they answer different questions:
 *
 *   SELECT   name the entry ids to drop. The same ACTION as jev, so this is
 *            the ranking comparison homework (n) asks for.
 *   SUMMARISE  write a shorter transcript. The action jev CANNOT take -- it
 *            cannot generate text -- and the only arm that can invent.
 *
 * THE DENOMINATOR IS THE TRAP, and docs/06's homework (j) exists to name it:
 * invention has to be counted PER FACT THE SUMMARY TOUCHED, not per fact in
 * the corpus. A summary that says nothing invents nothing and would win.
 * `touched = kept + invented` here, and the rate is `invented / touched`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dropUntilFits, totalTokens, type Entry } from "../../../packages/jev-compact/src/compact.js";

/**
 * Declared here rather than imported from `run.ts`.
 *
 * `run.ts` ends in `await main()`, so importing anything from it RUNS the
 * guard and orchestration sweep. Two seconds of confusion and a stray
 * "186 rows" line in this file's output.
 */
const MODELS = { haiku: "claude-haiku-4-5-20251001", sonnet: "claude-sonnet-5" } as const;
type ModelName = keyof typeof MODELS;
const RECORDS = resolve(import.meta.dirname, "../records");
const PATH = resolve(RECORDS, "compaction.json");
const CORPUS = resolve(import.meta.dirname, "../../compact/records/corpus.json");
const RANKING = resolve(import.meta.dirname, "../../compact/records/ranking.json");

const FLOORS = { keepRecent: 6, keepGoal: true };
/** The tightest budget docs/39 used: where a summariser must compress hardest. */
const BUDGET = 0.25;

/** One recorded jev ranking of one transcript, from docs/39's run. */
interface Draw {
  transcript: string;
  repeat: number;
  ranked: { id: string; level: number }[];
  ms: number;
}

type Mode = "select" | "summarise";
type Arm = "jev" | `${ModelName}-${Mode}`;

interface Fact {
  text: string;
  entryId: string;
}

interface Transcript {
  id: string;
  entries: Entry[];
  facts: Fact[];
  tokens: number;
  goal: string;
}

/**
 * Split a fact into the part that IDENTIFIES it and the part that is its
 * VALUE, so "said something else about the same thing" is detectable.
 *
 * Three outcomes, and which one a fact gets decides whether it can carry the
 * invention test at all. The report lists each group from this function rather
 * than from a sentence, so the groups cannot drift:
 *
 *   { probe, value }         a (thing, value) fact. CHECKABLE for invention.
 *                              `661 docs/31-orchestration.md`  value then id
 *                              `dropAt: 1.5`                   id then value
 *                              `S: Thresholds = { ... }`        a named binding
 *   { probe, value: null }   an EXISTENCE fact: it names a thing and gives it
 *                            no value. `registerFlag("jev-advise"`. Kept iff
 *                            the identifier survives; never invented, because
 *                            there is nothing to substitute for.
 *   null                     no identifier to anchor on. `id: "orchestrate-turn"`
 *                            is the one on this corpus: `id` appears in any
 *                            summary of any scenario file, so it anchors
 *                            nothing. Verbatim or nothing, and out of the
 *                            invention denominator either way.
 */
export function probeOf(fact: string): { probe: string; value: string | null } | null {
  let m = fact.match(/^(\d+) (\S+)$/);
  if (m) return { probe: m[2], value: m[1] };
  m = fact.match(/^(\d+) (#\S+)/);
  if (m) return { probe: m[2], value: m[1] };
  // `registerFlag("jev-advise"` USED TO RETURN probe `registerFlag`, AND THAT
  // WAS A THIRD FALSE INVENTION ON THIS CORPUS. The probe has to be unique to
  // the fact, and `registerFlag` is shared by both of this transcript's facts
  // and by any sentence about the API. haiku's summary named both flags and
  // both defaults CORRECTLY, then wrote one closing line -- "Both set via
  // `pi.registerFlag()`" -- 400 characters below them; the window around that
  // lone occurrence held neither flag name, so one fact scored INVENTED
  // against a summary that got it right.
  //
  // The real shape of this fact is EXISTENCE: "this flag is registered". There
  // is no value to substitute, so it cannot be invented, only kept or lost --
  // which drops the invention denominator from 8 to 6, the honest denominator
  // rather than the flattering one.
  //
  // AND THE FIRST ATTEMPT AT THIS FIX RETURNED `null`, WHICH BROKE IT THE
  // OTHER WAY. `null` sends the fact to the verbatim fallback, and verbatim is
  // wrong for an arm that rewrites -- the lesson written at the top of `judge`.
  // Both summarise arms named both flags and both defaults correctly and then
  // scored 0/2, because a summary writes `` `"jev-advise"` `` in a bullet and
  // never the bytes `registerFlag("jev-advise"`. Fixing a false invention by
  // breaking a true keep is not a fix. So: `value: null`, kept iff the
  // IDENTIFIER survives, never checkable for invention.
  //
  // Detecting a summary that invents a flag that does not exist is a
  // DIFFERENT measurement -- precision of claims, not preservation of facts --
  // and nothing here measures it.
  m = fact.match(/^registerFlag\("([^"]+)"/);
  if (m) return { probe: m[1], value: null };
  m = fact.match(/^(\w+):\s*([\d.]+)$/);
  if (m) return { probe: m[1], value: m[2] };
  m = fact.match(/(\w+) = \{(.+)\}/);
  if (m) return { probe: m[1], value: m[2].trim() };
  return null;
}

export interface Row {
  transcript: string;
  arm: Arm;
  /** Facts still present verbatim. */
  kept: number;
  /** Facts whose identifier is present with a DIFFERENT value. */
  invented: number;
  /** Facts with neither. */
  absent: number;
  facts: number;
  /** How many of this transcript's facts can be checked for invention. */
  checkable: number;
  tokensAfter: number;
  budget: number;
  ms: number;
  /** What the model said, for the audit. Truncated. */
  sample?: string;
  error?: string;
}

interface Record_ {
  rows: Row[];
  note: string;
}

const load = (): Record_ =>
  existsSync(PATH)
    ? (JSON.parse(readFileSync(PATH, "utf8")) as Record_)
    : {
        rows: [],
        note:
          "The compactor against a real model. `select` is the same action as jev; " +
          "`summarise` is the action jev cannot take, and the only one that can invent.",
      };

const save = (r: Record_): void => {
  mkdirSync(RECORDS, { recursive: true });
  writeFileSync(PATH, `${JSON.stringify(r, null, 2)}\n`);
};

/**
 * Score a surviving text three ways -- AND NOT BY A VERBATIM MATCH.
 *
 * THE FIRST VERSION OF THIS COUNTED PARAPHRASE AS INVENTION. It asked whether
 * the fact string was present byte for byte, and on the very first run it
 * reported an invention for `661 docs/31-orchestration.md` because the
 * summary had written:
 *
 *   **Result:** `docs/31-orchestration.md` is the longest report at 661 lines.
 *
 * Right path, right number, reworded -- which is what summarising IS. A
 * verbatim check is correct for an arm that preserves bytes (jev's deletion,
 * and the `select` arm) and wrong for one that rewrites. Using it for both
 * would have produced exactly the result I came in expecting, which is the
 * signal to distrust it (docs/39 §7 learned this on the same corpus).
 *
 * So the check is a WINDOW around the identifier:
 *
 *   KEPT      the probe appears and the true value is near it.
 *   INVENTED  the probe appears, the true value is NOT near it, and another
 *             value of the same shape IS -- it says something else about the
 *             same thing, which is docs/37 §3's claim exactly.
 *   ABSENT    the probe is gone, or it is there with no value at all. A
 *             mention with the number dropped is a LOSS, not an invention.
 *
 * The window subsumes verbatim: a byte-preserved fact has its probe and value
 * adjacent. So every arm gets the same test, which is what makes it a
 * comparison. The two facts with no (probe, value) split fall back to
 * verbatim and are excluded from the invention rate.
 */
const WINDOW = 160;

function judge(t: Transcript, surviving: string): Omit<Row, "transcript" | "arm" | "tokensAfter" | "budget" | "ms"> {
  let kept = 0;
  let invented = 0;
  let absent = 0;
  let checkable = 0;
  for (const f of t.facts) {
    const split = probeOf(f.text);
    if (!split) {
      // No identifier to anchor on: verbatim or nothing, and not counted
      // towards invention either way.
      if (surviving.includes(f.text)) kept += 1;
      else absent += 1;
      continue;
    }
    if (split.value === null) {
      // An existence fact. The identifier survives or it does not; no window,
      // no invention, and not in the invention denominator.
      if (surviving.includes(split.probe)) kept += 1;
      else absent += 1;
      continue;
    }
    checkable += 1;
    const windows: string[] = [];
    for (let at = surviving.indexOf(split.probe); at >= 0; at = surviving.indexOf(split.probe, at + 1)) {
      windows.push(surviving.slice(Math.max(0, at - WINDOW), at + split.probe.length + WINDOW));
    }
    if (windows.length === 0) {
      absent += 1;
      continue;
    }
    if (windows.some((w) => w.includes(split.value))) {
      kept += 1;
      continue;
    }
    // The probe is there and the true value is not. Is something else there?
    const shape = /^[\d.]+$/.test(split.value) ? /[\d][\d.]*/ : /\S+/;
    if (windows.some((w) => shape.test(w.replace(split.probe, " ")))) {
      invented += 1;
      continue;
    }
    absent += 1;
  }
  return { kept, invented, absent, facts: t.facts.length, checkable };
}

/** The transcript, as the model has to see it: every entry, with its id. */
function asText(t: Transcript): string {
  return t.entries.map((e) => `<<${e.id}>> [${e.role}${e.label ? ` ${e.label}` : ""}]\n${e.text}`).join("\n\n");
}

const SELECT_PROMPT = (t: Transcript, budget: number): string =>
  [
    "You are compacting a coding agent's transcript so it fits a smaller context window.",
    `The goal of the session was: ${t.goal}`,
    "",
    `The transcript is about ${t.tokens} tokens and must come down to about ${budget}.`,
    "You may only DELETE whole entries. Do not rewrite anything.",
    "Keep whatever a continuation of this session would still need; drop what is spent.",
    "",
    "Answer with nothing but the ids to DELETE, one per line, in the form <<id>>.",
    "",
    asText(t),
  ].join("\n");

const SUMMARISE_PROMPT = (t: Transcript, budget: number): string =>
  [
    "You are compacting a coding agent's transcript so it fits a smaller context window.",
    `The goal of the session was: ${t.goal}`,
    "",
    `The transcript is about ${t.tokens} tokens and must come down to about ${budget}.`,
    "Rewrite it as a shorter transcript. You may summarise, merge and shorten freely.",
    "Keep whatever a continuation of this session would still need -- exact paths, exact",
    "numbers and exact error strings matter, because the next step will use them.",
    "",
    "Answer with nothing but the compacted transcript.",
    "",
    asText(t),
  ].join("\n");

/**
 * `claude -p` with the prompt on stdin, because 100 KB does not fit an argv.
 *
 * `spawn` and not `execFile`: `execFile`'s `input` option is silently
 * ignored -- that option belongs to `execFileSync` -- so the child waited
 * three seconds, warned "no stdin data received", and exited 1. The stderr
 * said so in plain words and the first read of it was mine being too quick.
 */
function ask(model: ModelName, prompt: string): Promise<{ out: string; ms: number; error?: string }> {
  const t0 = Date.now();
  return new Promise((done) => {
    const child = spawn("claude", ["-p", "--model", MODELS[model]], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    const timer = setTimeout(() => child.kill("SIGKILL"), 600_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({
        out,
        ms: Date.now() - t0,
        ...(code === 0 ? {} : { error: `exit ${code}: ${err.slice(0, 200)}` }),
      });
    });
    child.stdin.on("error", () => {
      /* the child may exit before the write finishes */
    });
    child.stdin.end(prompt);
  });
}

/**
 * Rescore the record from the stored model output. No requests.
 *
 * Scoring is a pure function of (transcript, surviving text), and the record
 * keeps the raw output, so a fix to the scorer must not need the models run
 * again -- which is also the only way a scoring fix is auditable: same bytes,
 * different verdict, and the diff of the record shows exactly which rows moved.
 *
 * Refuses a row whose `sample` is at the storage cap, because a truncated
 * output would score a fact past the cut as absent. Those rows have to be
 * re-run, and saying so beats rescoring them quietly.
 */
function rejudge(record: Record_, transcripts: Transcript[], draws: Draw[]): void {
  let moved = 0;
  for (const row of record.rows) {
    if (row.arm !== "jev" && !row.sample) continue;
    if (row.sample && row.sample.length >= 200_000) {
      console.log(`  ${row.transcript} ${row.arm}: sample at the cap, re-run this row instead`);
      continue;
    }
    const t = transcripts.find((x) => x.id === row.transcript);
    if (!t) continue;
    let surviving: string;
    if (row.arm === "jev") {
      // jev's rows carry no `sample` because nothing was generated: the
      // ranking is replayed and the surviving text is a pure function of it.
      // They still have to be rescored, or `checkable` goes stale and §2's
      // denominator is read off a row the fix never touched.
      const d = draws.find((x) => x.transcript === row.transcript && x.repeat === 0);
      if (!d) continue;
      const byId = new Map(t.entries.map((e) => [e.id, e]));
      const order = d.ranked.map((r) => byId.get(r.id)).filter((e): e is Entry => Boolean(e));
      surviving = dropUntilFits(t.entries, order, row.budget, FLOORS).keep.map((e) => e.text).join("\n");
    } else if (row.arm.endsWith("-select")) {
      const named = new Set([...(row.sample as string).matchAll(/<<([^>]+)>>/g)].map((m) => m[1]));
      const order = t.entries.filter((e) => named.has(e.id));
      surviving = dropUntilFits(t.entries, order, row.budget, FLOORS).keep.map((e) => e.text).join("\n");
    } else {
      surviving = row.sample as string;
    }
    const before = `${row.kept}/${row.invented}/${row.absent}/${row.checkable}`;
    Object.assign(row, judge(t, surviving));
    const after = `${row.kept}/${row.invented}/${row.absent}/${row.checkable}`;
    if (before !== after) {
      console.log(`  ${row.transcript.padEnd(16)} ${row.arm.padEnd(18)} ${before} -> ${after}`);
      moved += 1;
    }
  }
  save(record);
  console.log(`\n  ${moved} of ${record.rows.length} rows changed verdict.\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const record = load();
  if (args.includes("--report")) {
    report(record);
    return;
  }
  const transcripts = (JSON.parse(readFileSync(CORPUS, "utf8")) as { transcripts: Transcript[] }).transcripts;
  if (args.includes("--rejudge")) {
    rejudge(record, transcripts, (JSON.parse(readFileSync(RANKING, "utf8")) as { draws: Draw[] }).draws);
    report(record);
    return;
  }
  const draws = (JSON.parse(readFileSync(RANKING, "utf8")) as { draws: Draw[] }).draws;
  const only = args.includes("--arms") ? args[args.indexOf("--arms") + 1].split(",") : null;

  for (const t of transcripts) {
    const budget = Math.round(t.tokens * BUDGET);
    const byId = new Map(t.entries.map((e) => [e.id, e]));

    // jev: the shipped deletion, from the recorded answers. No new requests.
    if ((!only || only.includes("jev")) && !record.rows.some((r) => r.transcript === t.id && r.arm === "jev")) {
      const d = draws.find((x) => x.transcript === t.id && x.repeat === 0);
      if (d) {
        const order = d.ranked.map((r) => byId.get(r.id)).filter((e): e is Entry => Boolean(e));
        const { keep } = dropUntilFits(t.entries, order, budget, FLOORS);
        const surviving = keep.map((e) => e.text).join("\n");
        record.rows.push({
          transcript: t.id,
          arm: "jev",
          ...judge(t, surviving),
          tokensAfter: totalTokens(keep),
          budget,
          // The REAL latency of the one request docs/39 recorded for this
          // transcript, not a zero. A zero here printed as "median 0 ms" in
          // the latency column, which reads as instant and is not what was
          // measured: jev spent one request, it just spent it in docs/39's run
          // rather than in this one.
          ms: d.ms,
        });
        save(record);
      }
    }

    for (const model of ["haiku", "sonnet"] as ModelName[]) {
      for (const mode of ["select", "summarise"] as Mode[]) {
        const arm = `${model}-${mode}` as Arm;
        if (only && !only.includes(arm)) continue;
        if (record.rows.some((r) => r.transcript === t.id && r.arm === arm)) continue;
        const prompt = mode === "select" ? SELECT_PROMPT(t, budget) : SUMMARISE_PROMPT(t, budget);
        const got = await ask(model, prompt);
        let surviving: string;
        let tokensAfter: number;
        if (mode === "select") {
          // Its deletion, applied through the SAME closure jev's goes through,
          // so a model that names half a tool-call pair is not penalised for
          // something the code fixes for every arm.
          const named = new Set([...got.out.matchAll(/<<([^>]+)>>/g)].map((m) => m[1]));
          const order = t.entries.filter((e) => named.has(e.id));
          const { keep } = dropUntilFits(t.entries, order, budget, FLOORS);
          surviving = keep.map((e) => e.text).join("\n");
          tokensAfter = totalTokens(keep);
        } else {
          surviving = got.out;
          tokensAfter = Math.ceil(got.out.length / 4);
        }
        record.rows.push({
          transcript: t.id,
          arm,
          ...judge(t, surviving),
          tokensAfter,
          budget,
          ms: got.ms,
          // The WHOLE output, because `--rejudge` rescores from this field and
          // a truncated sample would score a fact past the cut as absent. The
          // first cap was 4,000 and two sonnet-summarise rows hit it exactly,
          // which is what a cap looks like when it is doing damage.
          sample: got.out.slice(0, 200_000),
          ...(got.error ? { error: got.error } : {}),
        });
        save(record);
        const r = record.rows[record.rows.length - 1];
        console.log(
          `  ${t.id.padEnd(16)} ${arm.padEnd(18)} kept ${r.kept}/${r.facts} invented ${r.invented} ` +
            `absent ${r.absent}  ${String(r.tokensAfter).padStart(6)}/${r.budget} tok  ${String(r.ms).padStart(6)} ms` +
            (r.error ? `  ERROR ${r.error.slice(0, 60)}` : ""),
        );
      }
    }
  }
  save(record);
  console.log(`\n  ${record.rows.length} rows in records/compaction.json`);
}

const pct = (x: number, n: number): string => (n === 0 ? "    -" : `${((100 * x) / n).toFixed(0).padStart(4)}%`);

function report(record: Record_): void {
  // The corpus is a committed record, so the report can name its own facts
  // without an API key -- which is what makes the un-checkable list computed
  // rather than remembered.
  const facts: string[] | null = existsSync(CORPUS)
    ? (JSON.parse(readFileSync(CORPUS, "utf8")) as { transcripts: Transcript[] }).transcripts.flatMap((t) =>
        t.facts.map((f) => f.text),
      )
    : null;
  const arms: Arm[] = ["jev", "haiku-select", "sonnet-select", "haiku-summarise", "sonnet-summarise"];
  console.log("\n  docs/06 homework (n) for the compactor -- and homework (i), which needed a");
  console.log("  model that can generate text. Budget: a quarter of each transcript.\n");
  console.log("§1 what survived -- and whether the budget was met at all");
  console.log(
    "\n  READ `over budget` FIRST. Keeping every fact is trivial if nothing is\n" +
      "  deleted, and the budget is the whole reason a compactor runs. An arm that\n" +
      "  kept 100% of the facts while leaving the transcript over budget did not\n" +
      "  compact it; it declined to.\n",
  );
  console.log("  arm                 facts kept   INVENTED   absent   over budget   tokens left / budget   median ms");
  for (const arm of arms) {
    const xs = record.rows.filter((r) => r.arm === arm);
    if (xs.length === 0) continue;
    const ms = [...xs.map((r) => r.ms)].sort((a, b) => a - b);
    const facts = xs.reduce((n, r) => n + r.facts, 0);
    const over = xs.filter((r) => r.tokensAfter > r.budget).length;
    console.log(
      `  ${arm.padEnd(18)} ${pct(xs.reduce((n, r) => n + r.kept, 0), facts)} ` +
        `${String(xs.reduce((n, r) => n + r.invented, 0)).padStart(10)} ` +
        `${String(xs.reduce((n, r) => n + r.absent, 0)).padStart(8)}   ` +
        `${`${over}/${xs.length}`.padStart(11)}   ` +
        `${xs.reduce((n, r) => n + r.tokensAfter, 0)} / ${xs.reduce((n, r) => n + r.budget, 0)}`.padStart(20) +
        `${String(ms[Math.floor(ms.length / 2)] ?? 0).padStart(12)}`,
    );
  }
  console.log(
    "\n  jev's `median ms` is the latency docs/39 RECORDED for the same request; the\n" +
      "  ranking is replayed from `experiments/compact/records/ranking.json` rather\n" +
      "  than asked again, so it is a real measurement from another run, not this one.",
  );

  console.log("\n§1b per transcript, because the sums above hide which arm missed where\n");
  console.log("  transcript        arm                 kept   inv   tokens / budget   fits");
  for (const t of [...new Set(record.rows.map((r) => r.transcript))]) {
    for (const arm of arms) {
      const r = record.rows.find((x) => x.transcript === t && x.arm === arm);
      if (!r) continue;
      console.log(
        `  ${(arm === "jev" ? t : "").padEnd(17)} ${arm.padEnd(18)} ` +
          `${`${r.kept}/${r.facts}`.padStart(5)} ${String(r.invented).padStart(5)}   ` +
          `${`${r.tokensAfter} / ${r.budget}`.padStart(15)}   ${r.tokensAfter <= r.budget ? "yes" : "NO"}`,
      );
    }
  }

  console.log("\n§2 invention, on the denominator homework (j) insisted on");
  console.log(
    "\n  Counted per fact the arm TOUCHED (kept + invented), not per fact in the corpus:\n" +
      "  an arm that says nothing invents nothing and would otherwise win.\n",
  );
  console.log("  arm                 touched   invented   invention rate");
  for (const arm of arms) {
    const xs = record.rows.filter((r) => r.arm === arm);
    if (xs.length === 0) continue;
    const kept = xs.reduce((n, r) => n + r.kept, 0);
    const inv = xs.reduce((n, r) => n + r.invented, 0);
    console.log(
      `  ${arm.padEnd(18)} ${String(kept + inv).padStart(7)} ${String(inv).padStart(10)}   ${pct(inv, kept + inv)}`,
    );
  }
  const checkable = record.rows.filter((r) => r.arm === "jev").reduce((n, r) => n + r.checkable, 0);
  const allFacts = record.rows.filter((r) => r.arm === "jev").reduce((n, r) => n + r.facts, 0);
  console.log(`\n  >> ${checkable} of ${allFacts} facts can be checked for invention at all.`);
  // WHICH facts, listed from `probeOf` itself rather than from a sentence I
  // wrote once. The old version named two examples in prose, and when the
  // `registerFlag` facts moved out of the denominator the prose still said
  // "the other 1" -- a canned conclusion outliving its own table, which is
  // the fifth time that shape has appeared in this repo's reports.
  if (facts) {
    const existence = facts.filter((f) => probeOf(f)?.value === null);
    const none = facts.filter((f) => probeOf(f) === null);
    if (existence.length > 0) {
      console.log(
        `     ${existence.length} are EXISTENCE facts -- ${existence.map((f) => `\`${f}\``).join(", ")} --\n` +
          "     which name a thing rather than give it a value. Nothing can be substituted\n" +
          "     for a value that is not there, so they are scored kept-or-lost on the\n" +
          "     identifier and left out of the invention rate.",
      );
    }
    if (none.length > 0) {
      console.log(
        `     ${none.length} have no identifier that survives being reworded: ${none.map((f) => `\`${f}\``).join(", ")}.\n` +
          "     Those fall back to a verbatim check, which a summarising arm will fail\n" +
          "     even when it is right -- so they are out of the invention rate too.",
      );
    }
  }
  console.log(
    "\n     AND TWO FALSE INVENTIONS WERE FOUND AND REMOVED GETTING HERE, both on\n" +
      "     `flag-registry`, both against summaries that were CORRECT. The first\n" +
      "     version anchored on `registerFlag`, a token both facts share; the second\n" +
      "     fixed that by demanding the bytes, which no summary writes. The reported\n" +
      "     invention count is what survived looking for the mistake twice.\n",
  );
  console.log(`  ${record.rows.length} rows.\n`);
}

/**
 * Only when run as the entry point.
 *
 * A bare `await main()` here meant that `test.ts` importing `probeOf` RAN the
 * whole comparison, printing "40 rows in records/compaction.json" in the
 * middle of the test output -- the same trap this file's own header records
 * about importing from `run.ts`, walked into one file later.
 */
if (process.argv[1]?.endsWith("compaction.ts")) await main();
