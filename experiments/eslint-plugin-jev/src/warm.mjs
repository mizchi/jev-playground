#!/usr/bin/env node
/**
 * The warm pass: ask Jev about every function, out of band, and write the
 * verdicts where the synchronous rule can find them.
 *
 *   node src/warm.mjs "fixtures/**\/*.js"
 *   node src/warm.mjs "src/**\/*.js" --arm inlined --cache .jev-quality.json
 *
 * It runs the REAL ESLint with the REAL plugin in collector mode, so the
 * functions it asks about are exactly the functions the rule will look up.
 * Re-implementing the AST walk here would be the classic way to ship a cache
 * that never hits: the key is a hash of the function's text.
 *
 * Batching (docs/00 speculative fan-out, and the ceilings measured in
 * docs/21): one request per FILE by default, carrying two questions per
 * function. The measured ceilings are 64Ki tokens per request and 32Ki for
 * the state, neither of them a question count -- 1220 questions in one
 * request is fine.
 */
import { ESLint } from "eslint";
import plugin, { collector } from "./index.mjs";
import { relative } from "node:path";
import { Jev, mapLimit } from "./jev.mjs";
import {
  ARMS,
  RUBRICS,
  armShape,
  MAX_REQUEST_TOKENS,
  MAX_STATE_TOKENS,
  estimateTokens,
  keyOf,
  questionsFor,
  stateFor,
  verdictFrom,
} from "./judge.mjs";
import { readCache, writeCache } from "./cache.mjs";

export function parseArgs(argv) {
  const opts = {
    globs: [],
    arm: "located",
    rubric: "vague",
    cache: undefined,
    concurrency: 4,
    model: undefined,
    force: false,
    dryRun: false,
    minLines: undefined,
    includeCallbacks: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    if (a === "--arm") opts.arm = next();
    else if (a === "--rubric") opts.rubric = next();
    else if (a === "--cache") opts.cache = next();
    else if (a === "--concurrency") opts.concurrency = Number.parseInt(next(), 10);
    else if (a === "--model") opts.model = next();
    else if (a === "--min-lines") opts.minLines = Number.parseInt(next(), 10);
    else if (a === "--include-callbacks") opts.includeCallbacks = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else opts.globs.push(a);
  }
  if (!ARMS.includes(opts.arm)) throw new Error(`--arm must be one of ${ARMS.join(", ")}`);
  if (!RUBRICS.includes(opts.rubric)) {
    throw new Error(`--rubric must be one of ${RUBRICS.join(", ")}`);
  }
  if (opts.globs.length === 0) opts.globs.push(".");
  return opts;
}

/**
 * Extract the judgeable functions of every matched file, by running ESLint.
 */
export async function collectFiles(globs, { minLines, includeCallbacks } = {}) {
  const ruleOptions = {};
  if (minLines !== undefined) ruleOptions.minLines = minLines;
  if (includeCallbacks) ruleOptions.includeCallbacks = true;

  const eslint = new ESLint({
    // Ignore whatever config the target repo has: we are not linting, we are
    // walking, and the target's own rules would only add noise and time.
    overrideConfigFile: true,
    overrideConfig: {
      files: ["**/*.{js,mjs,cjs,jsx}"],
      languageOptions: { ecmaVersion: "latest", sourceType: "module" },
      plugins: { jev: plugin },
      rules: { "jev/quality": ["warn", ruleOptions] },
    },
    errorOnUnmatchedPattern: false,
  });

  collector.active = true;
  collector.units = [];
  try {
    await eslint.lintFiles(globs);
  } finally {
    collector.active = false;
  }
  const units = collector.units.slice();
  collector.units = [];
  return units;
}

/**
 * Group units into requests.
 *
 * The natural batch is one file, because the file is what the state carries
 * and the whole reason to batch is sending it once. A file that would blow
 * the request ceiling is split; a file whose SOURCE alone exceeds the state
 * ceiling cannot be asked about as a whole file at all, so it falls back to
 * the isolated shape (each function as its own small state) rather than
 * being dropped.
 */
