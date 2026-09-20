import { test } from "node:test";
import assert from "node:assert/strict";
import { orDefault, orDefaultStrict, pickFirst, countTruthy } from "../src/truthy.js";
test("uses the value", () => { assert.equal(orDefault(5, 9), 5); });
test("zero is a value", () => { assert.equal(orDefault(0, 9), 0); });
test("null falls back", () => { assert.equal(orDefault(null, 9), 9); });
test("strict", () => { assert.equal(orDefaultStrict(0, 9), 0); });
test("pick", () => { assert.equal(pickFirst([], 9), 9); });
test("truthy", () => { assert.equal(countTruthy([0, 1]), 1); });
