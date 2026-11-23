import assert from "node:assert/strict";
import { test } from "node:test";
import { CODES } from "../src/discount.ts";
import { addProduct, available, emptyInventory, receive } from "../src/inventory.ts";
import {
	addLine,
	applyDiscount,
	cancelOrder,
	createOrder,
	emptyBook,
	findOrder,
	orderTotals,
	placeOrder,
	shipOrder,
} from "../src/orders.ts";
import { errorOf, noError } from "./helpers.ts";

function shop() {
	const inv = emptyInventory();
	addProduct(inv, { sku: "ABC-0001", name: "Widget", price: 1000 }, noError);
	addProduct(inv, { sku: "ABC-0002", name: "Gadget", price: 2500 }, noError);
	receive(inv, "ABC-0001", 10, noError);
	receive(inv, "ABC-0002", 2, noError);
	const book = emptyBook();
	const order = createOrder(book, "Ada", noError)!;
	return { inv, book, order };
}

test("createOrder numbers orders and findOrder finds them in any case", () => {
	const { book, order } = shop();
	assert.equal(order.id, "O-0001");
	assert.equal(createOrder(book, "Bo", noError)!.id, "O-0002");
	assert.equal(findOrder(book, "o-0001", noError), order);
	assert.equal(
		errorOf((e) => findOrder(book, "O-0099", e)),
		"UNKNOWN_ORDER",
	);
	assert.equal(
		errorOf((e) => createOrder(book, "  ", e)),
		"BAD_NAME",
	);
});

test("addLine merges a repeated SKU and keeps the price at the time it was added", () => {
	const { inv, order } = shop();
	addLine(inv, order, "abc-0001", 2, noError);
	inv.products["ABC-0001"].priceCents = 9999;
	addLine(inv, order, "ABC-0001", 1, noError);
	assert.deepEqual(order.lines, [{ sku: "ABC-0001", qty: 3, unitCents: 1000 }]);
});

test("orderTotals adds 8% tax to an undiscounted order", () => {
	const { inv, order } = shop();
	addLine(inv, order, "ABC-0001", 2, noError);
	assert.deepEqual(orderTotals(order), { subtotal: 2000, discount: 0, tax: 160, total: 2160 });
});

test("orderTotals taxes a percent-discounted order on the subtotal less the discount", () => {
	const { inv, order } = shop();
	addLine(inv, order, "ABC-0001", 10, noError);
	applyDiscount(order, CODES.SAVE10, noError);
	assert.deepEqual(orderTotals(order), { subtotal: 10000, discount: 1000, tax: 720, total: 9720 });
});

test("orderTotals taxes a fixed-discounted order on the subtotal less the discount", () => {
	const { inv, order } = shop();
	addLine(inv, order, "ABC-0001", 1, noError);
	applyDiscount(order, CODES.FIVEOFF, noError);
	assert.deepEqual(orderTotals(order), { subtotal: 1000, discount: 500, tax: 40, total: 540 });
});

test("placeOrder reserves every line or none", () => {
	const { inv, order } = shop();
	addLine(inv, order, "ABC-0001", 4, noError);
	addLine(inv, order, "ABC-0002", 3, noError);
	assert.equal(
		errorOf((e) => placeOrder(inv, order, e)),
		"INSUFFICIENT_STOCK",
	);
	assert.equal(available(inv, "ABC-0001"), 10);
	assert.equal(order.status, "draft");
});

test("placeOrder refuses an empty order", () => {
	const { inv, order } = shop();
	assert.equal(
		errorOf((e) => placeOrder(inv, order, e)),
		"EMPTY_ORDER",
	);
});

test("a placed order cannot change, and ships its reserved units", () => {
	const { inv, order } = shop();
	addLine(inv, order, "ABC-0001", 4, noError);
	assert.equal(placeOrder(inv, order, noError), true);
	assert.equal(available(inv, "ABC-0001"), 6);
	assert.equal(
		errorOf((e) => addLine(inv, order, "ABC-0001", 1, e)),
		"BAD_TRANSITION",
	);
	assert.equal(
		errorOf((e) => applyDiscount(order, CODES.SAVE10, e)),
		"BAD_TRANSITION",
	);
	assert.equal(shipOrder(inv, order, noError), true);
	assert.deepEqual(inv.stock["ABC-0001"], { onHand: 6, reserved: 0 });
	assert.equal(
		errorOf((e) => shipOrder(inv, order, e)),
		"BAD_TRANSITION",
	);
});

test("cancelling a placed order releases its reservations; a shipped one cannot be cancelled", () => {
	const { inv, book, order } = shop();
	addLine(inv, order, "ABC-0001", 4, noError);
	placeOrder(inv, order, noError);
	assert.equal(cancelOrder(inv, order, noError), true);
	assert.equal(available(inv, "ABC-0001"), 10);
	assert.equal(
		errorOf((e) => cancelOrder(inv, order, e)),
		"BAD_TRANSITION",
	);
	const other = createOrder(book, "Bo", noError)!;
	addLine(inv, other, "ABC-0001", 1, noError);
	placeOrder(inv, other, noError);
	shipOrder(inv, other, noError);
	assert.equal(
		errorOf((e) => cancelOrder(inv, other, e)),
		"BAD_TRANSITION",
	);
});

test("a draft order cannot ship", () => {
	const { inv, order } = shop();
	addLine(inv, order, "ABC-0001", 1, noError);
	assert.equal(
		errorOf((e) => shipOrder(inv, order, e)),
		"BAD_TRANSITION",
	);
});
