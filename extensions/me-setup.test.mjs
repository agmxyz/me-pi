import assert from "node:assert/strict";
import test from "node:test";
import registerMeSetup, { applyAgentPick } from "./me-setup.ts";

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
	let command;
	registerMeSetup({ registerCommand: (_name, definition) => { command = definition; } });
	const notifications = [];
	const ctx = { hasUI: true, mode: "tui", ui: { notify: (message) => notifications.push(message) } };
	for (const args of ["default openai/model", "models", "models reset scout", "reset scout", "status extra"]) {
		await command.handler(args, ctx);
		assert.equal(notifications.pop(), "usage: /me-setup\n       /me-setup status");
	}
});

test("routes status to the read-only report", async () => {
	let command;
	registerMeSetup({ registerCommand: (_name, definition) => { command = definition; } });
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
