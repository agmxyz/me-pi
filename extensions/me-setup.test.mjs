import assert from "node:assert/strict";
import test from "node:test";
import { applyAgentPick } from "./me-setup.ts";

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

test("updates provider for the same model and clears inherited thinking", () => {
	assert.deepEqual(
		applyAgentPick(
			{ model: "gpt-6-luna", defaultProvider: "openai", thinking: "low", tools: ["subagent"] },
			{ model: "gpt-6-luna", defaultProvider: "openai-codex" },
		),
		{ model: "gpt-6-luna", defaultProvider: "openai-codex", tools: ["subagent"] },
	);
});
