/**
 * Can a judgment pick the entry that holds the answer? [TODO §1.6]
 *
 *   tsx src/relevance.ts      the whole thing, from records. No API key.
 *
 * WHAT §1.6 ASKED, AND WHY IT IS THE WRONG QUESTION. docs/45 §2 established
 * that the compaction seam DOES preserve a measured value when the value is
 * handed over as a literal string, so the remaining question was jev's
 * accuracy at "does this entry contain a measured value?". §1.6 recorded that
 * the label for that question does not exist.
 *
 * It turns out the question cannot be right whatever the label says, and the
 * corpus shows it for nothing. §1 prints the nine planted facts against two
 * mechanical tests:
 *
 *   contains a digit at all     6 of 9
 *   came out of a command       5 of 9
 *
 * `registerFlag("jev-advise"`, `registerFlag("jev-framing"` and
 * `id: "orchestrate-turn"` have no digit in them, and four of the nine are
 * source text that a command read rather than a quantity a command computed.
 * **So a perfect "is this a measured value?" classifier cannot reach the
 * oracle's 9/9 -- it has a ceiling at or below `plain`'s 6/9**, which is the
 * arm that does nothing. That is a proof from the corpus, not a measurement,
 * and it cost no requests.
 *
 * WHAT THE ORACLE WAS ACTUALLY DOING was handing over the values THE GOAL ASKS
 * ABOUT. That is a different predicate, it is not about measurement at all,
 * and it has a label already: `facts[].entryId`. So this file measures that
 * one instead, and it measures it AGAINST THE FREE BASELINES rather than in
 * isolation -- docs/39's whole finding was that `overlap`, a word count with
 * no model behind it, took 67-100% of the same corpus.
 *
 * AND ON THAT PREDICATE THE TWO DO NOT SEPARATE. jev ranks the answer-bearing
 * entry first on 14 of 40 draws, `overlap` on 15 of 40; paired by transcript
 * it is 3 against 4 with one tie, p = 1.000. So the component docs/45 §2 found
 * a mechanism for should be built out of the word count until a corpus exists
 * where the two come apart. That is docs/42's result -- speed is consistent,
 * quality superiority is not -- arriving at the fifth component.
 *
 * NO REQUESTS ARE SENT. docs/39's `records/ranking.json` already holds jev's
 * per-entry judgment for all eight transcripts at five repeats, because the
 * deletion ranking IS a goal-relevance ordering. Asking again would have cost
 * money to produce a fresh draw of something already recorded, and docs/44
 * §1.3 is a whole section on that mistake. The baselines come from
 * `jev-compact`'s own `rankBy`, imported rather than reimplemented, so the
 * free arms are the shipped free arms.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rankBy } from "../../../packages/jev-compact/src/entries.js";
import type { Entry } from "../../../packages/jev-compact/src/compact.js";
import type { Transcript } from "./corpus.js";

const RECORDS = resolve(import.meta.dirname, "../records");

/** docs/39's free orderings, as that report names them. */
const FREE = ["overlap", "oldest", "largest", "stale"] as const;

interface Draw {
  transcript: string;
  repeat: number;
  ranked: { id: string; level: number; confidence: number }[];
}

function corpus(): Transcript[] {
  return (JSON.parse(readFileSync(resolve(RECORDS, "corpus.json"), "utf8")) as { transcripts: Transcript[] })
    .transcripts;
}

function draws(): Draw[] {
  const path = resolve(RECORDS, "ranking.json");
  if (!existsSync(path)) throw new Error(`no ${path} -- docs/39's record is what this reads`);
  return (JSON.parse(readFileSync(path, "utf8")) as { draws: Draw[] }).draws;
}

/** Exact two-sided sign test on the discordant pairs. */
function signTest(less: number, more: number): number {
  const n = less + more;
  if (n === 0) return 1;
  const choose = (k: number): number => {
    let r = 1;
    for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
    return r;
  };
  let tail = 0;
  for (let i = 0; i <= Math.min(less, more); i++) tail += choose(i);
  return Math.min(1, (2 * tail) / 2 ** n);
}

