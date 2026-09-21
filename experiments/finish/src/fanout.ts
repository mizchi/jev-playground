/**
 * WORK A HUMAN ACTUALLY FANNED OUT. [TODO §2.0]
 *
 *   tsx src/fanout.ts --count      the corpus, from records/. No key.
 *   TYPESAFEAI_API_KEY=... tsx src/fanout.ts    the sweep
 *   tsx src/fanout.ts --report     from the record
 *
 * WHAT §2.0 ASKED. docs/44 §3 put `Task` in `--allowedTools` and ran 20 runs:
 * **0 `Task` calls out of 227 tool calls.** The gate agreed -- 58/58 below its
 * cutoff -- so both sides said "do not split" and neither was wrong: a
 * one-file bug fix does not need a subagent. **That makes it a corpus problem,
 * not a gate problem**, and §2.0 said the closing condition is *a distribution
 * of work where an agent actually chooses to fan out*, with the most promising
 * direction being §2.1's candidate 3: **human-written units of work from a
 * real repository.**
 *
 * AND IT WAS ON DISK, for the third time in four reports. Every package.json
 * under a `node_modules` carries a `scripts` block its publisher wrote (a glob
 * is spelled out here rather than written, because a bare one ends this block
 * comment at its own slash-star -- the third time that has happened in this
 * repository), and docs/49 already harvested all 2,706 of them. Some are
 * COMPOSITE -- they call two or more of their own siblings -- and **the author
 * chose, in writing, whether those branches run at once or in order**:
 *
 *   concurrently 'yarn:build:types' 'yarn:build:es'    at once
 *   npm run clean && npm run build                      in order
 *
 * THE LABEL IS ASYMMETRIC AND THAT DECIDES THE DESIGN. A `concurrently` set is
 * PROOF of independence: the package ships with those branches running
 * simultaneously, so they do not depend on each other. An `&&` chain is proof
 * of nothing -- `npm run lint && npm run unit` is two independent jobs the
 * author simply never parallelised. So the classes are not symmetric:
 *
 *   PARALLEL    composites the author runs at once. Solid positives.
 *   SEQUENTIAL  composites the author chained. **"Did not", not "could not"**
 *               -- a noisy negative, and the interesting one, because it is
 *               matched with the positives on being composite at all.
 *   SINGLE      one-command scripts. Unambiguous negatives, and the easy
 *               comparison: nothing to split.
 *
 * (The counts are deliberately not written here. `--count` prints them from
 * the harvest, and an earlier draft of this block carried the pre-dedup
 * figures until fixing the branch extraction moved all three -- which is
 * docs/50 §5's defect, for the fourth time.)
 *
 * So there are two comparisons and only one of them is hard. `parallel` against
 * `single` mostly measures whether the gate can count to two. `parallel`
 * against `sequential` is the real one: same shape, same branch counts, opposite
 * label -- and the label on one side is the author's habit rather than a fact
 * about the work, which the report reads rather than hides.
 *
 * WHAT THE GATE IS SHOWN. `jev-orchestrator`'s own `plan()`, so the state, the
 * questions, the framing and the cutoff are all the shipped ones. The request
 * is rendered from the branches' RESOLVED commands with `concurrently`, `&&`
 * and `npm-run-all` stripped out -- **the gate must read independence off the
 * work, not off the operator.** That stripping is the load-bearing step and it
 * is pinned in a test.
 *
 * WHOSE CHOICE THIS IS. §2.0 asked for work where an AGENT chooses to fan out.
 * This is work where an AUTHOR did. That substitution is exactly docs/49's --
 * and it is the same limitation, named in the report rather than papered over.
 *
 * AND THE ANSWER IS NOT THE ONE §2.0 EXPECTED. §2.0 read docs/44 §3's silence
 * as a corpus problem rather than a gate problem. The corpus now exists and
 * `plan()` still splits none of it -- but the `size` answer says the work is
 * small, and it is: three compiler invocations is seconds. **An author reaches
 * for `concurrently` because a second PROCESS is nearly free, which is not the
 * question the gate asks about a second WORKER.** So the corpus satisfies the
 * letter of §2.0's condition and misses it, and the gate is right to decline.
 * What does not survive that excuse is the TOPOLOGY, which is conditional on
 * splitting and so cannot be answered by "the work is small".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { advise, auc, quantile, type Sample } from "../../shared/thresholds.js";
import { plan } from "../../../packages/jev-orchestrator/src/plan.js";
import { GATE_AT, PARALLEL as PARALLEL_PATTERNS } from "../../../packages/jev-orchestrator/src/questions.js";
import { harvest } from "./scripts.js";

const RECORDS = resolve(import.meta.dirname, "../records");
const PATH_ = resolve(RECORDS, "fanout.json");

/**
 * The verbs an author uses to say "at once".
 *
 * `concurrently` and `npm-run-all --parallel` / `run-p` are the two that
 * actually appear; the workspace runners are here because they are the same
 * declaration at a different scale and their absence is worth recording
 * (docs/49's corpus has one `turbo run` and no `pnpm -r`, `lerna run` or
 * `nx run-many` at all).
 */
