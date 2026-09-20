/**
 * The turns to run through a real pi session, and what the scripted model does
 * on each.
 *
 * Each scenario is built to make ONE component observable AT THE WIRE, because
 * "the handler fired" is a weaker claim than "the decision reached the
 * provider". `stub.ts` records every payload pi sends, so:
 *
 *   the model router    the payload's `model` is the rung it chose
 *   the skill router    an injected skill appears among the messages pi sent
 *   the guard rail      a blocked command leaves its effect undone on disk
 *   the compactor       the payload carries fewer messages than the session
 *
 * The model is scripted, so a difference between the two arms is the
 * extension's doing. What is NOT measured is whether a model does the task
 * well -- there is no model here. This measures the harness.
 *
 * EVERY DESTRUCTIVE COMMAND TARGETS THE SCENARIO'S OWN SANDBOX, and
 * `sandbox.ts` refuses to run the script otherwise. That file's header says
 * why: the control arm runs the dangerous thing with the guard absent, which
 * is the point of a control, so containment has to sit outside both arms.
 * The first version of this file did not, and deleted the repository.
 */
import type { Sandbox } from "./sandbox.js";

export interface Scenario {
  id: string;
  prompt: string;
  /** What the scripted model does, step by step. Last step repeats. */
  script: (sandbox: Sandbox) => { text?: string; calls?: { name: string; input: Record<string, unknown> }[] }[];
  why: string;
  /** Files to create in the working directory first. */
  files?: Record<string, string>;
  /** What the report should check, named so a reader can find it. */
  checks: string[];
  /** Extra pi flags, for settings that are only reachable as flags (docs/38 §6). */
  flags?: string[];
  /** Extra extensions to load beside hermes, by package-relative path. */
  extensions?: string[];
  /**
   * A smaller context window for the stub's models.
   *
   * The only way to reach `jev-compact`'s threshold in a short run: it fires
   * at `contextWindow * startAt`, so 200,000 would need ~140,000 tokens of
   * transcript. See `provider.ts`.
   */
  contextWindow?: number;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "trivial-read",
    prompt: "what does note.txt say?",
    why: "the cheap path end to end: one read, no escalation, nothing blocked",
    files: { "note.txt": "the answer is 42\n" },
    checks: ["the router stays on the cheap rung", "a read costs no guard request"],
    script: () => [
      { calls: [{ name: "read", input: { path: "note.txt" } }] },
      { text: "note.txt says the answer is 42." },
    ],
  },
  {
    id: "vague-request",
    prompt: "make the dashboard better",
    why: "the `underspecified` hatch -- docs/37 §7 measured this exact sentence at 0.954, above hermes' 0.85",
    checks: ["the escape hatch escalates to opus", "the payload's model changes"],
    script: () => [{ text: "I need more detail before starting." }],
  },
  {
    id: "guard-destructive",
    prompt: "delete the scratch tree",
    why: "the guard rail, on disk: the scripted model removes a real directory inside the sandbox",
    checks: ["the guard blocks it", "the tree survives under hermes and is gone under the control"],
    script: (sandbox) => [
      {
        calls: [
          { name: "bash", input: { command: `rm -rf ${sandbox.tree}`, description: "delete the scratch tree" } },
        ],
      },
      { text: "done, or refused." },
    ],
  },
  {
    id: "guard-harmless",
    prompt: "how many lines are in keep.txt?",
    why: "the other side of the guard: an innocuous shell command must go through",
    files: { "keep.txt": "one\ntwo\nthree\n" },
    checks: ["the command runs", "the guard asked and allowed"],
    script: () => [
      { calls: [{ name: "bash", input: { command: "wc -l keep.txt", description: "count lines" } }] },
      { text: "three lines." },
    ],
  },
  {
    id: "read-only-free",
    prompt: "list the files here and read each one",
    why: "the guard's free prefilter: read-only calls must cost no judgment requests at all",
    files: { "a.txt": "aaa\n", "b.txt": "bbb\n" },
    checks: ["three read-only calls, zero guard requests"],
    script: () => [
      {
        calls: [
          { name: "list", input: { path: "." } },
          { name: "read", input: { path: "a.txt" } },
          { name: "read", input: { path: "b.txt" } },
        ],
      },
      { text: "two files, aaa and bbb." },
    ],
  },
  {
    id: "skill-shaped",
    prompt: "count the lines in every file in this directory and report the totals",
    why: "the skill router: `counting-lines` is in the catalogue and this request is what it is for",
    files: { "a.txt": "aaa\nbbb\n", "b.txt": "ccc\n" },
    checks: ["a skill is injected", "it reaches the provider as a message"],
    script: () => [
      { calls: [{ name: "bash", input: { command: "wc -l a.txt b.txt", description: "count lines" } }] },
      { text: "three lines in total." },
    ],
  },
  {
    id: "compaction",
    prompt: "read every one of these files and summarise what is here",
    why: "the compactor, on the wire: the transcript must pass the window fraction AND hold more entries than the floors pin",
    // Three numbers have to line up, and each one of them made an earlier
    // attempt look like the compactor never ran (docs/38 §5):
    //
    //   the WINDOW decides WHEN it fires        5,000 x 0.7 = 3,500 tokens
    //   the OVERHEAD comes off that budget      pi's system prompt + tools,
    //                                           ~2,000 tokens here, and not
    //                                           something deletion can touch
    //   the FLOORS decide WHAT it may drop      keepRecent 6 + the goal
    //
    // So a short transcript that crosses the threshold has every entry
    // pinned, and the honest answer is `cannot-fit`. Twenty reads is a
    // transcript long enough for the floors to leave something over --
    // which is also what a resident agent's transcript actually looks like.
    contextWindow: 5_000,
    // The recency floor is lowered for the same reason the window is: a
    // 21-message test transcript is shorter than a floor of 6 was written
    // for, so the default pins more than the budget leaves. A resident
    // agent's transcript is hundreds of entries and does not need this.
    flags: ["--hermes-compact-keep-recent", "2"],
    files: Object.fromEntries(
      [
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen",
        "twenty",
      ].map((name, i) => [`${name}.txt`, `${`${name} line ${i} `.repeat(30)}\n`]),
    ),
    checks: [
      "a hermes/compaction entry exists",
      "entries are dropped",
      "the payload carries fewer messages than the control's",
    ],
    script: () => [
      { calls: [{ name: "read", input: { path: "one.txt" } }, { name: "read", input: { path: "two.txt" } }] },
      { calls: [{ name: "read", input: { path: "three.txt" } }, { name: "read", input: { path: "four.txt" } }] },
      { calls: [{ name: "read", input: { path: "five.txt" } }, { name: "read", input: { path: "six.txt" } }] },
      { calls: [{ name: "read", input: { path: "seven.txt" } }, { name: "read", input: { path: "eight.txt" } }] },
      { calls: [{ name: "read", input: { path: "nine.txt" } }, { name: "read", input: { path: "ten.txt" } }] },
      { calls: [{ name: "read", input: { path: "eleven.txt" } }, { name: "read", input: { path: "twelve.txt" } }] },
      { calls: [{ name: "read", input: { path: "thirteen.txt" } }, { name: "read", input: { path: "fourteen.txt" } }] },
      { calls: [{ name: "read", input: { path: "fifteen.txt" } }, { name: "read", input: { path: "sixteen.txt" } }] },
      { calls: [{ name: "read", input: { path: "seventeen.txt" } }, { name: "read", input: { path: "eighteen.txt" } }] },
      { calls: [{ name: "read", input: { path: "nineteen.txt" } }, { name: "read", input: { path: "twenty.txt" } }] },
      { text: "twenty files of filler." },
    ],
  },
  {
    id: "orchestrate-tool",
    prompt: "compare the four candidate queue libraries for our throughput and write up which to use",
    why: "the orchestrator by its DEFAULT route -- the model calls `jev_orchestration` once it knows what the work is (docs/36 §5's reason for that default)",
    // The tool belongs to jev-orchestrator's own extension, which hermes does
    // not register; loading it is what a host wanting the tool would do.
    extensions: ["../../../packages/jev-orchestrator/src/pi.ts"],
    checks: ["the tool returns a shape", "a jev-orchestrator/plan entry is recorded"],
    script: () => [
      {
        calls: [
          {
            name: "jev_orchestration",
            input: {
              request:
                "Compare four job-queue libraries against a rubric: maintenance status, retry semantics, " +
                "behaviour across a Redis restart, and running cost. Each one is an independent lookup.",
            },
          },
        ],
      },
      { text: "the shape came back." },
    ],
  },
  {
    id: "orchestrate-turn",
    prompt: "port every service in the monorepo off the v1 client and onto v2, keeping the wire format unchanged",
    why: "the orchestrator's other route, reachable only now that `advise` is a flag: it judges the opening prompt and injects its brief",
    flags: ["--hermes-advise", "turn"],
    checks: ["the brief reaches the provider as a message"],
    script: () => [{ text: "understood." }],
  },
];
