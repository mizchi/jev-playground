import { test } from "node:test";
import assert from "node:assert/strict";
import { drain } from "../src/queue.js";

test("the queue drains", () => {
  assert.deepEqual(drain([1, 2, 3]), [2, 4, 6]);
});
