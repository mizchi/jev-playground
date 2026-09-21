import { test } from "node:test";
import assert from "node:assert/strict";
import { counts, keysOf, totalOf, mostCommon } from "../src/accumulate.js";
test("counts", () => { assert.deepEqual(counts(["a", "a", "b"]), { a: 2, b: 1 }); });
test("keys", () => { assert.deepEqual(keysOf({ b: 1, a: 1 }), ["a", "b"]); });
test("total", () => { assert.equal(totalOf({ a: 2, b: 1 }), 3); });
test("most common", () => { assert.equal(mostCommon(["a", "b", "b"]), "b"); });
