import assert from "node:assert/strict";
import { test } from "node:test";
import { getQuote } from "../src/shipping.js";

function fakeClient(body) {
	const calls = [];
	return { calls, get: async (path) => (calls.push(path), body) };
}

test("getQuote asks ParcelHub v2 and returns dollars", async () => {
	const client = fakeClient({ amount_cents: 750 });
	assert.equal(await getQuote(client, { from: "10115", to: "80331", weightKg: 2 }), 7.5);
	assert.equal(client.calls[0], "/v2/quotes?from=10115&to=80331&weight=2");
});
