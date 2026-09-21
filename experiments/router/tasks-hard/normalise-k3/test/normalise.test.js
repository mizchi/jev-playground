import { test } from "node:test";
import assert from "node:assert/strict";
import { normalise, scaleTo } from "../src/normalise.js";
test("normalises by the max", () => { assert.deepEqual(normalise([1, 2, 4]), [0.25, 0.5, 1]); });
test("all zero", () => { assert.deepEqual(normalise([0, 0]), [0, 0]); });
test("scales", () => { assert.deepEqual(scaleTo([1, 2], 10), [5, 10]); });
