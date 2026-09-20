import { test } from "node:test";
import assert from "node:assert/strict";
import { nameOf, emailOf, initials, describe } from "../src/guard.js";
test("trims", () => { assert.equal(nameOf({ name: " a " }), "a"); });
test("missing name", () => { assert.equal(nameOf({}), ""); });
test("email", () => { assert.equal(emailOf({ email: "A@B" }), "a@b"); });
test("initials", () => { assert.equal(initials({ name: "ada l" }), "AL"); });
test("describe falls back", () => { assert.equal(describe({}), "anonymous"); });
