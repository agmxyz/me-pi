import assert from "node:assert/strict";
import { test } from "node:test";
import { CODES } from "../src/discount.ts";
import { addProduct, receive } from "../src/inventory.ts";
import { addLine, applyDiscount, cancelOrder, createOrder, placeOrder, shipOrder } from "../src/orders.ts";
import {
	averageOrderValue,
	categoryOf,
	customerReport,
	discountUsageReport,
	lowStockReport,
	openOrdersReport,
	orderStatusReport,
	REPORTS,
	reservationsReport,
	runReport,
	salesByCategory,
	salesByCustomer,
	salesByProduct,
	stockReport,
	table,
	taxReport,
	topProducts,
} from "../src/report.ts";
import { emptyState, type State } from "../src/store.ts";
import { errorOf, noError } from "./helpers.ts";

/** Ada: one shipped order with a code; Bo: one shipped, one placed; Cy: one cancelled. */
function sample(): State {
	const state = emptyState();
	const { inventory: inv, book } = state;
	addProduct(inv, { sku: "ABC-0001", name: "Widget", price: 1000 }, noError);
	addProduct(inv, { sku: "ABC-0002", name: "Gadget", price: 2500 }, noError);
	addProduct(inv, { sku: "XYZ-0001", name: "Doohickey", price: 400, reorderAt: 1 }, noError);
	receive(inv, "ABC-0001", 20, noError);
	receive(inv, "ABC-0002", 5, noError);
	receive(inv, "XYZ-0001", 3, noError);
	const order = (customer: string, lines: [string, number][], end: "ship" | "place" | "cancel", code?: string) => {
		const o = createOrder(book, customer, noError)!;
		for (const [sku, qty] of lines) addLine(inv, o, sku, qty, noError);
		if (code) applyDiscount(o, CODES[code], noError);
		placeOrder(inv, o, noError);
		if (end === "ship") shipOrder(inv, o, noError);
		if (end === "cancel") cancelOrder(inv, o, noError);
	};
	order(
		"Ada",
		[
			["ABC-0001", 3],
			["XYZ-0001", 1],
		],
		"ship",
		"SAVE10",
	);
	order("Bo", [["ABC-0002", 2]], "ship");
	order("Bo", [["ABC-0001", 5]], "place");
	order("Cy", [["ABC-0002", 1]], "cancel");
	return state;
}

test("table aligns columns and shows (none) for no rows", () => {
	const cols = [
		{ title: "A", align: "left" as const, cell: (r: string[]) => r[0] },
		{ title: "Num", align: "right" as const, cell: (r: string[]) => r[1] },
	];
	assert.equal(
		table(cols, [
			["x", "1"],
			["yy", "22"],
		]),
		"A   Num\n--  ---\nx     1\nyy   22",
	);
	assert.equal(table(cols, []), "A  Num\n-  ---\n(none)");
});

test("salesByProduct counts shipped orders only, highest revenue first", () => {
	assert.deepEqual(salesByProduct(sample()), [
		{ sku: "ABC-0002", name: "Gadget", units: 2, cents: 5000 },
		{ sku: "ABC-0001", name: "Widget", units: 3, cents: 3000 },
		{ sku: "XYZ-0001", name: "Doohickey", units: 1, cents: 400 },
	]);
});

test("salesByCustomer and topProducts rank by revenue", () => {
	assert.deepEqual(salesByCustomer(sample()), [
		{ customer: "Bo", orders: 1, cents: 5000 },
		{ customer: "Ada", orders: 1, cents: 3400 },
	]);
	assert.deepEqual(
		topProducts(sample()).map((r) => r.label),
		["ABC-0002 Gadget", "ABC-0001 Widget", "XYZ-0001 Doohickey"],
	);
});

test("salesByCategory groups by SKU prefix with each category's share", () => {
	assert.equal(categoryOf("XYZ-0001"), "XYZ");
	const rows = salesByCategory(sample());
	assert.deepEqual(
		rows.map((r) => [r.category, r.cents, r.share.toFixed(1)]),
		[
			["ABC", 8000, "95.2"],
			["XYZ", 400, "4.8"],
		],
	);
});

test("averageOrderValue divides shipped revenue by shipped orders", () => {
	assert.deepEqual(averageOrderValue(sample()), [{ orders: 2, cents: 8400, average: 4200 }]);
});

test("stockReport and lowStockReport read on-hand, reserved, and available units", () => {
	const state = sample();
	assert.deepEqual(
		stockReport(state).map((r) => [r.sku, r.onHand, r.reserved, r.available]),
		[
			["ABC-0001", 17, 5, 12],
			["ABC-0002", 3, 0, 3],
			["XYZ-0001", 2, 0, 2],
		],
	);
	assert.deepEqual(
		lowStockReport(state).map((r) => [r.sku, r.shortfall]),
		[["ABC-0002", 2]],
	);
});

test("order status, open orders, and reservations", () => {
	const state = sample();
	assert.deepEqual(
		orderStatusReport(state).map((r) => [r.status, r.orders]),
		[
			["draft", 0],
			["placed", 1],
			["shipped", 2],
			["cancelled", 1],
		],
	);
	assert.deepEqual(
		openOrdersReport(state).map((r) => r.id),
		["O-0003"],
	);
	assert.deepEqual(reservationsReport(state), [{ sku: "ABC-0001", orderId: "O-0003", customer: "Bo", qty: 5 }]);
});

test("customerReport counts each customer's orders by state", () => {
	assert.deepEqual(
		customerReport(sample()).map((r) => [r.customer, r.open, r.shipped, r.cancelled, r.cents]),
		[
			["Bo", 1, 1, 0, 5000],
			["Ada", 0, 1, 0, 3400],
			["Cy", 0, 0, 1, 0],
		],
	);
});

test("discountUsageReport and taxReport read shipped orders", () => {
	const state = sample();
	assert.deepEqual(discountUsageReport(state), [{ code: "SAVE10", orders: 1, cents: 340 }]);
	assert.deepEqual(
		taxReport(state).map((r) => r.orderId),
		["O-0001", "O-0002"],
	);
});

test("runReport titles every registered report and refuses an unknown name", () => {
	const state = sample();
	for (const [name, r] of Object.entries(REPORTS))
		assert.ok(runReport(name, state, noError)?.startsWith(r.title), name);
	assert.equal(
		errorOf((e) => runReport("nope", state, e)),
		"BAD_ARGS",
	);
});
