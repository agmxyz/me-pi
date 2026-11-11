import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import {
	CTX,
	HAIKU,
	LUNA,
	ONE_OFF,
	OPUS,
	POOL_SET,
	pool,
	REGISTRY_MODELS,
	registryFixture,
	resolveRun,
	run,
	SONNET,
	scratch,
	setup,
	text,
	UNAUTHENTICATED,
} from "./helpers/delegate-harness.ts";

test("model pools resolve per-model thinking, the first pool model, and independent overrides", () => {
	assert.deepEqual(resolveRun("scout", {}, POOL_SET), {
		model: LUNA,
		thinking: "off",
	});
	assert.deepEqual(resolveRun("general", {}, POOL_SET), {
		model: LUNA,
		thinking: "max",
	});
	assert.deepEqual(resolveRun("general", { model: OPUS, thinking: "high" }, POOL_SET), {
		model: OPUS,
		thinking: "high",
	});
	assert.deepEqual(resolveRun("general", { model: HAIKU }, POOL_SET), {
		model: HAIKU,
		thinking: "off",
	});
	assert.deepEqual(resolveRun("general", { model: ONE_OFF }, POOL_SET), {
		model: ONE_OFF,
		thinking: "max",
	});
	assert.deepEqual(resolveRun("general", { model: ONE_OFF, thinking: "low" }, POOL_SET), {
		model: ONE_OFF,
		thinking: "low",
	});
	const perModelSet = {
		...POOL_SET,
		worker: {
			models: [
				{ model: HAIKU, thinking: "high" },
				{ model: OPUS, thinking: "low" },
			],
			thinking: "medium",
		},
	};
	assert.deepEqual(resolveRun("general", { model: OPUS }, perModelSet), {
		model: OPUS,
		thinking: "low",
	});
	assert.deepEqual(resolveRun("general", { thinking: "medium" }, perModelSet), {
		model: HAIKU,
		thinking: "medium",
	});
	assert.deepEqual(resolveRun("general", { model: ONE_OFF }, perModelSet), {
		model: ONE_OFF,
		thinking: "medium",
	});
	assert.deepEqual(resolveRun("scout", { thinking: "high" }, POOL_SET), {
		model: LUNA,
		thinking: "low",
	});
	assert.deepEqual(resolveRun("scout", { model: ONE_OFF, thinking: "off" }, POOL_SET), {
		model: ONE_OFF,
		thinking: "off",
	});
	assert.deepEqual(resolveRun("scout", { model: ONE_OFF, thinking: "high" }, POOL_SET), {
		model: ONE_OFF,
		thinking: "low",
	});
});

test("unlisted models use role defaults or independent thinking overrides without changing config", async (t) => {
	const marker = scratch("one-off-marker");
	const config = {
		version: 3,
		scout: { models: [], thinking: "low" },
		worker: {
			models: [
				{ model: HAIKU, thinking: "high" },
				{ model: OPUS, thinking: "low" },
			],
			thinking: "medium",
		},
	};
	const { tool } = setup(t, { config, env: { FAKE_PI_MARKER: marker } });
	const path = process.env.ME_PI_DELEGATE_CONFIG;
	const original = readFileSync(path, "utf8");

	const defaulted = await run(tool, { role: "general", task: "x", runs: [{ model: ONE_OFF }] });
	assert.equal(defaulted.isError, false, text(defaulted));
	assert.match(text(defaulted), new RegExp(`DONE model=${ONE_OFF} thinking=medium`));

	const overridden = await run(tool, {
		role: "general",
		task: "x",
		runs: [{ model: ONE_OFF, thinking: "high" }],
	});
	assert.equal(overridden.isError, false, text(overridden));
	assert.match(text(overridden), new RegExp(`DONE model=${ONE_OFF} thinking=high`));

	const listed = await run(tool, { role: "general", task: "x", runs: [{ model: OPUS }] });
	assert.equal(listed.isError, false, text(listed));
	assert.match(text(listed), new RegExp(`DONE model=${OPUS} thinking=low`));
	assert.equal(readFileSync(path, "utf8"), original, "one-off choices do not persist to delegate.json");
	assert.deepEqual(
		readFileSync(marker, "utf8")
			.trim()
			.split("\n")
			.map((line) => {
				const { model, thinking } = JSON.parse(line);
				return [model, thinking];
			}),
		[
			[ONE_OFF, "medium"],
			[ONE_OFF, "high"],
			[OPUS, "low"],
		],
	);
});

