/**
 * What has to hold before a request is spent.
 *
 *   npm test      # no API key
 *
 * The load-bearing ones: the roster still joins to docs/29's labels (a
 * catalog row that finds no entry would silently become a distractor), the
 * prefilter's tie-break still runs against itself, the terse form really is
 * the same question with the policy text moved rather than a different
 * question, and nothing about a label reaches a payload.
 */
import { PROJECTS, candidatesFor, loadCorpus } from "./src/corpus.js";
import { readProject, surveyFiles } from "./src/project.js";
import { collect, frontmatterName, tokensOf } from "./src/roster.js";
import {
  LEVELS,
  PREFILTERS,
  TERSE_LEVELS,
  chunk,
  keepTop,
  keyFor,
  prescore,
  questionsFor,
  stateFor,
} from "./src/stages.js";

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

const CORPUS = loadCorpus();
const CANDS = candidatesFor(CORPUS, PROJECTS[0]);

// --------------------------------------------------------------- the roster

check("the roster is large enough to be the point", () => {
  ok(CORPUS.roster.entries.length >= 400, `only ${CORPUS.roster.entries.length} entries`);
  ok(Object.keys(CORPUS.roster.revs).length >= 6, "fewer than six sources");
  for (const [repo, rev] of Object.entries(CORPUS.roster.revs)) {
    eq(rev.length, 40, `${repo} has no full sha`);
  }
});

check("every entry has a name and a description", () => {
  for (const e of CORPUS.roster.entries) {
    ok(e.name.length > 0, "an entry has no name");
    ok(e.description.length > 0, `${e.name} has no description`);
    ok(e.source.includes("/"), `${e.name} has no owner/repo source`);
  }
  const names = CORPUS.roster.entries.map((e) => e.name);
  eq(new Set(names).size, names.length, "the roster has duplicate names");
});

check("question keys stay unique after the identifier squeeze", () => {
  const keys = CORPUS.roster.entries.map((e) => keyFor(e.name));
  eq(new Set(keys).size, keys.length, "two entries collapse to the same question key");
});

check("the roster does not fit in one full-form request", () => {
  // The measured ceiling is 260 questions in the full form (§1). The test
  // asserts the premise, not the API: a roster that shrank below the
  // ceiling would make the whole experiment about nothing.
  ok(CORPUS.roster.entries.length > 260, `${CORPUS.roster.entries.length} entries would fit`);
  ok(tokensOf(CORPUS.roster.entries) > 32768, "the descriptions would fit in a state");
});

check("the frontmatter name falls back to the directory", () => {
  eq(frontmatterName("---\nname: given\n---\n", "dir"), "given");
  eq(frontmatterName('---\nname: "quoted"\n---\n', "dir"), "quoted");
  eq(frontmatterName("---\ndescription: x\n---\n", "dir"), "dir");
  eq(frontmatterName("no frontmatter", "dir"), "dir");
});

check("collecting from an empty directory yields an empty roster", () => {
  const empty = collect("/nonexistent-clone-root", () => "");
  eq(empty.entries.length, 0);
  eq(Object.keys(empty.revs).length, 0);
});

// ---------------------------------------------------------------- the join

check("every catalogued row finds its roster entry", () => {
  eq(CORPUS.unmatched.length, 0, `unmatched: ${CORPUS.unmatched.join(", ")}`);
  const catalogued = CANDS.filter((c) => c.catalogued !== null);
  ok(catalogued.length >= 70, `only ${catalogued.length} catalogued entries`);
});

check("the alias fallback is what matches the renamed row", () => {
  // The catalog calls it `workers-cd-rollback`; its SKILL.md says
  // `cloudflare-workers-cd-rollback`. A plain name join drops it.
  const entry = CANDS.find((c) => c.catalogued === "workers-cd-rollback");
  ok(entry !== undefined, "the renamed row did not join");
  eq(entry!.name, "cloudflare-workers-cd-rollback");
});

check("the labels are docs/29's, unchanged", () => {
  const bare = PROJECTS.find((p) => p.id === "bare-repo")!;
  const want = candidatesFor(CORPUS, bare).filter((c) => c.label === "want").map((c) => c.name).sort();
  eq(want.join(","), "apm-usage,pkfire", `bare-repo wants ${want.join(",")}`);
  for (const p of PROJECTS) {
    const cs = candidatesFor(CORPUS, p);
    eq(cs.length, CORPUS.roster.entries.length, `${p.id} lost candidates`);
    ok(cs.filter((c) => c.label === "want").length >= 2, `${p.id} wants fewer than two`);
  }
});

check("a distractor is never labelled want", () => {
  for (const p of PROJECTS) {
    for (const c of candidatesFor(CORPUS, p)) {
      if (c.catalogued === null) eq(c.label, "no", `${c.name} in ${p.id}`);
    }
  }
});

// ------------------------------------------------------------- the prefilter

check("every prefilter scores every candidate", () => {
  for (const filter of PREFILTERS) {
    const scores = prescore(filter, CANDS, PROJECTS[0]);
    eq(scores.length, CANDS.length, filter);
    eq(new Set(scores.map((s) => s.name)).size, CANDS.length, `${filter} has duplicate names`);
  }
});

