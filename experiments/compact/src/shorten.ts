/**
 * The summarisation arms: keep every entry and make each one shorter, rather
 * than keeping some entries whole and dropping the rest.
 *
 * WHAT IS AND IS NOT BEING COMPARED. There is no model here that can generate
 * text -- this container has no Anthropic, OpenAI or Google credential
 * (`pi auth check` says `credentials_not_configured`, and a bare POST to
 * api.anthropic.com returns 401) -- and Jev cannot write by construction. So
 * these are EXTRACTIVE summarisers: they select spans of the original bytes.
 *
 * That leaves the loud half of docs/37 §3's claim unmeasured. "A summary can
 * quietly invent" is about ABSTRACTIVE summarisation, and nothing here can
 * invent, because every byte in the output was in the input. What can be
 * measured is the other half, and it turns out to be the sharper one:
 *
 *   A DELETION IS EITHER THERE OR GONE. A SHORTENING CAN LEAVE A FRAGMENT
 *   THAT READS AS COMPLETE. Cut `661 docs/31-orchestration.md` after twelve
 *   characters and the transcript now contains `661 docs/31`, which is not a
 *   missing fact -- it is a plausible wrong one, and nothing downstream can
 *   tell that a number was severed.
 *
 * `report.ts` counts those separately (`mangled`), and deletion's count is
 * zero by construction rather than by assumption: a surviving entry survives
 * byte for byte.
 *
 * THE FLOORS ARE THE SAME AS DELETION'S. The goal and the recent tail are
 * never shortened, because they are never dropped either. Otherwise the
 * comparison would be about which floors each arm got.
 */
import { pinned, tokensOf, totalTokens, type Entry, type Floors } from "../../../packages/jev-compact/src/compact.js";

export type Shortener = "truncate" | "headtail" | "jev-shorten";

/** Cut `text` to about `keep` characters, on a character boundary. */
function cutTail(text: string, keep: number): string {
  if (keep >= text.length) return text;
  return text.slice(0, Math.max(0, keep));
}

/**
 * Cut to about `keep` characters, half from the head and half from the tail,
 * on LINE boundaries.
 *
 * This is the shape `jev-compact`'s own `digest` uses for its requests, and
 * the shape a careful engineer writes by hand: for a tool result the head says
 * what was attempted and the tail says how it ended. It is also the most
 * generous extractive summariser I could think of, which is the right
 * direction to be generous in -- I am the one with a stake in deletion.
 */
function cutHeadTail(text: string, keep: number): string {
  if (keep >= text.length) return text;
  const lines = text.split("\n");
  if (lines.length < 4) return cutTail(text, keep);
  const half = Math.max(1, Math.floor(keep / 2));
  const head: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > half) break;
    head.push(line);
    used += line.length + 1;
  }
  const tail: string[] = [];
  used = 0;
  for (let i = lines.length - 1; i >= head.length; i -= 1) {
    if (used + lines[i].length + 1 > half) break;
    tail.unshift(lines[i]);
    used += lines[i].length + 1;
  }
  if (head.length === 0 && tail.length === 0) return cutTail(text, keep);
  return [...head, `... ${lines.length - head.length - tail.length} lines cut ...`, ...tail].join("\n");
}

/**
 * Find the scale that brings the shortened transcript to the budget, then
 * SPEND WHAT IS LEFT OVER.
 *
 * Bisection rather than arithmetic because `cutHeadTail` snaps to line
 * boundaries, so the size is a step function of the scale and there is no
 * closed form.
 *
 * THE TOP-UP PASS IS NOT A REFINEMENT, IT IS WHAT MAKES THE ARM HONEST. With
 * bisection alone the step function made `jev-shorten` land 2,500 tokens
 * under the 80% budget -- it wasted a sixth of what it was allowed and then
 * lost the comparison by two points. That is a handicap in my own
 * implementation, not a fact about summarisation, and the first attempt to
 * correct it (raising the budget until the arm kept as much as deletion did,
 * the way §4 matches the baselines) let the arm escape to NOT COMPACTING AT
 * ALL, which is worse: it scored a meaningless 100%.
 *
 * So the leftover is spent here instead, growing entries one at a time while
 * they still fit. `order` decides which entries get the slack, so the paid
 * arm can give it to what it judged live.
 */
