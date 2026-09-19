/**
 * The transcript model, the structural constraints, and the free baselines.
 *
 * The premise of this package is a constraint, not a preference: JEV CANNOT
 * GENERATE TEXT. It answers questions about a state; it does not write. So
 * compaction driven by Jev is necessarily SELECTION -- keep these entries,
 * drop those -- and never summarisation.
 *
 * That turns out to be the better half of the trade, for a reason that has
 * nothing to do with what Jev can do:
 *
 *   A deletion is verifiable. You can say exactly what is gone, and a test
 *   can assert that a named fact survived.
 *   A summary is not. It can quietly invent, drop a qualifier, or merge two
 *   facts into a false one, and the only way to notice is to still have the
 *   original -- which is what was just thrown away.
 *
 * `tamaratran/fast-jev-compaction` states the same rule ("never rewrite, only
 * delete") and this package follows it.
 *
 * WHAT JUDGMENT IS NOT ALLOWED TO DECIDE. Three constraints below are
 * structural and are enforced in code, above any score:
 *
 *   1. Tool-call pairing. Dropping an assistant message that made a tool call
 *      while keeping its result -- or the reverse -- produces a conversation
 *      most providers reject outright. This is not a quality question, it is
 *      a validity one, so `pinned` computes it and the policy cannot override
 *      it.
 *   2. The goal survives. The first user message is the task. Losing it is
 *      not recoverable from anything left behind.
 *   3. A recency floor. The last few turns are the working set; a gate that
 *      can delete what just happened will eventually delete the thing the
 *      next step needed, and no score is worth that risk.
 */

/** One unit of transcript. Structural, host-independent. */
export interface Entry {
  /** Stable identity within one transcript. */
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  /** Flat text for digesting and sizing. Images and blobs are not counted. */
  text: string;
  /** Tool calls this entry MAKES, by call id. Assistant entries only. */
  calls?: string[];
  /** The tool call this entry ANSWERS. Tool entries only. */
  answers?: string;
  /** A name for the audit line: the tool, or the message kind. */
  label?: string;
}

/**
 * Tokens, estimated from characters.
 *
 * docs/00: the token count is the server's to compute and is not available
 * client-side. Four characters per token is the usual English approximation
 * and it is wrong in both directions -- code and JSON run denser, prose
 * thinner. It is used only to decide how much to delete, where being 20% off
 * costs one more round of deletion rather than a wrong answer, and never to
 * decide whether a request fits (`jev-core`'s budget is in bytes for exactly
 * that reason).
 */
export function tokensOf(entry: Entry): number {
  return Math.ceil(entry.text.length / 4);
}

export function totalTokens(entries: readonly Entry[]): number {
  return entries.reduce((sum, e) => sum + tokensOf(e), 0);
}

export interface Floors {
  /** Entries at the end that are never dropped. */
  keepRecent: number;
  /** Keep the first user message, whatever it scores. */
  keepGoal: boolean;
}

export const DEFAULT_FLOORS: Floors = { keepRecent: 6, keepGoal: true };

/**
 * Which entries cannot be dropped, whatever judgment says.
 *
 * Pairing is computed in BOTH directions. Keeping a tool result whose call is
 * gone is the obvious break; the reverse -- an assistant turn whose tool call
 * has no result -- is the one that looks harmless and is not, because a
 * provider that validates the transcript will reject it just as firmly.
 */
export function pinned(entries: readonly Entry[], floors: Floors = DEFAULT_FLOORS): Set<string> {
  const keep = new Set<string>();
  const n = entries.length;
  for (let i = Math.max(0, n - floors.keepRecent); i < n; i += 1) keep.add(entries[i].id);
  if (floors.keepGoal) {
    const goal = entries.find((e) => e.role === "user");
    if (goal) keep.add(goal.id);
  }
  return keep;
}

/**
 * Close a proposed deletion set under tool-call pairing.
 *
 * Returns the set actually safe to delete: a call and its result go together
 * or not at all. Deliberately expands ONLY by adding drops (never by rescuing
 * a drop into a keep) when both halves are droppable, and retracts when one
 * half is pinned -- so a pinned recent tool result protects the older
 * assistant turn that produced it.
 */
