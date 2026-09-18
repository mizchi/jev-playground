#!/usr/bin/env node
/**
 * The child process that `onMiss: "ask"` blocks on.
 *
 * Node has no synchronous fetch, but `execFileSync` blocks the parent, so
 * this is how an HTTP request gets inside a synchronous ESLint rule. One
 * child and one Jev request per FILE -- never per function.
 *
 * Reads a request on stdin, prints `{"verdicts": {key: {...}}}` on stdout,
 * and folds the fresh verdicts into the cache on the way out so the next lint
 * is free. Prints `{"verdicts":{}}` on any failure: the parent turns an empty
 * result into no reports, which is the fail-safe the plugin promises.
 */
import { readFileSync } from "node:fs";
import { Jev } from "./jev.mjs";
import { questionsFor, stateFor, verdictFrom } from "./judge.mjs";
import { readCache, writeCache } from "./cache.mjs";
import {
  DEFAULT_BATCH_SIZE,
  planRuleBatches,
  questionsForRules,
  stateForRules,
  verdictForRule,
} from "./rules.mjs";

/**
 * `jev/rule`'s side: one score per matched node.
 *
 * Batched the same way the warm pass batches, because a selector can match
 * hundreds of nodes in one file and a blocking child is already the slow
 * path -- making it one request per node would make it unusable rather than
 * merely slow.
 */
async function askRules(req, jev) {
  const matches = (req.matches ?? []).map((m) => ({ ...m, fileSource: req.source }));
  if (matches.length === 0) return {};
  const verdicts = {};
  for (const batch of planRuleBatches(matches, req.batchSize ?? DEFAULT_BATCH_SIZE)) {
    const res = await jev.askSplitting(
      stateForRules(req.file, batch.source, batch.matches),
      questionsForRules(batch.matches),
    );
    batch.matches.forEach((match, i) => {
      const verdict = verdictForRule(res.answers, i);
      if (verdict) verdicts[match.key] = verdict;
    });
  }

  try {
    const cache = readCache(req.cache);
    const entries = { ...cache.entries };
    for (const match of matches) {
      const verdict = verdicts[match.key];
      if (!verdict) continue;
      entries[match.key] = {
        ...verdict,
        kind: "rule",
        rule: match.rule?.id ?? null,
        node: match.nodeType,
        file: req.file,
        line: match.line,
        at: new Date().toISOString(),
      };
    }
    // Keep whatever arm/rubric the cache already declared: this path did not
    // warm the quality verdicts and must not relabel them.
    writeCache(req.cache, { model: null, arm: cache.arm, rubric: cache.rubric, entries });
  } catch {
    // A cache we cannot write costs speed, not correctness.
  }
  return verdicts;
}

/** The client for one request: the config's `apiKey` wins over the env. */
function clientFor(req) {
  return new Jev({
    apiKey: req.apiKey || undefined,
    model: process.env.JEV_QUALITY_MODEL || undefined,
    retries: 1,
  });
}

async function main() {
  const req = JSON.parse(readFileSync(0, "utf8"));
  if (req.kind === "rules") return askRules(req, clientFor(req));
  const units = req.units ?? [];
  if (units.length === 0) return {};

  // "located" is the arm the plugin defaults to: the file crosses the wire
  // once, and each question names its function by name and line range.
  const arm = process.env.JEV_QUALITY_ARM || "located";
  const rubric = req.rubric || "vague";
  const jev = clientFor(req);
  const res = await jev.askSplitting(
    stateFor(req.file, req.source, units, arm),
    questionsFor(units, arm, rubric),
  );

  const verdicts = {};
  units.forEach((unit, i) => {
    const verdict = verdictFrom(res.answers, i, rubric);
    if (verdict) verdicts[unit.key] = verdict;
  });

  // Fold into the cache. ESLint lints files one at a time in a single
  // process, so these children are sequential and a read-modify-write is
  // safe; a parallel runner could lose an entry, which costs a re-ask.
  try {
    const cache = readCache(req.cache);
    const entries = { ...cache.entries };
    units.forEach((unit, i) => {
      const verdict = verdicts[unit.key];
      if (!verdict) return;
      entries[unit.key] = {
        ...verdict,
        name: unit.name,
        file: req.file,
        line: unit.line,
        at: new Date().toISOString(),
      };
    });
    writeCache(req.cache, { model: res.model ?? null, arm, rubric, entries });
  } catch {
    // A cache we cannot write costs speed, not correctness.
  }
  return verdicts;
}

main()
  .then((verdicts) => process.stdout.write(JSON.stringify({ verdicts })))
  .catch(() => process.stdout.write(JSON.stringify({ verdicts: {} })));
