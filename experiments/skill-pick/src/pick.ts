/**
 * `skill-pick` -- the tool.
 *
 *   npx tsx src/pick.ts .               --intent "..."      # needs an API key
 *   npx tsx src/pick.ts . --stage1-only                     # free, no key
 *   npx tsx src/pick.ts . --k 60 --top 12 --json
 *
 * The defaults are the configuration docs/30's eval loop ended on (§6):
 *
 *   overlap@60      a free IDF-overlap prefilter down to 60 candidates.
 *                   NOT because the roster would not fit -- with terse
 *                   criteria all 461 fit in one request (§8) -- but because
 *                   the smaller pool gives a BETTER proposal: P@12 0.30
 *                   against 0.23 for the whole roster (§3).
 *   terse           the four criteria and the task sentence live in the
 *                   state, not repeated per question. Half the tokens, and
 *                   the answers move by 0.057 on average (§8).
 *   --prior         subtract each skill's baseline over the reference
 *                   projects, so a skill that fits every repository stops
 *                   crowding out the one that fits this one (§7).
 *
 * That is 1 request and about $0.0003 a project.
 *
 * `--stage1-only` exists so the tool is useful with no key and no network:
 * the prefilter alone keeps 63% of what the catalog wants at k = 60 (§2),
 * which is enough to hand someone a shortlist.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Jev, score } from "../../shared/jev.js";
import { loadCorpus } from "./corpus.js";
import { readProject } from "./project.js";
import { tokensOf } from "./roster.js";
import { PREFILTERS, chunk, keepTop, keyFor, prescore, questionsFor, stateFor, type Prefilter } from "./stages.js";

const ARGS = process.argv.slice(2);
const flag = (n: string) => ARGS.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = ARGS.indexOf(`--${n}`);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d;
};
const positional = ARGS.filter((a, i) => !a.startsWith("--") && !(i > 0 && ARGS[i - 1].startsWith("--") && !["stage1-only", "json"].includes(ARGS[i - 1].slice(2))));

const root = positional[0];
if (!root) {
  console.error("usage: tsx src/pick.ts <directory> [--intent TEXT] [--k 60] [--top 12]");
  console.error("       [--prefilter overlap|tfidf|firstline|random|none] [--stage1-only] [--json]");
  process.exit(2);
}

const K = Number(opt("k", "60"));
const TOP = Number(opt("top", "12"));
/** 520 terse questions fit and 560 did not (§1); this stays under it. */
const PER_REQUEST = Number(opt("per-request", "400"));
const TERSE = !flag("verbose-criteria");
const PREFILTER = opt("prefilter", "overlap") as Prefilter;
if (!PREFILTERS.includes(PREFILTER)) {
  console.error(`unknown prefilter ${PREFILTER}; one of ${PREFILTERS.join(", ")}`);
  process.exit(2);
}
const INTENT = opt("intent", "");

const corpus = loadCorpus();
const project = readProject(root, INTENT);

/**
 * Each skill's baseline score, measured over docs/30's fourteen reference
 * projects and shipped with the roster.
 *
 * This is the §7 correction in the form a tool can use: the prior does not
 * depend on the repository being scored, so it is computed once and read
 * from the record. Without a record the flag is a no-op and says so.
 */
function loadPriors(): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const rows = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../records/pick.json"), "utf8"),
    ) as { arm: string; name: string; value: number }[];
    const acc = new Map<string, number[]>();
    for (const r of rows) {
      if (r.arm !== "terse") continue;
      acc.set(r.name, [...(acc.get(r.name) ?? []), r.value]);
    }
    for (const [name, vs] of acc) out.set(name, vs.reduce((a, b) => a + b, 0) / vs.length);
  } catch {
    // No record: the flag has nothing to subtract, and `emit` says so.
  }
  return out;
}
const PRIORS = flag("prior") ? loadPriors() : new Map<string, number>();
// The label side is meaningless for a real directory, so the candidates are
// the roster with every label `no`; `pick` never reads a label.
const cands = corpus.roster.entries.map((e) => ({
  name: e.name,
  description: e.description,
  source: e.source,
  kind: e.kind,
  catalogued: null,
  label: "no" as const,
}));

const scores = prescore(PREFILTER, cands, project);
const survivors = keepTop(scores, cands, Math.min(K, cands.length));
const preScoreOf = new Map(scores.map((s) => [s.name, s]));

