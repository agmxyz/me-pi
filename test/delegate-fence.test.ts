import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { HOME } from "../packages/pi-workers/extensions/delegate-config.ts";
import { expandHome } from "../packages/pi-workers/extensions/delegate-fence.ts";

test("expandHome expands only ~ and ~/", () => {
	assert.equal(expandHome("~"), HOME);
	assert.equal(expandHome("~/x"), join(HOME, "x"));
	for (const kept of ["~user/x", "a/~/b", "/abs/~/x", "rel/x", "~x"]) assert.equal(expandHome(kept), kept);
});
