import { test } from "node:test";
import assert from "node:assert/strict";
import { isZero, isBlank, sameKind, countMatching } from "../src/equals.js";
test("string zero", () => { assert.equal(isZero("0"), true); });
test("number zero is not the string", () => { assert.equal(isZero(0), false); });
test("other", () => { assert.equal(isZero("1"), false); });
test("blank", () => { assert.equal(isBlank("  "), true); });
test("kind", () => { assert.equal(sameKind(1, 2), true); });
test("count", () => { assert.equal(countMatching([1, 1, 2], 1), 2); });