test("an explicit thinking override applies to the first pool model", async (t) => {
	const marker = scratch("thinking-fallback-marker");
	const config = {
		version: 3,
		scout: { models: [], thinking: "low" },
		worker: {
			models: [
				{ model: HAIKU, thinking: "high" },
				{ model: SONNET, thinking: "low" },
			],
			thinking: "medium",
		},
	};
	const { tool } = setup(t, {
		config,
		env: { FAKE_PI_MODE: "rate-limit-model", FAKE_PI_FAIL_MODEL: HAIKU, FAKE_PI_MARKER: marker },
	});
	const res = await run(tool, {
		role: "general",
		task: "x",
		runs: [{ thinking: "medium" }],
	});
	assert.equal(res.isError, true, text(res));
	assert.equal(res.details.round1[0].requested.model, HAIKU);
	assert.equal(res.details.round1[0].requested.thinking, "medium");
	assert.deepEqual(
		readFileSync(marker, "utf8")
			.trim()
			.split("\n")
			.map((line) => {
				const { model, thinking } = JSON.parse(line);
				return [model, thinking];
			}),
		[[HAIKU, "medium"]],
	);
});

test("one-off models must be exact catalog IDs with usable authentication", async (t) => {
	const marker = scratch("invalid-one-off-marker");
	const { tool } = setup(t, { config: POOL_SET, env: { FAKE_PI_MARKER: marker } });
	const registry = registryFixture({
		catalog: [...REGISTRY_MODELS, UNAUTHENTICATED],
		available: REGISTRY_MODELS,
	});
	const context = { ...CTX, modelRegistry: registry };
	for (const [model, error] of [
		["google/not-in-catalog", /unknown model .*no provider\/id or model id match/],
		[UNAUTHENTICATED, /unauthenticated.*no usable login for provider "unauthed"/],
		["Gemini Flash", /unknown model "Gemini Flash"/],
	]) {
		const res = await run(tool, { role: "general", task: "x", runs: [{ model }] }, undefined, undefined, context);
		assert.equal(res.isError, true, model);
		assert.match(text(res), error);
	}
	const unsupported = await run(
		tool,
		{ role: "general", task: "x", runs: [{ model: ONE_OFF }] },
		undefined,
		undefined,
		{ ...CTX, modelRegistry: {} },
	);
	assert.equal(unsupported.isError, true);
	assert.match(text(unsupported), /model registry lacks catalog\/auth lookup/);
	const loggedIn = await run(
		tool,
		{ role: "general", task: "x", runs: [{ model: UNAUTHENTICATED }] },
		undefined,
		undefined,
		{
			...CTX,
			modelRegistry: registryFixture({
				catalog: [...REGISTRY_MODELS, UNAUTHENTICATED],
				available: REGISTRY_MODELS,
				authenticated: ["unauthed"],
			}),
		},
	);
	assert.equal(loggedIn.isError, true);
	assert.match(text(loggedIn), /model "unauthed\/[^"]+" is unavailable: Pi does not list it as available/);
	assert.equal(existsSync(marker), false, "invalid or unverifiable models never spawn a worker");
});

test("bare model refs resolve like Pi: one-off validation, canonical --model, and same-model infra retry", async (t) => {
	const GLM = "z-ai/glm-5.3-flash";
	const OR = `openrouter/${GLM}`;
	const marker = scratch("bare-ref-marker");
	const context = { ...CTX, modelRegistry: registryFixture({ catalog: [...REGISTRY_MODELS, OR] }) };
	const { tool } = setup(t, {
		config: { version: 3, scout: pool([LUNA], "low"), worker: pool([GLM], "high") },
		env: { FAKE_PI_MODE: "rate-limit-model", FAKE_PI_FAIL_MODEL: OR, FAKE_PI_MARKER: marker },
		limits: { infraRetryDelaysMs: [1, 1] },
	});
	const launches = () =>
		readFileSync(marker, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).model);

	const pooled = await run(tool, { role: "general", task: "x" }, undefined, undefined, context);
	assert.equal(pooled.isError, true, text(pooled));
	assert.deepEqual(launches(), [OR, OR, OR], "the canonical ref reaches workers and the infra retry fires");

	writeFileSync(marker, "");
	const oneOff = await run(
		tool,
		{ role: "general", task: "x", runs: [{ model: "gemini-test" }] },
		undefined,
		undefined,
		context,
	);
	assert.equal(oneOff.isError, false, text(oneOff));
	assert.deepEqual(launches(), [ONE_OFF], "a bare unique one-off ref is accepted and canonicalized");
});

