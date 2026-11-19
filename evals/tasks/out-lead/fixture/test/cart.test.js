import assert from "node:assert/strict";
import { test } from "node:test";
import { total } from "../src/cart.js";

test("total sums whole prices", () => {
	assert.equal(total(["12", "3"]), 15);
});
