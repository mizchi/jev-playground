/**
 * The Pi extension. The ONLY file in this package that imports from Pi.
 *
 * Pi has two places a compactor can sit, and they do different things:
 *
 *   `context`                 fires before every LLM call and may REPLACE the
 *                             message list. Returning a subset is deletion,
 *                             which is what this package does.
 *   `session_before_compact`  fires when Pi decides to compact, and may
 *                             cancel. Pi's own compaction SUMMARISES with the
 *                             LLM, so the two are alternatives, not layers.
 *
 * Both are used, in that order, and the claim being tested is that the first
 * makes the second unnecessary: if deleting the spent entries gets the
 * context back under the threshold, the summarising call never happens. That
 * is the saving a resident agent is actually after -- a summarisation is a
 * full-price LLM call over the whole transcript, and a deletion is one
 * $0.042/MTok request over digests.
 *
 * TWO THINGS THIS FILE MUST NOT DO, both of which would be easy:
 *
 *   Ask on every call. `context` fires before EVERY LLM call, including the
 *   short ones in the middle of a tool loop. The gate is a usage threshold
 *   plus a cache keyed on the message count, so a decision is reused until
 *   the transcript actually changes.
 *
 *   Delete from the stored session. `context` shapes what is SENT; the
 *   session on disk keeps everything. That distinction is what makes a wrong
 *   deletion recoverable -- `/jev-compact restore` puts it back, because
 *   nothing was ever destroyed. It is also why the entry ids here are
 *   positions in the current message list and are not persisted anywhere.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMPACT_CONFIG, compact, compactBy, type CompactConfig, type CompactResult } from "./compact.js";
import { totalTokens, type Baseline } from "./entries.js";
import { entriesOf, type MessageLike } from "./messages.js";

const STATUS = "jev-compact";
const LOG_ENTRY = "jev-compact/deletion";

export interface PiCompactSettings extends Partial<CompactConfig> {
  enabled?: boolean;
  /** Start deleting at this fraction of the context window. */
  startAt?: number;
  /** Use a free ranking instead of judgment. For measuring what judgment adds. */
  baseline?: Baseline | null;
}

