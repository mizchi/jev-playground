/**
 * Ask each turn both ways, several times, and record every answer.
 *
 *   TYPESAFE_API_KEY=... npx tsx src/run.ts --repeat 4
 *
 * `jev-hermes` combines the model router's, the skill router's and the
 * orchestrator's questions into ONE request, and the reason to expect that to
 * be free is docs/29 §4: 74 questions asked together and one at a time gave
 * 99.8% of answers within 0.25 for a third of the tokens. But that fan-out was
 * many questions of one KIND over one STATE, and this is three states unioned
 * behind one `what` sentence. The neighbouring move in the same report -- a
 * question's subject pushed into the state -- cost 47 points of agreement.
 *
 * So: two ways, the same turns, repeated. What the repeats buy is the only
 * thing that makes the comparison readable -- the draw spread WITHIN one way.
 * An answer that moves 0.2 between the two ways has said nothing if it also
 * moves 0.2 between two draws of the same way, which is the mistake docs/09
 * warned about and docs/36 §5.2 had to correct a published claim over.
 *
 * Everything is recorded raw, so `report.ts` can re-read it at any cutoff
 * with no further requests (docs/19 §4).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Jev } from "../../../packages/jev-core/src/index.js";
import { askCombined, askSeparately, type TurnConfig } from "../../../packages/jev-hermes/src/turn.js";
import { HERMES_ROUTER } from "../../../packages/jev-hermes/src/tiers.js";
import { TURNS } from "./requests.js";

export type Way = "combined" | "separate";
export const WAYS: Way[] = ["combined", "separate"];

export interface Draw {
  turn: string;
  way: Way;
  repeat: number;
  /** Every numeric answer, by question key. */
  answers: Record<string, number>;
  /** The `choice` answer's label, which is not a number. */
  topology: string | null;
  requests: number;
  inputTokens: number;
  ms: number;
  error?: string;
}

export interface Record_ {
  draws: Draw[];
  config: { framing: string; cuts: number[] | null; tiers: string[] };
}

const RECORDS = resolve(import.meta.dirname, "../records");
const PATH = resolve(RECORDS, "combine.json");

const CONFIG: TurnConfig = { router: HERMES_ROUTER, framing: "cost", orchestrate: true };

function load(): Record_ {
  if (existsSync(PATH)) return JSON.parse(readFileSync(PATH, "utf8")) as Record_;
  return {
    draws: [],
    config: {
      framing: CONFIG.framing,
      cuts: HERMES_ROUTER.cuts,
      tiers: HERMES_ROUTER.tiers.map((t) => t.label),
    },
  };
}

function save(record: Record_): void {
  mkdirSync(RECORDS, { recursive: true });
  writeFileSync(PATH, `${JSON.stringify(record, null, 2)}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (name: string, fallback: string): string => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : (args[i + 1] ?? fallback);
  };
  const repeats = Number.parseInt(opt("repeat", "4"), 10);
  const only = args.includes("--turn") ? opt("turn", "") : "";
  const turns = only ? TURNS.filter((t) => t.id === only) : TURNS;

  const record = load();
  const jev = new Jev({ timeoutMs: 20_000 });

  for (let repeat = 0; repeat < repeats; repeat += 1) {
    for (const turn of turns) {
      for (const way of WAYS) {
        // Skip what is already recorded, so an interrupted run resumes.
        if (record.draws.some((d) => d.turn === turn.id && d.way === way && d.repeat === repeat)) continue;
        const input = { task: turn.text, cwd: process.cwd() };
        const result = way === "combined" ? await askCombined(input, CONFIG, { jev }) : await askSeparately(input, CONFIG, { jev });
        const answers: Record<string, number> = {};
        let topology: string | null = null;
        for (const [key, a] of Object.entries(result.response?.answers ?? {})) {
          if (a.type === "noul") answers[key] = a.noul;
          else if (a.type === "score") {
            answers[key] = a.score;
            answers[`${key}__confidence`] = a.confidence;
          } else {
            topology = a.choice;
            answers[`${key}__confidence`] = a.confidence;
            // The whole distribution: a `choice` returns all of it, so the
            // comparison can look at how much probability moved even when the
            // top label did not.
            for (const [name, p] of Object.entries(a.probabilities)) answers[`${key}__p_${name}`] = p;
          }
        }
        record.draws.push({
          turn: turn.id,
          way,
          repeat,
          answers,
          topology,
          requests: result.requests,
          inputTokens: result.response?.usage.input_tokens ?? 0,
          ms: result.ms,
          error: result.error,
        });
        save(record);
        process.stdout.write(
          `  ${String(repeat).padStart(2)} ${turn.id.padEnd(18)} ${way.padEnd(9)} ` +
            `${String(result.requests)} req ${String(result.response?.usage.input_tokens ?? 0).padStart(5)} tok ` +
            `${String(result.ms).padStart(5)} ms${result.error ? `  ERROR ${result.error.slice(0, 60)}` : ""}\n`,
        );
      }
    }
  }
  const usage = jev.usage();
  console.log(
    `\n  ${record.draws.length} draws recorded  ·  ${usage.calls} calls, ${usage.input} input tokens, $${usage.usd.toFixed(4)}`,
  );
}

if (process.argv[1]?.endsWith("run.ts")) await main();
