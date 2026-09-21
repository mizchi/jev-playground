/**
 * A pi extension whose only job is to register the stub as a provider.
 *
 * Separate from the hermes extension on purpose: the thing under test should
 * not also be the thing that arranges the test. `PI_STUB_URL` is read from the
 * environment so `run.ts` can point it at whatever port the stub took.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function stubProvider(pi: ExtensionAPI): void {
  const baseUrl = process.env.PI_STUB_URL;
  if (!baseUrl) return;
  /**
   * The context window, shrinkable per scenario.
   *
   * `jev-compact` fires when `getContextUsage().tokens` passes
   * `contextWindow * startAt`, so with a real 200,000-token window a scenario
   * would have to generate ~140,000 tokens of transcript to reach the code
   * path. Declaring a small window is the same threshold from the other side,
   * it exercises the identical branch, and it makes the run take seconds --
   * a model with a small context is a real thing to configure, not a mock.
   */
  const contextWindow = Number.parseInt(process.env.PI_STUB_CONTEXT ?? "200000", 10);
  pi.registerProvider("stub", {
    name: "stub",
    baseUrl,
    apiKey: "stub-key",
    api: "anthropic-messages",
    // The two rungs jev-hermes routes between, so `pi.setModel` has somewhere
    // real to go and an escalation is visible in the payload's `model`.
    models: [
      {
        id: "claude-sonnet-5",
        name: "sonnet (stub)",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: 8192,
      },
      {
        id: "claude-opus-5",
        name: "opus (stub)",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: 8192,
      },
    ],
  });
}
