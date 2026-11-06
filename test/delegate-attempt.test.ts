import assert from "node:assert/strict";
import test from "node:test";

const { createAttemptLedger, infraRetryable, mergeAttempts } = await import(
	"../packages/pi-goblins/extensions/delegate-attempt.ts"
);
const { TOOL_PROVENANCE_DETAIL_KEY } = await import("../packages/pi-goblins/extensions/delegate-provenance.ts");

// Array-fed ledger tests: synthetic Pi event records mirroring the fake-pi provenance modes in the harness.

const MODEL = "anthropic/claude-test";
const FAR = Date.now() + 3_600_000;
const BUDGET = { hardDeadline: FAR, hardCostCapUsd: 5, toolDeadline: FAR, toolCostCapUsd: 4, toolCalls: null };

const usage = (cost: number) => ({
	input: 10,
	output: 5,
	totalTokens: 15,
	cost: { input: cost / 2, output: cost / 2, total: cost },
});
const reply = (
	text: string,
	{ cost = 0.002, stopReason = "stop", errorMessage = undefined as string | undefined } = {},
) => ({
	type: "message_end",
	message: {
		role: "assistant",
		provider: "anthropic",
		model: "claude-test",
		api: "fake-api",
		usage: usage(cost),
		stopReason,
		errorMessage,
		content: [{ type: "text", text }],
	},
});
const start = (toolCallId: string, toolName: string, args: Record<string, unknown> = {}) => ({
	type: "tool_execution_start",
	toolCallId,
	toolName,
	args,
});
const end = (toolCallId: string, toolName: string, isError: boolean, result: Record<string, unknown>) => ({
	type: "tool_execution_end",
	toolCallId,
	toolName,
	isError,
	result,
});
const text = (value: string) => ({ content: [{ type: "text", text: value }] });

interface CollectorStub {
	records: any[];
	unmatched: any[];
	anomalies: string[];
}

function ledgerFor(
	events: unknown[],
	{
		role = "general",
		budget = BUDGET,
		implement = false,
		model = MODEL,
		exit = 0 as number | null,
	}: { role?: string; budget?: typeof BUDGET; implement?: boolean; model?: string; exit?: number | null } = {},
) {
	const collector: CollectorStub = { records: [], unmatched: [], anomalies: [] };
	const job: any = { role, web: false, output: false, jobId: "job-1" };
	if (implement)
		job.implement = {
			job: { check: { status: "none", command: "npm run check", runs: [] }, repoRoot: "/nonexistent" },
			trusted: false,
			pids: new Set<number>(),
			artifacts: {
				record: (input: any) => collector.records.push(input),
				recordUnmatchedStart: (input: any) => collector.unmatched.push(input),
				noteAnomaly: (kind: string) => collector.anomalies.push(kind),
			},
		};
	const progress: unknown[] = [];
	const kills: string[] = [];
	const ledger = createAttemptLedger({
		job,
		run: { model, thinking: "low" },
		cwd: "/work",
		outDir: undefined,
		budget,
		attemptIndex: 1,
		onProgress: (r) => progress.push(r),
	});
	ledger.attach(() => kills.push("kill"));
	for (const event of events) ledger.record(event);
	ledger.close();
	const result = ledger.settle(exit);
	return { result, provenance: ledger.provenance, collector, kills, progress };
}

test("ledger: a completed read is a replay-safe completed effect and the answer settles", () => {
	const { result, provenance } = ledgerFor([
		start("safe-read", "read", { path: "README.md" }),
		end("safe-read", "read", false, text("read completed")),
		reply("done"),
	]);
	assert.equal(result.failure, undefined);
	assert.equal(result.output, "done");
	assert.equal(result.toolCallCount, 1);
	assert.deepEqual(result.tools, ["read"]);
	assert.equal(provenance.complete, true);
	assert.deepEqual(
		provenance.toolEffects.map((f) => [f.toolCallId, f.effect, f.replaySafe]),
		[["safe-read", "completed", true]],
	);
	assert.deepEqual(provenance.stopFacts, []);
});

test("ledger: an edit rejected before writing is not-started, with an edit-rejected artifact", () => {
	const { provenance, collector } = ledgerFor(
		[
			start("edit-mismatch", "edit", { path: "a.ts" }),
			end("edit-mismatch", "edit", true, text("Could not find the exact text in a.ts")),
			reply("done"),
		],
		{ implement: true },
	);
	assert.deepEqual(
		provenance.toolEffects.map((f) => [f.effect, f.replaySafe]),
		[["not-started", false]],
	);
	assert.deepEqual(provenance.stopFacts, []);
	assert.equal(collector.records.length, 1);
	assert.equal(collector.records[0].toolCallId, "edit-mismatch");
	assert.equal(collector.records[0].disposition, "edit-rejected");
	assert.equal(collector.records[0].requestedModel, MODEL);
});

