/**
 * The free baseline: keywords.
 *
 * The repo's standing rule is that the judgment has to beat what rules can
 * do (docs/07, docs/23 §5, docs/27 §3, docs/29 §1). Here a rule is plausible
 * enough to be worth writing: the skill's own trigger list is keywords
 * ("multi-agent, orchestration, fan-out, worktree, blackboard, verifier,
 * AgentTask"), and each topology row has words that give it away.
 *
 * It is also the baseline that should lose on the traps, because every trap
 * in the skill's "Common mistakes" table is a request that USES the words
 * ("three agents", "team of five", "worktrees") while being a stay-single.
 */
import { PATTERNS, type Pattern, type Scenario } from "./scenarios.js";

/** Words that point at each row of the skill's table. */
const CUES: Record<Pattern, string[]> = {
  sequential: ["then", "pipeline", "each step", "gated", "in order", "stage"],
  fanout: ["parallel", "independent", "each one", "candidate", "in parallel", "at the same time", "merge"],
  supervisor: ["nobody has scoped", "no idea", "open-ended", "map", "decide what to look at", "re-planning", "replan"],
  handoff: ["hand", "route", "routed", "specialist", "answers the customer", "ownership", "passes"],
  blackboard: ["asynchronous", "asynchronously", "timezone", "backlog", "board", "progress file", "survive restarts"],
  debate: ["vote", "argue", "privately", "no right answer", "defensible", "second opinion", "critique"],
  dynamic_dag: ["varies", "cannot tell which", "not visible", "per ticket", "one minute or one day", "depending on what"],
  evolution: ["every week", "same shape", "repeats", "80 times", "500 documents", "variations", "search"],
};

/** Words that say "this is going to be more than one worker". */
const MULTI_CUES = [
  "agents", "agent", "team of", "parallel", "in parallel", "workers", "worker",
  "worktree", "worktrees", "three ", "four ", "five ", "six ", "several",
  "separately", "independent", "asynchronously", "vote",
];

/** Words that say "small". The gate's condition 4 in its crudest form. */
const SMALL_CUES = [
  "one file", "fifteen lines", "one function", "one-line", "a minute", "ten seconds",
  "under a minute", "trivial", "typo", "one command", "60-line", "30-line", "one field",
];

export interface RuleVerdict {
  multi: boolean;
  topology: Pattern | "single";
  /** The cues that fired, for reading. */
  hits: string[];
}

export function ruleVerdict(scenario: Scenario): RuleVerdict {
  const text = scenario.text.toLowerCase();
  const hits: string[] = [];
  const multiHits = MULTI_CUES.filter((c) => text.includes(c));
  const smallHits = SMALL_CUES.filter((c) => text.includes(c));
  hits.push(...multiHits.slice(0, 3), ...smallHits.slice(0, 2));
  const multi = multiHits.length > 0 && smallHits.length === 0;
  let best: Pattern | "single" = "single";
  let bestScore = 0;
  for (const p of PATTERNS) {
    const score = CUES[p].filter((c) => text.includes(c)).length;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return { multi, topology: multi ? best : "single", hits };
}
