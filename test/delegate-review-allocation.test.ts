// Issue #50: concurrent `review` calls without a model start on the least-occupied eligible review-pool model.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { resolveRuns } from "../extensions/delegate-config.ts";
import {
	CTX,
	commandCtx,
	FAKE_BIN,
	HAIKU,
	LIMITS,
	LUNA,
	OPUS,
	pool,
	REGISTRY_MODELS,
	registryFixture,
	run,
	SONNET,
	scratch,
	setup,
	TEST_HOME,
	text,
	UNAUTHENTICATED,
	waitFor,
} from "./helpers/delegate-harness.ts";

const reviewSet = (models: { model: string; thinking: string }[]) => ({
	version: 3,
	scout: pool([HAIKU, SONNET], "low"),
	worker: pool([LUNA, OPUS], "max"),
	review: { models, thinking: "medium" },
});
const TWO = reviewSet([
	{ model: OPUS, thinking: "high" },
	{ model: SONNET, thinking: "low" },
]);
const SHARED_NOTE =
	/Review model shared: (\S+) already has (\d+) review run\(s\) reserved; all eligible distinct pool models are occupied\./;

const launches = (marker: string) =>
	existsSync(marker)
		? readFileSync(marker, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const { model, thinking } = JSON.parse(line);
					return [model, thinking];
				})
		: [];

const review = (task: string, extra = {}) => ({ role: "review", task, ...extra });

/** Starts the calls in the same tick, then settles them all. */
async function concurrent(tool, calls: object[], ctx = CTX) {
	const pending = calls.map((params) => run(tool, params, undefined, undefined, ctx));
	const settled = await Promise.allSettled(pending);
	return settled.map((s) => {
		assert.equal(s.status, "fulfilled", String((s as PromiseRejectedResult).reason));
		return (s as PromiseFulfilledResult<any>).value;
	});
}

const indexes = (results) => results.map((r) => r.details.allocation[0].poolIndex);

async function runningNone(commands) {
	const { ctx, notes } = commandCtx();
	await commands.delegate.handler("status", ctx);
	return /\nRunning: none\n/.test(notes[0][0]);
}

test("resolveRuns: least-occupied eligible review entry, ties to config order, explicit models count", () => {
	const registry = registryFixture();
	const opts = (occupied = new Map()) => ({ sessionModel: "x/session", sessionThinking: "high", registry, occupied });
	assert.deepEqual(resolveRuns("review", [{}], TWO, opts()), [
		{ model: OPUS, thinking: "high", allocation: { source: "pool", poolIndex: 0, shared: 0 } },
	]);
	assert.deepEqual(
		resolveRuns("review", [{}, {}, { thinking: "minimal" }], TWO, opts()).map((r) => [
			r.model,
			r.thinking,
			r.allocation.poolIndex,
			r.allocation.shared,
		]),
		[
			[OPUS, "high", 0, 0],
			[SONNET, "low", 1, 0],
			[OPUS, "minimal", 0, 1],
		],
	);
	assert.deepEqual(
		resolveRuns("review", [{}], TWO, opts(new Map([[OPUS, 1]]))).map((r) => r.model),
		[SONNET],
	);
	// An explicit run in the same call reserves first, wherever it sits in `runs`.
	assert.deepEqual(
		resolveRuns("review", [{}, { model: OPUS }], TWO, opts()).map((r) => [r.model, r.allocation]),
		[
			[SONNET, { source: "pool", poolIndex: 1, shared: 0 }],
			[OPUS, { source: "explicit", shared: 0 }],
		],
	);
	// Other roles ignore occupancy and keep the first entry.
	for (const role of ["general", "research", "challenge", "scout"])
		assert.deepEqual(
			resolveRuns(role, [{}, {}], TWO, opts(new Map([[LUNA, 3]]))).map((r) => r.allocation),
			[
				{ source: "pool", poolIndex: 0, shared: 0 },
				{ source: "pool", poolIndex: 0, shared: 0 },
			],
			role,
		);
	// No pool: the session model, as before.
	const empty = { version: 3 as const, scout: { models: [] }, worker: { models: [] } };
	assert.deepEqual(resolveRuns("review", [{}, {}], empty, opts()), [
		{ model: "x/session", thinking: "high", allocation: { source: "session", shared: 0 } },
		{ model: "x/session", thinking: "high", allocation: { source: "session", shared: 0 } },
	]);
	// Without a review pool, review allocates over the worker pool.
	assert.deepEqual(
		resolveRuns("review", [{}, {}], { ...TWO, review: undefined }, opts()).map((r) => [r.model, r.thinking]),
		[
			[LUNA, "max"],
			[OPUS, "max"],
		],
	);
});