export function planBatches(units, arm, rubric = "vague") {
  const shape = armShape(arm);
  if (shape.batch === "one") {
    return units.map((u) => ({
      arm,
      rubric,
      file: u.file,
      source: shape.state === "file" ? (u.fileSource ?? u.text) : u.text,
      units: [u],
    }));
  }
  const byFile = new Map();
  for (const unit of units) {
    if (!byFile.has(unit.file)) byFile.set(unit.file, []);
    byFile.get(unit.file).push(unit);
  }
  const batches = [];
  for (const [file, group] of byFile) {
    const source = group[0].fileSource ?? "";
    const stateTokens = estimateTokens(stateFor(file, source, group, arm));
    if (stateTokens > MAX_STATE_TOKENS) {
      for (const unit of group) {
        batches.push({
          arm: "isolated",
          rubric,
          file,
          source: unit.text,
          units: [unit],
          oversize: true,
        });
      }
      continue;
    }
    let current = [];
    let tokens = stateTokens;
    for (const unit of group) {
      const cost = estimateTokens(questionsFor([unit], arm, rubric));
      if (current.length > 0 && tokens + cost > MAX_REQUEST_TOKENS) {
        batches.push({ arm, rubric, file, source, units: current });
        current = [];
        tokens = stateTokens;
      }
      current.push(unit);
      tokens += cost;
    }
    if (current.length > 0) batches.push({ arm, rubric, file, source, units: current });
  }
  return batches;
}

/** Ask one batch. Returns [{unit, verdict}]. */
export async function askBatch(jev, batch) {
  const state = stateFor(batch.file, batch.source, batch.units, batch.arm);
  const rubric = batch.rubric ?? "vague";
  const res = await jev.askSplitting(state, questionsFor(batch.units, batch.arm, rubric));
  return batch.units.map((unit, i) => ({
    unit,
    verdict: verdictFrom(res.answers, i, rubric),
  }));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const all = await collectFiles(opts.globs, opts);

  // Content-addressed: the same function text in two files is one question.
  const byKey = new Map();
  for (const unit of all) {
    const key = keyOf(unit, opts.rubric);
    if (!byKey.has(key)) byKey.set(key, { ...unit, key });
  }
  const cache = readCache(opts.cache);
  const entries = opts.force ? {} : { ...cache.entries };
  const todo = [...byKey.values()].filter((u) => opts.force || !entries[u.key]);

  const files = new Set(all.map((u) => u.file)).size;
  console.log(
    `${files} file(s), ${all.length} function(s), ${byKey.size} unique, ` +
      `${byKey.size - todo.length} already cached, ${todo.length} to ask`,
  );
  if (!cache.ok && cache.reason) console.log(`  cache: ${cache.reason}`);

  const batches = planBatches(todo, opts.arm, opts.rubric);
  console.log(
    `  ${batches.length} request(s) planned (arm: ${opts.arm}, rubric: ${opts.rubric})`,
  );
  if (opts.dryRun) {
    for (const batch of batches) {
      console.log(
        `    ${relative(process.cwd(), batch.file)}  ${batch.units.length} fn  ` +
          `~${estimateTokens(stateFor(batch.file, batch.source, batch.units, batch.arm)) + estimateTokens(questionsFor(batch.units, batch.arm, opts.rubric))} tok`,
      );
    }
    return;
  }
  if (todo.length === 0) return;

  const jev = new Jev({ model: opts.model });
  let failed = 0;
  const results = await mapLimit(batches, opts.concurrency, async (batch) => {
    try {
      return await askBatch(jev, batch);
    } catch (err) {
      failed += 1;
      console.error(`  ! ${relative(process.cwd(), batch.file)}: ${err.message}`);
      return [];
    }
  });

  let stored = 0;
  for (const pairs of results) {
    for (const { unit, verdict } of pairs) {
      if (!verdict) continue;
      entries[unit.key] = {
        ...verdict,
        name: unit.name,
        file: relative(process.cwd(), unit.file),
        line: unit.line,
        at: new Date().toISOString(),
      };
      stored += 1;
    }
  }
  const where = writeCache(opts.cache, {
    model: jev.model,
    arm: opts.arm,
    rubric: opts.rubric,
    entries,
  });
  console.log(
    `  ${jev.calls} request(s), ${jev.inputTokens} input tokens, $${jev.usd.toFixed(5)}` +
      (jev.splits > 0 ? `, ${jev.splits} split(s)` : "") +
      (failed > 0 ? `, ${failed} failed` : ""),
  );
  console.log(`  ${stored} verdict(s) -> ${relative(process.cwd(), where)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`warm: ${err.message}`);
    process.exit(1);
  });
}
