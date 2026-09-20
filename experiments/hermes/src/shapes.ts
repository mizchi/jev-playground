/**
 * docs/06 homework (f): docs/37 §6 measured WHETHER to union the three
 * components' states. It did not measure WHICH union.
 *
 *   TYPESAFEAI_API_KEY=... npx tsx src/shapes.ts
 *   npx tsx src/shapes.ts --repeat 4
 *   npx tsx src/shapes.ts --report          # from the record, no key
 *
 * `packages/jev-hermes/src/turn.ts` makes three choices about the union's
 * shape and says so in its own comments -- none of them measured:
 *
 *   ONE `what`. The three components each phrase "what this is" for their own
 *   question, and the union collapses them into a single sentence.
 *   NO DUPLICATE `cwd`. The model router already carries the working
 *   directory as `working_directory`, so the orchestrator's `cwd` is dropped,
 *   on the reasoning that one fact under two names "reads as two facts".
 *   FLAT. Every component's keys sit at the top level rather than nested
 *   under a name, which the file does not even flag as a choice.
 *
 * So four shapes carrying THE SAME FACTS, differing only in arrangement:
 *
 *   shipped     one `what`, `cwd` dropped, flat
 *   threewhats  each component's own `what` kept under its own key
 *   dupcwd      the working directory under both names
 *   nested      each component's state under `model:` / `orchestration:`
 *
 * THE QUESTIONS ARE IDENTICAL IN ALL FOUR. Only `stateFor` changes, so a
 * difference is the state's shape and not the asking.
 *
 * Scored the way docs/37 §6 scored combining, because that is the only way a
 * shift means anything: an answer that moves between shapes by less than it
 * moves between repeats of ONE shape has not moved. The same report found
 * seven of seven answers clearing that bar for combining -- which is the
 * reason to expect arrangement to matter too, and the reason not to assume it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Jev } from "../../../packages/jev-core/src/index.js";
import { questionsFor, stateFor, type TurnConfig, type TurnInput } from "../../../packages/jev-hermes/src/turn.js";
import { HERMES_ROUTER } from "../../../packages/jev-hermes/src/tiers.js";
import { stateFor as modelState } from "../../../packages/jev-model-router/src/route.js";
import { stateFor as orchestratorState } from "../../../packages/jev-orchestrator/src/plan.js";
import { drawNoise, type Sample } from "../../shared/thresholds.js";
import { TURNS } from "./requests.js";

const RECORDS = resolve(import.meta.dirname, "../records");
const PATH = resolve(RECORDS, "shapes.json");

export const SHAPES = ["shipped", "threewhats", "dupcwd", "nested"] as const;
export type Shape = (typeof SHAPES)[number];

const CONFIG: TurnConfig = { router: HERMES_ROUTER, framing: "cost", orchestrate: true };

/**
 * The same facts, arranged four ways.
 *
 * `shipped` delegates to the real `stateFor`, so this experiment cannot drift
 * away from what the package actually sends. The other three are built from
 * the same two component states it merges.
 */
function shapeState(shape: Shape, input: TurnInput, config: TurnConfig): Record<string, unknown> {
  if (shape === "shipped") return stateFor(input, config);

  const model = modelState(input, config.router) as Record<string, unknown>;
  const work = orchestratorState({ request: input.task, cwd: input.cwd, files: input.files }) as Record<string, unknown>;
  const { what: modelWhat, ...modelRest } = model;
  const { what: workWhat, request: workRequest, cwd: workCwd, ...workRest } = work;
  const UNION_WHAT =
    "one turn of a coding agent: the request below, and what it implies about how much model it " +
    "needs, which skills it calls for, and whether it is work for more than one agent. Judge the " +
    "request, not the agent.";

  if (shape === "threewhats") {
    // Each component's own sentence, kept. The collision the union exists to
    // resolve, left unresolved instead.
    return {
      what: UNION_WHAT,
      what_for_the_model_question: modelWhat,
      what_for_the_orchestration_question: workWhat,
      ...modelRest,
      ...workRest,
    };
  }
  if (shape === "dupcwd") {
    // The working directory under both names, which is what the union drops.
    return { what: UNION_WHAT, ...modelRest, ...workRest, cwd: workCwd };
  }
  // `nested`: no key collisions to resolve at all, because nothing shares a
  // namespace. The cost is that a fact now has a path rather than a name.
  return {
    what: UNION_WHAT,
    request: workRequest,
    model_context: { what: modelWhat, ...modelRest },
    orchestration_context: { what: workWhat, cwd: workCwd, ...workRest },
  };
}

