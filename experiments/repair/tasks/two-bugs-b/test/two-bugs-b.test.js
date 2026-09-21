import { test } from "node:test";
import assert from "node:assert/strict";
import { titleCase, initialsOf, wordCount } from "../src/two-bugs-b.js";
test("title", () => { assert.equal(titleCase("ada lovelace"), "Ada Lovelace"); });
test("initials", () => { assert.equal(initialsOf("ada lovelace"), "a.l"); });
test("words", () => { assert.equal(wordCount("a b c"), 3); });
