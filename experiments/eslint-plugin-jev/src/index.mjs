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
import { Linter } from "eslint";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { collectUnits, DEFAULT_SELECTION } from "./functions.mjs";
import { RUBRICS, decide, keyOf, levelName, withThresholds } from "./judge.mjs";
import { lookup, readCacheMemo } from "./cache.mjs";
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_RULE_THRESHOLDS,
  decideRule,
  normalizeRules,
  ruleMatchKey,
} from "./rules.mjs";

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
export const collector = { active: false, units: [], matches: [] };

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
      /**
       * Only meaningful with onMiss "ask". Overrides `TYPESAFEAI_API_KEY` for
       * the child process; the rule itself never talks to the network.
       */
      apiKey: { type: "string" },
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
    const thresholds = withThresholds(options);
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
              apiKey: options.apiKey ?? null,
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

const ruleMessages = {
  rule: "{{rule}}: {{text}} ({{level}}, {{score}}/3 confidence {{confidence}}; reports at {{at}}).",
  ruleUnsure:
    "{{rule}}: {{text}} -- but Jev is not sure, so this is a question rather than a finding ({{score}}/3, confidence {{confidence}} under {{unsureBelow}}).",
  ruleMissing:
    "No Jev verdict cached for `{{rule}}` here. Run the warm pass with the same rules, or set `onMiss` to \"silent\".",
  ruleConfig: "eslint-plugin-jev: {{problem}}.",
};

const ruleSchema = [
  {
    type: "object",
    properties: {
      /**
       * The rules. `selector` is code, `rule` is a sentence, and that split is
       * the whole idea -- see the header of `rules.mjs`.
       */
      rules: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            selector: { type: "string" },
            rule: { type: "string" },
            /** Extra context for the model only; never shown in the message. */
            note: { type: "string" },
            /** Per-rule cutoff, overriding `reportAt`. */
            at: { type: "number", minimum: 0, maximum: 3 },
          },
          required: ["selector", "rule"],
          additionalProperties: false,
        },
      },
      reportAt: { type: "number", minimum: 0, maximum: 3 },
      unsureBelow: { type: "number", minimum: 0, maximum: 1 },
      /** Matches per request. A self-imposed cap; see `rules.mjs`. */
      batchSize: { type: "integer", minimum: 1 },
      cache: { type: "string" },
      onMiss: { enum: ["silent", "report", "ask"] },
      timeout: { type: "integer", minimum: 100 },
      /** Only meaningful with onMiss "ask"; see `jev/quality`. */
      apiKey: { type: "string" },
    },
    additionalProperties: false,
  },
];

/**
 * `jev/rule` -- rules that do not exist yet, written as sentences.
 *
 * Unlike `jev/quality` this rule really does use per-node visitors, because
 * the selector is the input: ESLint's esquery decides which nodes get judged,
 * for free, before any question is asked. The visitors only COLLECT; every
 * lookup and report still happens on `Program:exit`, because the file is
 * still the batch.
 */
