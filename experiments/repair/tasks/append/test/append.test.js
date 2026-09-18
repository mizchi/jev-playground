import { test } from "node:test";
import assert from "node:assert/strict";
import { withItem, withoutItem, unique, head } from "../src/append.js";
test("returns the new array", () => { assert.deepEqual(withItem([1], 2), [1, 2]); });
test("does not mutate", () => { const a = [1]; withItem(a, 2); assert.deepEqual(a, [1]); });
test("without", () => { assert.deepEqual(withoutItem([1, 2], 1), [2]); });
test("unique", () => { assert.deepEqual(unique([1, 1, 2]), [1, 2]); });
test("head", () => { assert.deepEqual(head([1, 2, 3], 2), [1, 2]); });
