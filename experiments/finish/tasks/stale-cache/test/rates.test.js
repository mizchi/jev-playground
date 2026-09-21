import { test } from "node:test";
import assert from "node:assert/strict";
import { convert, rates } from "../src/rates.js";

test("the rates are the current ones", () => {
  assert.equal(rates().jpy, 157);
  assert.equal(rates().eur, 0.92);
});

test("conversion uses them", () => {
  assert.equal(convert(10, "jpy"), 1570);
});
