/**
 * WHAT ACTUALLY HAPPENS WHEN BOTH PROFILES LOAD. Fired, not read off a table.
 *
 *   tsx collide.ts          all three arms
 *   tsx collide.ts both     one of them
 *
 * `pi/README.md` listed this as its own unmeasured limit: it said loading
 * `components` and `resident` together puts two permission gates on one tool
 * call, and admitted that was **read off the seam table rather than
 * observed**. This file observes it, and the observation does not match the
 * table -- see `SHORT-CIRCUIT` below. No API key, no network, no agent.
 *
 * THREE ARMS, THE SAME INPUTS. "Twice" is a comparison, so the single-profile
 * arms are the measurement and `both` only means something beside them:
 *
 *   components   the five separate extensions
 *   resident     jev-hermes alone
 *   both         what `pi install` lets you do by accident
 *
 * HOW IT IS FIRED. Pi's own `discoverAndLoadExtensions` loads the same entry
 * files `pi install` would, and Pi's own `ExtensionRunner` dispatches the
 * events: `emitToolCall`, `emitContext` and `emitBeforeAgentStart` are the
 * methods its agent loop calls. The fan-out being counted is Pi's, not a
 * model of Pi's.
 *
 * SHORT-CIRCUIT, WHICH IS WHY TWO TOOL CALLS ARE FIRED AND NOT ONE.
 * `emitToolCall` returns the moment a handler answers `{ block: true }`, so
 * the second gate never runs on a call the first one blocks. `emitContext`
 * and `emitBeforeAgentStart` do not short-circuit -- every handler runs, and
 * `context` even chains, each handler seeing what the previous one left. So
 * the collision is not uniform across the seams, and both branches of the
 * tool-call seam get their own fire: one answer set that lands in the gate's
 * `ask` band, one that lands in `deny`.
 *
 * WHAT IS MINE, AND IT DECIDES HOW TO READ THE VERDICTS. `globalThis.fetch`
 * is replaced by a counter that answers from the table in `ANSWERS` below.
 * So:
 *
 *   MEASURED   how many handlers run, how many requests they send, how many
 *              confirmations one command shows a user, how many messages
 *              survive `context`, and what each component recorded.
 *   NOT        what Jev would answer about any of these commands. Every
 *              verdict here is a function of my canned numbers.
 *
 * The counts are the finding. The decisions are the stub's.
 */
