import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promptOf, renderContract, reportStatus, sessionFacts, type Task, validateTask } from "../evals/ab-task.ts";
import { workerSpend } from "../evals/score.ts";

const lines = (...entries: object[]) => entries.map((e) => JSON.stringify(e)).join("\n");
const call = (id: string, args: object) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "toolCall", id, name: "delegate", arguments: args }] },
});
const view = (...costs: number[]) => ({ view: { stage: "Done", runs: costs.map((cost) => ({ cost })) } });
const result = (id: string, text: string, details: object) => ({
	type: "message",
	message: { role: "toolResult", toolCallId: id, toolName: "delegate", content: [{ type: "text", text }], details },
});
const background = (job: string, details: object) => ({
	type: "custom_message",
	customType: "delegate",
	content: `Background delegate job ${job}:\n\nanswer`,
	display: true,
	details,
});

test("workerSpend sums foreground results and background messages once each, by role", () => {
	const log = lines(
		call("c1", { role: "implement", task: "x" }),
		result("c1", "✓ im1 feat; check ✓", view(1.25)),
		call("c2", { task: "review", runs: [{}, {}] }),
		result("c2", "two answers", view(0.5, 0.25)),
		call("c3", { role: "scout", task: "find", background: true }),
		result("c3", "Started background job bg1 (luna). Its answer arrives as a later message", { background: "bg1" }),
		call("c4", { role: "implement", task: "fix", background: true }),
		result("c4", "Started background job bg2 (sol).", { background: "bg2" }),
		background("bg2", view(2)),
		background("bg1", view(0.125)),
		// A replayed message for a job already counted adds nothing.
		background("bg1", view(0.125)),
	);
	const spend = workerSpend(log);
	assert.equal(spend.cost, 1.25 + 0.75 + 0.125 + 2);
	assert.deepEqual(spend.byRole, {
		implement: { calls: 2, cost: 3.25 },
		general: { calls: 1, cost: 0.75 },
		scout: { calls: 1, cost: 0.125 },
	});
});

test("workerSpend counts a call that never returned, without cost, and ignores other tools", () => {
	const log = lines(
		{ type: "session", version: 3 },
		call("c1", { role: "implement", task: "x" }),
		{
			type: "message",
			message: { role: "toolResult", toolCallId: "z", toolName: "bash", content: [], details: view(9) },
		},
		{ type: "custom_message", customType: "other", content: "Background delegate job bg1:", details: view(9) },
	);
	assert.deepEqual(workerSpend(log), { cost: 0, byRole: { implement: { calls: 1, cost: 0 } } });
});

const TASK: Task = {
	id: "t1",
	repo: "/r/target",
	base: "abc123",
	branch: "feat/x",
	brief: "/r/brief.md",
	check: "npm run check",
	setup: ["npm ci"],
	coordinator: { provider: "p", model: "m", thinking: "high" },
	pool: { version: 3 },
};
const template = readFileSync(join(import.meta.dirname, "..", "evals", "ab", "contract.md"), "utf8");
const paths = { run: "s A1", brief: "/a/brief.md", worktree: "/a/worktree", report: "/a/report.md" };

test("the arm A contract names implement-me-pi and binds the implement worker to the brief", () => {
	const c = renderContract(template, TASK, "A", paths);
	assert.doesNotMatch(c, /\{\{/);
	assert.match(c, /step 1 of `implement-me-pi`/);
	assert.match(c, /Brief: `\/a\/brief\.md`\. It binds you and your implement worker; give the worker that path\./);
	assert.match(c, /Checkout: `\/a\/worktree` \(your cwd\), branch `feat\/x`, created clean from `abc123`/);
	assert.match(c, /Check: `npm run check`/);
	assert.match(c, /Write `\/a\/report\.md`/);
	assert.equal(
		promptOf("A", "/a/contract.md"),
		"/skill:implement-me-pi Your contract is /a/contract.md; it answers every question of step 1.",
	);
});

test("the arm B contract names implement-direct and has no worker clause", () => {
	const c = renderContract(template, TASK, "B", paths);
	assert.match(c, /step 1 of `implement-direct`/);
	assert.match(c, /Brief: `\/a\/brief\.md`\. It binds you\./);
	assert.doesNotMatch(c, /implement worker/);
	assert.match(promptOf("B", "/c"), /^\/skill:implement-direct /);
});

test("renderContract refuses a template placeholder it cannot fill", () => {
	assert.throws(() => renderContract("{{TASK}} {{NOPE}}", TASK, "A", paths), /unfilled placeholders \{\{NOPE\}\}/);
});

test("validateTask accepts a complete task and lists every problem of a broken one", () => {
	assert.deepEqual(validateTask({ ...TASK }), TASK);
	const { base: _, ...noBase } = TASK;
	assert.throws(() => validateTask(noBase), /base: required string/);
	assert.throws(() => validateTask({ ...TASK, repo: "target" }), /repo: must be an absolute path/);
	assert.throws(() => validateTask({ ...TASK, brief: "brief.md" }), /brief: must be an absolute path/);
	assert.throws(() => validateTask({ ...TASK, setup: "npm ci" }), /setup: required array/);
	assert.throws(() => validateTask({ ...TASK, pool: { version: 2 } }), /pool: .*version 3/);
	assert.throws(() => validateTask({ ...TASK, coordinator: { provider: "p" } }), /coordinator: required/);
	assert.throws(() => validateTask([]), /must be a JSON object/);
	assert.throws(
		() => validateTask({ ...noBase, repo: "rel" }),
		(err: Error) => /base: required/.test(err.message) && /repo: must be an absolute path/.test(err.message),
	);
});

test("reportStatus reads the Status line or heading", () => {
	assert.equal(reportStatus("# Report\n## Status\n\nDONE\n## Final SHA"), "DONE");
	assert.equal(reportStatus("Status: BLOCKED (no route)"), "BLOCKED");
	assert.equal(reportStatus("- **Status**: DONE"), "DONE");
	assert.equal(reportStatus("all good"), "unknown");
});

test("sessionFacts counts compactions and blocked or denied tool results", () => {
	const tool = (text: string) => ({
		type: "message",
		message: { role: "toolResult", toolCallId: "x", toolName: "bash", content: [{ type: "text", text }] },
	});
	const log = lines(
		{ type: "compaction", summary: "s", firstKeptEntryId: "a" },
		tool("Blocked (force push): unattended session, no one can approve."),
		tool("BLOCKED: npm ci: offline"),
		tool("ok, nothing BLOCKED here"),
		{ type: "compaction", summary: "s", firstKeptEntryId: "b" },
	);
	assert.deepEqual(sessionFacts(log), { compactions: 2, blocked: 2 });
});
