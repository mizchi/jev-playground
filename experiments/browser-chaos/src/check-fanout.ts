/**
 * The parts of docs/29 that need no API key.
 *
 *   npx tsx src/check-fanout.ts
 *
 * Two things are worth pinning without spending a call: that the action
 * space splits into heads whose every target is executable, and that
 * `validateChoice` actually rejects the answers it claims to. The second
 * is the one that would otherwise rot silently — a validator nobody tests
 * passes everything.
 */
import { actionSpace, defaultOption, operationFor, untriedOption, validateChoice } from "./fanout.js";
import type { ProbedCandidate } from "./probes.js";
import {
  FIXTURES,
  hostileTrap,
  slotsHardTrap,
  slotsTrap,
  SLOTS_GOAL,
} from "./adversarial-fixtures.js";

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function cand(over: Partial<ProbedCandidate> & { index: number }): ProbedCandidate {
  return {
    selector: `[data-probe-idx="${over.index}"]`,
    description: 'button "Place order"',
    type: "click",
    options: [],
    currentValue: "",
    facts: { enabled: true, inViewport: true, inert: false },
    locator: { role: "button", name: "Place order" },
    ...over,
  };
}

const shipping = cand({
  index: 7,
  type: "select",
  description: 'select field "Shipping method"',
  currentValue: "",
  options: [
    { value: "", label: "Choose a shipping method…" },
    { value: "standard", label: "Standard — 5 days" },
    { value: "express", label: "Express — next day" },
  ],
  locator: { id: "shipping", role: "combobox", name: "Shipping method" },
});

console.log("action space");

check("each candidate maps to exactly one operation", () => {
  assert(operationFor(cand({ index: 0 })) === "CLICK", "a button is not CLICK");
  assert(operationFor(cand({ index: 1, type: "input" })) === "TYPE_TEXT", "an input is not TYPE_TEXT");
  assert(operationFor(shipping) === "SELECT", "a select is not SELECT");
});

check("heads contain only elements that accept their operation", () => {
  const { heads } = actionSpace([cand({ index: 0 }), cand({ index: 1, type: "input" }), shipping]);
  for (const [op, head] of heads) {
    for (const [, entry] of head) {
      assert(operationFor(entry.candidate) === op, `${op} head holds a ${entry.candidate.type}`);
    }
  }
});

check("an operation with no candidates is not offered", () => {
  // The whole point: a `choice` always names something, so offering
  // SELECT on a page with no dropdown invites an unexecutable answer.
  const { heads, operations } = actionSpace([cand({ index: 0 })]);
  assert(!heads.has("SELECT"), "SELECT head exists with no dropdown");
  assert(!operations.includes("SELECT"), "SELECT offered with no dropdown");
  assert(!operations.includes("TYPE_TEXT"), "TYPE_TEXT offered with no field");
  assert(operations.includes("CLICK"), "CLICK not offered despite a button");
});

check("DONE and BLOCKED are always offered", () => {
  const { operations } = actionSpace([cand({ index: 0 })]);
  assert(operations.includes("DONE"), "DONE missing");
  assert(operations.includes("BLOCKED"), "BLOCKED missing");
});

check("a dropdown yields one target per settable option", () => {
  const head = actionSpace([shipping]).heads.get("SELECT")!;
  // Three options, one of which is the current value, so two targets.
  assert(head.size === 2, `expected 2 targets, got ${head.size}`);
  const values = [...head.values()].map((e) => e.option);
  assert(!values.includes(""), "offered the option already set");
  assert(values.includes("standard") && values.includes("express"), `missing options: ${values.join(",")}`);
  for (const key of head.keys()) assert(/^7:\d+$/.test(key), `target key '${key}' is not index:option`);
});

check("the placeholder is never a target", () => {
  // docs/29's adversarial run found both arms naming it once shipping was
  // set: a target that unsets a satisfied requirement. `defaultOption`
  // always skipped it; `actionSpace` did not, which was an inconsistency
  // rather than a decision.
  for (const current of ["", "standard", "express"]) {
    const head = actionSpace([{ ...shipping, currentValue: current }]).heads.get("SELECT");
    for (const entry of head?.values() ?? []) {
      assert(entry.option !== "", `offered the placeholder with currentValue='${current}'`);
    }
  }
});

check("a set dropdown never offers a target that empties it", () => {
  const head = actionSpace([{ ...shipping, currentValue: "express" }]).heads.get("SELECT")!;
  // Three options, one current, one placeholder -> one real alternative.
  assert(head.size === 1, `expected 1 target, got ${head.size}`);
  assert([...head.values()][0]!.option === "standard", "the remaining target is not the other real value");
});

