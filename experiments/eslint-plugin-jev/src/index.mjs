/**
 * eslint-plugin-jev -- an ESLint rule whose verdict comes from Jev.
 *
 * The rule is `jev/quality`. It judges one function at a time and reports
 * four different things, because they want four different answers from a
 * team:
 *
 *   criterion    a NAMED review criterion matched (`rubric: "atoms"`/"full")
 *   jev/bug      the generic "this misbehaves" noul fired
 *   jev/quality  the reviewer-action score crossed the bar, confidently
 *   jev/unsure   over the bar but under-confident -- a human should look
 *
 * `criterion` is the only one that can say WHAT is wrong, which is why it
 * outranks the other three. docs/22 is what it costs and what it buys.
 *
 * ## The one hard problem
 *
 * ESLint rules are synchronous. `context.report()` must be called during the
 * traversal and there is no hook that may return a promise, so a rule cannot
 * await an HTTP request. Three ways out, and this plugin does all three so the
 * cost of each is visible:
 *
 *   1. **cache** (default) -- `warm.mjs` asks Jev out of band and writes
 *      verdicts to disk; the rule looks them up synchronously. Lint stays as
 *      fast as it was, and a miss reports nothing.
 *   2. **`onMiss: "ask"`** -- block the rule on a synchronous child process
 *      that makes the request. Zero setup, and it makes `eslint` as slow as
 *      the API. Measured in docs/21.
 *   3. **`onMiss: "report"`** -- report the miss itself, so CI fails on an
 *      un-warmed cache rather than passing quietly with the judgment skipped.
 *
 * All the work happens on `Program:exit` rather than in per-node visitors:
 * that is the point at which the whole file is available, and the whole file
 * is the batch. One file, one request, every function (docs/00 fan-out).
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { collectUnits, DEFAULT_SELECTION } from "./functions.mjs";
import { DEFAULT_THRESHOLDS, RUBRICS, decide, keyOf, levelName } from "./judge.mjs";
import { lookup, readCacheMemo } from "./cache.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The warm pass sets `collector.active` and harvests `collector.units`.
 *
 * Sharing module state rather than re-implementing the AST walk is deliberate:
 * the cache key is a hash of the function's text, so a second extractor that
 * disagreed by one character would produce a cache that never hits. The warm
 * pass runs the real ESLint with this real plugin, so the extraction is not
 * "the same" -- it is the same code.
 */
export const collector = { active: false, units: [] };

const messages = {
  quality:
    "Jev would push back on `{{name}}`: {{level}} (score {{score}}/3, confidence {{confidence}}; reports at {{reportAt}}).",
  bug: "Jev thinks `{{name}}` does the wrong thing for some realistic input (misbehaves {{bug}}; reviewer action {{score}}/3).",
  unsure:
    "Jev would push back on `{{name}}` but is not sure -- worth a human look rather than a fix (score {{score}}/3, confidence {{confidence}} under {{unsureBelow}}).",
  criterion:
    "`{{name}}` matches the review criterion `{{criterion}}` ({{criterionP}}, its cutoff is {{criterionAt}}). See docs/22 for what that criterion means and how well it holds.",
  missing: "No Jev verdict cached for `{{name}}`. Run the warm pass, or set `onMiss` to \"silent\".",
};

const schema = [
  {
    type: "object",
    properties: {
      reportAt: { type: "number", minimum: 0, maximum: 3 },
      bugAt: { type: "number", minimum: 0, maximum: 1 },
      atomAt: { type: "number", minimum: 0, maximum: 1 },
      /** One cutoff per named criterion. docs/22 measured why this is a map. */
      criterionAt: { type: "object", additionalProperties: { type: "number" } },
      unsureBelow: { type: "number", minimum: 0, maximum: 1 },
      /** Which question set the cache was warmed with. docs/22 compares them. */
      rubric: { enum: ["vague", "checklist", "atoms", "full"] },
      minLines: { type: "integer", minimum: 1 },
      includeCallbacks: { type: "boolean" },
      cache: { type: "string" },
      onMiss: { enum: ["silent", "report", "ask"] },
      /** Only meaningful with onMiss "ask". Milliseconds. */
      timeout: { type: "integer", minimum: 100 },
    },
    additionalProperties: false,
  },
];

