import { test } from "node:test";
import assert from "node:assert/strict";
import { retryCount, backoffMs, shouldRetry } from "../src/two-bugs-e.js";
test("count", () => { assert.equal(retryCount(3), 3); });
test("backoff doubles", () => { assert.equal(backoffMs(3), 800); });
test("retry under the cap", () => { assert.equal(shouldRetry(1, 3), true); });
test("stop at the cap", () => { assert.equal(shouldRetry(3, 3), false); });