import { ExtensionRunner, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { COMPONENTS, RESIDENT, type Component } from "./seams.js";

/** A command no prefilter waves through, so the battery actually runs. */
const COMMAND = "rm -rf /etc/nginx/sites-enabled";

/**
 * The two answer sets, named for the band of the shipped gate they aim at.
 *
 * `{ask: 0.5, deny: 1.5}` with `atomicRule`: `exfiltrates > 0.5`,
 * `obfuscated > 0.7` or `blast_radius >= 2.5` forces a deny outright, while
 * `destructive` with `irreversible` or `outside_project` is an ask. So `deny`
 * differs from `ask` in one predicate, `obfuscated`, and nothing else.
 */
const ANSWERS = {
  ask: {
    // The compactor's escape hatch. At the `noul` fallback of 0.9 it clears
    // `nothingSpareAt: 0.8` and vetoes every deletion before ranking starts,
    // which is why `context` first measured 12 -> 12 in all three arms.
    nothing_spare: 0.1,
    destructive: 0.9,
    irreversible: 0.9,
    outside_project: 0.9,
    exfiltrates: 0.1,
    obfuscated: 0.1,
    privileged: 0.1,
    affects_others: 0.1,
    blast_radius: 1.2,
    permission: 1.2,
  },
  deny: {
    nothing_spare: 0.1,
    destructive: 0.9,
    irreversible: 0.9,
    outside_project: 0.9,
    exfiltrates: 0.1,
    obfuscated: 0.9,
    privileged: 0.1,
    affects_others: 0.1,
    blast_radius: 1.2,
    permission: 1.2,
  },
} as const;

/**
 * The transcript, and a context usage CONSISTENT WITH IT.
 *
 * Both of those took a wrong answer out of this file. The first version
 * reported 190,000 tokens used while handing over a transcript of about
 * 4,000, and the two compactors failed on that inconsistency in two different
 * ways: hermes subtracts `usage.tokens - totalTokens(entries)` as untouchable
 * overhead, so its message budget went to zero and it recorded `cannot-fit`;
 * `jev-compact` does not subtract it, so it compared a 4,000-token transcript
 * against a 140,000-token budget, found it already small enough, and dropped
 * nothing without recording anything at all. Both were right about the
 * numbers they were given.
 *
 * So the usage is derived from the transcript instead: a window whose 70%
 * trigger sits BELOW what the messages weigh, plus a small overhead, which is
 * the shape a real over-budget session has.
 */
const ENTRIES = 24;
const CHARS_PER_ENTRY = 4_000;
/** `jev-compact` counts four bytes to a token. */
const TRANSCRIPT_TOKENS = Math.ceil((ENTRIES * CHARS_PER_ENTRY) / 4);
const USAGE = {
  tokens: TRANSCRIPT_TOKENS + 500,
  contextWindow: Math.floor(TRANSCRIPT_TOKENS / 2 / 0.7),
  percent: 95,
};

export interface Fired {
  requests: number;
  /** How many times a human was asked about ONE command. */
  confirms: number;
  blocked: boolean;
  reason: string | null;
}

export interface Observed {
  loaded: number;
  loadErrors: string[];
  /** Anything Pi warned about when both profiles were present. */
  diagnostics: string[];
  ask: Fired;
  deny: Fired;
  context: { requests: number; messagesIn: number; messagesOut: number };
  turn: { requests: number; asked: string[][] };
  /** Pi about to summarise. Cancelling it is the compactor's economic claim. */
  beforeCompact: { cancelled: boolean; notifies: number };
  /** Session-entry keys each component wrote, which is who decided what. */
  entries: string[];
  detail: { type: string; data?: unknown }[];
}

/** Records `confirm` and swallows the rest of the UI surface. */
function ui(confirms: string[], notifies: string[]): Record<string, unknown> {
  const nop = (): undefined => undefined;
  // A concrete object rather than a Proxy: Pi wraps the UI context by copying
  // its own properties, so a Proxy implementing only `get` arrives empty and
  // `ctx.ui.setStatus` is undefined inside the handler.
  return {
    confirm: async (title: string): Promise<boolean> => {
      confirms.push(title);
      return true;
    },
    select: async (): Promise<undefined> => undefined,
    input: async (): Promise<undefined> => undefined,
    editor: async (): Promise<undefined> => undefined,
    getEditorText: (): string => "",
    notify: (message: string): void => void notifies.push(message),
    onTerminalInput: () => nop,
    setStatus: nop,
    setWorkingMessage: nop,
    setWorkingVisible: nop,
    setWorkingIndicator: nop,
    setHiddenThinkingLabel: nop,
    setWidget: nop,
    setFooter: nop,
    setHeader: nop,
    setTitle: nop,
    custom: nop,
    pasteToEditor: nop,
    setEditorText: nop,
    addAutocompleteProvider: nop,
  };
}

/** `ExtensionActions`, with `appendEntry` recorded: that is who decided what. */
function actions(entries: string[], detail: { type: string; data?: unknown }[]): Record<string, unknown> {
  const nop = (): undefined => undefined;
  return {
    sendMessage: nop,
    sendUserMessage: nop,
    appendEntry: (customType: string, data?: unknown): void => {
      entries.push(customType);
      detail.push({ type: customType, data });
    },
    setSessionName: nop,
    getSessionName: (): undefined => undefined,
    setLabel: nop,
    getActiveTools: (): string[] => ["bash", "read", "edit", "write"],
    getAllTools: (): unknown[] => [],
    setActiveTools: nop,
    refreshTools: nop,
    getCommands: (): unknown[] => [],
    setModel: async (): Promise<boolean> => false,
    getThinkingLevel: (): string => "off",
    setThinkingLevel: nop,
  };
}

/** `ExtensionContextActions`. `getContextUsage` is what wakes the compactor. */
function contextActions(): Record<string, unknown> {
  const nop = (): undefined => undefined;
  return {
    getModel: (): undefined => undefined,
    getScopedModels: (): unknown[] => [],
    isIdle: (): boolean => true,
    isProjectTrusted: (): boolean => true,
    getSignal: (): undefined => undefined,
    abort: nop,
    hasPendingMessages: (): boolean => false,
    shutdown: nop,
    getContextUsage: (): typeof USAGE => USAGE,
    compact: nop,
    getSystemPrompt: (): string => "",
    getSystemPromptOptions: (): Record<string, unknown> => ({}),
  };
}

/**
 * A `fetch` that answers any battery from `ANSWERS`, counts the asking, and
 * keeps the question names.
 *
 * The names are the attribution: nothing else says WHICH component sent a
 * request. `permission` is the guard's, `tier` the model router's, `gate` the
 * orchestrator's, and hermes asks for several of them at once because that is
 * the whole point of it.
 */
function counting(
  band: { of: keyof typeof ANSWERS },
  seen: string[][],
): { fetch: typeof fetch; requests: () => number } {
  let requests = 0;
  const impl = async (_url: unknown, init?: { body?: string }): Promise<Response> => {
    requests += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      questions?: Record<string, { type?: string; criteria?: unknown }>;
    };
    const table = ANSWERS[band.of] as Record<string, number>;
    seen.push(Object.keys(body.questions ?? {}));
    const answers: Record<string, unknown> = {};
    for (const [name, q] of Object.entries(body.questions ?? {})) {
      const pinned = table[name];
      if (q.type === "score") {
        answers[name] = {
          type: "score",
          score: pinned ?? 1.2,
          confidence: 0.9,
          legend: {},
          probabilities: {},
        };
      } else if (q.type === "choice") {
        const first = Object.keys((q.criteria ?? {}) as Record<string, unknown>)[0] ?? "unknown";
        answers[name] = { type: "choice", choice: first, confidence: 0.9, probabilities: { [first]: 0.9 } };
      } else {
        answers[name] = { type: "noul", noul: pinned ?? 0.9 };
      }
    }
    return new Response(
      JSON.stringify({ model: "stub", answers, usage: { input_tokens: 700, output_tokens: 0 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { fetch: impl as unknown as typeof fetch, requests: () => requests };
}

/** The transcript handed to `context`. Long enough for a compactor to bite. */
function transcript(): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < ENTRIES; i += 1) {
    out.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `turn ${i}: ${"detail ".repeat(Math.ceil(CHARS_PER_ENTRY / 7))}` }],
    });
  }
  return out;
}

