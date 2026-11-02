import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import {
	CTX,
	fallbackAuthorization,
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
	TEST_HOME,
	text,
	UNAUTHENTICATED,
} from "./helpers/delegate-harness.ts";

test("dispatch stays first-only when a parent snapshot cannot bind a later child's endpoint", async (t) => {
	const marker = scratch("fallback-child-endpoint-marker");
	const modelsPath = join(mkdtempSync(join(TEST_HOME, "child-models-")), "models.json");
	const registry = registryFixture();
	const parentDestination = registry.find("anthropic", "claude-sonnet-5-5").baseUrl;
	writeFileSync(modelsPath, JSON.stringify({ providers: { anthropic: { baseUrl: parentDestination } } }));
	let credentialResolutionCalls = 0;
	registry.getApiKeyAndHeaders = () => {
		credentialResolutionCalls++;
		throw new Error("credential resolution must not be called");
	};
	const { tool } = setup(t, {
		config: {
			version: 3,
			scout: pool([LUNA], "low"),
			worker: pool([HAIKU, SONNET], "max"),
		},
		env: {
			FAKE_PI_MODE: "rate-limit-model",
			FAKE_PI_FAIL_MODEL: HAIKU,
			FAKE_PI_MARKER: marker,
			FAKE_PI_MODELS_PATH: modelsPath,
			FAKE_PI_DRIFT_ENDPOINT: "https://child-config-changed.invalid/v1",
		},
	});
	const result = await run(
		tool,
		{
			role: "review",
			task: "do not send this task to a later child with a changed endpoint",
			fallbackAuthorization: fallbackAuthorization([HAIKU, SONNET], { registry }),
		},
		undefined,
		undefined,
		{ ...CTX, modelRegistry: registry },
	);
	assert.equal(result.isError, true);
	assert.match(
		result.details.round1[0].fallbackBlockReason,
		/cross-model fallback deferred.*child-boundary endpoint enforcement/,
	);
	assert.equal(result.details.round1[0].requested.model, HAIKU);
	assert.equal(result.details.round1[0].provenance[0].providerRetry.owner, "pi-runtime");
	assert.equal(result.details.round1[0].provenance[0].providerRetry.sourceEvent, "auto_retry_start");
	const launches = readFileSync(marker, "utf8").trim().split("\n").map(JSON.parse);
	assert.equal(launches.length, 1, "no next Pi child was spawned after the child config drifted");
	assert.equal(launches[0].model, HAIKU);
	assert.equal(launches[0].configuredEndpoint, parentDestination, "the first child observed the parent snapshot URL");
	assert.match(launches[0].prompt, /do not send this task to a later child/);
	assert.equal(
		JSON.parse(readFileSync(modelsPath, "utf8")).providers.anthropic.baseUrl,
		"https://child-config-changed.invalid/v1",
		"the config a later child would load changed after the parent snapshot",
	);
	assert.equal(credentialResolutionCalls, 0);
});

