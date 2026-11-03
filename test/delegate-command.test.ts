import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	commandCtx,
	HAIKU,
	modelSet,
	OPUS,
	POOL_SET,
	pool,
	registryFixture,
	run,
	SONNET,
	setup,
	statusFor,
	UNAUTHENTICATED,
} from "./helpers/delegate-harness.ts";

test("/delegate status shows the stage and only active worker progress", async () => {
	const active = new Map([
		[
			"bg7",
			{
				role: "general",
				models: [HAIKU, OPUS],
				start: Date.now(),
				job: "bg7",
				stage: "Rebuttal",
				workers: [
					{
						index: 1,
						model: HAIKU,
						thinking: "low",
						startedAt: Date.now(),
						active: true,
						lastTool: "grep",
						task: "PRIVATE_TASK_MARKER",
						toolArguments: "PRIVATE_TOOL_ARGS_MARKER",
						result: "PRIVATE_RESULT_MARKER",
						reasoning: "PRIVATE_REASONING_MARKER",
					},
					{
						index: 2,
						model: OPUS,
						thinking: "max",
						startedAt: Date.now(),
						active: false,
						lastTool: "completed-only-marker",
					},
				],
			},
		],
	]);
	const output = await statusFor(active)();
	assert.match(output, /\nRunning \(1\):\n {2}bg7 general: claude-haiku-5-5, claude-opus-5-5 \d+s\n/);
	assert.match(output, /\n {4}Stage: Rebuttal\n {4}Worker 1: claude-haiku-5-5 @low \d+s · grep\n/);
	assert.doesNotMatch(output, /Worker 2:|completed-only-marker|PRIVATE_(?:TASK|TOOL_ARGS|RESULT|REASONING)_MARKER/);
	assert.match(output, /\nLast calls: none$/);
});

test("/delegate status omits a worker's latest tool when none is available", async () => {
	const active = new Map([
		[
			"bg8",
			{
				role: "general",
				models: [OPUS],
				start: Date.now(),
				stage: "Workers",
				workers: [{ index: 1, model: OPUS, thinking: "medium", startedAt: Date.now(), active: true }],
			},
		],
	]);
	const output = await statusFor(active)();
	assert.match(output, /\n {4}Worker: claude-opus-5-5 @medium \d+s\n/);
});

test("/delegate status keeps the existing running summary without worker metadata", async () => {
	const active = new Map([["bg9", { role: "scout", models: [HAIKU], start: Date.now(), job: "bg9" }]]);
	const output = await statusFor(active)();
	assert.match(output, /\nRunning \(1\):\n {2}bg9 scout: claude-haiku-5-5 \d+s\n/);
	assert.doesNotMatch(output, /\n {4}(?:Stage:|Worker(?: \d+)?:)/);
});

test("/delegate status keeps the existing running summary for stage-only calls", async () => {
	const active = new Map([
		["bg10", { role: "general", models: [OPUS], start: 1_000, job: "bg10", stage: "Rebuttal" }],
	]);
	const originalNow = Date.now;
	Date.now = () => 4_000;
	try {
		const output = await statusFor(active)();
		assert.match(output, /\nRunning \(1\):\n {2}bg10 general: claude-opus-5-5 3s\n/);
		assert.doesNotMatch(output, /\n {4}(?:Stage:|Worker(?: \d+)?:)/);
	} finally {
		Date.now = originalNow;
	}
});

