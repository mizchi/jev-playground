/**
 * Fit the skill router's `loadAt` and `noneAt` on the 1,036 pairs. No API key.
 *
 *   npx tsx src/fit.ts
 *
 * docs/37 §9's homework, and the one item on that list with enough labels to
 * fit from both sides: 107 judged positives in 1,008, against the 1 in 53 that
 * made docs/36 §5's cost ladder meaningless.
 *
 * TWO THINGS THIS DOES DIFFERENTLY FROM docs/31 §8's fit, and both are forced
 * by what the skill router actually does:
 *
 *   IT SCORES THE PIPELINE, NOT THE CUTOFF. `selectFrom` applies `loadAt` and
 *   THEN a cap (`maxLoad`, default 3). A cutoff fitted on its own is fitted
 *   against a decision nobody makes -- docs/30 §5 measured P@12 falling from
 *   0.25 to 0.19 as the cap grew over the same answers, so the two interact
 *   and the grid is the object. §4 runs the shipped `selectFrom` over it.
 *
 *   IT FOLDS OVER PROJECTS, NOT PAIRS. A project's 72 judged rows share one
 *   context and one request. Cutting folds along pairs would put a project's
 *   own rows on both sides of the split, which is the leak docs/25 §2 is about
 *   -- and with 14 projects that leak would be most of the data.
 *
 * It also excludes the catalogue's T0 tier, and finding that out was the most
 * useful thing here: see `alwaysTier` and §4. The router loads those without
 * judging them, so 28 of the 135 positives were credited to a decision that
 * was never asked for.
 *
 * `noneAt` cannot be fitted from this record and §4 says why in two ways, one
 * of which is not the one this file first claimed.
 *
 * Everything comes from `records/select.json`, which already exists. Zero
 * requests (docs/19 §4).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  advise,
  confusion,
  crossValidate,
  groupFolds,
  place,
  type Confusion,
  type Placement,
  type Sample,
} from "../../shared/thresholds.js";
import { loadSnapshot } from "./catalog.js";
import { PROJECTS, candidates } from "./projects.js";
import {
  DEFAULT_SKILL_CONFIG,
  selectFrom,
  type Pick,
  type Skill,
} from "../../../packages/jev-skill-router/src/route.js";

interface Row {
  project: string;
  arm: string;
  skill: string;
  value: number;
  confidence: number;
}

const RECORD = resolve(import.meta.dirname, "../records/select.json");

/** The arm the package ships: one `score` per skill, all in one request. */
const ARM = "fanout";

const pad = (s: string, n: number): string => s.padEnd(n);
const num = (x: number, d = 3): string => (Number.isFinite(x) ? x.toFixed(d) : "  -  ");

/**
 * The catalogue's own `always` tier: T0, which the label rule makes `want`
 * for every project.
 *
 * These are excluded from everything below, because THE ROUTER NEVER JUDGES
 * THEM. `split()` sorts the catalogue into always / never / judge before any
 * request is made (docs/29 §5, free), and a T0 row lands in `always` and is
 * loaded outright. Scoring judgment on rows it never sees inflates the
 * positive count by 14 x 2 = 28 and depresses the recall of a decision that
 * was never asked for.
 *
 * Found by this fit contradicting its own footer: §4 first reported zero
 * projects needing the escape hatch, and `bare-repo` -- max score 0.77,
 * nothing clearing the cutoff -- turned out to want exactly two skills, both
 * of them T0.
 */
function alwaysTier(): Set<string> {
  return new Set(
    loadSnapshot()
      .rows.filter((r) => r.tier === "T0" && r.description)
      .map((r) => r.skill),
  );
}

/**
 * The label. `want` is the positive class and `mention` is NOT.
 *
 * That is the shipped rubric's own distinction: level 2 is "fits an activity
 * this context could want, but the request does not ask for that activity"
 * and level 3 is "needs it now". `mention` is level 2's label, and a skill
 * worth naming in passing is not one worth spending context on in every
 * following turn -- which is exactly why `loadAt` ships at 2.5, between them.
 */
function labels(): Map<string, "want" | "mention" | "no"> {
  const snapshot = loadSnapshot();
  const out = new Map<string, "want" | "mention" | "no">();
  for (const project of PROJECTS) {
    for (const c of candidates(snapshot, project)) out.set(`${project.id}:${c.skill}`, c.label);
  }
  return out;
}

