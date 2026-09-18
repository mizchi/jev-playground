/**
 * The turns the combine measurement is run over.
 *
 * Chosen to differ along the axes the three components are supposed to read,
 * because docs/36 §5.2 is the cautionary tale: there, 21 prompts were one
 * identical string, `plain`'s across-task spread came in BELOW its draw
 * noise, and no arm's accuracy meant anything. A comparison of two ways of
 * ASKING needs requests whose answers differ, or every row reads as agreement.
 *
 * No labels. This experiment is not about whether the answers are right -- it
 * is about whether asking three components' questions in one request gives
 * the same answers as asking them separately. The comparison is between two
 * measurements of the same thing, so it needs no ground truth, which is also
 * why it can run over invented requests without inventing a label.
 */

export interface Turn {
  id: string;
  /** What the user says. The only thing either way sees. */
  text: string;
  /** Why it is in the set: which axis it is meant to sit at an end of. */
  why: string;
}

export const TURNS: Turn[] = [
  {
    id: "trivial",
    text: "rename the variable `res` to `response` in src/handler.ts",
    why: "cheapest tier, lowest effort, plainly one agent",
  },
  {
    id: "stale-token",
    text: "the auth middleware rejects valid tokens after an hour",
    why: "a symptom without a cause: ordinary difficulty, some deliberation",
  },
  {
    id: "vague",
    text: "make the dashboard better",
    why: "the underspecified hatch should fire and the tier should be pulled up",
  },
  {
    id: "sweeping",
    text: "migrate every service in the monorepo off the v1 client and onto v2, keeping the wire format unchanged",
    why: "the oversized hatch, and the orchestration gate's clearest yes",
  },
  {
    id: "subtle",
    text: "two of the integration tests pass alone and fail together, and only on CI",
    why: "the dearest tier's own description: a cause that is not where the symptom is",
  },
  {
    id: "parallel-research",
    text: "compare the four candidate queue libraries for our throughput and write up which to use",
    why: "independent parts, different information: the fanout pattern's own row",
  },
  {
    id: "pipeline",
    text: "read the OpenAPI spec, generate the client, then wire it into the settings page",
    why: "a transform pipeline: the sequential pattern's own row",
  },
  {
    id: "question",
    text: "what did that ENOTFOUND in the last test run mean?",
    why: "not work at all -- most of a resident agent's traffic, and it must stay cheap",
  },
];
