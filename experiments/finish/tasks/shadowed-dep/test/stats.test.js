import { test } from "node:test";
import assert from "node:assert/strict";
import { summary } from "../src/stats.js";

test("summary computes real statistics", () => {
  assert.deepEqual(summary([1, 2, 3, 4]), { mean: 2.5, median: 2.5 });
});

test("and on an odd-length input", () => {
  assert.deepEqual(summary([5, 1, 3]), { mean: 3, median: 3 });
});
