import assert from "node:assert/strict";
import { test } from "node:test";
import { receiptLines } from "../src/receipt.js";

test("receipt has one line per item", () => {
	assert.equal(receiptLines([{ name: "Pen", amount: 2 }, { name: "Ink", amount: 3 }]).length, 2);
});
