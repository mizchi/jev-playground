/**
 * What has to hold before a request is spent.
 *
 *   npm test      # no API key
 *
 * The load-bearing ones: the catalog snapshot still parses into the shape the
 * labels are derived from, the label rule is the catalog's tier legend and
 * not something softer, and nothing that decides the label -- a tier, a
 * heading path, a `Signals` line -- reaches any arm's payload. The two skill
 * names a project may write down are exempted by name, and the exemption is
 * checked in both directions so it cannot quietly grow.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { candidatePaths, frontmatterDescription, loadSnapshot, parseCatalog } from "./src/catalog.js";
import {
  DEFAULT_SKILL_CONFIG,
  selectFrom,
  type Pick,
  type Skill,
} from "../../packages/jev-skill-router/src/route.js";
import { ARMS, WIDTH, batches, keyFor, payloadOf, questionFor, singleQuestion, stateFor } from "./src/arms.js";
import { averagePrecision, precisionAtK, recallAtK, worstPositiveRank } from "./src/metrics.js";
import {
  NAME_OVERLAPS,
  PROJECTS,
  SECTION_CONSTANTS,
  SECTION_OVERLAPS,
  candidates,
  labelForRow,
  projectText,
  type Project,
} from "./src/projects.js";
import { deciderFor, fileShapedSections, routeFor } from "./src/route.js";
import { expand, ruleScores, tokens } from "./src/rules.js";

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void): void => {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}: ${(err as Error).message}`);
  }
};
const ok = (cond: boolean, what: string): void => {
  if (!cond) throw new Error(what);
};
const eq = <T,>(a: T, b: T, what = ""): void => {
  if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

const SNAPSHOT = loadSnapshot();

// --------------------------------------------------------------- the snapshot

check("the snapshot still holds the whole catalog", () => {
  ok(SNAPSHOT.rows.length >= 90, `only ${SNAPSHOT.rows.length} rows`);
  ok(SNAPSHOT.source.rev.length === 40, "the catalog rev is not a full sha");
  const tiers = new Set(SNAPSHOT.rows.map((r) => r.tier));
  for (const t of ["T0", "T1", "T2", "T3", "T4"]) ok(tiers.has(t as never), `tier ${t} has no row`);
});

check("every section constant names a real section", () => {
  const real = new Set(SNAPSHOT.rows.map((r) => r.section));
  for (const s of SECTION_CONSTANTS) ok(real.has(s), `no such section: ${s}`);
});

check("a row's install string resolves to a path under the clone root", () => {
  const p = candidatePaths("/clones", "mizchi/skills/gh-fix-ci");
  eq(p[0], "/clones/mizchi/skills/gh-fix-ci/SKILL.md");
  eq(p[1], "/clones/mizchi/skills/SKILL.md", "the repo-root fallback");
  eq(candidatePaths("/clones", "mizchi/vrt").length, 1, "a bare owner/repo has only the root");
});

check("frontmatter descriptions survive both quote styles and a block scalar", () => {
  eq(frontmatterDescription('---\nname: a\ndescription: plain text\n---\nbody'), "plain text");
  eq(frontmatterDescription('---\ndescription: "quoted text"\n---\n'), "quoted text");
  eq(frontmatterDescription("---\ndescription: 'quoted text'\n---\n"), "quoted text");
  eq(frontmatterDescription("---\ndescription: |\n  first line\n  second line\n---\n"), "first line second line");
  eq(frontmatterDescription("no frontmatter here"), "");
});

check("the catalog parser rejects a malformed tier instead of dropping the row", () => {
  const bad = "## S\n\n| T | Skill | Install | Use when |\n|---|---|---|---|\n| T9 | x | y | z |\n";
  let threw = false;
  try {
    parseCatalog(bad);
  } catch {
    threw = true;
  }
  ok(threw, "an unknown tier parsed silently");
});

check("the parser keeps a section's signals with its rows", () => {
  const md =
    "## Head\n\n### Sub\n**Signals**: `foo.toml`, bar\n\n| T | Skill | Install | Use when |\n" +
    "|---|---|---|---|\n| T1 | a | o/r/a | because |\n";
  const rows = parseCatalog(md);
  eq(rows.length, 1);
  eq(rows[0].section, "Head > Sub");
  eq(rows[0].signals, "`foo.toml`, bar");
  eq(rows[0].useWhen, "because");
});

// ------------------------------------------------------------------ the labels

check("the label rule is the catalog's tier legend", () => {
  const p: Project = { ...PROJECTS[0], signals: ["S"], asked: ["A"] };
  const row = (tier: string, section: string) =>
    ({ tier, section, skill: "x", install: "", useWhen: "", signals: "", description: "d", descriptionFrom: "" }) as never;
  eq(labelForRow(row("T0", "elsewhere"), p), "want", "T0 is wanted everywhere");
  eq(labelForRow(row("T1", "S"), p), "want", "T1 with its signals present");
  eq(labelForRow(row("T1", "elsewhere"), p), "no", "T1 without its signals");
  eq(labelForRow(row("T2", "A"), p), "want", "T2 when the ask names it");
  eq(labelForRow(row("T2", "S"), p), "no", "T2 with only the signals present");
  eq(labelForRow(row("T3", "S"), p), "mention", "T3 is never in the proposal");
  eq(labelForRow(row("T4", "S"), p), "no", "T4 is superseded");
  eq(labelForRow(row("T4", "A"), p), "no", "T4 stays out even when asked");
});

check("a skill listed twice takes its most eager label", () => {
  // ts2moonbit-migration is T1 under MoonBit and T3 under Migration.
  const dup = SNAPSHOT.rows.filter((r) => r.skill === "ts2moonbit-migration");
  eq(dup.length, 2, "the duplicate row is gone from the catalog");
  const moonbit = PROJECTS.find((p) => p.id === "moonbit-lib")!;
  const c = candidates(SNAPSHOT, moonbit).find((x) => x.skill === "ts2moonbit-migration")!;
  eq(c.label, "want", "the T1 row should win in a MoonBit project");
  eq(c.rows.length, 2, "both rows should be carried");
});

check("every project has a non-empty candidate list and the counts add up", () => {
  for (const p of PROJECTS) {
    const cs = candidates(SNAPSHOT, p);
    ok(cs.length >= 70, `${p.id} has only ${cs.length} candidates`);
    const byLabel = cs.filter((c) => c.label === "want").length + cs.filter((c) => c.label === "mention").length + cs.filter((c) => c.label === "no").length;
    eq(byLabel, cs.length, `${p.id} has a candidate with no label`);
  }
});

check("the negative control wants only the two always-on skills", () => {
  const bare = PROJECTS.find((p) => p.id === "bare-repo")!;
  const want = candidates(SNAPSHOT, bare).filter((c) => c.label === "want").map((c) => c.skill).sort();
  eq(want.join(","), "apm-usage,pkfire", `bare-repo wants ${want.join(",")}`);
});

check("no project is all-positive or all-negative", () => {
  for (const p of PROJECTS) {
    const cs = candidates(SNAPSHOT, p);
    const want = cs.filter((c) => c.label === "want").length;
    ok(want >= 2, `${p.id} wants only ${want}`);
    ok(want < cs.length / 2, `${p.id} wants ${want} of ${cs.length}, which is not a selection problem`);
  }
});

// ------------------------------------------------------------------- the input

check("no project's text names a skill, beyond the declared signal overlaps", () => {
  const names = [...new Set(SNAPSHOT.rows.map((r) => r.skill))];
  for (const p of PROJECTS) {
    const text = projectText(p).toLowerCase();
    for (const name of names) {
      if (NAME_OVERLAPS.includes(name)) continue;
      ok(!text.includes(name.toLowerCase()), `${p.id} names the skill ${name}`);
    }
  }
});

check("every declared name overlap is a signal the catalog declares, and is needed", () => {
  for (const name of NAME_OVERLAPS) {
    const rows = SNAPSHOT.rows.filter((r) => r.skill === name);
    ok(rows.length > 0, `${name} is not a skill in the catalog`);
    const declared = SNAPSHOT.rows.some((r) => r.signals.toLowerCase().includes(name.toLowerCase()));
    ok(declared, `${name} is not a signal the catalog declares`);
    const needed = PROJECTS.some((p) => projectText(p).toLowerCase().includes(name.toLowerCase()));
    ok(needed, `${name} is exempted but no project needs the exemption`);
  }
});

check("every declared section overlap is needed, and is a technology the signals name", () => {
  for (const leaf of SECTION_OVERLAPS) {
    const section = SECTION_CONSTANTS.find((s) => s.split(" > ").at(-1) === leaf);
    ok(section !== undefined, `${leaf} is not a section leaf`);
    const needed = PROJECTS.some((p) => projectText(p).includes(leaf));
    ok(needed, `${leaf} is exempted but no project needs the exemption`);
  }
});

check("no project's text carries the catalog's structure", () => {
  for (const p of PROJECTS) {
    const text = projectText(p);
    for (const s of SECTION_CONSTANTS) {
      ok(!text.includes(s), `${p.id} carries the heading path ${s}`);
      const leaf = s.split(" > ").at(-1)!;
      if (SECTION_OVERLAPS.includes(leaf)) continue;
      ok(!text.includes(leaf), `${p.id} names the section ${leaf}`);
    }
    ok(!/\bT[0-4]\b/.test(text), `${p.id} names a tier`);
    for (const signals of new Set(SNAPSHOT.rows.map((r) => r.signals))) {
      if (signals) ok(!text.includes(signals), `${p.id} quotes a Signals line verbatim`);
    }
  }
});

check("the label never travels in any arm's payload", () => {
  const p = PROJECTS[0];
  const cs = candidates(SNAPSHOT, p);
  for (const arm of ARMS) {
    for (const group of batches(arm, cs)) {
      const body = payloadOf(arm, p, group);
      // A tier, a label, a heading path or a Signals line would each hand
      // over the answer. The technology words inside a skill's description
      // are the INPUT and have to be there.
      ok(!/"T[0-4]"/.test(body), `${arm} leaks a tier`);
      ok(!/\btier\s*[:=]/i.test(body), `${arm} carries a tier field`);
      ok(!body.includes('"want"'), `${arm} leaks the label`);
      ok(!body.includes('"mention"'), `${arm} leaks the label`);
      for (const s of SECTION_CONSTANTS) ok(!body.includes(s), `${arm} leaks the heading path ${s}`);
      for (const signals of new Set(SNAPSHOT.rows.map((r) => r.signals))) {
        if (signals) ok(!body.includes(signals), `${arm} leaks a Signals line`);
      }
      break;
    }
  }
});

check("the fan-out arms ask about every candidate exactly once", () => {
  const cs = candidates(SNAPSHOT, PROJECTS[0]);
  for (const arm of ARMS) {
    const groups = batches(arm, cs);
    const seen = groups.flat().map((c) => c.skill);
    eq(new Set(seen).size, cs.length, `${arm} covers ${new Set(seen).size} of ${cs.length}`);
    for (const g of groups) ok(g.length <= (Number.isFinite(WIDTH[arm]) ? WIDTH[arm] : Infinity), `${arm} overfilled a request`);
  }
});

check("question keys are unique after the identifier squeeze", () => {
  const cs = candidates(SNAPSHOT, PROJECTS[0]);
  const keys = cs.map((c) => keyFor(c.skill));
  eq(new Set(keys).size, keys.length, "two skills collapse to the same question key");
});

check("the shapes match the question", () => {
  const cs = candidates(SNAPSHOT, PROJECTS[0]);
  eq(questionFor("fanout", cs[0]).type, "score");
  eq(questionFor("noul", cs[0]).type, "noul");
  eq(singleQuestion().needed.type, "score");
  const q = questionFor("fanout", cs[0]) as { criteria: unknown[] };
  eq(q.criteria.length, 4, "the score should have the four policy levels");
});

check("the curated arm really carries different text", () => {
  const cs = candidates(SNAPSHOT, PROJECTS[0]);
  const own = payloadOf("fanout", PROJECTS[0], cs.slice(0, 5));
  const curated = payloadOf("usewhen", PROJECTS[0], cs.slice(0, 5));
  ok(own !== curated, "usewhen sends the same bytes as fanout");
  ok(curated.includes(cs[0].rows[0].useWhen.slice(0, 20)), "usewhen does not carry the Use when prose");
});

check("only the single arm puts the skill in the state", () => {
  const cs = candidates(SNAPSHOT, PROJECTS[0]);
  for (const arm of ARMS) {
    const state = JSON.stringify(arm === "single" ? stateFor(arm, PROJECTS[0], cs[0]) : stateFor(arm, PROJECTS[0]));
    eq(state.includes(cs[0].skill), arm === "single", `${arm} state`);
  }
});

// ------------------------------------------------------------------ the metrics

check("average precision is 1 only when every positive outranks every negative", () => {
  const perfect = [
    { skill: "a", value: 3, positive: true },
    { skill: "b", value: 2, positive: true },
    { skill: "c", value: 1, positive: false },
  ];
  eq(averagePrecision(perfect), 1);
  const flipped = [
    { skill: "c", value: 3, positive: false },
    { skill: "a", value: 2, positive: true },
    { skill: "b", value: 1, positive: true },
  ];
  // 1/2 + 2/3, averaged.
  eq(Math.round(averagePrecision(flipped) * 1000) / 1000, 0.583);
});

check("a tie is resolved against the selector", () => {
  const tied = [
    { skill: "a", value: 1, positive: true },
    { skill: "b", value: 1, positive: false },
  ];
  eq(averagePrecision(tied), 0.5, "the positive must be ranked second");
  eq(precisionAtK(tied), 0, "P@1 must see the negative");
  eq(worstPositiveRank(tied), 2);
  const allTied = Array.from({ length: 10 }, (_, i) => ({ skill: `s${i}`, value: 0, positive: i < 2 }));
  eq(precisionAtK(allTied), 0, "all-zero scores must not score above chance");
});

check("recall at k counts positives, not rows", () => {
  const rows = [
    { skill: "a", value: 3, positive: true },
    { skill: "b", value: 2, positive: false },
    { skill: "c", value: 1, positive: true },
  ];
  eq(recallAtK(rows, 1), 0.5);
  eq(recallAtK(rows, 3), 1);
});

// -------------------------------------------------------------------- the rules

check("the tokeniser keeps identifiers whole and also splits them", () => {
  eq(tokens("wrangler.toml and node_modules/").join(","), "wrangler.toml,and,node,modules");
  eq(expand("wrangler.toml").join(","), "wrangler.toml,wrangler,toml");
  eq(expand("nix").join(","), "nix", "a bare token is not expanded");
});

check("the baseline scores a matching project above a mismatched one", () => {
  const cf = PROJECTS.find((p) => p.id === "ts-cf-e2e")!;
  const gleam = PROJECTS.find((p) => p.id === "gleam-api")!;
  const cs = candidates(SNAPSHOT, cf);
  const here = ruleScores(cs, cf).find((s) => s.skill === "cloudflare-deploy")!;
  const there = ruleScores(cs, gleam).find((s) => s.skill === "cloudflare-deploy")!;
  ok(here.score > there.score, `${here.score} should beat ${there.score}`);
});

// ------------------------------------------------------------------ the router

check("the route is decidable from the catalog alone", () => {
  // No project is passed in: that is the property that makes it a tool
  // rather than a fit. apm-usage is T0; gh-fix-ci is T1 in a section whose
  // signals name `.github/workflows/`; waxa-eval is T2 in a section with no
  // signals at all.
  const shaped = fileShapedSections(SNAPSHOT);
  const route = (s: string) => routeFor(SNAPSHOT, shaped, s);
  eq(route("apm-usage"), "policy");
  eq(route("gh-fix-ci"), "grep");
  eq(route("waxa-eval"), "judgment");
  eq(route("formal-methods-reconciler"), "judgment", "its signals are an activity, not a file");
  const counts = new Map<string, number>();
  for (const c of candidates(SNAPSHOT, PROJECTS[0])) {
    const r = route(c.skill);
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  ok((counts.get("grep") ?? 0) > 5, "the grep route is empty");
  ok((counts.get("judgment") ?? 0) > 5, "the judgment route is empty");
  eq(counts.get("policy"), 2, "there should be exactly two T0 rows");
});

check("the baseline is not already perfect", () => {
  // If it were, there would be nothing for a judgment to add and this
  // experiment would be measuring the corpus rather than the selector.
  let anyMiss = false;
  for (const p of PROJECTS) {
    const cs = candidates(SNAPSHOT, p);
    const scored = ruleScores(cs, p).map((s) => ({
      skill: s.skill,
      value: s.score,
      positive: cs.find((c) => c.skill === s.skill)!.label === "want",
    }));
    if (averagePrecision(scored) < 0.999) anyMiss = true;
  }
  ok(anyMiss, "the lexical baseline solves every project, so there is nothing to measure");
});

// ---------------------------------------------------- the fitted configuration

check("the router's shipped loadAt is the best cutoff at its shipped cap", () => {
  // `DEFAULT_SKILL_CONFIG.loadAt` and `maxLoad` are two numbers in a package,
  // and docs/29 §8 fitted them jointly against this record. Nothing else
  // connects the two, so this re-derives the claim from the raw rows: at the
  // shipped cap, no other cutoff in the grid gives better precision.
  const record = resolve(import.meta.dirname, "records/select.json");
  if (!existsSync(record)) return;
  const rows = (JSON.parse(readFileSync(record, "utf8")) as {
    project: string;
    arm: string;
    skill: string;
    value: number;
    confidence: number;
  }[]).filter((r) => r.arm === "fanout");
  const snapshot = loadSnapshot();
  // The catalogue's T0 tier is routed `always` and never judged, so scoring
  // judgment on it would credit a decision that was never asked for.
  const always = new Set(snapshot.rows.filter((r) => r.tier === "T0" && r.description).map((r) => r.skill));
  const label = new Map<string, string>();
  for (const project of PROJECTS) {
    for (const c of candidates(snapshot, project)) label.set(`${project.id}:${c.skill}`, c.label);
  }
  const judged = rows.filter((r) => label.has(`${r.project}:${r.skill}`) && !always.has(r.skill));
  const projects = [...new Set(judged.map((r) => r.project))];

  const through = (loadAt: number, maxLoad: number): { precision: number; recall: number } => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const project of projects) {
      const picks: Pick[] = judged
        .filter((r) => r.project === project)
        .map((r) => ({
          skill: { name: r.skill, description: "", route: "judge", invocable: true } as Skill,
          level: r.value,
          confidence: r.confidence,
          why: "judged" as const,
        }));
      const names = new Set(
        selectFrom(picks, Number.NaN, { ...DEFAULT_SKILL_CONFIG, loadAt, maxLoad }).load.map((x) => x.skill.name),
      );
      for (const pick of picks) {
        const positive = label.get(`${project}:${pick.skill.name}`) === "want";
        if (names.has(pick.skill.name) && positive) tp += 1;
        else if (names.has(pick.skill.name)) fp += 1;
        else if (positive) fn += 1;
      }
    }
    return { precision: tp / (tp + fp), recall: tp / (tp + fn) };
  };

  const shipped = through(DEFAULT_SKILL_CONFIG.loadAt, DEFAULT_SKILL_CONFIG.maxLoad);
  for (const other of [1.5, 2.0, 2.8]) {
    const got = through(other, DEFAULT_SKILL_CONFIG.maxLoad);
    ok(
      got.precision <= shipped.precision + 1e-9,
      `loadAt ${other} beats the shipped ${DEFAULT_SKILL_CONFIG.loadAt} on precision ` +
        `(${got.precision.toFixed(3)} vs ${shipped.precision.toFixed(3)})`,
    );
  }
  ok(shipped.precision > 0.8, `the shipped config's precision fell to ${shipped.precision.toFixed(3)}`);

  // And the trap: a lower cutoff buys NO recall at this cap, because the cap
  // is what decides how many get in. If this ever stops holding, the joint
  // fit needs redoing rather than the comment adjusting.
  const lower = through(1.5, DEFAULT_SKILL_CONFIG.maxLoad);
  eq(
    lower.recall.toFixed(3),
    shipped.recall.toFixed(3),
    "a lower cutoff now changes recall, so the cap is no longer binding: ",
  );
});

check("exactly one project is a genuine escape-hatch case", () => {
  // docs/29 §8: `bare-repo` wants nothing among the JUDGED skills -- its two
  // wanted skills are both T0, which the catalogue routes `always`. One
  // positive is why `noneAt` is unfitted, and this asserts the one rather
  // than letting it drift silently to zero or three.
  const snapshot = loadSnapshot();
  const always = new Set(snapshot.rows.filter((r) => r.tier === "T0" && r.description).map((r) => r.skill));
  const hatch = PROJECTS.filter((p) =>
    candidates(snapshot, p).every((c) => c.label !== "want" || always.has(c.skill)),
  );
  eq(hatch.length, 1, "the number of no-skill-applies projects changed: ");
  eq(hatch[0].id, "bare-repo");
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
