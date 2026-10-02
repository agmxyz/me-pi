import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

// me-setup resolves ~/.pi/agent at import time from $HOME; pin it to a temp
// dir before the dynamic import so settings writes land in a sandbox.
const TEST_HOME = mkdtempSync(join(tmpdir(), "me-setup-test-"));
process.env.HOME = TEST_HOME;
process.on("exit", () => {
	try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});

const { default: registerMeSetup, applyAgentPick } = await import("./me-setup.ts");

const SETTINGS_PATH = join(TEST_HOME, ".pi", "agent", "settings.json");

function writeSettings(settings) {
	mkdirSync(join(TEST_HOME, ".pi", "agent"), { recursive: true });
	writeFileSync(SETTINGS_PATH, typeof settings === "string" ? settings : JSON.stringify(settings, null, 2) + "\n");
}

function readSettingsRaw() {
	return readFileSync(SETTINGS_PATH, "utf8");
}

function fakePi() {
	const handlers = {};
	let command;
	const setModelCalls = [];
	const pi = {
		on: (event, handler) => { handlers[event] = handler; },
		registerCommand: (_name, definition) => { command = definition; },
		setModel: async (model) => { setModelCalls.push(model); return true; },
	};
	return { pi, handlers, get command() { return command; }, setModelCalls };
}

test("saves provider separately from a slash-containing model id", () => {
	assert.deepEqual(
		applyAgentPick(undefined, {
			model: "z-ai/glm-5.3-flash",
			defaultProvider: "openrouter",
			thinking: "xhigh",
		}),
		{
			model: "z-ai/glm-5.3-flash",
			defaultProvider: "openrouter",
			thinking: "xhigh",
		},
	);
});

test("rejects removed subcommands with only the supported usage", async () => {
	const fp = fakePi();
	registerMeSetup(fp.pi);
	const command = fp.command;
	const notifications = [];
	const ctx = { hasUI: true, mode: "tui", ui: { notify: (message) => notifications.push(message) } };
	for (const args of ["default openai/model", "models", "models reset scout", "reset scout", "status extra"]) {
		await command.handler(args, ctx);
		assert.equal(notifications.pop(), "usage: /me-setup\n       /me-setup status");
	}
});

test("routes status to the read-only report", async () => {
	const fp = fakePi();
	registerMeSetup(fp.pi);
	const command = fp.command;
	const notifications = [];
	const ctx = { hasUI: true, mode: "tui", ui: { notify: (message) => notifications.push(message) } };
	await command.handler("status", ctx);
	assert.equal(notifications.length, 1);
	assert.match(notifications[0], /^rig: /);
});

test("updates provider for the same model and clears inherited thinking", () => {
	assert.deepEqual(
		applyAgentPick(
			{ model: "gpt-6-luna", defaultProvider: "openai", thinking: "low", tools: ["subagent"] },
			{ model: "gpt-6-luna", defaultProvider: "openai-codex" },
		),
		{ model: "gpt-6-luna", defaultProvider: "openai-codex", tools: ["subagent"] },
	);
});

test("model_select with source set saves default model and provider", () => {
	const { pi, handlers } = fakePi();
	registerMeSetup(pi);
	writeSettings({ subagents: { defaultThinking: "high", agentOverrides: { reviewer: { model: "r", defaultProvider: "rp" } } } });
	const ctx = { hasUI: true, mode: "tui", ui: { notify: () => {} } };
	handlers.model_select({ type: "model_select", model: { provider: "openai-codex", id: "gpt-6-luna" }, previousModel: undefined, source: "set" }, ctx);
	const saved = JSON.parse(readSettingsRaw());
	assert.equal(saved.subagents.defaultModel, "gpt-6-luna");
	assert.equal(saved.subagents.defaultProvider, "openai-codex");
	assert.equal(saved.subagents.defaultThinking, "high");
	assert.deepEqual(saved.subagents.agentOverrides, { reviewer: { model: "r", defaultProvider: "rp" } });
});

