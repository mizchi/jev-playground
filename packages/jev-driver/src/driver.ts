/**
 * `jevDriver` — a chaosbringer `Driver` that asks Jev what to do next.
 *
 * Carved at `Driver` rather than at `DriverProvider`, deliberately. A
 * provider is handed a candidate list and answers with an index, which
 * is the one thing this design cannot live inside: the typed action
 * space needs to answer with an *operation* as well, and `CLEAR` and
 * `SELECT` need to carry a value. A `Driver` sees the whole step and can
 * return `kind: "custom"`, so the whole shape fits today with no change
 * upstream.
 *
 * Three upstream PRs from this line of work are now **merged and
 * unreleased**: chaosbringer#145 (a provider sees `type` + the
 * geometry, and the screenshot is a thunk), #146 (`operation: "clear"`
 * on a pick, and `"clear"` as an `ActionResult` type) and #147 (a
 * `<select>` is finally a candidate, with `"select"` as an
 * `ActionResult` type). None of them is needed to run this, and each
 * shrinks it — but the released `0.9.0` has none of them, so the code
 * below still targets that. See README for what changes on release.
 *
 * What it does not need is a screenshot. Jev takes text and returns
 * typed probabilistic decisions, so there is no capture cost, and at one
 * ~250 ms request per step there is no reason to sample or budget it:
 * `aiDriver`'s whole policy layer exists because a vision call is dear
 * enough that you ask on some steps and not others.
 *
 * Every design decision here is a measured one, and the report is named
 * at the decision:
 *
 *  - one request, `operation` + every target head, read one   docs/61 §4
 *  - the obstruction is told, not removed                     docs/62 §4
 *  - no confidence gate of its own                            docs/57 §4
 *  - the goal is a mark, not an order                          docs/58 §4.5
 *  - a value is read off the page or supplied by code          docs/62 §6.7
 */
import { Jev } from "@jev-playground/jev-core";
import { describeForState, isObstructed, type Candidate, type Enriched } from "./candidate.js";
import { enrich, type PageLike } from "./enrich.js";
import { actionSpace, questionsFor, readDecision, type Decision, type Operation } from "./space.js";

/** Structural stand-ins for the crawler's types. See `candidate.ts`. */
export interface ActionResultLike {
  type: "click" | "scroll" | "hover" | "navigate" | "input" | "clear";
  target?: string;
  selector?: string;
  success: boolean;
  error?: string;
  timestamp: number;
}

export interface DriverStepLike {
  url: string;
  currentUrl?: string;
  page: PageLike & { url(): string };
  candidates: ReadonlyArray<Candidate & { selector: string }>;
  history: ReadonlyArray<{ type: string; target?: string; success: boolean }>;
  stepIndex: number;
  invariantViolations: ReadonlyArray<{ name: string; message: string }>;
}

export type DriverPickLike =
  | { kind: "select"; index: number; reasoning?: string; source?: string; confidence?: number }
  | {
      kind: "custom";
      perform: (page: never) => Promise<ActionResultLike>;
      reasoning?: string;
      source?: string;
    }
  | { kind: "skip" };

export interface DriverLike {
  readonly name: string;
  selectAction(step: DriverStepLike): Promise<DriverPickLike | null>;
  onActionComplete?(action: ActionResultLike, step: DriverStepLike): void;
  onPageStart?(url: string): void;
  onPageEnd?(url: string): void;
}

/** One line per step, for a caller that wants to see the reasoning. */
export interface DecisionLog {
  url: string;
  stepIndex: number;
  candidates: number;
  offered: Operation[];
  decision: Decision | null;
  /** Candidates the geometry flagged, which are still offered. */
  obstructed: number;
  /** Candidates whose options / current value could not be read. */
  enrichFailed: number;
  ms: number;
}

export interface JevDriverOptions {
  jev: Jev;
  /**
   * What the crawl is for. Goes into the state as a fact, not into the
   * questions as an order: docs/58 §4.5 measured naming the target in
   * the goal and adding no instruction as the best arm (14.0/14 states
   * reached, 5.0 wasted steps), and adding "find it and click it"
   * dropped it to 10.0/14 with 9.0 wasted. Instructions cost breadth,
   * which for a chaos crawl is the objective.
   */
  goal?: string;
  /**
   * The text to type into a field. Code's job, not the model's: Jev
   * answers `choice`, so it cannot author a string. Omit and the
   * crawler's own `fillValue` is used instead — it derives one from the
   * field's `inputType`, which is what a `select` pick gets anyway.
   */
  fillValueFor?: (c: Enriched) => string | undefined;
  onDecision?: (log: DecisionLog) => void;
}