test("model pools resolve per-model thinking, ordered candidates, and independent overrides", () => {
	assert.deepEqual(resolveRun("scout", {}, POOL_SET), {
		model: LUNA,
		candidates: [
			{ model: LUNA, thinking: "off" },
			{ model: HAIKU, thinking: "off" },
		],
		thinking: "off",
	});
	assert.deepEqual(resolveRun("review", {}, POOL_SET), {
		model: LUNA,
		candidates: [
			{ model: LUNA, thinking: "max" },
			{ model: OPUS, thinking: "max" },
		],
		thinking: "max",
	});
	assert.deepEqual(resolveRun("research", { model: OPUS, thinking: "high" }, POOL_SET), {
		model: OPUS,
		candidates: [{ model: OPUS, thinking: "high" }],
		thinking: "high",
	});
	assert.deepEqual(resolveRun("review", { model: HAIKU }, POOL_SET), {
		model: HAIKU,
		candidates: [{ model: HAIKU, thinking: "off" }],
		thinking: "off",
	});
	assert.deepEqual(resolveRun("review", { model: ONE_OFF }, POOL_SET), {
		model: ONE_OFF,
		candidates: [{ model: ONE_OFF, thinking: "max" }],
		thinking: "max",
	});
	assert.deepEqual(resolveRun("review", { model: ONE_OFF, thinking: "low" }, POOL_SET), {
		model: ONE_OFF,
		candidates: [{ model: ONE_OFF, thinking: "low" }],
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
	assert.deepEqual(resolveRun("review", { model: OPUS }, perModelSet), {
		model: OPUS,
		candidates: [{ model: OPUS, thinking: "low" }],
		thinking: "low",
	});
	assert.deepEqual(resolveRun("review", { thinking: "medium" }, perModelSet), {
		model: HAIKU,
		candidates: [
			{ model: HAIKU, thinking: "medium" },
			{ model: OPUS, thinking: "medium" },
		],
		thinking: "medium",
	});
	assert.deepEqual(resolveRun("review", { model: ONE_OFF }, perModelSet), {
		model: ONE_OFF,
		candidates: [{ model: ONE_OFF, thinking: "medium" }],
		thinking: "medium",
	});
	assert.deepEqual(resolveRun("scout", { thinking: "high" }, POOL_SET), {
		model: LUNA,
		candidates: [
			{ model: LUNA, thinking: "low" },
			{ model: HAIKU, thinking: "low" },
		],
		thinking: "low",
	});
	assert.deepEqual(resolveRun("scout", { model: ONE_OFF, thinking: "off" }, POOL_SET), {
		model: ONE_OFF,
		candidates: [{ model: ONE_OFF, thinking: "off" }],
		thinking: "off",
	});
	assert.deepEqual(resolveRun("scout", { model: ONE_OFF, thinking: "high" }, POOL_SET), {
		model: ONE_OFF,
		candidates: [{ model: ONE_OFF, thinking: "low" }],
		thinking: "low",
	});
	const withReviewPool = {
		...POOL_SET,
		review: {
			models: [
				{ model: OPUS, thinking: "high" },
				{ model: SONNET, thinking: "medium" },
			],
			thinking: "low",
		},
	};
	assert.deepEqual(resolveRun("review", {}, withReviewPool), {
		model: OPUS,
		candidates: [
			{ model: OPUS, thinking: "high" },
			{ model: SONNET, thinking: "medium" },
		],
		thinking: "high",
	});
	assert.deepEqual(resolveRun("general", {}, withReviewPool), {
		model: LUNA,
		candidates: [
			{ model: LUNA, thinking: "max" },
			{ model: OPUS, thinking: "max" },
		],
		thinking: "max",
	});
	assert.deepEqual(resolveRun("research", {}, withReviewPool), {
		model: LUNA,
		candidates: [
			{ model: LUNA, thinking: "max" },
			{ model: OPUS, thinking: "max" },
		],
		thinking: "max",
	});
	assert.deepEqual(resolveRun("review", { model: ONE_OFF }, withReviewPool), {
		model: ONE_OFF,
		candidates: [{ model: ONE_OFF, thinking: "low" }],
		thinking: "low",
	});
	// An exact model absent from review keeps existing cross-pool precedence (scout before worker).
	assert.deepEqual(resolveRun("review", { model: LUNA }, withReviewPool), {
		model: LUNA,
		candidates: [{ model: LUNA, thinking: "off" }],
		thinking: "off",
	});
	assert.deepEqual(resolveRun("review", { model: LUNA, thinking: "max" }, withReviewPool), {
		model: LUNA,
		candidates: [{ model: LUNA, thinking: "max" }],
		thinking: "max",
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

	const defaulted = await run(tool, { role: "review", task: "x", runs: [{ model: ONE_OFF }] });
	assert.equal(defaulted.isError, false, text(defaulted));
	assert.match(text(defaulted), new RegExp(`DONE model=${ONE_OFF} thinking=medium`));

	const overridden = await run(tool, {
		role: "review",
		task: "x",
		runs: [{ model: ONE_OFF, thinking: "high" }],
	});
	assert.equal(overridden.isError, false, text(overridden));
	assert.match(text(overridden), new RegExp(`DONE model=${ONE_OFF} thinking=high`));

	const listed = await run(tool, { role: "review", task: "x", runs: [{ model: OPUS }] });
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

test("an explicit thinking override applies to the first selected pool candidate", async (t) => {
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
		role: "review",
		task: "x",
		runs: [{ thinking: "medium" }],
		fallbackAuthorization: fallbackAuthorization([HAIKU, SONNET]),
	});
	assert.equal(res.isError, true, text(res));
	assert.equal(res.details.round1[0].requested.model, HAIKU);
	assert.equal(res.details.round1[0].requested.thinking, "medium");
	assert.match(res.details.round1[0].fallbackBlockReason, /cross-model fallback deferred/);
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
		["google/not-in-catalog", /unknown model .*no exact provider\/model match/],
		[UNAUTHENTICATED, /unauthenticated.*no configured authentication/],
		["Gemini Flash", /must be an exact Pi model ID in provider\/model form/],
	]) {
		const res = await run(tool, { role: "review", task: "x", runs: [{ model }] }, undefined, undefined, context);
		assert.equal(res.isError, true, model);
		assert.match(text(res), error);
	}
	const unsupported = await run(
		tool,
		{ role: "review", task: "x", runs: [{ model: ONE_OFF }] },
		undefined,
		undefined,
		{ ...CTX, modelRegistry: {} },
	);
	assert.equal(unsupported.isError, true);
	assert.match(text(unsupported), /model registry lacks catalog\/auth lookup/);
	assert.equal(existsSync(marker), false, "invalid or unverifiable models never spawn a worker");
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
	const res = await run(tool, { role: "review", task: "x", runs: [{ model: ONE_OFF }] });
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
	const res = await run(tool, { role: "review", task: "x", runs: [{ model: HAIKU }] });
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
		role: "review",
		task: "x",
		fallbackAuthorization: fallbackAuthorization([HAIKU, SONNET]),
	});
	assert.equal(res.isError, true, text(res));
	assert.equal(res.details.round1[0].requested.model, HAIKU);
	assert.match(res.details.round1[0].fallbackBlockReason, /cross-model fallback deferred/);
	assert.match(text(res), /Pool fallback not attempted: cross-model fallback deferred/);
	const calls = readFileSync(marker, "utf8").trim().split("\n").map(JSON.parse);
	assert.deepEqual(
		calls.map((call) => [call.model, call.thinking]),
		[[HAIKU, "max"]],
	);
	assert.equal(res.usage.cost.total, 0.002);
});

