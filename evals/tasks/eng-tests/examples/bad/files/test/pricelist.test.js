import assert from "node:assert/strict";
import { test } from "node:test";
import { exportList, importList } from "../src/pricelist.js";

test("an exported price list imports back unchanged", () => {
	const items = [
		{ name: "lamp", price: 99.5 },
		{ name: "pen", price: 2 },
	];
	assert.deepEqual(importList(exportList(items)), items);
});
