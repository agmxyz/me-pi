import assert from "node:assert/strict";
import { test } from "node:test";
import {
	addProduct,
	available,
	emptyInventory,
	findProduct,
	isLowStock,
	lowStock,
	receive,
	release,
	reserve,
	ship,
	stockValue,
} from "../src/inventory.ts";
import { errorOf, noError } from "./helpers.ts";

function stocked(onHand = 10) {
	const inv = emptyInventory();
	addProduct(inv, { sku: "ABC-0001", name: "Widget", price: 250, reorderAt: 3 }, noError);
	if (onHand) receive(inv, "ABC-0001", onHand, noError);
	return inv;
}

test("addProduct starts a product with no stock and refuses a duplicate SKU", () => {
	const inv = stocked(0);
	assert.deepEqual(inv.stock["ABC-0001"], { onHand: 0, reserved: 0 });
	assert.equal(
		errorOf((e) => addProduct(inv, { sku: "abc-0001", name: "Again", price: 1 }, e)),
		"DUPLICATE_SKU",
	);
});

test("findProduct normalizes the SKU and reports an unknown one", () => {
	const inv = stocked();
	assert.equal(findProduct(inv, " abc-0001", noError)?.name, "Widget");
	assert.equal(
		errorOf((e) => findProduct(inv, "XYZ-9999", e)),
		"UNKNOWN_SKU",
	);
});

test("receive adds to on-hand stock and refuses a bad quantity", () => {
	const inv = stocked();
	assert.equal(receive(inv, "ABC-0001", 5, noError), 15);
	assert.equal(
		errorOf((e) => receive(inv, "ABC-0001", 0, e)),
		"BAD_QUANTITY",
	);
	assert.equal(
		errorOf((e) => receive(inv, "ABC-0002", 1, e)),
		"UNKNOWN_SKU",
	);
});

test("reserve lowers available units and refuses more than are available", () => {
	const inv = stocked();
	assert.equal(reserve(inv, "ABC-0001", 4, noError), true);
	assert.equal(available(inv, "ABC-0001"), 6);
	assert.equal(
		errorOf((e) => reserve(inv, "ABC-0001", 7, e)),
		"INSUFFICIENT_STOCK",
	);
	assert.equal(available(inv, "ABC-0001"), 6);
});

test("release gives reserved units back and refuses more than are reserved", () => {
	const inv = stocked();
	reserve(inv, "ABC-0001", 4, noError);
	assert.equal(release(inv, "ABC-0001", 3, noError), true);
	assert.equal(available(inv, "ABC-0001"), 9);
	assert.equal(
		errorOf((e) => release(inv, "ABC-0001", 2, e)),
		"BAD_QUANTITY",
	);
});

test("ship takes units out of both the reservation and the warehouse", () => {
	const inv = stocked();
	reserve(inv, "ABC-0001", 4, noError);
	assert.equal(ship(inv, "ABC-0001", 4, noError), true);
	assert.deepEqual(inv.stock["ABC-0001"], { onHand: 6, reserved: 0 });
});

test("a product well below its reorder level is low; one well above is not", () => {
	const inv = stocked(1);
	assert.equal(isLowStock(inv, "ABC-0001"), true);
	receive(inv, "ABC-0001", 10, noError);
	assert.equal(isLowStock(inv, "ABC-0001"), false);
	assert.equal(isLowStock(inv, "XYZ-0001"), false);
});

test("a product exactly at its reorder level is low; one unit above is not", () => {
	assert.equal(isLowStock(stocked(3), "ABC-0001"), true);
	assert.equal(isLowStock(stocked(4), "ABC-0001"), false);
	const inv = stocked(8);
	reserve(inv, "ABC-0001", 5, noError);
	assert.equal(isLowStock(inv, "ABC-0001"), true);
});

test("lowStock lists low products by SKU", () => {
	const inv = stocked(0);
	addProduct(inv, { sku: "AAA-0001", name: "First", price: 100 }, noError);
	assert.deepEqual(
		lowStock(inv).map((p) => p.sku),
		["AAA-0001", "ABC-0001"],
	);
});

test("stockValue prices on-hand units at list price", () => {
	assert.equal(stockValue(stocked(4)), 1000);
});
