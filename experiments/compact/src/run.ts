/**
 * Ask jev to rank each transcript's entries, once, and record the raw answers.
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/run.ts
 *   npx tsx src/run.ts --repeats 3
 *
 * ONE REQUEST PER TRANSCRIPT PER REPEAT, and that is the whole cost: the
 * scores do not depend on the budget, so every budget level in the report is
 * recomputed locally from these levels. docs/19 §4's rule -- a question about
 * a recorded run is answered from the record, and asking again answers a
 * different question.
 *
 * Repeats exist because `score` is a draw. docs/25's rule is that a gap is
 * compared against the noise, and the noise here is the same transcript
 * answered twice; without repeats a two-point win over `oldest` cannot be
 * told from the same transcript asked on a different afternoon.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Jev } from "../../../packages/jev-core/src/index.js";
import { DEFAULT_COMPACT_CONFIG, compact, pinned, totalTokens } from "../../../packages/jev-compact/src/compact.js";
import type { Transcript } from "./corpus.js";

const HERE = import.meta.dirname;
const RECORDS = resolve(HERE, "../records");

export interface Draw {
  transcript: string;
  repeat: number;
  /** Every candidate's continuous level, most spent first. */
  ranked: { id: string; level: number; confidence: number }[];
  /** The escape hatch: "nothing here is spare". */
  nothingSpare: number;
  outcome: string;
  ms: number;
  usage?: { input: number; output: number };
  error?: string;
}

export interface Record_ {
  draws: Draw[];
  note: string;
}

export function loadCorpus(): Transcript[] {
  const path = resolve(RECORDS, "corpus.json");
  if (!existsSync(path)) throw new Error("no records/corpus.json -- run `npm run corpus` first");
  return (JSON.parse(readFileSync(path, "utf8")) as { transcripts: Transcript[] }).transcripts;
}

export function loadRecord(): Record_ {
  const path = resolve(RECORDS, "ranking.json");
  if (!existsSync(path)) {
    return {
      draws: [],
      note: "One `score` question per candidate entry, batched into one request per transcript per repeat.",
    };
  }
  return JSON.parse(readFileSync(path, "utf8")) as Record_;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repeats = args.includes("--repeats") ? Number(args[args.indexOf("--repeats") + 1]) : 3;
  const transcripts = loadCorpus();
  const record = loadRecord();
  const jev = new Jev({ timeoutMs: 40_000 });
  mkdirSync(RECORDS, { recursive: true });
  const path = resolve(RECORDS, "ranking.json");

  for (let repeat = 0; repeat < repeats; repeat += 1) {
    for (const t of transcripts) {
      // Resume an interrupted run rather than paying for it twice.
      if (record.draws.some((d) => d.transcript === t.id && d.repeat === repeat)) continue;
      /**
       * The budget is EXACTLY THE FLOOR, which is the tightest budget that
       * still gets every entry a question.
       *
       * Not 1 token, which was the first attempt: `compact` returns
       * `cannot-fit` without asking anything when the pinned floor alone
       * exceeds the budget, so all eight transcripts came back with an empty
       * ranking and cost nothing, which looked like a key problem and was
       * arithmetic. At the floor exactly, the `floor > budget` guard is false
       * and the `already within budget` guard is false too.
       *
       * `maxCandidates` is raised past the transcript length for a related
       * reason: the shipped 200 is a cost cap for a resident agent, and a cap
       * that silently skipped entries would let a ranking look good by never
       * being asked about the entry it would have got wrong.
       */
      const floorTokens = totalTokens(t.entries.filter((e) => pinned(t.entries, DEFAULT_COMPACT_CONFIG).has(e.id)));
      const result = await compact(
        t.entries,
        { goal: t.goal, cwd: "/home/user/jev-playground" },
        {
          jev,
          config: {
            ...DEFAULT_COMPACT_CONFIG,
            budgetTokens: floorTokens,
            maxCandidates: 1_000,
            // The hatch is recorded, not acted on: `nothing-spare` returns
            // the ranking too, and whether to obey it is a question for the
            // report, at whatever cutoff.
            nothingSpareAt: 2,
          },
        },
      );
      const draw: Draw = {
        transcript: t.id,
        repeat,
        ranked: result.ranked.map((r) => ({ id: r.entry.id, level: r.level, confidence: r.confidence })),
        nothingSpare: result.nothingSpare,
        outcome: result.outcome,
        ms: result.ms,
        usage: result.usage,
        error: result.error,
      };
      record.draws.push(draw);
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
      const levels = draw.ranked.map((r) => r.level).filter((l) => Number.isFinite(l));
      console.log(
        `  ${t.id.padEnd(16)} r${repeat} ${draw.outcome.padEnd(11)} ` +
          `${String(draw.ranked.length).padStart(3)} ranked  ` +
          `levels ${levels.length ? `${Math.min(...levels).toFixed(2)}..${Math.max(...levels).toFixed(2)}` : "-"}  ` +
          `spare ${Number.isFinite(draw.nothingSpare) ? draw.nothingSpare.toFixed(2) : "-"}  ` +
          `${String(draw.ms).padStart(5)} ms  in ${draw.usage?.input ?? "-"}` +
          (draw.error ? `  ERROR ${draw.error.slice(0, 80)}` : ""),
      );
    }
  }
  const input = record.draws.reduce((s, d) => s + (d.usage?.input ?? 0), 0);
  console.log(`\n  ${record.draws.length} draws, ${input} input tokens, $${((input / 1e6) * 0.042).toFixed(4)}`);
}

if (process.argv[1]?.endsWith("run.ts")) await main();
