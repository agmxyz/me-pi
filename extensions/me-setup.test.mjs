import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// me-setup resolves ~/.pi/agent at import time from $HOME; pin it to a temp
// dir before the dynamic import so settings writes land in a sandbox.
const TEST_HOME = mkdtempSync(join(tmpdir(), "me-setup-test-"));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
process.env.HOME = TEST_HOME;
process.on("exit", () => {
	try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});

const { default: registerMeSetup } = await import("./me-setup.ts");

function fakePi() {
	const handlers = {};
	let command;
	const pi = {
		on: (event, handler) => { handlers[event] = handler; },
		registerCommand: (_name, definition) => { command = definition; },
	};
	return { pi, handlers, get command() { return command; } };
}

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

test("status reports missing installed policy links with an install hint", async () => {
	const fp = fakePi();
	registerMeSetup(fp.pi);
	const notifications = [];
	const ctx = { hasUI: true, mode: "tui", ui: { notify: (message) => notifications.push(message) } };
	await fp.command.handler("status", ctx);
	const policyLinks = [
		["~/.pi/agent/AGENTS.md", join(TEST_HOME, ".pi", "agent", "AGENTS.md"), join(REPO_ROOT, "GLOBAL_AGENTS.md")],
		["~/.agents/CODING_STANDARDS.md", join(TEST_HOME, ".agents", "CODING_STANDARDS.md"), join(REPO_ROOT, "CODING_STANDARDS.md")],
	];
	for (const [policyPath, livePath, sourcePath] of policyLinks) {
		assert.ok(notifications[0].includes(`${policyPath} link — missing or incorrect — run install.sh`), `${policyPath}\n${notifications[0]}`);
		mkdirSync(dirname(livePath), { recursive: true });
		symlinkSync(sourcePath, livePath);
	}
	await fp.command.handler("status", ctx);
	for (const [policyPath] of policyLinks) {
		assert.ok(notifications[1].includes(`✓ ${policyPath} link`), `${policyPath}\n${notifications[1]}`);
	}
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