const PARALLEL_VERB =
  /\b(concurrently|npm-run-all\s+(?:-p\b|--parallel)|run-p\b|wsrun\b|pnpm\s+-r\b|lerna\s+run\b|turbo\s+run\b|nx\s+run-many\b)/;

/**
 * Every sibling script a command calls, in every spelling the corpus uses.
 *
 * THE FIRST VERSION MISSED THE BARE `yarn X` FORM, and the very first example
 * the report printed showed it: `concurrently 'yarn:build:types'
 * 'yarn:build:es' && yarn build:cjs` has THREE branches and it captured two.
 * An understated branch list is not a cosmetic bug here -- the request shown
 * to the gate is built from it, so the gate was being asked about less work
 * than the author wrote.
 *
 * `yarn X` and `pnpm X` are shorthands for `yarn run X`, so a bare token
 * counts **only when it names a real sibling** -- that is what keeps
 * `tsc -p build` from being read as a call to a `build` script.
 */
export function siblingsIn(command: string, siblings: Record<string, string>, self: string): string[] {
  const found: string[] = [];
  const add = (name: string): void => {
    if (name !== self && typeof siblings[name] === "string" && !found.includes(name)) found.push(name);
  };
  // `yarn:NAME` -- concurrently's shorthand.
  for (const m of command.matchAll(/yarn:([A-Za-z0-9:_-]+)/g)) add(m[1]);
  // An explicit `run`.
  for (const m of command.matchAll(/(?:npm|yarn|pnpm)\s+run\s+([A-Za-z0-9:_-]+)/g)) add(m[1]);
  // The bare shorthand, validated against the scripts block.
  for (const m of command.matchAll(/(?:^|[\s;&|])(?:yarn|pnpm)\s+([A-Za-z0-9:_-]+)/g)) add(m[1]);
  // The multi-argument runners, whose arguments are all script names.
  for (const m of command.matchAll(/(?:npm-run-all|run-s|run-p)((?:\s+[A-Za-z0-9:_@*-]+)+)/g)) {
    for (const tok of m[1].trim().split(/\s+/)) if (!tok.startsWith("-")) add(tok);
  }
  return found;
}

export type Klass = "parallel" | "sequential" | "single";

export interface Item {
  pkg: string;
  script: string;
  /** The author's own command, verbatim. Never shown to the gate. */
  command: string;
  klass: Klass;
  /** `concurrently A B && C`: parallel branches AND a sequential tail. */
  mixed: boolean;
  /** The sibling scripts it calls, and what each of those actually runs. */
  branches: { name: string; command: string }[];
  /** What the gate is shown. Rendered, with the operators stripped. */
  request: string;
}

export interface Row extends Item {
  gate: number;
  size: number;
  staySingle: number;
  topology: string | null;
  topologyConfidence: number;
  shape: string;
  workers: number;
  split: boolean;
  agreement: string;
  ms: number;
}

export interface Record_ {
  note: string;
  framing: string;
  gateAt: number;
  rows: Row[];
}

const NOTE =
  "TODO §2.0's fan-out corpus, labelled by the authors of 354 published packages: a " +
  "composite npm script is `parallel` when its author runs the branches at once " +
  "(`concurrently`), `sequential` when it chains them (`&&`), and `single` when there " +
  "is one command. The gate is shown the branches' resolved commands with the " +
  "operators stripped, through jev-orchestrator's own plan().";

// ------------------------------------------------------------------ the corpus

