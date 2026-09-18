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
];
