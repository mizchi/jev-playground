#!/usr/bin/env node
/**
 * jevlang, JS implementation.
 *
 *   node bin/jevlang.mjs <file.jev> [options]
 *
 *   --lazy            one request per judgment, as reached. The default hoists
 *                     every judgment whose text is already known into ONE
 *                     request, so --lazy is what the batching is measured
 *                     against.
 *   --record <file>   write every answer to a transcript
 *   --replay <file>   read answers from a transcript; makes no API calls
 *   --json            machine-readable result, for cross-implementation checks
 *   --quiet           suppress the trace
 *   --model <name>    default jev-latest
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "../src/parse.mjs";
import { Interpreter } from "../src/interp.mjs";
import { Jev } from "../src/jev.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : (argv[i + 1] ?? d);
};

const file = argv.find((a) => !a.startsWith("--") && !isOptionValue(a));
function isOptionValue(a) {
  const i = argv.indexOf(a);
  return i > 0 && ["--record", "--replay", "--model"].includes(argv[i - 1]);
}

if (!file) {
  console.error("usage: jevlang <file.jev> [--lazy] [--record f] [--replay f] [--json]");
  process.exit(2);
}

const LAZY = flag("lazy");
const JSON_OUT = flag("json");
const QUIET = flag("quiet") || JSON_OUT;
const RECORD = opt("record");
const REPLAY = opt("replay");

async function main() {
  const source = readFileSync(file, "utf8");
  const program = parse(source);

  const replay = REPLAY ? JSON.parse(readFileSync(REPLAY, "utf8")) : null;
  // In replay mode nothing is asked, so a missing key is an error rather than
  // a silent API call -- that is what makes replayed runs comparable.
  const jev = replay === null ? new Jev({ model: opt("model", "jev-latest") }) : null;

  const interp = new Interpreter(program, { jev, lazy: LAZY, replay: replay?.answers ?? null });
  const result = await interp.run();

  if (RECORD) {
    writeFileSync(
      RECORD,
      JSON.stringify(
        { state: interp.state, answers: interp.recorded },
        null,
        2,
      ) + "\n",
    );
  }

  if (JSON_OUT) {
    // Only the parts both implementations must agree on.
    console.log(
      JSON.stringify(
        {
          effects: result.effects,
          output: result.output,
          bindings: result.bindings,
          judgments: result.trace.map((t) => ({ kind: t.kind, question: t.question })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!QUIET) {
    console.log(`${file}  (${program.judgmentCount} judgments in source)`);
    console.log("");
    for (const t of interp.trace) {
      const a = t.answer;
      const detail =
        a.type === "noul"
          ? a.noul.toFixed(2)
          : a.type === "choice"
            ? `${a.choice} @${a.confidence.toFixed(2)}`
            : `${a.score.toFixed(2)} @${a.confidence.toFixed(2)}`;
      console.log(
        `  [${t.how.padEnd(6)}] ${t.kind.padEnd(6)} ${clip(t.question, 46).padEnd(48)} ${detail}`,
      );
    }
    console.log("");
    for (const e of result.effects) {
      console.log(`  -> ${e.name}(${e.args.map((a) => JSON.stringify(a)).join(", ")})`);
    }
    console.log("");
    const mode = LAZY ? "lazy" : "batched";
    console.log(
      `  ${mode}: ${result.requests} request(s) for ${interp.trace.length} judgment(s)` +
        (result.batched > 0 ? ` (${result.batched} in the batch, ${result.lazy} lazy)` : "") +
        (jev
          ? ` · ${jev.inputTokens} input tokens · $${((jev.inputTokens / 1e6) * 0.042).toFixed(5)}` +
            ` · ${(jev.totalMs / 1000).toFixed(2)}s`
          : " · replayed, no API calls"),
    );
  }
}

function clip(s, n) {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

main().catch((err) => {
  console.error(`${err.name ?? "error"}: ${err.message}`);
  process.exit(1);
});
