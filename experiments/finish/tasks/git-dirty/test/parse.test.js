import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePairs } from "../src/parse.js";

test("pairs parse", () => {
  assert.deepEqual(parsePairs("a=1;b=2"), { a: "1", b: "2" });
});

test("values may contain =", () => {
  assert.deepEqual(parsePairs("q=a=b"), { q: "a=b" });
});

test("whitespace is trimmed", () => {
  assert.deepEqual(parsePairs(" a = 1 ; b = 2 "), { a: "1", b: "2" });
});