/** Every package.json's scripts block, keyed by directory. */
function scriptsByDir(): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const e of harvest()) {
    if (out.has(e.dir)) continue;
    try {
      const j = JSON.parse(readFileSync(resolve(e.dir, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      out.set(e.dir, j.scripts ?? {});
    } catch {
      out.set(e.dir, {});
    }
  }
  return out;
}

/**
 * The request the gate sees.
 *
 * THE STRIPPING IS THE WHOLE EXPERIMENT. If `concurrently` or `&&` survived
 * into this string the gate would be reading the author's answer back, which
 * is docs/45 §2's oracle -- so the branches are rendered from their own
 * resolved commands and nothing carries the operator. `npm run lint && npm run
 * unit` and `concurrently 'yarn:lint' 'yarn:unit'` produce the SAME request,
 * which is the point: they are the same work, and the labels differ because
 * the authors differed.
 */
export function requestFor(pkg: string, branches: { name: string; command: string }[]): string {
  if (branches.length === 0) return "";
  const list = branches.map((b) => `- ${b.name}: ${b.command}`).join("\n");
  return (
    `In the package ${pkg}, this piece of work has to be done. It consists of ` +
    `${branches.length === 1 ? "one step" : `${branches.length} steps`}:\n${list}`
  );
}

/** A single-command script, rendered the same way so the two are comparable. */
function requestForSingle(pkg: string, script: string, command: string): string {
  return requestFor(pkg, [{ name: script, command }]);
}

/** How many rows the last `corpus()` call dropped as inline-chained. */
export let excluded = 0;
/** Of those, the ones that hand the fan-out to a workspace runner. */
export let delegating = 0;

export function corpus(): Item[] {
  const byDir = scriptsByDir();
  const out: Item[] = [];
  const seen = new Set<string>();
  excluded = 0;
  delegating = 0;
  for (const e of harvest()) {
    const siblings = byDir.get(e.dir) ?? {};
    const names = siblingsIn(e.command, siblings, e.script);
    const isParallel = PARALLEL_VERB.test(e.command);
    const composite = names.length >= 2 || (isParallel && names.length >= 1);
    /**
     * `single` HAS TO MEAN ONE COMMAND, and the first version let chained work in.
     *
     * `tsc -p tsconfig.json && tsc -p tsconfig.module.json` calls no sibling
     * script, so it fell through to `single` -- but it is two steps chained,
     * which is exactly what `single` is supposed to exclude. **16% of the
     * class had a `&&` in it**, found by the no-leak test flagging one of them
     * rather than by reading.
     *
     * Those rows cannot be subjects either way: the rendering needs NAMED
     * branches and an inline chain has none. So they leave the corpus, and
     * `--count` prints how many.
     */
    const chained = !composite && /(&&|\|\||[;|])/.test(e.command);
    /**
     * `yarn g:turbo run build -F=$npm_package_name` IS FAN-OUT, and it is one
     * command.
     *
     * A workspace runner delegates the fan-out to a tool, so there are no
     * sibling branches to resolve and it fell into `single` -- a negative
     * class, for work that is arguably the most fan-out-shaped in the corpus.
     * All 19 were in `single` and none in either composite class, so the hard
     * comparison was never affected; the control was. Found by the no-leak
     * test, again, rather than by reading.
     */
    const delegates = !composite && PARALLEL_VERB.test(e.command);
    if (chained || delegates) {
      excluded += 1;
      if (delegates) delegating += 1;
      continue;
    }
    const klass: Klass = composite ? (isParallel ? "parallel" : "sequential") : "single";
    /**
     * `concurrently A B && C` is parallel AND then sequential.
     *
     * It is classed `parallel` -- the author did declare that some branches
     * run at once -- but the branch list flattens the two stages, so the row
     * is marked and the count is reported in §4 rather than left implicit.
     */
    const mixed = isParallel && /&&/.test(e.command) && names.length >= 2;
    const branches = composite
      ? names.map((n) => ({ name: n, command: siblings[n] }))
      : [{ name: e.script, command: e.command }];
    const request = composite
      ? requestFor(e.pkg, branches)
      : requestForSingle(e.pkg, e.script, e.command);
    if (request === "") continue;
    // DEDUPLICATED BY THE REQUEST, not by the command: two packages whose
    // composite resolves to the same branch commands are one subject for the
    // gate, and counting them twice would weight `@smithy`'s 40 identical
    // packages 40 times (docs/49's reason for deduplicating at all).
    if (seen.has(request)) continue;
    seen.add(request);
    out.push({ pkg: e.pkg, script: e.script, command: e.command, klass, mixed, branches, request });
  }
  return out;
}

// -------------------------------------------------------------------- report

const pct = (x: number, n: number): string => (n === 0 ? "—" : `${((100 * x) / n).toFixed(0)}%`);

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

const p = (x: number): string => (x < 0.001 ? "p < 0.001" : `p = ${x.toFixed(3)}`);

function countSection(items: Item[]): void {
  console.log("\n# Work a human actually fanned out [TODO §2.0]\n");
  console.log("## 0. The corpus was on disk, and its authors labelled it\n");
  console.log(
    "docs/44 §3 put `Task` in `--allowedTools` and ran 20 runs: **0 `Task` calls out of 227 tool " +
      "calls**, with the gate agreeing at 58/58 below its cutoff. **Both sides said do not split, and " +
      "neither was wrong** -- a one-file bug fix does not need a subagent. §2.0 recorded that as a " +
      "corpus problem and named the direction: **human-written units of work from a real repository.**\n",
  );
  console.log(
    "**It was in docs/49's harvest already.** Some published `scripts` are *composite* -- they call " +
      "two or more of their own siblings -- and **the author wrote down whether those branches run at " +
      "once or in order**:\n\n```\nconcurrently 'yarn:build:types' 'yarn:build:es'    at once\n" +
      "npm run clean && npm run build                      in order\n```\n",
  );
  const by = (k: Klass): Item[] => items.filter((i) => i.klass === k);
  console.log("| class | the author's own verb | distinct subjects | branches (median) |");
  console.log("| --- | --- | --- | --- |");
  for (const k of ["parallel", "sequential", "single"] as const) {
    const g = by(k);
    console.log(
      `| \`${k}\` | ${k === "parallel" ? "`concurrently`, `run-p`" : k === "sequential" ? "`&&`" : "one command" } | ` +
        `**${g.length}** | ${g.length === 0 ? "—" : quantile(g.map((i) => i.branches.length), 0.5)} |`,
    );
  }
  console.log(
    `\n**${excluded} more scripts were dropped, for two reasons the no-leak test found rather than ` +
      `my reading.** ${excluded - delegating} are **inline-chained**: \`tsc -p a && tsc -p b\` is two ` +
      "steps but calls no sibling, so it has no named branches to render and it is not one command " +
      "either -- the first version let those into `single`, where **16% of the class turned out to " +
      `have a \`&&\` in it.** The other ${delegating} **hand the fan-out to a workspace runner** ` +
      "(`yarn g:turbo run build -F=$npm_package_name`): one command, no branches to resolve, and " +
      "**arguably the most fan-out-shaped work in the corpus, sitting in the negative class.**\n\n" +
      "Every one of those was in `single` and **none in either composite class**, so the hard " +
      "comparison was never affected -- the control was. `single` now means one command that fans " +
      "out nothing.\n",
  );
  console.log(
    "\n> **The label is asymmetric, and that decides the design.**\n>\n" +
      "> A `concurrently` set is **proof of independence**: the package ships with those branches " +
      "running simultaneously, so they do not depend on one another. **An `&&` chain is proof of " +
      "nothing** -- `npm run lint && npm run unit` is two independent jobs whose author simply never " +
      "parallelised them.\n>\n" +
      "> So `sequential` is a **\"did not\", not a \"could not\"**, and it is the interesting class " +
      "precisely because it is *matched with `parallel` on being composite at all*. `parallel` against " +
      "`single` mostly measures whether the gate can count to two; **`parallel` against `sequential` " +
      "is the real comparison**, and §3 reads its disagreements rather than scoring them.\n",
  );
  const ex = by("parallel")[0];
  if (ex) {
    console.log(
      "**And what the gate is shown has the operator stripped out.** The author's command is never " +
        "sent; the branches are rendered from their own resolved commands, so `npm run lint && npm run " +
        "unit` and `concurrently 'yarn:lint' 'yarn:unit'` produce the **same request**. For " +
        `\`${ex.pkg}\`'s \`${ex.script}\`:\n\n` +
        "```\n" +
        `# the author wrote (never sent):\n${ex.command}\n\n# the gate sees:\n${ex.request}\n` +
        "```\n",
    );
  }
}

function results(rec: Record_): void {
  const rows = rec.rows;
  const by = (k: Klass): Row[] => rows.filter((r) => r.klass === k);
  console.log("\n## 1. The gate on work a human fanned out\n");
  console.log(
    `Through \`jev-orchestrator\`'s own \`plan()\`, so the state, the questions, the framing ` +
      `(**\`${rec.framing}\`**) and the cutoff (**${rec.gateAt}**, docs/31 §8's fitted number for that ` +
      "framing) are all the shipped ones.\n",
  );
  console.log("| class | n | `gate` median | p90 | over the cutoff | `plan()` split | median workers |");
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  for (const k of ["parallel", "sequential", "single"] as const) {
    const g = by(k);
    if (g.length === 0) continue;
    console.log(
      `| \`${k}\` | ${g.length} | **${quantile(g.map((r) => r.gate), 0.5).toFixed(3)}** | ` +
        `${quantile(g.map((r) => r.gate), 0.9).toFixed(3)} | ` +
        `${g.filter((r) => r.gate >= rec.gateAt).length}/${g.length} ` +
        `(${pct(g.filter((r) => r.gate >= rec.gateAt).length, g.length)}) | ` +
        `**${g.filter((r) => r.split).length}/${g.length}** ` +
        `(${pct(g.filter((r) => r.split).length, g.length)}) | ` +
        `${quantile(g.filter((r) => r.split).map((r) => r.workers), 0.5) || "—"} |`,
    );
  }
  const par = by("parallel");
  const seq = by("sequential");
  const sng = by("single");
  const fired = par.filter((r) => r.split).length;
  console.log(
    `\n**${fired} of ${par.length} of the work a human demonstrably ran in parallel, the gate also ` +
      `wants to split.** That is the number docs/44 §3 could not produce -- its corpus had no such ` +
      "work in it, so a false-negative rate was not measurable at all -- and " +
      (fired === 0
        ? `**it is zero.** Nothing in this corpus comes close: the \`parallel\` class has a p90 of ` +
          `${quantile(par.map((r) => r.gate), 0.9).toFixed(3)} and a maximum of ` +
          `${Math.max(...par.map((r) => r.gate)).toFixed(3)} against a cutoff of ${rec.gateAt}. ` +
          "**No cutoff-independent reading is needed: the gate never fires here at all.**\n"
        : `**it is ${pct(fired, par.length)}.**\n`),
  );
  // THE TOPOLOGY IS THE SHARPER RESULT, because it does not depend on the
  // cutoff. `choice` answers "IF this were split, which shape fits?" -- and
  // for branches the author runs simultaneously, `fanout` ("independent work
  // in parallel then merged") is the answer and `sequential` ("each step
  // consuming the last one's output") is not.
  const shapeOf = (rows_: Row[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of rows_) m.set(String(r.topology), (m.get(String(r.topology)) ?? 0) + 1);
    return m;
  };
  const parShapes = shapeOf(par);
  const parFanout = par.filter((r) => r.topology !== null && PARALLEL_PATTERNS.has(r.topology)).length;
  console.log(
    "**And the shape it picks is the sharper result, because it does not depend on the cutoff.** " +
      "`topology` answers *if this work were split, which shape would fit it?* -- asked and recorded " +
      "whatever the gate decided. For branches their author runs simultaneously the answer is " +
      "`fanout` (*independent work in parallel then merged*), not `sequential` (*each step consuming " +
      "the last one's output*).\n",
  );
  console.log(`| class | ${[...new Set([...par, ...seq, ...sng].map((r) => String(r.topology)))].map((s) => `\`${s}\``).join(" | ")} |`);
  const shapes = [...new Set([...par, ...seq, ...sng].map((r) => String(r.topology)))];
  console.log(`| --- | ${shapes.map(() => "---").join(" | ")} |`);
  for (const [name, g] of [["`parallel`", par], ["`sequential`", seq], ["`single`", sng]] as [string, Row[]][]) {
    const m = shapeOf(g);
    console.log(`| ${name} | ${shapes.map((s) => `${m.get(s) ?? 0}/${g.length}`).join(" | ")} |`);
  }
  console.log(
    `\n**${parFanout} of ${par.length}** of the demonstrably-parallel subjects get a parallel shape; ` +
      `${parShapes.get("sequential") ?? 0} get \`sequential\`. ` +
      (parFanout === 0
        ? "**Zero.** And the two classes where the answer is *not* established get `fanout` more " +
          `often than the one where it is (\`sequential\` ${shapeOf(seq).get("fanout") ?? 0}/${seq.length}, ` +
          `\`single\` ${shapeOf(sng).get("fanout") ?? 0}/${sng.length}) -- **so the ordering is not ` +
          "merely weak, it is inverted on the only class with a known answer.**"
        : "") +
      "\n",
  );
  console.log(
    "> **docs/31 measured this same `choice` at 22/22.**\n>\n" +
      "> That was on its own 38 scenarios, which I wrote. On work somebody else wrote, with the " +
      `answer established by its author shipping it, it is **${parFanout}/${par.length}**.\n>\n` +
      "> **That is docs/49's lesson arriving at the `choice`** -- a self-written corpus measured a " +
      "component far more kindly than someone else's does. docs/49 found the gate 20 times noisier " +
      "on published scripts than on mine; this finds the topology question inverted on them.\n",
  );
  // THE HARD COMPARISON, and the easy one, both against `parallel`.
  for (const [name, other] of [["sequential", seq], ["single", sng]] as [string, Row[]][]) {
    if (other.length === 0) continue;
    const samples: Sample[] = [
      ...par.map((r) => ({ value: r.gate, positive: true, group: r.pkg })),
      ...other.map((r) => ({ value: r.gate, positive: false, group: r.pkg })),
    ];
    const a = auc(samples);
    const verdict = advise(samples, { range: 1 }).verdict;
    console.log(
      `**\`parallel\` against \`${name}\`:** AUC **${a.toFixed(3)}**, \`advise()\` says ` +
        `**${verdict}**. Medians ${quantile(par.map((r) => r.gate), 0.5).toFixed(3)} against ` +
        `${quantile(other.map((r) => r.gate), 0.5).toFixed(3)}; split rates ` +
        `${pct(par.filter((r) => r.split).length, par.length)} against ` +
        `${pct(other.filter((r) => r.split).length, other.length)}.` +
        (name === "sequential"
          ? " **This is the comparison that matters** -- both classes are composite, so it is not " +
            "measuring branch counting."
          : " This one is the easy control: a one-command script has nothing to split.") +
        "\n",
    );
  }
}

