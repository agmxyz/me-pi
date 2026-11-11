import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runToolCall } from "@earendil-works/pi-agent-core";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { trackCheck } from "../packages/pi-workers/extensions/delegate-implement.ts";
import {
	CHECK,
	commandCtx,
	implement,
	implementEnv,
	implementRepo,
	LUNA,
	POOL_SET,
	run,
	scratch,
	setup,
	snapshotContent,
	TEST_HOME,
	text,
	trackIntervals,
	tuiCtx,
	waitFor,
} from "./helpers/delegate-harness.ts";

test(
	"implement background prepare hands off without a ghost widget row or worker slot",
	{ timeout: 10000 },
	async (t) => {
		const { tool, commands, messages } = setup(t, { env: implementEnv("implement-commit") });
		const intervals = trackIntervals(t);
		const ui = tuiCtx();
		const { repo } = implementRepo();
		const jobCtx = { ...ui.ctx, cwd: repo, isProjectTrusted: () => false };
		const started = await run(tool, implement({ background: true }), undefined, undefined, jobCtx);
		assert.match(text(started), /^Started background job bg1 /);
		await waitFor(() => messages.length === 1, "the successful implement handback");
		assert.deepEqual(ui.widget(), [], "completion removes the temporary prepare row");
		assert.equal(intervals.size, 0, "completion stops the elapsed timer");
		const { ctx: command, notes } = commandCtx();
		await commands.delegate.handler("status", command);
		assert.match(notes.at(-1)[0], /Running: none/);

		process.env.FAKE_PI_MODE = "hang";
		const fourWorkers = await run(
			tool,
			{ role: "scout", task: "fill the worker limit", runs: [{}, {}, {}, {}], background: true },
			undefined,
			undefined,
			jobCtx,
		);
		assert.match(text(fourWorkers), /^Started background job bg2 /, "the completed prepare slot is not counted");
		await commands.delegate.handler("cancel bg2", command);
		await waitFor(() => messages.length === 2, "the cancelled capacity-check job");
	},
);

test("exported Pi createBashTool and runToolCall report canonical nonzero and successful results", async () => {
	const cwd = mkdtempSync(join(TEST_HOME, "direct-bash-tool-"));
	const bash = createBashTool(cwd, { exposeSessionEnvironment: false });
	const assistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "fixture",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	const context = { messages: [], tools: [bash] };
	const call = (id, command) =>
		runToolCall(
			{ type: "toolCall", id, name: "bash", arguments: { command } },
			{ tools: [bash], assistantMessage, context },
		);
	const failed = await call("direct-failure", "printf 'side-effect\\n' > failed.txt; exit 7");
	assert.equal(failed.isError, true);
	assert.equal(failed.result.structuredContent.exit_code, 7);
	assert.equal(readFileSync(join(cwd, "failed.txt"), "utf8"), "side-effect\n");
	const succeeded = await call("direct-success", "printf 'verified\\n' > passed.txt");
	assert.equal(succeeded.isError, false);
	assert.equal(succeeded.result.structuredContent.exit_code, 0);
	assert.equal(readFileSync(join(cwd, "passed.txt"), "utf8"), "verified\n");
});

test("implement commits on the current branch; the result is a 2-line handback and a 0600 details file", async (t) => {
	const { tool, commands } = setup(t, { env: implementEnv("implement-commit") });
	const { git, lock, ctx } = implementRepo();
	const head = git("rev-parse", "HEAD");
	const updates = [];
	const res = await run(tool, implement(), undefined, (u) => updates.push(u), ctx);
	const out = text(res);
	assert.equal(res.isError, false, out);
	const tip = git("rev-parse", "HEAD");
	const lines = out.split("\n");
	assert.equal(lines.length, 2, out);
	assert.match(
		lines[0],
		new RegExp(
			`^✓ im\\d+ goal/x ${head.slice(0, 7)}\\.\\.${tip.slice(0, 7)}: 1 commit, 1 file \\+1 -0; check ✓ \`npm test\` \\[.+\\]$`,
		),
	);
	const detailsPath = lines[1].match(/^Added feature\.txt\. Details: (\S+)$/)[1];
	assert.equal(statSync(detailsPath).mode & 0o777, 0o600);
	assert.match(readFileSync(detailsPath, "utf8"), /IMPLEMENT-DIFF-BODY is in the details only/);
	assert.doesNotMatch(out, /IMPLEMENT-DIFF-BODY/);
	assert.equal(git("log", "-1", "--format=%s"), "feat: add feature");
	assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "goal/x");
	assert.equal(git("status", "--porcelain"), "");
	assert.ok(!existsSync(lock), "the lock is released");
	assert.match(updates[0].content[0].text, new RegExp(`^goal/x \\(im\\d+\\) from ${head.slice(0, 7)}`));
	assert.equal(res.details.implement.branch, "goal/x");
	assert.match(
		res.details.view.runs[0].output,
		/IMPLEMENT-DIFF-BODY is in the details only/,
		"the TUI keeps the answer",
	);
	const { ctx: cmd, notes } = commandCtx();
	await commands.delegate.handler("status", cmd);
	assert.match(
		notes[0][0],
		new RegExp(` implement .* goal/x ${head.slice(0, 7)}\\.\\.${tip.slice(0, 7)} check pass$`, "m"),
	);
	const id = res.details.implement.id;
	assert.equal(
		existsSync(join(TEST_HOME, `me-pi-delegate-${process.pid}`, `${id}-failed-tools.json`)),
		false,
		"successful tools do not create an artifact",
	);
});

