import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	coordinatorEnv,
	costMedian,
	finalState,
	promptOf,
	renderContract,
	reportStatus,
	sessionFacts,
	type Task,
	validateTask,
} from "../evals/ab-task.ts";
import { piCommand, processesWith, sweepProcesses } from "../evals/live.ts";
import type { Sandbox } from "../evals/sandbox.ts";
import { sessionSpend } from "../evals/score.ts";

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

const said = (cost: number) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { cost: { total: cost } } },
});

test("sessionSpend sums coordinator usage, and foreground results and background messages once each, by role", () => {
	const log = lines(
		said(0.5),
		call("c1", { role: "implement", task: "x" }),
		result("c1", "✓ im1 feat; check ✓", { view: { stage: "Done", runs: [{ cost: 1.25, ms: 90_000 }] } }),
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
	const spend = sessionSpend(log);
	assert.equal(spend.coordinator, 0.5);
	assert.equal(spend.worker, 1.25 + 0.75 + 0.125 + 2);
	assert.equal(spend.total, 0.5 + spend.worker);
	assert.deepEqual([spend.partial, spend.pending], [false, []]);
	assert.deepEqual(spend.byRole, {
		implement: { calls: 2, cost: 3.25, ms: 90_000 },
		general: { calls: 1, cost: 0.75, ms: 0 },
		scout: { calls: 1, cost: 0.125, ms: 0 },
	});
});

test("sessionSpend is partial when a started background job never delivered, and lists it", () => {
	const log = lines(
		call("c1", { role: "implement", task: "x", background: true }),
		result("c1", "Started background job bg1 (sol).", { background: "bg1" }),
		call("c2", { role: "scout", task: "y", background: true }),
		result("c2", "Started background job bg2 (luna).", { background: "bg2" }),
		background("bg2", view(0.25)),
	);
	const spend = sessionSpend(log);
	assert.equal(spend.worker, 0.25);
	assert.deepEqual([spend.partial, spend.pending], [true, ["bg1"]]);
});

test("sessionSpend counts a call that never returned as pending, without cost, and ignores other tools", () => {
	const log = lines(
		{ type: "session", version: 3 },
		call("c1", { role: "implement", task: "x" }),
		{
			type: "message",
			message: { role: "toolResult", toolCallId: "z", toolName: "bash", content: [], details: view(9) },
		},
		{ type: "custom_message", customType: "other", content: "Background delegate job bg1:", details: view(9) },
	);
	assert.deepEqual(sessionSpend(log), {
		coordinator: 0,
		worker: 0,
		total: 0,
		pending: ["c1"],
		partial: true,
		byRole: { implement: { calls: 1, cost: 0, ms: 0 } },
	});
});

test("finalState voids an arm-B attempt that used implement, and keeps arm A's", () => {
	const base = { state: "completed" as const, note: "", statusLog: "", hasLog: true, implementCalls: 1 };
	assert.deepEqual(finalState({ ...base, arm: "B" }), { state: "void", note: "arm B used implement" });
	assert.deepEqual(finalState({ ...base, arm: "B", state: "capped", note: "$30" }), {
		state: "void",
		note: "arm B used implement",
	});
	assert.deepEqual(finalState({ ...base, arm: "A" }), { state: "completed", note: "" });
	assert.deepEqual(finalState({ ...base, arm: "B", implementCalls: 0 }), { state: "completed", note: "" });
});

test("finalState: status-log stops win, and a completed run with no log is incomplete", () => {
	const base = { arm: "A" as const, state: "completed" as const, note: "", hasLog: true, implementCalls: 0 };
	assert.deepEqual(finalState({ ...base, statusLog: "STOPPED: account 401" }), {
		state: "incomplete",
		note: "account",
	});
	assert.deepEqual(finalState({ ...base, statusLog: "STOPPED: infra" }), { state: "void", note: "infra" });
	assert.deepEqual(finalState({ ...base, statusLog: "", hasLog: false }), {
		state: "incomplete",
		note: "no session log",
	});
	assert.deepEqual(finalState({ ...base, statusLog: "", hasLog: false, state: "timeout", note: "120 min" }), {
		state: "timeout",
		note: "120 min",
	});
});

test("costMedian leaves out unknown, partial, and non-completed costs instead of counting them as $0", () => {
	const r = (state: string, source: string, total: number) => ({ state, cost: { source, total } });
	assert.deepEqual(
		costMedian([
			r("completed", "pi-estimate", 4),
			r("completed", "pi-estimate", 6),
			r("completed", "unavailable", 0),
			r("capped", "pi-estimate", 25),
			r("completed", "partial", 1),
		]),
		{ median: 5, excluded: 3 },
	);
	assert.deepEqual(costMedian([r("timeout", "unavailable", 0)]), { median: undefined, excluded: 1 });
});

test("the coordinator command carries no GitHub token and pins git's ssh to no identity", () => {
	const sandbox = { env: { HOME: "/s/home", PATH: "/usr/bin" } } as unknown as Sandbox;
	const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
	Object.assign(process.env, { GH_TOKEN: "x", GITHUB_TOKEN: "y" });
	try {
		const cmd = piCommand("/bin/pi", sandbox, coordinatorEnv("/s/status.log", 25), "/s/sessions");
		assert.deepEqual(cmd.slice(0, 2), ["env", "-i"]);
		assert.equal(
			cmd.some((a) => /^(GH_TOKEN|GITHUB_TOKEN)=/.test(a)),
			false,
		);
		assert.ok(
			cmd.includes(
				"GIT_SSH_COMMAND=ssh -F /dev/null -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o BatchMode=yes",
			),
		);
		assert.ok(cmd.includes("GIT_TERMINAL_PROMPT=0"));
		assert.ok(cmd.includes("ME_PI_UNATTENDED=1"));
		assert.ok(cmd.includes("ME_PI_SPEND_BUDGET_USD=25"));
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
});

/** A temp root with HOME and TMPDIR pointed into it, as a sandbox root would be. */
function scratch(t: any) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "evals-sweep-")));
	const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
	Object.assign(process.env, { HOME: dir, TMPDIR: dir });
	t.after(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}

