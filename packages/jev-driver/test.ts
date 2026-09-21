/**
 * Model-free checks. No API key, no browser.
 *
 * What is worth pinning here is not "does it call the API" but the
 * invariants that make the answer executable and auditable:
 *
 *  - a chosen (operation, target) pair is performable by construction;
 *  - no model output becomes a selector;
 *  - an obstructed candidate is told about and still offered;
 *  - a head that was not asked cannot be answered;
 *  - the unread heads are counted, because that count is the fan-out's
 *    wager and a silent change to it would be a silent cost change.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { describeForState, isObstructed, type Enriched } from "./src/candidate.ts";
import { actionSpace, questionsFor, readDecision } from "./src/space.ts";

const base = (over: Partial<Enriched> & { index: number }): Enriched => ({
  description: `control ${over.index}`,
  type: "button",
  options: [],
  currentValue: "",
  ...over,
});

const BOARD: Enriched[] = [
  base({ index: 0, description: 'button "Continue to delivery"' }),
  base({ index: 1, description: 'textbox "Email"', type: "input" }),
  base({ index: 2, description: 'textbox "Address"', type: "input", currentValue: "1 Example St" }),
  base({
    index: 3,
    description: 'combobox "Shipping"',
    type: "interactive",
    currentValue: "standard",
    options: [
      { value: "standard", label: "Standard" },
      { value: "express", label: "Express" },
    ],
  }),
  base({ index: 4, description: "scroll", type: "scroll" }),
];

test("every operation head only holds targets that operation can perform", () => {
  const { heads } = actionSpace(BOARD);
  for (const [key, entry] of heads.get("CLICK") ?? []) {
    assert.equal(entry.candidate.index, Number(key));
    assert.notEqual(entry.candidate.type, "input");
    assert.equal(entry.candidate.options.length, 0);
  }
  for (const [, entry] of heads.get("TYPE_TEXT") ?? []) {
    assert.equal(entry.candidate.type, "input");
  }
  for (const [, entry] of heads.get("CLEAR") ?? []) {
    // Emptying an empty field is an action with no end state.
    assert.notEqual(entry.candidate.currentValue, "");
  }
  for (const [, entry] of heads.get("SELECT") ?? []) {
    assert.ok(entry.option !== undefined);
    assert.ok(entry.candidate.options.some((o) => o.value === entry.option));
  }
});

test("the scroll target is in no head", () => {
  const { heads } = actionSpace(BOARD);
  for (const head of heads.values()) {
    for (const [, entry] of head) assert.notEqual(entry.candidate.type, "scroll");
  }
});

test("SELECT offers the option, not just the element, and never the current value", () => {
  const { heads } = actionSpace(BOARD);
  const select = heads.get("SELECT")!;
  // "Element only, the caller guesses the value" is the shape docs/62 §1
  // found nobody ships. The key is the pair.
  assert.deepEqual([...select.keys()], ["3:express"]);
  assert.equal(select.get("3:express")!.option, "express");
});

test("a field with nothing in it is offered for TYPE_TEXT but not for CLEAR", () => {
  const { heads } = actionSpace(BOARD);
  assert.ok(heads.get("TYPE_TEXT")!.has("1"));
  assert.ok(!(heads.get("CLEAR") ?? new Map()).has("1"));
  assert.ok(heads.get("CLEAR")!.has("2"));
});

test("only non-empty heads are offered, and DONE always is", () => {
  const { offered } = actionSpace([base({ index: 0 })]);
  assert.deepEqual(offered, ["CLICK", "DONE"]);
  const all = actionSpace(BOARD).offered;
  assert.deepEqual(all, ["CLICK", "TYPE_TEXT", "CLEAR", "SELECT", "DONE"]);
});

test("a question is asked for every offered operation and no others", () => {
  const space = actionSpace(BOARD);
  const qs = questionsFor(space);
  assert.deepEqual(Object.keys(qs).sort(), [
    "CLEAR_target",
    "CLICK_target",
    "SELECT_target",
    "TYPE_TEXT_target",
    "operation",
    "stuck",
  ]);
  // `stuck` is separate because a choice always names something: with no
  // way to say "none of these", a dead end produces a confident decoy.
  assert.equal(qs.stuck!.type, "noul");
  const op = qs.operation as { type: "choice"; criteria: Record<string, string> };
  assert.deepEqual(Object.keys(op.criteria).sort(), space.offered.slice().sort());
});

test("the questions carry no selector", () => {
  const withSelector = BOARD.map((c) => ({ ...c, selector: `#secret-${c.index}` }));
  const blob = JSON.stringify(questionsFor(actionSpace(withSelector)));
  assert.ok(!blob.includes("#secret"), "a selector reached the question text");
  const stateBlob = JSON.stringify(withSelector.map(describeForState));
  assert.ok(!stateBlob.includes("#secret"), "a selector reached the state");
});

test("an obstructed candidate is told about and still offered", () => {
  // docs/62 §4 measured removing and telling as equivalent for accuracy;
  // docs/05 §3 breaks the tie on recoverability. A wrong label can be
  // overruled, a wrong removal closes the route at every threshold.
  const covered = base({
    index: 0,
    description: 'button "Continue"',
    inViewport: true,
    coveredBy: "Accept cookies <div#consent-backdrop>",
  });
  assert.equal(isObstructed(covered), true);
  const { heads } = actionSpace([covered, base({ index: 1 })]);
  assert.ok(heads.get("CLICK")!.has("0"), "the blocked candidate was removed");
  const described = describeForState(covered);
  assert.match(String(described.note), /consent-backdrop/);
});

test("an unmeasured candidate is not called obstructed", () => {
  // The published crawler reports no geometry at all. Absent has to mean
  // "not measured", not "fine" and not "blocked".
  const plain = base({ index: 0 });
  assert.equal(isObstructed(plain), false);
  assert.equal(describeForState(plain).note, undefined);
  const offscreen = base({ index: 1, inViewport: false });
  assert.equal(isObstructed(offscreen), false);
  assert.match(String(describeForState(offscreen).note), /not hit-tested/);
});

test("reading the answer resolves the named head and counts the rest", () => {
  const space = actionSpace(BOARD);
  const d = readDecision(space, {
    operation: { type: "choice", choice: "SELECT", confidence: 0.71, probabilities: {} },
    SELECT_target: { type: "choice", choice: "3:express", confidence: 0.93, probabilities: {} },
    CLICK_target: { type: "choice", choice: "0", confidence: 0.4, probabilities: {} },
    TYPE_TEXT_target: { type: "choice", choice: "1", confidence: 0.5, probabilities: {} },
    CLEAR_target: { type: "choice", choice: "2", confidence: 0.6, probabilities: {} },
    stuck: { type: "noul", noul: 0.08 },
  })!;
  assert.equal(d.operation, "SELECT");
  assert.equal(d.target!.candidate.index, 3);
  assert.equal(d.target!.option, "express");
  assert.equal(d.targetConfidence, 0.93);
  assert.equal(d.stuck, 0.08);
  // Three heads answered and thrown away. That is the wager docs/61 §4
  // measured as free, so the count belongs in the trace.
  assert.deepEqual(d.unusedHeads.sort(), ["CLEAR_target", "CLICK_target", "TYPE_TEXT_target"]);
});

test("DONE resolves with no target", () => {
  const space = actionSpace(BOARD);
  const d = readDecision(space, {
    operation: { type: "choice", choice: "DONE", confidence: 0.6, probabilities: {} },
    stuck: { type: "noul", noul: 0.9 },
  })!;
  assert.equal(d.operation, "DONE");
  assert.equal(d.target, undefined);
});

test("an answer that names something never offered does not resolve", () => {
  const space = actionSpace(BOARD);
  // A key from another head.
  assert.equal(
    readDecision(space, {
      operation: { type: "choice", choice: "CLICK", confidence: 0.9, probabilities: {} },
      CLICK_target: { type: "choice", choice: "3:express", confidence: 0.9, probabilities: {} },
    }),
    null,
  );
  // An operation with no head on this board.
  assert.equal(
    readDecision(actionSpace([base({ index: 0 })]), {
      operation: { type: "choice", choice: "SELECT", confidence: 0.9, probabilities: {} },
    }),
    null,
  );
  // A missing target head.
  assert.equal(
    readDecision(space, {
      operation: { type: "choice", choice: "CLICK", confidence: 0.9, probabilities: {} },
    }),
    null,
  );
  // A malformed operation answer.
  assert.equal(readDecision(space, { operation: { type: "noul", noul: 1 } }), null);
});

test("the state marks the goal and the facts, and never gives an order", () => {
  const space = actionSpace(BOARD);
  const qs = questionsFor(space);
  const instructions = Object.values(qs)
    .map((q) => String((q as { instructions?: unknown }).instructions ?? ""))
    .join(" ");
  // docs/58 §4.5: marking a fact as relevant is what gets it read, and
  // telling the model how to act narrowed what it reached. Every
  // instruction here asks about the answer's shape.
  assert.ok(!/\bclick the\b|\bpress the\b|\bfind .* and\b/i.test(instructions), instructions);
  assert.match(String((qs.operation as { instructions: string }).instructions), /which kind/i);
});