function middle(rec: Record_): void {
  const seq = rec.rows.filter((r) => r.klass === "sequential");
  const par = rec.rows.filter((r) => r.klass === "parallel");
  if (seq.length === 0) return;
  console.log("\n## 2. The ambiguous class, read rather than scored\n");
  console.log(
    "`sequential` is the author's **habit** as much as the work's nature, so a gate that fires on one " +
      "of these is not necessarily wrong. **The disagreements are the rows worth looking at**, and " +
      "there are two kinds.\n",
  );
  const fired = seq.filter((r) => r.split);
  console.log(
    `**${fired.length} of ${seq.length} \`sequential\` subjects the gate wants to split.** ` +
      (fired.length === 0
        ? "**None** -- so on this corpus the gate never contradicts an author who chained their " +
          "branches, and the `sequential` class cannot tell us whether it would have been right to.\n"
        : "Whether that is a false positive depends on whether the branches are actually " +
          "independent, which the author's `&&` does not say. The first few:\n"),
  );
  if (fired.length > 0) {
    console.log("| package | the author chained | branches | `gate` |");
    console.log("| --- | --- | --- | --- |");
    for (const r of fired.slice(0, 8)) {
      console.log(
        `| \`${r.pkg.slice(0, 26)}\` | \`${r.command.replace(/\|/g, "\\|").slice(0, 36)}\` | ` +
          `${r.branches.map((b) => `\`${b.name}\``).join(" ")} | ${r.gate.toFixed(2)} |`,
      );
    }
    console.log("");
  }
  // The pairing that removes the author from the comparison: same branch
  // count, one from each class.
  const counts = [...new Set(par.map((r) => r.branches.length))].filter((n) =>
    seq.some((r) => r.branches.length === n),
  );
  if (counts.length > 0) {
    console.log(
      "**Matched on branch count**, so the comparison cannot be about how many steps there are:\n",
    );
    console.log("| branches | `parallel` median | n | `sequential` median | n |");
    console.log("| --- | --- | --- | --- | --- |");
    let up = 0;
    let down = 0;
    for (const n of counts.sort((a, b) => a - b)) {
      const a = par.filter((r) => r.branches.length === n);
      const b = seq.filter((r) => r.branches.length === n);
      const ma = quantile(a.map((r) => r.gate), 0.5);
      const mb = quantile(b.map((r) => r.gate), 0.5);
      if (ma > mb) up += 1;
      else if (ma < mb) down += 1;
      console.log(
        `| ${n} | **${ma.toFixed(3)}** | ${a.length} | ${mb.toFixed(3)} | ${b.length} |`,
      );
    }
    console.log(
      `\n**\`parallel\` scores higher at ${up} of the ${counts.length} branch counts** where both ` +
        `classes have rows (${p(signTest(down, up))} on the ${up + down} discordant ones). At this n ` +
        "that is a direction and not much more, and it is the honest size of the only unconfounded " +
        "comparison in this report.\n",
    );
  }
}

