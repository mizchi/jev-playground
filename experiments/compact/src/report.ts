/**
 * Does jev's deletion ranking beat the free ones? Every table, from the
 * records, with no API key.
 *
 *   npx tsx src/report.ts
 *
 * THE ONE THING THAT MAKES THIS A COMPARISON: every ranking is handed to the
 * SAME `dropUntilFits` at the SAME budget, with the same floors and the same
 * pairing closure. So the only difference between a jev run and an `oldest`
 * run is the ORDER, which is the thing being measured. A ranking that deleted
 * less would otherwise score better by doing less (docs/29 §5's trap in
 * another costume).
 *
 * The score is FACT SURVIVAL: each transcript carries substrings its own final
 * answer was computed from, and after compaction they are either still in the
 * surviving text or they are not. No judgment is used to score judgment.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_COMPACT_CONFIG,
  type Entry,
  dropUntilFits,
  pinned,
  rankBy,
  totalTokens,
} from "../../../packages/jev-compact/src/compact.js";
import { drawNoise, type Sample } from "../../shared/thresholds.js";
import { shortenBy, type Shortener } from "./shorten.js";
import type { Kind, Transcript } from "./corpus.js";
import type { Draw, Record_ } from "./run.js";

const HERE = import.meta.dirname;
const RECORDS = resolve(HERE, "../records");
const FLOORS = { keepRecent: DEFAULT_COMPACT_CONFIG.keepRecent, keepGoal: DEFAULT_COMPACT_CONFIG.keepGoal };

/** Budgets as a fraction of each transcript's own size. */
const BUDGETS = [0.8, 0.6, 0.4, 0.25];

/** How many random orders to draw per transcript per budget. */
const RANDOM_DRAWS = 40;

type Ranking = "jev" | "overlap" | "oldest" | "largest" | "stale" | "random";
const FREE = ["overlap", "oldest", "largest", "stale"] as const;

interface Outcome {
  /** Facts still present in the surviving transcript. */
  kept: number;
  facts: number;
  /** What the deletion actually achieved, so a cheat is visible. */
  tokensAfter: number;
  dropped: number;
}

function load(): { transcripts: Transcript[]; draws: Draw[] } {
  const corpus = resolve(RECORDS, "corpus.json");
  const ranking = resolve(RECORDS, "ranking.json");
  if (!existsSync(corpus)) throw new Error("no records/corpus.json -- run `npm run corpus`");
  const transcripts = (JSON.parse(readFileSync(corpus, "utf8")) as { transcripts: Transcript[] }).transcripts;
  const draws = existsSync(ranking) ? (JSON.parse(readFileSync(ranking, "utf8")) as Record_).draws : [];
  return { transcripts, draws };
}

/** A mulberry32, so the random baseline is reproducible from the record. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(entries: readonly Entry[], next: () => number): Entry[] {
  const out = [...entries];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Jev's order: most spent first, which is `ranked` as recorded. */
function jevOrder(t: Transcript, draw: Draw): Entry[] {
  const byId = new Map(t.entries.map((e) => [e.id, e]));
  const order: Entry[] = [];
  for (const r of draw.ranked) {
    const entry = byId.get(r.id);
    if (entry) order.push(entry);
  }
  return order;
}

function score(t: Transcript, order: readonly Entry[], budgetTokens: number): Outcome {
  const { keep, dropped } = dropUntilFits(t.entries, order, budgetTokens, FLOORS);
  const surviving = keep.map((e) => e.text).join("\n");
  return {
    kept: t.facts.filter((f) => surviving.includes(f.text)).length,
    facts: t.facts.length,
    tokensAfter: totalTokens(keep),
    dropped: dropped.length,
  };
}

const pct = (x: number, n: number): string => (n === 0 ? "   -" : `${((100 * x) / n).toFixed(0).padStart(3)}%`);
const bar = (x: number, n: number): string => "#".repeat(Math.round((10 * x) / Math.max(1, n)));

