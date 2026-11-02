import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	commandCtx,
	fallbackAuthorization,
	HAIKU,
	LUNA,
	loadModelSet,
	OPUS,
	POLICY,
	POOL_SET,
	resolveRun,
	run,
	SONNET,
	scratch,
	setup,
	TEST_HOME,
	text,
} from "./helpers/delegate-harness.ts";

test("v1 and v2 configs migrate to per-model levels, and empty pools use the session model", () => {
	const path = scratch("legacy-delegate.json");
	writeFileSync(path, JSON.stringify({ models: [HAIKU, SONNET, OPUS], default: SONNET }));
	const set = loadModelSet(path);
	assert.deepEqual(set, {
		version: 3,
		scout: {
			models: [HAIKU, SONNET, OPUS].map((model) => ({ model, thinking: "low" })),
			thinking: "low",
		},
		worker: {
			models: [SONNET, HAIKU, OPUS].map((model) => ({ model, thinking: "max" })),
			thinking: "max",
		},
	});
	assert.deepEqual(resolveRun("review", { model: OPUS, thinking: "medium" }, set), {
		model: OPUS,
		candidates: [{ model: OPUS, thinking: "medium" }],
		thinking: "medium",
	});
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { models: [HAIKU, SONNET, OPUS], default: SONNET });

	const v2Path = scratch("v2-delegate.json");
	writeFileSync(
		v2Path,
		JSON.stringify({
			version: 2,
			scout: { models: [HAIKU], thinking: "off" },
			worker: { models: [LUNA, OPUS], thinking: "max" },
		}),
	);
	const v2 = loadModelSet(v2Path);
	assert.equal(JSON.parse(readFileSync(v2Path, "utf8")).version, 2, "reading a legacy config does not rewrite it");
	assert.deepEqual(v2, {
		version: 3,
		scout: { models: [{ model: HAIKU, thinking: "off" }], thinking: "off" },
		worker: {
			models: [LUNA, OPUS].map((model) => ({ model, thinking: "max" })),
			thinking: "max",
		},
	});
	assert.deepEqual(resolveRun("scout", { thinking: "high" }, v2), {
		model: HAIKU,
		candidates: [{ model: HAIKU, thinking: "low" }],
		thinking: "low",
	});
	assert.deepEqual(resolveRun("review", {}, v2), {
		model: LUNA,
		candidates: [
			{ model: LUNA, thinking: "max" },
			{ model: OPUS, thinking: "max" },
		],
		thinking: "max",
	});
	assert.deepEqual(resolveRun("review", { model: "openai/gpt-x" }, v2), {
		model: "openai/gpt-x",
		candidates: [{ model: "openai/gpt-x", thinking: "max" }],
		thinking: "max",
	});

	const empty = loadModelSet(join(TEST_HOME, "nope.json"));
	assert.deepEqual(resolveRun("scout", {}, empty, "x/session", "off"), {
		model: "x/session",
		candidates: [{ model: "x/session", thinking: "off" }],
		thinking: "off",
	});
	assert.deepEqual(resolveRun("review", { model: "y/m" }, empty, "x/session", "medium"), {
		model: "y/m",
		candidates: [{ model: "y/m", thinking: "medium" }],
		thinking: "medium",
	});
	assert.throws(() => resolveRun("review", {}, empty, "x/session"), /main session's thinking level is unknown/);
	assert.throws(
		() => resolveRun("review", {}, { ...empty, review: { models: [] } }, "x/session"),
		/set review\.thinking/,
	);
});