test("separate concurrent review calls start on distinct pool models; sequential calls do not rotate", async (t) => {
	const marker = scratch("alloc-pair-marker");
	const { tool } = setup(t, { config: TWO, env: { FAKE_PI_MARKER: marker } });
	const pair = await concurrent(tool, [review("Standards"), review("Spec")]);
	for (const r of pair) assert.equal(r.isError, false, text(r));
	assert.deepEqual(launches(marker).sort(), [
		[OPUS, "high"],
		[SONNET, "low"],
	]);
	assert.deepEqual(indexes(pair), [0, 1]);
	assert.deepEqual(
		pair.map((r) => [r.details.round1[0].requested.model, r.details.round1[0].requested.thinking]),
		[
			[OPUS, "high"],
			[SONNET, "low"],
		],
	);
	for (const r of pair) assert.doesNotMatch(text(r), SHARED_NOTE);

	writeFileSync(marker, "");
	const sequential = [];
	for (const task of ["one", "two", "three"]) sequential.push(await run(tool, review(task)));
	assert.deepEqual(indexes(sequential), [0, 0, 0]);
	assert.deepEqual(launches(marker), [
		[OPUS, "high"],
		[OPUS, "high"],
		[OPUS, "high"],
	]);
});

test("three concurrent calls: three entries give A, B, C; two entries give A, B, A with a shared note", async (t) => {
	const marker = scratch("alloc-three-marker");
	const three = setup(t, {
		config: reviewSet([
			{ model: OPUS, thinking: "high" },
			{ model: SONNET, thinking: "low" },
			{ model: HAIKU, thinking: "minimal" },
		]),
		env: { FAKE_PI_MARKER: marker },
	});
	const abc = await concurrent(three.tool, [review("a"), review("b"), review("c")]);
	assert.deepEqual(indexes(abc), [0, 1, 2]);
	assert.deepEqual(
		abc.map((r) => [r.details.round1[0].requested.model, r.details.round1[0].requested.thinking]),
		[
			[OPUS, "high"],
			[SONNET, "low"],
			[HAIKU, "minimal"],
		],
	);
	for (const r of abc) assert.doesNotMatch(text(r), SHARED_NOTE);

	const two = setup(t, { config: TWO, env: { FAKE_PI_MARKER: marker } });
	const aba = await concurrent(two.tool, [review("a"), review("b"), review("c")]);
	assert.deepEqual(indexes(aba), [0, 1, 0]);
	assert.deepEqual(
		aba.map((r) => r.details.allocation[0].shared),
		[0, 0, 1],
	);
	assert.doesNotMatch(text(aba[0]), SHARED_NOTE);
	assert.doesNotMatch(text(aba[1]), SHARED_NOTE);
	const note = text(aba[2]).match(SHARED_NOTE);
	assert.ok(note, text(aba[2]));
	assert.deepEqual([note[1], note[2]], [OPUS, "1"]);
	for (const r of aba) assert.equal(r.isError, false, text(r));
});

