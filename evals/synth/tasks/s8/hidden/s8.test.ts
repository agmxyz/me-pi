import assert from "node:assert/strict";
import { test } from "node:test";
import { USAGE } from "../src/cli.ts";
import { CODES } from "../src/discount.ts";
import { addProduct, receive } from "../src/inventory.ts";
import { addLine, applyDiscount, cancelOrder, createOrder, placeOrder, shipOrder } from "../src/orders.ts";
import { runReport } from "../src/report.ts";
import { emptyState, type State } from "../src/store.ts";
import { noError } from "./helpers.ts";

/**
 * Widget: Ada (with SAVE10) and Bo twice, all shipped. Gizmo: Ed, shipped, then removed from the catalogue.
 * Doohickey: Ada, shipped. Gadget: placed by Cy, cancelled by Di, so never sold. Widget's price rises after the sales.
 */
function sample(): State {
	const state = emptyState();
	const { inventory: inv, book } = state;
	addProduct(inv, { sku: "ABC-0001", name: "Widget", price: 1000 }, noError);
	addProduct(inv, { sku: "ABC-0002", name: "Gadget", price: 2500 }, noError);
	addProduct(inv, { sku: "ABC-0003", name: "Gizmo", price: 200 }, noError);
	addProduct(inv, { sku: "XYZ-0001", name: "Doohickey", price: 400 }, noError);
	receive(inv, "ABC-0001", 20, noError);
	receive(inv, "ABC-0002", 5, noError);
	receive(inv, "ABC-0003", 5, noError);
	receive(inv, "XYZ-0001", 5, noError);
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
	order("Bo", [["ABC-0001", 1]], "ship");
	order("Bo", [["ABC-0001", 2]], "ship");
	order("Cy", [["ABC-0002", 2]], "place");
	order("Di", [["ABC-0002", 1]], "cancel");
	order("Ed", [["ABC-0003", 2]], "ship");
	inv.products["ABC-0001"].priceCents = 9999;
	inv.products = Object.fromEntries(Object.entries(inv.products).filter(([sku]) => sku !== "ABC-0003"));
	return state;
}

const lines = (state: State) => runReport("buyers", state, noError)!.split("\n");
const cells = (line: string) => line.trim().split(/ {2,}/);

test("the buyers report is titled and has the four columns", () => {
	const [title, blank, header, rule] = lines(sample());
	assert.equal(title, "Buyers by product");
	assert.equal(blank, "");
	assert.deepEqual(cells(header), ["SKU", "Product", "Buyers", "Revenue"]);
	assert.match(rule, /^-+ {2}-+ {2}-+ {2}-+$/);
});

test("the buyers report counts distinct customers and shipped revenue as sold, highest revenue first", () => {
	assert.deepEqual(lines(sample()).slice(4).map(cells), [
		["ABC-0001", "Widget", "2", "$60.00"],
		["ABC-0003", "(deleted)", "1", "$4.00"],
		["XYZ-0001", "Doohickey", "1", "$4.00"],
	]);
});

test("the buyers report right-aligns its figures", () => {
	const table = lines(sample()).slice(2);
	for (const line of table) assert.equal(line.length, table[0].length, JSON.stringify(line));
	const buyersEnd = table[0].indexOf("Buyers") + "Buyers".length;
	for (const line of table.slice(2)) assert.notEqual(line[buyersEnd - 1], " ", JSON.stringify(line));
});

test("the buyers report is an empty table with no sales, and help lists it", () => {
	assert.equal(lines(emptyState())[4], "(none)");
	assert.match(USAGE, /\bbuyers\b/);
});
