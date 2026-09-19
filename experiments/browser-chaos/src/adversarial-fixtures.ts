/**
 * The boards docs/29 §8 uses to attack the speculation, and the graders
 * that say what a wrong pick was.
 *
 * Separate from `run-adversarial.ts` so `check-fanout.ts` can test the
 * graders without starting a browser. They are the whole basis of the
 * "traps executed: 0" line, and a grader whose regex quietly matches
 * nothing reports a perfect run.
 */
import type { Operation } from "./fanout.js";
import type { ProbedCandidate } from "./probes.js";

/**
 * Names every requirement, so a trap is a trap by the goal's own terms
 * rather than by my opinion: nothing here asks for a promo code or gift
 * wrap, and both are marked optional on the page.
 */
export const HOSTILE_GOAL =
  "Complete this order. The recipient is Ada Lovelace. Choose express shipping — next-day. " +
  "Then place the order. Do not add anything that is not required.";

/**
 * Deliberately silent about availability.
 *
 * The `slots` boards exist to test a discriminator the goal does *not*
 * name. "Reserve an available slot" would put the answer back into the
 * goal and make it another `twin`.
 */
export const SLOTS_GOAL = "Reserve a delivery slot for this order, then place the order.";

export interface Fixture {
  /** Query string that turns this board on. */
  query: string;
  goal: string;
  /** Was this pick wrong? */
  trap: (op: Operation, c: ProbedCandidate, option?: string) => boolean;
}

/**
 * `?select=hostile` / `twin`. Every head has something wrong to reach for.
 *
 * `Place order` is NOT a trap even while it is gated: it is the only
 * forward button, so naming it answers "if CLICK, which element" fairly.
 * Being early is not the same as being wrong.
 */
export function hostileTrap(op: Operation, c: ProbedCandidate, option?: string): boolean {
  if (op === "TYPE_TEXT") return /promo|coupon/i.test(c.description);
  // The twin. It passes the same gate and reaches the same confirmation,
  // so it is invisible to "goal reached" and has to be graded by name.
  if (op === "CLICK" && /restock alerts/i.test(c.description)) return true;
  if (op === "SELECT") {
    // The wrong dropdown, or the right dropdown set to the wrong value.
    if (/gift wrap/i.test(c.description)) return true;
    return option !== undefined && option !== "express";
  }
  return /apply promo|back to/i.test(c.description);
}

/** `?slots=1`: only the Wednesday morning slot has room. */
export function slotsTrap(op: Operation, c: ProbedCandidate): boolean {
  if (op !== "CLICK") return false;
  if (!/^button "Reserve/.test(c.description)) return false;
  return !/Wed 09:00/.test(c.description);
}

/** `?slots=hard`: only S4 has room — capacity 6, booked 4. */
export function slotsHardTrap(op: Operation, c: ProbedCandidate): boolean {
  if (op !== "CLICK") return false;
  if (!/^button "Reserve/.test(c.description)) return false;
  return !/\bS4\b/.test(c.description);
}

export const FIXTURES: Record<string, Fixture> = {
  hostile: { query: "select=hostile", goal: HOSTILE_GOAL, trap: hostileTrap },
  twin: { query: "select=twin", goal: HOSTILE_GOAL, trap: hostileTrap },
  slots: { query: "slots=1", goal: SLOTS_GOAL, trap: slotsTrap },
  "slots-hard": { query: "slots=hard", goal: SLOTS_GOAL, trap: slotsHardTrap },
};