function main(): void {
  if (!existsSync(RECORD)) {
    console.log("no records/select.json; run the skill-select experiment first");
    return;
  }
  const all = (JSON.parse(readFileSync(RECORD, "utf8")) as Row[]).filter((r) => r.arm === ARM);
  const label = labels();
  const always = alwaysTier();
  const judged = all.filter((r) => label.has(`${r.project}:${r.skill}`) && !always.has(r.skill));
  const rows = judged;
  const skipped = all.filter((r) => always.has(r.skill));
  const samples: Sample[] = rows.map((r) => ({
    value: r.value,
    positive: label.get(`${r.project}:${r.skill}`) === "want",
    // The PROJECT, so folds never split one context's own rows.
    group: r.project,
  }));
  const positives = samples.filter((s) => s.positive).length;
  console.log(
    `\n  ${rows.length} pairs from the \`${ARM}\` arm: ${new Set(rows.map((r) => r.project)).size} projects x ` +
      `${new Set(rows.map((r) => r.skill)).size} skills  ·  ${positives} want ` +
      `(${((100 * positives) / rows.length).toFixed(0)}%), ` +
      `${[...label.values()].filter((v) => v === "mention").length} mention  ·  no requests made`,
  );
  console.log(
    `  ${skipped.length} pairs excluded: the ${always.size} T0 skills (${[...always].join(", ")}), which the` +
      `\n  catalogue routes as \`always\` -- the router loads them without judging them, so scoring` +
      `\n  judgment on them would credit it with ${skipped.filter((r) => label.get(`${r.project}:${r.skill}`) === "want").length} positives it was never asked about.`,
  );

  const mentions = rows
    .filter((r) => label.get(`${r.project}:${r.skill}`) === "mention")
    .map((r) => r.value);
  reportSeparation(samples, mentions);
  reportLoadAt(samples);
  reportGrid(rows, label);
  reportNoneAt(rows, label);
  reportComponentTrap(rows, label, samples);
  console.log("");
}

function reportSeparation(samples: Sample[], mentions: number[]): void {
  console.log(`\n§1 does the score separate 'want' from the rest?\n`);
  const a = advise(samples, { range: 3 });
  console.log(`  verdict    ${a.verdict}`);
  console.log(`  AUC        ${num(a.separation.auc)}`);
  console.log(`  gap        ${num(a.separation.gap)}  (highest negative ${num(a.separation.maxNeg, 2)}, lowest positive ${num(a.separation.minPos, 2)})`);
  console.log(`  why        ${a.reason}`);
  // The distribution, because an AUC over 890 negatives and 135 positives can
  // look healthy while the positives sit in a band the negatives also fill.
  console.log("\n  score band   want   mention    no");
  for (const [lo, hi] of [[0, 0.5], [0.5, 1.5], [1.5, 2.5], [2.5, 3.01]] as const) {
    const inBand = samples.filter((s) => s.value >= lo && s.value < hi);
    const w = inBand.filter((s) => s.positive).length;
    const m = mentions.filter((v) => v >= lo && v < hi).length;
    console.log(
      `  ${`${lo.toFixed(1)}-${hi === 3.01 ? "3.0" : hi.toFixed(1)}`.padEnd(12)} ${String(w).padStart(4)}   ` +
        `${String(m).padStart(7)}   ${String(inBand.length - w - m).padStart(3)}`,
    );
  }
  console.log(
    "\n  The band table is the ceiling on recall, and no cutoff moves it: the wanted\n" +
      "  skills sitting under 0.5 are ones the question did not find, not ones a\n" +
      "  threshold excluded.",
  );
}

function reportLoadAt(samples: Sample[]): void {
  const placements: Placement[] = [
    { rule: "fixed", at: DEFAULT_SKILL_CONFIG.loadAt },
    { rule: "fixed", at: 1.5 },
    { rule: "youden" },
    { rule: "quantile", q: 0.9, margin: 0.01 },
    { rule: "auto" },
  ];
  console.log(`\n§2 \`loadAt\` on its own -- folds cut along projects\n`);
  console.log("  placement        cutoff   in-sample bal.   held-out bal.   held-out tp/fp/fn/tn   precision   fold cutoffs");
  for (const placement of placements) {
    const fit = place(samples, placement);
    const cv = crossValidate(samples, placement, { folds: 5 });
    if (!fit.fittable && cv.cutoffs.length === 0) {
      console.log(`  ${pad(`${placement.rule}`, 16)} -        ${fit.why}`);
      continue;
    }
    const h = cv.heldOut;
    console.log(
      `  ${pad(cv.placement, 16)} ${num(fit.at, 2).padStart(6)}   ${num(cv.inSample.balanced).padStart(14)}   ` +
        `${num(h.balanced).padStart(13)}   ${`${h.tp}/${h.fp}/${h.fn}/${h.tn}`.padStart(20)}   ` +
        `${num(h.precision).padStart(9)}   ${cv.cutoffs.map((c) => c.toFixed(2)).join(" ")}`,
    );
  }
  console.log(
    "\n  This table is about a decision nobody makes: the router applies a CAP after\n" +
      "  the cutoff, so a cutoff that fires on 40 skills and one that fires on 4 can\n" +
      "  produce the same three loads. §3 is the one to read.",
  );
}

