import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run, USAGE } from "../src/cli.ts";

type After = { after: (fn: () => void) => void };

function tempCli(t: After) {
	const dir = mkdtempSync(join(tmpdir(), "inv-s7-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "inventory.json");
	return { file, run: (...argv: string[]) => run(argv, file) };
}

test("price changes a product's list price and reports the old one", (t) => {
	const inv = tempCli(t);
	inv.run("add", "ABC-0001", "Widget", "10");
	assert.deepEqual(inv.run("price", "abc-0001", "12"), {
		code: 0,
		out: "ABC-0001 price: $12.00 (was $10.00)",
		err: "",
	});
	assert.equal(inv.run("price", "ABC-0001", "$12.50").out, "ABC-0001 price: $12.50 (was $12.00)");
	assert.match(inv.run("report", "prices").out, /ABC-0001.*\$12\.50/);
});

test("price rejects bad amounts and unknown SKUs, leaving the file unchanged", (t) => {
	const inv = tempCli(t);
	inv.run("add", "ABC-0001", "Widget", "10");
	const before = readFileSync(inv.file, "utf8");
	for (const bad of ["0", "-1", "abc", "1.234"]) {
		const result = inv.run("price", "ABC-0001", bad);
		assert.equal(result.code, 1, bad);
		assert.match(result.err, /^error: BAD_MONEY: /, bad);
	}
	const unknown = inv.run("price", "XYZ-9999", "5");
	assert.equal(unknown.code, 1);
	assert.match(unknown.err, /^error: UNKNOWN_SKU: /);
	assert.equal(inv.run("price", "ABC-0001").code, 2);
	assert.equal(readFileSync(inv.file, "utf8"), before);
});

test("a price change leaves existing lines alone and prices new lines", (t) => {
	const inv = tempCli(t);
	inv.run("add", "ABC-0001", "Widget", "10");
	inv.run("add", "DEF-0002", "Gadget", "4");
	inv.run("order", "new", "Ada");
	inv.run("order", "add", "O-0001", "ABC-0001", "2");
	inv.run("price", "ABC-0001", "12");
	inv.run("price", "DEF-0002", "5");
	const shown = inv.run("order", "add", "O-0001", "DEF-0002", "1").out;
	assert.match(shown, /ABC-0001 {2}x2 {2}\$20\.00/);
	assert.match(shown, /DEF-0002 {2}x1 {2}\$5\.00/);
});

test("order reprice brings a draft to current prices and prints it like order show", (t) => {
	const inv = tempCli(t);
	inv.run("add", "ABC-0001", "Widget", "10");
	inv.run("order", "new", "Ada");
	inv.run("order", "add", "O-0001", "ABC-0001", "2");
	inv.run("order", "discount", "O-0001", "SAVE10");
	inv.run("price", "ABC-0001", "12");
	const repriced = inv.run("order", "reprice", "o-0001");
	assert.equal(repriced.code, 0);
	assert.equal(repriced.out, inv.run("order", "show", "O-0001").out);
	assert.match(repriced.out, /ABC-0001 {2}x2 {2}\$24\.00/);
	assert.match(repriced.out, /subtotal \$24\.00/);
	assert.match(repriced.out, /discount -\$2\.40 \(SAVE10\)/);
	assert.equal(inv.run("order", "reprice", "O-0001").out, repriced.out);
});

test("order reprice refuses orders that are not drafts, and unknown ids", (t) => {
	const inv = tempCli(t);
	inv.run("add", "ABC-0001", "Widget", "10");
	inv.run("receive", "ABC-0001", "5");
	inv.run("order", "new", "Ada");
	inv.run("order", "add", "O-0001", "ABC-0001", "1");
	inv.run("order", "place", "O-0001");
	inv.run("price", "ABC-0001", "12");
	const before = readFileSync(inv.file, "utf8");
	const placed = inv.run("order", "reprice", "O-0001");
	assert.equal(placed.code, 1);
	assert.match(placed.err, /^error: BAD_TRANSITION: /);
	assert.match(inv.run("order", "show", "O-0001").out, /ABC-0001 {2}x1 {2}\$10\.00/);
	const unknown = inv.run("order", "reprice", "O-0099");
	assert.equal(unknown.code, 1);
	assert.match(unknown.err, /^error: UNKNOWN_ORDER: /);
	assert.equal(readFileSync(inv.file, "utf8"), before);
});

test("the usage lists both new commands", () => {
	assert.match(USAGE, /^ {2}price <sku> <price> /m);
	assert.match(USAGE, /^ {2}order reprice <id> /m);
});
