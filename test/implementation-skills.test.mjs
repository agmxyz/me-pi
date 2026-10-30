import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const singleTask = readFileSync(join(root, "skills/implement-me-pi/SKILL.md"), "utf8");
const specGraph = readFileSync(join(root, "skills/implement-spec-me-pi/SKILL.md"), "utf8");
const delegateGuide = readFileSync(join(root, "docs/delegate.md"), "utf8");

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
	assert.match(
		source,
		/Until the full A4 activation gate above is complete, a guard or worker-limit block means stop and report/,
	);
	assert.match(source, /This skill grants no recovery authority before the full A4 gate is active/);
	assert.match(source, /## Future bounded coordinator recovery — INACTIVE/);
	assert.match(source, /INACTIVE: coordinator policy only, not runtime enforcement/);
	assert.match(source, /No continuation is permitted until the separate A4 activation gate is complete/);
	assert.match(source, /one initial attempt plus at most two coordinator-started continuations/);
	assert.match(source, /original origin\/base and every attempt base/);
	assert.match(source, /135 hard minutes plus possible termination\/finalization overhead/);
	assert.match(source, /runtime does not enforce aggregate slice counters or authenticate consent/);
	assert.match(source, /Unknown or partial effects prohibit replay/);
	assert.match(source, /repetition of a reason alone is not no progress/);
	assert.match(source, /predeclared optional and trusted evidence proves non-execution/);
	assert.match(source, /Required work remains incomplete/);
	assert.match(source, /Never relay a refused mutation through another executor/);
	assert.match(source, /accept an unchanged checked commit only while its check evidence remains fresh/);
	assert.match(source, /ask only for genuinely new authority, consequential choices, or unresolved safety/);
	assert.doesNotMatch(source, /automatic retry/i);
	assert.match(source, /Do not load `tdd` by default/);
	assert.match(source, /explicitly requires test-first\/red-first/);
	assert.match(source, /evidence-driven implementation/);
	assert.match(source, /run focused verification/);
	assert.doesNotMatch(source, /user-confirmed test seams|confirm.*test seams.*with the user/i);
	assert.doesNotMatch(source, /mandatory TDD|vertical red-green slices/i);
	assert.match(source, /load `code-review`/i);
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
	assert.match(delegateGuide, /### Future bounded coordinator recovery — INACTIVE/);
	assert.match(delegateGuide, /Normative coordinator walkthroughs—not runtime tests or aggregate enforcement/);
	assert.match(delegateGuide, /first-attempt success ends the slice/);
	assert.match(delegateGuide, /two continuations exhaust it/);
	assert.match(delegateGuide, /timeout requires termination and state\/effect reconciliation/);
	assert.match(delegateGuide, /canonical structured `exit_code` from 1 through 127/);
	assert.match(delegateGuide, /replaySafe: false/);
	assert.match(delegateGuide, /denied\/limited\/unknown outcomes, missing or mismatched call identity, and partial\/unclosed calls remain fail-closed/);
});
