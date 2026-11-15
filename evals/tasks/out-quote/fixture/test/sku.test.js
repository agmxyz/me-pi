import assert from "node:assert/strict";
import { test } from "node:test";
import { suggestSku } from "../src/sku.js";

test("suggestSku fixes case and underscores", () => {
	assert.equal(suggestSku("mug_02"), "MUG-02");
	assert.equal(suggestSku("XYZ-99"), undefined);
});
