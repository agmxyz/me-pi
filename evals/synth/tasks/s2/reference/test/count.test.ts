import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { addProduct, available, emptyInventory, receive, recordCount, reserve } from "../src/inventory.ts";
import { parseCount } from "../src/sku.ts";
import { cli, errorOf, noError } from "./helpers.ts";

function stocked() {
	const inv = emptyInventory();
	addProduct(inv, { sku: "ABC-0001", name: "Widget", price: 250 }, noError);
	receive(inv, "ABC-0001", 10, noError);
	reserve(inv, "ABC-0001", 4, noError);
	return inv;
}

test("parseCount accepts zero and whole numbers, and refuses negatives, fractions, and text", () => {
	assert.equal(parseCount("0", noError), 0);
	assert.equal(parseCount(" 12 ", noError), 12);
	for (const bad of [-1, 1.5, "x", "-1", "2.0"])
		assert.equal(
			errorOf((e) => parseCount(bad, e)),
			"BAD_QUANTITY",
			String(bad),
		);
});

test("recordCount sets on-hand units, keeps reservations, and returns the old and new counts", () => {
	const inv = stocked();
	assert.deepEqual(recordCount(inv, "abc-0001", "7", noError), { sku: "ABC-0001", was: 10, onHand: 7 });
	assert.deepEqual(inv.stock["ABC-0001"], { onHand: 7, reserved: 4 });
	assert.equal(available(inv, "ABC-0001"), 3);
	assert.equal(recordCount(inv, "ABC-0001", 4, noError)?.onHand, 4);
});

test("recordCount refuses a count below the reserved units, an unknown SKU, and a bad count", () => {
	const inv = stocked();
	assert.equal(
		errorOf((e) => recordCount(inv, "ABC-0001", 3, e)),
		"INSUFFICIENT_STOCK",
	);
	assert.equal(
		errorOf((e) => recordCount(inv, "XYZ-9999", 1, e)),
		"UNKNOWN_SKU",
	);
	assert.equal(
		errorOf((e) => recordCount(inv, "ABC-0001", "-1", e)),
		"BAD_QUANTITY",
	);
	assert.deepEqual(inv.stock["ABC-0001"], { onHand: 10, reserved: 4 });
});

test("inv count prints the old and new counts and saves them; a failure leaves the file unchanged", (t) => {
	const inv = cli(t);
	inv.run("add", "ABC-0001", "Widget", "2.50");
	inv.run("receive", "ABC-0001", "3");
	assert.deepEqual(inv.run("count", "abc-0001", "0"), { code: 0, out: "ABC-0001 on hand: 0 (was 3)", err: "" });
	const before = readFileSync(inv.file, "utf8");
	assert.equal(JSON.parse(before).inventory.stock["ABC-0001"].onHand, 0);
	assert.deepEqual(inv.run("count", "ABC-0001", "x"), {
		code: 1,
		out: "",
		err: "error: BAD_QUANTITY: count must be a whole number, zero or more: x",
	});
	assert.equal(readFileSync(inv.file, "utf8"), before);
	assert.equal(inv.run("count", "ABC-0001").code, 2);
});