test("implement event tracking keeps a fresh final check after over 100 calls and a mutation", async (t) => {
	const marker = scratch("implement-events");
	const { tool } = setup(t, {
		env: implementEnv("implement-commit", {
			FAKE_PI_TOOL_EVENTS: "101",
			FAKE_PI_EVENT_MARKER: marker,
		}),
	});
	const { git, ctx } = implementRepo();
	const result = await run(tool, implement(), undefined, undefined, ctx);
	const handback = text(result);

	assert.equal(result.isError, false, handback);
	assert.equal(result.details.implement.failed, false);
	assert.equal(result.details.implement.check.status, "pass");
	assert.deepEqual(result.details.implement.check.runs, ["pass: npm test"]);
	assert.match(handback, /check ✓/);
	assert.equal(git("show", "HEAD:feature.txt"), "IMPLEMENT-DIFF-BODY");
	assert.equal(git("log", "-1", "--format=%s"), "feat: add feature");
	assert.equal(git("status", "--porcelain"), "");

	const events = readFileSync(marker, "utf8").trim().split("\n");
	assert.deepEqual(events, [...Array(101).fill("read"), "write", "bash"]);
});

test("implement rejects lifetime call ID reuse through event finalization", async (t) => {
	const { tool } = setup(t, {
		env: implementEnv("implement-review-regression", { FAKE_PI_REVIEW_SCENARIO: "reuse" }),
	});
	const result = await run(tool, implement(), undefined, undefined, implementRepo().ctx);
	assert.equal(result.isError, true, text(result));
	assert.equal(result.details.implement.check.status, "pass");
	assert.equal(result.details.implement.outcome.provenance[0].complete, false);
	assert.match(
		readFileSync(result.details.implement.detailsPath, "utf8"),
		/tool=reused cause=tool-failure resource=tool effect=unknown/,
	);
});

test("implement rejects a duplicate END after a completed call while retaining correlation diagnostics", async (t) => {
	const { tool } = setup(t, {
		env: implementEnv("implement-review-regression", { FAKE_PI_REVIEW_SCENARIO: "duplicate-end" }),
	});
	const result = await run(tool, implement(), undefined, undefined, implementRepo().ctx);
	assert.equal(result.isError, true, text(result));
	const facts = result.details.implement;
	assert.equal(facts.check.status, "pass");
	assert.equal(facts.delivered.commit, "normal");
	assert.equal(facts.delivered.wip, false);
	assert.equal(facts.problems.includes("provenance/effect state is incomplete or stopped; acceptance withheld"), true);

	const provenance = facts.outcome.provenance[0];
	assert.equal(provenance.complete, false);
	const effects = provenance.toolEffects.filter((fact) => fact.toolCallId === "call-completed");
	assert.deepEqual(
		effects.map((fact) => [fact.toolName, fact.effect, fact.replaySafe]),
		[
			["bash", "completed", false],
			["bash", "unknown", false],
		],
		"the completed call and its duplicate end stay separately attributed",
	);
	const stop = provenance.stopFacts.find(
		(fact) => fact.toolCallId === "call-completed" && fact.cause === "tool-failure",
	);
	assert.equal(stop.owner, "delegate-parent");
	assert.equal(stop.effect, "unknown");
	assert.equal(
		provenance.toolEffects.find((fact) => fact.toolCallId === "call-unique").effect,
		"completed",
		"unique call IDs still complete normally",
	);

	const artifact = JSON.parse(readFileSync(facts.outcome.failedToolCapture.path, "utf8"));
	assert.equal(artifact.capture.failureCount, 1);
	assert.equal(artifact.entries.length, 1);
	assert.equal(artifact.entries[0].toolCallId.text, "call-completed");
	assert.equal(artifact.entries[0].startedAt, null, "the duplicate end has no matching start");
	assert.ok(artifact.entries[0].missingFields.includes("startedAt"));
	assert.ok(artifact.capture.anomalies["end-without-start"] >= 1);
	const details = readFileSync(facts.detailsPath, "utf8");
	assert.match(details, /tool=call-completed cause=tool-failure resource=tool effect=unknown/);
});

test("implement rejects a competing provider retry after ordinary Bash repair", async (t) => {
	const { tool } = setup(t, {
		config: POOL_SET,
		env: implementEnv("implement-review-regression", { FAKE_PI_REVIEW_SCENARIO: "provider" }),
	});
	const result = await run(tool, implement(), undefined, undefined, implementRepo().ctx);
	assert.equal(result.isError, true, text(result));
	assert.equal(result.details.implement.check.status, "pass");
	assert.equal(result.details.implement.delivered.commit, "normal");
	const facts = result.details.implement.outcome.provenance[0].stopFacts;
	assert.ok(facts.some((fact) => fact.cause === "tool-failure" && fact.effect === "completed"));
	assert.ok(facts.some((fact) => fact.cause === "provider-retry-classified" && fact.effect === "unknown"));
});

test("implement rejects conflicting Bash status aliases through event finalization", async (t) => {
	for (const scenario of ["conflict", "check-conflict"])
		await t.test(scenario, async (t) => {
			const { tool } = setup(t, {
				env: implementEnv("implement-review-regression", { FAKE_PI_REVIEW_SCENARIO: scenario }),
			});
			const result = await run(tool, implement(), undefined, undefined, implementRepo().ctx);
			assert.equal(result.isError, true, `${scenario}: ${text(result)}`);
			if (scenario === "conflict") {
				assert.equal(result.details.implement.check.status, "pass");
				const artifact = JSON.parse(readFileSync(result.details.implement.outcome.failedToolCapture.path, "utf8"));
				assert.match(JSON.stringify(artifact.entries[0]), /143/);
			} else assert.notEqual(result.details.implement.check.status, "pass");
		});
});

