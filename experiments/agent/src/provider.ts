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
        contextWindow: 200000,
        maxTokens: 8192,
      },
      {
        id: "claude-opus-5",
        name: "opus (stub)",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
  });
}