test("a configured ref that is unknown passes through; an ambiguous one fails naming the config", async (t) => {
	const marker = scratch("bad-config-ref-marker");
	const context = {
		...CTX,
		modelRegistry: registryFixture({ catalog: [...REGISTRY_MODELS, "a/shared", "b/shared"] }),
	};
	const unknown = setup(t, {
		config: { version: 3, scout: pool([LUNA], "low"), worker: pool(["missing/model"], "high") },
		env: { FAKE_PI_MARKER: marker },
	});
	const passed = await run(unknown.tool, { role: "general", task: "x" }, undefined, undefined, context);
	assert.equal(passed.isError, false, text(passed));
	assert.deepEqual(
		readFileSync(marker, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).model),
		["missing/model"],
		"Pi decides whether an unknown configured ref is a custom id",
	);

	writeFileSync(marker, "");
	const ambiguous = setup(t, {
		config: { version: 3, scout: pool([LUNA], "low"), worker: pool(["shared"], "high") },
		env: { FAKE_PI_MARKER: marker },
	});
	const res = await run(ambiguous.tool, { role: "general", task: "x" }, undefined, undefined, context);
	assert.equal(res.isError, true);
	assert.match(text(res), /ambiguous model "shared" in .*: matches a\/shared, b\/shared; write provider\/id/);
	assert.equal(readFileSync(marker, "utf8"), "");
});

test("an unlisted model never falls back to the configured pool", async (t) => {
	const marker = scratch("one-off-no-fallback-marker");
	const { tool } = setup(t, {
		config: {
			version: 3,
			scout: { models: [], thinking: "low" },
			worker: {
				models: [
					{ model: HAIKU, thinking: "high" },
					{ model: OPUS, thinking: "low" },
				],
				thinking: "medium",
			},
		},
		env: { FAKE_PI_MODE: "unavailable-model", FAKE_PI_FAIL_MODEL: ONE_OFF, FAKE_PI_MARKER: marker },
	});
	const res = await run(tool, { role: "general", task: "x", runs: [{ model: ONE_OFF }] });
	assert.equal(res.isError, true);
	assert.deepEqual(
		readFileSync(marker, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).model),
		[ONE_OFF],
	);
});

test("an explicitly selected configured model never falls back after an availability failure", async (t) => {
	const marker = scratch("listed-no-fallback-marker");
	const { tool } = setup(t, {
		config: {
			version: 3,
			scout: { models: [], thinking: "low" },
			worker: {
				models: [
					{ model: HAIKU, thinking: "high" },
					{ model: SONNET, thinking: "low" },
				],
				thinking: "medium",
			},
		},
		env: { FAKE_PI_MODE: "unavailable-model", FAKE_PI_FAIL_MODEL: HAIKU, FAKE_PI_MARKER: marker },
	});
	const res = await run(tool, { role: "general", task: "x", runs: [{ model: HAIKU }] });
	assert.equal(res.isError, true);
	assert.deepEqual(
		readFileSync(marker, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).model),
		[HAIKU],
	);
	assert.equal(res.details.round1[0].requested.model, HAIKU);
});

test("a rate-limited worker does not fall back through its pool", async (t) => {
	const marker = scratch("fallback-marker");
	const { tool } = setup(t, {
		config: {
			version: 3,
			scout: pool([LUNA], "low"),
			worker: pool([HAIKU, SONNET], "max"),
		},
		env: { FAKE_PI_MODE: "rate-limit-model", FAKE_PI_FAIL_MODEL: HAIKU, FAKE_PI_MARKER: marker },
	});
	const res = await run(tool, {
		role: "general",
		task: "x",
	});
	assert.equal(res.isError, true, text(res));
	assert.equal(res.details.round1[0].requested.model, HAIKU);
	const calls = readFileSync(marker, "utf8").trim().split("\n").map(JSON.parse);
	assert.deepEqual(
		calls.map((call) => [call.model, call.thinking]),
		[[HAIKU, "max"]],
	);
	assert.equal(res.usage.cost.total, 0.002);
});