check("every offered option came off the page", () => {
  const head = actionSpace([shipping]).heads.get("SELECT")!;
  const onPage = new Set(shipping.options.map((o) => o.value));
  for (const entry of head.values()) {
    assert(onPage.has(entry.option!), `option '${entry.option}' is not on the page`);
  }
});

check("a dropdown with nothing left to set drops out entirely", () => {
  const settled = { ...shipping, currentValue: "express", options: [{ value: "express", label: "Express" }] };
  const { heads, operations } = actionSpace([settled]);
  assert(!heads.has("SELECT"), "offered a SELECT with no settable option");
  assert(!operations.includes("SELECT"), "SELECT still in the operation list");
});

console.log("\nflat-arm option fallback");

/** Walk a dropdown the way the flat arm does, and report where it lands. */
function walk(options: { value: string; label: string }[], steps: number, remember: boolean): string[] {
  const visited: string[] = [];
  const tried = new Set<string>();
  let current = "";
  for (let i = 0; i < steps; i += 1) {
    const c = { ...shipping, options, currentValue: current };
    let next = remember ? untriedOption(c, tried) : defaultOption(c);
    if (remember && next === undefined) {
      tried.clear();
      next = untriedOption(c, tried);
    }
    if (next === undefined) break;
    if (remember) tried.add(next);
    visited.push(next);
    current = next;
  }
  return visited;
}

const six = [
  { value: "", label: "Choose…" },
  { value: "standard", label: "Standard" },
  { value: "economy", label: "Economy" },
  { value: "locker", label: "Locker" },
  { value: "saturday", label: "Saturday" },
  { value: "courier", label: "Courier" },
  { value: "express", label: "Express" },
];

check("the memoryless fallback never offers the placeholder", () => {
  // The first version of this did, and it is the difference between a
  // dropdown that oscillates and one that unsets itself every other step.
  assert(!walk(six, 8, false).includes(""), "offered the empty option");
});

check("the memoryless fallback oscillates and never reaches the last option", () => {
  // Not slow — non-terminating. "First option that is not the current
  // one" maps "" -> a, a -> b, b -> a, so options 3..k are unreachable
  // however long the budget is. This is the flat arm's real failure and
  // the reason `flat-memo` exists.
  const visited = walk(six, 20, false);
  assert(visited.length === 20, `stopped after ${visited.length} steps`);
  assert(new Set(visited).size === 2, `visited ${new Set(visited).size} distinct options, expected 2`);
  assert(!visited.includes("express"), "reached express, so it does not oscillate");
});

check("the remembering fallback enumerates every option", () => {
  const visited = walk(six, 20, true);
  for (const o of six.slice(1)) {
    assert(visited.includes(o.value), `never tried '${o.value}'`);
  }
});

check("the remembering fallback reaches the last option in at most one step each", () => {
  const visited = walk(six, 20, true);
  const at = visited.indexOf("express");
  assert(at !== -1, "never reached express");
  // Six real options, so the wanted one is set by the sixth step at worst.
  assert(at <= six.length - 1, `took ${at + 1} steps, more than one per option`);
});

check("both fallbacks walk two options identically", () => {
  // Why the two-option fixture hides all of this, and why docs/29 can
  // report one `flat` row for `select=1` rather than running `flat-memo`
  // separately: with a single real alternative the two heuristics take
  // the same option in the same order, so the oscillation has nowhere to
  // show up and the arms cannot differ.
  const two = [six[0]!, six[1]!, six[6]!];
  const memoryless = walk(two, 2, false);
  const remembering = walk(two, 2, true);
  assert(
    memoryless.join(",") === remembering.join(","),
    `diverged: ${memoryless.join(",")} vs ${remembering.join(",")}`,
  );
  assert(remembering[1] === "express", `did not reach express on the second step: ${remembering.join(",")}`);
});

console.log("\nadversarial trap graders");

/**
 * These decide the "traps executed: 0" line in §8, so a grader whose
 * regex quietly matches nothing reports a flawless run. Each one is
 * checked in both directions: the trap is caught AND the correct pick is
 * not miscounted as one.
 */
const button = (name: string) => cand({ index: 0, description: `button "${name}"` });
const field = (name: string) => cand({ index: 0, type: "input", description: `text field "${name}"` });

check("hostile: the TYPE_TEXT trap is the optional field, not the required one", () => {
  assert(hostileTrap("TYPE_TEXT", field("Promo code (optional)")), "missed the promo field");
  assert(!hostileTrap("TYPE_TEXT", field("Recipient name (required)")), "flagged the required field");
});

check("hostile: Place order is not a trap, but the twin and Back are", () => {
  // Gated is not wrong — it is the only forward button, so naming it
  // answers "if CLICK, which element" fairly.
  assert(!hostileTrap("CLICK", button("Place order")), "flagged Place order");
  assert(hostileTrap("CLICK", button("Place order and subscribe to restock alerts")), "missed the twin");
  assert(hostileTrap("CLICK", button("Back to delivery")), "missed Back to delivery");
  assert(hostileTrap("CLICK", button("Apply promo code")), "missed Apply promo code");
});