test("model_select with source restore does not overwrite the saved default", () => {
	const { pi, handlers } = fakePi();
	registerMeSetup(pi);
	const raw = JSON.stringify({ subagents: { defaultModel: "keep-me", defaultProvider: "keep-prov" } });
	writeSettings(raw);
	const ctx = { hasUI: true, mode: "tui", ui: { notify: () => {} } };
	handlers.model_select({ type: "model_select", model: { provider: "other", id: "other-model" }, previousModel: undefined, source: "restore" }, ctx);
	assert.equal(readSettingsRaw(), raw);
});

test("model_select skips the rewrite when settings already match", () => {
	const { pi, handlers } = fakePi();
	registerMeSetup(pi);
	// Compact formatting: a rewrite would reformat the file, so raw equality proves the skip.
	const raw = JSON.stringify({ subagents: { defaultModel: "same-model", defaultProvider: "same-provider" } });
	writeSettings(raw);
	const ctx = { hasUI: true, mode: "tui", ui: { notify: () => {} } };
	handlers.model_select({ type: "model_select", model: { provider: "same-provider", id: "same-model" }, previousModel: undefined, source: "set" }, ctx);
	assert.equal(readSettingsRaw(), raw);
});

test("picking a default in the chooser switches the active session model", async () => {
	const fp = fakePi();
	registerMeSetup(fp.pi);
	const command = fp.command;
	const { setModelCalls } = fp;
	writeSettings({ subagents: { defaultModel: "old-model", defaultProvider: "old-provider" } });
	const selectAnswers = ["choose another…"];
	const customAnswers = ["test-provider/test-model", "inherit"];
	const ctx = {
		hasUI: true,
		mode: "tui",
		model: { provider: "old-ctx-prov", id: "old-ctx-model" },
		modelRegistry: { find: (provider, id) => ({ provider, id, resolvedFrom: "registry" }) },
		setModel: async (model) => { setModelCalls.push(model); return true; },
		ui: {
			notify: () => {},
			select: (_title, _options) => Promise.resolve(selectAnswers.shift()),
			custom: (_factory) => Promise.resolve(customAnswers.shift()),
		},
	};
	await command.handler("", ctx);
	assert.deepEqual(setModelCalls, [{ provider: "test-provider", id: "test-model", resolvedFrom: "registry" }]);
	const saved = JSON.parse(readSettingsRaw());
	assert.equal(saved.subagents.defaultModel, "test-model");
	assert.equal(saved.subagents.defaultProvider, "test-provider");
});

test("picking a default switches the active session model via pi.setModel when ctx omits setModel", async () => {
	const fp = fakePi();
	registerMeSetup(fp.pi);
	const command = fp.command;
	const { setModelCalls } = fp;
	writeSettings({ subagents: { defaultModel: "old-model", defaultProvider: "old-provider" } });
	const selectAnswers = ["choose another…"];
	const customAnswers = ["pi-provider/pi-model", "inherit"];
	const ctx = {
		hasUI: true,
		mode: "tui",
		model: { provider: "old-prov", id: "old-model" },
		modelRegistry: { find: (provider, id) => ({ provider, id, resolvedFrom: "registry" }) },
		ui: {
			notify: () => {},
			select: (_title, _options) => Promise.resolve(selectAnswers.shift()),
			custom: (_factory) => Promise.resolve(customAnswers.shift()),
		},
	};
	await command.handler("", ctx);
	assert.deepEqual(setModelCalls, [{ provider: "pi-provider", id: "pi-model", resolvedFrom: "registry" }]);
	const saved = JSON.parse(readSettingsRaw());
	assert.equal(saved.subagents.defaultModel, "pi-model");
	assert.equal(saved.subagents.defaultProvider, "pi-provider");
});