/** Build the `Pick[]` the shipped policy takes, for one project. */
function picksFor(rows: Row[], project: string): Pick[] {
  return rows
    .filter((r) => r.project === project)
    .map((r) => ({
      skill: { name: r.skill, description: "", route: "judge", invocable: true } as Skill,
      level: r.value,
      confidence: r.confidence,
      why: "judged" as const,
    }));
}

function reportGrid(rows: Row[], label: Map<string, "want" | "mention" | "no">): void {
  // The real object: the shipped `selectFrom` over a (cutoff, cap) grid, held
  // out over projects. Scored as precision and recall OF WHAT GETS LOADED,
  // which is what a context window actually pays for.
  console.log(`\n§3 the shipped pipeline over a (loadAt, maxLoad) grid, held out over projects\n`);
  const projects = [...new Set(rows.map((r) => r.project))];
  const folds = groupFolds(
    rows.map((r) => ({ value: 0, positive: false, group: r.project })),
    5,
  );

  const score = (loadAt: number, maxLoad: number, on: string[]): Confusion => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const project of on) {
      const picks = picksFor(rows, project);
      const loaded = selectFrom(picks, Number.NaN, { ...DEFAULT_SKILL_CONFIG, loadAt, maxLoad }).load;
      const names = new Set(loaded.map((p) => p.skill.name));
      for (const pick of picks) {
        const positive = label.get(`${project}:${pick.skill.name}`) === "want";
        if (names.has(pick.skill.name) && positive) tp += 1;
        else if (names.has(pick.skill.name)) fp += 1;
        else if (positive) fn += 1;
      }
    }
    const n = on.length;
    return {
      tp,
      fp,
      fn,
      tn: 0,
      n,
      recall: tp + fn === 0 ? Number.NaN : tp / (tp + fn),
      specificity: Number.NaN,
      precision: tp + fp === 0 ? Number.NaN : tp / (tp + fp),
      balanced: Number.NaN,
    };
  };

  console.log("  loadAt   cap   loaded/project   precision   recall   wanted-and-missed/project");
  for (const loadAt of [1.5, 2.0, 2.5, 2.8]) {
    for (const maxLoad of [1, 3, 5, 10]) {
      // Held out: score each fold with the grid point, then pool. The grid
      // point is fixed rather than fitted per fold, so this is the honest
      // reading of "what would this configuration have done".
      let tp = 0;
      let fp = 0;
      let fn = 0;
      for (const held of folds) {
        const c = score(loadAt, maxLoad, held);
        tp += c.tp;
        fp += c.fp;
        fn += c.fn;
      }
      console.log(
        `  ${num(loadAt, 1).padStart(6)}   ${String(maxLoad).padStart(3)}   ` +
          `${num((tp + fp) / projects.length, 2).padStart(14)}   ` +
          `${num(tp + fp === 0 ? Number.NaN : tp / (tp + fp)).padStart(9)}   ` +
          `${num(tp / (tp + fn)).padStart(6)}   ${num(fn / projects.length, 2).padStart(25)}`,
      );
    }
  }
  console.log(
    "\n  `loaded/project` is the bill: every loaded skill spends context in every\n" +
      "  following turn. docs/30 §5's finding shows up here as the precision column\n" +
      "  falling while the cap rises over the SAME answers.",
  );
}