test("a reservation is released on every exit; a busy refusal reserves nothing", { timeout: 60000 }, async (t) => {
	const marker = scratch("alloc-release-marker");
	const { tool, commands, handlers, messages } = setup(t, {
		config: TWO,
		// FAKE_PI_MODE is listed so the test's restore covers the direct mutations below.
		env: { FAKE_PI_MARKER: marker, FAKE_PI_FAIL_MODEL: OPUS, FAKE_PI_MODE: undefined },
	});
	// A fresh concurrent pair after the call ended: [0, 1] proves no OPUS reservation leaked ([1, 0] if it did).
	const freshPair = async (why: string) => {
		process.env.FAKE_PI_MODE = "";
		assert.ok(await runningNone(commands), `${why}: nothing left running`);
		const pair = await concurrent(tool, [review("a"), review("b")]);
		assert.deepEqual(indexes(pair), [0, 1], why);
		for (const r of pair) assert.equal(r.isError, false, `${why}: ${text(r)}`);
	};
	const heldOnOpus = (r) => assert.equal(r.details.round1[0].requested.model, OPUS);

	const ok = await run(tool, review("success"));
	assert.equal(ok.isError, false, text(ok));
	heldOnOpus(ok);
	await freshPair("success");

	process.env.FAKE_PI_MODE = "fail-model";
	const failed = await run(tool, review("worker failure"));
	assert.equal(failed.isError, true);
	assert.match(text(failed), /invalid request: tool schema rejected/);
	heldOnOpus(failed);
	await freshPair("worker failure");

	process.env.FAKE_PI_MODE = "hang";
	writeFileSync(marker, "");
	const started = await run(tool, review("background hang", { background: true }));
	const id = started.details.background;
	await waitFor(() => launches(marker).length === 1, "the background worker to start");
	assert.deepEqual(launches(marker), [[OPUS, "high"]]);
	const { ctx } = commandCtx();
	await commands.delegate.handler(`cancel ${id}`, ctx);
	await waitFor(() => messages.length === 1, "the cancelled job to report");
	assert.match(messages[0].message.content, /failed:\n\n✗ stopped: cancelled/);
	assert.equal(messages[0].message.details.allocation[0].poolIndex, 0);
	await freshPair("cancel");

	process.env.FAKE_PI_MODE = "hang";
	LIMITS.timeoutSecs = 0.5;
	const timedOut = await run(tool, review("hard timeout"));
	assert.match(text(timedOut), /^✗ stopped: timeout after 0\.5s/);
	heldOnOpus(timedOut);
	LIMITS.timeoutSecs = 900;
	await freshPair("hard timeout");

	process.env.PI_BIN = join(TEST_HOME, "no-such-pi");
	const launchError = await run(tool, review("launch error"));
	assert.equal(launchError.isError, true);
	heldOnOpus(launchError);
	process.env.PI_BIN = FAKE_BIN;
	await freshPair("launch error");

	// Three hanging review runs hold OPUS twice and SONNET once; a 2-run call would pass the cap and is refused.
	process.env.FAKE_PI_MODE = "hang";
	writeFileSync(marker, "");
	const holder = await run(tool, review("hold three", { background: true, runs: [{}, {}, {}] }));
	await waitFor(() => launches(marker).length === 3, "three hanging workers");
	const refused = await run(tool, review("over the cap", { runs: [{}, {}] }));
	assert.equal(refused.isError, true);
	assert.match(text(refused), /^3 worker\(s\) already running; at most 4 run at once/);
	// The refusal reserved nothing: the next run still sees OPUS×2, SONNET×1 and takes SONNET, shared once.
	const fourth = await run(tool, review("fourth", { background: true }));
	await waitFor(() => launches(marker).length === 4, "the fourth worker");
	assert.deepEqual(launches(marker).at(-1), [SONNET, "low"]);
	await commands.delegate.handler(`cancel ${holder.details.background}`, ctx);
	await commands.delegate.handler(`cancel ${fourth.details.background}`, ctx);
	await waitFor(() => messages.length === 3, "both background jobs to report");
	const fourthDetails = messages.find((m) =>
		m.message.content.startsWith(`Background delegate job ${fourth.details.background}`),
	).message.details;
	assert.deepEqual(fourthDetails.allocation, [{ source: "pool", poolIndex: 1, shared: 1 }]);
	await freshPair("busy refusal and cancels");

	// Last: session_shutdown terminates this extension instance, so no call runs on it afterwards.
	process.env.FAKE_PI_MODE = "hang";
	writeFileSync(marker, "");
	const pending = run(tool, review("session shutdown"));
	await waitFor(() => launches(marker).length === 1, "the foreground worker to start");
	assert.equal(await runningNone(commands), false, "the call holds its reservation while it runs");
	await handlers.session_shutdown();
	const ended = await pending;
	assert.match(text(ended), /^✗ stopped: session ended/);
	heldOnOpus(ended);
	assert.ok(await runningNone(commands), "session_shutdown released the reservation");
});

