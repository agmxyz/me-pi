import assert from "node:assert/strict";
import { test } from "node:test";
import { createProduct, DEFAULT_REORDER_AT, renameProduct } from "../src/product.ts";
import { errorOf, noError } from "./helpers.ts";

test("createProduct parses the price and defaults the reorder level", () => {
	assert.deepEqual(createProduct({ sku: "abc-0001", name: " Widget ", price: "2.50" }, noError), {
		sku: "ABC-0001",
		name: "Widget",
		priceCents: 250,
		reorderAt: DEFAULT_REORDER_AT,
	});
});

test("createProduct takes a price in cents and an explicit reorder level", () => {
	assert.equal(createProduct({ sku: "ABC-0001", name: "W", price: 99, reorderAt: 0 }, noError)?.reorderAt, 0);
});

test("createProduct refuses a bad name, price, or reorder level", () => {
	assert.equal(
		errorOf((e) => createProduct({ sku: "ABC-0001", name: " ", price: 1 }, e)),
		"BAD_NAME",
	);
	assert.equal(
		errorOf((e) => createProduct({ sku: "ABC-0001", name: "x".repeat(41), price: 1 }, e)),
		"BAD_NAME",
	);
	assert.equal(
		errorOf((e) => createProduct({ sku: "ABC-0001", name: "W", price: 0 }, e)),
		"BAD_MONEY",
	);
	assert.equal(
		errorOf((e) => createProduct({ sku: "ABC-0001", name: "W", price: "x" }, e)),
		"BAD_MONEY",
	);
	assert.equal(
		errorOf((e) => createProduct({ sku: "ABC-0001", name: "W", price: 1, reorderAt: -1 }, e)),
		"BAD_QUANTITY",
	);
});

test("renameProduct trims the new name and refuses an empty one", () => {
	const p = createProduct({ sku: "ABC-0001", name: "W", price: 1 }, noError)!;
	assert.equal(renameProduct(p, " Gadget ", noError), true);
	assert.equal(p.name, "Gadget");
	assert.equal(
		errorOf((e) => renameProduct(p, "", e)),
		"BAD_NAME",
	);
	assert.equal(p.name, "Gadget");
});
