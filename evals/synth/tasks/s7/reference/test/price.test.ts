import assert from "node:assert/strict";
import { test } from "node:test";
import { addProduct, emptyInventory } from "../src/inventory.ts";
import { addLine, createOrder, emptyBook, placeOrder, repriceOrder } from "../src/orders.ts";
import { setPrice } from "../src/product.ts";
import { cli, errorOf, noError } from "./helpers.ts";

test("setPrice changes the list price, returns the old one, and validates like add", () => {
	const inv = emptyInventory();
	const product = addProduct(inv, { sku: "ABC-0001", name: "Widget", price: "10" }, noError)!;
	assert.equal(setPrice(product, "12.50", noError), 1000);
	assert.equal(product.priceCents, 1250);
	for (const bad of ["0", "abc", "1.234", -1])
		assert.equal(
			errorOf((sink) => setPrice(product, bad, sink)),
			"BAD_MONEY",
		);
	assert.equal(product.priceCents, 1250);
});

test("repriceOrder updates a draft's lines and refuses a placed order", () => {
	const inv = emptyInventory();
	const product = addProduct(inv, { sku: "ABC-0001", name: "Widget", price: "10" }, noError)!;
	const order = createOrder(emptyBook(), "Ada", noError)!;
	addLine(inv, order, "ABC-0001", 2, noError);
	setPrice(product, "12", noError);
	assert.equal(order.lines[0].unitCents, 1000);
	assert.equal(repriceOrder(inv, order, noError), true);
	assert.deepEqual(order.lines, [{ sku: "ABC-0001", qty: 2, unitCents: 1200 }]);
	inv.stock["ABC-0001"].onHand = 5;
	placeOrder(inv, order, noError);
	assert.equal(
		errorOf((sink) => repriceOrder(inv, order, sink)),
		"BAD_TRANSITION",
	);
});

test("price and order reprice through the CLI", (t) => {
	const inv = cli(t);
	inv.run("add", "ABC-0001", "Widget", "10");
	inv.run("order", "new", "Ada");
	inv.run("order", "add", "O-0001", "ABC-0001", "1");
	assert.equal(inv.run("price", "ABC-0001", "12").out, "ABC-0001 price: $12.00 (was $10.00)");
	assert.match(inv.run("order", "reprice", "O-0001").out, /ABC-0001 {2}x1 {2}\$12\.00/);
});
