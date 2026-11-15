import assert from "node:assert/strict";
import { test } from "node:test";
import { checkout } from "../src/checkout.js";

test("checkout without coupon adds tax", () => {
	assert.equal(checkout([{ price: 100, qty: 1 }]), 108.25);
});

test("checkout with coupon", () => {
	assert.equal(checkout([{ price: 100, qty: 2 }], "SPRING10"), 194.85);
});