function answer(rec: Record_): void {
  const par = rec.rows.filter((r) => r.klass === "parallel");
  const split = par.filter((r) => r.split).length;
  const sizeMed = quantile(par.map((r) => r.size), 0.5);
  const sizeMax = Math.max(...par.map((r) => r.size));
  const stay = quantile(par.map((r) => r.staySingle), 0.5);
  console.log("\n## 3. §2.0's premise does not survive its own corpus\n");
  console.log(
    "§2.0 read docs/44 §3's silence as **a corpus problem and not a gate problem**, on the grounds " +
      "that a one-file bug fix genuinely does not need a subagent. **The corpus now exists** -- work " +
      "whose author runs it in parallel, so the independence is not my opinion -- and the verdict " +
      "did not change:\n",
  );
  console.log("| §2.0's claim | what the measurement says |");
  console.log("| --- | --- |");
  console.log(
    `| it is a corpus problem, not a gate problem | **does not hold as stated.** Given work a human ` +
      `demonstrably ran in parallel, \`plan()\` splits **${split} of ${par.length}**. Supplying the ` +
      "missing corpus did not make the seam fire |",
  );
  console.log(
    "| the closing condition is a distribution where fan-out is actually chosen | " +
      `**met, with a substitution.** 354 published packages' authors chose it, in writing, on ` +
      `${par.length} distinct subjects -- **but they are authors, not agents** |`,
  );
  console.log(
    "| the most promising direction is §2.1's candidate 3 | **right, and it was the same file.** " +
      "docs/49 had already harvested all 2,706 script entries; this is a re-read of them, not a new " +
      "harvest |",
  );
  console.log(
    "\n**So there are two readings, and they matter very differently.** Either the gate is " +
      "miscalibrated for this work, or **this is not the kind of fan-out the gate is about**. " +
      "The `size` answer decides between them, and it is recorded:\n",
  );
  console.log(
    `| | \`parallel\` class |\n| --- | --- |\n` +
      `| \`size\` median (*large: hours to weeks, or many items*) | **${sizeMed.toFixed(3)}** |\n` +
      `| \`size\` maximum | ${sizeMax.toFixed(3)} |\n` +
      `| \`stay_single\` median (*one worker should simply do this*) | **${stay.toFixed(3)}** |\n`,
  );
  console.log(
    "> **The gate says this work is small, and it is right.**\n>\n" +
      "> Three `tsc` invocations over one source tree is seconds of work. **An author reaches for " +
      "`concurrently` because in a shell a second process is nearly free** -- not because the job " +
      "warrants a second worker. The `cost` framing names exactly what an agent's second worker " +
      "costs (tokens, latency, one worker's mistake propagating), and none of that applies to " +
      "`concurrently`.\n>\n" +
      "> **So the honest reading is that the gate is right and this corpus is not §2.0's corpus.** " +
      "It has the property §2.0 asked for -- fan-out somebody actually chose -- and it does not have " +
      "the property that makes fan-out a *decision*: work large enough for the cost of a worker to " +
      "be small. **A corpus can satisfy the letter of the condition and miss it.**\n",
  );
  console.log(
    "> **And one finding survives that reading intact.**\n>\n" +
      "> The `size` answer excuses the gate for declining to split. **It does not excuse the " +
      "topology.** `topology` is conditional -- *if this were split, which shape would fit* -- so " +
      "\"the work is small\" is not an answer to it, and on the only class whose shape is established " +
      "by execution it chose the wrong one every time. **That is a component result, not a corpus " +
      "one.**\n",
  );
  console.log(
    "**Where this leaves §2.0.** docs/44 §3's 0 `Task` calls were **an agent's choice**, and nothing " +
      "here observes an agent making that choice differently -- these are scripts written once for " +
      "`npm run` by someone who knows the repository. **§2.1's candidate 1 is the condition again**: " +
      "real agent traffic in real repositories. Three reports have now converged on it from " +
      "different directions, which is worth more than any of them arriving there alone.\n",
  );
}

