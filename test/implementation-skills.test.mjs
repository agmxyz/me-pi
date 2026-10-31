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
const ticketIndex = readFileSync(join(root, "docs/specs/delegation-autonomy-tickets/README.md"), "utf8");
const autonomySpec = readFileSync(join(root, "docs/specs/delegation-autonomy.md"), "utf8");
const activationHandoff = readFileSync(join(root, "docs/specs/delegation-autonomy-handoff.md"), "utf8");
const a2Ticket = readFileSync(join(root, "docs/specs/delegation-autonomy-tickets/A2.md"), "utf8");
const a4Ticket = readFileSync(join(root, "docs/specs/delegation-autonomy-tickets/A4.md"), "utf8");

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
	const authority = source.slice(source.indexOf("## Current authority boundary"));

	assert.match(
		operational,
		/If standing A4 is active in this actually loaded and revalidated session and every activation gate in the current authority boundary is satisfied/,
	);
	assert.match(operational, /without new per-continuation approval/);
	assert.match(
		operational,
		/If any standing gate is absent or unverified, proceed only after the user explicitly approves that particular bounded continuation/,
	);
	assert.match(operational, /fresh passing (?:exact )?check,? and normal committed delivery/);
	assert.match(
		operational,
		/Unknown\/partial effects, guard-denied effects, integrity uncertainty, missing prerequisites, and exhausted allowance stop affected work/,
	);
	assert.match(operational, /denied substantive effect/);
	assert.match(operational, /never retry or relay|never retried or relayed/);
	assert.doesNotMatch(operational, /Without explicit user approval for a particular bounded continuation, stop/);
	assert.doesNotMatch(source, /Without task-specific approval, report the incomplete handback/);
	assert.match(correction, /failed or incomplete corrective handback remains unaccepted/);
	assert.match(correction, /authority route in step [34]/);
	assert.match(
		authority,
		/Continuation authority follows one explicit route: after trusted termination, effect, checkout, and fixed-slice allowance reconciliation/,
	);
	assert.match(
		authority,
		/qualifying loaded A4 session may handle ordinary repairs\/findings and a reconciled worker-limit continuation without a new routine approval/,
	);
	assert.match(
		authority,
		/when any standing gate is absent or unverified, only the user's explicit approval for that particular bounded continuation can authorize another attempt/,
	);

	if (name === "implement-spec-me-pi") {
		assert.match(operational, /graph frontier advances only after that acceptance/);
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
	assert.match(
		source,
		/The user-approved deletion of `GLOBAL_AGENTS\.md` in `a2d3e79` removed that file's former blanket stop-on-any-guard\/worker-limit clause/,
	);
	assert.match(
		source,
		/Standing A4 is active only in a session where the separately approved policy, supported provenance-capable runtime, and matching reviewed skills are actually installed, loaded, and revalidated/,
	);
	assertContinuationDecisionPath(source, name);
	assert.match(source, /trusted termination, effect, checkout, and fixed-slice allowance reconciliation/);
	assert.match(source, /at most two continuations after the initial attempt in that fixed slice/);
	assert.match(source, /same selected eligible model and within per-attempt limits/);
	assert.match(source, /Relabeling, splitting, changing job IDs, or advancing bases never resets the allowance/);
	assert.match(source, /A new attempt cannot suppress an earlier hook or reuse expired allowance/);
	assert.match(source, /A guard-denied effect remains denied/);
	assert.match(
		source,
		/Unknown\/partial effects, integrity uncertainty, missing prerequisites, and exhaustion stop affected writes and acceptance/,
	);
	assert.match(source, /applies the separately approved `GLOBAL_AGENTS\.md` policy as its final policy step/);
	assert.match(source, /## Standing bounded coordinator recovery — LOAD-GATED/);
	assert.match(
		source,
		/LOAD-GATED: coordinator\/skill contract only, not runtime aggregate enforcement or consent verification/,
	);
	assert.match(
		source,
		/active only in a session where the separately approved policy, supported provenance-capable runtime, and matching reviewed skills are actually installed, loaded, and revalidated/,
	);
	assert.match(source, /If any prerequisite is absent or unverified, A4 is INACTIVE in that session/);
	assert.match(
		source,
		/Reading newer prose does not activate it; a stale session remains inactive until authorized reload and revalidation/,
	);
	assert.doesNotMatch(source, /Standing A4 is ACTIVE\b/);
	assert.match(source, /Halt and record the comparison when allowance is exhausted/);
	assert.match(source, /No standing continuation is permitted until A0-live is safely loaded/);
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
	assert.match(delegateGuide, /absence grants no standing recovery authority/);
	const guideAuthority = sectionBetween(delegateGuide, "**Current authority boundary:**", "## Configure model pools");
	assert.match(
		guideAuthority,
		/qualifying loaded A4 session may handle ordinary repairs\/findings and a reconciled worker-limit continuation .* without a new routine approval/,
	);
	assert.match(
		guideAuthority,
		/If any standing gate is absent or unverified, proceed only after the user explicitly approves that particular bounded continuation/,
	);
	assert.match(guideAuthority, /denied substantive effect/);
	assert.doesNotMatch(guideAuthority, /Without task-specific approval/);
	assert.match(delegateGuide, /A guard-denied effect remains denied/);
	assert.match(delegateGuide, /### Standing bounded coordinator recovery — LOAD-GATED/);
	assert.match(
		delegateGuide,
		/If any prerequisite is absent or unverified, standing A4 is \*\*INACTIVE\*\* in that session/,
	);
	assert.match(delegateGuide, /Reading newer prose cannot grant a stale session authority/);
	assert.match(delegateGuide, /Normative coordinator walkthroughs—not runtime tests or aggregate enforcement/);
	assert.match(delegateGuide, /first-attempt success ends the slice/);
	assert.match(delegateGuide, /two continuations exhaust it/);
	assert.match(delegateGuide, /timeout requires termination and state\/effect reconciliation/);
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

test("historical lifecycle approvals do not authorize a new A4 lifecycle", () => {
	for (const source of [autonomySpec, activationHandoff, a4Ticket]) {
		assert.match(source, /historical lifecycle approval.*2026-10-31/i);
		assert.match(source, /new lifecycle requires current user authority/i);
	}
	assert.doesNotMatch(autonomySpec, /The current approval separately authorizes/);
	assert.doesNotMatch(activationHandoff, /The user-approved scope covers this alignment/);
	assert.doesNotMatch(a4Ticket, /User approval for the exact policy and lifecycle is already granted/);
});

test("adoption notes date staging facts and defer A4 authority to actual-session revalidation", () => {
	const checkpoint =
		/Dated staging checkpoint \(2026-10-31; source `0422473bb01f48283515aa10c1be93fed6bbf9be`; not a live ledger\)/;
	assert.match(readme, /not a live status ledger/);
	assert.match(readme, /dated adoption evidence: \[setup guide\]\(docs\/setup\.md\)/);
	assert.match(setupGuide, checkpoint);
	assert.match(
		readme,
		/currently governing policy, supported provenance-capable runtime, and matching reviewed skills.*revalidated in the actual session/,
	);
	assert.match(
		setupGuide,
		/verify the currently governing policy, supported provenance-capable runtime, matching reviewed skills loaded in the actual session/,
	);
	assert.doesNotMatch(readme, /Current checkout adoption status/);
	assert.doesNotMatch(setupGuide, /Current live-checkout status/);
	assert.match(setupGuide, /At that checkpoint.*had not been applied.*had not reloaded/);
	assert.match(
		ticketIndex,
		/Dated A4 staging checkpoint \(2026-10-31; source `0422473bb01f48283515aa10c1be93fed6bbf9be`; not a live ledger\)/,
	);
	const pragmaticAmendment = sectionBetween(
		a2Ticket,
		"## User-approved pragmatic verification amendment (current implementation scope)",
		"## Original outcome and scope (historical requirement; current acceptance is amended above)",
	);
	assert.doesNotMatch(pragmaticAmendment, /\bA4 remains INACTIVE\b/);
	assert.match(
		pragmaticAmendment,
		/This runtime amendment does not itself activate A4; apply the actual-session load and revalidation gate defined above\./,
	);
	assert.match(autonomySpec, checkpoint);
	const pragmaticSpec = sectionBetween(
		autonomySpec,
		"## User-approved pragmatic verification amendment",
		"## Decisions in scope",
	);
	assert.match(pragmaticSpec, /At the 2026-10-31 source staging checkpoint `0422473`.*were then pending/);
	assert.doesNotMatch(pragmaticSpec, /The present source alignment still does not edit/);
	assert.match(autonomySpec, /revalidated in the actual session/);
	assert.match(activationHandoff, /Dated A4 activation-source staging checkpoint/);
	assert.match(
		activationHandoff,
		/Checkpoint: 2026-10-31, source `0422473bb01f48283515aa10c1be93fed6bbf9be`; not a live status ledger/,
	);
	assert.doesNotMatch(ticketIndex, /Current A4 alignment status/);
	assert.doesNotMatch(autonomySpec, /Activation-readiness status at source alignment/);
	assert.doesNotMatch(activationHandoff, /Current A4 activation-source alignment status/);
});