test("invalid Bash alias diagnostics retain their path, type and value", async (t) => {
	const { tool } = setup(t, {
		env: implementEnv("implement-review-regression", { FAKE_PI_REVIEW_SCENARIO: "invalid-alias" }),
	});
	const result = await run(tool, implement(), undefined, undefined, implementRepo().ctx);
	assert.equal(result.isError, true, text(result));
	const artifact = JSON.parse(readFileSync(result.details.implement.outcome.failedToolCapture.path, "utf8"));
	const diagnostics = artifact.entries[0].statusDiagnostics.map((item) => item.text).join(" ");
	assert.match(diagnostics, /structuredContent.exit_code=7/);
	assert.match(diagnostics, /details.exitCode=string:143/);
});

test("status diagnostics redact arbitrary strings and bound success records", async (t) => {
	for (const scenario of ["invalid-secret", "success-overflow"])
		await t.test(scenario, async (t) => {
			const { tool } = setup(t, {
				env: implementEnv("implement-review-regression", { FAKE_PI_REVIEW_SCENARIO: scenario }),
			});
			const result = await run(tool, implement(), undefined, undefined, implementRepo().ctx);
			assert.equal(result.isError, true, text(result));
			const captured =
				scenario === "invalid-secret"
					? readFileSync(result.details.implement.outcome.failedToolCapture.path, "utf8")
					: readFileSync(result.details.implement.detailsPath, "utf8");
			assert.match(captured, /details.exitCode=string:\[REDACTED\]/);
			assert.doesNotMatch(captured, /synthetic-secret/);
			if (scenario === "success-overflow") {
				assert.equal((captured.match(/isError=false/g) ?? []).length, 20);
				assert.match(captured, /1 further status diagnostics omitted/);
			}
		});
});

test("success-marked conflicting Bash statuses survive finalization", async (t) => {
	for (const scenario of ["success-conflict", "check-success-conflict"])
		await t.test(scenario, async (t) => {
			const { tool } = setup(t, {
				env: implementEnv("implement-review-regression", { FAKE_PI_REVIEW_SCENARIO: scenario }),
			});
			const result = await run(tool, implement(), undefined, undefined, implementRepo().ctx);
			assert.equal(result.isError, true, text(result));
			assert.equal(result.details.implement.check.status === "pass", scenario === "success-conflict");
			assert.equal(result.details.implement.outcome.failedToolCapture, undefined);
			const details = readFileSync(result.details.implement.detailsPath, "utf8");
			assert.match(details, /isError=false/);
			assert.match(
				details,
				scenario === "success-conflict" ? /structuredContent.exit_code=7/ : /structuredContent.exit_code=0/,
			);
			assert.match(details, /details.exitCode=143/);
		});
});

test("multiple success-marked conflicting Bash calls retain bounded call identity in finalization", async (t) => {
	const { tool } = setup(t, {
		env: implementEnv("implement-review-regression", { FAKE_PI_REVIEW_SCENARIO: "success-multi" }),
	});
	const result = await run(tool, implement(), undefined, undefined, implementRepo().ctx);
	assert.equal(result.isError, true, text(result));
	const facts = result.details.implement;
	assert.equal(facts.check.status, "pass");
	assert.equal(facts.delivered.commit, "normal");
	assert.equal(facts.outcome.failedToolCapture, undefined, "successful conflicts do not create failed-tool artifacts");

	const details = readFileSync(facts.detailsPath, "utf8");
	const diagnostics = details.split("\n").filter((line) => line.includes("isError=false"));
	assert.equal(diagnostics.length, 3);
	const seven = diagnostics.find((line) => line.includes("toolCallId=call-seven"));
	const eight = diagnostics.find((line) => line.includes("toolCallId=call-eight"));
	const long = diagnostics.find((line) => /toolCallId=call-x{10}/.test(line));
	assert.ok(seven, details);
	assert.ok(eight, details);
	assert.ok(long, details);
	assert.match(seven, /structuredContent\.exit_code=7/);
	assert.match(eight, /structuredContent\.exit_code=8/);
	assert.match(long, /structuredContent\.exit_code=9/);
	assert.doesNotMatch(seven, /call-eight|exit_code=8/);
	assert.doesNotMatch(eight, /call-seven|exit_code=7/);
	const retainedCallId = long.match(/toolCallId=(\S+)/)[1];
	assert.equal(retainedCallId.length, 256, "call identity is bounded");
	assert.ok(`call-${"x".repeat(300)}`.startsWith(retainedCallId), "the bounded identity keeps the call ID prefix");

	const provenance = facts.outcome.provenance[0];
	for (const [toolCallId, exitCode] of [
		["call-seven", 7],
		["call-eight", 8],
		[`call-${"x".repeat(300)}`, 9],
	]) {
		const effect = provenance.toolEffects.find((fact) => fact.toolCallId === toolCallId);
		assert.equal(effect.effect, "unknown");
		const stop = provenance.stopFacts.find(
			(fact) => fact.toolCallId === toolCallId && fact.cause === "tool-failure" && fact.effect === "unknown",
		);
		assert.ok(stop, `call ${exitCode} keeps a correlated unknown stop fact`);
	}
});

test("bounded diagnostic call IDs mark byte truncation in contradictory success diagnostics", async (t) => {
	const { tool } = setup(t, {
		env: implementEnv("implement-review-regression", { FAKE_PI_REVIEW_SCENARIO: "success-multi" }),
	});
	const result = await run(tool, implement(), undefined, undefined, implementRepo().ctx);
	assert.equal(result.isError, true, text(result));
	const details = readFileSync(result.details.implement.detailsPath, "utf8");
	const diagnostics = details.split("\n").filter((line) => line.includes("isError=false"));
	const long = diagnostics.find((line) => line.includes("toolCallId=call-x"));
	assert.ok(long, details);
	assert.match(long, /^isError=false toolCallId=call-x{10}\S* \[truncated\] structuredContent\.exit_code=9$/);
	const short = diagnostics.find((line) => line.includes("toolCallId=call-seven"));
	assert.ok(short, details);
	assert.doesNotMatch(short, /\[truncated\]/);
});