test("quota and usage-limit failures do not fall through the pool", async (t) => {
	// One setup, so its env restore runs once; each case only swaps the error text.
	const { tool } = setup(t, {
		config: {
			version: 3,
			scout: pool([LUNA], "low"),
			worker: pool([HAIKU, SONNET], "max"),
		},
		env: { FAKE_PI_MODE: "quota-model", FAKE_PI_FAIL_MODEL: HAIKU, FAKE_PI_ERROR: "" },
	});
	for (const error of [
		"Codex error: The usage limit has been reached",
		"429 quota exceeded for this project",
		"insufficient_quota: check your plan",
	]) {
		process.env.FAKE_PI_ERROR = error;
		const res = await run(tool, {
			role: "general",
			task: "x",
		});
		assert.equal(res.isError, true, error);
		assert.equal(res.details.round1[0].requested.model, HAIKU, error);
	}
});

test("Pi's retry classifier separates transient availability from quota and billing exhaustion", () => {
	assert.equal(
		isRetryableAssistantError({ stopReason: "error", errorMessage: "429 rate_limit_error: too many requests" }),
		true,
	);
	for (const errorMessage of [
		"Codex error: The usage limit has been reached",
		"429 quota exceeded for this project",
		"insufficient_quota: check your plan",
		"billing account is disabled",
	])
		assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage }), false, errorMessage);
	assert.equal(isRetryableAssistantError({ stopReason: "stop", errorMessage: "429 rate_limit_error" }), false);
});

test("first-only dispatch reports the first pool model's worker cost", async (t) => {
	const marker = scratch("fallback-cost-marker");
	const { tool } = setup(t, {
		config: {
			version: 3,
			scout: pool([LUNA], "low"),
			worker: pool([HAIKU, SONNET, OPUS], "max"),
		},
		env: {
			FAKE_PI_MODE: "rate-limit-models",
			FAKE_PI_FAIL_MODELS: `${HAIKU},${SONNET}`,
			FAKE_PI_MARKER: marker,
		},
		limits: { costCapUsd: 0.003 },
	});
	const res = await run(tool, {
		role: "general",
		task: "x",
	});
	assert.equal(res.isError, true);
	assert.equal(res.details.round1[0].requested.model, HAIKU);
	assert.equal(res.usage.cost.total, 0.002);
	assert.deepEqual(
		readFileSync(marker, "utf8")
			.trim()
			.split("\n")
			.map(JSON.parse)
			.map((call) => call.model),
		[HAIKU],
	);
});

test("default dispatch keeps the first pool model's configured thinking level", async (t) => {
	const marker = scratch("per-model-thinking-marker");
	const { tool } = setup(t, {
		config: {
			version: 3,
			scout: { models: [{ model: LUNA, thinking: "off" }], thinking: "low" },
			worker: {
				models: [
					{ model: LUNA, thinking: "max" },
					{ model: OPUS, thinking: "low" },
				],
				thinking: "max",
			},
		},
		env: { FAKE_PI_MODE: "rate-limit-model", FAKE_PI_FAIL_MODEL: LUNA, FAKE_PI_MARKER: marker },
	});
	const progress = [];
	const res = await run(tool, { role: "general", task: "x" }, undefined, (update) => progress.push(update));
	assert.equal(res.isError, true, text(res));
	assert.ok(
		progress.some(
			(update) => update.details.view.runs[0].model === LUNA && update.details.view.runs[0].thinking === "max",
		),
	);
	assert.ok(
		progress.every((update) => update.details.view.runs[0].model !== OPUS || update.details.view.runs[0].done),
	);
	const calls = readFileSync(marker, "utf8").trim().split("\n").map(JSON.parse);
	assert.deepEqual(
		calls.map(({ model, thinking }) => [model, thinking]),
		[[LUNA, "max"]],
	);
	assert.equal(res.details.round1[0].requested.model, LUNA);
	assert.equal(res.details.round1[0].requested.thinking, "max");
});

