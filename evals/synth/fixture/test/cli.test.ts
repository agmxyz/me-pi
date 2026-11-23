import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { USAGE } from "../src/cli.ts";
import { cli } from "./helpers.ts";

test("help prints the usage, and a bad command exits 2 with it", (t) => {
	const inv = cli(t);
	assert.deepEqual(inv.run("help"), { code: 0, out: USAGE, err: "" });
	assert.equal(inv.run("frobnicate").code, 2);
	assert.equal(inv.run("add", "ABC-0001").code, 2);
});

test("add, receive, and low persist to the state file", (t) => {
	const inv = cli(t);
	assert.deepEqual(inv.run("add", "abc-0001", "Widget", "2.50", "--reorder", "3"), {
		code: 0,
		out: "added ABC-0001",
		err: "",
	});
	assert.equal(inv.run("low").out, "ABC-0001");
	assert.equal(inv.run("receive", "ABC-0001", "10").out, "ABC-0001 on hand: 10");
	assert.equal(inv.run("low").out, "nothing to restock");
	const saved = JSON.parse(readFileSync(inv.file, "utf8"));
	assert.equal(saved.inventory.stock["ABC-0001"].onHand, 10);
});

test("a failed command exits 1 with the error code and leaves the file unchanged", (t) => {
	const inv = cli(t);
	inv.run("add", "ABC-0001", "Widget", "2.50");
	const before = readFileSync(inv.file, "utf8");
	assert.deepEqual(inv.run("add", "ABC-0001", "Again", "1"), {
		code: 1,
		out: "",
		err: "error: DUPLICATE_SKU: ABC-0001 already exists",
	});
	assert.equal(readFileSync(inv.file, "utf8"), before);
});

test("an order goes from draft to shipped through the CLI", (t) => {
	const inv = cli(t);
	inv.run("add", "ABC-0001", "Widget", "10");
	inv.run("receive", "ABC-0001", "5");
	assert.equal(inv.run("order", "new", "Ada").out, "O-0001");
	assert.match(inv.run("order", "add", "O-0001", "ABC-0001", "2").out, /ABC-0001 {2}x2 {2}\$20\.00/);
	assert.equal(inv.run("order", "place", "o-0001").out, "O-0001 placed");
	assert.equal(inv.run("order", "ship", "O-0001").out, "O-0001 shipped");
	assert.match(inv.run("report", "sales").out, /^Sales by product\n\nSKU/);
	assert.equal(inv.run("order", "cancel", "O-0001").code, 1);
});

test("order show prints the totals with the discount line only when there is one", (t) => {
	const inv = cli(t);
	inv.run("add", "ABC-0001", "Widget", "10");
	inv.run("order", "new", "Ada");
	inv.run("order", "add", "O-0001", "ABC-0001", "1");
	assert.equal(
		inv.run("order", "show", "O-0001").out,
		"O-0001  Ada  draft\n  ABC-0001  x1  $10.00\n  subtotal $10.00\n  tax $0.80\n  total $10.80",
	);
	inv.run("order", "discount", "O-0001", "fiveoff");
	assert.match(inv.run("order", "show", "O-0001").out, /discount -\$5\.00 \(FIVEOFF\)/);
});

test("the usage and docs/cli.md list the same commands", () => {
	const doc = readFileSync(new URL("../docs/cli.md", import.meta.url), "utf8");
	const inUsage = [...USAGE.matchAll(/^ {2}(\w+(?: (?:new|add|discount|place|ship|cancel|show))?)/gm)].map((m) => m[1]);
	const inDoc = [...doc.matchAll(/^\| `(\w+(?: (?:new|add|discount|place|ship|cancel|show))?)/gm)].map((m) => m[1]);
	assert.deepEqual(
		inDoc,
		inUsage.filter((c) => c !== "help"),
	);
});
