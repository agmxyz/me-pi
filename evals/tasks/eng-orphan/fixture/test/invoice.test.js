import assert from "node:assert/strict";
import { test } from "node:test";
import { invoiceSummary } from "../src/invoice.js";

test("invoice summary shows the amount due and tax rate", () => {
	const invoice = { id: "A7", taxRate: 0.08, items: [{ amount: 1000 }, { amount: 250 }] };
	assert.equal(invoiceSummary(invoice), "Invoice A7: $1,250.00 due (tax 8% included)");
});
