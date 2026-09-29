import assert from "node:assert/strict";
import test from "node:test";
import { applyAgentPick, parseModelAssignment } from "./me-setup.ts";

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

test("accepts only known model ids from authenticated providers", () => {
	const getModels = (provider) => provider === "openrouter" ? ["z-ai/glm-5.3-flash"] : [];
	assert.deepEqual(parseModelAssignment("openrouter/z-ai/glm-5.3-flash", ["openrouter"], getModels), {
		model: "z-ai/glm-5.3-flash",
		defaultProvider: "openrouter",
	});
	assert.match(parseModelAssignment("unknown/model", ["openrouter"], getModels).error, /not authenticated/);
	assert.match(parseModelAssignment("openrouter/missing", ["openrouter"], getModels).error, /unknown model/);
	assert.match(parseModelAssignment("model-without-provider", ["openrouter"], getModels).error, /expected provider\/model/);
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
