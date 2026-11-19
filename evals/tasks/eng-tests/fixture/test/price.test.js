import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPrice, parsePrice } from "../src/price.js";

test("formatPrice shows two decimals", () => {
	assert.equal(formatPrice(12.5), "12.50");
	assert.equal(formatPrice(1234.5), "1234.50");
});

test("parsePrice rejects garbage", () => {
	assert.throws(() => parsePrice("abc"));
	assert.throws(() => parsePrice(""));
});