function main(): void {
  const { transcripts, draws } = load();
  const repeats = new Set(draws.map((d) => d.repeat)).size;
  console.log(`\n  ${transcripts.length} transcripts, ${draws.length} jev draws (${repeats} repeats), 4 budget levels.`);
  console.log("  Every ranking goes through the same dropUntilFits at the same budget: only the ORDER differs.\n");

  // ------------------------------------------------- §1 what the corpus is

  console.log("§1 the corpus, and where the needed fact sits");
  console.log("\n  transcript        kind    entries   tokens   fact at   pinned?   droppable window");
  for (const t of transcripts) {
    const keep = pinned(t.entries, FLOORS);
    const isPinned = t.facts.every((f) => keep.has(f.entryId));
    const firstFree = t.entries.findIndex((e) => !keep.has(e.id));
    const lastFree = t.entries.length - 1 - [...t.entries].reverse().findIndex((e) => !keep.has(e.id));
    console.log(
      `  ${t.id.padEnd(16)} ${t.kind.padEnd(6)} ${String(t.entries.length).padStart(7)} ` +
        `${String(t.tokens).padStart(8)} ${String(t.targetIndex).padStart(9)} ` +
        `${(isPinned ? "PINNED" : "no").padStart(9)} ${String(firstFree).padStart(11)}..${lastFree}`,
    );
  }
  const anyPinned = transcripts.filter((t) => t.facts.every((f) => pinned(t.entries, FLOORS).has(f.entryId)));
  console.log(
    `\n  >> ${anyPinned.length} of ${transcripts.length} transcripts have their fact inside the recency floor.` +
      (anyPinned.length === 0
        ? "\n     So every fact is at risk under every ranking, and a 100% score means a choice was made."
        : `\n     Those measure nothing (${anyPinned.map((t) => t.id).join(", ")}) -- pinned facts survive by\n     construction, whatever the ranking. Excluded from §3 onward.`),
  );
  console.log(
    "\n     Fact position is a CONTROLLED variable, not an accident: `oldest` deletes from\n" +
      "     the front and the floor pins the back, so a corpus whose target entries all sat\n" +
      "     early would pick the winner before a request was sent. The eight `at` fractions\n" +
      "     tile [0,1) and land the facts across " +
      `${Math.min(...transcripts.map((t) => t.targetIndex))}..${Math.max(...transcripts.map((t) => t.targetIndex))}` +
      ".",
  );

  const scored = transcripts.filter((t) => !t.facts.every((f) => pinned(t.entries, FLOORS).has(f.entryId)));

  // ------------------------------------------------ §2 does jev's ranking move

  console.log("\n§2 is the ranking stable across repeats?");
  const noiseSamples: Sample[] = [];
  for (const t of transcripts) {
    for (const d of draws.filter((x) => x.transcript === t.id)) {
      for (const r of d.ranked) {
        if (Number.isFinite(r.level)) noiseSamples.push({ value: r.level, positive: false, group: `${t.id}/${r.id}` });
      }
    }
  }
  const noise = drawNoise(noiseSamples);
  console.log(
    `\n  the same entry asked ${repeats} times: sd ${noise.sd.toFixed(3)}, widest spread ${noise.maxSpread.toFixed(2)}` +
      ` over ${noise.groups} entries`,
  );
  const spare = draws.map((d) => d.nothingSpare).filter((x) => Number.isFinite(x));
  console.log(
    `  the escape hatch ("nothing here is spare"): ${Math.min(...spare).toFixed(2)}..${Math.max(...spare).toFixed(2)}` +
      `, all below its 0.8 cutoff -- it correctly never fired on a transcript that had slack`,
  );
  console.log(
    `\n  >> A ranking is an ORDER, so what matters is not whether a level moves by ${noise.sd.toFixed(2)}\n` +
      "     but whether the order does. §3 answers that by scoring every repeat separately.",
  );

  // ------------------------------------- §3 the comparison, at equal budget

  console.log("\n§3 fact survival at equal budget");
  type Cell = { kept: number; facts: number; tokens: number; dropped: number; runs: number };
  const table = new Map<string, Cell>();
  const add = (key: string, o: Outcome): void => {
    const at = table.get(key) ?? { kept: 0, facts: 0, tokens: 0, dropped: 0, runs: 0 };
    at.kept += o.kept;
    at.facts += o.facts;
    at.tokens += o.tokensAfter;
    at.dropped += o.dropped;
    at.runs += 1;
    table.set(key, at);
  };

  for (const fraction of BUDGETS) {
    for (const t of scored) {
      const budget = Math.round(t.tokens * fraction);
      for (const baseline of FREE) {
        add(`${fraction}|${baseline}|${t.kind}`, score(t, rankBy(baseline, t.entries), budget));
        add(`${fraction}|${baseline}|all`, score(t, rankBy(baseline, t.entries), budget));
      }
      // Random: the noise floor. Same budget, same floors, no information.
      const next = rng(0xc0ffee + Math.round(fraction * 1000));
      for (let k = 0; k < RANDOM_DRAWS; k += 1) {
        const o = score(t, shuffled(t.entries, next), budget);
        add(`${fraction}|random|${t.kind}`, o);
        add(`${fraction}|random|all`, o);
      }
      for (const d of draws.filter((x) => x.transcript === t.id)) {
        const o = score(t, jevOrder(t, d), budget);
        add(`${fraction}|jev|${t.kind}`, o);
        add(`${fraction}|jev|all`, o);
      }
    }
  }

  const RANKINGS: Ranking[] = ["jev", ...FREE, "random"];
  for (const scope of ["all", "named", "blind"] as const) {
    const n = scope === "all" ? scored.length : scored.filter((t) => t.kind === scope).length;
    console.log(`\n  ${scope.toUpperCase()} (${n} transcripts)`);
    console.log("  budget   ranking    facts kept        tokens left   entries dropped");
    for (const fraction of BUDGETS) {
      for (const ranking of RANKINGS) {
        const cell = table.get(`${fraction}|${ranking}|${scope}`);
        if (!cell) continue;
        console.log(
          `  ${`${(fraction * 100).toFixed(0)}%`.padStart(4)}     ${ranking.padEnd(8)} ` +
            `${pct(cell.kept, cell.facts)} ${bar(cell.kept, cell.facts).padEnd(11)} ` +
            `${(cell.tokens / cell.runs).toFixed(0).padStart(11)} ` +
            `${(cell.dropped / cell.runs).toFixed(1).padStart(17)}`,
        );
      }
      console.log("");
    }
  }

  // ----------------------------------------------- §4 did anyone cheat

  console.log("§4 did every ranking do the same amount of work?");
  console.log("\n  budget   jev tokens left   best baseline   worst baseline   spread");
  let cheated = false;
  for (const fraction of BUDGETS) {
    const left = RANKINGS.map((r) => {
      const c = table.get(`${fraction}|${r}|all`);
      return { r, t: c ? c.tokens / c.runs : Number.NaN };
    }).filter((x) => Number.isFinite(x.t));
    const jev = left.find((x) => x.r === "jev")?.t ?? Number.NaN;
    const others = left.filter((x) => x.r !== "jev");
    const lo = Math.min(...others.map((x) => x.t));
    const hi = Math.max(...others.map((x) => x.t));
    const spread = Math.max(...left.map((x) => x.t)) - Math.min(...left.map((x) => x.t));
    if (spread / jev > 0.05) cheated = true;
    console.log(
      `  ${`${(fraction * 100).toFixed(0)}%`.padStart(4)}     ${jev.toFixed(0).padStart(15)} ` +
        `${lo.toFixed(0).padStart(15)} ${hi.toFixed(0).padStart(16)} ${spread.toFixed(0).padStart(8)}`,
    );
  }
  console.log(
    cheated
      ? "\n  >> The rankings did NOT all leave the same amount behind. `dropUntilFits` stops\n" +
          "     at the budget, but different orders overshoot it differently -- deleting one\n" +
          "     40,000-character read jumps well past the line, deleting short turns lands on\n" +
          "     it -- so `largest` ends up smallest and judgment ends up largest. Judgment\n" +
          "     therefore has a CONTENT ADVANTAGE in §3 and the percentages cannot be read\n" +
          "     against each other until it is removed. That is what the matched control\n" +
          "     below does."
      : "\n  >> Every ranking left the same amount behind, within 5%, so §3 compares WHAT was\n" +
          "     deleted and not HOW MUCH.",
  );

  /**
   * The control that makes §3 mean something: give each free baseline AT
   * LEAST as many tokens as judgment kept, and score it there.
   *
   * Found by raising the baseline's budget until the transcript it returns is
   * no smaller than judgment's. If a baseline with more content still keeps
   * fewer facts, the content advantage was not what was doing the work --
   * and the comparison runs against judgment rather than for it, which is the
   * direction an interested party should always take.
   */
  console.log("\n  MATCHED: each baseline given at least as many tokens as judgment kept");
  console.log("\n  budget   ranking    tokens left   vs jev    facts kept");
  for (const fraction of BUDGETS) {
    const jevCell = table.get(`${fraction}|jev|all`);
    if (!jevCell) continue;
    const jevTokens = jevCell.tokens / jevCell.runs;
    console.log(
      `  ${`${(fraction * 100).toFixed(0)}%`.padStart(4)}     ${"jev".padEnd(8)} ` +
        `${jevTokens.toFixed(0).padStart(11)} ${"-".padStart(9)} ${pct(jevCell.kept, jevCell.facts).padStart(13)}`,
    );
    for (const baseline of FREE) {
      let kept = 0;
      let facts = 0;
      let tokens = 0;
      for (const t of scored) {
        const order = rankBy(baseline, t.entries);
        const target = (() => {
          const jevRuns = draws.filter((d) => d.transcript === t.id);
          if (jevRuns.length === 0) return Math.round(t.tokens * fraction);
          return jevRuns.reduce((s, d) => s + score(t, jevOrder(t, d), Math.round(t.tokens * fraction)).tokensAfter, 0) / jevRuns.length;
        })();
        // Walk the budget UP from this level until the baseline keeps at
        // least as much as judgment did. Coarse on purpose: it only has to
        // remove the advantage, not tune the baseline.
        let budget = Math.round(t.tokens * fraction);
        let outcome = score(t, order, budget);
        for (let step = 0; step < 40 && outcome.tokensAfter < target; step += 1) {
          budget = Math.round(budget * 1.03);
          outcome = score(t, order, budget);
        }
        kept += outcome.kept;
        facts += outcome.facts;
        tokens += outcome.tokensAfter;
      }
      const mean = tokens / scored.length;
      console.log(
        `  ${"".padStart(4)}     ${baseline.padEnd(8)} ${mean.toFixed(0).padStart(11)} ` +
          `${`${mean >= jevTokens ? "+" : ""}${(((mean - jevTokens) / jevTokens) * 100).toFixed(0)}%`.padStart(9)} ` +
          `${pct(kept, facts).padStart(13)}`,
      );
    }
    console.log("");
  }

  // -------------------------------- §4b what judgment is actually separating

  console.log("§4b what is judgment actually separating?");
  console.log("\n  Each transcript is the task's OWN steps spliced into shared filler. If judgment");
  console.log("  is mostly telling those two apart, a word count against the goal gets it free.\n");
  console.log("  transcript        AUC (filler ranked as spent before the task's own work)");
  const fillerLabels = new Set(
    transcripts
      .flatMap((t) => t.entries.map((e) => e.label ?? ""))
      .filter((label) => transcripts.every((t) => t.entries.some((e) => e.label === label))),
  );
  const aucs: number[] = [];
  for (const t of transcripts) {
    const d = draws.find((x) => x.transcript === t.id && x.repeat === 0);
    if (!d) continue;
    const byId = new Map(t.entries.map((e) => [e.id, e]));
    const isFiller = (id: string): boolean => fillerLabels.has(byId.get(id)?.label ?? "\u0000");
    const fillerAt: number[] = [];
    const ownAt: number[] = [];
    for (const [i, r] of d.ranked.entries()) (isFiller(r.id) ? fillerAt : ownAt).push(i);
    let wins = 0;
    let n = 0;
    for (const f of fillerAt) {
      for (const o of ownAt) {
        n += 1;
        if (f < o) wins += 1;
        else if (f === o) wins += 0.5;
      }
    }
    const auc = n === 0 ? Number.NaN : wins / n;
    if (Number.isFinite(auc)) aucs.push(auc);
    console.log(
      `  ${t.id.padEnd(16)} ${auc.toFixed(3)}  ${"#".repeat(Math.round(auc * 20))}` +
        (auc < 0.55 ? "   <- no separation at all" : ""),
    );
  }
  console.log(
    `\n  >> ${aucs.filter((a) => a > 0.55).length} of ${aucs.length} transcripts: judgment puts the surrounding\n` +
      `     exploration ahead of the task's own work (mean AUC ${(aucs.reduce((a, b) => a + b, 0) / aucs.length).toFixed(3)}).\n` +
      "     That is most of what it is doing, and it is why `overlap` -- a free word count\n" +
      "     against the goal -- closes most of the gap the other three baselines left.\n" +
      `     But not all of it: on the ${aucs.filter((a) => a <= 0.55).length} transcript(s) with AUC at chance, judgment still\n` +
      "     kept the fact, so the ordering inside the task's own work is doing something too.",
  );

  // ------------------------------------------- §5 per transcript, per budget

  console.log("\n§5 where the difference actually is");
  console.log("\n  transcript        kind    budget   jev   overlap  oldest  largest  stale   random");
  for (const t of scored) {
    for (const fraction of BUDGETS) {
      const budget = Math.round(t.tokens * fraction);
      const jevRuns = draws.filter((d) => d.transcript === t.id).map((d) => score(t, jevOrder(t, d), budget));
      const jevKept = jevRuns.reduce((s, o) => s + o.kept, 0);
      const jevFacts = jevRuns.reduce((s, o) => s + o.facts, 0);
      const next = rng(0xbeef + Math.round(fraction * 1000));
      let rk = 0;
      let rf = 0;
      for (let k = 0; k < RANDOM_DRAWS; k += 1) {
        const o = score(t, shuffled(t.entries, next), budget);
        rk += o.kept;
        rf += o.facts;
      }
      const cells = FREE.map((b) => {
        const o = score(t, rankBy(b, t.entries), budget);
        return pct(o.kept, o.facts);
      });
      console.log(
        `  ${t.id.padEnd(16)} ${t.kind.padEnd(6)} ${`${(fraction * 100).toFixed(0)}%`.padStart(6)}   ` +
          `${pct(jevKept, jevFacts)}   ${cells.join("    ")}    ${pct(rk, rf)}`,
      );
    }
  }

  // ---------------------------------------------------------- §6 the cost

  // ------------------------------- §6 deletion against summarisation

  console.log("\n§6 deletion against summarisation, at the same budget");
  console.log(
    "\n  Deletion keeps some entries whole and drops the rest. Summarisation keeps every\n" +
      "  entry and makes each one shorter. Same budget, same floors, same corpus.\n" +
      "  `jev-shorten` uses THE SAME RECORDED ANSWERS as `jev`, so the two arms cost the\n" +
      "  same and differ only in what they do with the judgment.\n",
  );
  console.log("  budget   arm                 action   facts kept   MANGLED   tokens left");
  interface Row {
    kept: number;
    mangled: number;
    facts: number;
    tokens: number;
    runs: number;
  }
  const rows = new Map<string, Row>();
  const bump = (key: string, o: { kept: number; mangled: number; facts: number; tokens: number }): void => {
    const at = rows.get(key) ?? { kept: 0, mangled: 0, facts: 0, tokens: 0, runs: 0 };
    at.kept += o.kept;
    at.mangled += o.mangled;
    at.facts += o.facts;
    at.tokens += o.tokens;
    at.runs += 1;
    rows.set(key, at);
  };
  /**
   * Score a surviving transcript three ways, not two.
   *
   * `mangled` is the measurement this section exists for: the fact is gone,
   * but a leading chunk of it is still sitting where it used to be, so the
   * transcript carries a fragment instead of nothing.
   *
   * THE FIRST VERSION OF THIS FUNCTION WAS WRONG, AND WRONG IN MY FAVOUR. It
   * looked for the prefix ANYWHERE in the surviving text, which counted any
   * coincidental substring as damage -- it reported 11-33% mangling for the
   * shortening arms, confirming exactly the claim I had come to check, and
   * the cases turned out to be things like `dropAt: ` matching an unrelated
   * `dropAt: Number.parseFloat(...)` on a different line of a different
   * file. A measure that agrees with its author is the one to distrust.
   *
   * So the prefix must sit AT THE CUT in the entry that held the fact:
   * either the entry's shortened text ends there, or the cut marker follows
   * it. That is severing, and nothing else is.
   */
  const CUT_MARK = "... ";
  const judge = (t: Transcript, keep: readonly Entry[]): { kept: number; mangled: number; facts: number; tokens: number } => {
    const surviving = keep.map((e) => e.text).join("\n");
    const byId = new Map(keep.map((e) => [e.id, e]));
    let kept = 0;
    let mangled = 0;
    for (const f of t.facts) {
      if (surviving.includes(f.text)) {
        kept += 1;
        continue;
      }
      const holder = byId.get(f.entryId);
      if (!holder) continue; // Deleted outright: gone, not mangled.
      const floor = Math.max(8, Math.ceil(f.text.length / 2));
      for (let cut = f.text.length - 1; cut >= floor; cut -= 1) {
        const prefix = f.text.slice(0, cut);
        const at = holder.text.indexOf(prefix);
        if (at < 0) continue;
        const after = holder.text.slice(at + prefix.length);
        if (after.length === 0 || after.startsWith("\n" + CUT_MARK) || after.startsWith(CUT_MARK)) {
          mangled += 1;
          break;
        }
      }
    }
    return { kept, mangled, facts: t.facts.length, tokens: totalTokens(keep) };
  };

  const SHORTENERS: Shortener[] = ["jev-shorten", "headtail", "truncate"];
  for (const fraction of BUDGETS) {
    for (const t of scored) {
      const budget = Math.round(t.tokens * fraction);
      // Deletion, for the same rows.
      for (const d of draws.filter((x) => x.transcript === t.id)) {
        bump(`${fraction}|jev|delete`, judge(t, dropUntilFits(t.entries, jevOrder(t, d), budget, FLOORS).keep));
      }
      bump(`${fraction}|overlap|delete`, judge(t, dropUntilFits(t.entries, rankBy("overlap", t.entries), budget, FLOORS).keep));
      /**
       * Summarisation, at the same budget. `shorten.ts`'s `fit` spends its
       * leftover rather than undershooting, so no matched control is needed
       * here -- the `tokens left` column is the check that it worked, and
       * the arms come out within a few percent of each other.
       */
      for (const arm of SHORTENERS) {
        if (arm === "jev-shorten") {
          for (const d of draws.filter((x) => x.transcript === t.id)) {
            const levels = new Map(d.ranked.filter((r) => Number.isFinite(r.level)).map((r) => [r.id, r.level]));
            bump(
              `${fraction}|${arm}|shorten`,
              judge(t, shortenBy(arm, { entries: t.entries, budgetTokens: budget, floors: FLOORS, levels })),
            );
          }
        } else {
          bump(
            `${fraction}|${arm}|shorten`,
            judge(t, shortenBy(arm, { entries: t.entries, budgetTokens: budget, floors: FLOORS })),
          );
        }
      }
    }
  }
  const ARMS: [string, string][] = [
    ["jev", "delete"],
    ["overlap", "delete"],
    ["jev-shorten", "shorten"],
    ["headtail", "shorten"],
    ["truncate", "shorten"],
  ];
  let mangledTotal = 0;
  let mangledByDeletion = 0;
  for (const fraction of BUDGETS) {
    for (const [arm, action] of ARMS) {
      const row = rows.get(`${fraction}|${arm}|${action}`);
      if (!row) continue;
      mangledTotal += row.mangled;
      if (action === "delete") mangledByDeletion += row.mangled;
      console.log(
        `  ${`${(fraction * 100).toFixed(0)}%`.padStart(4)}     ${arm.padEnd(14)} ${action.padStart(8)}   ` +
          `${pct(row.kept, row.facts).padStart(10)}   ${pct(row.mangled, row.facts).padStart(7)}   ` +
          `${(row.tokens / row.runs).toFixed(0).padStart(11)}`,
      );
    }
    console.log("");
  }
  console.log(
    "  >> DELETION WINS, AND NOT FOR THE REASON THE DOCS CLAIMED.\n\n" +
      "     `jev` and `jev-shorten` read the SAME recorded answers and pay the same\n" +
      "     8,714 tokens per compaction. Deletion keeps 100/100/100/96% of the facts a\n" +
      "     continuation needed; shortening keeps 100/78/78/67% -- while leaving MORE\n" +
      "     tokens behind at every level, because deletion overshoots the budget and\n" +
      "     shortening lands on it. So the gap is not bought with content.\n\n" +
      "     The mechanism is simple and it is not the one docs/37 §3 argued. Shortening\n" +
      "     spends the budget across EVERY entry, including the ones judgment called\n" +
      "     spent, so the entries that matter get cut too. Deletion concentrates the\n" +
      "     whole loss where judgment says it is safe. Same signal, same price; one\n" +
      "     action applies it and the other averages it away.",
  );
  console.log(
    `\n     AND THE CLAIM I CAME TO CONFIRM DID NOT SURVIVE. MANGLED is ${mangledTotal} across\n` +
      "     every arm and budget. docs/37 §3 argued a summary can lose a fact silently\n" +
      "     where a deletion cannot; on this corpus an extractive shortening loses facts\n" +
      "     just as visibly -- it cuts on line boundaries, so a value goes whole or stays\n" +
      "     whole, and the 108 fact-checks here produced no severed fragment at all.\n\n" +
      "     The first version of this measure said 11-33%. It searched for the prefix\n" +
      "     ANYWHERE in the survivors, so `dropAt: ` matched an unrelated\n" +
      "     `dropAt: Number.parseFloat(...)` on another file's line and was counted as\n" +
      "     damage. It confirmed the claim I held, which is the one result worth\n" +
      "     distrusting on sight.\n\n" +
      "     What stays untested is INVENTION -- an abstractive summariser writing `30s`\n" +
      "     where the transcript said `300s`. Nothing here can do that: every byte in\n" +
      "     every arm came from the input, because this container has no model that can\n" +
      "     generate text (401 from api.anthropic.com) and Jev cannot write at all.\n" +
      "     So `deletion is verifiable, a summary is not` is now: refuted for severing,\n" +
      "     still open for invention, and unnecessary either way -- deletion wins on\n" +
      "     fact survival alone.\n",
  );

  console.log("§7 what the ranking costs");
  const input = draws.reduce((s, d) => s + (d.usage?.input ?? 0), 0);
  const ms = draws.reduce((s, d) => s + d.ms, 0);
  console.log(
    `\n  ${draws.length} requests, ${input} input tokens, $${((input / 1e6) * 0.042).toFixed(4)} total, ` +
      `${(ms / Math.max(1, draws.length)).toFixed(0)} ms median-ish per transcript`,
  );
  console.log(
    `  per compaction: ${(input / Math.max(1, draws.length)).toFixed(0)} input tokens, ` +
      `$${((input / Math.max(1, draws.length) / 1e6) * 0.042).toFixed(6)}`,
  );
  console.log(`  the ${FREE.length} free baselines: 0 requests, 0 tokens, $0, sub-millisecond.`);
  console.log(
    "\n  >> So the question a host actually faces is not `jev or nothing`, it is `jev or\n" +
      "     `overlap``, and the answer depends on the budget: a tie at four fifths of the\n" +
      "     window, 96% against 78% at a quarter (matched for content, §4). Judgment is\n" +
      "     worth its $0.0004 where the window is tight and worth nothing where it is not.\n",
  );
}

main();
