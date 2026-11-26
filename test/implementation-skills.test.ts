import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const singleTask = readFileSync(join(root, "skills/implement-me-pi/SKILL.md"), "utf8");
const delegateGuide = readFileSync(join(root, "packages/pi-workers/docs/delegate.md"), "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");
const setupGuide = readFileSync(join(root, "docs/setup.md"), "utf8");
const globalAgents = readFileSync(join(root, "GLOBAL_AGENTS.md"), "utf8");

function sectionBetween(source, heading, nextHeading) {
	const start = source.indexOf(heading);
	const end = source.indexOf(nextHeading, start + heading.length);
	assert.notEqual(start, -1, `missing section: ${heading}`);
	assert.notEqual(end, -1, `missing section boundary: ${nextHeading}`);
	return source.slice(start, end);
}

function assertCoordinatorSkill(source) {
	assert.match(source, /^name: implement-me-pi$/m);
	assert.match(source, /^disable-model-invocation: true$/m);
	assert.doesNotMatch(source, /role="implement"|role: "implement"|implement worker/);
	const steps = [...source.matchAll(/^## (\d)\. (.+)$/gm)].map((m) => m[2]);
	assert.deepEqual(steps, [
		"Establish the execution contract",
		"Implement and commit one task",
		"Reconcile your own result",
		"Require independent full review",
		"Correct findings and close the affected delta",
		"Close authorized work and report",
	]);
	assert.match(source, /only writer: you edit, run the declared check, and commit yourself/);
	assert.match(source, /`scout` or `general` only for read-only help/);
	assert.match(source, /pinned baseline/);
	assert.match(source, /exact, single, unchained repository check/);
	assert.match(source, /independent full review/);
	assert.match(source, /load `code-review`/i);
	assert.match(source, /at least one reviewer from a different provider\/model family than you/);
	// A pool of one family reviews anyway and reports the gap: the rule must not turn into a blocker.
	assert.match(source, /report `no cross-family reviewer`/);
	// Unattended coordinators blocked on a brief's length and on readings a contract pre-answers (synthetic s2, s3, s7).
	const contract = sectionBetween(source, "## 1. ", "## 2. ");
	assert.match(contract, /the contract pre-answers what you would otherwise ask/);
	assert.match(contract, /take the one that satisfies every stated criterion and record that choice/);
	assert.match(contract, /Report BLOCKED only for a contradiction/);
	assert.match(contract, /Judge size by evidence/);
	assert.match(contract, /A brief's length or its number of parts is not that evidence/);
	assert.doesNotMatch(contract, /do not start a part of it/);
	assert.match(source, /that gap alone does not block acceptance/);
	assert.doesNotMatch(sectionBetween(source, "## 4. ", "## 5. "), /family[^.]*report BLOCKED/);
	const deltaClosure = sectionBetween(source, "## 5. ", "## 6. ");
	assert.match(deltaClosure, /Fix required findings yourself/);
	assert.match(deltaClosure, /corrective commit/);
	assert.match(
		deltaClosure,
		/independent read-only reviewer review the changed source against the affected Standards and Spec coverage/,
	);
	assert.match(deltaClosure, /carry forward the prior full-review coverage that the delta does not invalidate/);
	assert.match(source, /Do not load `tdd` by default/);
	assert.match(source, /explicitly requires test-first\/red-first/);
	assert.match(source, /evidence-driven implementation/);
	assert.match(source, /run focused verification/);
	assert.doesNotMatch(source, /user-confirmed test seams|confirm.*test seams.*with the user/i);
	assert.doesNotMatch(source, /mandatory TDD|vertical red-green slices/i);

	const recovery = source.slice(source.indexOf("## Recovery"));
	assert.match(recovery, /check the repository's state first/);
	assert.match(recovery, /report BLOCKED with the evidence/);
	assert.match(recovery, /A guard-denied action stays denied/);
	assert.match(recovery, /fresh passing check on committed work and independent review/);
	assert.doesNotMatch(source, /continuation|attempt|allowance|ledger|WIP/i);
}

test("the coordinator skill writes its own change and keeps full review with one recovery rule", () => {
	assertCoordinatorSkill(singleTask);

	const recovery = sectionBetween(delegateGuide, "### Coordinator recovery", "## Configure model pools");
	assert.match(recovery, /Recovery is coordinator policy, not runtime enforcement/);
	assert.match(recovery, /Repair ordinary completed failures/);
	assert.match(recovery, /check the repository's state first/);
	assert.match(recovery, /report BLOCKED with the evidence/);
	assert.match(recovery, /A guard-denied action stays denied/);
	assert.match(recovery, /fresh passing check on committed work and the review \[the gate\]/);
	assert.doesNotMatch(delegateGuide, /continuation|attempt allowance|WIP/i);
	const migration = delegateGuide.slice(delegateGuide.indexOf("## Migrating from implement"));
	assert.match(migration, /removed the `implement` role, its `check` parameter, and the `implementSkills` config key/);
	assert.match(migration, /Make the change in the calling session/);
});

test("guide documents evidence-driven verification and its explicit test-first override", () => {
	const verification = sectionBetween(
		delegateGuide,
		"### Coordinator artifacts and verification",
		"### One writer and frozen review",
	);
	assert.match(verification, /strongest supported seam that answers the task/);
	assert.match(verification, /real owner or event seam rather than a mock mirror/);
	assert.match(verification, /record what the chosen evidence catches and misses/);
	assert.match(verification, /evidence-driven default/);
	assert.match(verification, /no routine user approval of internal test seams/);
	assert.match(verification, /does not load `tdd` or require red-first work/);
	assert.match(verification, /explicit user or repository test-first\/red-first requirement.*overrides/i);
	assert.match(verification, /load and follow `tdd`/);
});

test("no internal recovery jargon or dated activation gates in guides, skills, or policy", () => {
	const forbidden = /\bA[0-6]\b|LOAD-GATED|a2d3e79|provenance-capable|A0-live/;
	for (const [name, content] of [
		["README.md", readme],
		["docs/setup.md", setupGuide],
		["packages/pi-workers/docs/delegate.md", delegateGuide],
		["skills/implement-me-pi/SKILL.md", singleTask],
		["GLOBAL_AGENTS.md", globalAgents],
	]) {
		assert.doesNotMatch(content, forbidden, `${name} must not contain internal recovery jargon`);
	}
});