async function main(): Promise<void> {
  if (flag("stage1-only")) {
    const ranked = [...survivors].sort(
      (a, b) => (preScoreOf.get(b.name)?.score ?? 0) - (preScoreOf.get(a.name)?.score ?? 0),
    );
    emit(
      ranked.slice(0, TOP).map((c) => ({
        name: c.name,
        source: c.source,
        prefilter: Number((preScoreOf.get(c.name)?.score ?? 0).toFixed(2)),
        hits: preScoreOf.get(c.name)?.hits ?? [],
      })),
      { stage2: false },
    );
    return;
  }
  const jev = new Jev();
  const rows: { name: string; source: string; score: number; raw: number; confidence: number; prefilter: number }[] = [];
  for (const group of chunk(survivors, PER_REQUEST)) {
    const res = await askFitting(jev, group);
    for (const c of res.asked) {
      const a = score(res.answers[keyFor(c.name)]);
      const prior = PRIORS.get(c.name);
      rows.push({
        name: c.name,
        source: c.source,
        score: Number((prior === undefined ? a.score : a.score - prior).toFixed(2)),
        raw: Number(a.score.toFixed(2)),
        confidence: Number(a.confidence.toFixed(2)),
        prefilter: Number((preScoreOf.get(c.name)?.score ?? 0).toFixed(2)),
      });
    }
  }
  rows.sort((a, b) => b.score - a.score);
  emit(rows.slice(0, TOP), {
    stage2: true,
    prior: flag("prior") ? (PRIORS.size > 0 ? `subtracted, from ${PRIORS.size} recorded baselines` : "asked for, but no record to read") : "not used",
    requests: jev.calls,
    inputTokens: jev.inputTokens,
    dollars: Number(((jev.inputTokens / 1e6) * 0.042).toFixed(4)),
    ms: Math.round(jev.totalMs / Math.max(1, jev.calls)),
  });
}

/**
 * Ask, and halve on `max_tokens_exceeded`.
 *
 * The per-request count is an estimate and the descriptions here run from 39
 * to 1,068 characters, so a chunk that fits on average can still be 60%
 * over. docs/27 needed the same retry for the same reason.
 */
async function askFitting(
  jev: Jev,
  group: (typeof survivors)[number][],
): Promise<{ asked: typeof group; answers: Awaited<ReturnType<Jev["ask"]>>["answers"] }> {
  let current = group;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const res = await jev.ask(stateFor(project, TERSE), questionsFor(current, TERSE));
      if (current.length === group.length) return { asked: current, answers: res.answers };
      // The chunk was halved; ask for the rest too.
      const rest = await askFitting(jev, group.slice(current.length));
      return { asked: [...current, ...rest.asked], answers: { ...res.answers, ...rest.answers } };
    } catch (err) {
      if (!String(err).includes("max_tokens_exceeded") || current.length <= 1) throw err;
      current = current.slice(0, Math.max(1, Math.floor(current.length / 2)));
    }
  }
  throw new Error("could not fit even one question");
}

function emit(rows: unknown[], meta: Record<string, unknown>): void {
  if (flag("json")) {
    console.log(JSON.stringify({ project: project.id, prefilter: PREFILTER, k: K, rows, ...meta }, null, 2));
    return;
  }
  console.log(`  ${project.id}: ${project.files.length} paths surveyed, ${project.claudeMd.length} CLAUDE.md line(s)`);
  if (!INTENT) console.log("  no --intent given: the request text is the evidence for a third of what a catalog wants (docs/29 §5)");
  console.log(
    `  roster ${cands.length} entries (${tokensOf(corpus.roster.entries)} tokens) ` +
      `-> ${PREFILTER} keeps ${survivors.length} -> ${meta.stage2 ? "scored" : "stage 1 only"}`,
  );
  console.log("");
  for (const row of rows as Record<string, unknown>[]) {
    const head = meta.stage2 ? `${String(row.score).padStart(6)}` : `${String(row.prefilter).padStart(6)}`;
    const raw = meta.stage2 && row.raw !== row.score ? ` (raw ${String(row.raw)})` : "";
    console.log(`  ${head}  ${String(row.name).padEnd(34)} ${String(row.source)}${raw}`);
  }
  if (meta.stage2) {
    console.log("");
    console.log(`  prior: ${meta.prior}`);
    console.log(`  ${meta.requests} request(s), ${meta.inputTokens} input tokens, $${meta.dollars}, ${meta.ms} ms mean`);
  }
  console.log("");
  console.log("  This is a proposal to subtract from. Each entry costs context in every conversation.");
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
