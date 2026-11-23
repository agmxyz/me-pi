import assert from "node:assert/strict";
import { test } from "node:test";
import { invoiceLine } from "../src/invoice.js";

test("invoiceLine shows name and total", () => {
	assert.equal(invoiceLine("Tea", ["2", "3"]), "Tea: $5");
});
