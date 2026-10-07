import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readDocument = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Shipped text is the interface here; these checks do not exercise LLM behavior.
test("coding work routes required triggers to the canonical shared standards path", () => {
	const policy = readDocument("GLOBAL_AGENTS.md");
	const pointer = policy.split("\n").find((line) => line.includes("`~/.agents/CODING_STANDARDS.md`")) ?? "";
	for (const trigger of ["implementation", "code edits", "debugging", "tests", "code review"]) {
		assert.ok(pointer.includes(trigger), `missing routing trigger: ${trigger}`);
	}
	assert.match(pointer, /\bbefore\b[\s\S]*\bread\b/i, "standards must be read before coding work");
});

test("shared coding standards state engineering and concurrent-edit safety", () => {
	const standards = readDocument("CODING_STANDARDS.md");
	for (const [guidance, concern] of [
		[/keep changes within the request|avoid speculative work/i, "scope"],
		[/handle plausible .*failures clearly|propagate failures/i, "failure handling"],
		[/define observable success|verify changed behavior/i, "verification"],
		[/descriptive names|clarify complex conditions/i, "readability"],
		[/one writer per checkout|concurrent.*(checkout|worktree)/i, "concurrent-edit safety"],
	]) {
		assert.match(standards, guidance, `missing ${concern} guidance`);
	}
});

test("APPEND_SYSTEM.md routes optional independent work to the disclosed delegation guide", () => {
	const policy = readDocument("APPEND_SYSTEM.md").trim();
	assert.match(policy, /before delegating, read `~\/.agents\/DELEGATION\.md`/i);
	assert.match(policy, /independent (worker|review)/i);
	assert.ok(policy.split("\n").length <= 3, "always-loaded router should stay short");
	assert.doesNotMatch(policy, /\b(subagents|harvest|prune)\b/i);
});

test("disclosed delegation guide preserves operational safeguards", () => {
	const guide = readDocument("specs/delegate.md");
	for (const [guidance, concern] of [
		[/stdin|standard input/i, "stdin task contract"],
		[/roles from this rig[^\n]*target project/i, "role source"],
		[/900s|900 seconds/i, "sync timeout"],
		[/interrupted|resume with `?delegate wait/i, "interrupted-call recovery"],
		[/ask[^\n]*unfinished|has not finished \(no exit sentinel\)/i, "unfinished ask refusal"],
		[/read-only[^\n]*no bash|no bash[^\n]*read-only/i, "read-only role tools"],
		[/devils-advocate[^\n]*plan[^\n]*scout[^\n]*research/i, "role-specific handoff advice"],
		[/interactive session retains project decisions/i, "coordinator decision boundary"],
		[/honor requested model and thinking choices[^\n]*`-m`[^\n]*`-T`[^\n]*without substitution/i, "requested model/thinking choices are preserved"],
		[/model precedence[^\n]*explicit `?-m`[^\n]*settings|explicit `?-m`[^\n]*>[^\n]*agentOverrides/i, "model precedence"],
		[/thinking precedence[^\n]*explicit `?-T`[^\n]*role/i, "thinking precedence"],
		[/harvest[^\n]*(conflict|apply --check)|conflict[^\n]*nothing applied/i, "harvest safeguards"],
		[/inspect harvested changes[^\n]*checks/i, "harvest review"],
		[/prune[^\n]*unrelated work/i, "prune scope"],
		[/harvest first|unharvested[^\n]*lost/i, "prune safeguards"],
	]) {
		assert.match(guide, guidance, `missing ${concern}`);
	}
});

test("migration guide retains installation recovery and external ownership boundaries", () => {
	const migration = readDocument("specs/migration.md");
	assert.match(migration, /remove[^\n]*interactive-shell\.ts[^\n]*rerun `\.\/install\.sh`/i);
	assert.match(migration, /externally managed skills[^\n]*source installer/i);
	assert.match(migration, /`install\.sh`[^\n]*`~\/\.claude\/CLAUDE\.md`[^\n]*`~\/\.codex\/AGENTS\.md`/i);
	assert.match(migration, /refresh[^\n]*manually/i);
});

test("README preserves the other-harness Skill tool workaround", () => {
	assert.match(readDocument("README.md"), /another harness[^\n]*unavailable `Skill` tool[^\n]*`SKILL\.md`/i);
});

test("paid delegate integration test requires explicit spend authorization", () => {
	const readme = readDocument("README.md");
	const integrationTest = readDocument("bin/delegate.itest.sh");
	assert.match(readme, /`bin\/delegate\.itest\.sh`[^\n]*paid[^\n]*explicit spend authorization/i);
	assert.match(integrationTest, /paid integration test[\s\S]*Do not run without explicit user authorization for this invocation/i);
	assert.match(integrationTest, /SKIP: paid real-Pi\/model test requires explicit user authorization and ME_PI_ITEST=1/i);
});

test("README routes delegation, migration, and engineering topics", () => {
	const readme = readDocument("README.md");
	assert.match(readme, /~\/.agents\/DELEGATION\.md|specs\/delegate\.md/);
	assert.match(readme, /migration[^\n]*specs\/migration\.md|specs\/migration\.md[^\n]*migration/i);
	assert.match(readme, /CODING_STANDARDS\.md/);
	assert.match(readme, /credentials|auth\.json/i);
});

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
