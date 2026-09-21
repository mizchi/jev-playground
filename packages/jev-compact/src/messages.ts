/**
 * Mapping a host's message list onto entries. No Pi import, on purpose.
 *
 * This lives outside `pi.ts` because two hosts need it -- this package's own
 * extension and `jev-hermes`, which assembles all five components into one
 * extension -- and importing `pi.ts` to get it would drag in a module whose
 * side effect is registering handlers.
 *
 * The shape is declared structurally rather than imported. Pi's `AgentMessage`
 * lives in `@earendil-works/pi-agent-core`, which is not a dependency here:
 * the extension is loaded by a host that already has it. The fields named are
 * the ones `@earendil-works/pi-ai`'s `UserMessage`, `AssistantMessage` and
 * `ToolResultMessage` actually carry, and `test.ts` builds those three shapes
 * by hand and asserts the pairing survives -- because a wrong field name here
 * would silently disable pairing and produce a transcript a provider rejects.
 */
import type { Entry } from "./entries.js";

export interface MessageLike {
  role: string;
  content: unknown;
  toolCallId?: string;
  toolName?: string;
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as {
    type?: string;
    text?: string;
    thinking?: string;
    name?: string;
    arguments?: unknown;
  }[]) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    // Thinking counts as text rather than vanishing: an assistant turn that
    // is "empty" only because thinking was ignored would look free to drop
    // and would not be.
    else if (block?.type === "thinking" && typeof block.thinking === "string") parts.push(block.thinking);
    else if (block?.type === "toolCall") parts.push(`${block.name ?? "tool"}(${JSON.stringify(block.arguments ?? {})})`);
    else if (block?.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

export function callsOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return (content as { type?: string; id?: string }[])
    .filter((b) => b?.type === "toolCall" && typeof b.id === "string")
    .map((b) => b.id as string);
}

/**
 * Map the message list onto entries. The INDEX is the id.
 *
 * Positions, not persisted identities, because what is being decided is which
 * of these messages to send on this call. Nothing is written back to the
 * session, so an id only has to survive as long as the decision does.
 */
export function entriesOf(messages: readonly MessageLike[]): Entry[] {
  return messages.map((m, i) => {
    const role =
      m.role === "toolResult" ? "tool" : m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user";
    const calls = callsOf(m.content);
    const entry: Entry = {
      id: String(i),
      role: role as Entry["role"],
      text: textOf(m.content),
      label: m.toolName ?? role,
    };
    if (calls.length > 0) entry.calls = calls;
    if (typeof m.toolCallId === "string") entry.answers = m.toolCallId;
    return entry;
  });
}