test("workers drop coordinator-only policy, writer policy unless implement, and unlisted skills", (t) => {
	const options = () => ({
		contextFiles: [{ path: "/g/AGENTS.md", content: POLICY }],
		skills: [{ name: "code-review" }, { name: "tdd" }, { name: "pr" }],
	});
	const reader = options();
	const { skills } = reader;
	const handlers = setup(t, {
		env: { ME_PI_RUN: "1", ME_PI_ROLE: "review", ME_PI_SKILLS: JSON.stringify(["code-review", "pr"]) },
	}).handlers;
	handlers.before_agent_start({ systemPromptOptions: reader });
	assert.equal(reader.contextFiles[0].content, "## Output\n- lead with the result\n## Secrets\n- never read keys");
	assert.deepEqual(
		reader.skills.map((s) => s.name),
		["code-review", "pr"],
	);
	assert.equal(reader.skills, skills, "filtered in place, so the Skill tool's array matches the prompt");

	const writer = options();
	setup(t, { env: { ME_PI_RUN: "1", ME_PI_ROLE: "implement" } }).handlers.before_agent_start({
		systemPromptOptions: writer,
	});
	assert.match(writer.contextFiles[0].content, /## Approval \(coordinator and implement only\)\n- protected actions/);
	assert.doesNotMatch(writer.contextFiles[0].content, /coordinator ledger/);
	assert.equal(writer.skills.length, 3, "no allowlist keeps every skill");
});

test("readOnlySkills reaches read-only workers and is validated", async (t) => {
	const config = {
		version: 3,
		scout: { models: [] },
		worker: { models: [] },
		readOnlySkills: ["code-review", "pr"],
	};
	assert.deepEqual(loadModelSet(join(mkdtempSync(join(TEST_HOME, "cfg-")), "x.json")).readOnlySkills, undefined);
	const { tool } = setup(t, { config });
	const res = await run(tool, { role: "review", task: "x" });
	assert.equal(res.isError, false, text(res));
	assert.match(text(res), /skills=\["code-review","pr"\]/);
	const plain = await run(setup(t).tool, { role: "review", task: "x" });
	assert.match(text(plain), /skills=all/);
	for (const [value, error] of [
		["code-review", /readOnlySkills must be an array of skill names/],
		[["pr", ""], /readOnlySkills must be an array of skill names/],
		[["pr", "pr"], /readOnlySkills lists a skill twice/],
	]) {
		const bad = await run(setup(t, { config: { ...config, readOnlySkills: value } }).tool, {
			role: "scout",
			task: "x",
		});
		assert.equal(bad.isError, true);
		assert.match(text(bad), error);
	}
});

test("v3 model configs validate per-model thinking", (t) => {
	const write = (content) => {
		const path = scratch("delegate.json");
		writeFileSync(path, content);
		return path;
	};
	assert.deepEqual(loadModelSet(join(TEST_HOME, "nope.json")), {
		version: 3,
		scout: { models: [] },
		worker: { models: [] },
	});
	assert.deepEqual(
		loadModelSet(write(JSON.stringify({ version: 3, scout: { models: [] }, worker: { models: [] } }))),
		{ version: 3, scout: { models: [] }, worker: { models: [] } },
		"pool-level thinking is optional",
	);
	assert.deepEqual(
		loadModelSet(
			write(
				JSON.stringify({
					version: 3,
					scout: { models: [] },
					worker: { models: [{ model: LUNA, thinking: "max" }] },
					review: { models: [{ model: OPUS, thinking: "high" }], thinking: "medium" },
				}),
			),
		),
		{
			version: 3,
			scout: { models: [] },
			worker: { models: [{ model: LUNA, thinking: "max" }] },
			review: { models: [{ model: OPUS, thinking: "high" }], thinking: "medium" },
		},
		"review pool is optional and validated in v3",
	);
	assert.deepEqual(loadModelSet(write(JSON.stringify(POOL_SET))), POOL_SET);
	assert.equal(loadModelSet(write(JSON.stringify(POOL_SET))).worker.models[1].thinking, "max");
	for (const [content, error] of [
		["{", /delegate config .*: /],
		["[]", /expected a JSON object/],
		[JSON.stringify({ models: [HAIKU], tiers: {} }), /unknown key\(s\) tiers \(allowed: models, default\)/],
		[JSON.stringify({ models: [{ id: HAIKU }] }), /models.*must be an array of model ids/],
		[JSON.stringify({ models: [HAIKU, HAIKU] }), /models.*lists a model twice/],
		[JSON.stringify({ models: [HAIKU], default: OPUS }), /"default" must be one of "models"/],
		[JSON.stringify({ version: 4 }), /unsupported version 4 \(expected 2 or 3\)/],
		[
			JSON.stringify({
				version: 2,
				scout: { models: [HAIKU], thinking: "low" },
				worker: { models: [OPUS], thinking: "max" },
				review: { models: [SONNET], thinking: "high" },
			}),
			/unknown key\(s\) review \(allowed: version, scout, worker\)/,
		],
		[
			JSON.stringify({
				version: 3,
				scout: { models: [{ model: HAIKU, thinking: "high" }], thinking: "low" },
				worker: { models: [], thinking: "max" },
			}),
			/scout.models\[0\].thinking must be one of low, off/,
		],
		[
			JSON.stringify({
				version: 3,
				scout: { models: [], thinking: "low" },
				worker: { models: [] },
				review: "invalid",
			}),
			/review: expected an object/,
		],
		[
			JSON.stringify({
				version: 3,
				scout: { models: [], thinking: "low" },
				worker: { models: [] },
				review: { models: [{ model: HAIKU, thinking: "nope" }] },
			}),
			/review\.models\[0\]\.thinking must be one of off, minimal, low, medium, high, xhigh, max/,
		],
		[
			JSON.stringify({
				version: 3,
				scout: { models: [], thinking: "low" },
				worker: { models: [] },
				review: {
					models: [
						{ model: HAIKU, thinking: "high" },
						{ model: HAIKU, thinking: "low" },
					],
				},
			}),
			/review\.models lists model .* twice/,
		],
		[
			JSON.stringify({
				version: 3,
				scout: { models: [], thinking: "low" },
				worker: {
					models: [
						{ model: HAIKU, thinking: "medium" },
						{ model: HAIKU, thinking: "low" },
					],
					thinking: "max",
				},
			}),
			/worker.models lists model .* twice/,
		],
	]) {
		assert.throws(() => loadModelSet(write(content)), error);
	}
	const { tool } = setup(t, { config: JSON.stringify({ models: "x" }) });
	return run(tool, { role: "scout", task: "x" }).then((res) => {
		assert.equal(res.isError, true);
		assert.match(text(res), /models.*must be an array/);
	});
});

test("review pool selects its first candidate, reports status, and preserves worker/scout behavior", async (t) => {
	const marker = scratch("review-pool-marker");
	const config = {
		version: 3,
		scout: {
			models: [{ model: HAIKU, thinking: "low" }],
			thinking: "low",
		},
		worker: {
			models: [
				{ model: LUNA, thinking: "max" },
				{ model: OPUS, thinking: "high" },
			],
			thinking: "max",
		},
		review: {
			models: [
				{ model: SONNET, thinking: "high" },
				{ model: OPUS, thinking: "medium" },
			],
			thinking: "low",
		},
	};
	const main = setup(t, {
		config,
		env: { FAKE_PI_MODE: "success", FAKE_PI_FAIL_MODEL: SONNET, FAKE_PI_MARKER: marker },
		limits: { costCapUsd: 0.005 },
	});
	const { ctx: statusCtx, notes } = commandCtx({ available: [HAIKU, OPUS] });
	await main.commands.delegate.handler("status", statusCtx);
	assert.ok(
		notes[0][0].includes(
			`Review pool: 1. ${SONNET} (high) ✗ not available (no login or unknown id); 2. ${OPUS} (medium) ✓`,
		),
	);

	const reviewRes = await run(main.tool, {
		role: "review",
		task: "check review pool",
		fallbackAuthorization: fallbackAuthorization([SONNET, OPUS]),
	});
	assert.equal(reviewRes.isError, false, text(reviewRes));
	assert.equal(reviewRes.details.round1[0].requested.model, SONNET);
	assert.equal(reviewRes.details.round1[0].requested.thinking, "high");

	const generalRes = await run(main.tool, { role: "general", task: "check worker pool" });
	assert.equal(generalRes.isError, false, text(generalRes));
	assert.equal(generalRes.details.round1[0].requested.model, LUNA);
	assert.equal(generalRes.details.round1[0].requested.thinking, "max");

	const scoutRes = await run(main.tool, { role: "scout", task: "check scout pool" });
	assert.equal(scoutRes.isError, false, text(scoutRes));
	assert.equal(scoutRes.details.round1[0].requested.model, HAIKU);
	assert.equal(scoutRes.details.round1[0].requested.thinking, "low");

	process.env.FAKE_PI_MODE = "rate-limit-model";
	const exactFail = await run(main.tool, { role: "review", task: "exact fail", runs: [{ model: SONNET }] });
	assert.equal(exactFail.isError, true);

	const calls = readFileSync(marker, "utf8")
		.trim()
		.split("\n")
		.map((line) => {
			const { model, thinking } = JSON.parse(line);
			return [model, thinking];
		});
	assert.deepEqual(calls, [
		[SONNET, "high"],
		[LUNA, "max"],
		[HAIKU, "low"],
		[SONNET, "high"],
	]);

	// Exhausting the cap on the first attempt must prevent any review fallback.
	const costMarker = scratch("review-pool-cost-marker");
	const capped = setup(t, {
		config,
		env: { FAKE_PI_MODE: "rate-limit-models", FAKE_PI_FAIL_MODELS: `${SONNET},${OPUS}`, FAKE_PI_MARKER: costMarker },
		limits: { costCapUsd: 0.002 },
	});
	const cappedRes = await run(capped.tool, {
		role: "review",
		task: "budget shared",
		fallbackAuthorization: fallbackAuthorization([SONNET, OPUS]),
	});
	assert.equal(cappedRes.isError, true);
	const costStops = cappedRes.details.round1[0].provenance[0].stopFacts;
	assert.ok(costStops.some((fact) => fact.cause === "hard-cost-limit" && fact.resource === "hard-cost"));
	assert.ok(costStops.some((fact) => fact.cause === "wrap-up-limit" && fact.resource === "tool-cost"));
	assert.equal(cappedRes.usage.cost.total, 0.002);
	assert.deepEqual(
		readFileSync(costMarker, "utf8")
			.trim()
			.split("\n")
			.map(JSON.parse)
			.map(({ model, thinking }) => [model, thinking]),
		[[SONNET, "high"]],
	);
});

test("the schema allows exact model IDs outside the configured pools", (t) => {
	const { tool } = setup(t, { config: { models: [HAIKU, OPUS] } });
	const model = tool.parameters.properties.runs.items.properties.model;
	assert.equal(model.type, "string");
	assert.equal(model.enum, undefined);
	assert.match(model.description, /exact Pi model ID/);
	assert.match(tool.parameters.properties.runs.description, /explicitly named model runs alone and never falls back/i);
	assert.match(tool.parameters.properties.fallbackAuthorization.description, /does not enable fallback/);
});

test(
	"tool starts publish bounded sanitized live activity independently before a turn completes",
	{ timeout: 5000 },
	async (t) => {
		const { tool } = setup(t, {
			config: {
				version: 3,
				scout: { models: [], thinking: "low" },
				worker: {
					models: [
						{ model: HAIKU, thinking: "high" },
						{ model: SONNET, thinking: "low" },
					],
				},
			},
			env: { FAKE_PI_MODE: "tool-activity" },
		});
		let resolveActivity: any;
		const updates = [];
		const firstActivity = new Promise((resolve) => {
			resolveActivity = resolve;
		});
		const pending = run(
			tool,
			{ task: "inspect", runs: [{ model: HAIKU }, { model: SONNET }] },
			undefined,
			(update) => {
				updates.push(update);
				if (update.details.view.runs.every((run) => run.activity?.length)) resolveActivity(update);
			},
		);
		const live = await firstActivity;
		assert.deepEqual(
			live.details.view.runs.map(({ model, thinking, done, turns, activity }) => [
				model,
				thinking,
				done,
				turns,
				activity,
			]),
			[
				[HAIKU, "high", false, 0, ["read", "read", "read", "read", "read", "read", "tool", "read"]],
				[SONNET, "low", false, 0, ["grep", "grep", "grep", "grep", "grep", "grep", "tool", "grep"]],
			],
		);
		assert.match(
			live.content[0].text,
			/🧑[🏻-🏿]\u200d[🍳🌾] claude-haiku-5-5 @high turn 0 .*· (letting him cook|doing honest work)$/mu,
		);
		assert.match(
			live.content[0].text,
			/🧑[🏻-🏿]\u200d[🍳🌾] claude-sonnet-5-5 @low turn 0 .*· (letting him cook|doing honest work)$/mu,
		);
		assert.doesNotMatch(live.content[0].text, /--\*/);
		assert.doesNotMatch(JSON.stringify(live), /PRIVATE_(?:ARGUMENT|COMMAND|OUTPUT|REASONING)|\\u001b/);
		const result = await pending;
		assert.equal(result.isError, false);
		assert.deepEqual(
			result.details.round1.map(({ tools }) => tools),
			[
				["read", "read", "read", "read", "read", "read", "tool", "read"],
				["grep", "grep", "grep", "grep", "grep", "grep", "tool", "grep"],
			],
		);
		assert.ok(updates.length <= 8, `tool-start burst was not coalesced: ${updates.length} updates`);
		assert.ok(
			updates.at(-1).details.view.runs.every((run) => run.done),
			"final progress was flushed",
		);
	},
);
