import { test } from "node:test";
import assert from "node:assert/strict";
import { sum, mean, runningTotal, maxOf } from "../src/sum.js";
test("sums", () => { assert.equal(sum([1, 2, 3]), 6); });
test("empty", () => { assert.equal(sum([]), 0); });
test("one", () => { assert.equal(sum([7]), 7); });
test("mean", () => { assert.equal(mean([2, 4]), 3); });
test("running", () => { assert.deepEqual(runningTotal([1, 2]), [1, 3]); });
test("max", () => { assert.equal(maxOf([1, 9, 4]), 9); });
