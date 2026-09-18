/**
 * A local endpoint that speaks the Anthropic Messages API and returns a script.
 *
 * This is what makes "does the agent actually run" answerable in an
 * environment with no model credentials. Pi's `registerProvider` takes a
 * `baseUrl`, so a server on 127.0.0.1 is indistinguishable to it from a real
 * provider: pi assembles its own request, runs its own tool loop, fires its
 * own events, and the hermes extension sees all of it. Only the token
 * generation is fake.
 *
 * Two properties make it a measuring instrument rather than a mock:
 *
 *   IT RECORDS WHAT PI SENT. Every request body is kept, so what reached the
 *   wire is checkable. That is the only way to verify the components end to
 *   end -- an escalation either shows up as a different `model` in the
 *   payload, and a deletion either shows up as fewer messages, or it did not
 *   happen.
 *   IT IS SCRIPTED, NOT RANDOM. The model's behaviour is fixed per turn, so a
 *   difference between the two arms is the extension's doing and nothing else.
 */
import { createServer, type Server } from "node:http";

/** What the fake model does on one call. */
export interface Step {
  text?: string;
  calls?: { name: string; input: Record<string, unknown> }[];
}

export interface Recorded {
  at: number;
  messages: { role: string; content: unknown }[];
  system?: unknown;
  tools?: string[];
  model?: string;
  bytes: number;
}

export interface Stub {
  url: string;
  requests: Recorded[];
  close: () => Promise<void>;
}

function sse(events: unknown[]): string {
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

/** One scripted assistant message as an Anthropic SSE stream. */
function streamFor(step: Step, model: string): string {
  const events: unknown[] = [
    {
      type: "message_start",
      message: {
        id: `msg_${Math.random().toString(36).slice(2)}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    },
  ];
  let index = 0;
  if (step.text) {
    events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
    events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: step.text } });
    events.push({ type: "content_block_stop", index });
    index += 1;
  }
  for (const call of step.calls ?? []) {
    const id = `toolu_${Math.random().toString(36).slice(2)}`;
    events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id, name: call.name, input: {} } });
    events.push({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
    });
    events.push({ type: "content_block_stop", index });
    index += 1;
  }
  events.push({
    type: "message_delta",
    delta: { stop_reason: (step.calls?.length ?? 0) > 0 ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: 10 },
  });
  events.push({ type: "message_stop" });
  return sse(events);
}

export async function start(script: Step[]): Promise<Stub> {
  const requests: Recorded[] = [];
  let step = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: {
        messages?: { role: string; content: unknown }[];
        system?: unknown;
        tools?: { name: string }[];
        model?: string;
      } = {};
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        /* a non-JSON probe; record it as empty */
      }
      requests.push({
        at: Date.now(),
        messages: body.messages ?? [],
        system: body.system,
        tools: body.tools?.map((t) => t.name),
        model: body.model,
        bytes: raw.length,
      });
      const current = script[Math.min(step, script.length - 1)] ?? { text: "done" };
      step += 1;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.end(streamFor(current, body.model ?? "stub"));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
