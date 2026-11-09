import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runToolCall } from "@earendil-works/pi-agent-core";
import {
	applyEnv,
	HAIKU,
	LIMITS,
	LOCAL_TOOLS,
	modelSet,
	OPUS,
	REPO_ROOT,
	run,
	scratch,
	secretPathIn,
	setup,
	TEST_HOME,
	TOOL_PROVENANCE_DETAIL_KEY,
	text,
	writeBlockedIn,
} from "./helpers/delegate-harness.ts";

test("multiple setups restore the original environment after child cleanup, including later keys", async (t) => {
	const existing = "ME_PI_TEST_SETUP_EXISTING";
	const later = "ME_PI_TEST_SETUP_LATER";
	const original = { [existing]: process.env[existing], [later]: process.env[later] };
	t.after(() => applyEnv(original));
	applyEnv({ [existing]: "original", [later]: undefined });
	const before = {
		PI_BIN: process.env.PI_BIN,
		TMPDIR: process.env.TMPDIR,
		ME_PI_DELEGATE_CONFIG: process.env.ME_PI_DELEGATE_CONFIG,
		[existing]: process.env[existing],
		[later]: process.env[later],
	};
	await t.test("two setups complete successfully", (child) => {
		setup(child, { env: { [existing]: "first" } });
		assert.equal(process.env[existing], "first");
		assert.equal(process.env[later], undefined);
		setup(child, { env: { [existing]: "second", [later]: "introduced" } });
		assert.equal(process.env[existing], "second");
		assert.equal(process.env[later], "introduced");
	});
	for (const [key, value] of Object.entries(before)) {
		assert.equal(process.env[key], value, `${key} restored after child cleanup`);
	}
	assert.equal(Object.hasOwn(process.env, later), false, "later key is deleted, not stringified");
});

test("opt-in coordinator status logs a provider-error stop and announces spend before the budget runs out", async (t) => {
	const log = join(mkdtempSync(join(TEST_HOME, "status-")), "status.log");
	const notes = [];
	const ctx = { ui: { notify: (text, level) => notes.push([level, text]) } };
	const { handlers, tool } = setup(t, { env: { ME_PI_STATUS_LOG: log, ME_PI_SPEND_BUDGET_USD: "0.01" } });
	const assistant = (cost, extra = {}) => ({
		message: { role: "assistant", stopReason: "stop", usage: { cost: { total: cost } }, ...extra },
	});
	await handlers.message_end(assistant(0.005), ctx);
	await handlers.agent_settled({ aborted: false }, ctx);
	assert.equal(existsSync(log), false, "an ordinary turn writes nothing");
	await handlers.message_end(assistant(0.0035), ctx);
	await run(tool, { role: "scout", task: "look" });
	await handlers.message_end(
		assistant(0, { stopReason: "error", errorMessage: "403 Key limit exceeded (total limit)" }),
		ctx,
	);
	await handlers.agent_settled({ aborted: false }, ctx);
	const lines = readFileSync(log, "utf8")
		.trim()
		.split("\n")
		.map((line) => line.replace(/^\S+ /, ""));
	assert.deepEqual(lines, [
		"WARNING: estimated spend $0.01 of the $0.01 budget",
		"BUDGET: estimated spend $0.01 of the $0.01 budget reached; stop starting work",
		"STOPPED: account: 403 Key limit exceeded (total limit) (BLOCKER: needs the user)",
	]);
	assert.equal(statSync(log).mode & 0o777, 0o600);
	assert.equal(notes.length, 3);
});

test("registers delegate in the main session; workers get only the secret-path block", (t) => {
	const main = setup(t);
	assert.ok(main.tool);
	assert.deepEqual(Object.keys(main.handlers), [
		"session_before_switch",
		"session_before_fork",
		"session_shutdown",
		"tool_call",
	]);
	const { properties, required } = main.tool.parameters;
	assert.deepEqual(required, ["task"]);
	assert.deepEqual(properties.role.enum, ["general", "scout", "implement"]);
	assert.equal(properties.check.type, "string");
	assert.match(properties.check.description, /one unchained command/);
	assert.match(properties.check.description, /runs it alone, exactly as given, after its final edit/);
	assert.equal(properties.branch, undefined);
	assert.equal(properties.web.type, "boolean");
	assert.equal(properties.answer.maxLength, 400);
	assert.equal(properties.output.type, "boolean");
	assert.equal(typeof main.tool.renderCall, "function");
	assert.equal(typeof main.tool.renderResult, "function");
	const worker = setup(t, { env: { ME_PI_RUN: "1" } });
	assert.equal(worker.tool, undefined, "no nested delegation");
	assert.deepEqual(Object.keys(worker.handlers).sort(), [
		"before_agent_start",
		"message_end",
		"tool_call",
		"tool_execution_end",
	]);
});

