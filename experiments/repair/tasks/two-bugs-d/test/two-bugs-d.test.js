import { test } from "node:test";
import assert from "node:assert/strict";
import { csvRow, csv } from "../src/two-bugs-d.js";
test("row", () => { assert.equal(csvRow(["a", "b"]), "a,b"); });
test("table", () => { assert.equal(csv([["a"], ["b"]]), "a\nb"); });