const rule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Report nodes that break a project rule written in natural language, matched by an ESLint selector and judged by Jev.",
      recommended: false,
    },
    schema: ruleSchema,
    messages: ruleMessages,
  },

  create(context) {
    const options = context.options?.[0] ?? {};
    const { rules, errors } = normalizeRules(options.rules);
    const thresholds = {
      reportAt: options.reportAt ?? DEFAULT_RULE_THRESHOLDS.reportAt,
      unsureBelow: options.unsureBelow ?? DEFAULT_RULE_THRESHOLDS.unsureBelow,
    };
    const onMiss = options.onMiss ?? "silent";
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const filename = context.filename ?? context.getFilename();

    // One handler per distinct selector, because two rules may share one and
    // a visitor object has one slot per key.
    const bySelector = new Map();
    const bad = [];
    for (const r of rules) {
      // A selector ESLint cannot parse throws during traversal, long after
      // `create()` has returned, and takes the whole lint run with it. That is
      // the one thing this plugin promises not to do, so an unparseable
      // selector is dropped here and reported as the config problem it is.
      if (!selectorParses(r.selector)) {
        bad.push(`\`${r.id}\` has a selector ESLint cannot parse: ${r.selector}`);
        continue;
      }
      if (!bySelector.has(r.selector)) bySelector.set(r.selector, []);
      bySelector.get(r.selector).push(r);
    }
    const problems = [...errors, ...bad];

    const matches = [];
    // Handlers are collected per key and composed at the end: a user selector
    // of `Program:exit` is legal (it means "on leaving the file") and must not
    // displace this rule's own exit hook, nor be displaced by it.
    const handlers = new Map();
    const on = (key, fn) => {
      if (!handlers.has(key)) handlers.set(key, []);
      handlers.get(key).push(fn);
    };

    for (const [selector, group] of bySelector) {
      on(selector, (node) => {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        let text;
        try {
          text = sourceCode.getText(node);
        } catch {
          return;
        }
        for (const r of group) {
          matches.push({
            rule: r,
            node,
            nodeType: node.type,
            text,
            line: node.loc.start.line,
            endLine: node.loc.end.line,
            file: filename,
          });
        }
      });
    }

    on("Program:exit", () => {
      const sourceCode = context.sourceCode ?? context.getSourceCode();

      // A typo in the config is worth exactly one message on the file it was
      // noticed in, not silence: a rule that never fires because its entry was
      // malformed is indistinguishable from a rule that found nothing.
      if (problems.length > 0 && !collector.active) {
        context.report({
          loc: { line: 1, column: 0 },
          messageId: "ruleConfig",
          data: { problem: problems.join("; ") },
        });
      }
      if (matches.length === 0) return;

      if (collector.active) {
        const fileSource = sourceCode.getText();
        for (const m of matches) {
          // Drop `node` on the way out: the warm pass runs in another process
          // than the lint that reads the cache, and an AST node is neither
          // serialisable nor needed to ask the question.
          collector.matches.push({
            rule: m.rule,
            nodeType: m.nodeType,
            text: m.text,
            line: m.line,
            endLine: m.endLine,
            file: m.file,
            fileSource,
            key: ruleMatchKey(m.rule, m.text),
          });
        }
        return;
      }

      const cache = readCacheMemo(options.cache);
      const verdicts = new Map();
      const missing = [];
      for (const m of matches) {
        const verdict = lookup(cache, ruleMatchKey(m.rule, m.text));
        if (verdict && typeof verdict.score === "number") verdicts.set(m, verdict);
        else missing.push(m);
      }

      if (missing.length > 0 && onMiss === "ask") {
        const fresh = askBlocking(
          {
            kind: "rules",
            file: relative(process.cwd(), filename),
            source: sourceCode.getText(),
            cache: options.cache ?? null,
            apiKey: options.apiKey ?? null,
            batchSize,
            matches: missing.map((m) => ({
              key: ruleMatchKey(m.rule, m.text),
              rule: m.rule,
              nodeType: m.nodeType,
              text: m.text,
              line: m.line,
              endLine: m.endLine,
            })),
          },
          options.timeout ?? 30_000,
        );
        for (const m of missing) {
          const verdict = fresh[ruleMatchKey(m.rule, m.text)];
          if (verdict && typeof verdict.score === "number") verdicts.set(m, verdict);
        }
      }

      for (const m of matches) {
        const verdict = verdicts.get(m);
        if (!verdict) {
          if (onMiss === "report") {
            context.report({
              node: m.node,
              loc: firstLine(m.node),
              messageId: "ruleMissing",
              data: { rule: m.rule.id },
            });
          }
          continue;
        }
        const outcome = decideRule(verdict, m.rule, thresholds);
        if (!outcome) continue;
        context.report({
          node: m.node,
          loc: firstLine(m.node),
          messageId: outcome.messageId,
          data: { level: outcome.level, ...outcome.data },
        });
      }
    });

    const visitors = {};
    for (const [key, fns] of handlers) {
      visitors[key] = fns.length === 1 ? fns[0] : (node) => fns.forEach((fn) => fn(node));
    }
    return visitors;
  },
};

/**
 * Does ESLint's selector parser accept this string?
 *
 * There is no way to catch this from inside a rule: ESLint parses the visitor
 * keys after `create()` returns, and an unparseable one throws mid-traversal
 * and fails the whole lint run. So the check happens up front, by asking a
 * throwaway `Linter` to build the same visitor, and the answer is memoised
 * because a config's selectors do not change during a run.
 *
 * `eslint` is a peer dependency and this plugin only ever runs inside it, so
 * importing `Linter` costs nothing that was not already loaded.
 */
const selectorOk = new Map();

function selectorParses(selector) {
  const hit = selectorOk.get(selector);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    new Linter().verify("0;", {
      plugins: { jevProbe: { rules: { probe: { create: () => ({ [selector]() {} }) } } } },
      rules: { "jevProbe/probe": "error" },
    });
    ok = true;
  } catch {
    ok = false;
  }
  selectorOk.set(selector, ok);
  return ok;
}

/**
 * Highlight the first line of the match, not all 200 of it.
 *
 * A selector can match a whole class, and squiggling a class body buries the
 * message it is attached to.
 */
function firstLine(node) {
  const start = node.loc.start;
  if (node.loc.end.line === start.line) return node.loc;
  return { start, end: { line: start.line, column: start.column + 1 } };
}

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
  rules: { quality, rule },
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

export { quality, rule, levelName, meta };
export default plugin;
