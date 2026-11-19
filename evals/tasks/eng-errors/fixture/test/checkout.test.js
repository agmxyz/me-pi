import assert from "node:assert/strict";
import { test } from "node:test";
import { total } from "../src/checkout.js";

test("total adds weight-based shipping", () => {
	assert.equal(total({ subtotal: 20, weightKg: 2 }), 27);
});
