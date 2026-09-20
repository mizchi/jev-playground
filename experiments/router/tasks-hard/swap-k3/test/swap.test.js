import { test } from "node:test";
import assert from "node:assert/strict";
import { between, outside, overlaps } from "../src/swap.js";
test("inside", () => { assert.equal(between(3, 0, 5), true); });
test("outside", () => { assert.equal(between(9, 0, 5), false); });
test("negation", () => { assert.equal(outside(9, 0, 5), true); });
test("overlaps", () => { assert.equal(overlaps(0, 5, 3, 9), true); });
test("disjoint", () => { assert.equal(overlaps(0, 2, 5, 9), false); });