test("a crashing child keeps its real stderr tail alongside contradictory success diagnostics", async (t) => {
	const { tool } = setup(t, {
		env: implementEnv("implement-review-regression", { FAKE_PI_REVIEW_SCENARIO: "success-crash" }),
	});
	const result = await run(tool, implement(), undefined, undefined, implementRepo().ctx);
	assert.equal(result.isError, true, text(result));
	const facts = result.details.implement;
	assert.ok(!facts.outcome.answer?.trim(), "the crashing child gave no final answer");
	assert.match(
		facts.outcome.failure,
		/^exit 3: boom: last stderr line/,
		"the reported failure uses the child's crash tail",
	);
	assert.doesNotMatch(
		facts.outcome.failure,
		/isError=false/,
		"an appended diagnostic does not replace the crash message",
	);
	assert.match(facts.outcome.stderr, /boom: last stderr line/);
	assert.match(facts.outcome.stderr, /contradictory Bash success status diagnostics/);
	assert.match(facts.outcome.stderr, /isError=false toolCallId=call-crash/);
	assert.match(facts.outcome.stderr, /structuredContent\.exit_code=7; details\.exitCode=143/);
});

test("implement check requires canonical status and accepts matching or absent aliases", async (t) => {
	for (const scenario of ["check-missing", "check-invalid", "check-match", "check-absent"])
		await t.test(scenario, async (t) => {
			const { tool } = setup(t, {
				env: implementEnv("implement-review-regression", { FAKE_PI_REVIEW_SCENARIO: scenario }),
			});
			const result = await run(tool, implement(), undefined, undefined, implementRepo().ctx);
			const valid = scenario === "check-match" || scenario === "check-absent";
			assert.equal(result.isError, !valid, text(result));
			assert.equal(result.details.implement.check.status === "pass", valid);
		});
});

test("implement accepts correlated completed Bash failures after repair, fresh check, and normal commit", async (t) => {
	const tmp = mkdtempSync(join(TEST_HOME, "agent-loop-job-"));
	const commands = [
		{ command: "printf 'broken\\n' > feature.txt && node verify.mjs" },
		{ command: "printf 'partial\\n' > partial.txt; exit 7" },
		{ command: "printf 'fixed\\n' > feature.txt && node verify.mjs" },
		{ command: "npm test" },
		{ command: "git add feature.txt partial.txt && git commit -m 'feat: repair feature'" },
	];
	const { tool } = setup(t, {
		env: implementEnv("implement-agent-loop", {
			TMPDIR: tmp,
			FAKE_PI_AGENT_COMMANDS: JSON.stringify(commands),
			FAKE_PI_AGENT_HOOK: "preserve-status",
		}),
	});
	const { repo, git, ctx } = implementRepo();
	const result = await run(tool, implement(), undefined, undefined, ctx);
	const handback = text(result);

	assert.equal(result.isError, false, handback);
	assert.equal(result.details.implement.failed, false);
	assert.deepEqual(result.details.implement.check.runs, ["pass: npm test"]);
	assert.equal(git("log", "-1", "--format=%s"), "feat: repair feature");
	assert.equal(git("show", "HEAD:feature.txt"), "fixed");
	assert.equal(git("show", "HEAD:partial.txt"), "partial");
	assert.equal(git("status", "--porcelain"), "");

	const provenance = result.details.implement.outcome.provenance[0];
	const failures = provenance.stopFacts.filter((fact) => fact.cause === "tool-failure");
	assert.equal(failures.length, 2);
	assert.ok(failures.every((fact) => fact.owner === "delegate-parent" && fact.effect === "completed"));
	for (const failure of failures) {
		const effect = provenance.toolEffects.find((fact) => fact.toolCallId === failure.toolCallId);
		assert.equal(effect.toolName, "bash");
		assert.equal(effect.effect, "completed");
		assert.equal(effect.replaySafe, false);
	}
	assert.equal(provenance.complete, true);

	const capture = JSON.parse(readFileSync(result.details.implement.outcome.failedToolCapture.path, "utf8"));
	assert.deepEqual(
		capture.entries.map((entry) => entry.exitCode.value),
		[1, 7],
	);
	assert.equal(capture.entries[0].command.rawArgsCommand.value.text, commands[0].command);
	assert.equal(capture.entries[1].command.rawArgsCommand.value.text, commands[1].command);
	assert.match(handback, /check ✓ `npm test`/);
	assert.ok(existsSync(repo));
});

test("signal and timeout Bash failures remain unresolved after a fresh check and commit", async (t) => {
	for (const [scenario, command, expectedExit] of [
		["signal", "kill -TERM $$", 143],
		["timeout", "sleep 2", undefined],
	]) {
		const tmp = mkdtempSync(join(TEST_HOME, "agent-loop-job-"));
		const commands = [
			{ command: "printf 'fixed\\n' > feature.txt" },
			{ command, ...(scenario === "timeout" && { timeout: 0.05 }) },
			{ command: "npm test" },
			{ command: "git add feature.txt && git commit -m 'feat: interrupted command fixture'" },
		];
		const { tool } = setup(t, {
			env: implementEnv("implement-agent-loop", { TMPDIR: tmp, FAKE_PI_AGENT_COMMANDS: JSON.stringify(commands) }),
		});
		const result = await run(tool, implement(), undefined, undefined, implementRepo().ctx);
		assert.equal(result.isError, true, `${scenario}: ${text(result)}`);
		assert.equal(result.details.implement.check.status, "pass");
		assert.match(text(result), /acceptance withheld/);
		const provenance = result.details.implement.outcome.provenance[0];
		assert.equal(provenance.toolEffects[1].effect, "unknown", scenario);
		assert.equal(provenance.stopFacts[0].cause, "tool-failure", scenario);
		assert.equal(provenance.stopFacts[0].effect, "unknown", scenario);
		if (expectedExit !== undefined) {
			assert.equal(provenance.toolEffects[1].replaySafe, false);
			const artifact = JSON.parse(readFileSync(result.details.implement.outcome.failedToolCapture.path, "utf8"));
			assert.equal(artifact.entries[0].exitCode.value, expectedExit);
		} else {
			assert.equal(result.details.implement.outcome.failedToolCapture.path !== undefined, true);
			const artifact = JSON.parse(readFileSync(result.details.implement.outcome.failedToolCapture.path, "utf8"));
			assert.equal(artifact.entries[0].exitCode.state, "not-provided");
		}
	}
});