test("model-unavailable errors without structured retry evidence fail closed", async (t) => {
	const marker = scratch("unavailable-marker");
	const { tool } = setup(t, {
		config: {
			version: 3,
			scout: pool([LUNA], "off"),
			worker: pool([HAIKU, SONNET], "max"),
		},
		env: { FAKE_PI_MODE: "unavailable-model", FAKE_PI_FAIL_MODEL: HAIKU, FAKE_PI_MARKER: marker },
	});
	const res = await run(tool, {
		role: "general",
		task: "x",
	});
	assert.equal(res.isError, true, text(res));
	assert.deepEqual(
		readFileSync(marker, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).model),
		[HAIKU],
	);
});

test("configuration changed after dispatch cannot start another child", async (t) => {
	const marker = scratch("late-fallback-authorization-marker");
	const { tool } = setup(t, {
		config: {
			version: 3,
			scout: pool([LUNA], "low"),
			worker: pool([HAIKU, SONNET], "max"),
		},
		env: { FAKE_PI_MODE: "rate-limit-model", FAKE_PI_FAIL_MODEL: HAIKU, FAKE_PI_MARKER: marker },
	});
	const params = { role: "general", task: "frozen at dispatch" };
	const pending = run(tool, params);
	writeFileSync(
		process.env.ME_PI_DELEGATE_CONFIG,
		JSON.stringify({
			version: 3,
			scout: pool([LUNA], "low"),
			worker: pool([HAIKU, SONNET, OPUS], "max"),
		}),
	);
	const res = await pending;
	assert.equal(res.isError, true, text(res));
	assert.deepEqual(
		readFileSync(marker, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).model),
		[HAIKU],
	);
});

test("attempt provenance records malformed evidence, shell 429s, prior effects, and blocked calls", async (t) => {
	const config = {
		version: 3,
		scout: pool([LUNA], "low"),
		worker: pool([HAIKU, SONNET], "max"),
	};
	const cases = [
		["malformed-retry", "no-retry"],
		["shell-429", "tool-failure"],
		["partial-result-then-retry", "partial-result-unknown"],
		["tool-then-retry", "completed-unsafe"],
		["start-then-retry", "unmatched-unknown"],
		["blocked-owner-event", "guard-denial"],
	];
	for (const [mode, kind] of cases) {
		const marker = scratch(`fallback-${mode}-marker`);
		const { tool } = setup(t, {
			config,
			env: { FAKE_PI_MODE: mode, FAKE_PI_FAIL_MODEL: HAIKU, FAKE_PI_MARKER: marker },
		});
		const res = await run(tool, {
			role: "general",
			task: mode,
		});
		assert.equal(res.isError, true, mode);
		assert.deepEqual(
			readFileSync(marker, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line).model),
			[HAIKU],
			mode,
		);
		const provenance = res.details.round1[0].provenance[0];
		if (kind === "tool-failure" || kind === "partial-result-unknown")
			assert.ok(
				provenance.stopFacts.some((fact) => fact.cause === "tool-failure"),
				mode,
			);
		if (kind === "tool-failure") {
			assert.equal(provenance.toolEffects[0].effect, "unknown", mode);
			assert.equal(provenance.toolEffects[0].partialResultObserved, undefined, mode);
		}
		if (kind === "partial-result-unknown") {
			assert.equal(provenance.toolEffects[0].effect, "unknown", mode);
			assert.equal(provenance.toolEffects[0].partialResultObserved, true, mode);
			assert.notEqual(provenance.toolEffects[0].effect, "partial", mode);
		}
		if (kind === "completed-unsafe")
			assert.deepEqual(provenance.toolEffects[0], {
				owner: "pi-runtime",
				jobId: provenance.jobId,
				attempt: 1,
				toolCallId: "prior-effect",
				toolName: "bash",
				effect: "completed",
				replaySafe: false,
			});
		if (kind === "unmatched-unknown") {
			assert.equal(provenance.complete, false, mode);
			assert.equal(provenance.toolEffects[0].effect, "unknown", mode);
		}
		if (kind === "guard-denial")
			assert.ok(
				provenance.stopFacts.some((fact) => fact.owner === "guard" && fact.cause === "guard-denial"),
				mode,
			);
	}
});