export interface Arm {
  name: string;
  what: string;
  components: readonly Component[];
}

export const ARMS: readonly Arm[] = [
  { name: "components", what: "the five separate extensions", components: COMPONENTS },
  { name: "resident", what: "jev-hermes alone", components: [RESIDENT] },
  { name: "both", what: "what `pi install` lets you do by accident", components: [...COMPONENTS, RESIDENT] },
] as const;

export async function run(arm: Arm): Promise<Observed> {
  const paths = arm.components.map((c) =>
    resolve(import.meta.dirname, c.name === RESIDENT.name ? "resident" : "components", "extensions", `${c.name}.ts`),
  );
  const band: { of: keyof typeof ANSWERS } = { of: "ask" };
  const seen: string[][] = [];
  const stub = counting(band, seen);
  const real = globalThis.fetch;
  // Patched before loading, because each component builds its client lazily
  // and `Jev` captures whichever `fetch` is global at construction time.
  globalThis.fetch = stub.fetch;
  // A key has to exist for `Jev` to construct at all. It never leaves the
  // process: the `fetch` above never reaches the network.
  const hadKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = hadKey ?? "stub-key-never-sent";
  try {
    const loaded = await discoverAndLoadExtensions(
      paths,
      import.meta.dirname,
      mkdtempSync(resolve(tmpdir(), "jev-collide-")),
    );
    const confirms: string[] = [];
    const notifies: string[] = [];
    const entries: string[] = [];
    const detail: { type: string; data?: unknown }[] = [];
    const runner = new ExtensionRunner(
      loaded.extensions,
      loaded.runtime,
      import.meta.dirname,
      new Proxy({}, { get: () => () => undefined }) as never,
      new Proxy({}, { get: () => () => undefined }) as never,
    );
    runner.bindCore(actions(entries, detail) as never, contextActions() as never);
    runner.setUIContext(ui(confirms, notifies) as never, "interactive" as never);

    const fire = async (of: keyof typeof ANSWERS): Promise<Fired> => {
      band.of = of;
      const before = stub.requests();
      const at = confirms.length;
      const out = (await runner.emitToolCall({
        type: "tool_call",
        toolCallId: `collide-${of}`,
        toolName: "bash",
        input: { command: COMMAND },
      } as never)) as { block?: boolean; reason?: string } | undefined;
      return {
        requests: stub.requests() - before,
        confirms: confirms.length - at,
        blocked: out?.block === true,
        reason: out?.reason ?? null,
      };
    };
    const ask = await fire("ask");
    const deny = await fire("deny");

    band.of = "ask";
    const before = stub.requests();
    const messages = transcript();
    const kept = (await runner.emitContext(messages as never)) as unknown[];
    const afterContext = stub.requests();
    // Three arguments, which is what the shipped runner takes -- its typings
    // show four. Passing the extra one silently feeds the system-prompt
    // options the system prompt itself.
    const turnFrom = seen.length;
    await runner.emitBeforeAgentStart("port the API to v2 and update every call site", undefined, {} as never);
    const afterTurn = stub.requests();

    /**
     * The fourth seam. `emit` returns on the first `{ cancel: true }` for a
     * `session_before_*` event, so this one short-circuits like `tool_call`
     * and unlike `context` -- and `notify` is how each compactor announces
     * the cancellation, so counting notifies counts the handlers that got
     * that far.
     */
    const notifiesBefore = notifies.length;
    const cancelled = (await runner.emit({
      type: "session_before_compact",
      preparation: { entries: [], tokens: USAGE.tokens },
      branchEntries: [],
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    } as never)) as { cancel?: boolean } | undefined;

    return {
      loaded: loaded.extensions.length,
      loadErrors: (loaded.errors ?? []).map((e: { path?: string; error?: string }) => `${e.path}: ${e.error}`),
      diagnostics: [
        ...runner.getCommandDiagnostics(),
        ...runner.getShortcutDiagnostics({} as never),
      ].map((d: { message?: string }) => String(d.message ?? JSON.stringify(d))),
      ask,
      deny,
      context: { requests: afterContext - before, messagesIn: messages.length, messagesOut: kept.length },
      turn: { requests: afterTurn - afterContext, asked: seen.slice(turnFrom) },
      beforeCompact: { cancelled: cancelled?.cancel === true, notifies: notifies.length - notifiesBefore },
      entries,
      detail,
    };
  } finally {
    globalThis.fetch = real;
    if (hadKey === undefined) delete process.env.TYPESAFE_API_KEY;
  }
}