/**
 * Ask Jev synchronously by blocking on a child process.
 *
 * There is no synchronous fetch in Node, but `execFileSync` really does block,
 * so this is a genuine (and genuinely slow) way to put an HTTP call inside an
 * ESLint rule. It is one child and one request for the whole file, never one
 * per function.
 *
 * Every failure returns {} -- no verdicts, therefore no reports. Same rule as
 * the hook in docs/18: a judgment layer that fails into a verdict is worse
 * than one that fails into silence.
 */
function askBlocking(payload, timeout) {
  try {
    const out = execFileSync(process.execPath, [join(HERE, "sync-ask.mjs")], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = JSON.parse(out);
    return parsed && typeof parsed === "object" && parsed.verdicts ? parsed.verdicts : {};
  } catch {
    return {};
  }
}

/** The rule. */
const quality = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Report functions that Jev would push back on in review, using a cached per-function score and confidence.",
      recommended: false,
    },
    schema,
    messages,
  },

  create(context) {
    const options = context.options?.[0] ?? {};
    const thresholds = { ...DEFAULT_THRESHOLDS, ...options };
    const selection = {
      minLines: options.minLines ?? DEFAULT_SELECTION.minLines,
      includeCallbacks: options.includeCallbacks ?? DEFAULT_SELECTION.includeCallbacks,
    };
    const onMiss = options.onMiss ?? "silent";
    const rubric = RUBRICS.includes(options.rubric) ? options.rubric : "vague";
    const filename = context.filename ?? context.getFilename();

    return {
      "Program:exit"() {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        let units;
        try {
          units = collectUnits(sourceCode, filename, selection);
        } catch {
          // A parser shape we did not expect must not take the lint run down.
          return;
        }
        if (units.length === 0) return;

        if (collector.active) {
          collector.units.push(...units);
          return;
        }

        const cache = readCacheMemo(options.cache);
        const verdicts = new Map();
        const missing = [];
        for (const unit of units) {
          const verdict = lookup(cache, keyOf(unit, rubric));
          if (verdict) verdicts.set(unit, verdict);
          else missing.push(unit);
        }

        if (missing.length > 0 && onMiss === "ask") {
          const fresh = askBlocking(
            {
              file: relative(process.cwd(), filename),
              source: sourceCode.getText(),
              cache: options.cache ?? null,
              rubric,
              units: missing.map((u) => ({
                key: keyOf(u, rubric),
                name: u.name,
                line: u.line,
                endLine: u.endLine,
                text: u.text,
              })),
            },
            options.timeout ?? 30_000,
          );
          for (const unit of missing) {
            const verdict = fresh[keyOf(unit, rubric)];
            // Same bar as a cache hit: a score pair or a named criterion.
            // The `atoms` rubric produces no score at all.
            const usable =
              verdict &&
              (typeof verdict.score === "number" ||
                (verdict.atoms && Object.keys(verdict.atoms).length > 0));
            if (usable) verdicts.set(unit, verdict);
          }
        }

        for (const unit of units) {
          const verdict = verdicts.get(unit);
          if (!verdict) {
            if (onMiss === "report") {
              context.report({
                node: unit.node,
                messageId: "missing",
                data: { name: unit.name },
              });
            }
            continue;
          }
          const outcome = decide(verdict, thresholds);
          if (!outcome) continue;
          context.report({
            node: unit.node,
            // The whole function highlighted would bury the message; the
            // signature line is where a reviewer looks.
            loc: { start: unit.node.loc.start, end: headEnd(sourceCode, unit) },
            messageId: outcome.messageId,
            data: { name: unit.name, ...outcome.data },
          });
        }
      },
    };
  },
};

/** Underline the signature, not the body. */
function headEnd(sourceCode, unit) {
  const body = unit.node.body;
  if (body && body.loc) return body.loc.start;
  const line = sourceCode.lines[unit.line - 1] ?? "";
  return { line: unit.line, column: line.length };
}

const meta = { name: "eslint-plugin-jev", version: "0.1.0" };

const plugin = {
  meta,
  rules: { quality },
  configs: {},
};

/**
 * `recommended` deliberately sets `onMiss: "silent"`: a cold cache must not
 * turn into a wall of findings, and it must not turn into a wall of "no
 * verdict" either. Opting into failure on a cold cache is a per-repo choice.
 */
plugin.configs.recommended = {
  plugins: { jev: plugin },
  rules: { "jev/quality": ["warn", { onMiss: "silent" }] },
};

export { quality, levelName, meta };
export default plugin;
