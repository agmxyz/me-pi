import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPrice, parsePrice } from "../src/price.js";

test("formatPrice shows two decimals and thousands separators", () => {
	assert.equal(formatPrice(12.5), "12.50");
	assert.equal(formatPrice(1234.5), "1,234.50");
	assert.equal(formatPrice(1234567.5), "1,234,567.50");
});

test("parsePrice accepts thousands separators", () => {
	assert.equal(parsePrice("1,234.50"), 1234.5);
});

test("parsePrice rejects garbage", () => {
	assert.throws(() => parsePrice("abc"));
	assert.throws(() => parsePrice(""));
});