test("Pi blocked calls are reported on tool_execution_end, not tool_result", async (t) => {
	const { handlers } = setup(t, {
		env: {
			ME_PI_RUN: "1",
			ME_PI_ROLE: "general",
			ME_PI_DELEGATE_JOB_ID: "actual-pi-job",
			ME_PI_DELEGATE_ATTEMPT: "1",
		},
		withGuard: true,
	});
	let executed = false;
	let afterCalled = false;
	const bash = {
		name: "bash",
		label: "Bash",
		description: "Run a shell command",
		parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
		execute: async () => {
			executed = true;
			return { content: [], details: {} };
		},
	};
	const toolCall = {
		id: "actual-blocked-call",
		name: "bash",
		arguments: { command: "git push origin main" },
	};
	const outcome = await runToolCall(toolCall, {
		tools: [bash],
		assistantMessage: { role: "assistant", content: [] },
		context: { messages: [], tools: [bash] },
		beforeToolCall: ({ toolCall: call, args }) =>
			handlers.tool_call(
				{ toolName: call.name, toolCallId: call.id, input: args },
				{ cwd: REPO_ROOT, hasUI: false },
			),
		afterToolCall: () => {
			afterCalled = true;
		},
	});
	assert.equal(outcome.isError, true);
	assert.equal(executed, false);
	assert.equal(afterCalled, false, "Pi skips afterToolCall for an immediate blocked-call result");
	const event = {
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result: outcome.result,
		isError: outcome.isError,
	};
	await handlers.tool_execution_end(event);
	assert.deepEqual(event.result.details[TOOL_PROVENANCE_DETAIL_KEY], [
		{
			owner: "guard",
			jobId: "actual-pi-job",
			attempt: 1,
			toolCallId: toolCall.id,
			cause: "guard-denial",
			resource: "guard",
			effect: "denied",
		},
	]);
	assert.equal(handlers.tool_result, undefined);
});

test("Pi transports delegate-worker wrap-up denials on tool_execution_end", async (t) => {
	const { handlers } = setup(t, {
		env: {
			ME_PI_RUN: "1",
			ME_PI_ROLE: "general",
			ME_PI_DELEGATE_JOB_ID: "budget-pi-job",
			ME_PI_DELEGATE_ATTEMPT: "1",
			ME_PI_BUDGET: JSON.stringify({ tools: 0, deadline: Date.now() + 60_000, cost: 1 }),
		},
	});
	const read = {
		name: "read",
		label: "Read",
		description: "Read a file",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		execute: async () => ({ content: [], details: {} }),
	};
	const toolCall = { id: "budget-blocked-call", name: "read", arguments: { path: "README.md" } };
	const outcome = await runToolCall(toolCall, {
		tools: [read],
		assistantMessage: { role: "assistant", content: [] },
		context: { messages: [], tools: [read] },
		beforeToolCall: ({ toolCall: call, args }) =>
			handlers.tool_call(
				{ toolName: call.name, toolCallId: call.id, input: args },
				{ cwd: REPO_ROOT, hasUI: false },
			),
	});
	assert.equal(outcome.isError, true);
	const event = {
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result: outcome.result,
		isError: outcome.isError,
	};
	await handlers.tool_execution_end(event);
	assert.deepEqual(event.result.details[TOOL_PROVENANCE_DETAIL_KEY], [
		{
			owner: "delegate-worker",
			jobId: "budget-pi-job",
			attempt: 1,
			toolCallId: toolCall.id,
			cause: "wrap-up-limit",
			resource: "tool-calls",
			effect: "denied",
		},
	]);
});