test("picking an uncatalogued default model does not call setModel with a stub", async () => {
	const fp = fakePi();
	registerMeSetup(fp.pi);
	const command = fp.command;
	const { setModelCalls } = fp;
	writeSettings({ subagents: { defaultModel: "old-model", defaultProvider: "old-provider" } });
	const selectAnswers = ["choose another…"];
	const customAnswers = ["uncatalogued-provider/uncatalogued-model", "inherit"];
	const notifications = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		model: { provider: "stale-prov", id: "stale-model" },
		modelRegistry: { find: () => undefined },
		setModel: async (model) => { setModelCalls.push(model); return true; },
		ui: {
			notify: (msg) => { notifications.push(msg); },
			select: (_title, _options) => Promise.resolve(selectAnswers.shift()),
			custom: (_factory) => Promise.resolve(customAnswers.shift()),
		},
	};
	await command.handler("", ctx);
	assert.deepEqual(setModelCalls, []);
	const saved = JSON.parse(readSettingsRaw());
	assert.equal(saved.subagents.defaultModel, "uncatalogued-model");
	assert.equal(saved.subagents.defaultProvider, "uncatalogued-provider");
	assert.match(notifications[0], /could not be switched/);
});

// Worker guard: a delegate worker (ME_PI_RUN set) must never see the
// coordinator addendum; if pi ever merges it in, the run fails closed.
const ADDENDUM_PATH = join(TEST_HOME, ".pi", "agent", "APPEND_SYSTEM.md");
const ADDENDUM = "## Coordination\nStay the coordinator.";

function runWorkerGuard(t, { workerRun, systemPrompt }) {
	mkdirSync(join(TEST_HOME, ".pi", "agent"), { recursive: true });
	writeFileSync(ADDENDUM_PATH, ADDENDUM + "\n");
	const previousRun = process.env.ME_PI_RUN;
	if (workerRun) process.env.ME_PI_RUN = workerRun;
	else delete process.env.ME_PI_RUN;
	t.after(() => {
		if (previousRun === undefined) delete process.env.ME_PI_RUN;
		else process.env.ME_PI_RUN = previousRun;
	});
	const exit = t.mock.method(process, "exit", () => {});
	const stderr = t.mock.method(console, "error", () => {});
	const { pi, handlers } = fakePi();
	registerMeSetup(pi);
	handlers.before_agent_start({ type: "before_agent_start", prompt: "Do the attached task.", systemPrompt, systemPromptOptions: {} }, {});
	return { exitCodes: exit.mock.calls.map((call) => call.arguments[0]), errors: stderr.mock.calls.map((call) => call.arguments.join(" ")) };
}

test("worker guard exits non-zero when a worker prompt contains the coordinator addendum", (t) => {
	const { exitCodes, errors } = runWorkerGuard(t, { workerRun: "implementer-1", systemPrompt: `base\n<addendum>\n${ADDENDUM}\n</addendum>` });
	assert.deepEqual(exitCodes, [1]);
	assert.match(errors[0], /coordinator addendum/);
});

test("worker guard lets a worker prompt without the coordinator addendum run", (t) => {
	const { exitCodes } = runWorkerGuard(t, { workerRun: "implementer-1", systemPrompt: "base\n<addendum>\nDelegated worker run.\n</addendum>" });
	assert.deepEqual(exitCodes, []);
});

test("worker guard ignores the main session", (t) => {
	const { exitCodes } = runWorkerGuard(t, { workerRun: undefined, systemPrompt: `base\n<addendum>\n${ADDENDUM}\n</addendum>` });
	assert.deepEqual(exitCodes, []);
});

// Commit gate: the coordinator may `git commit` only after a finished reviewer
// run over the exact current diff returned `No issues.`; workers never commit.
// `delegate` is a stub on PATH (next to the real git); runs live in a temp
// ME_PI_RUNS_ROOT and end with delegate's real out.md trailer.
const DIFF_HASH = "3f".repeat(32);
const GIT_DIR = dirname(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim());
const trailer = (id) => `\n[${id} exit=0 cost=0.001698 5s]\n`;

function cleanReview(overrides = {}) {
	return { meta: {}, exit: "0", out: (id) => `No issues.\n${trailer(id)}`, ...overrides };
}

