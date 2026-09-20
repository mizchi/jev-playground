import { test } from "node:test";
import assert from "node:assert/strict";
import { squareOf } from "../src/squares.js";

test("the generated table is correct", () => {
  for (let i = 1; i <= 8; i += 1) assert.equal(squareOf(i), i * i);
});