export default function jevCompact(pi: ExtensionAPI): void {
  let settings: PiCompactSettings = {};
  /** The last deletion, so `context` can reuse it and `restore` can undo it. */
  let last: { at: number; keep: Set<string>; result: CompactResult } | null = null;
  let saved = 0;

  const on = (): boolean => settings.enabled !== false;
  const startAt = (): number => settings.startAt ?? 0.7;

  function show(ctx: ExtensionContext): void {
    if (!on()) {
      ctx.ui.setStatus(STATUS, undefined);
      return;
    }
    ctx.ui.setStatus(
      STATUS,
      last && last.result.dropped.length > 0
        ? `compact -${last.result.dropped.length} entries (${last.result.tokensBefore}->${last.result.tokensAfter})` +
            (saved > 0 ? `, ${saved} summarisation${saved === 1 ? "" : "s"} avoided` : "")
        : "compact idle",
    );
  }

  /** Is the context full enough to act on? */
  function pressured(ctx: ExtensionContext): { over: boolean; budget: number } {
    let usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
    try {
      usage = ctx.getContextUsage();
    } catch {
      usage = undefined;
    }
    const window = usage?.contextWindow ?? 0;
    const budget = settings.budgetTokens ?? (window > 0 ? Math.floor(window * startAt()) : DEFAULT_COMPACT_CONFIG.budgetTokens);
    // `tokens` is null right after a compaction, before the next response.
    // Unknown pressure is treated as no pressure: acting on a guess here
    // would delete on the strength of a number Pi declined to give.
    if (usage?.tokens == null) return { over: false, budget };
    return { over: usage.tokens > budget, budget };
  }

  pi.on("session_start", async (_event, ctx) => {
    last = null;
    saved = 0;
    show(ctx);
  });

  pi.on("context", async (event, ctx) => {
    if (!on()) return {};
    const messages = event.messages as unknown as MessageLike[];
    const entries = entriesOf(messages);
    const { over, budget } = pressured(ctx);

    // Reuse the last decision while the transcript has not grown. `context`
    // fires on every LLM call, including every step of a tool loop, and
    // asking each time would cost more requests than the whole rest of this
    // agent put together.
    if (last && last.at === messages.length) {
      return { messages: messages.filter((_, i) => last?.keep.has(String(i))) as typeof event.messages };
    }
    if (!over) return {};

    const config: Partial<CompactConfig> = { ...settings, budgetTokens: budget };
    const result = settings.baseline
      ? compactBy(settings.baseline, entries, config)
      : await compact(
          entries,
          { goal: entries.find((e) => e.role === "user")?.text.slice(0, 2_000) ?? "(no stated goal)", cwd: ctx.cwd },
          { config },
        );

    if (result.dropped.length === 0) {
      // Say something only when the reason is actionable: `cannot-fit` means
      // the host's summariser is about to be needed and the operator may want
      // to know why deletion could not help.
      if (result.outcome === "cannot-fit") ctx.ui.notify(`jev-compact: ${result.reason}`, "warning");
      return {};
    }

    last = { at: messages.length, keep: new Set(result.keep.map((e) => e.id)), result };
    pi.appendEntry(LOG_ENTRY, {
      outcome: result.outcome,
      dropped: result.dropped.map((e) => ({ id: e.id, role: e.role, label: e.label, tokens: Math.ceil(e.text.length / 4) })),
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      // The ranking, so a recorded session can be re-read at other cutoffs
      // without asking again (docs/19 §4).
      ranked: result.ranked.map((r) => ({ id: r.entry.id, level: r.level, confidence: r.confidence })),
      nothingSpare: result.nothingSpare,
      reason: result.reason,
      ms: result.ms,
      at: Date.now(),
    });
    show(ctx);
    return { messages: messages.filter((_, i) => last?.keep.has(String(i))) as typeof event.messages };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!on()) return {};
    // Pi is about to summarise. If deletion has already brought the sent
    // context under the threshold, the summary is redundant -- and cancelling
    // it is the whole economic claim of this package, so it is counted.
    if (!last || last.result.dropped.length === 0) return {};
    const kept = totalTokens(last.result.keep);
    const { budget } = pressured(ctx);
    if (kept > budget) return {};
    // `manual` is the user typing /compact. They asked; do not cancel it.
    if (event.reason === "manual") return {};
    saved += 1;
    show(ctx);
    ctx.ui.notify(
      `jev-compact: ${last.result.dropped.length} deleted entries keep the context at ${kept} of ${budget}; skipping the summarisation`,
      "info",
    );
    return { cancel: true };
  });

  pi.registerCommand("jev-compact", {
    description: "Show, undo, or reconfigure Jev's deletion-based compaction",
    async handler(args, ctx) {
      const [sub, value] = String(args ?? "").trim().split(/\s+/);
      if (sub === "on" || sub === "off") {
        settings = { ...settings, enabled: sub === "on" };
        show(ctx);
        ctx.ui.notify(`jev-compact: ${sub}`, "info");
        return;
      }
      if (sub === "restore") {
        // Nothing was destroyed: `context` only shaped what was sent. This is
        // the property that makes deletion safer than summarisation, so it
        // gets a command rather than a footnote.
        last = null;
        show(ctx);
        ctx.ui.notify("jev-compact: the full transcript is sent again from the next call", "info");
        return;
      }
      if (sub === "baseline") {
        const b = value as Baseline;
        settings = { ...settings, baseline: ["oldest", "largest", "stale"].includes(b) ? b : null };
        ctx.ui.notify(`jev-compact: ranking by ${settings.baseline ?? "judgment"}`, "info");
        return;
      }
      const config = { ...DEFAULT_COMPACT_CONFIG, ...settings };
      const { budget, over } = pressured(ctx);
      ctx.ui.notify(
        [
          `jev-compact: ${on() ? "on" : "off"}, ranking by ${settings.baseline ?? "judgment"}`,
          `budget ${budget} tokens, currently ${over ? "over" : "under"}`,
          `floors: the goal${config.keepGoal ? "" : " (off)"}, the last ${config.keepRecent} entries, and tool-call pairing`,
          `drop at or below level ${config.dropAt} of 3; on failure, ${config.onError}`,
          last
            ? `last: ${last.result.reason} (${last.result.ms} ms)` +
              (last.result.usage ? `, ${last.result.usage.input} input tokens` : "")
            : "nothing deleted yet",
          saved > 0 ? `${saved} summarisation${saved === 1 ? "" : "s"} avoided` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        "info",
      );
    },
  });
}