const exited = (child: ReturnType<typeof spawn>) =>
	new Promise<NodeJS.Signals | null>((done) => {
		if (child.exitCode !== null || child.signalCode !== null) done(child.signalCode);
		else child.once("exit", (_code, sig) => done(sig));
	});

test("sweepProcesses kills a detached process whose argv names the root, and returns the count", async (t) => {
	const root = scratch(t);
	// Detached like a delegate worker: its own process group, so killing the tmux session would not reach it.
	const child = spawn("sleep", ["300"], { argv0: join(root, "worker"), detached: true, stdio: "ignore" });
	t.after(() => child.kill("SIGKILL"));
	const gone = exited(child);
	await new Promise((r) => setTimeout(r, 200));
	assert.deepEqual(await processesWith(root), [child.pid]);
	assert.equal(await sweepProcesses(root, [], { graceMs: 300, termMs: 2_000, pollMs: 50 }), 1);
	assert.equal(await gone, "SIGTERM");
	assert.deepEqual(await processesWith(root), []);
});

test("sweepProcesses SIGKILLs a process that ignores SIGTERM, and waits for one that exits in its grace", async (t) => {
	const root = scratch(t);
	const stubborn = spawn("sh", ["-c", 'trap "" TERM; while :; do sleep 0.1; done', join(root, "stubborn")], {
		detached: true,
		stdio: "ignore",
	});
	t.after(() => stubborn.kill("SIGKILL"));
	const gone = exited(stubborn);
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(await sweepProcesses(root, [], { graceMs: 200, termMs: 500, pollMs: 50 }), 1);
	assert.equal(await gone, "SIGKILL");

	const polite = spawn("sleep", ["0.3"], { argv0: join(root, "polite"), stdio: "ignore" });
	const done = exited(polite);
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(await sweepProcesses(root, [], { graceMs: 5_000, termMs: 500, pollMs: 50 }), 0);
	assert.equal(await done, null);
});

test("sweepProcesses also waits for a listed pid whose argv does not name the root", async (t) => {
	const root = scratch(t);
	const child = spawn("sleep", ["300"], { stdio: "ignore" });
	t.after(() => child.kill("SIGKILL"));
	const gone = exited(child);
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(await sweepProcesses(root, [child.pid!], { graceMs: 200, termMs: 2_000, pollMs: 50 }), 1);
	assert.equal(await gone, "SIGTERM");
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