test("implement repairs a failed declared check and preserves its history through commit", async (t) => {
	const tmp = mkdtempSync(join(TEST_HOME, "agent-loop-job-"));
	const commands = [
		{ command: "printf 'broken\\n' > feature.txt" },
		{ command: "npm test" },
		{ command: "printf 'fixed\\n' > feature.txt" },
		{ command: "npm test" },
		{ command: "git add feature.txt && git commit -m 'feat: repair declared check'" },
	];
	const { tool } = setup(t, {
		env: implementEnv("implement-agent-loop", { TMPDIR: tmp, FAKE_PI_AGENT_COMMANDS: JSON.stringify(commands) }),
	});
	const { git, ctx } = implementRepo();
	const result = await run(tool, implement(), undefined, undefined, ctx);
	assert.equal(result.isError, false, text(result));
	assert.equal(result.details.implement.check.status, "pass");
	assert.deepEqual(result.details.implement.check.runs, ["fail: npm test", "pass: npm test"]);
	assert.equal(git("log", "-1", "--format=%s"), "feat: repair declared check");
	const artifact = JSON.parse(readFileSync(result.details.implement.outcome.failedToolCapture.path, "utf8"));
	assert.equal(artifact.entries.length, 1);
	assert.equal(artifact.entries[0].exitCode.value, 1);
	assert.equal(artifact.entries[0].command.rawArgsCommand.value.text, "npm test");
	assert.equal(result.details.implement.outcome.provenance[0].stopFacts[0].effect, "completed");
});

test("dropped and contradictory Bash status metadata cannot become accepted via a fresh green check", async (t) => {
	for (const [hook, command, expectedExit, expectedComplete, captureFailure] of [
		["drop-structured", "printf 'fixed\\n' > feature.txt; exit 7", undefined, true, true],
		["contradict-success", "printf 'fixed\\n' > feature.txt; exit 7", 7, false, false],
		["contradict-error", "printf 'fixed\\n' > feature.txt", 0, true, true],
	]) {
		const tmp = mkdtempSync(join(TEST_HOME, "agent-loop-job-"));
		const commands = [
			{ command },
			{ command: "npm test" },
			{ command: "git add feature.txt && git commit -m 'feat: hook metadata fixture'" },
		];
		const { tool } = setup(t, {
			env: implementEnv("implement-agent-loop", {
				TMPDIR: tmp,
				FAKE_PI_AGENT_COMMANDS: JSON.stringify(commands),
				FAKE_PI_AGENT_HOOK: hook,
			}),
		});
		const result = await run(tool, implement(), undefined, undefined, implementRepo().ctx);
		assert.equal(result.isError, true, `${hook}: ${text(result)}`);
		assert.equal(result.details.implement.check.status, "pass");
		assert.match(text(result), /acceptance withheld/);
		const provenance = result.details.implement.outcome.provenance[0];
		assert.equal(provenance.complete, expectedComplete);
		assert.equal(provenance.toolEffects[0].effect, "unknown");
		assert.ok(provenance.stopFacts.some((fact) => fact.cause === "tool-failure" && fact.effect === "unknown"));
		if (captureFailure) {
			const artifact = JSON.parse(readFileSync(result.details.implement.outcome.failedToolCapture.path, "utf8"));
			if (expectedExit === undefined) assert.equal(artifact.entries[0].exitCode.state, "not-provided");
			else assert.equal(artifact.entries[0].exitCode.value, expectedExit);
		} else {
			assert.equal(result.details.implement.outcome.failedToolCapture, undefined);
			const details = readFileSync(result.details.implement.detailsPath, "utf8");
			assert.match(details, /isError=false toolCallId=\S+ structuredContent\.exit_code=7/);
		}
	}
});