check("the tie-break runs against the prefilter", () => {
  // A filter that gives everything the same score must not score on its
  // sort order: the positives have to land last inside the tie.
  const flat = CANDS.map((c) => ({ name: c.name, score: 0, hits: [] }));
  const kept = keepTop(flat, CANDS, 12);
  eq(kept.filter((c) => c.label === "want").length, 0, "a positive survived a flat prefilter");
});

check("the random control is seeded, and different seeds differ", () => {
  const a = prescore("random", CANDS, PROJECTS[0], 1);
  const b = prescore("random", CANDS, PROJECTS[0], 1);
  const c = prescore("random", CANDS, PROJECTS[0], 2);
  eq(JSON.stringify(a), JSON.stringify(b), "the same seed gave a different order");
  ok(JSON.stringify(a) !== JSON.stringify(c), "two seeds gave the same order");
});

check("overlap beats random on the project it is scored against", () => {
  const recall = (filter: "overlap" | "random") => {
    const kept = new Set(keepTop(prescore(filter, CANDS, PROJECTS[0]), CANDS, 60).map((c) => c.name));
    const want = CANDS.filter((c) => c.label === "want");
    return want.filter((c) => kept.has(c.name)).length / want.length;
  };
  ok(recall("overlap") > recall("random") + 0.2, `${recall("overlap")} vs ${recall("random")}`);
});

check("chunking covers everything exactly once", () => {
  for (const per of [1, 10, 200, 1000]) {
    const groups = chunk(CANDS, per);
    eq(groups.flat().length, CANDS.length, `per=${per}`);
    for (const g of groups) ok(g.length <= per, `per=${per} overfilled a request`);
  }
});

// ----------------------------------------------------------------- the ask

check("the terse form moves the policy text, it does not change the question", () => {
  const group = CANDS.slice(0, 3);
  const fullQ = questionsFor(group, false);
  const terseQ = questionsFor(group, true);
  eq(Object.keys(fullQ).join(","), Object.keys(terseQ).join(","), "different question keys");
  for (const key of Object.keys(fullQ)) {
    const a = fullQ[key] as { criteria: string[]; instructions: Record<string, string> };
    const b = terseQ[key] as { criteria: string[]; instructions: Record<string, string> };
    eq(a.criteria.length, b.criteria.length, "different number of levels");
    eq(a.instructions.skill, b.instructions.skill, "different skill");
    eq(a.instructions.skill_description, b.instructions.skill_description, "different description");
    ok(b.instructions.task === undefined, "the terse question still carries the task sentence");
  }
  const terseState = JSON.stringify(stateFor(PROJECTS[0], true));
  ok(terseState.includes(LEVELS[3]), "the terse state does not carry the level meanings");
  ok(!JSON.stringify(stateFor(PROJECTS[0], false)).includes(LEVELS[3]), "the full state carries them twice");
  ok(TERSE_LEVELS.every((l) => l.length < 25), "the terse levels are not terse");
});

check("the terse form is really smaller", () => {
  const group = CANDS.slice(0, 50);
  const big = JSON.stringify([stateFor(PROJECTS[0], false), questionsFor(group, false)]).length;
  const small = JSON.stringify([stateFor(PROJECTS[0], true), questionsFor(group, true)]).length;
  ok(small < big * 0.7, `${small} is not much smaller than ${big}`);
});

check("no label, tier or catalog structure reaches a payload", () => {
  for (const terse of [false, true]) {
    for (const group of chunk(CANDS, 200)) {
      const body = JSON.stringify([stateFor(PROJECTS[0], terse), questionsFor(group, terse)]);
      ok(!/"T[0-4]"/.test(body), "a tier leaked");
      ok(!body.includes('"want"'), "a label leaked");
      ok(!body.includes('"catalogued"'), "the catalog flag leaked");
      ok(!body.includes('"distractor"'), "the distractor flag leaked");
      for (const signals of new Set(CORPUS.snapshot.rows.map((r) => r.signals))) {
        if (signals) ok(!body.includes(signals), "a Signals line leaked");
      }
      break;
    }
  }
});

// --------------------------------------------------------- the real directory

check("surveying a real directory finds its manifests and stops", () => {
  // This experiment's own directory: it has a manifest, a src/ tree and a
  // node_modules/ that must not be walked.
  const here = new URL(".", import.meta.url).pathname;
  const files = surveyFiles(here, { maxFiles: 60 });
  ok(files.length <= 60, `${files.length} paths`);
  ok(files.includes("package.json"), `no package.json in ${files.slice(0, 8).join(" ")}`);
  ok(files.includes("src/"), "the src directory was not listed");
  ok(!files.some((f) => f.includes("node_modules")), "node_modules was surveyed");
  ok(surveyFiles(here, { maxFiles: 5 }).length <= 5, "maxFiles was ignored");
});

check("a real project carries no labels", () => {
  const p = readProject(new URL(".", import.meta.url).pathname, "do a thing");
  eq(p.signals.length, 0, "a real directory cannot declare sections");
  eq(p.asked.length, 0);
  eq(p.intent, "do a thing");
  ok(p.files.length > 0, "nothing was surveyed");
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