const DEFAULT_GOAL =
  "Reach states this crawl has not seen, and finish any flow the app offers end to end.";

export function jevDriver(opts: JevDriverOptions): DriverLike {
  const { jev, goal = DEFAULT_GOAL, fillValueFor, onDecision } = opts;
  const seenUrls = new Set<string>();
  const recent: string[] = [];
  // How many times each action has been taken on a screen that did not
  // change afterwards, and how long the screen has been standing still.
  // Both go into the state as facts rather than into a threshold here:
  // docs/57 §4 measured that confidence does not notice a no-op click
  // (12 of 13 dead clicks came back at 0.99) until the failure is put
  // back into the state, and docs/62 §6.5 found that driving on a
  // position fact oscillates where a progress fact does not.
  const takenHere = new Map<string, number>();
  let lastScreen = "";
  let unchangedFor = 0;
  // A latch, because `skip` is not a stop. The crawler re-asks a driver
  // that skips (its attempt budget is three times the step budget), so
  // an un-latched DONE spends a request per attempt to say the same
  // thing: the first run of this spent 8 extra requests that way on one
  // screen. Cleared when the screen changes, since DONE was about that
  // screen.
  let doneWith = "";

  return {
    name: "jev",

    async selectAction(step: DriverStepLike): Promise<DriverPickLike | null> {
      const actionable = step.candidates.filter((c) => c.type !== "scroll");
      if (actionable.length === 0) return null;

      const here = liveUrl(step);
      seenUrls.add(here);
      const started = Date.now();

      const { candidates: enriched, failed: enrichFailed } = await enrich(
        step.page,
        step.candidates,
        (c) => step.candidates.find((x) => x.index === c.index)?.selector,
      );
      const space = actionSpace(enriched);

      // The screen, as the decision sees it. Not the URL: this app routes
      // by hash and re-renders in place, so the URL can move while the
      // controls do not, and the controls can change while it does not.
      const screen = `${here}|${enriched.map((c) => c.description).join("|")}`;
      if (screen === lastScreen) {
        unchangedFor += 1;
      } else {
        unchangedFor = 0;
        takenHere.clear();
        lastScreen = screen;
        doneWith = "";
      }
      // Already answered for this screen. Standing down without asking.
      if (doneWith === screen) return null;
      // Every head empty means nothing here is actionable at all. Stand
      // down rather than spend a request to be told so.
      if (space.offered.length <= 1) return null;

      const state = {
        goal,
        current_url: here,
        step_on_this_page: step.stepIndex,
        states_seen_so_far: [...seenUrls],
        recent_actions: recent.slice(-8),
        page_history: step.history.slice(-5).map((h) => ({
          action: h.type,
          target: h.target,
          ok: h.success,
        })),
        invariant_violations: step.invariantViolations.map((v) => v.name),
        // The progress facts. `steps_since_this_screen_changed` is the
        // one a no-op click cannot hide from, and
        // `already_tried_on_this_screen` names what has been spent.
        steps_since_this_screen_changed: unchangedFor,
        already_tried_on_this_screen: [...takenHere]
          .filter(([, n]) => n > 0)
          .map(([what, n]) => `${what} (${n}x, screen unchanged)`),
        candidates: enriched.filter((c) => c.type !== "scroll").map(describeForState),
      };

      const res = await jev.ask(state, questionsFor(space));
      const decision = readDecision(space, res.answers);

      onDecision?.({
        url: here,
        stepIndex: step.stepIndex,
        candidates: actionable.length,
        offered: space.offered,
        decision,
        obstructed: enriched.filter(isObstructed).length,
        enrichFailed,
        ms: Date.now() - started,
      });

      if (!decision) return null;
      if (decision.operation === "DONE") {
        doneWith = screen;
        return { kind: "skip" };
      }
      const target = decision.target;
      if (!target) return null;

      const what = `${decision.operation} ${target.candidate.description}`;
      recent.push(what);
      takenHere.set(what, (takenHere.get(what) ?? 0) + 1);
      const reasoning =
        `${decision.operation} conf=${fmt(decision.operationConfidence)}` +
        `/${fmt(decision.targetConfidence)} stuck=${fmt(decision.stuck)}`;
      return toPick(decision, reasoning, fillValueFor);
    },

    onPageStart(url: string) {
      seenUrls.add(url);
    },
  };
}

/**
 * Turn a decision into the crawler's vocabulary.
 *
 * `CLICK` is a plain `select` — the crawler already clicks a button and
 * a link, and there is no reason to take the page over to do it.
 * Everything that has to carry a value becomes `custom`, which is the
 * escape hatch a `Driver` has and a `DriverProvider` does not.
 */