function fit(
  entries: readonly Entry[],
  budgetTokens: number,
  shorten: (entry: Entry, scale: number) => Entry,
  priority: (entry: Entry) => number,
): Entry[] {
  if (totalTokens(entries) <= budgetTokens) return [...entries];
  let lo = 0;
  let hi = 1;
  let best = entries.map((e) => shorten(e, 0));
  for (let i = 0; i < 30; i += 1) {
    const mid = (lo + hi) / 2;
    const attempt = entries.map((e) => shorten(e, mid));
    if (totalTokens(attempt) <= budgetTokens) {
      best = attempt;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  // Spend the leftover. Highest priority first, in growing steps, and never
  // past the entry's original length.
  const byId = new Map(entries.map((e) => [e.id, e]));
  const out = [...best];
  const index = new Map(out.map((e, i) => [e.id, i]));
  const queue = [...out].sort((a, b) => priority(byId.get(b.id) ?? b) - priority(byId.get(a.id) ?? a));
  for (const entry of queue) {
    const original = byId.get(entry.id);
    if (!original) continue;
    const at = index.get(entry.id);
    if (at === undefined) continue;
    // The cap is well above 1 on purpose. In the paid arm an entry's
    // retention is `share * scale` with `share < 1` for anything judged
    // spent, so a scale of 1 cannot restore it and the arm would leave its
    // budget unspent -- which is what it did, 2,500 tokens under at the 80%
    // budget. `cutHeadTail` never returns more than the original, so there
    // is nothing to bound here but the loop.
    for (let scale = lo; scale <= 32; scale = scale * 1.35 + 0.02) {
      const grown = shorten(original, scale);
      if (grown.text.length <= out[at].text.length) continue;
      const before = out[at];
      out[at] = grown;
      if (totalTokens(out) > budgetTokens) {
        out[at] = before;
        break;
      }
    }
  }
  return out;
}

export interface ShortenInput {
  entries: readonly Entry[];
  budgetTokens: number;
  floors: Floors;
  /** Recorded per-entry levels, for the paid arm. Most spent is lowest. */
  levels?: Map<string, number>;
}

export function shortenBy(arm: Shortener, input: ShortenInput): Entry[] {
  const { entries, budgetTokens, floors, levels } = input;
  const keep = pinned(entries, floors);

  if (arm === "truncate" || arm === "headtail") {
    const cut = arm === "truncate" ? cutTail : cutHeadTail;
    return fit(
      entries,
      budgetTokens,
      (entry, scale) =>
        keep.has(entry.id) ? entry : { ...entry, text: cut(entry.text, Math.round(entry.text.length * scale)) },
      // The free arms have no signal, so the leftover goes to the most
      // recent entries -- the only preference available without judgment.
      (entry) => entries.findIndex((e) => e.id === entry.id),
    );
  }

  /**
   * The paid arm, and the one this experiment is for: the SAME recorded
   * answers, spent a different way.
   *
   * Deletion reads the levels as a rank and removes from the bottom.
   * Shortening reads them as a retention: an entry judged spent keeps a
   * little of itself, an entry judged live keeps all of it. So both arms pay
   * exactly the same 8,714 tokens per compaction and differ only in what
   * they do with the answer -- which is the design question docs/37 §3 left
   * open and could not settle by argument.
   *
   * A floor of 5% on the retention is deliberate. Letting a spent entry go
   * to zero would make this arm a deletion wearing a summariser's name, and
   * the whole point is to compare the two actions.
   */
  const top = Math.max(...[...(levels?.values() ?? [1])].filter((x) => Number.isFinite(x)), 1);
  return fit(
    entries,
    budgetTokens,
    (entry, scale) => {
      if (keep.has(entry.id)) return entry;
      const level = levels?.get(entry.id);
      const share = Number.isFinite(level) ? Math.max(0.05, Math.min(1, (level as number) / top)) : 1;
      return { ...entry, text: cutHeadTail(entry.text, Math.round(entry.text.length * share * scale)) };
    },
    // The leftover goes to what judgment called most live.
    (entry) => levels?.get(entry.id) ?? Number.POSITIVE_INFINITY,
  );
}

/** Total tokens, for a caller checking an arm hit its budget. */
export { totalTokens, tokensOf };