test("ledger: bash exit codes decide the effect; contradictory aliases leave it unknown", () => {
	const { provenance, result, collector } = ledgerFor(
		[
			start("exit-1", "bash", { command: "false" }),
			end("exit-1", "bash", true, { ...text("failed"), structuredContent: { exit_code: 1 } }),
			start("exit-0", "bash", { command: "true" }),
			end("exit-0", "bash", false, { ...text("ok"), structuredContent: { exit_code: 0 }, details: { exitCode: 0 } }),
			start("alias-mismatch", "bash", { command: "true" }),
			end("alias-mismatch", "bash", false, { ...text("ok"), structuredContent: { exit_code: 0 }, exitCode: 2 }),
			reply("done"),
		],
		{ implement: true },
	);
	assert.deepEqual(
		provenance.toolEffects.map((f) => [f.toolCallId, f.effect]),
		[
			["exit-1", "completed"],
			["exit-0", "completed"],
			["alias-mismatch", "unknown"],
		],
	);
	assert.equal(provenance.complete, false);
	assert.deepEqual(
		provenance.stopFacts.map((f) => [f.toolCallId, f.cause, f.effect]),
		[["exit-1", "tool-failure", "completed"]],
	);
	assert.equal(collector.records.length, 1);
	assert.equal(collector.records[0].disposition, "nonzero-exit");
	assert.equal(collector.records[0].rawArgsCommand, "false");
	assert.match(
		result.stderr,
		/contradictory Bash success status diagnostics:\nisError=false toolCallId=alias-mismatch/,
	);
});

test("ledger: a guard denial marker is retained as a denied owner fact", () => {
	const fact = {
		owner: "guard",
		jobId: "job-1",
		attempt: 1,
		toolCallId: "blocked-call",
		cause: "guard-denial",
		resource: "guard",
		effect: "denied",
	};
	const foreign = { ...fact, jobId: "other-job" };
	const { provenance } = ledgerFor([
		start("blocked-call", "bash", { command: "git push origin main" }),
		end("blocked-call", "bash", true, {
			...text("Blocked by guard"),
			details: { [TOOL_PROVENANCE_DETAIL_KEY]: [fact, foreign] },
		}),
		reply("done"),
	]);
	assert.deepEqual(provenance.stopFacts, [fact]);
	assert.equal(provenance.toolEffects[0].effect, "denied");
	assert.equal(provenance.complete, false, "a foreign owner fact marks the ledger incomplete");
});

test("ledger: auto_retry_start correlates with the requested model's provider error", () => {
	const events = [
		reply("", { stopReason: "error", errorMessage: "429 rate_limit_error: too many requests" }),
		{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1 },
	];
	const { result, provenance } = ledgerFor(events, { exit: 1 });
	assert.deepEqual(provenance.providerRetry, {
		owner: "pi-runtime",
		jobId: "job-1",
		attempt: 1,
		provider: "anthropic",
		model: "claude-test",
		api: "fake-api",
		sourceEvent: "auto_retry_start",
		retry: 1,
	});
	assert.deepEqual(
		provenance.stopFacts.map((f) => f.cause),
		["provider-retry-classified"],
	);
	assert.equal(provenance.complete, true);
	assert.equal(result.failureClass, "infra");
	assert.equal(infraRetryable(result), true);

	const mismatch = ledgerFor(events, { model: "openai/other", exit: 1 });
	assert.equal(mismatch.provenance.providerRetry, undefined);
	assert.equal(mismatch.provenance.complete, false);
	assert.equal(infraRetryable(mismatch.result), false);

	const malformed = ledgerFor([events[0], { type: "auto_retry_start", attempt: 0, maxAttempts: 3 }], { exit: 1 });
	assert.equal(malformed.provenance.providerRetry, undefined);
	assert.equal(malformed.provenance.complete, false);
});

test("ledger: reaching the hard cost cap on a continuing reply stops synchronously", () => {
	const budget = { ...BUDGET, hardCostCapUsd: 1, toolCostCapUsd: 0.8 };
	const { result, provenance, kills } = ledgerFor([reply("working", { cost: 1.5, stopReason: "toolUse" })], {
		budget,
		exit: null,
	});
	assert.deepEqual(kills, ["kill"]);
	assert.deepEqual(
		provenance.stopFacts.map((f) => [f.cause, f.resource]),
		[
			["wrap-up-limit", "tool-cost"],
			["hard-cost-limit", "hard-cost"],
		],
	);
	assert.equal(result.failure, "stopped: cost cap $1 reached");
	assert.equal(result.failureClass, "model/task");

	const final = ledgerFor([reply("answer", { cost: 1.5 })], { budget });
	assert.deepEqual(final.kills, [], "a final answer over the cap is kept");
	assert.equal(final.result.failure, undefined);
});

test("ledger: close flushes an unclosed call as an unknown effect and an unmatched start", () => {
	const { provenance, collector, result } = ledgerFor(
		[start("unfinished", "bash", { command: "printf maybe-effect" })],
		{ implement: true, exit: 1 },
	);
	assert.equal(provenance.complete, false);
	assert.deepEqual(
		provenance.toolEffects.map((f) => [f.toolCallId, f.effect, f.replaySafe]),
		[["unfinished", "unknown", false]],
	);
	assert.deepEqual(
		collector.unmatched.map((c) => [c.toolCallId, c.toolName, c.rawArgsCommand]),
		[["unfinished", "bash", "printf maybe-effect"]],
	);
	assert.equal(result.failure, "exit 1: no error message");
});

test("mergeAttempts keeps every attempt's provenance, usage, and earlier failure", () => {
	const first = ledgerFor(
		[
			reply("", { stopReason: "error", errorMessage: "temporary provider failure" }),
			{ type: "auto_retry_start", attempt: 1 },
		],
		{ exit: 1 },
	).result;
	const second = ledgerFor([reply("ok")]).result;
	const merged = mergeAttempts(first, second);
	assert.equal(merged.output, "ok");
	assert.deepEqual(merged.infraRetries, ["exit 1: temporary provider failure"]);
	assert.equal(merged.provenance?.length, 2);
	assert.equal(merged.turns, 2);
	assert.equal(merged.usage.cost.total, 0.004);
});