export function closePairs(entries: readonly Entry[], drop: ReadonlySet<string>, keep: ReadonlySet<string>): Set<string> {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const resultOf = new Map<string, Entry>();
  for (const e of entries) if (e.answers) resultOf.set(e.answers, e);
  const callerOf = new Map<string, Entry>();
  for (const e of entries) for (const c of e.calls ?? []) callerOf.set(c, e);

  const out = new Set(drop);
  // Iterate to a fixed point: retracting one entry can un-drop its partner,
  // which can un-drop a further one when an assistant turn made two calls.
  for (let round = 0; round < entries.length + 1; round += 1) {
    let changed = false;
    for (const id of [...out]) {
      const entry = byId.get(id);
      if (!entry) {
        out.delete(id);
        changed = true;
        continue;
      }
      if (keep.has(id)) {
        out.delete(id);
        changed = true;
        continue;
      }
      // An assistant turn is droppable only if every result it produced is
      // also being dropped.
      for (const call of entry.calls ?? []) {
        const result = resultOf.get(call);
        if (result && !out.has(result.id)) {
          out.delete(id);
          changed = true;
          break;
        }
      }
      if (!out.has(id)) continue;
      // A tool result is droppable only if its caller is also dropped -- a
      // result whose call is gone has nothing to attach to.
      if (entry.answers) {
        const caller = callerOf.get(entry.answers);
        if (caller && !out.has(caller.id)) {
          out.delete(id);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return out;
}

/** True when the surviving transcript is structurally sound. */
export function valid(entries: readonly Entry[]): { ok: boolean; why?: string } {
  const ids = new Set(entries.map((e) => e.id));
  void ids;
  const made = new Set<string>();
  for (const e of entries) for (const c of e.calls ?? []) made.add(c);
  const answered = new Set(entries.filter((e) => e.answers).map((e) => e.answers as string));
  for (const call of made) {
    if (!answered.has(call)) return { ok: false, why: `tool call ${call} has no result` };
  }
  for (const call of answered) {
    if (!made.has(call)) return { ok: false, why: `tool result for ${call} has no call` };
  }
  return { ok: true };
}

/**
 * The free baselines, measured before judgment is paid for.
 *
 * docs/33 §1's lesson, which was expensive to learn: measure what the free
 * features give you FIRST. There the metrics-only classifier already had the
 * answer; here a resident agent's transcript has obvious orderings that cost
 * nothing, and if one of them keeps the same facts as Jev's ranking then
 * Jev's ranking is not what is doing the work.
 *
 * `oldest` is what nearly every agent already does (drop from the front).
 * `largest` targets the tool results that actually fill a window -- one
 * 40,000-character file read outweighs fifty turns of conversation.
 * `stale` is LRU by mention: an entry whose file or command has not been
 * referred to since is a candidate.
 * `overlap` scores each entry by how much of the GOAL's vocabulary it
 * contains, and drops the entries that share least with the task.
 *
 * `overlap` WAS ADDED AFTER MEASURING, and it is the whole reason docs/39
 * exists. The first three are the orderings that occurred to me when this
 * package was written, and on docs/39's corpus they keep 11-78% of the facts
 * a continuation needs, against judgment's 96-100% -- a gap so large it was
 * more likely to be a broken comparison than a real result. It was neither:
 * the three baselines are simply the wrong baselines. What judgment was
 * mostly doing was separating THE TASK'S OWN WORK from the exploration
 * around it (AUC 0.49-0.98 per transcript), and a word count against the
 * goal does that for free. It keeps 67-100%, closing most of the gap the
 * other three left, and it does so while leaving MORE tokens behind.
 *
 * So the honest reading of this package is: `overlap` is the baseline that
 * matters, judgment still beats it, and the margin is worth paying for only
 * where the budget is tight: 96% against 78% at a quarter of the window, a
 * tie at four fifths (docs/39 §4, which matches the two for content first --
 * different orders overshoot the budget differently and judgment overshoots
 * least, so the raw numbers in §3 flatter it).
 */
export type Baseline = "oldest" | "largest" | "stale" | "overlap";

/**
 * Words worth matching on: three characters or more, so `a`/`of`/`is` drop out.
 *
 * DELIBERATELY THE SIMPLEST THING, because two attempts to improve it both
 * made it worse. docs/39 §5.1 measured four variants on the same corpus:
 *
 *   3+ chars, as here       100%  89%  89%  67%     <- shipped
 *   3+ chars, stoplist      100%  89%  67%  56%
 *   5+ chars                 89%  78%  67%  56%
 *   7+ chars                 89%  78%  56%  33%
 *
 * A stoplist for the verbs every instruction contains ("tell me which...")
 * looked obviously right and cost 22 points at the tightest budget: the
 * common words are shared by every entry, so they add a near-constant term
 * that moves no order, while the stoplist also removed words that did
 * separate. Requiring longer words loses the short identifiers -- `pi`,
 * `wc`, `at` -- that a coding transcript turns on.
 *
 * Being the first thing anyone would write also matters for what it is FOR.
 * A free baseline tuned on the corpus it is then compared against is not a
 * baseline any more, and a version chosen for simplicity keeps the
 * comparison honest in the direction that matters: against judgment.
 */
function vocabulary(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []);
}

export function rankBy(baseline: Baseline, entries: readonly Entry[]): Entry[] {
  const order = [...entries];
  if (baseline === "oldest") return order;
  if (baseline === "largest") return order.sort((a, b) => tokensOf(b) - tokensOf(a));
  if (baseline === "overlap") {
    const goal = vocabulary(entries.find((e) => e.role === "user")?.text ?? "");
    // No goal text means no signal, so fall back rather than return an
    // arbitrary order that a caller would read as a decision.
    if (goal.size === 0) return rankBy("largest", entries);
    const share = new Map<string, number>();
    for (const e of entries) {
      const words = vocabulary(e.text);
      let hits = 0;
      for (const g of goal) if (words.has(g)) hits += 1;
      share.set(e.id, hits / goal.size);
    }
    // Least shared with the task first: that is the entry least likely to be
    // about the work still in progress.
    return order.sort((a, b) => (share.get(a.id) ?? 0) - (share.get(b.id) ?? 0));
  }
  // `stale`: how recently anything else referred to this entry's label.
  const lastMention = new Map<string, number>();
  for (const [i, e] of entries.entries()) {
    for (const other of entries) {
      if (other.label && e.text.includes(other.label)) lastMention.set(other.id, i);
    }
  }
  return order.sort((a, b) => (lastMention.get(a.id) ?? -1) - (lastMention.get(b.id) ?? -1));
}

/**
 * Drop in the given order until the transcript fits, respecting the floors
 * and closing under pairing. Shared by the baselines and by the Jev policy,
 * so the only difference between them is the ORDER -- which is the thing
 * being measured.
 */
export function dropUntilFits(
  entries: readonly Entry[],
  order: readonly Entry[],
  budgetTokens: number,
  floors: Floors = DEFAULT_FLOORS,
): { keep: Entry[]; dropped: Entry[] } {
  const keep = pinned(entries, floors);
  const proposed = new Set<string>();
  let size = totalTokens(entries);
  for (const candidate of order) {
    if (size <= budgetTokens) break;
    if (keep.has(candidate.id) || proposed.has(candidate.id)) continue;
    proposed.add(candidate.id);
    // Size is recomputed from the CLOSED set, not from the proposal: a drop
    // that pairing retracts frees nothing, and counting it would stop
    // deleting too early and leave the transcript over budget.
    const closed = closePairs(entries, proposed, keep);
    size = totalTokens(entries.filter((e) => !closed.has(e.id)));
  }
  const closed = closePairs(entries, proposed, keep);
  return {
    keep: entries.filter((e) => !closed.has(e.id)),
    dropped: entries.filter((e) => closed.has(e.id)),
  };
}
