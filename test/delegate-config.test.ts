import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadModelSet, resolveModelRef, resolveRun } from "../packages/pi-goblins/extensions/delegate-config.ts";
import { SUBAGENT_LINE } from "../packages/pi-goblins/extensions/delegate-worker.ts";
import {
	HAIKU,
	LUNA,
	modelSet,
	OPUS,
	POLICY,
	POOL_SET,
	registryFixture,
	run,
	SONNET,
	scratch,
	setup,
	TEST_HOME,
	text,
	UNAUTHENTICATED,
	workerContract,
} from "./helpers/delegate-harness.ts";

test("v1 and v2 configs fail with a pointer to the v3 format, and empty pools use the session model", () => {
	for (const [name, config] of [
		["v1", { models: [HAIKU, SONNET, OPUS], default: SONNET }],
		["v2", { version: 2, scout: { models: [HAIKU], thinking: "off" }, worker: { models: [LUNA], thinking: "max" } }],
	]) {
		const path = scratch(`${name}-delegate.json`);
		writeFileSync(path, JSON.stringify(config));
		assert.throws(
			() => loadModelSet(path),
			/unsupported format \(version (null|2)\); expected "version": 3 .*docs\/delegate\.md/,
			name,
		);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), config, `${name} config is not rewritten`);
	}

	const empty = loadModelSet(join(TEST_HOME, "nope.json"));
	assert.deepEqual(resolveRun("scout", {}, empty, "x/session", "off"), {
		model: "x/session",
		thinking: "off",
	});
	assert.deepEqual(resolveRun("general", { model: "y/m" }, empty, "x/session", "medium"), {
		model: "y/m",
		thinking: "medium",
	});
	assert.throws(
		() => resolveRun("general", {}, empty, "x/session"),
		/main session's thinking level is unknown; set worker\.thinking/,
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
		env: { ME_PI_RUN: "1", ME_PI_ROLE: "general", ME_PI_SKILLS: JSON.stringify(["code-review", "pr"]) },
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

test("a general worker with no context files or skills drops the subagent line", (t) => {
	const options = { contextFiles: [], skills: [], appendSystemPrompt: workerContract(false) };
	assert.ok(options.appendSystemPrompt.includes(SUBAGENT_LINE));
	setup(t, { env: { ME_PI_RUN: "1", ME_PI_ROLE: "general" } }).handlers.before_agent_start({
		systemPromptOptions: options,
	});
	assert.ok(!options.appendSystemPrompt.includes(SUBAGENT_LINE), options.appendSystemPrompt);
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
	const res = await run(tool, { role: "general", task: "x" });
	assert.equal(res.isError, false, text(res));
	assert.match(text(res), /skills=\["code-review","pr"\]/);
	const plain = await run(setup(t).tool, { role: "general", task: "x" });
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

test("implementSkills reaches implement workers only and is validated like readOnlySkills", (t) => {
	const write = (extra: object) => {
		const path = scratch("delegate.json");
		writeFileSync(path, JSON.stringify({ version: 3, scout: { models: [] }, worker: { models: [] }, ...extra }));
		return path;
	};
	const set = loadModelSet(write({ readOnlySkills: ["pr"], implementSkills: ["tdd", "code-review"] }));
	assert.deepEqual(set.implementSkills, ["tdd", "code-review"]);
	assert.deepEqual(set.readOnlySkills, ["pr"]);
	assert.equal(loadModelSet(write({})).implementSkills, undefined, "unset keeps all skills");
	for (const [value, error] of [
		["tdd", /\.implementSkills must be an array of skill names/],
		[{ tdd: true }, /\.implementSkills must be an array of skill names/],
		[["tdd", " "], /\.implementSkills must be an array of skill names/],
		[["tdd", "tdd"], /\.implementSkills lists a skill twice/],
	] as const)
		assert.throws(() => loadModelSet(write({ implementSkills: value })), error);
	assert.throws(
		() => loadModelSet(write({ implementSkils: ["tdd"] })),
		/unknown key\(s\) implementSkils \(allowed: version, scout, worker, readOnlySkills, implementSkills\)/,
	);

	const handlers = setup(t, {
		env: { ME_PI_RUN: "1", ME_PI_ROLE: "implement", ME_PI_SKILLS: JSON.stringify(["tdd"]) },
	}).handlers;
	const options = { contextFiles: [], skills: [{ name: "tdd" }, { name: "wizard" }] };
	handlers.before_agent_start({ systemPromptOptions: options });
	assert.deepEqual(
		options.skills.map((s) => s.name),
		["tdd"],
	);
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
	assert.deepEqual(loadModelSet(write(JSON.stringify(POOL_SET))), POOL_SET);
	assert.equal(loadModelSet(write(JSON.stringify(POOL_SET))).worker.models[1].thinking, "max");
	for (const [content, error] of [
		["{", /delegate config .*: /],
		["[]", /expected a JSON object/],
		[JSON.stringify({ version: 4 }), /unsupported format \(version 4\)/],
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
	const { tool } = setup(t, {
		config: JSON.stringify({ version: 3, scout: { models: "x" }, worker: { models: [] } }),
	});
	return run(tool, { role: "scout", task: "x" }).then((res) => {
		assert.equal(res.isError, true);
		assert.match(text(res), /scout\.models must be an array/);
	});
});

test("a review pool fails with a migration pointer before any worker starts, without rewriting the file", async (t) => {
	const marker = scratch("review-key-marker");
	const config = {
		version: 3,
		scout: { models: [{ model: HAIKU, thinking: "low" }] },
		worker: { models: [{ model: LUNA, thinking: "max" }] },
		review: { models: [{ model: SONNET, thinking: "high" }] },
	};
	const path = scratch("review-delegate.json");
	writeFileSync(path, JSON.stringify(config));
	const migration =
		/review pool was removed: move its entries not already listed into worker\.models \(later entries keep their thinking when a run names that model\) and pass runs\[\]\.model for a second-opinion review; see docs\/delegate\.md/;
	assert.throws(() => loadModelSet(path), migration);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), config, "the config is not rewritten");

	const { tool } = setup(t, { config, env: { FAKE_PI_MODE: "success", FAKE_PI_MARKER: marker } });
	const res = await run(tool, { task: "x" });
	assert.equal(res.isError, true);
	assert.match(text(res), migration);
	assert.equal(existsSync(marker), false, "no worker started");
});

test("worker and scout pools select their first model; an exact model never falls back; the cost cap stops retries", async (t) => {
	const marker = scratch("pool-marker");
	const config = {
		version: 3,
		scout: {
			models: [{ model: HAIKU, thinking: "low" }],
			thinking: "low",
		},
		worker: {
			models: [
				{ model: LUNA, thinking: "max" },
				{ model: SONNET, thinking: "high" },
				{ model: OPUS, thinking: "medium" },
			],
			thinking: "max",
		},
	};
	const main = setup(t, {
		config,
		env: { FAKE_PI_MODE: "success", FAKE_PI_FAIL_MODEL: SONNET, FAKE_PI_MARKER: marker },
		limits: { costCapUsd: 0.005 },
	});
	const generalRes = await run(main.tool, { role: "general", task: "check worker pool" });
	assert.equal(generalRes.isError, false, text(generalRes));
	assert.equal(generalRes.details.round1[0].requested.model, LUNA);
	assert.equal(generalRes.details.round1[0].requested.thinking, "max");

	const scoutRes = await run(main.tool, { role: "scout", task: "check scout pool" });
	assert.equal(scoutRes.isError, false, text(scoutRes));
	assert.equal(scoutRes.details.round1[0].requested.model, HAIKU);
	assert.equal(scoutRes.details.round1[0].requested.thinking, "low");

	process.env.FAKE_PI_MODE = "rate-limit-model";
	const exactFail = await run(main.tool, { role: "general", task: "exact fail", runs: [{ model: SONNET }] });
	assert.equal(exactFail.isError, true);

	const calls = readFileSync(marker, "utf8")
		.trim()
		.split("\n")
		.map((line) => {
			const { model, thinking } = JSON.parse(line);
			return [model, thinking];
		});
	assert.deepEqual(calls, [
		[LUNA, "max"],
		[HAIKU, "low"],
		[SONNET, "high"],
	]);

	// Exhausting the cap on the first attempt fails without further attempts.
	const costMarker = scratch("pool-cost-marker");
	const capped = setup(t, {
		config,
		env: { FAKE_PI_MODE: "rate-limit-models", FAKE_PI_FAIL_MODELS: `${SONNET},${OPUS}`, FAKE_PI_MARKER: costMarker },
		limits: { costCapUsd: 0.002 },
	});
	const cappedRes = await run(capped.tool, {
		task: "budget shared",
		runs: [{ model: SONNET }],
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
	const { tool } = setup(t, { config: modelSet([HAIKU, OPUS]) });
	const model = tool.parameters.properties.runs.items.properties.model;
	assert.equal(model.type, "string");
	assert.equal(model.enum, undefined);
	assert.match(model.description, /provider\/id, or a bare id/);
	assert.match(tool.parameters.properties.runs.description, /explicitly named model runs alone and never falls back/i);
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
			/🧑[🏻-🏿]\u200d[🍳🌾] claude-haiku-5-5 @high turn 0 .*· (time to cook|doing honest work)$/mu,
		);
		assert.match(
			live.content[0].text,
			/🧑[🏻-🏿]\u200d[🍳🌾] claude-sonnet-5-5 @low turn 0 .*· (time to cook|doing honest work)$/mu,
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

test("resolveModelRef mirrors Pi's exact --model precedence", () => {
	const registry = (catalog: string[], available: string[] = catalog) => registryFixture({ catalog, available });
	const GLM = "z-ai/glm-5.3-flash";
	const OR = `openrouter/${GLM}`;
	const NV = `nvidia/${GLM}`;
	assert.deepEqual(resolveModelRef(HAIKU, registry([HAIKU])), {
		status: "resolved",
		model: HAIKU,
		provider: "anthropic",
		id: "claude-haiku-5-5",
		usable: true,
		authed: true,
	});
	assert.equal((resolveModelRef("claude-haiku-5-5", registry([HAIKU])) as any).model, HAIKU, "bare unique id");
	assert.equal((resolveModelRef(GLM, registry([OR])) as any).model, OR, "slash in a bare id");
	assert.equal((resolveModelRef(OR, registry([OR])) as any).model, OR, "provider prefix before a slashed id");
	assert.equal((resolveModelRef(GLM, registry([OR, NV], [OR])) as any).model, OR, "the one usable provider wins");
	assert.deepEqual(resolveModelRef(GLM, registry([OR, NV])), { status: "ambiguous", candidates: [OR, NV] });
	const nvidiaAuth = registryFixture({ catalog: [OR, NV], available: [OR], authenticated: ["nvidia"] });
	assert.equal((resolveModelRef(GLM, nvidiaAuth) as any).model, NV, "Pi's configured-auth tie-break wins");
	const { hasConfiguredAuth: _, ...olderPi } = registry([OR, NV], [OR]);
	assert.equal((resolveModelRef(GLM, olderPi) as any).model, OR, "without hasConfiguredAuth, getAvailable decides");
	assert.deepEqual(resolveModelRef(UNAUTHENTICATED, registry([UNAUTHENTICATED], [])), {
		status: "resolved",
		model: UNAUTHENTICATED,
		provider: "unauthed",
		id: "model",
		usable: false,
		authed: false,
	});
	assert.deepEqual(resolveModelRef("anthropic/nope", registry([HAIKU])), { status: "unknown" });
	assert.deepEqual(resolveModelRef("nope", registry([HAIKU])), { status: "unknown" });
	assert.equal((resolveModelRef("Anthropic/Claude-HAIKU-5-5", registry([HAIKU])) as any).model, HAIKU);
	assert.equal((resolveModelRef("Z-AI/GLM-5.3-FLASH", registry([OR])) as any).model, OR);
});
