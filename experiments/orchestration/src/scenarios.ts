/**
 * The corpus: situations, and the answer `multi-agent-orchestration` gives.
 *
 * The skill is unusual for this repository because it does not say "use
 * judgment" -- it states a DECISION PROCEDURE, and the procedure is a boolean
 * expression over four named conditions:
 *
 *   > Default to a single agent. Go multi only if (1) or (2) holds and (4) is
 *   > positive.
 *   > 1. Independent parts that can run in parallel
 *   > 2. Agents would have different information, models, tools, or permissions
 *   > 3. Intermediate artifacts checkable mechanically
 *   > 4. Expected gain of another agent beats its token / latency cost
 *   > **3 is not a reason to spawn.**
 *
 * So the label is `(c1 || c2) && c4`, applied to conditions that each
 * scenario DECLARES. Nothing here is my opinion about whether a task wants
 * agents: I fix the four facts, the skill's own sentence fixes the answer,
 * and the scenario text states the facts without naming them.
 *
 * Condition 4 needed a decision. Read literally ("expected gain of ANOTHER
 * agent beats its cost") it is not independent of 1 and 2 -- with no
 * independent parts the gain is zero, so 4 could never be positive without
 * 1 or 2, and the gate would collapse to `(1 or 2)`. The corpus reads it as
 * the SIZE fact it has to be for the conjunction to mean anything: is the
 * task large enough that an extra agent's tokens and latency would be small
 * against it. docs/31 §1 states that choice and what it costs.
 *
 * `three` is carried but never used by the label, which is the point of the
 * `withThree` arm: the skill says in bold that condition 3 is not a reason to
 * spawn, and a selector that reads it as one gets four scenarios wrong --
 * the ones built to have 3 and 4 without 1 or 2.
 *
 * The topology label is the row of the skill's own table whose "Use for"
 * column the scenario is written from.
 */

export const PATTERNS = [
  "sequential",
  "fanout",
  "supervisor",
  "handoff",
  "blackboard",
  "debate",
  "dynamic_dag",
  "evolution",
] as const;
export type Pattern = (typeof PATTERNS)[number];

/** The skill's table, as the `choice` criteria. Its own words, condensed. */
export const PATTERN_USE: Record<Pattern, string> = {
  sequential: "A clear transform pipeline: A then B then C, each step consuming the last one's output.",
  fanout: "Independent work in parallel then merged: research, a known candidate set, independent tests.",
  supervisor: "Open-ended research or development where a manager has to decompose, assign and replan.",
  handoff: "Routing where ownership moves to the next specialist, who then owns the reply.",
  blackboard: "Long-running asynchronous development around a shared task board and shared artifacts.",
  debate: "A judgment that is hard to grade, answered independently and then critiqued or voted on.",
  dynamic_dag: "Difficulty varies so widely that the roles, dependencies and parallelism must be chosen at run time.",
  evolution: "The same class of task repeats often enough to search over workflows themselves.",
};

export interface Conditions {
  /** (1) Independent parts that can run in parallel. */
  independent: boolean;
  /** (2) The agents would differ in information, model, tools or permissions. */
  different: boolean;
  /** (3) Intermediate artifacts are mechanically checkable. NOT in the rule. */
  three: boolean;
  /**
   * (4) Is the task big enough that another agent's tokens and latency are
   * small against it? Read as a size fact -- see the note at the top.
   */
  bigEnough: boolean;
}

export interface Scenario {
  id: string;
  /** What the requester says. The only thing any arm sees. */
  text: string;
  conditions: Conditions;
  /** The table row this is written from, or "single" when the gate says no. */
  topology: Pattern | "single";
  /** Which "Common mistakes" row this is, when it is one. */
  trap?: string;
  /** Why the conditions are what they are, for a reader checking the corpus. */
  why: string;
}

const C = (independent: boolean, different: boolean, three: boolean, bigEnough: boolean): Conditions => ({
  independent,
  different,
  three,
  bigEnough,
});