test("workers cannot name secret paths in read, grep, find, or ls", async (t) => {
	const home = homedir();
	const dir = mkdtempSync(join(TEST_HOME, "secrets-"));
	writeFileSync(join(dir, "notes.txt"), "x");
	// Both targets are missing under the real HOME (only links in TEST_HOME are created): a dangling link must still be blocked by where it points.
	symlinkSync(join(home, ".ssh", "id_ed25519"), join(dir, "innocent-link"));
	symlinkSync(join(home, ".ssh", "me-pi-test-nonexistent-key"), join(dir, "plain-link"));
	symlinkSync("plain-link", join(dir, "relative-link"));
	for (const [tool, input] of [
		["read", { path: "~/.ssh/id_ed25519" }],
		["read", { path: join(home, ".pi/agent/auth.json") }],
		["read", { path: "@.env" }],
		["read", { path: ".env.local" }],
		["read", { path: ".ENV" }],
		["read", { path: ".envrc" }],
		["read", { path: "~/.SSH/id_rsa" }],
		["read", { path: "sub/.npmrc" }],
		["read", { path: "../.git-credentials" }],
		["read", { path: "certs/server.pem" }],
		["read", { path: "innocent-link" }],
		["read", { path: "plain-link" }],
		["read", { path: "relative-link" }],
		["ls", { path: "relative-link/sub" }],
		["grep", { pattern: "x", path: "~/.aws" }],
		["grep", { pattern: "TOKEN", path: ".", glob: "**/.env*" }],
		["grep", { pattern: "x", glob: "{*.ts,id_rsa}" }],
		["find", { pattern: "~/.ssh/*" }],
		["ls", { path: "~/.ssh" }],
	]) {
		assert.ok(secretPathIn(tool, input, dir), `${tool} ${JSON.stringify(input)} should be blocked`);
	}
	for (const [tool, input] of [
		["read", { path: "notes.txt" }],
		["read", { path: ".env.example" }],
		["read", { path: "deploy/id_ed25519.pub" }],
		["read", { path: "src/monkey.ts" }],
		["read", { path: join(home, ".pi/agent/delegate.json") }],
		["grep", { pattern: ".env", glob: "*.ts" }],
		["find", { pattern: "**/*.test.mjs" }],
		["web_search", { path: "~/.ssh" }],
	]) {
		assert.equal(secretPathIn(tool, input, dir), undefined, `${tool} ${JSON.stringify(input)} should pass`);
	}
	const hook = setup(t, { env: { ME_PI_RUN: "1" } }).handlers.tool_call;
	const blocked = await hook({ toolName: "read", input: { path: "~/.ssh/id_rsa" } }, { cwd: dir });
	assert.match(blocked.reason, /\.ssh\/id_rsa may hold secrets; delegated workers cannot read it/);
	assert.equal(await hook({ toolName: "read", input: { path: "notes.txt" } }, { cwd: dir }), undefined);
});

