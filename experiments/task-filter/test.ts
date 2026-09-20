/**
 * Everything that must hold before a single request is spent.
 *
 *   npm test        # no API key, no `just` on PATH
 *
 * Two of these are load-bearing for the report rather than for the code. The
 * corpus is checked for a defect no recipe can catch, which would make every
 * strategy look equally good, and the static baseline is checked to be sound
 * on all twenty branches -- if the globs missed a defect the write-up would be
 * comparing Jev against a broken baseline instead of a real one.
 */
import { globToRegExp, loadGraph, matchesAny, ROOT, TaskGraph } from "./src/graph.js";
import { CATCHES, failingTasks, unwinnable } from "./src/oracle.js";
import { SCENARIOS, WITH_DEFECT } from "./src/scenarios.js";
import { caught, globsOnly, plan, planAll, planFromScores, planPruned, staticAffected } from "./src/select.js";
import { ARMS, questionsFor, stateFor } from "./src/arms.js";
import { CALIBRATION, impliedCutoff, planLeastLoss, probability } from "./src/cost.js";

let pass = 0;
let fail = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

function eq<T>(actual: T, expected: T, what = ""): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}${what ? ": " : ""}${a} !== ${b}`);
}

function ok(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

const graph = new TaskGraph(loadGraph(ROOT));

// ---------------------------------------------------------------- globs

check("a single star stops at a slash", () => {
  ok(globToRegExp("packages/*/package.json").test("packages/ui/package.json"), "one segment");
  ok(!globToRegExp("packages/*/package.json").test("packages/ui/src/package.json"), "two segments");
});

check("a double star spans segments, and zero of them", () => {
  ok(globToRegExp("**/*.ts").test("a.ts"), "no directory");
  ok(globToRegExp("**/*.ts").test("web/src/a.ts"), "two directories");
  ok(!globToRegExp("**/*.ts").test("web/src/a.tsx"), "different extension");
});

check("a trailing double star covers a whole subtree", () => {
  ok(globToRegExp("web/**").test("web/src/routes/a.tsx"), "deep");
  ok(!globToRegExp("web/**").test("weblog/a.ts"), "prefix is not a boundary");
});

check("a dot is a literal", () => {
  ok(!globToRegExp("pnpm-lock.yaml").test("pnpm-lockXyaml"), "dot escaped");
});

// ---------------------------------------------------------------- the graph

check("the graph came from just, with every annotation parsed", () => {
  eq(graph.tasks.length, 27);
  const noCost = graph.tasks.filter((t) => !graph.isMeta(t.name) && t.cost === 0);
  eq(noCost.map((t) => t.name), [], "recipes missing @cost");
  const noDoc = graph.tasks.filter((t) => t.doc === null);
  eq(noDoc.map((t) => t.name), [], "recipes missing a doc comment");
});

check("goals are the recipes nothing else depends on", () => {
  const goals = graph.goals().map((t) => t.name);
  eq(goals.length, 18);
  ok(!goals.includes("install"), "install is a prerequisite, not a goal");
  ok(!goals.includes("build-web"), "build-web is a prerequisite of a11y and the e2e suites");
  ok(!goals.includes("ci"), "the meta recipe is not a goal");
  ok(goals.includes("e2e-auth"), "e2e-auth is a goal");
  ok(goals.includes("infra-plan"), "infra-plan is a goal even though infra-validate is not");
});

check("the closure pulls in the whole prerequisite chain, in a runnable order", () => {
  const order = graph.ordered(graph.closure(["e2e-auth"]));
  eq([...order].sort(), [
    "build-api",
    "build-shared",
    "build-ui",
    "build-web",
    "codegen",
    "e2e-auth",
    "install",
  ]);
  const seen = new Set<string>();
  for (const name of order) {
    for (const d of graph.task(name).deps) {
      ok(seen.has(d), `${name} runs before its prerequisite ${d}`);
    }
    seen.add(name);
  }
});

check("dependents run upwards and ignore the meta recipe", () => {
  const up = graph.dependents(["build-shared"]);
  ok(up.has("test-web-unit"), "a shared change reaches the web unit suite");
  ok(up.has("e2e-web"), "and the browser suite");
  ok(!up.has("ci"), "but never the aggregate");
});

check("the critical path is the longest chain, not the sum", () => {
  const p = plan(graph, ["e2e-auth"]);
  eq(p.serial, 35 + 12 + 18 + 8 + 46 + 24 + 140, "machine seconds");
  // install -> build-shared -> build-ui -> build-web -> e2e-auth
  eq(p.wall, 35 + 12 + 18 + 46 + 140, "wall clock");
  ok(p.wall < p.serial, "parallelism has to help somewhere");
});

check("run everything is the ci recipe's own closure", () => {
  const all = planAll(graph);
  eq(all.run.length, 26, "every recipe but ci");
  eq(all.serial, 1111);
});

// ---------------------------------------------------------------- the oracle

check("every task that can catch something exists in the graph", () => {
  const unknown = Object.keys(CATCHES).filter((n) => !graph.byName.has(n));
  eq(unknown, [], "unknown task names in CATCHES");
});

check("no scenario plants a defect nothing can catch", () => {
  eq(unwinnable(graph, SCENARIOS).map((s) => s.id), []);
});

check("running everything catches every defect", () => {
  const all = planAll(graph);
  const missed = WITH_DEFECT.filter((s) => !caught(all, failingTasks(graph, s)));
  eq(missed.map((s) => s.id), []);
});

check("the defect sets are narrow enough for the corpus to discriminate", () => {
  // If a defect were caught by most of the graph, skipping the right task
  // would still catch it and the corpus would measure nothing.
  const wide = WITH_DEFECT.filter((s) => failingTasks(graph, s).size > 8);
  eq(wide.map((s) => `${s.id}:${failingTasks(graph, s).size}`), []);
});

check("a defect's surfacing path is not always a path the diff touches", () => {
  const schema = SCENARIOS.find((s) => s.id === "schema_nonnull")!;
  ok(
    !schema.files.some((f) => f.path === schema.defect!.at),
    "the schema change surfaces in a file it does not touch",
  );
  ok(failingTasks(graph, schema).has("typecheck-web"), "and the web typecheck is what sees it");
});

// ---------------------------------------------------------------- strategies

check("the static baseline is sound on all twenty branches", () => {
  const missed = WITH_DEFECT.filter(
    (s) => !caught(staticAffected(graph, s), failingTasks(graph, s)),
  );
  eq(missed.map((s) => s.id), []);
});

check("the static baseline over-selects, which is the point", () => {
  const typo = SCENARIOS.find((s) => s.id === "comment_typo")!;
  const p = staticAffected(graph, typo);
  ok(p.serial > 900, `a comment in packages/shared still costs ${p.serial}s`);
});

check("a11y is reached through the graph, not through its own globs", () => {
  // Its @inputs say web/**, the change is in packages/ui: only the dependency
  // edge build-ui -> build-web -> a11y connects them.
  const aria = SCENARIOS.find((s) => s.id === "ui_aria_removed")!;
  ok(!matchesAny("packages/ui/src/IconButton.tsx", graph.task("a11y").inputs), "globs miss it");
  ok(staticAffected(graph, aria).selected.includes("a11y"), "the graph finds it");
});

check("glob matching without the graph is unsound, and this is where", () => {
  const missed = WITH_DEFECT.filter(
    (s) => !caught(globsOnly(graph, s), failingTasks(graph, s)),
  );
  eq(missed.map((s) => s.id), ["ui_aria_removed"]);
});

check("a selection of goals always runs its prerequisites", () => {
  const p = planFromScores(graph, { "test-api-integration": 2 }, 1);
  eq(p.selected, ["test-api-integration"]);
  ok(p.run.includes("db-migrate") && p.run.includes("install"), "prerequisites added");
  eq(p.run[0], "install", "and ordered so it is runnable");
});

check("pruning can only ever shrink the static set", () => {
  for (const s of SCENARIOS) {
    const affected = new Set(staticAffected(graph, s).selected);
    const scores = Object.fromEntries(graph.goals().map((t) => [t.name, 2]));
    const pruned = planPruned(graph, s, scores, 1);
    for (const n of pruned.selected) ok(affected.has(n), `${n} was not in the static set`);
  }
});

check("an empty selection runs nothing and costs nothing", () => {
  const p = planFromScores(graph, {}, 1);
  eq(p.run, []);
  eq(p.serial, 0);
  eq(p.wall, 0);
});

// ---------------------------------------------------------------- the request

check("one request carries every goal plus the two whole-diff judgments", () => {
  const qs = questionsFor("diff", graph);
  eq(Object.keys(qs).length, 20);
  eq(qs["e2e-auth"].type, "score");
  eq(qs["_all_waste"].type, "noul");
});

check("the score criteria are three ordered rungs", () => {
  const q = questionsFor("diff", graph)["lint"];
  ok(q.type === "score" && q.criteria.length === 3, "three rungs");
});

check("the arms differ only in how much of the change they show", () => {
  const s = SCENARIOS[0];
  const paths = JSON.stringify(stateFor("paths", s, true));
  const diff = JSON.stringify(stateFor("diff", s, true));
  ok(!paths.includes("fetchCart"), "paths arm hides the hunk");
  ok(diff.includes("fetchCart"), "diff arm shows it");
  ok(paths.includes(s.branch) && diff.includes(s.branch), "both keep the branch");
});

check("--no-intent drops the branch and the subject, nothing else", () => {
  const s = SCENARIOS[0];
  const blind = JSON.stringify(stateFor("diff", s, false));
  ok(!blind.includes(s.branch), "branch gone");
  ok(!blind.includes(s.subject), "subject gone");
  ok(blind.includes("fetchCart"), "the patch stays");
});

check("only the graph arm puts graph facts in the question", () => {
  for (const arm of ARMS) {
    const q = questionsFor(arm, graph)["a11y"];
    const text = JSON.stringify(q.instructions);
    eq(text.includes("build-web"), arm === "diff_graph", `${arm} mentions prerequisites`);
  }
});

check("the oracle never reaches Jev", () => {
  // The kind vocabulary itself is not a secret -- "lint catches lint problems"
  // is what the doc comment already says, and half the kind names are task
  // names. Three things are secret, and these are they.
  for (const s of SCENARIOS) {
    const state = JSON.stringify(stateFor("diff_graph", s, true));
    const sent = `${state}${JSON.stringify(questionsFor("diff_graph", graph))}`;
    if (s.defect) {
      ok(!sent.includes(s.defect.why), `${s.id}: the planted reason travelled`);
      // Where the failure surfaces is the real secret. It is fine when the
      // diff touches that file anyway; it must not arrive any other way.
      const touched = s.files.some((f) => f.path === s.defect!.at);
      ok(touched || !sent.includes(s.defect.at), `${s.id}: the surfacing path travelled`);
    }
    // A hidden scope often coincides with some task's declared @inputs, and
    // the graph arm sends those on purpose. What must never travel is a scope
    // glob the justfile does not declare anywhere.
    const declared = new Set(graph.tasks.flatMap((t) => t.inputs));
    for (const [name, c] of Object.entries(CATCHES)) {
      for (const g of c.scope) {
        if (declared.has(g)) continue;
        ok(!sent.includes(`"${g}"`), `${s.id}: ${name}'s hidden scope ${g} travelled`);
      }
    }
  }
});

