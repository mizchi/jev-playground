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
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Jev, mapLimit } from "./jev.mjs";
import {
  DEFAULT_BATCH_SIZE,
  planRuleBatches,
  questionsForRules,
  ruleTextHash,
  stateForRules,
  verdictForRule,
} from "./rules.mjs";
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
    /** A file of ad-hoc rule definitions (.json or .mjs). */
    rules: undefined,
    /** The target repo's real ESLint config, as the source of those rules. */
    config: undefined,
    batchSize: undefined,
    /** Warm only one of the two rules. Both by default. */
    only: undefined,
    /** Drop ad-hoc verdicts left behind by an earlier draft of a sentence. */
    prune: false,
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
    else if (a === "--rules") opts.rules = next();
    else if (a === "--config") opts.config = next();
    else if (a === "--batch-size") opts.batchSize = Number.parseInt(next(), 10);
    else if (a === "--only") opts.only = next();
    else if (a === "--prune") opts.prune = true;
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else opts.globs.push(a);
  }
  if (opts.only !== undefined && !["quality", "rules"].includes(opts.only)) {
    throw new Error("--only must be quality or rules");
  }
  if (opts.rules && opts.config) {
    throw new Error("--rules and --config both supply the ad-hoc rules; pick one");
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
 * Load the ad-hoc rule definitions from a file.
 *
 * `.json` is an array, or `{rules: [...]}`. Anything else is imported and its
 * default (or named `rules`) export is used, so a `.mjs` file can be the
 * single place the rules live and be imported by the ESLint config too --
 * which is the point, because the rule text is part of the cache key and two
 * copies that drift produce a cache that never hits.
 */
export async function loadRules(path) {
  const file = resolve(path);
  if (file.endsWith(".json")) {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : (parsed?.rules ?? []);
  }
  const mod = await import(pathToFileURL(file).href);
  const found = mod.rules ?? mod.default;
  return Array.isArray(found) ? found : (found?.rules ?? []);
}

/**
 * Extract every node that an ad-hoc rule's selector matched, by running the
 * real ESLint with the real `jev/rule`.
 *
 * Same argument as `collectFiles`: the selector matching, the node text and
 * the cache key all come from the plugin itself, so the keys written here are
 * the keys the lint looks up. A second esquery call in this file would be the
 * classic way to ship a cache that never hits.
 *
 * With `--config`, the target's own ESLint config is used unchanged, so the
 * rules come from the one place they are already written. Without it, the
 * rules come from `--rules` and the target's config is ignored.
 */
export async function collectMatches(globs, { rules, config } = {}) {
  const eslint = config
    ? new ESLint({ overrideConfigFile: resolve(config), errorOnUnmatchedPattern: false })
    : new ESLint({
        overrideConfigFile: true,
        overrideConfig: {
          files: ["**/*.{js,mjs,cjs,jsx}"],
          languageOptions: { ecmaVersion: "latest", sourceType: "module" },
          plugins: { jev: plugin },
          rules: { "jev/rule": ["warn", { rules: rules ?? [] }] },
        },
        errorOnUnmatchedPattern: false,
      });

  collector.active = true;
  collector.matches = [];
  try {
    await eslint.lintFiles(globs);
  } finally {
    collector.active = false;
  }
  const matches = collector.matches.slice();
  collector.matches = [];
  return matches;
}

/** One request's worth of matched nodes. */
export async function askRuleBatch(jev, batch) {
  const res = await jev.askSplitting(
    stateForRules(batch.file, batch.source, batch.matches),
    questionsForRules(batch.matches),
  );
  return batch.matches.map((match, i) => ({
    match,
    verdict: verdictForRule(res.answers, i),
  }));
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
export function planBatches(units, arm, rubric = "vague", omit = []) {
  const shape = armShape(arm);
  if (shape.batch === "one") {
    return units.map((u) => ({
      arm,
      rubric,
      omit,
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
          omit,
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
      const cost = estimateTokens(questionsFor([unit], arm, rubric, omit));
      if (current.length > 0 && tokens + cost > MAX_REQUEST_TOKENS) {
        batches.push({ arm, rubric, omit, file, source, units: current });
        current = [];
        tokens = stateTokens;
      }
      current.push(unit);
      tokens += cost;
    }
    if (current.length > 0) {
      batches.push({ arm, rubric, omit, file, source, units: current });
    }
  }
  return batches;
}

/** Ask one batch. Returns [{unit, verdict}]. */
export async function askBatch(jev, batch) {
  const state = stateFor(batch.file, batch.source, batch.units, batch.arm);
  const rubric = batch.rubric ?? "vague";
  const res = await jev.askSplitting(
    state,
    questionsFor(batch.units, batch.arm, rubric, batch.omit ?? []),
  );
  return batch.units.map((unit, i) => ({
    unit,
    verdict: verdictFrom(res.answers, i, rubric),
  }));
}

/** Run every batch, reporting a failure per batch rather than aborting. */
async function runBatches(jev, batches, concurrency, ask, label) {
  let failed = 0;
  const results = await mapLimit(batches, concurrency, async (batch) => {
    try {
      return await ask(jev, batch);
    } catch (err) {
      failed += 1;
      console.error(`  ! ${label(batch)}: ${err.message}`);
      return [];
    }
  });
  return { results, failed };
}

/** `jev/quality`: the fixed question set, every function. Returns entries. */
async function warmQuality(opts, jev, entries) {
  const all = await collectFiles(opts.globs, opts);

  // Content-addressed: the same function text in two files is one question.
  const byKey = new Map();
  for (const unit of all) {
    const key = keyOf(unit, opts.rubric);
    if (!byKey.has(key)) byKey.set(key, { ...unit, key });
  }
  const todo = [...byKey.values()].filter((u) => opts.force || !entries[u.key]);

  const files = new Set(all.map((u) => u.file)).size;
  console.log(
    `quality: ${files} file(s), ${all.length} function(s), ${byKey.size} unique, ` +
      `${byKey.size - todo.length} already cached, ${todo.length} to ask`,
  );

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
    return 0;
  }
  if (todo.length === 0) return 0;

  const { results, failed } = await runBatches(jev, batches, opts.concurrency, askBatch, (b) =>
    relative(process.cwd(), b.file),
  );
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
  if (failed > 0) console.log(`  ${failed} request(s) failed`);
  return stored;
}

/** `jev/rule`: one score per node an ad-hoc selector matched. */
async function warmRules(opts, jev, entries) {
  const rules = opts.rules ? await loadRules(opts.rules) : undefined;
  const all = await collectMatches(opts.globs, { rules, config: opts.config });

  // Content-addressed on (rule text, node text), so the same call site written
  // twice is one question -- and the same node under two rules is two.
  const byKey = new Map();
  for (const m of all) {
    if (!byKey.has(m.key)) byKey.set(m.key, m);
  }
  const todo = [...byKey.values()].filter((m) => opts.force || !entries[m.key]);

  const files = new Set(all.map((m) => m.file)).size;
  const ruleIds = new Set(all.map((m) => m.rule.id));
  console.log(
    `rules: ${files} file(s), ${all.length} match(es) of ${ruleIds.size} rule(s), ` +
      `${byKey.size} unique, ${byKey.size - todo.length} already cached, ${todo.length} to ask`,
  );
  for (const id of ruleIds) {
    const n = all.filter((m) => m.rule.id === id).length;
    console.log(`    ${id}  ${n} match(es)`);
  }

  // Editing a sentence orphans its old verdicts: new key, same rule id. They
  // cost nothing to keep and are worth keeping by default (revert the edit and
  // the old answers are free again), but a cache that only ever grows is not
  // one you want committed. Done before the early returns, because a cache
  // with nothing left to ask is exactly when you want to tidy it.
  if (opts.prune && !opts.dryRun) {
    let dropped = 0;
    for (const [key, entry] of Object.entries(entries)) {
      if (entry?.kind !== "rule") continue;
      if (byKey.has(key)) continue;
      delete entries[key];
      dropped += 1;
    }
    console.log(`  pruned ${dropped} verdict(s) from earlier drafts`);
  }

  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const batches = planRuleBatches(todo, batchSize);
  console.log(`  ${batches.length} request(s) planned (batch size ${batchSize})`);
  if (opts.dryRun) {
    for (const batch of batches) {
      console.log(
        `    ${relative(process.cwd(), batch.file)}  ${batch.matches.length} match  ` +
          `~${estimateTokens(stateForRules(batch.file, batch.source, batch.matches)) + estimateTokens(questionsForRules(batch.matches))} tok`,
      );
    }
    return 0;
  }
  if (todo.length === 0) return 0;

  const { results, failed } = await runBatches(
    jev,
    batches,
    opts.concurrency,
    askRuleBatch,
    (b) => relative(process.cwd(), b.file),
  );
  let stored = 0;
  for (const pairs of results) {
    for (const { match, verdict } of pairs) {
      if (!verdict) continue;
      entries[match.key] = {
        ...verdict,
        // `kind` is what makes `--force --only rules` able to re-ask the
        // ad-hoc verdicts without discarding the quality ones.
        kind: "rule",
        rule: match.rule.id,
        // Which draft of the sentence answered. See `ruleTextHash`.
        ruleHash: ruleTextHash(match.rule),
        node: match.nodeType,
        file: relative(process.cwd(), match.file),
        line: match.line,
        at: new Date().toISOString(),
      };
      stored += 1;
    }
  }
  if (failed > 0) console.log(`  ${failed} request(s) failed`);
  return stored;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const doQuality = opts.only !== "rules";
  const doRules = opts.only !== "quality" && Boolean(opts.rules || opts.config);
  if (opts.only === "rules" && !doRules) {
    throw new Error("--only rules needs --rules or --config");
  }

  const cache = readCache(opts.cache);
  if (!cache.ok && cache.reason) console.log(`cache: ${cache.reason}`);
  // `--force` re-asks, and drops only the namespace being re-asked: wiping
  // the ad-hoc verdicts because the quality ones are being rebuilt (or the
  // reverse) would be a surprise that costs real money to undo.
  const entries = {};
  for (const [key, entry] of Object.entries(cache.entries ?? {})) {
    const isRule = entry?.kind === "rule";
    if (opts.force && isRule && doRules) continue;
    if (opts.force && !isRule && doQuality) continue;
    entries[key] = entry;
  }

  const jev = new Jev({ model: opts.model });
  let stored = 0;
  if (doQuality) stored += await warmQuality(opts, jev, entries);
  if (doRules) stored += await warmRules(opts, jev, entries);
  if (opts.dryRun) return;

  const where = writeCache(opts.cache, {
    model: jev.model,
    arm: opts.arm,
    rubric: opts.rubric,
    entries,
  });
  console.log(
    `  ${jev.calls} request(s), ${jev.inputTokens} input tokens, $${jev.usd.toFixed(5)}` +
      (jev.splits > 0 ? `, ${jev.splits} split(s)` : ""),
  );
  console.log(`  ${stored} verdict(s) -> ${relative(process.cwd(), where)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`warm: ${err.message}`);
    process.exit(1);
  });
}