function setupCommitGate(t, { stub = "hash", runs = [], workerRun } = {}) {
	const root = mkdtempSync(join(TEST_HOME, "gate-"));
	const project = join(root, "project");
	const elsewhere = join(root, "elsewhere");
	const runsRoot = join(root, "runs");
	const bin = join(root, "bin");
	for (const dir of [project, elsewhere, runsRoot, bin]) mkdirSync(dir);
	mkdirSync(join(project, "sub"));
	for (const repo of [project, elsewhere]) execFileSync("git", ["init", "-q", repo]);
	const callsFile = join(root, "delegate-calls");
	if (stub !== "missing") {
		const body = {
			hash: `echo ${DIFF_HASH}`,
			empty: ":",
			fail: `echo "diff-hash: not a git repository" >&2\nexit 3`,
			garbage: "echo warning: something odd",
		}[stub];
		writeFileSync(join(bin, "delegate"), `#!/bin/sh\necho "$*" >> '${callsFile}'\n${body}\n`, { mode: 0o755 });
	}
	(typeof runs === "function" ? runs({ project, elsewhere }) : runs).forEach((run, i) => {
		const id = `reviewer-1002-181724-${8000 + i}`;
		const dir = join(runsRoot, id);
		mkdirSync(dir);
		// Meta records the realpath; ctx.cwd below is the unresolved tmp path.
		const meta = { role: "reviewer", cwd: realpathSync(project), diff_sha: DIFF_HASH, started: "1790000000", ...run.meta };
		writeFileSync(join(dir, "meta"), Object.entries(meta).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}\n`).join(""));
		if (run.exit !== null) writeFileSync(join(dir, "exit"), `${run.exit}\n`);
		if (run.out !== null) writeFileSync(join(dir, "out.md"), typeof run.out === "function" ? run.out(id) : run.out);
	});
	const saved = { PATH: process.env.PATH, ME_PI_RUNS_ROOT: process.env.ME_PI_RUNS_ROOT, ME_PI_RUN: process.env.ME_PI_RUN };
	process.env.PATH = `${bin}:${GIT_DIR}`;
	process.env.ME_PI_RUNS_ROOT = runsRoot;
	if (workerRun) process.env.ME_PI_RUN = workerRun;
	else delete process.env.ME_PI_RUN;
	t.after(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	const { pi, handlers } = fakePi();
	registerMeSetup(pi);
	const ctx = { cwd: project, hasUI: false, mode: "print", ui: { notify: () => {} } };
	return {
		project,
		delegateCalls: () => (existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n") : []),
		gate: (command, toolName = "bash") => handlers.tool_call({ type: "tool_call", toolName, toolCallId: "call-1", input: { command } }, ctx),
	};
}

test("commit gate blocks every commit from a delegate worker", async (t) => {
	const g = setupCommitGate(t, { workerRun: "implementer-1", runs: [cleanReview()] });
	const res = await g.gate("git commit -m done");
	assert.equal(res?.block, true);
	assert.match(res.reason, /worker/);
	assert.deepEqual(g.delegateCalls(), []);
});

test("commit gate blocks a coordinator commit with no reviewer run and says how to fix it", async (t) => {
	const g = setupCommitGate(t);
	const res = await g.gate("git commit -m done");
	assert.equal(res?.block, true);
	assert.match(res.reason, /delegate run reviewer/);
	assert.match(res.reason, /stdin/);
	assert.match(res.reason, /fresh review/);
	assert.match(res.reason, /!git commit/);
});

test("commit gate allows a commit after a clean review of the exact current diff", async (t) => {
	const g = setupCommitGate(t, { runs: [cleanReview({ meta: { diff_sha: "0".repeat(64) }, out: (id) => `1. [high] a.ts:1 — bug\n${trailer(id)}` }), cleanReview()] });
	assert.equal(await g.gate("git commit -m done"), undefined);
	assert.deepEqual(g.delegateCalls(), [`diff-hash -C ${g.project}`]);
});

test("commit gate blocks when the matching review reported findings", async (t) => {
	const g = setupCommitGate(t, { runs: [cleanReview({ out: (id) => `1. [high] a.ts:1 — off-by-one\n${trailer(id)}` })] });
	assert.equal((await g.gate("git commit -m done"))?.block, true);
});

test("commit gate blocks when the tree changed after the review", async (t) => {
	const g = setupCommitGate(t, { runs: [cleanReview({ meta: { diff_sha: "0".repeat(64) } })] });
	assert.equal((await g.gate("git commit -m done"))?.block, true);
});

test("commit gate blocks a clean review of another repository", async (t) => {
	const g = setupCommitGate(t, { runs: ({ elsewhere }) => [cleanReview({ meta: { cwd: realpathSync(elsewhere) } })] });
	assert.equal((await g.gate("git commit -m done"))?.block, true);
});

test("commit gate accepts a clean review started from a subdirectory of the same repository", async (t) => {
	const g = setupCommitGate(t, { runs: ({ project }) => [cleanReview({ meta: { cwd: join(project, "sub") } })] });
	assert.equal(await g.gate("git commit -m done"), undefined);
});

test("commit gate does not accept a trailer-only output or another run's trailer as clean", async (t) => {
	const g = setupCommitGate(t, { runs: [
		cleanReview({ out: (id) => trailer(id) }),
		cleanReview({ out: `No issues.\n${trailer("reviewer-0000-000000-1")}` }),
		cleanReview({ out: (id) => `No issues.\n${trailer(id)}${trailer(id)}` }),
	] });
	assert.equal((await g.gate("git commit -m done"))?.block, true);
});

test("commit gate blocks while the reviewer run is unfinished or failed", async (t) => {
	const g = setupCommitGate(t, { runs: [cleanReview({ exit: null }), cleanReview({ exit: "1" }), cleanReview({ out: null })] });
	assert.equal((await g.gate("git commit -m done"))?.block, true);
});

test("commit gate ignores clean output from non-reviewer roles", async (t) => {
	const g = setupCommitGate(t, { runs: [cleanReview({ meta: { role: "implementer" } }), cleanReview({ meta: { role: undefined } })] });
	assert.equal((await g.gate("git commit -m done"))?.block, true);
});

test("commit gate allows a commit when the tree matches HEAD", async (t) => {
	const g = setupCommitGate(t, { stub: "empty" });
	assert.equal(await g.gate("git commit -m done"), undefined);
});

test("commit gate fails closed when diff-hash fails", async (t) => {
	const g = setupCommitGate(t, { stub: "fail", runs: [cleanReview()] });
	const res = await g.gate("git commit -m done");
	assert.equal(res?.block, true);
	assert.match(res.reason, /not a git repository/);
});

test("commit gate fails closed on malformed diff-hash output", async (t) => {
	const g = setupCommitGate(t, { stub: "garbage", runs: [cleanReview()] });
	const res = await g.gate("git commit -m done");
	assert.equal(res?.block, true);
	assert.match(res.reason, /something odd/);
});

test("commit gate fails closed when delegate is missing", async (t) => {
	const g = setupCommitGate(t, { stub: "missing", runs: [cleanReview()] });
	const res = await g.gate("git commit -m done");
	assert.equal(res?.block, true);
	assert.match(res.reason, /delegate diff-hash/);
});

test("commit gate recognises common git commit spellings", async (t) => {
	const g = setupCommitGate(t);
	for (const command of [
		'git commit -m "msg"',
		"git -C /some/path commit -am msg",
		"rtk git commit -m msg",
		"git add -A && git commit -m msg",
		"cd sub && git commit",
		"/usr/bin/git commit --amend --no-edit",
		"git -c user.name=x commit -m y",
		"git --no-pager commit",
		'sh -c "git commit -m x"',
	]) {
		assert.equal((await g.gate(command))?.block, true, command);
	}
});

test("commit gate leaves other commands and tools untouched", async (t) => {
	const g = setupCommitGate(t, { stub: "fail" });
	for (const command of ["git status", "git log --grep commit", "git commit-tree HEAD^{tree}", "echo committed", "legit commit", "ls -la"]) {
		assert.equal(await g.gate(command), undefined, command);
	}
	assert.equal(await g.gate("git commit -m x", "read"), undefined);
	assert.deepEqual(g.delegateCalls(), []);
});
