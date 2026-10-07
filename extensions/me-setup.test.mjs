import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("chooser constructs model and thinking pickers with their titles and choices", async (t) => {
	const fp = fakePi();
	registerMeSetup(fp.pi);
	writeSettings({ subagents: {} });
	const agentDir = join(TEST_HOME, ".pi", "agent");
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ "test-provider": {} }));
	writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({
		"test-provider": { models: [{ id: "test-model" }] },
	}));
	t.after(() => {
		rmSync(join(agentDir, "auth.json"));
		rmSync(join(agentDir, "models-store.json"));
	});
	const renderedPickers = [];
	const selectAnswers = ["choose another…", "✓ done — save"];
	const ctx = {
		hasUI: true,
		mode: "tui",
		modelRegistry: { find: (provider, id) => ({ provider, id }) },
		ui: {
			notify: () => {},
			select: () => Promise.resolve(selectAnswers.shift()),
			custom: (factory) => new Promise((done) => {
				const picker = factory(
					{},
					{ fg: (_color, text) => text },
					{ matches: (data, action) => data === "\r" && action === "tui.select.confirm" },
					done,
				);
				renderedPickers.push(picker.render(80).join("\n"));
				picker.handleInput("\r");
			}),
		},
	};
	await fp.command.handler("", ctx);
	assert.equal(renderedPickers.length, 2);
	assert.match(renderedPickers[0], /Default — model/);
	assert.match(renderedPickers[0], /test-model \[test-provider\]/);
	assert.match(renderedPickers[1], /Default — thinking level/);
	assert.match(renderedPickers[1], /inherit/);
	const saved = JSON.parse(readSettingsRaw());
	assert.equal(saved.subagents.defaultModel, "test-model");
	assert.equal(saved.subagents.defaultProvider, "test-provider");
	assert.equal(saved.subagents.defaultThinking, undefined);
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

// Worker-only textual commit guard. No delegate executable is placed on PATH,
// so a main-session commit regression proves the removed review dependency stays gone.
function setupCommitGuard(t, { workerRun } = {}) {
	const bin = mkdtempSync(join(TEST_HOME, "commit-guard-bin-"));
	const saved = { PATH: process.env.PATH, ME_PI_RUN: process.env.ME_PI_RUN };
	process.env.PATH = bin;
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
	const ctx = { cwd: process.cwd(), hasUI: false, mode: "print", ui: { notify: () => {} } };
	return {
		delegateAvailable: existsSync(join(bin, "delegate")),
		gate: (command, toolName = "bash") => handlers.tool_call({ type: "tool_call", toolName, toolCallId: "call-1", input: { command } }, ctx),
	};
}

test("main-session commits proceed when delegate is unavailable", async (t) => {
	const g = setupCommitGuard(t);
	assert.equal(g.delegateAvailable, false);
	assert.equal(await g.gate("git commit -m done"), undefined);
});

test("worker git commits are blocked with leave-uncommitted guidance", async (t) => {
	const g = setupCommitGuard(t, { workerRun: "implementer-1" });
	for (const command of [
		"git commit -m done",
		"git -C /some/path commit -m done",
		"git -c user.name=worker commit -m done",
		"rtk git commit -m done",
		"a && git commit -m done",
		'sh -c "git commit -m done"',
	]) {
		const result = await g.gate(command);
		assert.equal(result?.block, true, command);
		assert.match(result.reason, /Leave changes uncommitted/, command);
	}
});

test("worker commit guard leaves other commands and tools untouched", async (t) => {
	const g = setupCommitGuard(t, { workerRun: "implementer-1" });
	for (const command of ["git status", "git log --grep commit", "git commit-tree HEAD^{tree}", "echo committed", "legit commit", "ls -la"]) {
		assert.equal(await g.gate(command), undefined, command);
	}
	assert.equal(await g.gate("git commit -m x", "read"), undefined);
});
