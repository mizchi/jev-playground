#!/usr/bin/env node
/**
 * What your sentence actually did to your selector's matches.
 *
 *   node experiment/rules-report.mjs --cache experiment/out-rules.json \
 *     --rules experiment/rules.mjs
 *   node experiment/rules-report.mjs --at 1.5      # one cutoff for every rule
 *
 * Reads the warmed cache and prints, per ad-hoc rule, every match sorted by
 * score, the biggest gap in that list, and where the cutoff falls relative to
 * it. No API key and no requests: the verdicts are already on disk.
 *
 * `--rules` scores each rule at its OWN `at`, so the report says what the
 * shipped config does. Without it, `--at` applies one cutoff to everything,
 * which is the right way to see whether a per-rule cutoff is earning its keep.
 *
 * This is the authoring loop, and the gap is the number to read. A rule that
 * works separates its violations from the rest of its selector's matches by a
 * wide margin, and then the threshold does not matter -- anything in the gap
 * gives the same answer. A rule whose scores are all bunched together is not a
 * threshold that needs tuning, it is a SENTENCE that is not discriminating,
 * and no cutoff will rescue it.
 *
 * What this cannot show you is the other failure mode: a node your selector
 * never matched was never asked about, so it cannot appear here at any score.
 * That one only shows up by reading the selector.
 */
import { readFileSync } from "node:fs";
import { DEFAULT_RULE_THRESHOLDS, normalizeRules } from "../src/rules.mjs";
import { loadRules } from "../src/warm.mjs";
import { cachePath } from "../src/cache.mjs";

function parseArgs(argv) {
  const opts = { cache: undefined, at: DEFAULT_RULE_THRESHOLDS.reportAt, rules: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--cache") opts.cache = argv[(i += 1)];
    else if (argv[i] === "--at") opts.at = Number.parseFloat(argv[(i += 1)]);
    else if (argv[i] === "--rules") opts.rules = argv[(i += 1)];
    else throw new Error(`unknown flag ${argv[i]}`);
  }
  return opts;
}

/** The widest gap between consecutive scores, and what sits on each side. */
function widestGap(sorted) {
  let best = { size: 0, above: null, below: null, index: -1 };
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const size = sorted[i].score - sorted[i + 1].score;
    if (size > best.size) {
      best = { size, above: sorted[i], below: sorted[i + 1], index: i };
    }
  }
  return best;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // With `--rules`, each rule is scored at ITS OWN cutoff, so the report says
  // what the shipped config does rather than what a single global number would.
  let atOf = () => opts.at;
  if (opts.rules) {
    const loaded = await loadRules(opts.rules);
    const { rules: normal } = normalizeRules(loaded);
    const byId = new Map(normal.map((r) => [r.id, r]));
    atOf = (id) => {
      const r = byId.get(id);
      return typeof r?.at === "number" ? r.at : opts.at;
    };
  }
  const cache = JSON.parse(readFileSync(cachePath(opts.cache), "utf8"));
  const rows = Object.values(cache.entries ?? {}).filter((e) => e?.kind === "rule");
  if (rows.length === 0) {
    console.log("no ad-hoc rule verdicts in the cache -- run the warm pass with --rules");
    return;
  }

  // Group by (rule id, DRAFT), not by rule id: editing a sentence produces new
  // keys under the same id, so the old verdicts are still here. The plugin
  // never sees them -- it looks up by key -- but averaging two drafts together
  // would show a spread that belongs to neither. `--prune` on the warm pass
  // drops them for good.
  const byRule = new Map();
  for (const row of rows) {
    const id = row.ruleHash ? `${row.rule}@${row.ruleHash}` : row.rule;
    if (!byRule.has(id)) byRule.set(id, []);
    byRule.get(id).push(row);
  }
  const drafts = new Map();
  for (const id of byRule.keys()) {
    const base = id.split("@")[0];
    drafts.set(base, (drafts.get(base) ?? 0) + 1);
  }

  console.log(
    `${rows.length} verdict(s), ${byRule.size} rule draft(s), ` +
      (opts.rules ? "cutoff per rule" : `cutoff ${opts.at.toFixed(2)}`),
  );
  for (const [base, n] of drafts) {
    if (n > 1) {
      console.log(
        `  note: \`${base}\` has ${n} drafts in this cache -- warm with --prune to drop the old ones`,
      );
    }
  }
  console.log("");
  const summary = [];
  for (const [id, group] of byRule) {
    const sorted = group.slice().sort((a, b) => b.score - a.score);
    const at = atOf(group[0].rule);
    const over = sorted.filter((r) => r.score >= at);
    const gap = widestGap(sorted);
    // A gap the cutoff sits inside is a cutoff that does not matter: move it
    // anywhere in there and the same nodes report.
    const cutoffInGap = gap.above !== null && at <= gap.above.score && at > gap.below.score;

    console.log(`${id}`);
    console.log(
      `  ${sorted.length} match(es), ${over.length} over the cutoff (${at.toFixed(2)})`,
    );
    for (const r of sorted) {
      const mark = r.score >= at ? ">>" : "  ";
      const here = gap.above === r && gap.size > 0 ? `   <- gap ${gap.size.toFixed(2)}` : "";
      console.log(
        `  ${mark} ${r.score.toFixed(2)}  conf ${(r.confidence ?? 0).toFixed(2)}  ` +
          `${r.file}:${r.line}  ${r.node}${here}`,
      );
    }
    console.log(
      `  widest gap ${gap.size.toFixed(2)}` +
        (cutoffInGap ? " -- the cutoff is inside it, so its exact value does not matter" : "") +
        (gap.size < 0.5 ? " -- too narrow to separate anything; rewrite the sentence" : ""),
    );
    console.log("");
    summary.push({ id, at, n: sorted.length, over: over.length, gap: gap.size, cutoffInGap });
  }

  console.log(
    "rule@draft                          cutoff  matches  reported  widest gap  cutoff in gap",
  );
  for (const s of summary) {
    console.log(
      `${s.id.padEnd(34)}  ${s.at.toFixed(2).padStart(6)}  ${String(s.n).padStart(7)}  ` +
        `${String(s.over).padStart(8)}  ${s.gap.toFixed(2).padStart(10)}  ` +
        `${s.cutoffInGap ? "yes" : "no"}`,
    );
  }
}

main().catch((err) => {
  console.error(`rules-report: ${err.message}`);
  process.exit(1);
});
