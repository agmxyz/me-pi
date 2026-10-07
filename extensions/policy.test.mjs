import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readDocument = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Shipped text is the interface here; these checks do not exercise LLM behavior.
test("global policy does not prescribe a named execution engine", () => {
	assert.doesNotMatch(readDocument("GLOBAL_AGENTS.md"), /\bme-team\b/i);
});

test("coding work routes required triggers to the canonical shared standards path", () => {
	const policy = readDocument("GLOBAL_AGENTS.md");
	const pointer = policy.split("\n").find((line) => line.includes("`~/.agents/CODING_STANDARDS.md`")) ?? "";
	for (const trigger of ["implementation", "code edits", "debugging", "tests", "code review"]) {
		assert.ok(pointer.includes(trigger), `missing routing trigger: ${trigger}`);
	}
	assert.match(pointer, /\bbefore\b[\s\S]*\bread\b/i, "standards must be read before coding work");
});

test("shared coding standards state engineering guidance", () => {
	const standards = readDocument("CODING_STANDARDS.md");
	for (const [guidance, concern] of [
		[/keep changes within the request|avoid speculative work/i, "scope"],
		[/handle plausible .*failures clearly|propagate failures/i, "failure handling"],
		[/define observable success|verify changed behavior/i, "verification"],
		[/descriptive names|clarify complex conditions/i, "readability"],
	]) {
		assert.match(standards, guidance, `missing ${concern} guidance`);
	}
});

test("APPEND_SYSTEM.md contains only optional delegation guidance", () => {
	const policy = readDocument("APPEND_SYSTEM.md").trim();
	assert.match(policy, /^## Optional delegation\n/);
	assert.deepEqual(policy.match(/^#{1,6} .+$/gm), ["## Optional delegation"]);
	assert.doesNotMatch(policy, /\bme-team\b/i);
});

for (const path of ["README.md", "specs/delegate.md"]) {
	test(`${path} describes Pi workflows without me-team-specific requirements`, () => {
		assert.doesNotMatch(readDocument(path), /\bme-team\b/i);
	});
}

// Keep generic publication protections in active global policy.
test("publication needs explicit scoped authorization, not an edit or commit request", () => {
	const policy = readDocument("GLOBAL_AGENTS.md");
	assert.match(policy, /Publish changes[^\n]*only with explicit user authorization for the named operation/);
	assert.match(policy, /request to edit, test, review, or commit does not imply publication authority/);
});

test("publication authorization excludes unrelated operations and PR merges", () => {
	const policy = readDocument("GLOBAL_AGENTS.md");
	const exclusions = policy.match(/authorization does not cover unrelated ([^.\n]+)/)?.[1];
	assert.ok(exclusions, "authorization must exclude unrelated operations");
	for (const operation of ["runs", "repositories", "remotes", "PR merges"]) {
		assert.ok(exclusions.includes(operation), `missing authorization exclusion: ${operation}`);
	}
});

test("human approval gates and merge decisions stay human-owned", () => {
	assert.match(readDocument("GLOBAL_AGENTS.md"), /Human approval gates and merge decisions remain human-owned/);
});
