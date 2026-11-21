import assert from "node:assert/strict";
import { test } from "node:test";
import { CODES, discountAmount, parseDiscount } from "../src/discount.ts";
import { errorOf, noError } from "./helpers.ts";

test("parseDiscount accepts known codes in any case", () => {
	assert.equal(parseDiscount(" save10", noError)?.code, "SAVE10");
	assert.equal(
		errorOf((e) => parseDiscount("FREE", e)),
		"BAD_CODE",
	);
});

test("a percent code takes its share of the subtotal, rounded half up", () => {
	assert.equal(discountAmount(1005, CODES.SAVE10), 101);
	assert.equal(discountAmount(2000, CODES.SAVE15), 300);
});

test("a fixed code never takes more than the subtotal", () => {
	assert.equal(discountAmount(2000, CODES.FIVEOFF), 500);
	assert.equal(discountAmount(300, CODES.FIVEOFF), 300);
	assert.equal(discountAmount(300, undefined), 0);
});