// ---------------------------------------------------------------- cost rule

check("the implied cutoff rises with the recipe's cost", () => {
  const cheap = impliedCutoff(0.5, 600);
  const dear = impliedCutoff(320, 600);
  ok(cheap < dear, `cheap ${cheap.toFixed(2)} needs less than dear ${dear.toFixed(2)}`);
  eq(impliedCutoff(1200, 600), Number.POSITIVE_INFINITY, "a recipe dearer than the penalty never runs");
  eq(impliedCutoff(0.001, 600), 0, "a recipe cheap enough runs on no evidence");
});

check("the loss rule is monotone in the penalty", () => {
  const scores = Object.fromEntries(graph.goals().map((t) => [t.name, 1.0]));
  let previous = -1;
  for (const penalty of [1, 10, 60, 600, 6000]) {
    const serial = planLeastLoss(graph, scores, penalty).serial;
    ok(serial >= previous - 1e-9, `penalty ${penalty}: ${serial} after ${previous}`);
    previous = serial;
  }
});

check("the loss rule runs nothing when a miss is cheaper than the checks", () => {
  const scores = Object.fromEntries(graph.goals().map((t) => [t.name, 0.2]));
  eq(planLeastLoss(graph, scores, 0.001).selected, [], "nothing is worth its seconds");
});