test("implement captures targeted failures while a later declared check passes", async (t) => {
	const tmp = mkdtempSync(join(TEST_HOME, "artifact-job-"));
	const reference = scratch("referenced-output");
	writeFileSync(reference, "DO NOT COPY THIS REFERENCED FILE");
	const { tool } = setup(t, {
		env: implementEnv("implement-artifacts", {
			TMPDIR: tmp,
			FAKE_PI_REF: reference,
		}),
	});
	const { ctx } = implementRepo();
	const result = await run(tool, implement(), undefined, undefined, ctx);
	assert.equal(result.isError, true, text(result));
	assert.equal(result.details.implement.failed, true);
	assert.equal(result.details.implement.check.status, "pass");
	assert.deepEqual(result.details.implement.check.runs, ["pass: npm test"]);
	assert.match(text(result), /acceptance withheld/);

	const capture = result.details.implement.outcome.failedToolCapture;
	assert.equal(capture.status, "written");
	const artifactPath = capture.path;
	assert.equal(statSync(join(tmp, `me-pi-delegate-${process.pid}`)).mode & 0o777, 0o700);
	assert.equal(statSync(artifactPath).mode & 0o777, 0o600);
	const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
	assert.equal(artifact.capture.failureCount, 1);
	assert.equal(artifact.entries.length, 1, "successful declared check and read calls are omitted");
	const [entry] = artifact.entries;
	assert.equal(entry.attempt.index, 1);
	assert.equal(entry.toolName.text, "bash");
	assert.equal(
		entry.command.rawArgsCommand.value.text,
		'export GITHUB_TOKEN="[REDACTED]" AWS_SECRET_ACCESS_KEY="[REDACTED]" npm run targeted-test',
	);
	assert.equal(
		entry.command.effectiveCommand.value.text,
		'GITHUB_TOKEN=[REDACTED] AWS_SECRET_ACCESS_KEY="[REDACTED]" rtk npm run targeted-test',
	);
	assert.deepEqual(
		entry.exitCode,
		{ state: "not-provided", value: null },
		"an alias-only exit code (details.exitCode without canonical structuredContent.exit_code) is recorded as not provided",
	);
	assert.match(entry.output.value.text, /GITHUB_TOKEN=\[REDACTED\]/);
	assert.match(entry.output.value.text, /AWS_SECRET_ACCESS_KEY="\[REDACTED\]"/);
	assert.equal(entry.error.value.text, 'AWS_SECRET_ACCESS_KEY="[REDACTED]"');
	assert.equal(entry.references.items[0].value.text, reference);
	assert.equal(entry.references.items[0].kind, "full-output-path");
	assert.equal(entry.references.fullOutputPathState, "provided");
	assert.ok(entry.missingFields.includes("result.childDiagnostics"));
	assert.ok(entry.missingFields.includes("result.childDiagnosticReferences"));
	assert.ok(artifact.redaction.includes("not guaranteed complete"));
	assert.equal(readFileSync(reference, "utf8"), "DO NOT COPY THIS REFERENCED FILE");
	const serialized = JSON.stringify(artifact);
	for (const secret of [
		"command-fake-secret",
		"command-aws-secret",
		"effective-fake-secret",
		"effective-aws-secret",
		"target-secret",
		"target-aws-secret",
		"error-fake-secret",
		"answer-fake-secret",
		"DO NOT COPY THIS REFERENCED FILE",
	])
		assert.equal(serialized.includes(secret), false, `artifact excludes ${secret}`);
	const details = readFileSync(result.details.implement.detailsPath, "utf8");
	assert.ok(details.includes(artifactPath));
	assert.match(details, /Redaction: explicit-patterns-v1; not guaranteed complete/);
	assert.doesNotMatch(
		`${details}\n${text(result)}`,
		/(?:command|effective|target|error|answer)-fake-secret|(?:command|effective|target)-aws-secret|target-secret/,
	);
});

test("implement captures failed declared checks and non-Bash tools with missing metadata", async (t) => {
	for (const mode of ["implement-check-artifact-fail", "implement-read-artifact-fail"]) {
		const tmp = mkdtempSync(join(TEST_HOME, "artifact-job-"));
		const { tool } = setup(t, { env: implementEnv(mode, { TMPDIR: tmp }) });
		const result = await run(tool, implement(), undefined, undefined, implementRepo().ctx);
		assert.equal(result.isError, true, text(result));
		const artifact = JSON.parse(readFileSync(result.details.implement.outcome.failedToolCapture.path, "utf8"));
		assert.equal(artifact.entries.length, 1);
		const [entry] = artifact.entries;
		if (mode === "implement-check-artifact-fail") {
			assert.equal(result.details.implement.check.status, "fail");
			assert.equal(entry.disposition, "nonzero-exit");
			assert.equal(entry.toolName.text, "bash");
			assert.equal(entry.exitCode.value, 1);
			assert.match(text(result), /^✗ im\d+ /);
			assert.match(text(result), /^Failed-tool diagnostics:/m);
		} else {
			assert.equal(result.details.implement.check.status, "none");
			assert.equal(entry.toolName.text, "read");
			assert.equal(entry.command, null);
			assert.equal(entry.exitCode.state, "not-provided");
			assert.ok(entry.missingFields.includes("result.exitCode"));
			assert.match(entry.resultSummary.value.text, /missing fixture/);
			assert.equal(JSON.stringify(entry).includes("do-not-capture-input"), false);
		}
	}
});

test("provider failures without tool failures do not create diagnostic artifacts", async (t) => {
	const tmp = mkdtempSync(join(TEST_HOME, "artifact-job-"));
	const { tool } = setup(t, {
		config: POOL_SET,
		env: implementEnv("rate-limit-model", { TMPDIR: tmp, FAKE_PI_FAIL_MODEL: LUNA }),
	});
	const result = await run(tool, implement(), undefined, undefined, implementRepo().ctx);
	assert.equal(result.isError, true, text(result));
	assert.equal(result.details.implement.check.status, "none");
	assert.equal(result.details.implement.outcome.failedToolCapture, undefined);
	assert.equal(
		existsSync(join(tmp, `me-pi-delegate-${process.pid}`, `${result.details.implement.id}-failed-tools.json`)),
		false,
	);
});

test("implement preserves evidence of a completed non-replay-safe Bash failure", async (t) => {
	const tmp = mkdtempSync(join(TEST_HOME, "artifact-job-"));
	const { tool } = setup(t, {
		config: POOL_SET,
		env: implementEnv("implement-fallback-artifacts", { TMPDIR: tmp }),
	});
	const result = await run(tool, implement(), undefined, undefined, implementRepo().ctx);
	assert.equal(result.isError, true, text(result));
	assert.equal(result.details.implement.check.status, "fail");
	const provenance = result.details.round1[0].provenance[0];
	assert.ok(provenance.stopFacts.some((fact) => fact.cause === "tool-failure" && fact.effect === "completed"));
	assert.equal(provenance.toolEffects[0].effect, "completed");
	assert.equal(provenance.toolEffects[0].replaySafe, false);
	assert.equal(provenance.providerRetry.owner, "pi-runtime");
	const artifact = JSON.parse(readFileSync(result.details.implement.outcome.failedToolCapture.path, "utf8"));
	assert.equal(artifact.entries.length, 1);
	assert.deepEqual(
		artifact.entries.map((entry) => [entry.attempt.index, entry.attempt.requestedModel.text]),
		[[1, LUNA]],
	);
	assert.equal(artifact.entries[0].exitCode.value, 3);
	assert.equal(artifact.entries[0].command.effectiveCommand.state, "not-provided");
	assert.equal(artifact.entries[0].command.effectiveCommand.value, null);
	assert.deepEqual(
		artifact.entries.map((entry) => entry.toolName.text),
		["bash"],
	);
});

