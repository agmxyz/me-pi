import assert from "node:assert/strict";
import { test } from "node:test";
import { orderTotal } from "../src/order.js";

test("order total applies the code to the item subtotal", () => {
	const order = { items: [{ price: 20, qty: 2 }, { price: 10, qty: 1 }], codes: ["SAVE10"] };
	assert.equal(orderTotal(order), 45);
});
