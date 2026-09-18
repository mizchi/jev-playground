/**
 * Turning an explored run into a Playwright spec, and the question of what
 * to assert.
 *
 * Emitting the clicks is the easy half and the worthless half. A spec that
 * replays a sequence and checks the final URL passes against an app whose
 * "Place order" button has stopped recording the order — it still lands on
 * `#/confirm`, because the navigation was never the thing that broke. So
 * the interesting part is the post-conditions, and the split this file
 * makes is:
 *
 * - **Candidate post-conditions are extracted in code.** The harness
 *   already knows the status line and the heading before and after every
 *   step; the ones that changed are the only candidates worth considering.
 *   Nothing is invented, and a model that hallucinated a fact could not
 *   get it in here.
 * - **Which of them is a consequence is asked.** "The status line now says
 *   `cart=1`" is a consequence of adding to the cart. "The heading says
 *   Products" is true and would also have been true if the click had done
 *   nothing. Telling those apart is a judgement about the app, which is
 *   the half worth a model call — and it is one `noul` per candidate.
 *
 * Same division as docs/25 and docs/26: extract deterministically, judge
 * with the model, and never the other way round.
 */
import type { StepLog } from "./confidence-bench.js";
import { Jev, noul, type Question } from "../../shared/jev.js";

export interface RecordedStep extends StepLog {
  /**
   * The route after the action. `StepLog.hash` is where the step
   * STARTED, so using it as the end state makes the last assertion name
   * the second-to-last screen — a generated spec that fails against the
   * app it was generated from.
   */
  hashAfter: string;
  /** The status line after the action — the app's own state readout. */
  statusAfter: string;
  /** The `<h1>` after the action. */
  headingAfter: string;
  /** The status line before, so a change can be spotted. */
  statusBefore: string;
  headingBefore: string;
}

export interface Assertion {
  /** Playwright expectation source, ready to emit. */
  code: string;
  /** What it claims, for the comment above it. */
  says: string;
  /** How sure the model was that this is a consequence of the action. */
  consequence: number;
}

/**
 * The facts that changed. Only changes are offered: a fact that held
 * before the action cannot be evidence that the action worked, and a spec
 * full of them is what makes a generated suite green forever.
 */
export function candidateAssertions(step: RecordedStep): Assertion[] {
  const out: Assertion[] = [];
  if (step.statusAfter !== step.statusBefore) {
    // The status line is one string of `key=value` pairs; assert the
    // pairs that moved, not the whole line, so an unrelated change
    // elsewhere does not fail this step.
    const before = new Map(
      step.statusBefore.split(/\s+/).filter(Boolean).map((p) => p.split("=") as [string, string]),
    );
    for (const pair of step.statusAfter.split(/\s+/).filter(Boolean)) {
      const [key, value] = pair.split("=") as [string, string];
      if (before.get(key) === value) continue;
      out.push({
        code: `await expect(page.locator("#status")).toContainText("${key}=${value}");`,
        says: `the app now reports ${key}=${value}`,
        consequence: 0,
      });
    }
  }
  if (step.headingAfter && step.headingAfter !== step.headingBefore) {
    out.push({
      code: `await expect(page.locator("h1")).toContainText(${JSON.stringify(step.headingAfter)});`,
      says: `the screen is now "${step.headingAfter}"`,
      consequence: 0,
    });
  }
  return out;
}

/**
 * Ask, per candidate, whether it is a consequence of the action rather
 * than something that merely became true. One request per step carrying
 * all of its candidates, since the state is the expensive part.
 */
export async function judgeAssertions(
  jev: Jev,
  step: RecordedStep,
  candidates: Assertion[],
): Promise<Assertion[]> {
  if (candidates.length === 0) return [];
  const questions: Record<string, Question> = {};
  candidates.forEach((c, i) => {
    questions[`a${i}`] = {
      type: "noul",
      instructions: `This is a consequence of the action: ${c.says}`,
      criteria: {
        true: "The action caused this. If the action had silently failed, this would not hold, so checking it would catch that failure",
        false: "This became true for some other reason, or would have held anyway — checking it proves nothing about the action",
      },
    };
  });
  const res = await jev.ask(
    {
      action: `${step.action} ${step.locator.role} "${step.locator.name}"`,
      screen_before: step.headingBefore,
      screen_after: step.headingAfter,
      app_state_before: step.statusBefore,
      app_state_after: step.statusAfter,
      note: "The app prints its own state in a status line. A check on that line tests behaviour; a check on the heading usually tests navigation.",
    },
    questions,
  );
  return candidates
    .map((c, i) => ({ ...c, consequence: noul(res.answers[`a${i}`]!) }))
    .filter((c) => c.consequence > 0.6)
    .sort((a, b) => b.consequence - a.consequence);
}

function locatorCode(loc: StepLog["locator"]): string {
  if (loc.id) return `page.locator(${JSON.stringify(`#${loc.id}`)})`;
  return `page.getByRole(${JSON.stringify(loc.role)}, { name: ${JSON.stringify(loc.name)} })`;
}

export interface SpecOptions {
  title: string;
  /** The natural-language goal the run was given. */
  goal: string;
  /** Replaced at run time so the spec can be pointed at a mutation. */
  baseUrlVar?: string;
}

/**
 * The naive generator: the actions, and the URL it ended on.
 *
 * This is what "generate a test from a recording" usually means, and it
 * is the control arm — the point of measuring it is that it looks
 * complete.
 */
export function emitReplaySpec(steps: RecordedStep[], opts: SpecOptions): string {
  const body = steps
    .map((s) => {
      const loc = locatorCode(s.locator);
      return s.action === "fill"
        ? `  await ${loc}.fill(${JSON.stringify(s.value ?? "")});`
        : `  await ${loc}.click();`;
    })
    .join("\n");
  const finalHash = steps[steps.length - 1]?.hashAfter ?? "#/home";
  return `${header(opts, "replay")}
test(${JSON.stringify(opts.title)}, async ({ page }) => {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });

${body}

  // The only claim this spec makes about the outcome.
  await expect(page).toHaveURL(new RegExp(${JSON.stringify(escapeRe(finalHash))}));
});
`;
}

/** The actions, each followed by the post-conditions that survived judging. */
export function emitAssertedSpec(
  steps: RecordedStep[],
  kept: Assertion[][],
  opts: SpecOptions,
): string {
  const body = steps
    .map((s, i) => {
      const loc = locatorCode(s.locator);
      const act =
        s.action === "fill"
          ? `  await ${loc}.fill(${JSON.stringify(s.value ?? "")});`
          : `  await ${loc}.click();`;
      const checks = (kept[i] ?? [])
        .map((a) => `  // ${a.says} (consequence ${a.consequence.toFixed(2)})\n  ${a.code}`)
        .join("\n");
      return checks ? `${act}\n${checks}` : act;
    })
    .join("\n\n");
  return `${header(opts, "asserted")}
test(${JSON.stringify(opts.title)}, async ({ page }) => {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });

${body}
});
`;
}

function header(opts: SpecOptions, kind: string): string {
  return `// GENERATED by experiments/browser-chaos (docs/27) — ${kind} variant.
// Goal given to the explorer, in words:
//   ${opts.goal}
//
// Do not edit: regenerate with \`npx tsx src/run-testgen.ts\`.
import { expect, test } from "@playwright/test";

const BASE = process.env.APP_URL ?? "http://127.0.0.1:8901/";
`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
