import { test } from "node:test";
import assert from "node:assert/strict";
import { total, firstOf, totalAll } from "../src/await.js";
test("awaits", async () => { assert.equal(await total(async () => [1, 2]), 2); });
test("first", async () => { assert.equal(await firstOf(async () => [7]), 7); });
test("all", async () => { assert.equal(await totalAll([async () => [1], async () => [2, 3]]), 3); });
