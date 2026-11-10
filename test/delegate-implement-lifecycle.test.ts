import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	bgCtx,
	CHECK,
	CTX,
	classifyProviderError,
	commandCtx,
	implement,
	implementEnv,
	implementRepo,
	LIMITS,
	LUNA,
	OPUS,
	POOL_SET,
	run,
	scratch,
	setup,
	TEST_HOME,
	text,
	waitFor,
	workerStarted,
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

test("implement retries an infra failure without effects inside the same job, and not after a Bash effect", async (t) => {
	const counter = () => join(mkdtempSync(join(TEST_HOME, "infra-")), "runs");
	const { tool } = setup(t, {
		env: implementEnv("infra-flaky", {
			FAKE_PI_INFRA_FAILS: "1",
			FAKE_PI_ERROR: "Request timed out",
			FAKE_PI_INFRA_EFFECT: undefined,
			FAKE_PI_COUNTER: counter(),
		}),
		limits: { infraRetryDelaysMs: [1, 1] },
	});
	const retried = await run(tool, implement(), undefined, undefined, implementRepo().ctx);
	assert.equal(retried.isError, false, text(retried));
	assert.equal(text(retried).split("\n").length, 2, text(retried));
	const details = readFileSync(retried.details.implement.detailsPath, "utf8");
	assert.match(details, /## Infra retries\n\nexit 1: Request timed out\n/);

	process.env.FAKE_PI_COUNTER = counter();
	process.env.FAKE_PI_INFRA_EFFECT = "1";
	const kept = await run(tool, implement(), undefined, undefined, implementRepo().ctx);
	assert.equal(kept.isError, true);
	assert.equal(readFileSync(process.env.FAKE_PI_COUNTER, "utf8"), "1", "a Bash effect prevents the retry");
	assert.match(text(kept), /^Failure class: infra \(provider or network, not the task\)\.$/m);
});

test("implement accepts a handback whose only failures had no effect", async (t) => {
	const { tool } = setup(t, {
		env: implementEnv("implement-no-effect-failures", { FAKE_PI_EDIT_WRITE_FAILED: undefined }),
	});
	const result = await run(tool, implement(), undefined, undefined, implementRepo().ctx);
	assert.equal(result.isError, false, text(result));
	assert.equal(result.details.implement.check.status, "pass");
	const [attempt] = result.details.implement.outcome.provenance;
	assert.deepEqual(
		attempt.toolEffects.map(({ toolCallId, effect }) => [toolCallId, effect]),
		[
			["edit-mismatch", "not-started"],
			["read-missing", "completed"],
			["fenced-write", "denied"],
			["timed-out", "completed"],
			["t1", "completed"],
		],
	);
	assert.deepEqual(
		attempt.stopFacts.map(({ toolCallId, cause }) => [toolCallId, cause]),
		[
			["fenced-write", "worker-fence-denial"],
			["timed-out", "tool-failure"],
		],
	);
	const details = readFileSync(result.details.implement.detailsPath, "utf8");
	assert.doesNotMatch(details, /acceptance withheld/);
	assert.doesNotMatch(details, /edit-mismatch|read-missing/);
	const artifact = JSON.parse(readFileSync(result.details.implement.outcome.failedToolCapture.path, "utf8"));
	assert.deepEqual(
		artifact.entries.map((entry) => [entry.toolCallId.text, entry.disposition]),
		[
			["edit-mismatch", "edit-rejected"],
			["read-missing", "read-failed"],
			["fenced-write", "guard-denied"],
			["timed-out", "timeout"],
		],
	);

	process.env.FAKE_PI_EDIT_WRITE_FAILED = "1";
	const unknown = await run(tool, implement(), undefined, undefined, implementRepo().ctx);
	assert.equal(unknown.isError, true, "an edit failure without a known pre-write cause stays unknown");
	assert.match(text(unknown), /acceptance withheld/);
});

test("implement: a worker that moves another branch trips the ref tripwire", async (t) => {
	const { tool } = setup(t, { env: implementEnv("move-ref") });
	const { ctx } = implementRepo();
	const res = await run(tool, implement(), undefined, undefined, ctx);
	assert.equal(res.isError, true);
	assert.match(text(res), /^✗ Tripwire: refs\/heads\/other moved during the job/m);
});

test("implement refusals leave no lock", async (t) => {
	const { tool } = setup(t, { env: implementEnv("implement-commit") });
	const { repo, git, lock, ctx } = implementRepo();
	for (const [params, c, error] of [
		[{ role: "implement", task: "x" }, ctx, /^implement needs `check`: the command that proves the change$/],
		[implement({ answer: "a table" }), ctx, /^implement does not take answer$/],
		[implement({ branch: "goal/x" }), ctx, /^unknown parameter\(s\) branch;/],
		[implement({ runs: [{}, {}] }), ctx, /^implement does not take runs with more than 1 entry$/],
		[implement({ output: true }), ctx, /^implement does not take output$/],
		[implement({ web: true }), ctx, /^implement does not take web: true$/],
		[
			implement({ runs: [{}, {}], rebuttal: true }),
			ctx,
			/^implement does not take runs with more than 1 entry, rebuttal$/,
		],
		[{ role: "general", task: "x", check: CHECK }, ctx, /^check is a non-empty string, for role implement only$/],
		...["npm test | tail", "npm test; true", "npm test && x", "npm test || true"].map((check) => [
			implement({ check }),
			ctx,
			/^check must be one command without `\|`, `;`, `&&`, or `\|\|`: a chained check never matches/,
		]),
		[implement(), { ...ctx, cwd: mkdtempSync(join(TEST_HOME, "norepo-")) }, /^implement needs a git repository/],
	]) {
		const res = await run(tool, params, undefined, undefined, c);
		assert.equal(res.isError, true, JSON.stringify(params));
		assert.match(text(res), error);
	}
	writeFileSync(join(repo, "dirty.txt"), "x\n");
	assert.match(text(await run(tool, implement(), undefined, undefined, ctx)), /^implement needs a clean tree/);
	rmSync(join(repo, "dirty.txt"));
	git("switch", "-q", "main");
	assert.match(text(await run(tool, implement(), undefined, undefined, ctx)), /^implement does not commit on main/);
	assert.ok(!existsSync(lock));
});

test("implement: a second job in the same repo is refused; the main session's writes there are blocked until the handback", async (t) => {
	const { tool, handlers, messages, commands } = setup(t, {
		env: implementEnv("implement-hang", { FAKE_PI_TERMFILE: scratch("term") }),
	});
	const { repo, real, lock, ctx } = implementRepo();
	const bg = { ...bgCtx().ctx, cwd: repo, isProjectTrusted: () => false };
	const started = await run(tool, implement({ background: true }), undefined, undefined, bg);
	assert.match(text(started), /^Started background job bg1 \(.+\) on goal\/x \(im\d+\) from \w{7}\./);
	await workerStarted(repo);
	const second = await run(tool, implement(), undefined, undefined, ctx);
	assert.match(text(second), /^implement job im\d+ \(pid \d+\) is already writing in /);
	assert.deepEqual(second.details.stopFacts[0], {
		owner: "implement",
		jobId: second.details.stopFacts[0].jobId,
		attempt: 1,
		toolCallId: "call",
		cause: "lock-refusal",
		resource: "checkout-lock",
		effect: "denied",
	});
	const hook = handlers.tool_call;
	const outside = mkdtempSync(join(TEST_HOME, "outside-"));
	const blocked = await hook({ toolName: "edit", input: { path: join(repo, "sub", "a.txt") } }, { cwd: outside });
	assert.equal(blocked?.block, true);
	assert.equal(
		blocked.reason,
		`implement job bg1 is writing in ${real}; wait for its handback or /delegate cancel bg1.`,
	);
	assert.equal((await hook({ toolName: "write", input: { path: "sub/new.txt" } }, { cwd: repo }))?.block, true);
	assert.equal(
		(await hook({ toolName: "bash", input: { command: "git commit -m x" } }, { cwd: join(repo, "sub") }))?.block,
		true,
	);
	assert.equal(
		(await hook({ toolName: "bash", input: { command: `git -C ${real} add -A` } }, { cwd: outside }))?.block,
		true,
	);
	assert.equal(await hook({ toolName: "bash", input: { command: "git log --oneline" } }, { cwd: repo }), undefined);
	assert.equal(await hook({ toolName: "edit", input: { path: join(outside, "x.txt") } }, { cwd: repo }), undefined);
	assert.equal(await hook({ toolName: "bash", input: { command: "git commit -m x" } }, { cwd: outside }), undefined);
	// An explicit target decides, resolved against the cwd.
	const bash = (command, cwd) => hook({ toolName: "bash", input: { command } }, { cwd });
	assert.equal(await bash(`git -C ${outside} commit -m x`, repo), undefined);
	assert.equal(await bash(`cd ${outside} && git add -A`, repo), undefined);
	assert.equal((await bash("cd sub && git add -A", repo))?.block, true);
	assert.equal((await bash(`git -C ${repo}/sub commit -m x`, outside))?.block, true);
	assert.equal((await bash("git -C .. commit -m x", join(repo, "sub")))?.block, true);
	// A dangling symlink cannot be resolved: blocked only under the root.
	symlinkSync(join(TEST_HOME, "missing-target"), join(outside, "dangling"));
	symlinkSync(join(TEST_HOME, "missing-target"), join(repo, "dangling"));
	assert.equal(
		await hook({ toolName: "write", input: { path: join(outside, "dangling") } }, { cwd: repo }),
		undefined,
	);
	assert.equal(
		(await hook({ toolName: "write", input: { path: join(repo, "dangling") } }, { cwd: outside }))?.block,
		true,
	);
	await commands.delegate.handler("cancel bg1", commandCtx().ctx);
	await waitFor(() => messages.length === 1, "the cancelled job's report");
	assert.ok(!existsSync(lock));
	assert.equal(
		await hook({ toolName: "edit", input: { path: join(repo, "sub", "a.txt") } }, { cwd: repo }),
		undefined,
	);
});

test("implement background cancel: SIGTERM first, WIP commit, lock gone, report without a turn", async (t) => {
	const termFile = scratch("term");
	const { tool, messages, commands } = setup(t, {
		env: implementEnv("implement-hang", { FAKE_PI_TERMFILE: termFile }),
		limits: { termGraceMs: 3000 },
	});
	const { repo, git, lock } = implementRepo();
	const ctx = { ...bgCtx().ctx, cwd: repo, isProjectTrusted: () => false };
	await run(tool, implement({ background: true }), undefined, undefined, ctx);
	await workerStarted(repo);
	await new Promise((r) => setTimeout(r, 200));
	await commands.delegate.handler("cancel bg1", commandCtx().ctx);
	await waitFor(() => messages.length === 1, "the cancelled job's report");
	assert.equal(readFileSync(termFile, "utf8"), "TERM\n");
	assert.deepEqual(messages[0].options, { triggerTurn: false, deliverAs: "followUp" });
	const content = messages[0].message.content;
	assert.match(content, /^Background delegate job bg1 failed:\n\n✗ im\d+ goal\/x /);
	assert.match(content, /^✗ stopped: cancelled$/m);
	const details = readFileSync(content.match(/Details: (\S+)/)[1], "utf8");
	assert.match(details, /delegate-parent job=im\d+ attempt=1 cause=cancelled resource=cancellation effect=unknown/);
	assert.match(git("log", "-1", "--format=%s"), /^WIP\(delegate im\d+\): stopped: cancelled$/);
	assert.ok(!existsSync(lock));
});

test("implement: session shutdown waits for the WIP commit and the lock release, and sends nothing", async (t) => {
	const { tool, messages, handlers } = setup(t, {
		env: implementEnv("implement-hang", { FAKE_PI_TERMFILE: scratch("term") }),
	});
	const { repo, git, lock } = implementRepo();
	const ctx = { ...bgCtx().ctx, cwd: repo, isProjectTrusted: () => false };
	await run(tool, implement({ background: true }), undefined, undefined, ctx);
	await workerStarted(repo);
	await new Promise((r) => setTimeout(r, 200));
	await handlers.session_shutdown();
	assert.match(git("log", "-1", "--format=%s"), /^WIP\(delegate im\d+\): stopped: session ended$/);
	assert.ok(!existsSync(lock));
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(messages.length, 0);
});

test("implement worker env: fences, parent, remote and gh cut-offs, tools, approve, and cwd", async (t) => {
	const { tool } = setup(t, {
		env: implementEnv("echo-env", {
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "user.name",
			GIT_CONFIG_VALUE_0: "Preset",
			GH_TOKEN: "t1",
			GITHUB_TOKEN: "t2",
			GH_ENTERPRISE_TOKEN: "t3",
			GITHUB_ENTERPRISE_TOKEN: "t4",
		}),
	});
	const { repo, real, ctx } = implementRepo();
	const echo = async (c) => {
		const res = await run(tool, implement(), undefined, undefined, c);
		return JSON.parse(readFileSync(text(res).match(/Details: (\S+)/)[1], "utf8").match(/^ENV (.*)$/m)[1]);
	};
	const untrusted = await echo({ ...ctx, cwd: join(repo, "sub") });
	assert.equal(realpathSync(untrusted.cwd), join(real, "sub"));
	assert.equal(untrusted.tools, "read,grep,find,ls,Skill,edit,write,bash");
	assert.deepEqual([untrusted.approve, untrusted.noApprove], [false, true]);
	const { GH_CONFIG_DIR, ...env } = untrusted.env;
	assert.match(GH_CONFIG_DIR, /me-pi-delegate-gh-/);
	assert.ok(!existsSync(GH_CONFIG_DIR), "finish removes the gh config dir");
	// Ambient GITHUB_*/GH_* (e.g. a CI runner's) are passed through; only the seeded tokens must go.
	for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) {
		assert.equal(name in env, false, `${name} removed`);
	}
	const controlled = Object.fromEntries(Object.entries(env).filter(([k]) => /^(GIT_CONFIG_|ME_PI_)/.test(k)));
	assert.deepEqual(controlled, {
		GIT_CONFIG_COUNT: "5",
		GIT_CONFIG_KEY_0: "user.name",
		GIT_CONFIG_KEY_1: "protocol.ssh.allow",
		GIT_CONFIG_KEY_2: "protocol.https.allow",
		GIT_CONFIG_KEY_3: "protocol.http.allow",
		GIT_CONFIG_KEY_4: "protocol.git.allow",
		GIT_CONFIG_VALUE_0: "Preset",
		GIT_CONFIG_VALUE_1: "never",
		GIT_CONFIG_VALUE_2: "never",
		GIT_CONFIG_VALUE_3: "never",
		GIT_CONFIG_VALUE_4: "never",
		ME_PI_DENY_DIR: join(real, ".git"),
		ME_PI_OUTPUT_DIR: real,
		ME_PI_PARENT: String(process.pid),
		ME_PI_ROLE: "implement",
	});
	const trusted = await echo({ ...ctx, isProjectTrusted: () => true });
	assert.deepEqual([trusted.approve, trusted.noApprove], [true, false]);
});