test("implement cancellation flushes failures and reports correlation anomalies", async (t) => {
	const tmp = mkdtempSync(join(TEST_HOME, "artifact-job-"));
	const ready = scratch("artifact-worker-ready");
	const { tool } = setup(t, {
		env: implementEnv("implement-artifact-anomalies", { TMPDIR: tmp, FAKE_PI_READY: ready }),
	});
	const controller = new AbortController();
	const pending = run(tool, implement(), controller.signal, undefined, implementRepo().ctx);
	await waitFor(() => existsSync(ready), "the worker's failed tool events");
	controller.abort();
	const result = await pending;
	assert.equal(result.isError, true);
	const artifact = JSON.parse(readFileSync(result.details.implement.outcome.failedToolCapture.path, "utf8"));
	assert.equal(artifact.entries.length, 2);
	assert.equal(artifact.entries[0].command.rawArgsCommand.value.text, "first duplicate command");
	assert.equal(artifact.entries[1].startedAt, null, "an end without a matching start stays unattributed");
	assert.ok(artifact.entries[1].missingFields.includes("toolCallId"));
	assert.ok(artifact.entries[1].missingFields.includes("startedAt"));
	assert.equal(artifact.capture.failureCount, 2, "only observed failed end events count as failures");
	assert.equal(artifact.capture.unmatchedStartCount, 2);
	assert.equal(artifact.capture.recordedUnmatchedStartCount, 2);
	assert.equal(artifact.unmatchedStarts[0].state, "end-not-observed");
	assert.equal(artifact.unmatchedStarts[0].attempt.index, 1);
	assert.ok(artifact.unmatchedStarts[0].attempt.requestedModel.text);
	assert.ok(Number.isFinite(Date.parse(artifact.unmatchedStarts[0].startedAt)));
	assert.equal(artifact.unmatchedStarts[0].toolName.text, "bash");
	assert.equal(artifact.unmatchedStarts[0].toolCallId.text, "duplicate");
	assert.equal(artifact.unmatchedStarts[0].command.rawArgsCommand.value.text, "second duplicate command");
	assert.equal(artifact.unmatchedStarts[0].isError, null);
	assert.equal(artifact.unmatchedStarts[0].exitCode.value, null);
	assert.equal(artifact.capture.anomalies["duplicate-tool-call-id"], 1);
	assert.ok(artifact.capture.anomalies["end-without-start"] >= 1);
	assert.ok(artifact.capture.anomalies["start-without-end"] >= 2);
	assert.ok(artifact.capture.anomalies["malformed-event"] >= 1);
});

test("capture storage failure is visible while unknown effects still withhold acceptance", async (t) => {
	const tmp = mkdtempSync(join(TEST_HOME, "artifact-job-"));
	const { tool } = setup(t, {
		env: implementEnv("implement-artifacts", { TMPDIR: tmp, FAKE_PI_BLOCK_ARTIFACT: "1" }),
	});
	const result = await run(tool, implement(), undefined, undefined, implementRepo().ctx);
	assert.equal(result.isError, true, text(result));
	assert.equal(result.details.implement.failed, true);
	assert.equal(result.details.implement.check.status, "pass");
	assert.match(text(result), /⚠ capture unavailable:/);
	assert.match(text(result), /acceptance withheld/);
	const details = readFileSync(result.details.implement.detailsPath, "utf8");
	assert.match(details, /capture unavailable:/);
	const id = result.details.implement.id;
	assert.equal(
		readFileSync(join(tmp, `me-pi-delegate-${process.pid}`, `${id}-failed-tools.json`), "utf8"),
		"do not overwrite",
	);
});

test("read-only workers do not create failed-tool artifacts", async (t) => {
	const tmp = mkdtempSync(join(TEST_HOME, "artifact-job-"));
	const directory = join(tmp, `me-pi-delegate-${process.pid}`);
	const before = existsSync(directory)
		? readdirSync(directory).filter((name) => name.endsWith("-failed-tools.json"))
		: [];
	const { tool } = setup(t, { env: { FAKE_PI_MODE: "implement-read-artifact-fail", TMPDIR: tmp } });
	const result = await run(tool, { role: "scout", task: "read a fixture" });
	assert.equal(result.isError, false, text(result));
	assert.equal(result.details.round1[0].failedToolCapture, undefined);
	const after = existsSync(directory)
		? readdirSync(directory).filter((name) => name.endsWith("-failed-tools.json"))
		: [];
	assert.deepEqual(after, before);
});

test("implement: work left uncommitted becomes a WIP commit on the branch and an error", async (t) => {
	const { tool } = setup(t, { env: implementEnv("implement-dirty") });
	const { git, ctx } = implementRepo();
	const res = await run(tool, implement(), undefined, undefined, ctx);
	assert.equal(res.isError, true);
	const id = text(res).match(/^✗ (im\d+) /)[1];
	assert.equal(git("log", "-1", "--format=%s"), `WIP(delegate ${id}): left uncommitted by the worker`);
	assert.match(text(res), /^✗ WIP \w+ on goal\/x \(left uncommitted by the worker\): left\.txt$/m);
	assert.deepEqual(res.details.implement.delivered, {
		check: "pass",
		commit: "none",
		wip: true,
		integrity: "clear",
	});
	assert.equal(git("status", "--porcelain"), "");
});

