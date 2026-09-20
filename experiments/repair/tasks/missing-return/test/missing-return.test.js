import { test } from "node:test";
import assert from "node:assert/strict";
import { double, triple, scaleAll, sumOfDoubles } from "../src/missing-return.js";
test("doubles", () => { assert.equal(double(4), 8); });
test("zero", () => { assert.equal(double(0), 0); });
test("triples", () => { assert.equal(triple(2), 6); });
test("scale", () => { assert.deepEqual(scaleAll([1, 2], 3), [3, 6]); });
test("sum of doubles", () => { assert.equal(sumOfDoubles([1, 2]), 6); });
