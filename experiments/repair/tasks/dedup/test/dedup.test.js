import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeBy, groupBy, countBy } from "../src/dedup.js";
const id = (x) => x.id;
test("keeps the first of each", () => {
  assert.deepEqual(dedupeBy([{ id: 1 }, { id: 1 }, { id: 2 }], id), [{ id: 1 }, { id: 2 }]);
});
test("group", () => { assert.deepEqual(groupBy([{ id: 1 }], id), { 1: [{ id: 1 }] }); });
test("count", () => { assert.deepEqual(countBy([{ id: 1 }, { id: 1 }], id), { 1: 2 }); });
