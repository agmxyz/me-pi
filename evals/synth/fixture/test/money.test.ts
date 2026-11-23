import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCents, parseMoney, percentOf, sum } from "../src/money.ts";
import { errorOf, noError } from "./helpers.ts";

test("formatCents pads cents and separates thousands", () => {
	assert.equal(formatCents(0), "$0.00");
	assert.equal(formatCents(5), "$0.05");
	assert.equal(formatCents(123456), "$1,234.56");
});

test("parseMoney reads whole and decimal amounts with an optional dollar sign", () => {
	assert.equal(parseMoney("12", noError), 1200);
	assert.equal(parseMoney("12.5", noError), 1250);
	assert.equal(parseMoney("$0.99", noError), 99);
});

test("parseMoney refuses signs, text, and more than two decimals", () => {
	for (const bad of ["-1", "abc", "1.234", ""])
		assert.equal(
			errorOf((e) => parseMoney(bad, e)),
			"BAD_MONEY",
			bad,
		);
});

test("percentOf rounds half up to the cent", () => {
	assert.equal(percentOf(1005, 10), 101);
	assert.equal(percentOf(999, 8), 80);
	assert.equal(sum([1, 2, 3]), 6);
});
