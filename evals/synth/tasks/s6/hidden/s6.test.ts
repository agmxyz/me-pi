import assert from "node:assert/strict";
import { test } from "node:test";
import { CODES } from "../src/discount.ts";
import { addProduct, emptyInventory, receive } from "../src/inventory.ts";
import { addLine, applyDiscount, createOrder, emptyBook, orderTotals, placeOrder, shipOrder } from "../src/orders.ts";
import { orderStatusReport, taxReport } from "../src/report.ts";
import { emptyState } from "../src/store.ts";
import { cli, noError } from "./helpers.ts";

function priced(unitCents: number, qty: number, code?: string) {
	const inv = emptyInventory();
	addProduct(inv, { sku: "ABC-0001", name: "Widget", price: unitCents }, noError);
	const order = createOrder(emptyBook(), "Ada", noError)!;
	addLine(inv, order, "ABC-0001", qty, noError);
	if (code) applyDiscount(order, CODES[code], noError);
	return orderTotals(order);
}

test("a percent code lowers the taxable amount; no code taxes the full subtotal", () => {
	assert.deepEqual(priced(1000, 10, "SAVE10"), { subtotal: 10000, discount: 1000, tax: 720, total: 9720 });
	assert.deepEqual(priced(1000, 2, "SAVE15"), { subtotal: 2000, discount: 300, tax: 136, total: 1836 });
	assert.deepEqual(priced(1000, 3), { subtotal: 3000, discount: 0, tax: 240, total: 3240 });
});

test("a fixed code lowers the taxable amount, and a fully discounted order has no tax", () => {
	assert.deepEqual(priced(1000, 1, "FIVEOFF"), { subtotal: 1000, discount: 500, tax: 40, total: 540 });
	assert.deepEqual(priced(300, 1, "FIVEOFF"), { subtotal: 300, discount: 300, tax: 0, total: 0 });
});

test("tax on the discounted amount rounds half up to the cent", () => {
	// 1005 - 101 = 904 taxable; 8% of it is 72.32
	assert.deepEqual(priced(1005, 1, "SAVE10"), { subtotal: 1005, discount: 101, tax: 72, total: 976 });
});

test("order show prints the tax and total of a discounted order", (t) => {
	const inv = cli(t);
	inv.run("add", "ABC-0001", "Widget", "10");
	inv.run("order", "new", "Ada");
	inv.run("order", "add", "O-0001", "ABC-0001", "1");
	inv.run("order", "discount", "O-0001", "FIVEOFF");
	assert.equal(
		inv.run("order", "show", "O-0001").out,
		"O-0001  Ada  draft\n  ABC-0001  x1  $10.00\n  subtotal $10.00\n  discount -$5.00 (FIVEOFF)\n  tax $0.40\n  total $5.40",
	);
});

test("the tax report taxes the taxable amount, and order status totals agree", () => {
	const state = emptyState();
	const { inventory: inv, book } = state;
	addProduct(inv, { sku: "ABC-0001", name: "Widget", price: 1000 }, noError);
	receive(inv, "ABC-0001", 20, noError);
	const order = createOrder(book, "Ada", noError)!;
	addLine(inv, order, "ABC-0001", 10, noError);
	applyDiscount(order, CODES.SAVE10, noError);
	placeOrder(inv, order, noError);
	shipOrder(inv, order, noError);
	assert.deepEqual(taxReport(state), [{ orderId: "O-0001", taxable: 9000, tax: 720 }]);
	const shipped = orderStatusReport(state).find((r) => r.status === "shipped")!;
	assert.equal(shipped.cents, 9720);
});