export const SCENARIOS: Scenario[] = [
  // ------------------------------------------------- the gate says go multi
  {
    id: "three-services",
    text:
      "We are adding rate limiting to three services that share nothing but a Redis instance. " +
      "Each one is its own repository, its own deploy pipeline, roughly a week of work, and the " +
      "middleware signature is already agreed and written down. Each has an integration test suite.",
    conditions: C(true, false, true, true),
    topology: "fanout",
    why: "Disjoint write sets, a frozen contract, and each part large enough to pay for an agent.",
  },
  {
    id: "library-survey",
    text:
      "I need to choose between four job-queue libraries for a Node service. For each one I want " +
      "the maintenance status, the retry semantics, whether it survives a Redis restart, and what " +
      "it costs to run. I have a rubric I want every answer filled in against.",
    conditions: C(true, false, true, true),
    topology: "fanout",
    why: "Four independent lookups with a schema to fill; the candidate set is known.",
  },
  {
    id: "pentest-pair",
    text:
      "Before release I want the authentication code reviewed by someone reading the source and " +
      "separately probed by someone who only has the running staging URL and no repository access. " +
      "The second one should not be told what the first one found.",
    conditions: C(false, true, true, true),
    topology: "fanout",
    why: "Condition 2: different information and different permissions, deliberately.",
  },
  {
    id: "migration-open",
    text:
      "We want to move a 40k-line Rails app off Sidekiq onto something else. Nobody has scoped it " +
      "yet: we do not know how many call sites there are, which ones are load-bearing, or whether " +
      "the scheduling semantics can be preserved. Expect several weeks and a lot of re-planning.",
    conditions: C(true, false, false, true),
    topology: "supervisor",
    why: "Open-ended, needs decomposition and replanning; the parts are not known up front.",
  },
  {
    id: "research-broad",
    text:
      "Find out what is actually known about prompt injection defences in tool-using agents. " +
      "I do not have a list of sources; I want the space mapped, then the strongest three defences " +
      "written up with citations. Budget is not a concern here.",
    conditions: C(true, false, true, true),
    topology: "supervisor",
    why: "Broad investigation where the manager must decide what to look at next.",
  },
  {
    id: "support-router",
    text:
      "Inbound support messages land in one inbox. Billing questions should end up with the person " +
      "who can issue refunds, bug reports with the on-call engineer, and sales questions with " +
      "sales. Whoever ends up with it answers the customer directly.",
    conditions: C(false, true, false, true),
    topology: "handoff",
    why: "Different permissions per specialist, and ownership of the reply moves with the ticket.",
  },
  {
    id: "long-running-board",
    text:
      "Four people are working through a 200-item backlog over a month, asynchronously across " +
      "timezones. Nobody is online at the same time. The state of who is doing what has to survive " +
      "restarts, and the CI results are what tell everyone where things stand.",
    conditions: C(true, false, true, true),
    topology: "blackboard",
    why: "Long-running, asynchronous, shared task board; state must outlive any one session.",
  },
  {
    id: "grade-essays",
    text:
      "I have 50 short answers to a question that does not have a single right answer, and I need " +
      "a defensible ranking. Two readers who cannot see each other's scores would give me something " +
      "I can argue about; one reader would not.",
    conditions: C(false, true, false, true),
    topology: "debate",
    why: "Hard-to-grade judgment where independent answers before any critique is the point.",
  },
  {
    id: "mixed-difficulty",
    text:
      "This queue has 60 tickets. Some are typo fixes in a README, some are multi-week protocol " +
      "changes, and we cannot tell which is which until someone has opened it. Whatever we build " +
      "has to decide per ticket how much to spend.",
    conditions: C(true, false, true, true),
    topology: "dynamic_dag",
    why: "The skill's own row: difficulty varies so widely the shape must be decided at run time.",
  },
  {
    id: "repeated-class",
    text:
      "Every week we get the same shape of task: take a REST endpoint's OpenAPI spec and generate " +
      "a typed client plus tests. We have done it 80 times. We keep tweaking the procedure by hand " +
      "and would rather search for a better one automatically.",
    conditions: C(true, false, true, true),
    topology: "evolution",
    why: "The same task class, many repeats; the thing to optimise is the workflow itself.",
  },
  {
    id: "two-languages",
    text:
      "The same algorithm has to land in the Rust core and in the TypeScript client, and the two " +
      "must agree. The wire format is already frozen in a JSON schema. Each side is a few hundred " +
      "lines with its own test suite, and the two repositories do not share files.",
    conditions: C(true, false, true, true),
    topology: "fanout",
    why: "Disjoint write sets behind a frozen contract artifact, both sides substantial.",
  },
  {
    id: "model-families",
    text:
      "I want to know whether this SQL migration is safe. I would like one look from something that " +
      "reads the schema and the query plans, and a second, separate look from something that only " +
      "runs the migration against a copy of production and reports what happened.",
    conditions: C(false, true, true, true),
    topology: "fanout",
    why: "Static analysis against execution: genuinely different evidence, not different personas.",
  },

  // -------------------------------------------- the gate says stay single
  {
    id: "read-patch-test",
    text:
      "There is a null-pointer crash in the checkout handler. Read the stack trace, find the line, " +
      "fix it, run the test suite. One file, maybe fifteen lines.",
    conditions: C(false, false, true, false),
    topology: "single",
    why: "The skill's own 'when not to use': one tightly sequential transform with no independent parts.",
  },
  {
    id: "programmer-reviewer",
    text:
      "I want one agent to write the function and a second agent called the reviewer to check it. " +
      "Same repository, same tools, same model, same context — the second one just has a different " +
      "name and is told to be critical.",
    conditions: C(false, false, true, false),
    topology: "single",
    trap: "Name them programmer and reviewer",
    why: "Homogeneous role-play. Same model, same input, same tools; only the role name changes.",
  },
  {
    id: "debate-will-fix",
    text:
      "The answer to this API design question keeps coming out wrong. I want three agents to argue " +
      "about it and vote. They would all read the same two files and have the same tools; nobody " +
      "would go and find anything new.",
    conditions: C(false, false, false, false),
    topology: "single",
    trap: "Debate will fix the answer",
    why: "Closed debate adds no evidence; the errors are correlated because the inputs are identical.",
  },
  {
    id: "team-of-five",
    text:
      "Rename a CSS class across the project and update the two snapshot tests it breaks. Let us " +
      "start a team of five so it goes faster.",
    conditions: C(false, false, true, false),
    topology: "single",
    trap: "Always start a team of 5",
    why: "An easy task; five agents cost more than the work.",
  },
  {
    id: "function-call-edge",
    text:
      "The parser calls the tokenizer, so I assumed this cannot be parallelised. But the tokenizer's " +
      "signature is fixed in a .d.ts we already committed, the two live in separate directories that " +
      "nothing else writes to, and each side is about two days of work with its own tests.",
    conditions: C(true, false, true, true),
    topology: "fanout",
    trap: "There is a function call, so it cannot be parallel",
    why: "The skill says a call edge is not an automatic stay-single once the signature is frozen.",
  },
  {
    id: "worktrees-ignore",
    text:
      "Three agents, three git worktrees, and all three need to edit `src/config.ts` — but since " +
      "they are in separate worktrees the conflicts will not be a problem.",
    conditions: C(false, false, true, false),
    topology: "single",
    trap: "Worktrees mean we can ignore write-sets",
    why: "Worktrees defer conflicts rather than removing them; the write sets overlap.",
  },
  {
    id: "full-thread",
    text:
      "Spin up four agents on this refactor and give each of them the whole conversation so far, " +
      "including the two approaches we already abandoned, so they have full context.",
    conditions: C(false, false, false, false),
    topology: "single",
    trap: "Give everyone the full thread",
    why: "Context pollution and stale decisions; and no independent parts were identified.",
  },
  {
    id: "more-is-better",
    text:
      "This upgrade is mostly running one command and then fixing whatever the compiler complains " +
      "about, in order, until it builds. It feels hard so I want to throw more agents at it.",
    conditions: C(false, false, true, false),
    topology: "single",
    trap: "More agents = more quality",
    why: "Sequential and tool-heavy; the skill says these often get worse with more agents.",
  },
  {
    id: "three-only",
    text:
      "Migrating this 12k-line module to the new API is about two weeks of work, and the test suite " +
      "is excellent — 400 tests, full coverage, a linter that catches everything, so nothing anyone " +
      "claims has to be trusted. But every edit is on the same set of files and each one has to " +
      "build on the last. Should we split it across agents because the results are so checkable?",
    conditions: C(false, false, true, true),
    topology: "single",
    why: "Condition 3 with 1 and 2 absent and 4 positive: the case the bold sentence is about.",
  },
  {
    id: "three-only-2",
    text:
      "This is a month of work rewriting the query planner, and a differential tester will reject " +
      "any plan that does not match the old one, so every intermediate result is verifiable. " +
      "It is one file, and each rewrite depends on the shape the previous rewrite left behind.",
    conditions: C(false, false, true, true),
    topology: "single",
    why: "Condition 3 again with 4 positive; still one sequential transform on one write set.",
  },
  {
    id: "three-only-3",
    text:
      "Every artifact here has provenance and can be re-derived from the source data, so nothing " +
      "an agent claims has to be trusted. The job is a three-week schema normalisation where each " +
      "step has to see the tables the previous step produced, all in the same database.",
    conditions: C(false, false, true, true),
    topology: "single",
    why: "Condition 3 again with 4 positive; shared write set and strict ordering.",
  },
  {
    id: "three-only-4",
    text:
      "Six months of accumulated lint suppressions to work through, and the linter itself tells us " +
      "when each one is really gone, so progress is completely mechanical to check. Every " +
      "suppression is in the same three files and removing one changes what the next one needs.",
    conditions: C(false, false, true, true),
    topology: "single",
    why: "Condition 3 with 4 positive and overlapping write sets.",
  },
  {
    id: "independent-but-tiny",
    text:
      "Four config files each need the same one-line version bump. They are in four different " +
      "directories and nothing depends on anything. Each edit takes about ten seconds.",
    conditions: C(true, false, true, false),
    topology: "single",
    why: "Condition 1 holds and 4 does not: the parts are independent and far too small to pay for.",
  },
  {
    id: "independent-but-tiny-2",
    text:
      "Add a copyright header to the six files that are missing one. Nothing overlaps, nothing " +
      "depends on anything, and the whole job is under a minute by hand.",
    conditions: C(true, false, true, false),
    topology: "single",
    why: "Condition 1 without 4 again.",
  },
  {
    id: "different-but-tiny",
    text:
      "I want a second opinion on whether this variable should be called `count` or `total`. The " +
      "second opinion would come from a different model with no repository access, which is a " +
      "genuinely different vantage point.",
    conditions: C(false, true, false, false),
    topology: "single",
    why: "Condition 2 holds and 4 does not: a naming question is not worth a second agent.",
  },
  {
    id: "sequential-pipeline",
    text:
      "Take the CSV, normalise the column names, join it against the product table, then write the " +
      "result as Parquet. Each step needs the previous step's output. It is a known, fixed pipeline " +
      "and each stage is substantial enough to own — different data tools at each stage, and each " +
      "stage's output has a schema that has to validate before the next one runs.",
    conditions: C(false, true, true, true),
    topology: "sequential",
    why: "Different tools per stage (condition 2) and worth it, but the stages are strictly ordered.",
  },
  {
    id: "sequential-pipeline-2",
    text:
      "The release process is: cut a tag, build the artifacts, sign them with the hardware key, " +
      "upload, then run the smoke test against the uploaded build. Signing needs a credential the " +
      "build step must not have. Each step is gated on the one before it.",
    conditions: C(false, true, true, true),
    topology: "sequential",
    why: "A permission boundary between stages (condition 2) in a strictly ordered pipeline.",
  },
  {
    id: "handoff-triage",
    text:
      "A chat comes in. Whoever picks it up figures out if it is a password reset, a billing " +
      "dispute or a bug, and then either answers it or passes the whole conversation to the person " +
      "who can. The customer only ever talks to one of us at a time.",
    conditions: C(false, true, false, true),
    topology: "handoff",
    why: "Ownership of the reply moves; the specialists differ in what they can do.",
  },
  {
    id: "blackboard-async",
    text:
      "Six contributors across five timezones are porting a test suite over three months. Nobody " +
      "overlaps. Progress has to be readable by whoever shows up next, and the only source of " +
      "truth about what is done is the CI dashboard and a checked-in progress file.",
    conditions: C(true, false, true, true),
    topology: "blackboard",
    why: "Asynchronous long-running work coordinated through shared state.",
  },
  {
    id: "debate-hiring",
    text:
      "Two candidates, one slot, and the decision is a judgment call about a take-home exercise " +
      "that has no right answer. I want each reviewer to write their verdict privately before " +
      "seeing anyone else's, then discuss.",
    conditions: C(false, true, false, true),
    topology: "debate",
    why: "Hard to grade, and private answers before votes is the mechanism.",
  },
  {
    id: "dynamic-incidents",
    text:
      "Alerts arrive all night. Some are a restart, some are a multi-day investigation, and the " +
      "difference is not visible from the alert. Whatever handles them needs to spend one minute " +
      "or one day depending on what it finds.",
    conditions: C(true, false, true, true),
    topology: "dynamic_dag",
    why: "Difficulty varies widely and is not knowable before starting.",
  },
  {
    id: "evolution-tuning",
    text:
      "We run the same extraction job on 500 documents a day and the accuracy is 80%. We have a " +
      "labelled set. Rather than hand-tuning the steps again, we want something that tries " +
      "variations of the pipeline and keeps what scores better.",
    conditions: C(true, false, true, true),
    topology: "evolution",
    why: "A repeating task class with an eval set: search over workflows.",
  },
  {
    id: "fanout-tests",
    text:
      "The test suite takes 50 minutes. The four packages have no shared fixtures and no shared " +
      "database, and each package's tests pass or fail on their own. We want the wall clock down.",
    conditions: C(true, false, true, true),
    topology: "fanout",
    why: "Genuinely independent work, merged at the end; large enough to pay for.",
  },
  {
    id: "supervisor-unknown",
    text:
      "Something is making the p99 latency spike once an hour and we have no idea what. It could " +
      "be the database, the cache, a cron job, a neighbour on the host, or the client. Someone has " +
      "to decide what to look at next based on what the last look found.",
    conditions: C(false, true, true, true),
    topology: "supervisor",
    why: "Open-ended; what to do next depends on the last result, so a manager has to replan.",
  },
  {
    id: "single-tight",
    text:
      "Rewrite this 60-line function so it does not allocate in the loop. The tests already cover " +
      "it. There is nothing else to change and no other file involved.",
    conditions: C(false, false, true, false),
    topology: "single",
    why: "One tight transform with no independent parts and no different information.",
  },
  {
    id: "single-tight-2",
    text:
      "Add the missing `await` in this async handler and confirm the flaky test stops flaking.",
    conditions: C(false, false, true, false),
    topology: "single",
    why: "Trivial and sequential.",
  },
];

/**
 * The skill's gate, as a function.
 *
 * `(1) or (2), and (4)`. Condition 3 does not appear, which is the sentence
 * the skill sets in bold, and the reason `withThree` exists as an arm.
 */
export function goMulti(c: Conditions): boolean {
  return (c.independent || c.different) && c.bigEnough;
}

/** The same gate with condition 3 wrongly admitted, for the `withThree` arm. */
export function goMultiWithThree(c: Conditions): boolean {
  return (c.independent || c.different || c.three) && c.bigEnough;
}

export const CONDITION_KEYS = ["independent", "different", "three", "bigEnough"] as const;
export type ConditionKey = (typeof CONDITION_KEYS)[number];
