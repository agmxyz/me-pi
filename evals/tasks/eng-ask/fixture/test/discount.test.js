import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCodes } from "../src/discount.js";

test("no code leaves the subtotal", () => {
	assert.equal(applyCodes(80, []), 80);
});

test("one code takes its percent off", () => {
	assert.equal(applyCodes(100, ["SAVE20"]), 80);
});

test("unknown code is rejected", () => {
	assert.throws(() => applyCodes(100, ["FREE"]), /unknown discount code/);
});

test("more than one code is rejected", () => {
	assert.throws(() => applyCodes(100, ["SAVE10", "SAVE20"]), /only one discount code/);
});