test("implement Bash content freshness ignores Git metadata but stales mutations until a passing rerun", async (t) => {
	for (const [scenario, expectedStatus, expectedContent] of [
		["unchanged", "pass", "fixed\n"],
		["stale", "stale", "mutated\n"],
		["rerun", "pass", "mutated\n"],
	]) {
		const { tool } = setup(t, {
			env: implementEnv("implement-content-check", { FAKE_PI_CONTENT_SCENARIO: scenario }),
		});
		const { repo, git, ctx } = implementRepo();
		const result = await run(tool, implement(), undefined, undefined, ctx);
		const handback = text(result);
		assert.equal(result.details.implement.check.status, expectedStatus, scenario);
		assert.equal(result.details.implement.delivered.check, expectedStatus, scenario);
		assert.equal(
			execFileSync("git", ["-C", repo, "show", "HEAD:feature.txt"], { encoding: "utf8" }),
			expectedContent,
			scenario,
		);
		assert.equal(git("status", "--porcelain"), "", scenario);
		if (expectedStatus === "stale") {
			assert.equal(result.isError, true, handback);
			assert.match(handback, /check stale \(checkout content changed after the last check\)/);
			assert.match(handback, /^✗ check stale: checkout content changed after the last check$/m);
		} else if (scenario === "rerun") {
			assert.equal(result.isError, false, handback);
			assert.match(handback, /check ✓/);
			assert.doesNotMatch(handback, /acceptance withheld/);
			const provenance = result.details.implement.outcome.provenance[0];
			assert.ok(provenance.stopFacts.some((fact) => fact.cause === "tool-failure" && fact.effect === "completed"));
		} else {
			assert.equal(result.isError, false, handback);
			assert.match(handback, /check ✓/);
		}
		if (scenario === "rerun")
			assert.deepEqual(result.details.implement.check.runs, ["pass: npm test", "pass: npm test"]);
	}
});

test("implement Bash binary-content collision stales a committed tree through the event path", async (t) => {
	const { tool } = setup(t, {
		env: implementEnv("implement-content-check", { FAKE_PI_CONTENT_SCENARIO: "binary-collision" }),
	});
	const { repo, git, ctx } = implementRepo();
	const result = await run(tool, implement(), undefined, undefined, ctx);
	const handback = text(result);

	assert.equal(result.details.implement.check.status, "stale", handback);
	assert.equal(result.details.implement.delivered.check, "stale", handback);
	assert.equal(result.isError, true, handback);
	assert.match(handback, /check stale \(checkout content changed after the last check\)/);
	assert.deepEqual(execFileSync("git", ["-C", repo, "show", "HEAD^:a"]), Buffer.from("x"));
	assert.deepEqual(execFileSync("git", ["-C", repo, "show", "HEAD^:b"]), Buffer.from("y"));
	assert.deepEqual(
		execFileSync("git", ["-C", repo, "show", "HEAD:a"]),
		Buffer.from("7800620066696c6500300079", "hex"),
	);
	assert.deepEqual(git("ls-tree", "-r", "--name-only", "HEAD").split("\n").sort(), [
		"a",
		"feature.txt",
		"package.json",
		"sub/a.txt",
		"verify.mjs",
	]);
	assert.equal(git("status", "--porcelain"), "");
});

test("implement check freshness fails closed when a passing check cannot be snapshotted", () => {
	const root = join(TEST_HOME, "missing-checkout");
	const job = { repoRoot: root, check: { command: CHECK, status: "none", runs: [] } };
	const calls = new Map([["check", { tool: "bash", command: CHECK }]]);
	trackCheck(
		job,
		calls,
		{ toolCallId: "check", isError: false, result: { structuredContent: { exit_code: 0 } } },
		root,
	);
	assert.equal(job.check.status, "stale");
	assert.match(job.check.staleReason, /could not be verified/);
	assert.match(job.check.runs[0], /content snapshot unavailable/);
	assert.throws(() => snapshotContent(root), /ENOENT/);
});

test("implement: a failed check, an edit after the check, or no check run is ✗", async (t) => {
	for (const [extra, line] of [
		[{ FAKE_PI_CHECK_FAIL: "1" }, "✗ check failed"],
		[
			{ FAKE_PI_EDIT_AFTER: "1", FAKE_PI_STALE_TOOL: "edit" },
			"✗ check stale: successful edit/write after the last check",
		],
		[
			{ FAKE_PI_EDIT_AFTER: "1", FAKE_PI_STALE_TOOL: "write" },
			"✗ check stale: successful edit/write after the last check",
		],
		[{ FAKE_PI_RAN: "" }, "✗ check not run"],
		[{ FAKE_PI_RAN: "npm test | tail" }, "✗ check not run"],
	]) {
		const clean = {
			FAKE_PI_CHECK_FAIL: undefined,
			FAKE_PI_EDIT_AFTER: undefined,
			FAKE_PI_STALE_TOOL: undefined,
			FAKE_PI_RAN: undefined,
		};
		const { tool } = setup(t, { env: implementEnv("implement-commit", { ...clean, ...extra }) });
		const { ctx } = implementRepo();
		const res = await run(tool, implement(), undefined, undefined, ctx);
		assert.equal(res.isError, true, JSON.stringify(extra));
		assert.ok(text(res).split("\n").includes(line), text(res));
	}
	const { tool } = setup(t, {
		env: implementEnv("implement-commit", {
			FAKE_PI_CHECK_FAIL: undefined,
			FAKE_PI_EDIT_AFTER: undefined,
			FAKE_PI_RAN: "rtk npm test 2>&1",
		}),
	});
	const res = await run(tool, implement(), undefined, undefined, implementRepo().ctx);
	assert.equal(res.isError, false, text(res));
});
