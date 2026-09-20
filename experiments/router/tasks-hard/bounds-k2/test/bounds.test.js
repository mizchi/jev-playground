import { test } from "node:test";
import assert from "node:assert/strict";
import { slice, firstN, lastN, window } from "../src/bounds.js";
test("slice is exclusive", () => { assert.deepEqual(slice([1, 2, 3, 4], 1, 3), [2, 3]); });
test("first", () => { assert.deepEqual(firstN([1, 2, 3], 2), [1, 2]); });
test("last", () => { assert.deepEqual(lastN([1, 2, 3], 2), [2, 3]); });
test("window", () => { assert.deepEqual(window([1, 2, 3, 4], 1, 2), [2, 3]); });
