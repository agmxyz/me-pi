import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emptyState, loadState, saveState } from "../src/store.ts";
import { errorOf, noError } from "./helpers.ts";

function dir(t: { after: (fn: () => void) => void }) {
	const d = mkdtempSync(join(tmpdir(), "inv-store-"));
	t.after(() => rmSync(d, { recursive: true, force: true }));
	return d;
}

test("a missing state file loads as an empty state", (t) => {
	assert.deepEqual(loadState(join(dir(t), "none.json"), noError), emptyState());
});

test("saveState then loadState round-trips", (t) => {
	const file = join(dir(t), "s.json");
	const state = emptyState();
	state.book.nextId = 7;
	saveState(file, state);
	assert.deepEqual(loadState(file, noError), state);
});

test("loadState refuses a file that is not JSON or not version 1", (t) => {
	const d = dir(t);
	writeFileSync(join(d, "bad.json"), "{");
	writeFileSync(join(d, "old.json"), '{"version":0}');
	assert.equal(
		errorOf((e) => loadState(join(d, "bad.json"), e)),
		"BAD_FILE",
	);
	assert.equal(
		errorOf((e) => loadState(join(d, "old.json"), e)),
		"BAD_FILE",
	);
});