async function main(): Promise<void> {
  const only = process.argv[2];
  const rows = new Map<string, Observed>();
  for (const arm of ARMS) {
    if (only !== undefined && arm.name !== only) continue;
    rows.set(arm.name, await run(arm));
  }
  console.log(`\n## One tool call, one context event, one turn -- \`${COMMAND}\`\n`);
  console.log(
    "| arm | extensions | ask: requests | **ask: confirmations** | deny: requests | deny: blocked | " +
      "context: requests | context: msgs | turn: requests | summary cancelled (notifies) |",
  );
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const [name, o] of rows) {
    console.log(
      `| \`${name}\` | ${o.loaded} | ${o.ask.requests} | **${o.ask.confirms}** | ${o.deny.requests} | ` +
        `${o.deny.blocked ? "yes" : "no"} | ${o.context.requests} | ${o.context.messagesIn} -> ` +
        `${o.context.messagesOut} | ${o.turn.requests} | ${o.beforeCompact.cancelled ? "yes" : "no"} (${o.beforeCompact.notifies}) |`,
    );
  }
  const c = rows.get("components");
  const r = rows.get("resident");
  const b = rows.get("both");
  if (c && r && b) {
    console.log(
      `\n**The ask band is where it doubles**: one command, **${b.ask.confirms} confirmations** against ` +
        `${c.ask.confirms} for \`components\` and ${r.ask.confirms} for \`resident\`.\n` +
        `**The deny band does not**: ${b.deny.requests} request against ${c.deny.requests} and ${r.deny.requests} -- ` +
        "`emitToolCall` returns on the first `{block: true}`, so the second gate never runs.\n" +
        `**The turn**: ${c.turn.requests} + ${r.turn.requests} separately, **${b.turn.requests} together**. ` +
        `**\`context\`**: ${c.context.messagesOut} messages survive under \`components\`, ` +
        `${r.context.messagesOut} under \`resident\`, **${b.context.messagesOut} under both**.`,
    );
    const sum = c.loaded + r.loaded;
    console.log(
      `\nPi loaded **${b.loaded}** extensions for \`both\` (${c.loaded} + ${r.loaded} = ${sum}), with ` +
        `**${b.loadErrors.length} load errors** and **${b.diagnostics.length} diagnostics**: ` +
        `${b.loaded === sum && b.diagnostics.length === 0 ? "no deduplication, and no warning of any kind" : "something was caught"}.`,
    );
    for (const d of b.diagnostics) console.log(`  diagnostic: ${d}`);
    console.log("\nWho recorded what, in order -- the short-circuit is visible here:\n");
    for (const [name, o] of rows) console.log(`  ${name.padEnd(11)} ${o.entries.join(" -> ") || "(nothing)"}`);
    console.log("\nWho asked at turn start, by the question names in each request:\n");
    for (const [name, o] of rows) {
      const shown = o.turn.asked.map((q) => `[${q.slice(0, 6).join(" ")}${q.length > 6 ? ` +${q.length - 6}` : ""}]`);
      console.log(`  ${name.padEnd(11)} ${shown.join(" ") || "(nothing asked)"}`);
    }
  }
  console.log("");
}

if (process.argv[1]?.endsWith("collide.ts")) await main();
