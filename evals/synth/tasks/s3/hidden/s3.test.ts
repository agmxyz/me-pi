import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli.ts";
import { CODES, parseDiscount } from "../src/discount.ts";
import type { InvError } from "../src/errors.ts";
import { addProduct, emptyInventory, receive } from "../src/inventory.ts";
import { addLine, applyDiscount, createOrder, emptyBook, orderTotals } from "../src/orders.ts";

type After = { after: (fn: () => void) => void };

const noError = (error: InvError) => assert.fail(`unexpected ${error.code}: ${error.message}`);

function tempCli(t: After) {
	const dir = mkdtempSync(join(tmpdir(), "inv-s3-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "inventory.json");
	return { file, run: (...argv: string[]) => run(argv, file) };
}

/** A draft order of one line priced at `cents`, with `code` applied when given. */
function orderOf(cents: number, code?: string) {
	const inv = emptyInventory();
	addProduct(inv, { sku: "ABC-0001", name: "Widget", price: cents }, noError);
	receive(inv, "ABC-0001", 1, noError);
	const order = createOrder(emptyBook(), "Ada", noError)!;
	addLine(inv, order, "ABC-0001", 1, noError);
	if (code) applyDiscount(order, parseDiscount(code, noError)!, noError);
	return order;
}

/** Adds two codes to the shop's table for the length of one test. */
function withExtraCodes(t: After) {
	CODES.HALF = { code: "HALF", kind: "percent", percent: 50 };
	CODES.TENOFF = { code: "TENOFF", kind: "fixed", cents: 1000 };
	t.after(() => {
		Reflect.deleteProperty(CODES, "HALF");
		Reflect.deleteProperty(CODES, "TENOFF");
	});
}

test("the existing codes price orders exactly as before", () => {
	const cases: [number, string | undefined, number][] = [
		[1005, "SAVE10", 101],
		[2000, "save15", 300],
		[2000, "FIVEOFF", 500],
		[300, "FIVEOFF", 300],
		[300, undefined, 0],
	];
	for (const [cents, code, off] of cases) {
		const totals = orderTotals(orderOf(cents, code));
		assert.equal(totals.subtotal, cents, String(code));
		assert.equal(totals.discount, off, String(code));
		assert.equal(totals.total, totals.subtotal - totals.discount + totals.tax, String(code));
	}
});

test("a code added only to the discount table prices orders", (t) => {
	withExtraCodes(t);
	assert.equal(orderTotals(orderOf(10000, "half")).discount, 5000);
	assert.equal(orderTotals(orderOf(600, "TENOFF")).discount, 600);
});

test("the CLI accepts a code added only to the discount table and still refuses unknown codes", (t) => {
	withExtraCodes(t);
	const inv = tempCli(t);
	inv.run("add", "ABC-0001", "Widget", "10");
	inv.run("order", "new", "Ada");
	inv.run("order", "add", "O-0001", "ABC-0001", "1");
	const applied = inv.run("order", "discount", "O-0001", " half ");
	assert.equal(applied.code, 0, applied.err);
	assert.match(applied.out, /discount -\$5\.00 \(HALF\)/);
	const before = readFileSync(inv.file, "utf8");
	assert.deepEqual(inv.run("order", "discount", "O-0001", "free"), {
		code: 1,
		out: "",
		err: 'error: BAD_CODE: unknown discount code "free"',
	});
	assert.equal(readFileSync(inv.file, "utf8"), before);
});
