import assert from "node:assert/strict";
import test from "node:test";

const { default: registerGuard, classify } = await import("./guard.ts");

const onMain = () => "main";
const onFeature = () => "feature/x";

test("flags pushes to main/master and forced rm at command position", () => {
	for (const [command, branch] of [
		["git push origin main", onFeature],
		["git push -u origin master", onFeature],
		["git push origin HEAD:main", onFeature],
		["git push origin +feature/x:refs/heads/main", onFeature],
		["git push --force origin main", onFeature],
		["git push", onMain],
		["git push origin", onMain],
		["git push origin HEAD", onMain],
		["git push --all origin", onFeature],
		["git -C /some/path push origin main", onFeature],
		["rtk proxy git push origin main", onFeature],
		["GIT_SSH_COMMAND='ssh -i k' git push origin main", onFeature],
		["git push origin feature/x && git push origin main", onFeature],
		["rm -f notes.txt", onFeature],
		["rm -rf dist", onFeature],
		["rm -r -f build", onFeature],
		["rm --force out", onFeature],
		['sh -c "rm -rf x"', onFeature],
	]) {
		assert.ok(classify(command, branch), `expected flagged: ${command}`);
	}
});

test("allows feature pushes, PRs, and routine commands", () => {
	for (const [command, branch] of [
		["git push", onFeature],
		["git push -u origin feature/x", onFeature],
		["git push --force-with-lease origin feature/x", onFeature],
		["git push origin HEAD", onFeature],
		["git push origin main-fix", onFeature],
		["gh pr create --fill", onMain],
		["git reset --hard HEAD~1", onMain],
		["git log --grep push", onMain],
		["grep 'git push origin main' README.md", onMain],
		['echo "rm -rf /"', onMain],
		["rm notes.txt", onMain],
		["rm -r empty-dir", onMain],
	]) {
		assert.equal(classify(command, branch), undefined, `expected allowed: ${command}`);
	}
});

function setup() {
	let handler;
	let command;
	registerGuard({
		on: (_event, h) => {
			handler = h;
		},
		registerCommand: (_name, definition) => {
			command = definition;
		},
	});
	return { handler, command };
}

test("confirms with UI, blocks without UI or on refusal", async () => {
	const { handler } = setup();
	const event = { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "git push origin main" } };
	const cwd = process.cwd();

	const headless = await handler(event, { cwd, hasUI: false });
	assert.equal(headless?.block, true);
	assert.match(headless.reason, /push to main\/master/);

	assert.equal(await handler(event, { cwd, hasUI: true, ui: { confirm: async () => true } }), undefined);
	assert.equal((await handler(event, { cwd, hasUI: true, ui: { confirm: async () => false } }))?.block, true);
	assert.equal(await handler({ ...event, input: { command: "git status" } }, { cwd, hasUI: false }), undefined);
	assert.equal(await handler({ ...event, toolName: "read", input: { path: "x" } }, { cwd, hasUI: false }), undefined);
});

test("/guard toggles enforcement for the session", async () => {
	const { handler, command } = setup();
	const notes = [];
	const ctx = { cwd: process.cwd(), hasUI: false, ui: { notify: (message) => notes.push(message) } };
	const push = { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "git push origin main" } };

	await command.handler("off", ctx);
	assert.equal(notes.pop(), "guard off");
	assert.equal(await handler(push, ctx), undefined);

	await command.handler("", ctx);
	assert.equal(notes.pop(), "guard off");

	await command.handler("on", ctx);
	assert.equal(notes.pop(), "guard on");
	assert.equal((await handler(push, ctx))?.block, true);

	await command.handler("maybe", ctx);
	assert.equal(notes.pop(), "usage: /guard [on|off]");
});
