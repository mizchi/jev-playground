import { test } from "node:test";
import assert from "node:assert/strict";
import { isEmpty, isFull, firstOr, countNonEmpty } from "../src/negate.js";
test("empty", () => { assert.equal(isEmpty([]), true); });
test("not empty", () => { assert.equal(isEmpty([1]), false); });
test("full", () => { assert.equal(isFull([1, 2], 2), true); });
test("first or", () => { assert.equal(firstOr([], 9), 9); });
test("count", () => { assert.equal(countNonEmpty([[], [1]]), 1); });