interface Draw {
  turn: string;
  shape: Shape;
  repeat: number;
  answers: Record<string, number>;
  topology: string | null;
  inputTokens: number;
  ms: number;
  error?: string;
}

interface Record_ {
  draws: Draw[];
  note: string;
}

const load = (): Record_ =>
  existsSync(PATH)
    ? (JSON.parse(readFileSync(PATH, "utf8")) as Record_)
    : { draws: [], note: "The same facts arranged four ways; identical questions. docs/06 homework (f)." };

const save = (r: Record_): void => {
  mkdirSync(RECORDS, { recursive: true });
  writeFileSync(PATH, `${JSON.stringify(r, null, 2)}\n`);
};

function report(): void {
  const record = load();
  if (record.draws.length === 0) throw new Error("no records/shapes.json -- run without --report first");
  const repeats = new Set(record.draws.map((d) => d.repeat)).size;
  const keys = [...new Set(record.draws.flatMap((d) => Object.keys(d.answers)))].filter((k) => !k.includes("__p_"));
  console.log(`\n  docs/06 homework (f): does the union's SHAPE change the answers?`);
  console.log(`  ${record.draws.length} draws, ${SHAPES.length} shapes x ${TURNS.length} turns x ${repeats} repeats.`);
  console.log("  Identical questions in all four; only `stateFor` differs.\n");

  // ------------------------------------------------- the bar a shift must clear

  const noise: Sample[] = [];
  for (const d of record.draws) {
    for (const k of keys) {
      const v = d.answers[k];
      if (Number.isFinite(v)) noise.push({ value: v, positive: false, group: `${d.turn}/${d.shape}/${k}` });
    }
  }
  const within = drawNoise(noise);
  console.log("§1 the bar");
  console.log(
    `\n  repeats of ONE shape on one turn move an answer by sd ${within.sd.toFixed(4)}` +
      ` (widest ${within.maxSpread.toFixed(3)}, ${within.groups} cells)\n`,
  );
  console.log(
    "  >> That is the noise a shape difference has to clear. docs/37 §6 used the same\n" +
      "     bar for combining and found all seven answers over it.\n",
  );

  // -------------------------------------------- did any answer move by shape

  console.log("§2 how far each answer moves when the shape changes");
  console.log("\n  answer                          shipped   threewhats   dupcwd   nested   spread   vs noise");
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  let moved = 0;
  for (const k of keys) {
    const per = SHAPES.map((shape) =>
      mean(record.draws.filter((d) => d.shape === shape).map((d) => d.answers[k]).filter((v) => Number.isFinite(v))),
    );
    if (per.some((v) => !Number.isFinite(v))) continue;
    const spread = Math.max(...per) - Math.min(...per);
    const ratio = within.sd === 0 ? Number.POSITIVE_INFINITY : spread / within.sd;
    if (ratio > 1) moved += 1;
    console.log(
      `  ${k.slice(0, 30).padEnd(30)} ${per.map((v) => v.toFixed(3).padStart(8)).join(" ")}  ` +
        `${spread.toFixed(3).padStart(7)}   ${ratio.toFixed(2).padStart(5)}x${ratio > 1 ? " <-" : ""}`,
    );
  }
  console.log(
    `\n  >> ${moved} of ${keys.length} answers move further between shapes than between repeats\n` +
      "     of one shape. An answer at or under 1x has not been shown to care how the\n" +
      "     state is arranged.\n",
  );

  // ------------------------------------------------ and did a decision change

  console.log("§3 did any DECISION change?");
  console.log("\n  turn                  topology by shape");
  let disagreed = 0;
  for (const turn of TURNS) {
    const per = SHAPES.map((shape) => {
      const tops = record.draws.filter((d) => d.turn === turn.id && d.shape === shape).map((d) => d.topology);
      const counts = new Map<string, number>();
      for (const t of tops) if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "-";
    });
    if (new Set(per).size > 1) disagreed += 1;
    console.log(
      `  ${turn.id.slice(0, 20).padEnd(20)}  ${per.map((p, i) => `${SHAPES[i]}=${p}`).join("  ")}` +
        (new Set(per).size > 1 ? "   <- disagree" : ""),
    );
  }
  console.log(
    `\n  >> ${disagreed} of ${TURNS.length} turns pick a different topology under a different shape.\n` +
      "     docs/37 §6's lesson applies here too: a moved answer only matters where it\n" +
      "     crosses a cutoff, and the topology is the one answer that IS a decision.\n",
  );

  // ------------------------------------------------------------- what it costs

  console.log("§4 what each shape costs");
  console.log("\n  shape        input tokens   vs shipped   ms");
  const base = mean(record.draws.filter((d) => d.shape === "shipped").map((d) => d.inputTokens));
  for (const shape of SHAPES) {
    const of = record.draws.filter((d) => d.shape === shape);
    const t = mean(of.map((d) => d.inputTokens));
    console.log(
      `  ${shape.padEnd(12)} ${t.toFixed(0).padStart(12)}   ${`${t - base > 0 ? "+" : ""}${(t - base).toFixed(0)}`.padStart(10)}   ` +
        `${mean(of.map((d) => d.ms)).toFixed(0).padStart(5)}`,
    );
  }
  const totalTokens = record.draws.reduce((n, d) => n + d.inputTokens, 0);
  console.log(`\n  ${record.draws.length} requests, ${totalTokens} input tokens, $${((totalTokens / 1e6) * 0.042).toFixed(4)}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--report")) {
    report();
    return;
  }
  const repeats = args.includes("--repeat") ? Number(args[args.indexOf("--repeat") + 1]) : 4;
  const record = load();
  const jev = new Jev({ timeoutMs: 20_000 });

  for (let repeat = 0; repeat < repeats; repeat += 1) {
    for (const turn of TURNS) {
      for (const shape of SHAPES) {
        if (record.draws.some((d) => d.turn === turn.id && d.shape === shape && d.repeat === repeat)) continue;
        const input: TurnInput = { task: turn.text, cwd: process.cwd() };
        const started = Date.now();
        let draw: Draw;
        try {
          const res = await jev.ask(shapeState(shape, input, CONFIG), questionsFor(input, CONFIG));
          const answers: Record<string, number> = {};
          let topology: string | null = null;
          for (const [key, a] of Object.entries(res.answers)) {
            if (a.type === "noul") answers[key] = a.noul;
            else if (a.type === "score") {
              answers[key] = a.score;
              answers[`${key}__confidence`] = a.confidence;
            } else {
              topology = a.choice;
              answers[`${key}__confidence`] = a.confidence;
              for (const [name, p] of Object.entries(a.probabilities)) answers[`${key}__p_${name}`] = p;
            }
          }
          draw = {
            turn: turn.id,
            shape,
            repeat,
            answers,
            topology,
            inputTokens: res.usage.input_tokens,
            ms: Date.now() - started,
          };
        } catch (err) {
          draw = {
            turn: turn.id,
            shape,
            repeat,
            answers: {},
            topology: null,
            inputTokens: 0,
            ms: Date.now() - started,
            error: String(err).slice(0, 200),
          };
        }
        record.draws.push(draw);
        save(record);
        console.log(
          `  ${String(repeat).padStart(2)} ${turn.id.padEnd(18)} ${draw.shape.padEnd(11)} ` +
            `${String(draw.inputTokens).padStart(5)} tok ${String(draw.ms).padStart(5)} ms` +
            (draw.error ? `  ERROR ${draw.error.slice(0, 60)}` : ""),
        );
      }
    }
  }
  const tokens = record.draws.reduce((n, d) => n + d.inputTokens, 0);
  console.log(`\n  ${record.draws.length} draws, ${tokens} input tokens, $${((tokens / 1e6) * 0.042).toFixed(4)}`);
}

await main();
