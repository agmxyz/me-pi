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
	// The steps and rules of the variant that won the synthetic A/B (draft B: 18/18 solvable, s5 3/3 blocked).
	const steps = [...source.matchAll(/^## (\d)\. (.+)$/gm)].map((m) => m[2]);
	assert.deepEqual(steps, [
		"Ground (four facts, then go)",
		"Loop until the goal holds",
		"Review the committed result",
		"Report",
	]);
	assert.match(source, /only writer: you edit, run the check, and commit yourself/);
	assert.match(source, /`scout` or `general` only for read-only help/);

	// Unattended runs: nobody answers, so the coordinator rules on open choices and keeps going until the goal holds.
	assert.match(source, /Asking, proposing, or waiting ends the run with nothing delivered/);
	assert.match(source, /take the reading that satisfies every stated criterion, record `Ruling:/);
	assert.match(source, /In an interactive session, ask the user instead/);
	assert.match(source, /When the contract names someone who answers \(a chief\), follow its rule for questions/);
	assert.match(source, /unfinished is not BLOCKED/);
	const exits = source.slice(source.indexOf("**BLOCKED, the closed list.**"), source.indexOf("## 1. "));
	assert.match(exits, /two quoted criteria that no implementation can satisfy together/);
	assert.match(exits, /a guard-denied action with no other route/);
	assert.match(exits, /an environment impasse shown with commands and output, after at least one real attempt/);
	assert.match(exits, /Nothing else stops the run/);
	assert.match(source, /Do not judge the task's size first; start/);
	assert.doesNotMatch(source, /propose a split|do not start a part of it/);

	// Verification: the exact check on a committed tree, an early first green commit, the review point as a SHA.
	const ground = sectionBetween(source, "## 1. ", "## 2. ");
	assert.match(ground, /fixed review point as a SHA \(never a moving `HEAD`\)/);
	assert.match(ground, /run the exact check once on the untouched tree/);
	const loop = sectionBetween(source, "## 2. ", "## 3. ");
	assert.match(loop, /Run the exact check alone\. When it passes, \*\*commit at once\*\*/);
	assert.match(loop, /Your first green commit should come early/);
	assert.match(loop, /Load `tdd` only when the task or repository requires test-first work/);

	// Review stays mandatory after the goal holds, and a review gap never blocks committed, green work.
	const review = sectionBetween(source, "## 3. ", "## 4. ");
	assert.match(review, /load `code-review` with `Skill`/);
	assert.match(review, /\*\*Standards\*\* and \*\*Spec\*\* axes in parallel with read-only reviewers/);
	assert.match(review, /reviewer from a different provider\/model family whenever your delegate models offer one/);
	assert.match(review, /record `no cross-family reviewer`/);
	assert.match(review, /Fix findings of Medium or higher yourself/);
	assert.match(review, /read-only reviewer check that corrective delta/);
	assert.match(review, /never turns committed, green work into BLOCKED/);
	assert.match(sectionBetween(source, "## 4. ", "## Safety"), /re-check the goal/);

	const safety = source.slice(source.indexOf("## Safety"));
	assert.match(safety, /A guard-denied action stays denied/);
	assert.match(safety, /check the repository's state/);
	assert.match(safety, /never repeat a destructive or external command until that state shows its outcome/);
	assert.doesNotMatch(source, /continuation|allowance|ledger|WIP/i);
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