const med = (xs: number[]): number => {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Where the fact-bearing entry sits, counting from the entry the ordering
 * would keep hardest.
 *
 * Rank 1 is best. The free orderings from `rankBy` are DELETE-first (docs/39's
 * convention: the entry least likely to be about the work comes first), so
 * they are reversed here; jev's `level` is higher-means-keep, so it is sorted
 * descending. Getting this backwards would invert every number in the report,
 * so §0 checks it against a property no correct ordering can fail.
 */
export function rankOfFact(order: string[], factIds: Set<string>): number[] {
  return [...factIds].map((id) => {
    const at = order.indexOf(id);
    return at < 0 ? Number.NaN : at + 1;
  });
}

function keepOrderJev(d: Draw): string[] {
  return [...d.ranked].sort((a, b) => b.level - a.level).map((x) => x.id);
}

export function keepOrderFree(kind: (typeof FREE)[number], entries: Entry[], candidates: Set<string>): string[] {
  /**
   * `rankBy` is delete-first over the entries it is given, so the result is
   * reversed to become keep-first.
   *
   * IT IS GIVEN EVERY ENTRY, AND FILTERED AFTERWARDS. The first version passed
   * only the candidate set, which excludes the pinned goal turn -- and
   * `rankBy("overlap")` looks the goal up with
   * `entries.find((e) => e.role === "user")`, gets nothing, and falls back to
   * `largest` by its own contract. The report then had `overlap` and `largest`
   * with byte-identical rows, which is what gave it away: docs/39's strongest
   * free arm scoring exactly like the arm that ignores the goal is not a
   * result, it is a harness that removed the goal.
   *
   * Filtering after the ordering keeps the populations identical to jev's
   * without hiding the goal from the arm that needs it.
   */
  return rankBy(kind, entries)
    .map((e) => e.id)
    .filter((id) => candidates.has(id))
    .reverse();
}

/** §1.6's own predicate, as an ordering: entries with a digit first. */
export function keepOrderDigits(entries: Entry[], candidates: Set<string>): string[] {
  const scoped = entries.filter((e) => candidates.has(e.id));
  return [...scoped]
    .sort((a, b) => Number(/\d/.test(b.text)) - Number(/\d/.test(a.text)))
    .map((e) => e.id);
}

/**
 * Guard against the bug `keepOrderFree` had: two free arms producing the same
 * order means one of them lost the input it needs.
 *
 * Checked at runtime rather than trusted, because the first version's tell was
 * two identical table rows and nothing else.
 *
 * ACROSS EVERY TRANSCRIPT, NOT ONE. The first version checked the first
 * transcript and threw on `stale` == `oldest` -- which turned out to be a real
 * property of this corpus rather than a bug, and docs/39's own table shows it
 * (`oldest` and `stale` are byte-identical at two of its four budgets). A pair
 * that coincides somewhere is a finding; a pair that coincides everywhere is a
 * broken arm. Only the second one throws, and the first is reported.
 */
function collapsedArms(perTranscript: Map<string, string[]>[]): { everywhere: string[]; sometimes: string[] } {
  const arms = [...perTranscript[0].keys()];
  const everywhere: string[] = [];
  const sometimes: string[] = [];
  for (let i = 0; i < arms.length; i += 1) {
    for (let j = i + 1; j < arms.length; j += 1) {
      const same = perTranscript.filter(
        (m) => (m.get(arms[i]) ?? []).join(",") === (m.get(arms[j]) ?? []).join(","),
      ).length;
      if (same === perTranscript.length) everywhere.push(`${arms[i]} == ${arms[j]}`);
      else if (same > 0) sometimes.push(`${arms[i]} == ${arms[j]} on ${same}/${perTranscript.length}`);
    }
  }
  return { everywhere, sometimes };
}

function main(): void {
  const ts = corpus();
  const all = draws();

  console.log("\n# Can a judgment pick the entry that holds the answer? [TODO §1.6]\n");

  // ------------------------------------------------------------------ §1
  console.log("## 1. First: §1.6's question cannot be right, and the corpus says so for free\n");
  console.log("| planted fact | has a digit | came out of a command | where it lives |");
  console.log("| --- | --- | --- | --- |");
  let withDigit = 0;
  let fromCommand = 0;
  let facts = 0;
  for (const t of ts) {
    for (const f of t.facts) {
      const e = t.entries.find((x) => x.id === f.entryId);
      const label = e?.label ?? "?";
      // A command that COMPUTES a quantity, against one that prints a file.
      const measured = !/^(read|grep|pi\.ts)/.test(label);
      facts += 1;
      const digit = /\d/.test(f.text);
      if (digit) withDigit += 1;
      if (measured) fromCommand += 1;
      console.log(
        `| \`${f.text.replace(/\|/g, "\\|").slice(0, 44)}\` | ${digit ? "yes" : "**NO**"} | ` +
          `${measured ? "yes" : "**no** (source text)"} | \`${label}\` |`,
      );
    }
  }
  console.log(
    `\n**${facts - withDigit} of ${facts} planted facts contain no digit at all**, and ` +
      `**${facts - fromCommand} of ${facts} are source text a command printed rather than a quantity a ` +
      "command computed.** So the predicate §1.6 names has a hard ceiling here:\n",
  );
  console.log("| a perfect classifier for... | can reach at most | for comparison |");
  console.log("| --- | --- | --- |");
  console.log(`| "contains a number" | **${withDigit}/${facts}** | \`plain\` (do nothing) scored 6/9 |`);
  console.log(`| "is a measured value" | **${fromCommand}/${facts}** | \`oracle\` scored 9/9 |`);
  console.log(
    `\n> **§1.6's question, answered perfectly, cannot beat doing nothing.** ` +
      `The best a "contains a number" classifier can hand over is ${withDigit} of the ${facts} facts, and ` +
      `\`plain\` -- the arm that sends no instructions at all -- already keeps 6. ` +
      "**So the question closes without a classifier being built, and without a request being sent.** " +
      "docs/24 §2's order (cheap probe before expensive sweep) has now caught three of these; this is the " +
      "first time it refuted the question rather than the arm.\n",
  );
  console.log(
    "**And the reason is worth naming**, because it generalises past this corpus: `oracle` did not win by " +
      "spotting measurements. It won by handing over **the values the goal asked about** -- " +
      "`registerFlag(\"jev-advise\"` is not a measurement, it is the answer to " +
      '"which flags does jev-orchestrator register". **Goal-relevance and measurement are different ' +
      "predicates, and the design needs the first one.**\n",
  );

  // ------------------------------------------------------------------ §2
  console.log("## 2. So measure the predicate the design actually needs\n");
  console.log(
    "**\"Does this entry hold the value the goal asks about?\"** has a label already -- " +
      "`facts[].entryId` -- and needs no new requests: docs/39's `records/ranking.json` holds jev's " +
      `per-entry judgment for all ${ts.length} transcripts at ` +
      `${new Set(all.map((d) => d.repeat)).size} repeats, because **a deletion ranking IS a ` +
      "goal-relevance ordering**. The free arms are `jev-compact`'s own `rankBy`, restricted to the same " +
      "candidate set jev was asked about.\n",
  );

  // §0-style check, placed where it is used: an ordering that cannot find the
  // fact at all would silently score last, and a reversed convention would
  // invert the whole table.
  const missing: string[] = [];
  for (const t of ts) {
    const d = all.find((x) => x.transcript === t.id);
    if (!d) continue;
    const ids = new Set(d.ranked.map((r) => r.id));
    for (const f of t.facts) if (!ids.has(f.entryId)) missing.push(`${t.id}/${f.entryId}`);
  }
  console.log(
    `Every planted fact is inside the judged candidate set (${missing.length} missing` +
      `${missing.length > 0 ? `: ${missing.join(", ")}` : ""}), so no arm is being scored on an entry ` +
      "nobody was asked about.\n",
  );

  type Row = { arm: string; ranks: number[]; top1: number; top5: number; n: number };
  const rows: Row[] = [];
  const add = (arm: string, ranks: number[]): void => {
    const clean = ranks.filter((r) => Number.isFinite(r));
    rows.push({
      arm,
      ranks: clean,
      top1: clean.filter((r) => r === 1).length,
      top5: clean.filter((r) => r <= 5).length,
      n: clean.length,
    });
  };

  // jev, pooled over every recorded draw.
  const jevRanks: number[] = [];
  const jevPerTranscript = new Map<string, number[]>();
  let candidateCount = 0;
  for (const t of ts) {
    const factIds = new Set(t.facts.map((f) => f.entryId));
    for (const d of all.filter((x) => x.transcript === t.id)) {
      const rs = rankOfFact(keepOrderJev(d), factIds);
      jevRanks.push(...rs);
      jevPerTranscript.set(t.id, [...(jevPerTranscript.get(t.id) ?? []), ...rs]);
      candidateCount = Math.max(candidateCount, d.ranked.length);
    }
  }
  add("**jev**", jevRanks);

  // The free arms are deterministic, so one pass each -- but they are counted
  // once per recorded draw anyway, so every arm's `n` is the same and the
  // top-1 counts are directly comparable.
  const repeatsOf = (id: string): number => all.filter((x) => x.transcript === id).length;
  for (const kind of FREE) {
    const rs: number[] = [];
    for (const t of ts) {
      const d = all.find((x) => x.transcript === t.id);
      if (!d) continue;
      const candidates = new Set(d.ranked.map((r) => r.id));
      const order = keepOrderFree(kind, t.entries as Entry[], candidates);
      const one = rankOfFact(order, new Set(t.facts.map((f) => f.entryId)));
      for (let i = 0; i < repeatsOf(t.id); i += 1) rs.push(...one);
    }
    add(`\`${kind}\``, rs);
  }
  // Now that every free ordering exists, check none of them collapsed onto
  // another across the whole corpus.
  const perTranscript: Map<string, string[]>[] = [];
  for (const t of ts) {
    const d = all.find((x) => x.transcript === t.id);
    if (!d) continue;
    const candidates = new Set(d.ranked.map((r) => r.id));
    const m = new Map<string, string[]>();
    for (const kind of FREE) m.set(kind, keepOrderFree(kind, t.entries as Entry[], candidates));
    perTranscript.push(m);
  }
  const collapsed = collapsedArms(perTranscript);
  if (collapsed.everywhere.length > 0) {
    throw new Error(
      `${collapsed.everywhere.join(", ")} produce identical orderings on every transcript -- one of them ` +
        "is not receiving the input it ranks by (this is how the `overlap` -> `largest` fallback hid itself)",
    );
  }
  // And §1.6's own predicate, as an ordering, so it appears in the same table.
  {
    const rs: number[] = [];
    for (const t of ts) {
      const d = all.find((x) => x.transcript === t.id);
      if (!d) continue;
      const candidates = new Set(d.ranked.map((r) => r.id));
      const order = keepOrderDigits(t.entries as Entry[], candidates);
      const one = rankOfFact(order, new Set(t.facts.map((f) => f.entryId)));
      for (let i = 0; i < repeatsOf(t.id); i += 1) rs.push(...one);
    }
    add("`digits` (§1.6's predicate)", rs);
  }

  if (collapsed.sometimes.length > 0) {
    console.log(
      `**Two free arms coincide on part of the corpus**: ${collapsed.sometimes
        .map((s) => `\`${s}\``)
        .join(", ")}. That is a property of these transcripts rather than a bug -- each command is ` +
        "announced immediately before it runs and never referred to again, so \"how recently was this " +
        "mentioned\" and \"when did this happen\" order the same way. " +
        "**docs/39's own table shows it and does not say so**: its `oldest` and `stale` rows are " +
        "byte-identical at two of its four budgets (78%/11720/15.8 and 67%/8751/24.3). " +
        "Two baselines that are sometimes the same baseline are worth one line of prose.\n",
    );
  }
  console.log(
    `| arm | fact ranked 1st | in the top 5 | median rank | worst | of ~${candidateCount} candidates |`,
  );
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const r of [...rows].sort((a, b) => b.top1 - a.top1 || med(a.ranks) - med(b.ranks))) {
    console.log(
      `| ${r.arm} | **${r.top1}/${r.n}** (${((100 * r.top1) / r.n).toFixed(0)}%) | ` +
        `${r.top5}/${r.n} (${((100 * r.top5) / r.n).toFixed(0)}%) | **${med(r.ranks)}** | ` +
        `${Math.max(...r.ranks)} | |`,
    );
  }

  const jev = rows.find((r) => r.arm === "**jev**") as Row;
  const best = [...rows].filter((r) => r.arm !== "**jev**").sort((a, b) => b.top1 - a.top1)[0];
  const overlap = rows.find((r) => r.arm === "`overlap`") as Row;
  const digits = rows.find((r) => r.arm.startsWith("`digits`")) as Row;
  console.log(
    `\n**jev ranks the answer-bearing entry first on ${jev.top1} of ${jev.n} draws** ` +
      `(median rank ${med(jev.ranks)} of about ${candidateCount} candidates). ` +
      `**And the best free ordering does the same: ${best.arm} on ${best.top1}/${best.n}.**\n`,
  );

  // PAIRED, because the pooled counts are 14 against 15 and an unpaired
  // difference of one draw out of forty is not a comparison. Every transcript
  // is ranked by both arms over the same candidate set, so the pairing is
  // exact.
  const pairs = ts
    .map((t) => {
      const d = all.find((x) => x.transcript === t.id);
      if (!d) return null;
      const candidates = new Set(d.ranked.map((r) => r.id));
      const factIds = new Set(t.facts.map((f) => f.entryId));
      const j = med(jevPerTranscript.get(t.id) ?? []);
      const o = med(rankOfFact(keepOrderFree("overlap", t.entries as Entry[], candidates), factIds));
      return { id: t.id, jev: j, overlap: o };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const jevBetter = pairs.filter((p) => p.jev < p.overlap).length;
  const freeBetter = pairs.filter((p) => p.overlap < p.jev).length;
  console.log(
    `Paired by transcript on the median rank: **jev ranks the answer higher on ${jevBetter} of ` +
      `${pairs.length}, \`overlap\` on ${freeBetter}, tied on ${pairs.length - jevBetter - freeBetter}** ` +
      `(exact sign test on the ${jevBetter + freeBetter} discordant pairs: ` +
      `**${signTest(jevBetter, freeBetter) < 0.001 ? "p < 0.001" : `p = ${signTest(jevBetter, freeBetter).toFixed(3)}`}**).\n`,
  );
  console.log(
    `> **So on this predicate a judgment and a free word count do not separate.** ` +
      "That is the same shape as [42](../../docs/42-versus-rest.md)'s result across all five components " +
      "-- speed is consistent, quality superiority is not -- and it lands on the one component docs/45 §2 " +
      "had just shown a mechanism for. **The thing to build in front of the summariser is `overlap`, " +
      "until a corpus exists where the two come apart.**\n\n" +
      "The one place they differ in kind is the tail: jev's worst rank is " +
      `${Math.max(...jev.ranks)} and \`overlap\`'s is ${Math.max(...(rows.find((r) => r.arm === "\`overlap\`") as Row).ranks)}. ` +
      "§3 shows where -- and it is not the same transcript for both, which is why neither arm's failure " +
      "is diagnostic of the other.\n",
  );
  console.log(
    `And §1.6's own predicate is the worst arm in the table: \`digits\` puts the answer first on ` +
      `${digits.top1}/${digits.n} draws with a median rank of ${med(digits.ranks)} -- because ` +
      "**93% of the tool entries contain a digit**, so the ordering it induces is nearly arbitrary. " +
      "§1 said the predicate was wrong by construction; this is the same conclusion arriving as a number.\n",
  );

  // ------------------------------------------------------------------ §3
  console.log("## 3. Per transcript, because eight is small enough to print\n");
  console.log("| transcript | the goal | jev's rank of the answer | `overlap` | `digits` |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const t of ts) {
    const d = all.find((x) => x.transcript === t.id);
    if (!d) continue;
    const candidates = new Set(d.ranked.map((r) => r.id));
    const factIds = new Set(t.facts.map((f) => f.entryId));
    const j = jevPerTranscript.get(t.id) ?? [];
    const o = rankOfFact(keepOrderFree("overlap", t.entries as Entry[], candidates), factIds);
    const g = rankOfFact(keepOrderDigits(t.entries as Entry[], candidates), factIds);
    const spread = new Set(j);
    console.log(
      `| \`${t.id}\` | ${t.goal.slice(0, 46)}${t.goal.length > 46 ? "…" : ""} | ` +
        `**${med(j)}**${spread.size > 1 ? ` (${Math.min(...j)}–${Math.max(...j)} over draws)` : ""} | ` +
        `${med(o)} | ${med(g)} |`,
    );
  }

  const unstable = ts.filter((t) => new Set(jevPerTranscript.get(t.id) ?? []).size > 1).length;
  console.log(
    `\n**jev's rank moved between draws on ${unstable} of ${ts.length} transcripts**, which is the ` +
      "variance this measure carries and the reason the pooled table above counts draws rather than " +
      "transcripts.\n",
  );

  // ------------------------------------------------------------------ §4
  console.log("## 4. What this closes and what it does not\n");
  console.log(
    `- **§1.6 closes as "the question was wrong".** Not "jev is bad at it" and not "the label is ` +
      `missing" -- the predicate it named cannot reach the result it was meant to reproduce, and ` +
      `${facts - withDigit} of ${facts} facts show why without a request being sent.\n` +
      `- **The predicate the design needs is goal-relevance, and a judgment does it -- so does a word ` +
      `count.** jev: answer first on ${jev.top1}/${jev.n} draws, top 5 on ${jev.top5}/${jev.n}. ` +
      `\`overlap\`: ${overlap.top1}/${overlap.n} and ${overlap.top5}/${overlap.n}. ` +
      `Paired by transcript, ${jevBetter} against ${freeBetter} with ` +
      `${pairs.length - jevBetter - freeBetter} tied, **p = ` +
      `${signTest(jevBetter, freeBetter).toFixed(3)}**. **A null, not a win either way** -- and when a ` +
      "judgment and a free word count tie, the word count is the one to ship.\n" +
      "- **Which makes this docs/39's measurement seen from a different angle, not a new one.** Same " +
      "corpus, same record, same eight transcripts. docs/39's conclusion -- that a free word count takes " +
      "most of the value -- survives being asked a different question about the same data, which is the " +
      "most that a re-analysis can establish.\n" +
      "- **The end-to-end claim is still unmeasured.** Nothing here shows that feeding jev's top-ranked " +
      "entries into `custom_instructions` reproduces docs/45 §2's 9/9. That needs the arm, and the arm " +
      "needs a fact corpus bigger than nine before its result could clear the summariser's own draw " +
      "(docs/45 §2.3: three discordant pairs, p = 0.250).\n" +
      "- **8 transcripts, 9 facts, 1 corpus, written by me.** The oldest limit in the programme " +
      "(TODO §2.1) and the one this does not touch.",
  );
}

if (process.argv[1]?.endsWith("relevance.ts")) main();
