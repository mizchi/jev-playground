/**
 * A chaosbringer `Driver` that asks Jev which candidate to act on next.
 *
 * This is the shape the `drivers/` layer already expects, so it drops into
 * `chaos({ driver })` next to `weightedRandomDriver` and `aiDriver`. The
 * difference from `aiDriver` is what it needs: no screenshot, so there is no
 * capture cost and no reason to sample or budget it — one ~250 ms call per
 * step is affordable on every step.
 *
 * Two things this file is careful about, both from docs/00-api-notes.md:
 *
 * - Candidate names are indices, and their descriptions are the candidate
 *   descriptions the crawler already computed. Selectors are never sent.
 * - A choice question always picks something, so `stuck` is asked alongside
 *   it: without a way to say "none of these", a dead-end page produces a
 *   confident click on a decoy.
 */
import type { Driver, DriverPick, DriverStep } from "chaosbringer";
import { Jev, choice, noul, type Question } from "../../shared/jev.js";

export interface JevDriverOptions {
  jev: Jev;
  /** What the crawl is trying to do. Forwarded into the state. */
  goal?: string;
  /** Below this confidence, defer to the next driver in the composite. */
  minConfidence?: number;
  /** Called with a one-line trace of every decision. */
  onDecision?: (line: string) => void;
}

/** Candidates the crawler offers, trimmed to what a model should see. */
function visibleCandidates(step: DriverStep) {
  return step.candidates.map((c) => ({
    index: c.index,
    description: c.description,
    type: c.type,
    href: c.href,
  }));
}

export function jevDriver(opts: JevDriverOptions): Driver {
  const {
    jev,
    goal = "Reach states the crawl has not seen yet, and complete any flow the app offers.",
    minConfidence = 0,
    onDecision,
  } = opts;
  // What this driver has already done, so the state can say so. The crawler's
  // own `step.history` is per-page and drops hash navigation.
  const seenUrls = new Set<string>();
  const recentPicks: string[] = [];

  return {
    name: "jev",

    async selectAction(step: DriverStep): Promise<DriverPick | null> {
      if (step.candidates.length === 0) return null;
      const here = await liveUrl(step);
      seenUrls.add(here);
      const cands = visibleCandidates(step);

      const criteria: Record<string, string> = {};
      for (const c of cands) {
        criteria[String(c.index)] =
          `${c.type}: ${c.description}` + (c.href ? ` -> ${c.href}` : "");
      }

      const state = {
        goal,
        current_url: here,
        step_on_this_page: step.stepIndex,
        states_seen_so_far: [...seenUrls],
        recent_actions: recentPicks.slice(-8),
        page_history: step.history.slice(-5).map((h) => ({
          action: h.type,
          target: h.target,
          ok: h.success,
        })),
        invariant_violations: step.invariantViolations.map((v) => v.name),
        candidates: cands,
      };

      // One request, three questions. The state is sent once, so the two
      // extra questions cost only their own tokens.
      const questions: Record<string, Question> = {
        pick: {
          type: "choice",
          instructions:
            "Which candidate moves the crawl furthest toward the goal? Prefer actions that open a state not in states_seen_so_far, and prefer advancing a multi-step flow over restarting it.",
          criteria,
        },
        stuck: {
          type: "noul",
          instructions: "This page is a dead end for the goal.",
          criteria: {
            true: "Nothing here advances the goal; the crawl should go elsewhere",
            false: "At least one candidate makes progress",
          },
        },
        destructive: {
          type: "noul",
          instructions:
            "The chosen candidate would undo progress already made (emptying a cart, deleting an account, logging out).",
        },
      };

      const res = await jev.ask(state, questions);
      const picked = choice(res.answers.pick);
      const index = Number.parseInt(picked.choice, 10);
      const dead = noul(res.answers.stuck);
      const undo = noul(res.answers.destructive);

      onDecision?.(
        `${here} step=${step.stepIndex} cands=${cands.length} ` +
          `pick=${picked.choice}@${picked.confidence.toFixed(2)} ` +
          `stuck=${dead.toFixed(2)} undo=${undo.toFixed(2)} ` +
          `-> ${criteria[picked.choice] ?? "?"}`,
      );

      // A choice always names something, so the guards are separate answers.
      if (!Number.isInteger(index) || !step.candidates.some((c) => c.index === index)) {
        return null;
      }
      if (picked.confidence < minConfidence) return null;
      // Only stand down on a destructive pick when the page has an
      // alternative; on a page whose only control is destructive, taking it
      // is how the crawl gets out.
      if (undo > 0.7 && step.candidates.length > 1) {
        const other = step.candidates.find((c) => c.index !== index);
        if (other) {
          recentPicks.push(criteria[String(other.index)] ?? "?");
          return { kind: "select", index: other.index, source: "jev:avoided-undo" };
        }
      }
      recentPicks.push(criteria[picked.choice] ?? "?");
      return {
        kind: "select",
        index,
        reasoning: `jev conf=${picked.confidence.toFixed(2)} stuck=${dead.toFixed(2)}`,
        source: "jev",
      };
    },
  };
}

/**
 * Wraps a driver to record the URL seen at every step and the candidate it
 * picked. Both arms of the benchmark get the same wrapper, so the coverage
 * numbers are measured identically.
 */
async function liveUrl(step: DriverStep): Promise<string> {
  try {
    return step.page.url();
  } catch {
    return step.url;
  }
}

export function recordingDriver(
  inner: Driver,
  sink: { urls: string[]; picks: string[] },
): Driver {
  return {
    name: `recording(${inner.name})`,
    async selectAction(step) {
      // `step.url` is the page-level URL and does not move with hash
      // navigation, so read the live one.
      sink.urls.push(await liveUrl(step));
      const pick = await inner.selectAction(step);
      if (pick && pick.kind === "select") {
        const c = step.candidates.find((x) => x.index === pick.index);
        sink.picks.push(c ? c.description : `#${pick.index}`);
      } else {
        sink.picks.push(pick ? pick.kind : "null");
      }
      return pick;
    },
    onActionComplete: inner.onActionComplete?.bind(inner),
    onPageStart: inner.onPageStart?.bind(inner),
    onPageEnd: inner.onPageEnd?.bind(inner),
  };
}