test("implement refuses runs[].model and runs[].thinking: it uses the worker pool", async (t) => {
	const { tool } = setup(t, { config: POOL_SET, env: implementEnv("implement-commit") });
	const { ctx, lock, git } = implementRepo();
	for (const r of [{ model: OPUS }, { thinking: "low" }, { model: LUNA, thinking: "max" }]) {
		const res = await run(tool, implement({ runs: [r] }), undefined, undefined, ctx);
		assert.equal(res.isError, true);
		assert.equal(text(res), "implement uses the worker pool in delegate.json; set models there");
		assert.ok(!existsSync(lock), "refused before prepare");
	}
	const head = git("rev-parse", "HEAD");
	const plain = await run(tool, implement({ runs: [{}] }), undefined, undefined, ctx);
	assert.equal(plain.isError, false, text(plain));
	assert.match(text(plain), /^✓ im\d+ goal\/x .*; check ✓ `npm test` \[gpt-6-luna @max /);
	assert.equal(plain.details.round1.length, 1);
	assert.deepEqual(plain.details.round1[0].requested, { model: LUNA, thinking: "max" });
	assert.deepEqual(plain.details.implement.delivered, {
		check: "pass",
		commit: "normal",
		wip: false,
		integrity: "clear",
	});
	const facts = plain.details.implement;
	assert.equal(facts.failed, false);
	assert.deepEqual(facts.problems, []);
	assert.equal(facts.outcome.failure, undefined);
	assert.equal(facts.wip, undefined);
	assert.equal(facts.base, head);
	assert.equal(facts.tip, git("rev-parse", "HEAD"));
	assert.notEqual(facts.tip, head);
	assert.equal(facts.commitCount, 1);
	assert.equal(facts.check.status, "pass");
	assert.deepEqual(facts.check.runs, ["pass: npm test"]);
	assert.ok(!existsSync(lock), "successful run releases the lock");
});

test("implement dispatches only the first worker pool model", async (t) => {
	const marker = scratch("implement-first-model-marker");
	const { tool } = setup(t, {
		config: POOL_SET,
		env: implementEnv("rate-limit-model", { FAKE_PI_FAIL_MODEL: LUNA, FAKE_PI_MARKER: marker }),
	});
	const { ctx } = implementRepo();
	const res = await run(tool, implement(), undefined, undefined, ctx);
	assert.equal(res.isError, true);
	assert.equal(res.details.round1[0].requested.model, LUNA);
	assert.deepEqual(
		readFileSync(marker, "utf8")
			.trim()
			.split("\n")
			.map(JSON.parse)
			.map((call) => call.model),
		[LUNA],
	);
	const details = readFileSync(text(res).match(/Details: (\S+)/)[1], "utf8");
	assert.match(details, /^# im\d+ .* \[gpt-6-luna @max/m);
	assert.doesNotMatch(details, /claude-opus-5-5/);
});

test("implement workers get implementSkills, not readOnlySkills; unset sends no allowlist", async (t) => {
	const skillsSent = async (extra: object) => {
		const marker = scratch("implement-skills-marker");
		const { tool } = setup(t, {
			config: { ...POOL_SET, readOnlySkills: ["pr"], ...extra },
			env: implementEnv("rate-limit-model", { FAKE_PI_FAIL_MODEL: LUNA, FAKE_PI_MARKER: marker }),
		});
		await run(tool, implement(), undefined, undefined, implementRepo().ctx);
		return JSON.parse(readFileSync(marker, "utf8").trim().split("\n")[0]).skills;
	};
	assert.equal(await skillsSent({ implementSkills: ["tdd", "code-review"] }), '["tdd","code-review"]');
	assert.equal(await skillsSent({}), "");
});

test("implement gets its own time limit; the wrap-up deadline is 80% of it", async (t) => {
	const { tool } = setup(t, { env: implementEnv("echo-budget") });
	const { ctx } = implementRepo();
	const before = Date.now();
	const res = await run(tool, implement(), undefined, undefined, ctx);
	const details = readFileSync(text(res).match(/Details: (\S+)/)[1], "utf8");
	const budget = JSON.parse(details.match(/^\{"tools".*\}$/m)[0]);
	assert.equal(LIMITS.implementTimeoutSecs, 2700);
	assert.equal(LIMITS.costCapUsd, 5);
	assert.equal(budget.tools, null);
	assert.ok(Number.isFinite(budget.deadline));
	assert.ok(Number.isFinite(budget.cost));
	assert.equal(budget.cost, 4);
	assert.ok(budget.deadline >= before + 2700 * 800 && budget.deadline <= Date.now() + 2700 * 800);
});

test("implement sends --approve only to its first trusted pool model", async (t) => {
	const marker = scratch("implement-approved-first-model-marker");
	const { tool } = setup(t, {
		config: POOL_SET,
		env: implementEnv("rate-limit-model", { FAKE_PI_FAIL_MODEL: LUNA, FAKE_PI_MARKER: marker }),
	});
	const { ctx } = implementRepo();
	const res = await run(tool, implement(), undefined, undefined, { ...ctx, isProjectTrusted: () => true });
	assert.equal(res.isError, true);
	const launches = readFileSync(marker, "utf8").trim().split("\n").map(JSON.parse);
	assert.equal(launches.length, 1);
	assert.equal(launches[0].model, LUNA);
	assert.equal(launches[0].approve, true, "the coordinator's trust decision still applies to the first pool model");
});

test("implement workers cannot write inside the git dir and stop when their coordinator is gone", async (t) => {
	const { real } = implementRepo();
	const env = { ME_PI_RUN: "1", ME_PI_ROLE: "implement", ME_PI_OUTPUT_DIR: real, ME_PI_DENY_DIR: join(real, ".git") };
	const hook = setup(t, { env: { ...env, ME_PI_PARENT: String(process.ppid) } }).handlers.tool_call;
	const intoGit = await hook({ toolName: "write", input: { path: ".git/hooks/pre-commit" } }, { cwd: real });
	assert.equal(intoGit?.block, true);
	assert.match(intoGit.reason, /is inside the git directory /);
	assert.equal(await hook({ toolName: "write", input: { path: "sub/new.txt" } }, { cwd: real }), undefined);
	const alive = setup(t, { env: { ...env, ME_PI_PARENT: String(process.pid) } }).handlers.tool_call;
	assert.equal(await alive({ toolName: "read", input: { path: "sub/a.txt" } }, { cwd: real }), undefined);
	const gone = spawn(process.execPath, ["-e", ""]);
	await new Promise((r) => gone.once("exit", r));
	const orphan = setup(t, { env: { ...env, ME_PI_PARENT: String(gone.pid) } }).handlers.tool_call;
	const stopped = await orphan({ toolName: "read", input: { path: "sub/a.txt" } }, { cwd: real });
	assert.deepEqual(stopped, { block: true, reason: "Blocked: the coordinator is gone; stop now.", terminate: true });
});

test("implement workers in a linked worktree cannot write its .git file or the shared git dir", async (t) => {
	const { real, git } = implementRepo();
	const wt = `${real}.worktrees/y`;
	git("worktree", "add", "-q", "-b", "goal/y", wt);
	const env = { ME_PI_RUN: "1", ME_PI_ROLE: "implement", ME_PI_OUTPUT_DIR: wt, ME_PI_DENY_DIR: join(real, ".git") };
	const hook = setup(t, { env: { ...env, ME_PI_PARENT: String(process.pid) } }).handlers.tool_call;
	for (const toolName of ["write", "edit"]) {
		const link = await hook({ toolName, input: { path: ".git" } }, { cwd: wt });
		assert.equal(link?.block, true, toolName);
		assert.match(link.reason, /\.git is the checkout's link to the git directory/);
	}
	assert.equal((await hook({ toolName: "write", input: { path: join(wt, ".git") } }, { cwd: real }))?.block, true);
	assert.equal(await hook({ toolName: "write", input: { path: "sub/new.txt" } }, { cwd: wt }), undefined);
	assert.equal(await hook({ toolName: "write", input: { path: "sub/.git" } }, { cwd: wt }), undefined);
});

test("another session's implement lock blocks this session's writes in that checkout, not its reads or a worktree", async (t) => {
	const hook = setup(t).handlers.tool_call;
	const { repo, real, git, lock } = implementRepo();
	const wt = `${real}.worktrees/y`;
	git("worktree", "add", "-q", "-b", "goal/y", wt);
	const outside = mkdtempSync(join(TEST_HOME, "outside-"));
	const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
	t.after(() => other.kill());
	const call = (toolName, input, cwd = repo) => hook({ toolName, input }, { cwd });
	const bash = (command, cwd = repo) => call("bash", { command }, cwd);
	assert.equal(await call("edit", { path: "sub/a.txt" }), undefined, "no lock, no block");

	writeFileSync(lock, `${other.pid} im3\n`);
	const blocked = await call("edit", { path: "sub/a.txt" });
	assert.equal(blocked?.block, true);
	assert.equal(
		blocked.reason,
		`implement job im3 (pid ${other.pid}) of another session is writing in ${real}; wait for its handback, or start unrelated work in a sibling worktree (\`git worktree add <path> -b <branch>\`, then a Pi session there).`,
	);
	assert.equal((await call("write", { path: join(repo, "new", "deep", "x.txt") }, outside))?.block, true);
	for (const command of ["git switch -c goal/z", "git commit -m x", "git stash", `git -C ${real} add -A`])
		assert.equal((await bash(command, command.includes("-C") ? outside : repo))?.block, true, command);
	assert.equal((await bash("git add -A", join(repo, "sub")))?.block, true, "from a subdirectory");
	for (const command of ["git status", "git log --oneline", `git worktree add ${real}.worktrees/z -b goal/z`, "ls"])
		assert.equal(await bash(command), undefined, command);
	assert.equal(await call("edit", { path: join(outside, "x.txt") }), undefined);
	assert.equal(await call("edit", { path: "sub/a.txt" }, wt), undefined, "the sibling worktree is free");
	assert.equal(await bash("git commit -m x", wt), undefined);
	assert.equal(await bash(`git -C ${wt} commit -m x`), undefined);

	rmSync(lock);
	const wtLock = join(real, ".git", "worktrees", "y", "me-pi-implement.lock");
	writeFileSync(wtLock, `${other.pid} im4\n`);
	assert.equal(await call("edit", { path: "sub/a.txt" }), undefined, "a lock in the worktree leaves the anchor free");
	const inWt = await call("edit", { path: "sub/a.txt" }, wt);
	assert.match(inWt?.reason ?? "", new RegExp(`^implement job im4 .* is writing in ${wt};`));
	assert.equal((await bash(`cd ${wt} && git commit -m x`))?.block, true);
	rmSync(wtLock);

	writeFileSync(lock, `${process.pid} im5\n`);
	assert.equal(await call("edit", { path: "sub/a.txt" }), undefined, "this session's own job is the writing map's");
	const dead = spawn(process.execPath, ["-e", ""]);
	await new Promise((r) => dead.once("exit", r));
	writeFileSync(lock, `${dead.pid} im6\n`);
	assert.equal(await call("edit", { path: "sub/a.txt" }), undefined, "a dead holder blocks nothing");
	writeFileSync(lock, "garbage\n");
	assert.match(
		(await call("edit", { path: "sub/a.txt" }))?.reason ?? "",
		/me-pi-implement\.lock is unreadable; another implement job may be starting/,
	);
});

test("implement: a WIP HEAD from an earlier attempt reaches the worker's prompt", async (t) => {
	const { tool } = setup(t, { env: implementEnv("") });
	const { repo, git, ctx } = implementRepo();
	writeFileSync(join(repo, "sub", "a.txt"), "half\n");
	git("commit", "-qam", "WIP(delegate im1): stopped: cancelled");
	const res = await run(tool, implement(), undefined, undefined, ctx);
	const details = readFileSync(text(res).match(/Details: (\S+)/)[1], "utf8");
	assert.match(details, /HEAD is a `WIP\(delegate` commit from an earlier attempt: finish that first\./);
});

test("implement: a session that ends during prepare leaves no job, lock, or message", async (t) => {
	const { tool, handlers, messages } = setup(t, { env: implementEnv("implement-commit") });
	const { repo, lock } = implementRepo();
	const ctx = { ...bgCtx().ctx, cwd: repo, isProjectTrusted: () => false };
	const pending = run(tool, implement({ background: true }), undefined, undefined, ctx);
	await handlers.session_shutdown();
	assert.ok(!existsSync(lock), "shutdown waited for the finish");
	const res = await pending;
	assert.equal(res.isError, true);
	assert.equal(text(res), "stopped: session ended");
	assert.equal(messages.length, 0);
});

// The activity widget is set after prepare took the lock; a throw there must still finish the job.
test("implement: a widget that throws after prepare still finishes the job, releases the lock, and clears writing", async (t) => {
	const { tool, handlers, messages } = setup(t, { env: implementEnv("implement-commit") });
	const hook = handlers.tool_call;
	for (const background of [false, true]) {
		const { repo, lock } = implementRepo();
		let sets = 0;
		const ui = {
			setStatus: () => {},
			setWidget: (_key, content) => {
				// Function contents only (clears pass undefined): 1 is prepare's slot, 2 the job's activity inside `call`.
				if (typeof content === "function" && ++sets === 2) throw new Error("widget broke");
			},
		};
		const ctx = { ...CTX, mode: "tui", ui, cwd: repo, isProjectTrusted: () => false };
		if (background) {
			await run(tool, implement({ background: true }), undefined, undefined, ctx);
			await waitFor(() => messages.length === 1, "the failed job's report");
			assert.match(
				messages[0].message.content,
				/^Background delegate job bg\d+ failed:\n\n✗ widget broke\n✗ im\d+ goal\/x /,
			);
			assert.match(messages[0].message.content, /^✗ delegate error: widget broke$/m);
		} else {
			await assert.rejects(run(tool, implement(), undefined, undefined, ctx), (err: any) => {
				assert.match(err.message, /^widget broke\n✗ im\d+ goal\/x /);
				assert.match(err.message, /^✗ delegate error: widget broke$/m);
				return true;
			});
		}
		assert.ok(!existsSync(lock), `lock released (background: ${background})`);
		assert.equal(
			await hook({ toolName: "edit", input: { path: join(repo, "sub", "a.txt") } }, { cwd: repo }),
			undefined,
		);
	}
});

// The fence must hold until finish has committed WIP; lifting it earlier lets main-session edits into that commit.
test("implement: writing stays set until finish completes after a throw", async (t) => {
	const { tool, handlers, messages } = setup(t, { env: implementEnv("implement-commit") });
	const hook = handlers.tool_call;
	for (const background of [false, true]) {
		const { repo, lock } = implementRepo();
		let thrown = false;
		let sets = 0;
		const ui = {
			setStatus: () => {},
			setWidget: (_key, content) => {
				if (typeof content === "function" && ++sets === 2) {
					thrown = true;
					throw new Error("widget broke");
				}
			},
		};
		const ctx = { ...CTX, mode: "tui", ui, cwd: repo, isProjectTrusted: () => false };
		let settled = false;
		const call = background
			? run(tool, implement({ background: true }), undefined, undefined, ctx).then(() =>
					waitFor(() => messages.length === 1, "the failed job's report"),
				)
			: run(tool, implement(), undefined, undefined, ctx).catch(() => {});
		call.finally(() => {
			settled = true;
		});
		let observed = 0;
		const edit = { toolName: "edit", input: { path: join(repo, "sub", "a.txt") } };
		while (!settled) {
			if (thrown && existsSync(lock)) {
				observed++;
				const verdict = await hook(edit, { cwd: repo });
				if (existsSync(lock))
					assert.equal(verdict?.block, true, `edit blocked while finish runs (background: ${background})`);
			}
			await new Promise((r) => setImmediate(r));
		}
		await call;
		assert.ok(observed > 0, "finish was observed running");
		assert.ok(!existsSync(lock));
		assert.equal(await hook(edit, { cwd: repo }), undefined);
		messages.length = 0;
	}
});

test("implement: parallel calls at the cap cannot both pass it while preparing", async (t) => {
	const { tool, commands, messages } = setup(t, { env: implementEnv("hang") });
	const ctxs = [implementRepo(), implementRepo()].map(({ repo }) => ({
		...bgCtx().ctx,
		cwd: repo,
		isProjectTrusted: () => false,
	}));
	await run(tool, { role: "scout", task: "x", runs: [{}, {}, {}], background: true }, undefined, undefined, ctxs[0]);
	const results = await Promise.all(
		ctxs.map((c) => run(tool, implement({ background: true }), undefined, undefined, c)),
	);
	const refused = results.filter((r) => r.isError);
	assert.equal(refused.length, 1, results.map(text).join("\n"));
	assert.match(text(refused[0]), /^4 worker\(s\) already running/);
	const { ctx: cmd } = commandCtx();
	await commands.delegate.handler("cancel bg1", cmd);
	await commands.delegate.handler("cancel bg2", cmd);
	await waitFor(() => messages.length === 2, "both cancelled reports");
});

// Last: every job above, refused, failed, cancelled, or stopped by shutdown, removed its gh config dir. Scans TEST_HOME
// and alternate TMPDIRs; the harness repeats this sweep after every delegate file.
test("no gh config dir outlives its job", () => {
	const roots = [
		TEST_HOME,
		join(TEST_HOME, "missing-tmp"),
		...readdirSync(TEST_HOME)
			.filter((n) => n.startsWith("not-a-dir-"))
			.map((n) => join(TEST_HOME, n)),
	].filter((dir) => existsSync(dir) && statSync(dir).isDirectory());
	assert.ok(roots.length >= 1, "TEST_HOME is scanned");
	assert.deepEqual(
		roots.flatMap((dir) => readdirSync(dir).filter((n) => n.startsWith("me-pi-delegate-gh-"))),
		[],
	);
});
