import assert from "node:assert/strict";
import { test } from "node:test";
import { addProduct, emptyInventory, isLowStock, lowStock, receive, reserve } from "../src/inventory.ts";
import { cli, noError } from "./helpers.ts";

function withStock(onHand: number, reorderAt: number) {
	const inv = emptyInventory();
	addProduct(inv, { sku: "ABC-0001", name: "Widget", price: 250, reorderAt }, noError);
	receive(inv, "ABC-0001", onHand, noError);
	return inv;
}

test("s1: a product exactly at its reorder level is low; one unit above is not", () => {
	assert.equal(isLowStock(withStock(3, 3), "ABC-0001"), true);
	assert.equal(isLowStock(withStock(4, 3), "ABC-0001"), false);
	assert.equal(isLowStock(withStock(1, 3), "ABC-0001"), true);
});

test("s1: reservations that bring available units down to the level make a product low", () => {
	const inv = withStock(8, 3);
	assert.equal(isLowStock(inv, "ABC-0001"), false);
	reserve(inv, "ABC-0001", 5, noError);
	assert.equal(isLowStock(inv, "ABC-0001"), true);
	assert.deepEqual(
		lowStock(inv).map((p) => p.sku),
		["ABC-0001"],
	);
});

test("s1: inv low and inv report low list a product at its reorder level", (t) => {
	const inv = cli(t);
	inv.run("add", "ABC-0001", "Widget", "2.50", "--reorder", "3");
	inv.run("receive", "ABC-0001", "3");
	assert.deepEqual(inv.run("low"), { code: 0, out: "ABC-0001", err: "" });
	assert.match(inv.run("report", "low").out, /^ABC-0001\s+Widget\s/m);
	inv.run("receive", "ABC-0001", "1");
	assert.equal(inv.run("low").out, "nothing to restock");
});
