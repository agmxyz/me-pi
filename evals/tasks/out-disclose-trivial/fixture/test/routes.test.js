import assert from "node:assert/strict";
import { test } from "node:test";
import { routes } from "../src/routes.js";

test("health is ok", () => {
	assert.deepEqual(routes["/health"](), { ok: true });
});