check("hostile: SELECT grades the element and the option", () => {
  const ship = cand({ index: 0, type: "select", description: 'select-one field "Shipping method"' });
  const gift = cand({ index: 0, type: "select", description: 'select-one field "Gift wrap (optional)"' });
  assert(!hostileTrap("SELECT", ship, "express"), "flagged shipping=express");
  assert(hostileTrap("SELECT", ship, "standard"), "missed shipping=standard");
  assert(hostileTrap("SELECT", gift, "foil"), "missed the gift-wrap dropdown");
});

check("slots: only the Wednesday morning slot passes", () => {
  assert(!slotsTrap("CLICK", button("Reserve Wed 09:00")), "flagged the open slot");
  for (const n of ["Reserve Tue 09:00", "Reserve Tue 13:00", "Reserve Wed 13:00"]) {
    assert(slotsTrap("CLICK", button(n)), `missed the full slot '${n}'`);
  }
  // Not a Reserve button at all, so not this grader's business.
  assert(!slotsTrap("CLICK", button("Place order")), "flagged Place order");
});

check("slots-hard: only S4 passes, and S4 is matched on a word boundary", () => {
  assert(!slotsHardTrap("CLICK", button("Reserve S4")), "flagged the open slot");
  for (const n of ["Reserve S1", "Reserve S2", "Reserve S3", "Reserve S5", "Reserve S6"]) {
    assert(slotsHardTrap("CLICK", button(n)), `missed the full slot '${n}'`);
  }
  // A bare /S4/ would pass "Reserve S40" too. Codes are single-digit
  // here, but the grader should not depend on that.
  assert(slotsHardTrap("CLICK", button("Reserve S40")), "matched S4 inside S40");
});

check("every fixture has a query, a goal and a grader", () => {
  for (const [name, f] of Object.entries(FIXTURES)) {
    assert(f.query.length > 0, `${name} has no query`);
    assert(f.goal.length > 0, `${name} has no goal`);
    assert(typeof f.trap === "function", `${name} has no grader`);
  }
  // The slots goal must not leak the discriminator, or the board becomes
  // another `twin` and tests nothing new.
  assert(!/avail|open|free|booked/i.test(SLOTS_GOAL), `the slots goal names availability: ${SLOTS_GOAL}`);
});

console.log("\nvalidateChoice");

const ok = {
  type: "choice" as const,
  choice: "a",
  confidence: 0.9,
  probabilities: { a: 0.7, b: 0.3 },
};

check("accepts a well-formed answer", () => {
  const out = validateChoice(ok, ["a", "b"]);
  assert(out.choice === "a", "lost the choice");
  assert(out.confidence === 0.9, "lost the confidence");
});

const rejects: [string, unknown, string[]][] = [
  ["a noul answer where a choice was asked", { type: "noul", noul: 0.5 }, ["a", "b"]],
  ["nothing at all", undefined, ["a", "b"]],
  ["a choice that was never offered", { ...ok, choice: "z", probabilities: { a: 0.7, b: 0.3 } }, ["a", "b"]],
  ["a distribution missing an offered key", { ...ok, probabilities: { a: 1 } }, ["a", "b"]],
  ["a distribution naming a key not offered", { ...ok, probabilities: { a: 0.7, z: 0.3 } }, ["a", "b"]],
  ["probabilities that do not sum to 1", { ...ok, probabilities: { a: 0.7, b: 0.9 } }, ["a", "b"]],
  ["a probability outside 0..1", { ...ok, probabilities: { a: 1.4, b: -0.4 } }, ["a", "b"]],
  ["a confidence outside 0..1", { ...ok, confidence: 1.5 }, ["a", "b"]],
  ["a non-finite number", { ...ok, confidence: Number.NaN }, ["a", "b"]],
  // The one that matters most: a choice the distribution itself disagrees
  // with. Nothing downstream would notice, and it means the answer and
  // its own reasoning point at different elements.
  ["a choice that is not the argmax", { ...ok, choice: "b", probabilities: { a: 0.7, b: 0.3 } }, ["a", "b"]],
];

for (const [name, answer, keys] of rejects) {
  check(`rejects ${name}`, () => {
    let threw = false;
    try {
      validateChoice(answer as never, keys);
    } catch {
      threw = true;
    }
    assert(threw, "accepted it");
  });
}

check("a tie is not a rejection", () => {
  // Two equally-weighted options are a real answer, and the argmax check
  // has to allow either. An exact-equality check with no epsilon would
  // reject one of them depending on float noise.
  validateChoice({ ...ok, choice: "b", probabilities: { a: 0.5, b: 0.5 } }, ["a", "b"]);
});

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
