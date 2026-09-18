import { test } from "node:test";
import assert from "node:assert/strict";
import { clamp, clampAll, inRange, spread } from "../src/clamp.js";
test("clamps above", () => { assert.equal(clamp(9, 0, 5), 5); });
test("clamps below", () => { assert.equal(clamp(-1, 0, 5), 0); });
test("passes through", () => { assert.equal(clamp(3, 0, 5), 3); });
test("all", () => { assert.deepEqual(clampAll([-1, 3, 9], 0, 5), [0, 3, 5]); });
test("range", () => { assert.equal(inRange(3, 0, 5), true); });
test("spread", () => { assert.equal(spread([2, 9, 4]), 7); });
