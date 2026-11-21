import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSku, parseQuantity, parseSku } from "../src/sku.ts";
import { errorOf, noError } from "./helpers.ts";

test("parseSku normalizes case and whitespace", () => {
	assert.equal(parseSku(" abc-1234 ", noError), "ABC-1234");
	assert.equal(normalizeSku("xyz-0001"), "XYZ-0001");
});

test("parseSku refuses malformed SKUs", () => {
	for (const bad of ["AB-1234", "ABCD-123", "ABC1234", "ABC-12a4"])
		assert.equal(
			errorOf((e) => parseSku(bad, e)),
			"BAD_SKU",
			bad,
		);
});

test("parseQuantity accepts positive whole numbers as text or number", () => {
	assert.equal(parseQuantity("3", noError), 3);
	assert.equal(parseQuantity(7, noError), 7);
});

test("parseQuantity refuses zero, negatives, fractions, and text", () => {
	for (const bad of [0, -2, 1.5, "x", "2.0"])
		assert.equal(
			errorOf((e) => parseQuantity(bad, e)),
			"BAD_QUANTITY",
			String(bad),
		);
});