function toPick(
  decision: Decision<Enriched & { selector: string }>,
  reasoning: string,
  fillValueFor?: (c: Enriched) => string | undefined,
): DriverPickLike {
  const c = decision.target!.candidate;
  const source = `jev:${decision.operation}`;

  if (decision.operation === "CLICK") {
    return {
      kind: "select",
      index: c.index,
      reasoning,
      source,
      // Passed through so the crawler records it, not gated on. docs/57
      // §4 found the picks that did nothing came back at 0.99 and above:
      // the number says how sure the model is about a question, not
      // whether the click lands. The facts in the state say that.
      ...(Number.isFinite(decision.targetConfidence)
        ? { confidence: decision.targetConfidence }
        : {}),
    };
  }

  if (decision.operation === "TYPE_TEXT" && !fillValueFor) {
    // No value to carry, so there is nothing `custom` would add: the
    // crawler fills an `input` target with its own derived value.
    return {
      kind: "select",
      index: c.index,
      reasoning,
      source,
      ...(Number.isFinite(decision.targetConfidence)
        ? { confidence: decision.targetConfidence }
        : {}),
    };
  }

  // Carried in the type by `enrich`, which preserves its input's shape:
  // `DriverStepLike.candidates` has the selector, so the enriched
  // candidate does too. Nothing model-facing ever sees it.
  const selector = c.selector;
  const op = decision.operation;
  const option = decision.target!.option;
  const value = op === "TYPE_TEXT" ? fillValueFor?.(c) : undefined;

  return {
    kind: "custom",
    reasoning,
    source,
    async perform(page: never): Promise<ActionResultLike> {
      const timestamp = Date.now();
      const locator = (page as unknown as PageLike).locator(selector ?? "").first() as unknown as {
        fill(v: string, o?: { timeout?: number }): Promise<void>;
        clear(o?: { timeout?: number }): Promise<void>;
        selectOption(v: string, o?: { timeout?: number }): Promise<unknown>;
      };
      try {
        if (op === "CLEAR") {
          await locator.clear({ timeout: 2000 });
          return {
            // Mislabelled on purpose, for exactly as long as the release
            // lags: chaosbringer#146 added `"clear"` and is merged but
            // not published, and `0.9.0` would record an `ActionResult`
            // type it does not know. Until then the trace cannot tell
            // this apart from a fill, which was that PR's whole
            // argument. Costs nothing worse than a wrong label, since a
            // clear round-trips through the recipe language as a fill
            // with an empty value either way.
            type: "input",
            target: `cleared ${c.description}`,
            selector,
            success: true,
            timestamp,
          };
        }
        if (op === "SELECT" && option !== undefined) {
          await locator.selectOption(option, { timeout: 2000 });
          return {
            // Same wait on the same release (#147 added `"select"`), but
            // this label costs more than the clear's, and the cost is
            // read off the code rather than observed: a recorded
            // `"input"` becomes `{ kind: "fill", value: "test input" }`,
            // and `replay` calls `page.fill` on a `<select>`, which
            // throws. So a recipe captured from this arm does not
            // replay. Only reachable through `tracingDriver`, which
            // nothing here wraps, so it has not been seen — but it is
            // the first thing to fix on release, and the reason to fix
            // the label rather than leave it approximate.
            type: "input",
            target: `${c.description} = ${option}`,
            selector,
            success: true,
            timestamp,
          };
        }
        if (op === "TYPE_TEXT" && value !== undefined) {
          await locator.fill(value, { timeout: 2000 });
          return {
            type: "input",
            target: `${c.description} = ${value}`,
            selector,
            success: true,
            timestamp,
          };
        }
        return {
          type: "input",
          target: c.description,
          success: false,
          error: `no way to perform ${op}`,
          timestamp,
        };
      } catch (err) {
        return {
          type: "input",
          target: c.description,
          selector,
          success: false,
          error: err instanceof Error ? err.message : String(err),
          timestamp,
        };
      }
    },
  };
}

function liveUrl(step: DriverStepLike): string {
  try {
    return step.page.url();
  } catch {
    return step.currentUrl ?? step.url;
  }
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : "-";
}

/**
 * Re-exported so a caller needs one package, not two: `jevDriver` takes
 * the client rather than constructing it (a crawl wants the call count
 * and the wall clock afterwards), and there is no reason to make them
 * install `@jev-playground/jev-core` to hand one in.
 */
export { Jev, JevError } from "@jev-playground/jev-core";
export { actionSpace, questionsFor, readDecision } from "./space.js";
export { describeForState, isObstructed } from "./candidate.js";
export type { Candidate, Enriched } from "./candidate.js";
export type { ActionSpace, Decision, Operation, TargetEntry } from "./space.js";
