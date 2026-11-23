import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	classifyProviderError,
	LIMITS,
	OPUS,
	run,
	scratch,
	setup,
	TEST_HOME,
	text,
} from "./helpers/delegate-harness.ts";

test("provider errors are classified as infra, account, or model/task", () => {
	for (const message of [
		"Upstream error from OpenInference: Upstream returned HTTP 409",
		"Request timed out",
		"fetch failed: ECONNRESET",
		"503 Service Unavailable",
		"429 rate_limit_error: too many requests",
	])
		assert.equal(classifyProviderError(message), "infra", message);
	for (const message of [
		"403 Key limit exceeded (total limit)",
		"429 quota exceeded for this project",
		"insufficient_quota: check your plan",
		"401 Unauthorized",
	])
		assert.equal(classifyProviderError(message), "account", message);
	for (const message of [
		"invalid request: tool schema rejected",
		"400 invalid_request_error: max_tokens: 550 > 512",
		"",
		undefined,
	])
		assert.equal(classifyProviderError(message), "model/task", String(message));
});

test("an infra failure without effects is retried on the same model; effects or account limits are not", async (t) => {
	const counter = () => join(mkdtempSync(join(TEST_HOME, "infra-")), "runs");
	const { tool } = setup(t, {
		env: { FAKE_PI_MODE: "infra-flaky", FAKE_PI_INFRA_FAILS: "2", FAKE_PI_ERROR: "Upstream returned HTTP 409" },
		limits: { infraRetryDelaysMs: [1, 1] },
	});
	process.env.FAKE_PI_COUNTER = counter();
	const retried = await run(tool, { role: "scout", task: "look" });
	assert.equal(retried.isError, false, text(retried));
	assert.match(text(retried), /Answered after run 3\./);
	const [r] = retried.details.round1;
	assert.deepEqual(r.infraRetries, ["exit 1: Upstream returned HTTP 409", "exit 1: Upstream returned HTTP 409"]);
	assert.deepEqual(
		r.provenance.map((p) => p.attempt),
		[1, 2, 3],
	);

	process.env.FAKE_PI_COUNTER = counter();
	process.env.FAKE_PI_INFRA_FAILS = "5";
	const exhausted = await run(tool, { role: "scout", task: "look" });
	assert.equal(exhausted.isError, true);
	assert.match(
		text(exhausted),
		/^Failure class: infra \(provider or network, not the task\); retried 2× on the same model\.$/m,
	);
	assert.equal(readFileSync(process.env.FAKE_PI_COUNTER, "utf8"), "3");

	process.env.FAKE_PI_COUNTER = counter();
	process.env.FAKE_PI_ERROR = "403 Key limit exceeded (total limit)";
	const account = await run(tool, { role: "scout", task: "look" });
	assert.match(
		text(account),
		/^Failure class: account \(quota, key, or billing limit\); BLOCKER: retrying cannot help\.$/m,
	);
	assert.equal(readFileSync(process.env.FAKE_PI_COUNTER, "utf8"), "1");
});

test("a provider retry after the cost cap is spent records a stop and is not retried on the same model", async (t) => {
	const marker = scratch("spent-budget-retry-marker");
	const launches = () => readFileSync(marker, "utf8").trim().split("\n").length;
	const { tool } = setup(t, {
		env: { FAKE_PI_MODE: "rate-limit-model", FAKE_PI_FAIL_MODEL: OPUS, FAKE_PI_MARKER: marker },
		limits: { infraRetryDelaysMs: [1, 1] },
	});
	const control = await run(tool, { role: "scout", task: "look", runs: [{ model: OPUS }] });
	assert.equal(control.isError, true);
	assert.equal(launches(), 3, "with budget left, the infra failure is retried on the same model");

	rmSync(marker);
	Object.assign(LIMITS, { costCapUsd: 0.002 });
	const spent = await run(tool, { role: "scout", task: "look", runs: [{ model: OPUS }] });
	assert.equal(spent.isError, true);
	assert.equal(launches(), 1, "a spent cost cap stops the same-model retry");
	const [r] = spent.details.round1;
	assert.equal(r.infraRetries, undefined);
	assert.ok(
		r.provenance[0].stopFacts.some((fact) => fact.owner === "delegate-parent" && fact.resource === "tool-cost"),
	);
});