test("quota and usage-limit failures do not fall through an authorized pool", async (t) => {
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
			role: "review",
			task: "x",
			fallbackAuthorization: fallbackAuthorization([HAIKU, SONNET]),
		});
		assert.equal(res.isError, true, error);
		assert.equal(res.details.round1[0].requested.model, HAIKU, error);
		assert.match(res.details.round1[0].fallbackBlockReason, /no structured retry classification/);
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

test("first-only dispatch reports the first candidate's worker cost", async (t) => {
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
		role: "review",
		task: "x",
		fallbackAuthorization: fallbackAuthorization([HAIKU, SONNET, OPUS], { authority: "adopted-snapshot" }),
	});
	assert.equal(res.isError, true);
	assert.equal(res.details.round1[0].requested.model, HAIKU);
	assert.match(res.details.round1[0].fallbackBlockReason, /cross-model fallback deferred/);
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

test("default dispatch keeps the first candidate's configured thinking level", async (t) => {
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
	const res = await run(
		tool,
		{ role: "review", task: "x", fallbackAuthorization: fallbackAuthorization([LUNA, OPUS]) },
		undefined,
		(update) => progress.push(update),
	);
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
	assert.match(res.details.round1[0].fallbackBlockReason, /cross-model fallback deferred/);
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
		role: "research",
		task: "x",
		fallbackAuthorization: fallbackAuthorization([HAIKU, SONNET]),
	});
	assert.equal(res.isError, true, text(res));
	assert.deepEqual(
		readFileSync(marker, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).model),
		[HAIKU],
	);
	assert.match(text(res), /no structured retry classification/);
});

test("an adopted scope and later config changes cannot enable cross-model fallback", async (t) => {
	const marker = scratch("adopted-snapshot-frozen-marker");
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
	});
	// Even a valid-looking adopted scope does not enable fallback at the fresh child boundary.
	const authorization = fallbackAuthorization([HAIKU, SONNET], { authority: "adopted-snapshot" });
	const pending = run(tool, {
		role: "review",
		task: "use the adopted recorded snapshot, not later config",
		fallbackAuthorization: authorization,
	});
	const opusScope = fallbackAuthorization([OPUS]).candidates[0];
	authorization.candidates.push(opusScope);
	authorization.candidates[1].provider = "changed-provider";
	authorization.candidates[1].destination = "https://changed.invalid";
	authorization.candidates[1].dataClasses[0] = "public";
	writeFileSync(
		process.env.ME_PI_DELEGATE_CONFIG,
		JSON.stringify({
			version: 3,
			scout: pool([LUNA], "low"),
			worker: pool([HAIKU, OPUS, ONE_OFF], "max"),
		}),
	);

	const res = await pending;
	assert.equal(res.isError, true, text(res));
	assert.equal(res.details.round1[0].requested.model, HAIKU);
	assert.match(res.details.round1[0].fallbackBlockReason, /cross-model fallback deferred/);
	assert.deepEqual(
		readFileSync(marker, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).model),
		[HAIKU],
	);
});

test("configuration and authorization added after dispatch cannot start another child", async (t) => {
	const marker = scratch("late-fallback-authorization-marker");
	const { tool } = setup(t, {
		config: {
			version: 3,
			scout: pool([LUNA], "low"),
			worker: pool([HAIKU, SONNET], "max"),
		},
		env: { FAKE_PI_MODE: "rate-limit-model", FAKE_PI_FAIL_MODEL: HAIKU, FAKE_PI_MARKER: marker },
	});
	const params = { role: "review", task: "frozen at dispatch" };
	const pending = run(tool, params);
	writeFileSync(
		process.env.ME_PI_DELEGATE_CONFIG,
		JSON.stringify({
			version: 3,
			scout: pool([LUNA], "low"),
			worker: pool([HAIKU, SONNET, OPUS], "max"),
		}),
	);
	params.fallbackAuthorization = fallbackAuthorization([HAIKU, SONNET, OPUS]);
	const res = await pending;
	assert.equal(res.isError, true, text(res));
	assert.match(res.details.round1[0].fallbackBlockReason, /cross-model fallback deferred/);
	assert.deepEqual(
		readFileSync(marker, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).model),
		[HAIKU],
	);
});

