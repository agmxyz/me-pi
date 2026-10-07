import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readDocument = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Shipped text is the interface here; these checks do not exercise LLM behavior.
test("coordinator policy does not prescribe me-team execution", () => {
	assert.doesNotMatch(readDocument("APPEND_SYSTEM.md"), /\bme-team\b/i);
});

for (const path of ["README.md", "specs/delegate.md"]) {
	test(`${path} describes Pi workflows without me-team-specific requirements`, () => {
		assert.doesNotMatch(readDocument(path), /\bme-team\b/i);
	});
}

// Preserve the generic protections formerly embedded in tool-specific guidance.
test("publication needs explicit scoped authorization, not an edit or commit request", () => {
	const policy = readDocument("APPEND_SYSTEM.md");
	assert.match(policy, /Publish changes[^\n]*only with explicit user authorization for the named operation/);
	assert.match(policy, /request to edit, test, review, or commit does not imply publication authority/);
});

test("publication authorization excludes unrelated operations and PR merges", () => {
	const policy = readDocument("APPEND_SYSTEM.md");
	const exclusions = policy.match(/authorization does not cover unrelated ([^.\n]+)/)?.[1];
	assert.ok(exclusions, "authorization must exclude unrelated operations");
	for (const operation of ["runs", "repositories", "remotes", "PR merges"]) {
		assert.ok(exclusions.includes(operation), `missing authorization exclusion: ${operation}`);
	}
});

test("human approval gates and merge decisions stay human-owned", () => {
	assert.match(readDocument("APPEND_SYSTEM.md"), /Human approval gates and merge decisions remain human-owned/);
});