function limits(rec: Record_, items: Item[]): void {
  const par = rec.rows.filter((r) => r.klass === "parallel");
  const seq = rec.rows.filter((r) => r.klass === "sequential");
  console.log("\n## 4. Honest limits\n");
  console.log(
    "- **The `sequential` label is the author's habit, not a fact about the work.** " +
      "`npm run lint && npm run unit` is two independent jobs. So **every number computed against " +
      "`sequential` is a lower bound on the gate's agreement**, and §2 reads that class instead of " +
      "scoring it.\n" +
      `- **${par.length} positives and ${seq.length} ambiguous rows**, and the positives are ` +
      "concentrated: the `@aws-sdk` and `@smithy` families write the same `concurrently` line in " +
      "many packages. Deduplicating by the rendered request removes the byte-identical copies, " +
      "**but not the family resemblance** -- these are not 93 independent authors.\n" +
      "- **The branches are within one package.** That is a narrow kind of fan-out (three compiler " +
      "invocations over one source tree), and **not the kind docs/31's scenarios describe** -- no " +
      "research fan-out, no debate, no review pipeline. The topology numbers should be read as " +
      "\"which shape fits three independent builds\", not as a test of the eight-way `choice`.\n" +
      "- **The stripping is mine and it is load-bearing.** If `concurrently` or `&&` leaked into the " +
      "request the gate would be reading the label. It is pinned in a test that renders both classes " +
      "and asserts neither operator survives, **and that the same branch set produces the same " +
      "request whichever class it came from.**\n" +
      `- **One framing.** \`${rec.framing}\` at ${rec.gateAt}, the shipped default. docs/31 §2 ` +
      "measured the two framings as genuinely different instruments, so the `plain` framing's " +
      "numbers on this corpus are unknown.\n" +
      `- **${items.filter((i) => i.klass === "single").length} single-command scripts exist and only ` +
      "a sample was swept.** The sample is the first N by harvest order, which is package order, " +
      "**not random** -- and the `single` class is the easy control anyway.\n" +
      "- **`npm run lint && npm run unit` is the row this corpus most wants and does not have**: a " +
      "case where the same branch set appears `concurrently` in one package and `&&` in another. " +
      "**That would remove the author from the comparison entirely**, and it is worth looking for " +
      "before trusting §2's direction.",
  );
}

