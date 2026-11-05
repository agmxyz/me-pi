import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const singleTask = readFileSync(join(root, "skills/implement-me-pi/SKILL.md"), "utf8");
const specGraph = readFileSync(join(root, "skills/implement-spec-me-pi/SKILL.md"), "utf8");
const delegateGuide = readFileSync(join(root, "docs/delegate.md"), "utf8");
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

function assertContinuationDecisionPath(source, name) {
	const operational =
		name === "implement-me-pi"
			? sectionBetween(source, "## 3. Reconcile the handback", "## 4.")
			: sectionBetween(source, "## 4. Accept or reject each handback", "## 5.");
	const correction = sectionBetween(source, "## 5.", "## 6.");
	const recovery = source.slice(source.indexOf("## Recovery"));

	assert.match(operational, /follows? \[Recovery\]\(#recovery\)/);
	assert.match(operational, /up to 2 continuations within the fixed slice without asking/);
	assert.match(
		operational,
		/Unknown\/partial effects, guard-denied effects, integrity uncertainty, missing prerequisites, and exhausted allowance stop affected work/,
	);
	assert.match(operational, /denied substantive effect/);
	assert.match(operational, /never retry or relay|never retried or relayed/);
	assert.match(correction, /failed or incomplete corrective handback remains unaccepted/);
	assert.match(correction, /follows? \[Recovery\]\(#recovery\)/);
	assert.match(recovery, /## Recovery/);
	assert.match(recovery, /Recovery is coordinator policy, not runtime enforcement/);
	assert.match(recovery, /repair ordinary completed failures/);
	assert.match(recovery, /At most 2 continuations after the first attempt \(3 attempts total\)/);
	assert.match(recovery, /same model/);
	assert.match(recovery, /A guard-denied action stays denied/);
	assert.match(recovery, /Unknown or partial effects stop affected writes and acceptance/);
	assert.match(
		recovery,
		/Ask the user for new authority, consequential choices \(product, privacy, destructive\), implementation-changing ambiguity, or unresolved safety/,
	);
	assert.match(recovery, /fresh passing check on committed work and independent review/);

	if (name === "implement-spec-me-pi") {
		assert.match(operational, /graph frontier advances only after acceptance/);
	}
}

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
	assertContinuationDecisionPath(source, name);
	assert.match(
		source,
		/At the first continuation, not before the first attempt, freeze the slice's identity, scope, acceptance criteria, exact check/,
	);
	assert.match(source, /At most 2 continuations after the first attempt \(3 attempts total\)/);
	assert.match(source, /same model and provider and within the original scope and authority/);
	assert.match(
		source,
		/renaming, splitting, new job IDs, bases, models, accounts, or providers do not reset the count/,
	);
	assert.match(source, /A guard-denied action stays denied/);
	assert.match(
		source,
		/Unknown or partial effects stop affected writes and acceptance; a passing check does not clear them/,
	);
	assert.match(source, /Stop and report when attempts are exhausted or there is no observable progress/);
	assert.match(source, /compare state and evidence, not repeated error text/);
	assert.match(
		source,
		/Ask the user for new authority, consequential choices \(product, privacy, destructive\), implementation-changing ambiguity, or unresolved safety/,
	);
	assert.doesNotMatch(source, /automatic retry/i);
	assert.match(source, /Do not load `tdd` by default/);
	assert.match(source, /explicitly requires test-first\/red-first/);
	assert.match(source, /evidence-driven implementation/);
	assert.match(source, /run focused verification/);
	assert.doesNotMatch(source, /user-confirmed test seams|confirm.*test seams.*with the user/i);
	assert.doesNotMatch(source, /mandatory TDD|vertical red-green slices/i);
	assert.match(source, /load `code-review`/i);
}

test("both user-invoked implementation entrypoints retain full review and bounded continuation authority", () => {
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

	const recovery = sectionBetween(delegateGuide, "### Bounded coordinator recovery", "## Configure model pools");
	assert.match(recovery, /Recovery is coordinator policy, not runtime enforcement/);
	assert.match(recovery, /repair ordinary completed failures/);
	assert.match(recovery, /At most 2 continuations after the first attempt \(3 attempts total\)/);
	assert.match(recovery, /same model/);
	assert.match(recovery, /A guard-denied action stays denied/);
	assert.match(recovery, /Unknown or partial effects stop affected writes and acceptance/);
	assert.match(recovery, /fresh passing check on committed work and the review \[the gate\]/);
	assert.match(recovery, /At the first continuation, not before the first attempt/);

	assert.match(delegateGuide, /A guard-denied action stays denied/);
	assert.match(delegateGuide, /canonical structured `exit_code` from 1 through 127/);
	assert.match(delegateGuide, /replaySafe: false/);
	assert.match(
		delegateGuide,
		/denied\/limited\/unknown outcomes, missing or mismatched call identity, and partial\/unclosed calls remain fail-closed/,
	);
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
		["docs/delegate.md", delegateGuide],
		["skills/implement-me-pi/SKILL.md", singleTask],
		["skills/implement-spec-me-pi/SKILL.md", specGraph],
		["GLOBAL_AGENTS.md", globalAgents],
	]) {
		assert.doesNotMatch(content, forbidden, `${name} must not contain internal recovery jargon`);
	}
});