test("/delegate status: the set with availability, missing tools, running and recent calls", async (t) => {
	assert.deepEqual(setup(t, { env: { ME_PI_RUN: "1" } }).commands, {}, "workers get no command");
	const main = setup(t, {
		config: {
			version: 3,
			scout: {
				thinking: "low",
				models: [
					{ model: HAIKU, thinking: "low" },
					{ model: OPUS, thinking: "off" },
				],
			},
			worker: {
				thinking: "max",
				models: [
					{ model: OPUS, thinking: "max" },
					{ model: HAIKU, thinking: "low" },
				],
			},
		},
	});
	assert.deepEqual(
		main.commands.delegate.getArgumentCompletions("").map((c) => c.value),
		["status", "models", "cancel"],
	);
	assert.deepEqual(
		main.commands.delegate.getArgumentCompletions("m").map((c) => c.value),
		["models"],
	);
	const status = async () => {
		const { ctx, notes } = commandCtx({ available: [HAIKU] });
		await main.commands.delegate.handler("", ctx);
		return notes[0][0];
	};
	const before = await status();
	assert.ok(before.includes(`Scout pool: 1. ${HAIKU} (low) ✓; 2. ${OPUS} (off) ✗ unknown model id`));
	assert.ok(before.includes(`Worker pool: 1. ${OPUS} (max) ✗ unknown model id; 2. ${HAIKU} (low) ✓`));
	assert.equal(before.includes("Review pool:"), false);
	assert.match(before, /\nTools: missing Skill \(this repo's extensions\/skill\.ts\), web_search \(pi-web-access\)/);
	assert.match(before, /\nRunning: none\nLast calls: none$/);

	await run(main.tool, { task: "x", runs: [{ model: HAIKU }] });
	const after = await status();
	assert.match(after, /\nRunning: none\n/, "a finished call leaves the running list");
	assert.match(after, /\nLast 1 calls, \$0\.0020:\n {2}\d\d:\d\d \u2713 general claude-haiku-5-5 \$0\.0020 \d+s$/);

	// A reloaded instance keeps the history.
	const reloaded = setup(t, { config: modelSet([HAIKU, OPUS]), keepHistory: true });
	const kept = commandCtx();
	await reloaded.commands.delegate.handler("", kept.ctx);
	assert.match(kept.notes[0][0], /\nLast 1 calls, \$0\.0020:/);

	const hanging = setup(t, { config: modelSet([HAIKU, OPUS]), env: { FAKE_PI_MODE: "hang" } });
	const controller = new AbortController();
	const pending = run(hanging.tool, { role: "general", task: "x" }, controller.signal);
	await new Promise((r) => setTimeout(r, 300));
	const { ctx, notes } = commandCtx();
	await hanging.commands.delegate.handler("status", ctx);
	assert.match(notes[0][0], /\nRunning \(1\):\n {2}general: claude-opus-5-5 \d+s\n/);
	controller.abort();
	await pending;

	const broken = setup(t, { config: { ...modelSet([HAIKU]), extra: 1 } });
	const bad = commandCtx();
	await broken.commands.delegate.handler("status", bad.ctx);
	assert.match(bad.notes[0][0], /\n {2}\u2717 delegate config .*: unknown key\(s\) extra/);
	await assert.rejects(
		broken.commands.delegate.handler("nope", bad.ctx),
		/^Error: Unknown \/delegate subcommand "nope"\. Use: status, models, cancel\.$/,
	);
});

test("/delegate status without a config names the main session model and thinking", async (t) => {
	const main = setup(t);
	const { ctx, notes } = commandCtx();
	await main.commands.delegate.handler("status", ctx);
	assert.ok(
		notes[0][0].includes("Scout pool: main session model (main session thinking, capped at low, no fallback models)"),
	);
	assert.ok(notes[0][0].includes("Worker pool: main session model (main session thinking, no fallback models)"));
});

test("/delegate status keeps the last 20 calls", async (t) => {
	const main = setup(t, { config: modelSet([HAIKU, OPUS]) });
	for (let i = 0; i < 21; i++) await run(main.tool, { task: "x", runs: [{ model: HAIKU }] });
	const { ctx, notes } = commandCtx();
	await main.commands.delegate.handler("", ctx);
	assert.match(notes[0][0], /\nLast 20 calls, \$0\.0400:\n/);
	assert.equal(notes[0][0].split("\n").filter((l) => l.includes("general claude-haiku")).length, 20);
});

test("/delegate models directs users to edit JSON manually without writing it", async (t) => {
	const main = setup(t, { config: POOL_SET });
	const path = process.env.ME_PI_DELEGATE_CONFIG;
	const original = readFileSync(path, "utf8");
	const { ctx, notes } = commandCtx();
	await main.commands.delegate.handler("models", ctx);
	assert.deepEqual(notes, [[`Edit ${path} to set ordered models and per-model thinking, then run /reload.`, "info"]]);
	assert.equal(readFileSync(path, "utf8"), original);
});

test("/delegate status tells logged-in-but-unavailable from not logged in", async (t) => {
	const main = setup(t, {
		config: { version: 3, scout: pool([HAIKU], "low"), worker: pool([UNAUTHENTICATED], "high") },
	});
	const { ctx, notes } = commandCtx({ catalog: [HAIKU, UNAUTHENTICATED], available: [HAIKU] });
	ctx.modelRegistry = registryFixture({
		catalog: [HAIKU, UNAUTHENTICATED],
		available: [HAIKU],
		authenticated: ["anthropic", "unauthed"],
	});
	await main.commands.delegate.handler("status", ctx);
	assert.ok(
		notes[0][0].includes(`1. ${UNAUTHENTICATED} (high) \u2717 not available (logged in to unauthed)`),
		notes[0][0],
	);
});

test("/delegate status without registry lookup marks each entry unchecked", async (t) => {
	const main = setup(t, { config: { version: 3, scout: pool([HAIKU], "low"), worker: pool([SONNET], "high") } });
	const { ctx, notes } = commandCtx();
	ctx.modelRegistry = {};
	await main.commands.delegate.handler("status", ctx);
	const cannot = "? cannot check (Pi's model registry lacks lookup)";
	assert.ok(notes[0][0].includes(`Scout pool: 1. ${HAIKU} (low) ${cannot}\n`), notes[0][0]);
	assert.ok(notes[0][0].includes(`Worker pool: 1. ${SONNET} (high) ${cannot}`), notes[0][0]);
});

test("/delegate status shows what each model ref resolves to", async (t) => {
	const OR = "openrouter/z-ai/glm-5.3-flash";
	const main = setup(t, {
		config: {
			version: 3,
			scout: { models: [{ model: HAIKU, thinking: "low" }] },
			worker: {
				models: [
					{ model: "z-ai/glm-5.3-flash", thinking: "high" },
					{ model: UNAUTHENTICATED, thinking: "high" },
					{ model: "shared-id", thinking: "high" },
					{ model: "missing/model", thinking: "high" },
				],
			},
		},
	});
	const { ctx, notes } = commandCtx({
		catalog: [HAIKU, OR, UNAUTHENTICATED, "anthropic/shared-id", "nvidia/shared-id"],
		available: [HAIKU, OR, "nvidia/shared-id"],
	});
	await main.commands.delegate.handler("status", ctx);
	assert.ok(notes[0][0].includes(`Scout pool: 1. ${HAIKU} (low) \u2713\n`), notes[0][0]);
	assert.ok(
		notes[0][0].includes(
			`Worker pool: 1. z-ai/glm-5.3-flash (high) \u2713 \u2192 ${OR}; ` +
				`2. ${UNAUTHENTICATED} (high) \u2717 not logged in (unauthed); ` +
				"3. shared-id (high) \u2717 ambiguous: anthropic/shared-id, nvidia/shared-id; write provider/id; " +
				"4. missing/model (high) \u2717 unknown model id",
		),
		notes[0][0],
	);
});