test("duplicate aliases are one candidate; the first occurrence keeps its thinking", async (t) => {
	const marker = scratch("alloc-alias-marker");
	const { tool } = setup(t, {
		config: reviewSet([
			{ model: "claude-opus-5-5", thinking: "high" },
			{ model: OPUS, thinking: "low" },
		]),
		env: { FAKE_PI_MARKER: marker },
	});
	const pair = await concurrent(tool, [review("a"), review("b")]);
	assert.deepEqual(launches(marker), [
		[OPUS, "high"],
		[OPUS, "high"],
	]);
	assert.deepEqual(
		pair.map((r) => r.details.allocation[0]),
		[
			{ source: "pool", poolIndex: 0, shared: 0 },
			{ source: "pool", poolIndex: 0, shared: 1 },
		],
	);
	assert.doesNotMatch(text(pair[0]), SHARED_NOTE);
	assert.match(text(pair[1]), SHARED_NOTE);
	for (const r of pair) assert.equal(r.isError, false, text(r));
});

test("ineligible later entries are skipped silently; without registry lookup only entry 0 is eligible", async (t) => {
	const marker = scratch("alloc-eligible-marker");
	const { tool } = setup(t, {
		config: reviewSet([
			{ model: OPUS, thinking: "high" },
			{ model: UNAUTHENTICATED, thinking: "max" },
			{ model: "missing/model", thinking: "max" },
			{ model: SONNET, thinking: "low" },
		]),
		env: { FAKE_PI_MARKER: marker },
	});
	const ctx = {
		...CTX,
		modelRegistry: registryFixture({ catalog: [...REGISTRY_MODELS, UNAUTHENTICATED], available: REGISTRY_MODELS }),
	};
	const pair = await concurrent(tool, [review("a"), review("b")], ctx);
	for (const r of pair) assert.equal(r.isError, false, text(r));
	assert.deepEqual(indexes(pair), [0, 3]);
	assert.deepEqual(launches(marker).sort(), [
		[OPUS, "high"],
		[SONNET, "low"],
	]);

	writeFileSync(marker, "");
	const blind = await concurrent(tool, [review("a"), review("b")], { ...CTX, modelRegistry: {} });
	for (const r of blind) assert.equal(r.isError, false, text(r));
	assert.deepEqual(launches(marker), [
		[OPUS, "high"],
		[OPUS, "high"],
	]);
	assert.equal(blind[1].details.allocation[0].shared, 1);
	assert.match(text(blind[1]), SHARED_NOTE);
});

test("explicit models stay exact and count as occupancy; runs[].thinking applies to the allocated model", async (t) => {
	const marker = scratch("alloc-explicit-marker");
	const { tool } = setup(t, { config: TWO, env: { FAKE_PI_MARKER: marker } });
	const avoid = await concurrent(tool, [review("explicit", { runs: [{ model: OPUS }] }), review("default")]);
	assert.deepEqual(
		avoid.map((r) => r.details.allocation[0]),
		[
			{ source: "explicit", shared: 0 },
			{ source: "pool", poolIndex: 1, shared: 0 },
		],
	);
	assert.deepEqual(launches(marker).sort(), [
		[OPUS, "high"],
		[SONNET, "low"],
	]);

	writeFileSync(marker, "");
	const exact = await concurrent(tool, [review("default"), review("explicit", { runs: [{ model: OPUS }] })]);
	assert.deepEqual(
		exact.map((r) => [r.details.round1[0].requested.model, r.details.allocation[0].source]),
		[
			[OPUS, "pool"],
			[OPUS, "explicit"],
		],
	);
	assert.equal(exact[1].details.allocation[0].shared, 1);
	assert.doesNotMatch(text(exact[1]), SHARED_NOTE, "the shared note is for default runs only");

	writeFileSync(marker, "");
	const thinking = await concurrent(tool, [review("a"), review("b", { runs: [{ thinking: "minimal" }] })]);
	assert.deepEqual(
		thinking.map((r) => [r.details.round1[0].requested.model, r.details.round1[0].requested.thinking]),
		[
			[OPUS, "high"],
			[SONNET, "minimal"],
		],
	);
	assert.deepEqual(launches(marker).sort(), [
		[OPUS, "high"],
		[SONNET, "minimal"],
	]);
});

