import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { USAGE } from "../src/cli.ts";
import { cli } from "./helpers.ts";

/** A CLI with ABC-0001 at 10 on hand and 4 reserved by placed order O-0001. */
function stocked(t: Parameters<typeof cli>[0]) {
	const inv = cli(t);
	inv.run("add", "ABC-0001", "Widget", "2.50");
	inv.run("receive", "ABC-0001", "10");
	inv.run("order", "new", "Ada");
	inv.run("order", "add", "O-0001", "ABC-0001", "4");
	inv.run("order", "place", "O-0001");
	return inv;
}

const stockOf = (file: string) => JSON.parse(readFileSync(file, "utf8")).inventory.stock["ABC-0001"];

test("s2: count sets on-hand units, keeps reservations, and prints old and new", (t) => {
	const inv = stocked(t);
	const result = inv.run("count", "abc-0001", "7");
	assert.deepEqual(result, { code: 0, out: "ABC-0001 on hand: 7 (was 10)", err: "" });
	assert.deepEqual(stockOf(inv.file), { onHand: 7, reserved: 4 });
	assert.equal(inv.run("count", "ABC-0001", "12").out, "ABC-0001 on hand: 12 (was 7)");
	assert.match(inv.run("report", "stock").out, /^ABC-0001\s+Widget\s+12\s+4\s+8\s/m);
});

test("s2: a count of zero is valid, and a count equal to the reserved units is allowed", (t) => {
	const inv = cli(t);
	inv.run("add", "ABC-0001", "Widget", "2.50");
	inv.run("receive", "ABC-0001", "3");
	assert.equal(inv.run("count", "ABC-0001", "0").out, "ABC-0001 on hand: 0 (was 3)");
	assert.equal(inv.run("low").out, "ABC-0001");
	const placed = stocked(t);
	assert.equal(placed.run("count", "ABC-0001", "4").code, 0);
	assert.deepEqual(stockOf(placed.file), { onHand: 4, reserved: 4 });
});

test("s2: a count below the reserved units fails and leaves the file unchanged", (t) => {
	const inv = stocked(t);
	const before = readFileSync(inv.file, "utf8");
	const result = inv.run("count", "ABC-0001", "3");
	assert.equal(result.code, 1);
	assert.equal(result.out, "");
	assert.match(result.err, /^error: INSUFFICIENT_STOCK: /);
	assert.equal(readFileSync(inv.file, "utf8"), before);
});

test("s2: bad counts, unknown SKUs, and wrong arguments fail without touching the file", (t) => {
	const inv = stocked(t);
	const before = readFileSync(inv.file, "utf8");
	for (const bad of ["-1", "1.5", "x"]) {
		const result = inv.run("count", "ABC-0001", bad);
		assert.equal(result.code, 1, bad);
		assert.match(result.err, /^error: BAD_QUANTITY: /, bad);
	}
	const unknown = inv.run("count", "XYZ-9999", "1");
	assert.equal(unknown.code, 1);
	assert.match(unknown.err, /^error: UNKNOWN_SKU: /);
	assert.deepEqual(inv.run("count", "ABC-0001"), { code: 2, out: "", err: USAGE });
	assert.equal(inv.run("count", "ABC-0001", "1", "2").code, 2);
	assert.equal(readFileSync(inv.file, "utf8"), before);
});

test("s2: USAGE and docs/cli.md list count right after receive", () => {
	const doc = readFileSync(new URL("../docs/cli.md", import.meta.url), "utf8");
	assert.match(USAGE, /^ {2}receive <sku> <qty>[^\n]*\n {2}count <sku> <qty> /m);
	assert.match(doc, /^\| `receive <sku> <qty>` \|[^\n]*\n\| `count <sku> <qty>` \|/m);
});