test("named, adopted, or mismatched scope metadata cannot enable fallback", async (t) => {
	const marker = scratch("scope-metadata-no-fallback-marker");
	const { tool } = setup(t, {
		config: {
			version: 3,
			scout: pool([LUNA], "low"),
			worker: pool([HAIKU, SONNET], "max"),
		},
		env: { FAKE_PI_MODE: "rate-limit-model", FAKE_PI_FAIL_MODEL: HAIKU, FAKE_PI_MARKER: marker },
	});
	const validNamed = fallbackAuthorization([HAIKU, SONNET]);
	const validAdopted = fallbackAuthorization([HAIKU, SONNET], { authority: "adopted-snapshot" });
	const mismatched = fallbackAuthorization([HAIKU, SONNET]);
	mismatched.candidates[1].destination = "https://other.invalid";
	for (const [name, authorization] of [
		["named", validNamed],
		["adopted", validAdopted],
		["mismatched destination", mismatched],
	]) {
		const res = await run(tool, { role: "review", task: name, fallbackAuthorization: authorization });
		assert.equal(res.isError, true, name);
		assert.equal(res.details.round1[0].requested.model, HAIKU, name);
		assert.match(res.details.round1[0].fallbackBlockReason, /cross-model fallback deferred/, name);
	}
	assert.deepEqual(
		readFileSync(marker, "utf8")
			.trim()
			.split("\n")
			.map(JSON.parse)
			.map((call) => call.model),
		[HAIKU, HAIKU, HAIKU],
	);
});

test("fallback fails closed on malformed evidence, shell 429s, prior effects, and blocked calls", async (t) => {
	const config = {
		version: 3,
		scout: pool([LUNA], "low"),
		worker: pool([HAIKU, SONNET], "max"),
	};
	const cases = [
		["malformed-retry", /no structured retry classification/, "no-retry"],
		["shell-429", /no structured retry classification/, "tool-failure"],
		["partial-result-then-retry", /competing safety stop/, "partial-result-unknown"],
		["tool-then-retry", /tool effects are unknown or unsafe/, "completed-unsafe"],
		["start-then-retry", /tool effects are unknown or unsafe/, "unmatched-unknown"],
		["blocked-owner-event", /no structured retry classification/, "guard-denial"],
	];
	for (const [mode, reason, kind] of cases) {
		const marker = scratch(`fallback-${mode}-marker`);
		const { tool } = setup(t, {
			config,
			env: { FAKE_PI_MODE: mode, FAKE_PI_FAIL_MODEL: HAIKU, FAKE_PI_MARKER: marker },
		});
		const res = await run(tool, {
			role: "review",
			task: mode,
			fallbackAuthorization: fallbackAuthorization([HAIKU, SONNET]),
		});
		assert.equal(res.isError, true, mode);
		assert.match(res.details.round1[0].fallbackBlockReason, reason, mode);
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

test("fallback keeps the original tool deadline and retains a competing guard denial", async (t) => {
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
			FAKE_PI_RETRY_DELAY: "850",
			FAKE_PI_MARKER: delayedMarker,
		},
		limits: { timeoutSecs: 1 },
	});
	const deadline = await run(delayed.tool, {
		role: "review",
		task: "original tool deadline",
		fallbackAuthorization: fallbackAuthorization([HAIKU, SONNET]),
	});
	assert.equal(deadline.isError, true, text(deadline));
	assert.match(deadline.details.round1[0].fallbackBlockReason, /original tool deadline/);
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
		role: "review",
		task: "competing safety cause",
		fallbackAuthorization: fallbackAuthorization([HAIKU, SONNET]),
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

test("fallback preserves the cumulative scout tool-call allowance", async (t) => {
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
		fallbackAuthorization: fallbackAuthorization([HAIKU, SONNET]),
	});
	assert.equal(res.isError, true, text(res));
	assert.match(res.details.round1[0].fallbackBlockReason, /cumulative scout tool-call allowance is spent/);
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
	const res = await run(tool, { role: "review", task: "x" });
	assert.equal(res.isError, true);
	const calls = readFileSync(marker, "utf8").trim().split("\n").map(JSON.parse);
	assert.deepEqual(
		calls.map((call) => call.model),
		[HAIKU],
	);
});
