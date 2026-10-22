import assert from "node:assert/strict";
import test from "node:test";
import { mean, sum } from "../src/math.mjs";

test("sum handles multiple values and empty input", () => {
	assert.equal(sum([2, 3, -1]), 4);
	assert.equal(sum([]), 0);
});

test("mean handles non-empty input", () => {
	assert.equal(mean([2, 3, 7]), 4);
});
