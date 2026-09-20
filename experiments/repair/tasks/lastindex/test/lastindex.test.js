import { test } from "node:test";
import assert from "node:assert/strict";
import { last, first, penultimate, rotate } from "../src/lastindex.js";
test("last", () => { assert.equal(last([1, 2, 3]), 3); });
test("one", () => { assert.equal(last([9]), 9); });
test("first", () => { assert.equal(first([1, 2]), 1); });
test("penultimate", () => { assert.equal(penultimate([1, 2, 3]), 2); });
test("rotate", () => { assert.deepEqual(rotate([1, 2, 3]), [3, 1, 2]); });
