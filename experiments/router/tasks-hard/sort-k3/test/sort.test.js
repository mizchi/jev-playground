import { test } from "node:test";
import assert from "node:assert/strict";
import { ascending, descending, byLength, median } from "../src/sort.js";
test("ascending", () => { assert.deepEqual(ascending([3, 1, 2]), [1, 2, 3]); });
test("descending", () => { assert.deepEqual(descending([1, 3, 2]), [3, 2, 1]); });
test("by length", () => { assert.deepEqual(byLength(["abc", "a"]), ["a", "abc"]); });
test("median", () => { assert.equal(median([5, 1, 3]), 3); });
