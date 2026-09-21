import { test } from "node:test";
import assert from "node:assert/strict";
import { usable, present, allUsable, firstUsable } from "../src/andor.js";
test("a value", () => { assert.equal(usable(1), true); });
test("null", () => { assert.equal(usable(null), false); });
test("undefined", () => { assert.equal(usable(undefined), false); });
test("present", () => { assert.equal(present(0), true); });
test("all", () => { assert.equal(allUsable([1, null]), false); });
test("first", () => { assert.equal(firstUsable([null, 2]), 2); });
