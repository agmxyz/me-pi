import assert from "node:assert/strict";
import { test } from "node:test";
import { CODES } from "../src/discount.ts";
import { addProduct, emptyInventory } from "../src/inventory.ts";
import { addLine, applyDiscount, createOrder, emptyBook, orderTotals } from "../src/orders.ts";
import { cli, noError } from "./helpers.ts";

function bulk(lines: [string, number][], code?: string) {
	const inv = emptyInventory();
	addProduct(inv, { sku: "ABC-0001", name: "Widget", price: 1000 }, noError);
	addProduct(inv, { sku: "ABC-0002", name: "Gadget", price: 2500 }, noError);
	const order = createOrder(emptyBook(), "Ada", noError)!;
	for (const [sku, qty] of lines) addLine(inv, order, sku, qty, noError);
	if (code) applyDiscount(order, CODES[code], noError);
	return order;
}

test("a single line of 10 or more units still gets no discount", () => {
	const totals = orderTotals(bulk([["ABC-0001", 12]]));
	assert.deepEqual(totals, { subtotal: 12000, discount: 0, tax: 960, total: 12960 });
});

test("an order of 10 or more units across lines still gets no discount", () => {
	const lines: [string, number][] = [
		["ABC-0001", 6],
		["ABC-0002", 4],
	];
	assert.deepEqual(orderTotals(bulk(lines)), { subtotal: 16000, discount: 0, tax: 1280, total: 17280 });
});

test("a bulk order with a code is discounted by the code alone", () => {
	assert.equal(orderTotals(bulk([["ABC-0001", 12]], "SAVE10")).discount, 1200);
	assert.equal(orderTotals(bulk([["ABC-0001", 12]], "FIVEOFF")).discount, 500);
});

test("order show prints no discount line for a bulk order without a code", (t) => {
	const inv = cli(t);
	inv.run("add", "ABC-0001", "Widget", "10");
	inv.run("order", "new", "Ada");
	inv.run("order", "add", "O-0001", "ABC-0001", "12");
	assert.equal(
		inv.run("order", "show", "O-0001").out,
		"O-0001  Ada  draft\n  ABC-0001  x12  $120.00\n  subtotal $120.00\n  tax $9.60\n  total $129.60",
	);
});
