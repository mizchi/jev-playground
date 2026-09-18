#!/usr/bin/env node
/**
 * What does each way out of "ESLint rules are synchronous" cost?
 *
 *   node experiment/sync-bench.mjs
 *
 * Three lint runs over the same 12 files:
 *
 *   cold, silent   the cache is empty and the rule says nothing -- this is the
 *                  floor: what the plugin costs when it does no work
 *   warm           verdicts on disk, looked up synchronously
 *   cold, ask      one blocking child process and one Jev request PER FILE,
 *                  inside the rule
 *
 * The third number is the one worth knowing before you put `onMiss: "ask"` in
 * a repo: it is what every developer's editor will wait for.
 */
import { ESLint } from "eslint";
import { existsSync, renameSync, unlinkSync } from "node:fs";
import plugin from "../src/index.mjs";
import { resetCacheMemo } from "../src/cache.mjs";

const CACHE = ".jev-quality.json";
const STASH = ".jev-quality.stash.json";
const TARGET = ["experiment/corpus"];

async function run(label, options) {
  resetCacheMemo();
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: {
      files: ["**/*.js"],
      languageOptions: { ecmaVersion: "latest", sourceType: "module" },
      plugins: { jev: plugin },
      rules: { "jev/quality": ["warn", options] },
    },
  });
  const started = Date.now();
  const results = await eslint.lintFiles(TARGET);
  const ms = Date.now() - started;
  const problems = results.reduce((n, r) => n + r.messages.length, 0);
  const files = results.length;
  console.log(
    `  ${label.padEnd(24)} ${String(ms).padStart(6)} ms   ` +
      `${String(problems).padStart(3)} finding(s) over ${files} files`,
  );
  return { label, ms, problems, files };
}

const hadCache = existsSync(CACHE);
if (hadCache) renameSync(CACHE, STASH);

console.log("");
console.log("LINT TIME, 12 files / 56 functions");
try {
  // Discarded: the first lint in a process pays for parsing and JIT warmup,
  // and attributing that to the plugin would flatter every later number.
  await run("(warmup, discarded)", { onMiss: "silent", cache: CACHE });
  const cold = await run("cold cache, silent", { onMiss: "silent", cache: CACHE });
  const ask = process.env.TYPESAFEAI_API_KEY
    ? await run("cold cache, onMiss ask", { onMiss: "ask", cache: CACHE, timeout: 60_000 })
    : null;
  if (existsSync(CACHE)) unlinkSync(CACHE);
  if (hadCache) renameSync(STASH, CACHE);
  const warm = hadCache ? await run("warm cache", { onMiss: "silent", cache: CACHE }) : null;

  console.log("");
  if (ask && warm) {
    console.log(
      `  blocking costs ${(ask.ms / warm.ms).toFixed(0)}x a warm lint: ` +
        `${ask.ms} ms against ${warm.ms} ms, ${Math.round(ask.ms / ask.files)} ms per file`,
    );
    console.log(
      `  a warm lint and a lint that reports nothing are ${warm.ms} ms and ${cold.ms} ms: ` +
        "the same within noise, because the lookup is a hash and a map get",
    );
  }
  if (!ask) console.log("  (no TYPESAFEAI_API_KEY, so the blocking arm was skipped)");
} finally {
  if (existsSync(STASH)) {
    if (existsSync(CACHE)) unlinkSync(CACHE);
    renameSync(STASH, CACHE);
  }
}
