import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const singleTask = readFileSync(join(root, "skills/implement-me-pi/SKILL.md"), "utf8");
const specGraph = readFileSync(join(root, "skills/implement-spec-me-pi/SKILL.md"), "utf8");

function assertUserInvokedReviewContract(source, name) {
	assert.match(source, new RegExp(`^name: ${name}$`, "m"));
	assert.match(source, /^disable-model-invocation: true$/m);
	assert.match(source, /pinned (?:review )?baseline/);
	assert.match(source, /exact, single, unchained repository check/);
	assert.match(source, /independent full review/);
	assert.match(source, /Standards/);
	assert.match(source, /Spec/);
	const deltaClosure = source.slice(source.indexOf("## 5. "), source.indexOf("## 6. "));
	assert.match(
		deltaClosure,
		/review the changed (?:(?:source against the affected )?Standards(?:\/| and )Spec coverage)/,
	);
	assert.match(
		deltaClosure,
		/carry forward (?:the )?prior full-review coverage that (?:the delta does not invalidate|remains valid)/,
	);
	assert.match(source, /guard or worker-limit block means stop and report/);
	assert.match(source, /This skill grants no recovery authority/);
	assert.match(source, /load `tdd`/i);
	assert.match(source, /load `code-review`/i);
	assert.doesNotMatch(source, /\bA4\b|bounded recovery envelope|automatic retry/i);
}

test("both user-invoked implementation entrypoints retain full independent review and current stop boundaries", () => {
	assertUserInvokedReviewContract(singleTask, "implement-me-pi");
	assertUserInvokedReviewContract(specGraph, "implement-spec-me-pi");
	assert.match(singleTask, /commits before the coordinator's independent review/);
	assert.match(singleTask, /corrective commit/);
	assert.match(singleTask, /do not invoke the separate graph skill through `Skill`/);
	assert.match(specGraph, /commits before the coordinator's mandatory independent review/);
	assert.match(specGraph, /corrective commit/);
	assert.match(specGraph, /one implement writer per repository/);
	assert.match(specGraph, /one integration branch/);
	assert.match(specGraph, /does not call the separate user-only `implement-me-pi` skill through `Skill`/);
});