test("a retry after the tool deadline retains the deadline stop and a competing guard denial", async (t) => {
	const delayedMarker = scratch("fallback-deadline-marker");
	const config = {
		version: 3,
		scout: pool([LUNA], "low"),
		worker: pool([HAIKU, SONNET], "max"),
	};
	const delayed = setup(t, {
		config,
		env: {
			FAKE_PI_MODE: "rate-limit-delayed",
			FAKE_PI_FAIL_MODEL: HAIKU,
			FAKE_PI_RETRY_DELAY: "1000",
			FAKE_PI_MARKER: delayedMarker,
		},
		// Tool deadline 100 ms, hard kill 10 s: the retry at 1 s lands >= 900 ms clear of both, whatever the spawn time.
		limits: { timeoutSecs: 10, wrapUpShare: 0.01 },
	});
	const deadline = await run(delayed.tool, {
		role: "general",
		task: "original tool deadline",
	});
	assert.equal(deadline.isError, true, text(deadline));
	assert.ok(
		deadline.details.round1[0].provenance[0].stopFacts.some(
			(fact) => fact.cause === "wrap-up-limit" && fact.resource === "tool-time",
		),
	);
	assert.deepEqual(
		readFileSync(delayedMarker, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).model),
		[HAIKU],
	);

	const competingMarker = scratch("fallback-competing-stop-marker");
	const competing = setup(t, {
		config,
		env: { FAKE_PI_MODE: "blocked-owner-hang", FAKE_PI_FAIL_MODEL: HAIKU, FAKE_PI_MARKER: competingMarker },
		limits: { timeoutSecs: 0.5 },
	});
	const stopped = await run(competing.tool, {
		role: "general",
		task: "competing safety cause",
	});
	assert.equal(stopped.isError, true, text(stopped));
	const stopFacts = stopped.details.round1[0].provenance[0].stopFacts;
	assert.ok(stopFacts.some((fact) => fact.owner === "guard" && fact.cause === "guard-denial"));
	assert.ok(stopFacts.some((fact) => fact.owner === "delegate-parent" && fact.cause === "hard-timeout"));
	assert.equal(stopped.details.round1[0].provenance[0].toolEffects[0].effect, "denied");
	assert.deepEqual(
		readFileSync(competingMarker, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).model),
		[HAIKU],
	);
});

test("a retry after the scout tool-call allowance retains the tool-call stop", async (t) => {
	const marker = scratch("fallback-scout-call-limit-marker");
	const { tool } = setup(t, {
		config: {
			version: 3,
			scout: pool([HAIKU, SONNET], "low"),
			worker: pool([LUNA], "max"),
		},
		env: { FAKE_PI_MODE: "read-then-retry", FAKE_PI_FAIL_MODEL: HAIKU, FAKE_PI_MARKER: marker },
		limits: { scoutToolCalls: 1 },
	});
	const res = await run(tool, {
		role: "scout",
		task: "shared scout call limit",
	});
	assert.equal(res.isError, true, text(res));
	const provenance = res.details.round1[0].provenance[0];
	assert.equal(res.details.round1[0].toolCallCount, 1);
	assert.deepEqual(
		provenance.toolEffects.map(({ effect, replaySafe }) => [effect, replaySafe]),
		[["completed", true]],
	);
	assert.ok(provenance.stopFacts.some((fact) => fact.cause === "wrap-up-limit" && fact.resource === "tool-calls"));
	assert.deepEqual(
		readFileSync(marker, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).model),
		[HAIKU],
	);
});

test("non-availability failures do not trigger pool fallback", async (t) => {
	const marker = scratch("no-fallback-marker");
	const { tool } = setup(t, {
		config: {
			...POOL_SET,
			worker: {
				models: [
					{ model: HAIKU, thinking: "max" },
					{ model: SONNET, thinking: "max" },
				],
				thinking: "max",
			},
		},
		env: { FAKE_PI_MODE: "fail-model", FAKE_PI_FAIL_MODEL: HAIKU, FAKE_PI_MARKER: marker },
	});
	const res = await run(tool, { role: "general", task: "x" });
	assert.equal(res.isError, true);
	const calls = readFileSync(marker, "utf8").trim().split("\n").map(JSON.parse);
	assert.deepEqual(
		calls.map((call) => call.model),
		[HAIKU],
	);
});