// ------------------------------------------------------------------------ main

function load(): Record_ {
  if (!existsSync(PATH_)) return { note: NOTE, framing: "cost", gateAt: GATE_AT.cost, rows: [] };
  return JSON.parse(readFileSync(PATH_, "utf8")) as Record_;
}

function report(rec: Record_, items: Item[]): void {
  countSection(items);
  if (rec.rows.length === 0) {
    console.log("\n**The sweep has not run**, so §1 onward is empty. Run without `--report`.\n");
    return;
  }
  results(rec);
  middle(rec);
  answer(rec);
  limits(rec, items);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const items = corpus();
  if (argv.includes("--count")) {
    countSection(items);
    return;
  }
  if (argv.includes("--report")) {
    report(load(), items);
    return;
  }
  const singles = Number.parseInt(
    argv.includes("--singles") ? (argv[argv.indexOf("--singles") + 1] ?? "80") : "80",
    10,
  );
  const subjects = [
    ...items.filter((i) => i.klass === "parallel"),
    ...items.filter((i) => i.klass === "sequential"),
    ...items.filter((i) => i.klass === "single").slice(0, singles),
  ];
  const rows: Row[] = [];
  for (const item of subjects) {
    const started = Date.now();
    const res = await plan({ request: item.request });
    rows.push({
      ...item,
      gate: res.judgment?.gate ?? Number.NaN,
      size: res.judgment?.size ?? Number.NaN,
      staySingle: res.judgment?.staySingle ?? Number.NaN,
      topology: res.judgment?.topology ?? null,
      topologyConfidence: res.judgment?.topologyConfidence ?? Number.NaN,
      shape: res.plan.shape,
      workers: res.plan.workers,
      split: res.plan.split,
      agreement: res.plan.agreement,
      ms: Date.now() - started,
    });
    process.stderr.write(
      `${item.klass.padEnd(10)} gate=${(rows[rows.length - 1].gate ?? 0).toFixed(2)} ` +
        `${rows[rows.length - 1].split ? "SPLIT" : "single"} ${String(rows[rows.length - 1].shape).padEnd(12)} ` +
        `${item.pkg.slice(0, 24)} [${item.script}]\n`,
    );
    mkdirSync(RECORDS, { recursive: true });
    writeFileSync(
      PATH_,
      `${JSON.stringify({ note: NOTE, framing: "cost", gateAt: GATE_AT.cost, rows }, null, 2)}\n`,
    );
  }
  report({ note: NOTE, framing: "cost", gateAt: GATE_AT.cost, rows }, items);
}

if (process.argv[1]?.endsWith("fanout.ts")) await main();