function reportNoneAt(rows: Row[], label: Map<string, "want" | "mention" | "no">): void {
  console.log(`\n§4 \`noneAt\` -- one case in fourteen, and the free substitute finds it\n`);
  const projects = [...new Set(rows.map((r) => r.project))];
  // Computed over the JUDGED rows, which is the set the hatch is asked about.
  // The first version of this section counted every row and reported zero such
  // projects; `bare-repo` then turned out to want exactly two skills, both of
  // them T0, i.e. both in the bucket the router loads without judging. The
  // hatch's question is "is this a request none of THESE is for", and the
  // catalogue's always-tier is not among them.
  const hatch = projects.filter((p) =>
    rows.filter((r) => r.project === p).every((r) => label.get(`${p}:${r.skill}`) !== "want"),
  );
  console.log(`  projects whose correct \`none_apply\` answer is TRUE: ${hatch.length} of ${projects.length}` +
    (hatch.length > 0 ? `  (${hatch.join(", ")})` : ""));

  console.log("\n  project                max score   cleared 2.5   judged-wanted   hatch should fire");
  for (const project of projects) {
    const mine = rows.filter((r) => r.project === project);
    const max = Math.max(...mine.map((r) => r.value));
    const over = mine.filter((r) => r.value >= DEFAULT_SKILL_CONFIG.loadAt).length;
    const wanted = mine.filter((r) => label.get(`${project}:${r.skill}`) === "want").length;
    console.log(
      `  ${pad(project, 22)} ${num(max, 2).padStart(9)}   ${String(over).padStart(11)}   ${String(wanted).padStart(13)}   ` +
        (wanted === 0 ? "YES" : ""),
    );
  }

  // The question the hatch has to answer to be worth a question: does it say
  // anything the per-skill scores do not already say? docs/33 §1 -- price the
  // free version first.
  const freeFires = projects.filter((p) =>
    rows.filter((r) => r.project === p).every((r) => r.value < DEFAULT_SKILL_CONFIG.loadAt),
  );
  console.log(
    `\n  the free substitute ("no skill cleared ${DEFAULT_SKILL_CONFIG.loadAt}") fires on: ` +
      `${freeFires.join(", ") || "nothing"}`,
  );
  const agree = hatch.length === freeFires.length && hatch.every((p) => freeFires.includes(p));
  console.log(
    `  ${agree ? "It agrees with the label on every project." : "It DISAGREES with the label somewhere."}\n`,
  );
  console.log(
    "  >> So on this corpus the escape hatch buys nothing: reading the scores gives\n" +
      "     the same answer at no extra question, which is docs/33 §1's result in a\n" +
      "     third place. `noneAt` keeps its timid 0.8 default and the README says it\n" +
      "     is unfitted -- one positive cannot place a cutoff, and this record does\n" +
      "     not carry the hatch's own answer anyway (docs/29's arms never asked it).\n" +
      "     What would settle it is a corpus with several contexts no skill is for;\n" +
      "     docs/29 has exactly one, by accident.",
  );
}

/**
 * What fitting the cutoff on its own would have cost.
 *
 * §2 and §3 disagree, and the disagreement is the most transferable thing
 * here, so it is computed rather than left for a reader to notice.
 */
function reportComponentTrap(
  rows: Row[],
  label: Map<string, "want" | "mention" | "no">,
  samples: Sample[],
): void {
  console.log(`\n§5 what fitting \`loadAt\` on its own would have cost\n`);
  const projects = [...new Set(rows.map((r) => r.project))];
  const through = (loadAt: number): { loaded: number; precision: number; recall: number } => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const project of projects) {
      const picks: Pick[] = rows
        .filter((r) => r.project === project)
        .map((r) => ({
          skill: { name: r.skill, description: "", route: "judge", invocable: true } as Skill,
          level: r.value,
          confidence: r.confidence,
          why: "judged" as const,
        }));
      const names = new Set(
        selectFrom(picks, Number.NaN, { ...DEFAULT_SKILL_CONFIG, loadAt }).load.map((p) => p.skill.name),
      );
      for (const pick of picks) {
        const positive = label.get(`${project}:${pick.skill.name}`) === "want";
        if (names.has(pick.skill.name) && positive) tp += 1;
        else if (names.has(pick.skill.name)) fp += 1;
        else if (positive) fn += 1;
      }
    }
    return { loaded: (tp + fp) / projects.length, precision: tp / (tp + fp), recall: tp / (tp + fn) };
  };

  const shipped = DEFAULT_SKILL_CONFIG.loadAt;
  const fitted = place(samples, { rule: "youden" }).at;
  console.log("  cutoff            source                        loaded/project   precision   recall");
  for (const [at, why] of [
    [shipped, "shipped (between levels 2 and 3)"],
    [fitted, "youden, fitted on the cutoff alone"],
  ] as const) {
    const r = through(at);
    console.log(
      `  ${num(at, 2).padStart(6)}            ${pad(why, 29)} ${num(r.loaded, 2).padStart(14)}   ` +
        `${num(r.precision).padStart(9)}   ${num(r.recall).padStart(6)}`,
    );
  }
  const a = through(shipped);
  const b = through(fitted);
  console.log(
    `\n  >> Fitting the cutoff alone moves it ${shipped.toFixed(2)} -> ${fitted.toFixed(2)} and is STRICTLY WORSE\n` +
      `     through the pipeline: recall ${num(a.recall, 3)} -> ${num(b.recall, 3)} and precision\n` +
      `     ${num(a.precision, 3)} -> ${num(b.precision, 3)}. The cap is already binding at ${DEFAULT_SKILL_CONFIG.maxLoad}, so a lower\n` +
      `     cutoff cannot admit more WANTED skills -- only more unwanted ones into the\n` +
      `     same ${DEFAULT_SKILL_CONFIG.maxLoad} places. The ranking decides which get in; the cutoff only decides\n` +
      "     how much junk is eligible.\n\n" +
      "     So the component's balanced accuracy pointed the wrong way, and it would\n" +
      "     have been believed: §2's held-out column is a real number, cross-validated\n" +
      "     over projects, and it says 1.39 beats 2.50. Fit what the code does.",
  );
}

if (process.argv[1]?.endsWith("fit.ts")) main();