test("a single eligible model is shared without error", async (t) => {
	const marker = scratch("alloc-single-marker");
	const { tool } = setup(t, {
		config: reviewSet([{ model: SONNET, thinking: "medium" }]),
		env: { FAKE_PI_MARKER: marker },
	});
	const pair = await concurrent(tool, [review("a"), review("b")]);
	for (const r of pair) assert.equal(r.isError, false, text(r));
	assert.deepEqual(launches(marker), [
		[SONNET, "medium"],
		[SONNET, "medium"],
	]);
	assert.equal(pair[1].details.allocation[0].shared, 1);
	assert.match(text(pair[1]), SHARED_NOTE);
});

test("an allocated model is never switched after dispatch: infra retries and rebuttals keep it", async (t) => {
	const marker = scratch("alloc-retry-marker");
	const { tool } = setup(t, {
		config: TWO,
		env: { FAKE_PI_MODE: "rate-limit-model", FAKE_PI_FAIL_MODEL: SONNET, FAKE_PI_MARKER: marker },
		limits: { infraRetryDelaysMs: [1, 1] },
	});
	const [first, second] = await concurrent(tool, [review("a"), review("b")]);
	assert.equal(first.isError, false, text(first));
	assert.equal(second.isError, true);
	assert.equal(second.details.round1[0].requested.model, SONNET);
	assert.equal(second.details.round1[0].failureClass, "infra");
	assert.equal(second.details.round1[0].infraRetries.length, 2);
	assert.equal(second.details.round1[0].provenance.length, 3);
	const all = launches(marker);
	assert.deepEqual(
		all.filter(([model]) => model === SONNET),
		[
			[SONNET, "low"],
			[SONNET, "low"],
			[SONNET, "low"],
		],
	);
	assert.deepEqual(
		all.filter(([model]) => model === OPUS),
		[[OPUS, "high"]],
		"only the first call's run launches OPUS",
	);

	process.env.FAKE_PI_MODE = "";
	writeFileSync(marker, "");
	const rebuttal = await run(tool, review("rebut", { runs: [{}, {}], rebuttal: true }));
	assert.equal(rebuttal.isError, false, text(rebuttal));
	const pair = [OPUS, SONNET];
	assert.deepEqual(
		rebuttal.details.round1.map((r) => r.requested.model),
		pair,
	);
	assert.deepEqual(
		rebuttal.details.round2.map((r) => r.requested.model),
		pair,
	);
});

test("other roles keep their pool's first entry under concurrency", async (t) => {
	const marker = scratch("alloc-roles-marker");
	const { tool } = setup(t, { config: TWO, env: { FAKE_PI_MARKER: marker } });
	for (const [role, first] of [
		["general", LUNA],
		["research", LUNA],
		["challenge", LUNA],
		["scout", HAIKU],
	]) {
		const pair = await concurrent(tool, [
			{ role, task: "a", web: false },
			{ role, task: "b", web: false },
		]);
		assert.deepEqual(
			pair.map((r) => [r.details.round1[0].requested.model, r.details.allocation[0].poolIndex]),
			[
				[first, 0],
				[first, 0],
			],
			role,
		);
		for (const r of pair) assert.doesNotMatch(text(r), SHARED_NOTE, role);
	}
	// A running review does not move a concurrent general call off the worker pool's first entry.
	const mixed = await concurrent(tool, [review("r"), { role: "general", task: "g" }]);
	assert.deepEqual(
		mixed.map((r) => r.details.round1[0].requested.model),
		[OPUS, LUNA],
	);
});