test("implement workers' bash calls are checked against the worker-only rules", async (t) => {
	const bash = (command) => ({ toolName: "bash", input: { command } });
	const hook = setup(t, { env: { ME_PI_RUN: "1", ME_PI_ROLE: "implement" } }).handlers.tool_call;
	const blocked = await hook(bash("git push origin x"), { cwd: REPO_ROOT });
	assert.equal(blocked?.block, true);
	assert.match(blocked.reason, /^Blocked: git push is main-session only; list it as BLOCKED\.$/);
	assert.equal(await hook(bash("bash -n install.sh test/install.test.sh"), { cwd: REPO_ROOT }), undefined);
	const installerChain = await hook(bash("bash -n install.sh && bash install.sh"), { cwd: REPO_ROOT });
	assert.equal(installerChain?.block, true);
	assert.match(installerChain.reason, /install\.sh would change Pi's settings and live links/);
	assert.equal(await hook(bash("npm test"), { cwd: REPO_ROOT }), undefined);
	const checked = setup(t, { env: { ME_PI_RUN: "1", ME_PI_ROLE: "implement", ME_PI_CHECK: "npm test" } }).handlers
		.tool_call;
	const piped = await checked(bash("npm test 2>&1 | tail -25"), { cwd: REPO_ROOT });
	assert.equal(piped?.block, true);
	assert.match(piped.reason, /^Blocked: run `npm test` alone, exactly as given/);
	assert.equal(await checked(bash("npm test"), { cwd: REPO_ROOT }), undefined);
	assert.equal(await checked(bash("npm test -- test/a.test.mjs | tail"), { cwd: REPO_ROOT }), undefined);
	assert.match(
		(await checked(bash("npm test -- --test-timeout=60000"), { cwd: REPO_ROOT })).reason,
		/^Blocked: run `npm test` alone/,
	);
	const other = setup(t, { env: { ME_PI_RUN: "1" } }).handlers.tool_call;
	assert.equal(await other(bash("git push origin x"), { cwd: REPO_ROOT }), undefined);
});

test("workers get a wrap-up budget: scout tool calls, 80% of the time limit and cost cap", async (t) => {
	const { tool } = setup(t, { config: modelSet([HAIKU, OPUS]), env: { FAKE_PI_MODE: "echo-budget" } });
	assert.equal(LIMITS.scoutToolCalls, 60);
	assert.equal(LIMITS.scoutTimeoutSecs, 300);
	assert.equal(LIMITS.costCapUsd, 5);
	assert.equal(LIMITS.wrapUpShare, 0.8);
	for (const [role, tools, secs] of [
		["scout", 60, 300],
		["general", null, 900],
	]) {
		const before = Date.now();
		const res = await run(tool, { role, task: "x" });
		const budget = JSON.parse(text(res).split("\n")[0]);
		assert.equal(budget.tools, tools, role);
		assert.equal(budget.cost, 4, role);
		assert.ok(budget.deadline >= before + secs * 800 && budget.deadline <= Date.now() + secs * 800, role);
	}
});

test("past the wrap-up budget, a worker's tool calls are blocked with an answer-now reason", async (t) => {
	const far = Date.now() + 60_000;
	const worker = (budget, role) =>
		setup(t, { env: { ME_PI_RUN: "1", ME_PI_ROLE: role, ME_PI_BUDGET: JSON.stringify(budget) } }).handlers;
	const call = (h) => h.tool_call({ toolName: "read", input: { path: "README.md" } }, { cwd: REPO_ROOT });

	const counted = worker({ tools: 2, deadline: far, cost: 1 });
	assert.equal(await call(counted), undefined);
	assert.equal(await call(counted), undefined);
	const over = await call(counted);
	assert.equal(
		over.reason,
		"Blocked: budget reached (2 tool calls). Stop using tools; give your final answer now, and list what is unverified.",
	);
	// Three ignored blocks are allowed; the fourth also terminates the run.
	assert.deepEqual(
		[over.terminate, (await call(counted)).terminate, (await call(counted)).terminate],
		[false, false, false],
	);
	assert.equal((await call(counted)).terminate, true);
	// The budget check comes first: an over-budget call to a secret path gets the budget reason.
	const spentFirst = worker({ tools: 0, deadline: far, cost: 1 });
	const secret = await spentFirst.tool_call({ toolName: "read", input: { path: ".env" } }, { cwd: REPO_ROOT });
	assert.match(secret.reason, /budget reached/);

	const priced = worker({ tools: null, deadline: far, cost: 0.5 });
	const usage = (cost) => ({ cost: { total: cost } });
	await priced.message_end({ message: { role: "user", usage: usage(9) } });
	await priced.message_end({ message: { role: "assistant", usage: usage(0.3) } });
	assert.equal(await call(priced), undefined);
	await priced.message_end({ message: { role: "assistant", usage: usage(0.2) } });
	assert.match((await call(priced)).reason, /budget reached \(\$0\.50 cost\)/);

	const single = worker({ tools: 1, deadline: far, cost: 1 });
	await call(single);
	assert.match((await call(single)).reason, /budget reached \(1 tool call\)\./);

	const late = worker({ tools: null, deadline: Date.now() - 1, cost: 1 });
	assert.match((await call(late)).reason, /budget reached \(time\)/);

	const denied = worker({ tools: 1, deadline: far, cost: 1 }, "implement");
	const risky = await denied.tool_call(
		{ toolName: "bash", input: { command: "git push origin x" } },
		{ cwd: REPO_ROOT },
	);
	assert.match(risky.reason, /git push is main-session only/);
	assert.match((await call(denied)).reason, /budget reached \(1 tool call\)/);

	const cappedScout = worker({ tools: 60, deadline: far, cost: 1 }, "scout");
	for (let i = 0; i < 60; i++) assert.equal(await call(cappedScout), undefined);
	assert.match((await call(cappedScout)).reason, /budget reached \(60 tool calls\)/);

	for (const role of ["general", "implement"]) {
		const uncapped = worker({ tools: null, deadline: far, cost: 1 }, role);
		for (let i = 0; i < 150; i++) assert.equal(await call(uncapped), undefined, role);
	}
	const lateImplement = worker({ tools: null, deadline: Date.now() - 1, cost: 0.5 }, "implement");
	await lateImplement.message_end({ message: { role: "assistant", usage: usage(0.5) } });
	assert.match((await call(lateImplement)).reason, /budget reached \(time\)/);
	const pricedImplement = worker({ tools: null, deadline: far, cost: 0.5 }, "implement");
	await pricedImplement.message_end({ message: { role: "assistant", usage: usage(0.2) } });
	await pricedImplement.message_end({ message: { role: "assistant", usage: usage(0.3) } });
	assert.match((await call(pricedImplement)).reason, /budget reached \(\$0\.50 cost\)/);

	const unbounded = setup(t, { env: { ME_PI_RUN: "1", ME_PI_BUDGET: undefined } }).handlers;
	for (let i = 0; i < 150; i++) assert.equal(await call(unbounded), undefined);
	assert.throws(() => setup(t, { env: { ME_PI_RUN: "1", ME_PI_BUDGET: '{"tools":1}' } }), /invalid ME_PI_BUDGET/);
	assert.throws(() => setup(t, { env: { ME_PI_RUN: "1", ME_PI_BUDGET: "" } }), /invalid ME_PI_BUDGET/);
});

test("workers write only inside their own output directory", async (t) => {
	const out = mkdtempSync(join(TEST_HOME, "out-"));
	const cwd = mkdtempSync(join(TEST_HOME, "cwd-"));
	symlinkSync(TEST_HOME, join(out, "escape-link"));
	for (const [tool, input] of [
		["write", { path: join(cwd, "x.md") }],
		["write", { path: "x.md" }],
		["write", { path: join(out, "../x.md") }],
		["write", { path: out }],
		["write", { path: `${out}-sibling/x.md` }],
		["write", { path: join(out, "escape-link/x.md") }],
		["write", { path: "~/x.md" }],
		["write", { path: `file://${out}/x.md` }],
		["write", {}],
		["edit", { path: join(cwd, "x.md") }],
	]) {
		assert.ok(writeBlockedIn(tool, input, cwd, out), `${tool} ${JSON.stringify(input)} should be blocked`);
	}
	for (const input of [{ path: join(out, "a.md") }, { path: `@${out}/new/dir/b.md` }, { path: join(out, "..x.md") }]) {
		assert.equal(writeBlockedIn("write", input, cwd, out), undefined, `${JSON.stringify(input)} should pass`);
	}
	// Pi expands these to $HOME and a file URL, so they are refused even where they would resolve inside.
	assert.match(writeBlockedIn("write", { path: "~/x.md" }, out, out), /use an absolute path inside/);
	assert.match(writeBlockedIn("write", { path: "file:x.md" }, out, out), /use an absolute path inside/);
	// A dangling symlink inside: the write would follow it out.
	symlinkSync(join(cwd, "made-by-write.md"), join(out, "dangling.md"));
	assert.match(writeBlockedIn("write", { path: join(out, "dangling.md") }, cwd, out), /cannot be resolved/);
	// Pi writes `a<NBSP>b/x.md` to `a b/x.md`; a symlink named with the NBSP must not decide the check.
	mkdirSync(join(cwd, "a b"));
	symlinkSync(out, join(cwd, "a\u00A0b"));
	assert.match(writeBlockedIn("write", { path: join(cwd, "a\u00A0b/x.md") }, cwd, out), /is outside/);
	// A relative path resolves against the project: the reason says where it went and where to write.
	const rel = writeBlockedIn("write", { path: "notes/x.md" }, cwd, out);
	assert.ok(rel.startsWith("notes/x.md resolves to "), rel);
	assert.ok(rel.endsWith(`, outside ${out}; write to ${join(out, "notes/x.md")} instead`), rel);
	assert.doesNotMatch(writeBlockedIn("write", { path: "../x.md" }, cwd, out), /write to/);
	assert.doesNotMatch(writeBlockedIn("write", { path: "." }, cwd, out), /write to/);
	// A suggestion through a symlink that leaves the directory is still blocked when followed.
	symlinkSync(cwd, join(out, "linked"));
	const viaLink = writeBlockedIn("write", { path: "linked/x.md" }, cwd, out);
	assert.ok(viaLink.endsWith(`; write to ${join(out, "linked/x.md")} instead`), viaLink);
	assert.match(writeBlockedIn("write", { path: join(out, "linked/x.md") }, cwd, out), /is outside/);
	assert.equal(
		writeBlockedIn("write", { path: join(cwd, "x.md") }, cwd, out),
		`${join(cwd, "x.md")} is outside ${out}`,
	);
	assert.equal(writeBlockedIn("read", { path: join(cwd, "x.md") }, cwd, out), undefined);
	assert.match(writeBlockedIn("write", { path: join(out, "a.md") }, cwd, ""), /without `output: true`/);

	const hook = setup(t, { env: { ME_PI_RUN: "1", ME_PI_OUTPUT_DIR: out } }).handlers.tool_call;
	const blocked = await hook({ toolName: "write", input: { path: join(cwd, "x.md") } }, { cwd });
	assert.match(blocked.reason, /^Blocked: .*x\.md is outside /);
	assert.equal(await hook({ toolName: "write", input: { path: join(out, "a.md") } }, { cwd }), undefined);
	const noOutput = setup(t, { env: { ME_PI_RUN: "1", ME_PI_OUTPUT_DIR: "" } }).handlers.tool_call;
	assert.ok((await noOutput({ toolName: "write", input: { path: join(out, "a.md") } }, { cwd })).block);
});

test("past the wrap-up budget, an output worker can still write into its output directory, within the allowance", async (t) => {
	const out = mkdtempSync(join(TEST_HOME, "out-"));
	const cwd = mkdtempSync(join(TEST_HOME, "cwd-"));
	const budget = JSON.stringify({ tools: 0, deadline: Date.now() + 60_000, cost: 1 });
	const hook = setup(t, { env: { ME_PI_RUN: "1", ME_PI_OUTPUT_DIR: out, ME_PI_BUDGET: budget } }).handlers.tool_call;
	const inside = { toolName: "write", input: { path: join(out, "a.md") } };
	assert.equal(await hook(inside, { cwd }), undefined);
	const outside = await hook({ toolName: "write", input: { path: join(cwd, "x.md") } }, { cwd });
	assert.match(outside.reason, /budget reached/);
	assert.equal(outside.terminate, false);
	for (const [toolName, input] of [
		["read", { path: join(out, "a.md") }],
		["bash", { command: "ls" }],
	]) {
		const blocked = await hook({ toolName, input }, { cwd });
		assert.match(blocked.reason, /budget reached/, toolName);
	}
	// Allowed writes spend the same allowance: once it is gone, an in-directory write also terminates.
	const last = await hook(inside, { cwd });
	assert.match(last.reason, /budget reached/);
	assert.equal(last.terminate, true);

	const writer = setup(t, { env: { ME_PI_RUN: "1", ME_PI_OUTPUT_DIR: out, ME_PI_BUDGET: budget } }).handlers.tool_call;
	for (let i = 0; i < 3; i++) assert.equal(await writer(inside, { cwd }), undefined);
	assert.equal((await writer(inside, { cwd })).terminate, true);

	// An implement worker's output directory is its checkout, so its writes stay blocked past the budget.
	const implementer = setup(t, {
		env: { ME_PI_RUN: "1", ME_PI_ROLE: "implement", ME_PI_OUTPUT_DIR: out, ME_PI_BUDGET: budget },
	}).handlers.tool_call;
	assert.match((await implementer(inside, { cwd })).reason, /budget reached/);
});

test("output: each worker gets write and a fresh 0700 directory; the result lists files, not contents", async (t) => {
	const { tool } = setup(t, { config: modelSet([HAIKU, OPUS]), env: { FAKE_PI_MODE: "write-draft" } });
	const res = await run(tool, { task: "draft", output: true, runs: [{ model: HAIKU }, { model: OPUS }] });
	assert.equal(res.isError, false, text(res));
	assert.doesNotMatch(text(res), /DRAFT-BODY/);
	const dirs = [...text(res).matchAll(/\nFiles in (\S+): notes\/draft\.md \(10 B\)\n/g)].map((m) => m[1]);
	assert.equal(dirs.length, 2, text(res));
	assert.notEqual(dirs[0], dirs[1]);
	for (const dir of dirs) {
		assert.equal(statSync(dir).mode & 0o777, 0o700);
		assert.equal(readFileSync(join(dir, "notes/draft.md"), "utf8"), "DRAFT-BODY");
	}
	assert.match(text(res), new RegExp(`tools=${LOCAL_TOOLS},write promptNamesDir=true`));
});

test("output with rebuttal: round 2 gets new directories and the round-1 file lists", async (t) => {
	const marker = scratch("marker");
	const { tool } = setup(t, {
		config: modelSet([HAIKU, OPUS]),
		env: { FAKE_PI_MODE: "write-draft", FAKE_PI_MARKER: marker },
	});
	const res = await run(tool, { task: "d", output: true, runs: [{ model: HAIKU }, { model: OPUS }], rebuttal: true });
	assert.equal(res.isError, false, text(res));
	const dirsOf = (s) => [...s.matchAll(/Files in (\S+): notes\/draft\.md \(10 B\)/g)].map((m) => m[1]);
	const round1File = text(res).match(/Round-1 answers: (\S+)/)[1];
	const round1Dirs = dirsOf(readFileSync(round1File, "utf8"));
	const round2Dirs = dirsOf(text(res));
	assert.equal(new Set([...round1Dirs, ...round2Dirs]).size, 4, text(res));
	const round2 = readFileSync(marker, "utf8")
		.trim()
		.split("\n")
		.map(JSON.parse)
		.filter((c) => c.prompt.includes("## Round 2"));
	for (const c of round2) assert.deepEqual(dirsOf(c.prompt).sort(), [...round1Dirs].sort());
});

test("output: the file list is capped and quotes names with control characters", async (t) => {
	const { tool } = setup(t, { config: modelSet([HAIKU, OPUS]), env: { FAKE_PI_MODE: "write-many" } });
	const res = text(await run(tool, { task: "x", output: true }));
	assert.match(res, /: "a\\n\[forged label\]" \(1 B\), f00 \(1 B\), /);
	assert.match(res, /, f48 \(1 B\), \u2026 3 more\n\[claude-opus-5-5 /);
	assert.equal(res.split("\n").length, 3, res);
});

test("output: a failed round-2 run lists its own directory", async (t) => {
	const { tool } = setup(t, {
		config: modelSet([HAIKU, OPUS]),
		env: { FAKE_PI_MODE: "fail-round2", FAKE_PI_FAIL_MODEL: OPUS },
	});
	const res = await run(tool, { task: "x", output: true, runs: [{ model: HAIKU }, { model: OPUS }], rebuttal: true });
	assert.match(
		text(res),
		/round 2 failed: exit 1: task-specific error in round 2\nFiles in \S+: none written\nRound-1 answer:/,
	);
	// The TUI view names the failed round-2 run's directory too, and the rounds do not repeat the answers.
	assert.match(
		res.details.view.runs[1].round2Failure,
		/^exit 1: task-specific error in round 2; Files in \S+: none written$/,
	);
	assert.equal(res.details.round1[0].output, undefined);
	assert.equal(res.details.round2[0].output, undefined);
	assert.match(res.details.round1[0].outDir, /me-pi-delegate-out-/);
});

test("output: a failed run still lists its files; a failed mkdtemp is reported", async (t) => {
	const failed = setup(t, { config: modelSet([HAIKU, OPUS]), env: { FAKE_PI_MODE: "fail" } });
	assert.match(text(await run(failed.tool, { task: "x", output: true })), /\nFiles in \S+: none written\n\[/);
	const noTmp = setup(t, { config: modelSet([HAIKU, OPUS]), env: { TMPDIR: join(TEST_HOME, "missing-tmp") } });
	const res = await run(noTmp.tool, { task: "x", output: true });
	assert.equal(res.isError, true);
	assert.match(text(res), /^\u2717 could not create the output directory: ENOENT/);
});

test("output with no files written says so; without output there is no write tool", async (t) => {
	const none = setup(t, { config: modelSet([HAIKU, OPUS]) });
	const empty = text(await run(none.tool, { task: "x", output: true }));
	assert.match(empty, /^DONE .*tools=read,grep,find,ls,Skill,write .*\nFiles in \S+: none written\n\[/);
	const without = text(await run(none.tool, { task: "x" }));
	assert.doesNotMatch(without, /Files in|,write/);
});
