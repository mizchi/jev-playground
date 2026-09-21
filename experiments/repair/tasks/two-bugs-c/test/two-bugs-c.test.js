import { test } from "node:test";
import assert from "node:assert/strict";
import { paginate, pageCount, pageOf } from "../src/two-bugs-c.js";
test("first page", () => { assert.deepEqual(paginate([1, 2, 3, 4, 5], 0, 2), [1, 2]); });
test("second page", () => { assert.deepEqual(paginate([1, 2, 3, 4, 5], 1, 2), [3, 4]); });
test("page count rounds up", () => { assert.equal(pageCount([1, 2, 3], 2), 2); });
test("page of", () => { assert.equal(pageOf(3, 2), 1); });
