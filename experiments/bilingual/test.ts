/**
 * What has to hold before a request is spent.
 *
 *   npm test      # no API key
 *
 * The load-bearing ones: the two documents still align section for section
 * (the whole corpus is built on that), every mutation actually changes the
 * text it claims to change (a no-op mutation would silently become a second
 * "equivalent" subject), and the label never travels in the state.
 */
import { checkPair, identifiersIn, loadCorpus, numbersIn, sections, significantNumbers } from "./src/align.js";
import { ARMS, questions, stateFor } from "./src/arms.js";
import { MUTATIONS, buildSubjects, sentencesOf } from "./src/mutate.js";

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
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what}${what ? ": " : ""}${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
};

const corpus = loadCorpus();
const { subjects, unplanted } = buildSubjects(corpus.pairs);

check("the two documents still align section for section", () => {
  ok(corpus.pairs.length >= 20, `only ${corpus.pairs.length} sections`);
  for (const p of corpus.pairs) eq(p.level, p.level, `§${p.index} heading level`);
  // Heading levels must agree pairwise, or the alignment is an accident.
  const en = sections(corpus.enWhole);
  const ja = sections(corpus.jaWhole);
  for (let i = 0; i < en.length; i += 1) eq(en[i].level, ja[i].level, `§${i} level`);
});

check("the splitter does not read headings inside code fences", () => {
  const md = "# Real\n\ntext\n\n```bash\n# 1. Not a heading\n```\n\n## Also real\n";
  eq(
    sections(md).map((s) => s.title),
    ["Real", "Also real"],
  );
});

check("every mutation plants somewhere and changes the text", () => {
  eq(unplanted, [], "unplanted mutations");
  for (const m of MUTATIONS) {
    const planted = subjects.find((s) => s.mutation === m.id);
    ok(planted !== undefined, `${m.id} did not plant`);
    const original = corpus.pairs[planted!.pairIndex].ja;
    ok(planted!.ja !== original, `${m.id} produced identical text`);
  }
});

check("the two harmless mutations keep every number and identifier", () => {
  for (const id of ["paraphrase", "reflowed"]) {
    const s = subjects.find((x) => x.mutation === id)!;
    const before = corpus.pairs[s.pairIndex].ja;
    eq(numbersIn(s.ja), numbersIn(before), `${id} moved a number`);
    eq(identifiersIn(s.ja).sort(), identifiersIn(before).sort(), `${id} moved an identifier`);
  }
});

check("the significant-number filter keeps measurements and drops prose counts", () => {
  eq(significantNumbers("one request per file", { spelled: true }), []);
  eq(significantNumbers("88.4% at 31 ms over 256 nodes"), ["88.4%", "31ms", "256"]);
});

check("spelled-out English numbers normalise to digits", () => {
  eq(numbersIn("one request", { spelled: true }), ["1"]);
  eq(numbersIn("one request"), []);
});

check("the deterministic check is quiet on every untouched pair in the corpus", () => {
  const ratios = corpus.pairs.map((p) => p.ja.length / Math.max(1, p.en.length)).sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  const band = { lo: median * 0.8, hi: median * 1.25 };
  // The corpus is the sections over 400 characters; the rules DO flag one
  // shorter section (§3 Install, 378 characters), which docs/28 §1 reports
  // rather than tunes away.
  const inCorpus = new Set(subjects.filter((s) => s.mutation === "original").map((s) => s.pairIndex));
  const flagged = corpus.pairs.filter((p) => inCorpus.has(p.index) && checkPair(p, band).diverged).map((p) => p.index);
  eq(flagged, [], "sections the rules flag");
});

check("sentences split on the Japanese full stop", () => {
  eq(sentencesOf("これは一文です。これは二文目です。"), ["これは一文です。", "これは二文目です。"]);
});

check("no arm's state carries the label", () => {
  // Only the label vocabulary: a mutation id like `addition` is also an
  // ordinary English word that the README itself uses, so banning the ids
  // would fail on the document rather than on a leak.
  const banned = ["diverged", "equivalent", "planted", "number_changed", "negation_flipped", "claim_strength"];
  for (const s of subjects) {
    for (const arm of ARMS) {
      const sent = JSON.stringify(stateFor(arm, s, { en: corpus.enWhole, ja: corpus.jaWhole }));
      for (const word of banned) ok(!sent.includes(word), `${arm}/${s.id} leaked ${word}`);
    }
  }
});

check("the shapes match the question", () => {
  const qs = questions();
  eq(qs.divergence.type, "score", "the ordered answer");
  eq((qs.divergence as { criteria: unknown[] }).criteria.length, 4, "four rungs");
  eq(qs.kind.type, "choice", "the class");
  eq(qs.no_divergence.type, "noul", "the escape hatch is its own question");
  for (const [name, q] of Object.entries(qs)) {
    if (q.type !== "noul") continue;
    const raw = q as unknown as Record<string, unknown>;
    ok(raw.criteria !== undefined && raw.true === undefined, `${name}: docs/00's nested criteria`);
  }
});

console.log("");
console.log(`  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