check("a high score on one goal drags in its prerequisites and nothing else", () => {
  const scores = Object.fromEntries(graph.goals().map((t) => [t.name, 0]));
  const one = graph.goals().find((t) => t.deps.length > 0)!;
  scores[one.name] = 3;
  const chosen = planLeastLoss(graph, scores, 600);
  ok(chosen.selected.includes(one.name), `${one.name} selected`);
  for (const dep of one.deps) ok(chosen.run.includes(dep), `${dep} pulled in by the closure`);
});

check("the bitmask selection agrees with the obvious implementation", () => {
  // The fast version indexes tasks and goals separately and ORs closures into
  // bitmasks; the obvious version just walks sets. They have to agree, and
  // once they did not: the loss was reading a task-indexed array with a goal
  // index, which changed the objective without failing anything. docs/19's
  // "two implementations found the rounding bug", scaled down to one function.
  const goals = graph.goals().map((t) => t.name);
  const scores = Object.fromEntries(goals.map((n, i) => [n, ((i * 7) % 13) / 4]));
  const naive = (penalty: number): number => {
    const p = Object.fromEntries(goals.map((n) => [n, probability(scores[n])]));
    const loss = (selected: string[]): number => {
      const run = graph.closure(selected);
      let inside = 1;
      for (const n of run) inside *= 1 - (p[n] ?? 0);
      let outside = 1;
      for (const n of goals) if (!run.has(n)) outside *= 1 - (p[n] ?? 0);
      return graph.serialCost(run) + penalty * inside * (1 - outside);
    };
    let best = loss([]);
    for (let mask = 1; mask < 1 << goals.length; mask += 1) {
      const set = goals.filter((_, i) => (mask >> i) & 1);
      best = Math.min(best, loss(set));
    }
    return best;
  };
  const mine = (penalty: number): number => {
    const p = Object.fromEntries(goals.map((n) => [n, probability(scores[n])]));
    const chosen = planLeastLoss(graph, scores, penalty);
    const run = new Set(chosen.run);
    let inside = 1;
    for (const n of run) inside *= 1 - (p[n] ?? 0);
    let outside = 1;
    for (const n of goals) if (!run.has(n)) outside *= 1 - (p[n] ?? 0);
    return graph.serialCost(run) + penalty * inside * (1 - outside);
  };
  for (const penalty of [60, 600]) {
    const a = mine(penalty);
    const b = naive(penalty);
    ok(Math.abs(a - b) < 1e-9, `penalty ${penalty}: ${a.toFixed(4)} against the optimum ${b.toFixed(4)}`);
  }
});

check("the shipped calibration is a probability, and monotone", () => {
  ok(CALIBRATION.a > 0, "higher score, higher probability");
  let previous = -1;
  for (const s of [0, 0.5, 1, 1.5, 2, 2.5, 3]) {
    const p = probability(s);
    ok(p > previous, `p(${s}) = ${p.toFixed(3)} rises`);
    ok(p >= 0 && p <= 1, "inside [0,1]");
    previous = p;
  }
});

console.log("");
console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
