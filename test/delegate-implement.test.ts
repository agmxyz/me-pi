import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const {
	finish,
	GIT_LIMITS,
	checkInCompound,
	formatHandback,
	gitTripwires,
	isCheckRun,
	nextImplementId,
	prepare,
	settingsResources,
	settingsTripwire,
	snapshotGit,
} = await import("../packages/pi-workers/extensions/delegate-implement.ts");

const TEST_HOME = mkdtempSync(join(tmpdir(), "delegate-implement-test-"));
process.on("exit", () => rmSync(TEST_HOME, { recursive: true, force: true }));
// The gh dir goes to TMPDIR and Pi settings to PI_CODING_AGENT_DIR; both stay inside TEST_HOME.
process.env.TMPDIR = TEST_HOME;
process.env.PI_CODING_AGENT_DIR = join(TEST_HOME, "agent");

// A temp repo with one commit on main, as test/install.test.sh sets up its fixture.
function fixture() {
	const repo = mkdtempSync(join(TEST_HOME, "repo-"));
	const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
	git("init", "-q", "--template=", "-b", "main");
	git("config", "core.hooksPath", "/dev/null");
	git("config", "commit.gpgsign", "false");
	git("config", "user.email", "implement-test@example.invalid");
	git("config", "user.name", "Implement Test");
	writeFileSync(join(repo, "a.txt"), "a\n");
	git("add", "-A");
	git("commit", "-q", "-m", "initial");
	return { repo, git };
}

function commit(git, repo, name) {
	writeFileSync(join(repo, name), `${name}\n`);
	git("add", "-A");
	git("commit", "-q", "-m", name);
	return git("rev-parse", "HEAD");
}

// The job's branch is `job`; only it may move.
async function tripwires(repo, change, branch = "refs/heads/job") {
	const before = await snapshotGit(repo);
	change();
	return gitTripwires(before, await snapshotGit(repo), branch);
}

test("no change trips nothing; the job's branch, new refs and tags, and refs/remotes may change", async () => {
	const { repo, git } = fixture();
	git("branch", "job");
	assert.deepEqual(await tripwires(repo, () => {}), []);
	const base = git("rev-parse", "HEAD");
	assert.deepEqual(
		await tripwires(repo, () => {
			git("switch", "-q", "job");
			commit(git, repo, "b.txt");
			git("switch", "-q", "main");
			git("branch", "new-branch", base);
			git("tag", "v-new");
			git("update-ref", "refs/remotes/origin/main", base);
		}),
		[],
	);
	git("update-ref", "refs/remotes/origin/main", git("rev-parse", "job"));
	assert.deepEqual(await tripwires(repo, () => git("update-ref", "refs/remotes/origin/main", base)), []);
});

test("another branch moved or deleted is flagged", async () => {
	const { repo, git } = fixture();
	git("branch", "other");
	const first = git("rev-parse", "HEAD");
	const tip = commit(git, repo, "b.txt");
	git("update-ref", "refs/heads/other", tip);
	git("update-ref", "refs/heads/main", first);
	const moved = await tripwires(repo, () => git("update-ref", "refs/heads/other", first));
	assert.equal(moved.length, 1);
	assert.match(moved[0], /^refs\/heads\/other moved during the job/);
	const deleted = await tripwires(repo, () => git("update-ref", "-d", "refs/heads/other"));
	assert.deepEqual(deleted, ["refs/heads/other was deleted during the job"]);
});

test("local config and hooks/info changes are flagged", async () => {
	const { repo, git } = fixture();
	const config = await tripwires(repo, () => git("config", "core.hooksPath", "x"));
	assert.equal(config.length, 1);
	assert.match(config[0], /^local git config changed: .*-core\.hookspath=\/dev\/null.*\+core\.hookspath=x/);
	const hooks = await tripwires(repo, () => {
		mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
		writeFileSync(join(repo, ".git", "hooks", "pre-push"), "#!/bin/sh\n");
	});
	assert.deepEqual(hooks, ["files under the git common dir's hooks/ or info/ changed"]);
});

test("settings tripwire compares only resource keys", async () => {
	const dir = mkdtempSync(join(TEST_HOME, "agent-"));
	const write = (settings) => writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
	assert.equal(await settingsResources(dir), JSON.stringify({}));
	write({ packages: ["../a"], defaultModel: "x" });
	const before = await settingsResources(dir);
	write({ packages: ["../a"], defaultModel: "y" });
	assert.deepEqual(settingsTripwire(before, await settingsResources(dir)), []);
	write({ packages: ["../a", "/tmp/wt/extensions"], defaultModel: "y" });
	const changed = settingsTripwire(before, await settingsResources(dir));
	assert.equal(changed.length, 1);
	assert.match(changed[0], /\/tmp\/wt\/extensions/);
});

test("upstream tracking config may be added or changed; other config and removals still flag", async () => {
	const { repo, git } = fixture();
	const tracking = await tripwires(repo, () => {
		git("config", "branch.main.remote", "origin");
		git("config", "branch.main.merge", "refs/heads/main");
	});
	assert.deepEqual(tracking, []);
	assert.deepEqual(await tripwires(repo, () => git("config", "branch.main.remote", "upstream")), []);
	const removed = await tripwires(repo, () => git("config", "--unset", "branch.main.remote"));
	assert.match(removed[0] ?? "", /-branch\.main\.remote=upstream/);
	const other = await tripwires(repo, () => git("config", "remote.origin.url", "x"));
	assert.match(other[0] ?? "", /\+remote\.origin\.url=x/);
});

test("hooks/info symlinks and executable bits are part of the hash", async () => {
	const { repo } = fixture();
	const hooks = join(repo, ".git", "hooks");
	mkdirSync(hooks, { recursive: true });
	writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\n");
	const flagged = ["files under the git common dir's hooks/ or info/ changed"];
	assert.deepEqual(await tripwires(repo, () => chmodSync(join(hooks, "pre-push"), 0o755)), flagged);
	symlinkSync("/bin/true", join(hooks, "pre-commit"));
	assert.deepEqual(
		await tripwires(repo, () => {
			rmSync(join(hooks, "pre-commit"));
			symlinkSync("/bin/false", join(hooks, "pre-commit"));
		}),
		flagged,
	);
});

test("a snapshot outside a repository throws so the caller can report the tripwire unavailable", async () => {
	await assert.rejects(snapshotGit(mkdtempSync(join(TEST_HOME, "norepo-"))), /^Error: git .* failed in /);
});

// --- Checkout lifecycle ---

const CHECK = "npm test";
// A fixture on a goal branch with two commits, so a reset can leave the base.
function goalFixture() {
	const f = fixture();
	commit(f.git, f.repo, "second.txt");
	f.git("switch", "-q", "-c", "goal/x");
	return f;
}
const lockOf = (repo) => join(repo, ".git", "me-pi-implement.lock");
const passed = (job) => {
	job.check.status = "pass";
	job.check.runs.push(`pass: ${CHECK}`);
};
const ok = (job) => ({
	answer: "Added the feature.",
	label: "[m @high $0.0100 3s]",
	provenance: [{ jobId: job.id, attempt: 1, complete: true, stopFacts: [], toolEffects: [] }],
});

test("prepare refuses before taking the lock and leaves nothing behind", async () => {
	const plain = mkdtempSync(join(TEST_HOME, "plain-"));
	await assert.rejects(prepare(plain, "im90", CHECK), /implement needs a git repository with a commit/);
	const empty = mkdtempSync(join(TEST_HOME, "empty-"));
	execFileSync("git", ["init", "-q", "--template=", empty]);
	await assert.rejects(prepare(empty, "im90", CHECK), /implement needs a git repository with a commit/);
	for (const [setup, error] of [
		[({ repo }) => writeFileSync(join(repo, "a.txt"), "changed\n"), /needs a clean tree/],
		[({ repo }) => writeFileSync(join(repo, "untracked.txt"), "x\n"), /needs a clean tree/],
		[({ git }) => git("switch", "-q", "--detach"), /HEAD on a branch, not detached; `git switch -c goal\/<slug>`/],
		[({ git }) => git("switch", "-q", "main"), /does not commit on main; `git switch -c goal\/<slug>` first/],
		[({ git }) => git("switch", "-q", "-c", "master"), /does not commit on master/],
		[
			({ repo, git }) => writeFileSync(join(repo, ".git", "MERGE_HEAD"), `${git("rev-parse", "HEAD")}\n`),
			/a merge is in progress/,
		],
	]) {
		const f = goalFixture();
		setup(f);
		await assert.rejects(prepare(f.repo, "im90", CHECK), error);
		assert.ok(!existsSync(lockOf(f.repo)), `no lock after ${error}`);
	}
	const { repo } = goalFixture();
	writeFileSync(lockOf(repo), `${process.pid} im7\n`);
	await assert.rejects(prepare(repo, "im90", CHECK), /implement job im7 \(pid \d+\) is already writing in /);
	assert.equal(readFileSync(lockOf(repo), "utf8"), `${process.pid} im7\n`, "a live lock is kept");
});

test("an empty or unparseable lock counts as live", async () => {
	for (const content of ["", "garbage\n"]) {
		const { repo } = goalFixture();
		writeFileSync(lockOf(repo), content);
		await assert.rejects(
			prepare(repo, "im89", CHECK),
			/me-pi-implement\.lock is unreadable; another implement job may be starting/,
		);
		assert.equal(readFileSync(lockOf(repo), "utf8"), content);
	}
});

test("two takeovers of a dead lock: exactly one wins", async () => {
	const { repo } = goalFixture();
	const dead = spawn(process.execPath, ["-e", ""]);
	await new Promise((r) => dead.once("exit", r));
	writeFileSync(lockOf(repo), `${dead.pid} im5\n`);
	const results = await Promise.allSettled([prepare(repo, "im87", CHECK), prepare(repo, "im88", CHECK)]);
	const won = results.filter((r) => r.status === "fulfilled");
	assert.equal(won.length, 1, results.map((r) => r.reason?.message).join("; "));
	assert.equal(readFileSync(lockOf(repo), "utf8"), `${process.pid} ${won[0].value.id}\n`);
	await finish(won[0].value, ok(won[0].value));
	assert.ok(!existsSync(lockOf(repo)));
	assert.deepEqual(
		readdirSync(join(repo, ".git")).filter((n) => n.startsWith("me-pi-implement")),
		[],
		"no temp files left",
	);
});

test("a lock whose pid is dead is taken over", async () => {
	const { repo } = goalFixture();
	const dead = spawn(process.execPath, ["-e", ""]);
	await new Promise((r) => dead.once("exit", r));
	writeFileSync(lockOf(repo), `${dead.pid} im6\n`);
	const job = await prepare(repo, "im91", CHECK);
	assert.equal(readFileSync(lockOf(repo), "utf8"), `${process.pid} im91\n`);
	await finish(job, ok(job));
	assert.ok(!existsSync(lockOf(repo)));
});

test("finish: worker commits give the range, a clean tree, no lock, and a 0600 details file", async () => {
	const { repo, git } = goalFixture();
	const head = git("rev-parse", "HEAD");
	const job = await prepare(repo, "im92", CHECK);
	assert.equal(job.branch, "goal/x");
	assert.equal(job.base, head);
	assert.equal(job.wipHead, false);
	assert.equal(job.commonDir, realpathSync(join(repo, ".git")));
	commit(git, repo, "feature.txt");
	passed(job);
	const facts = await finish(job, ok(job));
	const out = formatHandback(facts);
	assert.equal(facts.failed, false, out);
	assert.deepEqual(facts.delivered, { check: "pass", commit: "normal", wip: false, integrity: "clear" });
	const tip = git("rev-parse", "HEAD");
	const lines = out.split("\n");
	assert.equal(lines.length, 2, out);
	assert.equal(
		lines[0],
		`✓ im92 goal/x ${head.slice(0, 7)}..${tip.slice(0, 7)}: 1 commit, 1 file +1 -0; check ✓ \`npm test\` [m @high $0.0100 3s]`,
	);
	assert.equal(lines[1], `Added the feature. Details: ${facts.detailsPath}`);
	assert.equal(statSync(facts.detailsPath).mode & 0o777, 0o600);
	const details = readFileSync(facts.detailsPath, "utf8");
	assert.match(details, /feature\.txt/);
	assert.match(details, /Added the feature\./);
	assert.equal(git("status", "--porcelain"), "");
	assert.ok(!existsSync(lockOf(repo)));
	assert.ok(!existsSync(job.ghConfigDir));
});

test("finish flags new top-level directories and dot-paths, which are often scratch", async () => {
	const { repo, git } = goalFixture();
	const job = await prepare(repo, "im-scratch", CHECK);
	mkdirSync(join(repo, ".tmp"));
	mkdirSync(join(repo, "daily-app"));
	writeFileSync(join(repo, ".tmp", "clock-test.ts"), "x\n");
	writeFileSync(join(repo, "daily-app", "index.ts"), "x\n");
	writeFileSync(join(repo, ".repro-loop.mts"), "x\n");
	commit(git, repo, "feature.txt");
	passed(job);
	const facts = await finish(job, ok(job));
	assert.deepEqual(facts.newTopLevel, [".repro-loop.mts", ".tmp/", "daily-app/"]);
	assert.equal(facts.failed, false);
	const lines = formatHandback(facts).split("\n");
	assert.equal(lines.length, 2);
	assert.match(
		lines[1],
		/ ⚠ new top-level paths: \.repro-loop\.mts, \.tmp\/, daily-app\/; confirm the task asked for them$/,
	);
	assert.match(
		readFileSync(facts.detailsPath, "utf8"),
		/## New top-level paths\n\n\.repro-loop\.mts\n\.tmp\/\ndaily-app\//,
	);

	const plain = goalFixture();
	const next = await prepare(plain.repo, "im-no-scratch", CHECK);
	commit(plain.git, plain.repo, "feature.txt");
	passed(next);
	assert.deepEqual((await finish(next, ok(next))).newTopLevel, []);
});

test("finish withholds acceptance for missing provenance, unknown effects, and uncorrelated denials", async () => {
	const denial = (jobId) => ({
		owner: "guard",
		jobId,
		attempt: 1,
		toolCallId: "blocked-call",
		cause: "guard-denial",
		resource: "guard",
		effect: "denied",
	});
	for (const scenario of [
		{ name: "missing provenance", missingProvenance: true, stopFacts: [] },
		{ name: "unknown", effect: "unknown", stopFacts: [] },
		{ name: "denied without its owner fact", effect: "denied", stopFacts: [] },
		{
			name: "denial of a completed call",
			effect: "completed",
			stopFacts: [denial("im-a2-denial-of-a-completed-call")],
		},
	]) {
		const { repo } = goalFixture();
		const job = await prepare(repo, `im-a2-${scenario.name.replaceAll(" ", "-")}`, CHECK);
		passed(job);
		const provenance = {
			jobId: job.id,
			attempt: 1,
			complete: true,
			stopFacts: scenario.stopFacts,
			toolEffects: [
				{
					owner: "pi-runtime",
					jobId: job.id,
					attempt: 1,
					toolCallId: "blocked-call",
					toolName: "bash",
					effect: scenario.effect,
					replaySafe: false,
				},
			],
		};
		const facts = await finish(job, {
			answer: "The worker reports success.",
			...(!scenario.missingProvenance && { provenance: [provenance] }),
		});
		assert.equal(facts.failed, true, scenario.name);
		assert.deepEqual(facts.delivered, { check: "pass", commit: "none", wip: false, integrity: "clear" });
		assert.ok(
			facts.problems.some((problem) => problem.includes("acceptance withheld")),
			scenario.name,
		);
		assert.match(readFileSync(facts.detailsPath, "utf8"), /acceptance withheld/);
	}
});

test("finish accepts no-effect tool failures: guard or fence denials and edits rejected before writing", async () => {
	const { repo, git } = goalFixture();
	const job = await prepare(repo, "im-no-effect", CHECK);
	commit(git, repo, "feature.txt");
	passed(job);
	const effect = (toolCallId, toolName, effect) => ({
		owner: "pi-runtime",
		jobId: job.id,
		attempt: 1,
		toolCallId,
		toolName,
		effect,
		replaySafe: false,
	});
	const denied = (owner, cause) => ({
		owner,
		jobId: job.id,
		attempt: 1,
		toolCallId: `${owner}-call`,
		cause,
		resource: "guard",
		effect: "denied",
	});
	const facts = await finish(job, {
		answer: "Implemented.",
		provenance: [
			{
				jobId: job.id,
				attempt: 1,
				complete: true,
				stopFacts: [denied("guard", "guard-denial"), denied("delegate-worker", "worker-fence-denial")],
				toolEffects: [
					effect("guard-call", "bash", "denied"),
					effect("delegate-worker-call", "write", "denied"),
					effect("edit-call", "edit", "not-started"),
				],
			},
		],
	});
	assert.equal(facts.failed, false, facts.problems.join("\n"));
	assert.deepEqual(facts.problems, []);
});

test("finish permits only one correlated completed non-replay-safe Bash failure", async () => {
	for (const scenario of [
		{ name: "matching ordinary Bash failure", allowed: true },
		{ name: "wrong tool", allowed: false, toolName: "read" },
		{ name: "replay-safe failure", allowed: false, replaySafe: true },
		{ name: "missing effect", allowed: false, missingEffect: true },
		{ name: "duplicate effect id", allowed: false, duplicateEffect: true },
		{ name: "duplicate stop id", allowed: false, duplicateStop: true },
		{
			name: "competing guard denial",
			allowed: false,
			extraStop: { owner: "guard", cause: "guard-denial", resource: "guard", effect: "denied" },
		},
		{
			name: "competing wrap-up limit",
			allowed: false,
			extraStop: { owner: "delegate-parent", cause: "wrap-up-limit", resource: "tool-time", effect: "denied" },
		},
		{
			name: "competing provider retry",
			allowed: false,
			extraStop: {
				owner: "pi-runtime",
				cause: "provider-retry-classified",
				resource: "provider",
				effect: "unknown",
			},
		},
		{ name: "attempt incomplete", allowed: false, incomplete: true },
	]) {
		const { repo, git } = goalFixture();
		const job = await prepare(repo, `im-failure-${scenario.name.replaceAll(" ", "-")}`, CHECK);
		commit(git, repo, "feature.txt");
		passed(job);
		const toolCallId = "ordinary-failure";
		const attempt = {
			jobId: job.id,
			attempt: 1,
			complete: !scenario.incomplete,
			stopFacts: [
				{
					owner: "delegate-parent",
					jobId: job.id,
					attempt: 1,
					toolCallId,
					cause: "tool-failure",
					resource: "tool",
					effect: "completed",
				},
				...(scenario.extraStop
					? [
							{
								jobId: job.id,
								attempt: 1,
								toolCallId,
								...scenario.extraStop,
							},
						]
					: []),
				...(scenario.duplicateStop
					? [
							{
								owner: "delegate-parent",
								jobId: job.id,
								attempt: 1,
								toolCallId,
								cause: "tool-failure",
								resource: "tool",
								effect: "completed",
							},
						]
					: []),
			],
			toolEffects: scenario.missingEffect
				? []
				: [
						{
							owner: "pi-runtime",
							jobId: job.id,
							attempt: 1,
							toolCallId,
							toolName: scenario.toolName ?? "bash",
							effect: "completed",
							replaySafe: scenario.replaySafe ?? false,
						},
						...(scenario.duplicateEffect
							? [
									{
										owner: "pi-runtime",
										jobId: job.id,
										attempt: 1,
										toolCallId,
										toolName: "bash",
										effect: "completed",
										replaySafe: false,
									},
								]
							: []),
					],
		};
		const facts = await finish(job, {
			answer: "Repaired and verified.",
			provenance: [attempt],
		});
		assert.equal(facts.failed, !scenario.allowed, scenario.name);
		assert.equal(facts.delivered.commit, "normal", scenario.name);
		assert.equal(facts.delivered.check, "pass", scenario.name);
		if (!scenario.allowed)
			assert.ok(
				facts.problems.some((problem) => problem.includes("acceptance withheld")),
				scenario.name,
			);
	}
});

test("finish commits leftovers as WIP on the branch with hooks off; odd reasons stay on one line", async () => {
	const { repo, git } = goalFixture();
	// A hook that would fail the commit: the WIP commit skips it.
	git("config", "core.hooksPath", join(repo, "hooks"));
	const job = await prepare(repo, "im93", CHECK);
	mkdirSync(join(repo, "hooks"));
	writeFileSync(join(repo, "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	writeFileSync(join(repo, "a.txt"), "changed\n");
	const facts = await finish(job, { failure: "stopped:\nline two" });
	assert.ok(facts.wip, formatHandback(facts));
	assert.deepEqual(facts.delivered, { check: "none", commit: "none", wip: true, integrity: "clear" });
	assert.equal(git("log", "-1", "--format=%s"), "WIP(delegate im93): stopped:");
	assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "goal/x");
	assert.equal(git("status", "--porcelain"), "");
	const out = formatHandback(facts);
	assert.match(out, /^✗ im93 /);
	assert.match(out, /^✗ WIP \w+ on goal\/x: a\.txt, hooks\/$/m, "the failure line already gives the reason");
	assert.match(out, /^✗ stopped:$/m);
	assert.doesNotMatch(out, /^line two/m);
	assert.match(out, /\nRecovery rules: \/\S+\/docs\/delegate\.md#bounded-coordinator-recovery$/);
	assert.ok(!existsSync(lockOf(repo)));
});

test("finish: a switched branch is ✗ with no WIP", async () => {
	const { repo, git } = goalFixture();
	const job = await prepare(repo, "im94", CHECK);
	git("switch", "-q", "main");
	writeFileSync(join(repo, "x.txt"), "x\n");
	passed(job);
	const facts = await finish(job, ok(job));
	assert.equal(facts.wip, undefined);
	assert.deepEqual(facts.delivered, { check: "pass", commit: "none", wip: false, integrity: "tripped" });
	assert.ok(facts.stopFacts.some((fact) => fact.owner === "implement" && fact.cause === "integrity-tripwire"));
	assert.match(formatHandback(facts), /^✗ HEAD moved: now refs\/heads\/main, not goal\/x; no WIP commit$/m);
	assert.equal(git("status", "--porcelain"), "?? x.txt");
	assert.ok(!existsSync(lockOf(repo)));
});

test("finish flags a reset below the base, a merge commit, an old commit, a moved ref, and .pi changes", async () => {
	const cases = [
		["reset below the base", ({ git }) => git("reset", "-q", "--hard", "HEAD~1"), /no longer descends from the base/],
		[
			"merge commit",
			({ repo, git }) => {
				git("switch", "-q", "-c", "side");
				commit(git, repo, "side.txt");
				git("switch", "-q", "goal/x");
				commit(git, repo, "mine.txt");
				git("merge", "-q", "--no-ff", "--no-edit", "side");
			},
			/merge commit\(s\) in the range: \w+/,
		],
		[
			"fast-forward to an older commit",
			({ git }) => git("merge", "-q", "--ff-only", "old"),
			/commit\(s\) older than the job \(fast-forward to existing work\?\): \w+/,
		],
		[
			"another ref moved",
			({ git }) => git("update-ref", "refs/heads/main", "HEAD~1"),
			/Tripwire: refs\/heads\/main moved during the job/,
		],
		[
			".pi changed",
			({ repo, git }) => {
				mkdirSync(join(repo, ".pi"));
				writeFileSync(join(repo, ".pi", "x.ts"), "x\n");
				git("add", "-A");
				git("commit", "-q", "-m", "pi");
			},
			/Tripwire: \.pi or \.agents changed \(\.pi\/x\.ts\); review before \/reload/,
		],
		[
			"settings changed",
			() => {
				mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
				writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ packages: ["/x"] }));
			},
			/Tripwire: Pi settings resources changed during the job/,
		],
	];
	for (const [name, change, error] of cases) {
		const f = goalFixture();
		// An existing commit, dated an hour ago, the job's branch can fast-forward to.
		f.git("branch", "old");
		f.git("switch", "-q", "old");
		writeFileSync(join(f.repo, "old.txt"), "old\n");
		f.git("add", "-A");
		execFileSync("git", ["-C", f.repo, "commit", "-q", "-m", "old"], {
			env: { ...process.env, GIT_COMMITTER_DATE: new Date(Date.now() - 3600_000).toISOString() },
		});
		f.git("switch", "-q", "goal/x");
		rmSync(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), { force: true });
		const job = await prepare(f.repo, "im95", CHECK);
		change(f);
		passed(job);
		const facts = await finish(job, ok(job));
		assert.equal(facts.failed, true, name);
		assert.equal(facts.delivered.integrity, "tripped", name);
		assert.ok(
			facts.stopFacts.some((fact) => fact.owner === "implement" && fact.cause === "integrity-tripwire"),
			name,
		);
		assert.match(formatHandback(facts), new RegExp(`^✗ .*${error.source}`, "m"), name);
	}
	rmSync(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), { force: true });
});

test("finish never throws; git timeouts become problems and the lock is released", async (t) => {
	const { repo } = goalFixture();
	const job = await prepare(repo, "im96", CHECK);
	// Every git call during finish hangs until the timeout kills it, so no call can win a race against it.
	const bin = mkdtempSync(join(tmpdir(), "hung-git-"));
	writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
	const saved = { timeoutMs: GIT_LIMITS.timeoutMs, path: process.env.PATH };
	const restore = () => {
		GIT_LIMITS.timeoutMs = saved.timeoutMs;
		process.env.PATH = saved.path;
	};
	t.after(restore);
	GIT_LIMITS.timeoutMs = 100;
	process.env.PATH = `${bin}:${saved.path}`;
	const facts = await finish(job, ok(job));
	restore();
	assert.equal(facts.failed, true);
	assert.equal(facts.delivered.integrity, "unknown");
	assert.match(formatHandback(facts), /timed out after 100 ms/);
	assert.ok(!existsSync(lockOf(repo)));
});

test("terminal WIP is not delivered, while a normal commit resolves prior WIP", async (t) => {
	for (const scenario of ["unchanged", "worker-wip", "resolved"])
		await t.test(scenario, async () => {
			const { repo, git } = goalFixture();
			if (scenario !== "worker-wip") {
				writeFileSync(join(repo, "a.txt"), "half\n");
				git("commit", "-qam", "WIP(delegate earlier): stopped");
			}
			const job = await prepare(repo, `im-wip-${scenario}`, CHECK);
			if (scenario !== "unchanged") {
				writeFileSync(join(repo, "a.txt"), "done\n");
				git("commit", "-qam", scenario === "worker-wip" ? "WIP(delegate worker): stopped" : "feat: resolve WIP");
			}
			passed(job);
			const facts = await finish(job, ok(job));
			assert.equal(facts.failed, scenario !== "resolved", scenario);
			assert.equal(facts.delivered.wip, scenario !== "resolved", scenario);
			assert.equal(facts.delivered.commit, scenario === "resolved" ? "normal" : "none", scenario);
		});
});

test("prepare notes a WIP HEAD from an earlier attempt", async () => {
	const { repo, git } = goalFixture();
	writeFileSync(join(repo, "a.txt"), "half\n");
	git("commit", "-qam", "WIP(delegate im1): stopped: cancelled");
	const job = await prepare(repo, "im97", CHECK);
	assert.equal(job.wipHead, true);
	await finish(job, ok(job));
});

const facts = (over = {}) => ({
	id: "im3",
	branch: "goal/x",
	base: "9f8e7d6aaaaaaa",
	tip: "1a2b3c4bbbbbbb",
	commits: [],
	commitCount: 2,
	files: 3,
	insertions: 40,
	deletions: 5,
	stat: "",
	problems: [],
	check: { command: "npm run check --prefix extensions", status: "pass", runs: [] },
	outcome: { answer: "Did it.", label: "[glm @high $0.04 118s]" },
	detailsPath: "/tmp/me-pi-delegate-1/im3.md",
	failed: false,
	...over,
});

test("formatHandback: a failure shows only its first line, capped at 200 characters", () => {
	const failure = `${"f".repeat(300)}\nsecond line`;
	const out = formatHandback(
		facts({ failed: true, outcome: { failure }, wip: { sha: "abc1234", reason: "x", files: ["a.txt"], more: 0 } }),
	);
	assert.ok(out.split("\n").includes(`✗ ${"f".repeat(200)}`), out);
	assert.doesNotMatch(out, /second line|f{201}/);
	assert.match(out, /^✗ WIP abc1234 on goal\/x: a\.txt$/m);
});

test("formatHandback: two lines when ✓; BLOCKED capped; control characters quoted; check problems are ✗", () => {
	assert.equal(
		formatHandback(facts()),
		"✓ im3 goal/x 9f8e7d6..1a2b3c4: 2 commits, 3 files +40 -5; check ✓ `npm run check --prefix extensions` [glm @high $0.04 118s]\nDid it. Details: /tmp/me-pi-delegate-1/im3.md",
	);
	const answer = ["Summary", "BLOCKED: a: x", "BLOCKED: b: x", "BLOCKED: c: x", "BLOCKED: d: x", "BLOCKED: e: x"].join(
		"\n",
	);
	const blocked = formatHandback(facts({ outcome: { answer } })).split("\n");
	assert.equal(blocked[1], "Summary. Details: /tmp/me-pi-delegate-1/im3.md");
	assert.deepEqual(blocked.slice(2), [
		"BLOCKED: a: x",
		"BLOCKED: b: x",
		"BLOCKED: c: x",
		"+2 more BLOCKED in details",
	]);
	const quoted = formatHandback(facts({ outcome: { answer: `x\u001b[2Jy${"z".repeat(300)}` } })).split("\n");
	assert.equal(quoted.length, 2);
	assert.match(quoted[1], /^x\\u001b\[2Jyz+\. Details:/);
	assert.ok(quoted[1].length < 260);
	for (const [status, line] of [
		["stale", "✗ check stale: checkout content changed after the last check"],
		["fail", "✗ check failed"],
		["none", "✗ check not run"],
	]) {
		const out = formatHandback(facts({ failed: true, check: { command: "npm test", status, runs: [] } }));
		assert.match(out, /^✗ im3 /);
		assert.ok(out.split("\n").includes(line), out);
	}
});

test("formatHandback keeps a passing capture warning inline and links artifacts on failed handbacks", () => {
	const warning = formatHandback(
		facts({
			outcome: {
				answer: "Done.",
				failedToolCapture: { status: "unavailable", warning: "capture unavailable: EACCES" },
			},
		}),
	);
	assert.equal(warning.split("\n").length, 2, warning);
	assert.match(warning.split("\n")[0], /^✓ .*check ✓/);
	assert.match(warning.split("\n")[1], /⚠ capture unavailable: EACCES/);

	const linked = formatHandback(
		facts({
			failed: true,
			outcome: {
				failure: "worker failed",
				failedToolCapture: {
					status: "written",
					path: "/tmp/im3-failed-tools.json",
					bytes: 100,
					failureCount: 2,
					unmatchedStartCount: 1,
					truncated: true,
				},
			},
		}),
	);
	assert.match(
		linked,
		/^Failed-tool diagnostics: \/tmp\/im3-failed-tools\.json \(2 failed tool call\(s\), 1 end-not-observed start; truncated\)$/m,
	);
});

test("details and handback redact worker text and escape control characters", async () => {
	const { repo } = goalFixture();
	const job = await prepare(repo, "im98", CHECK);
	job.check.command = "GITHUB_TOKEN=check-fake-secret npm test";
	job.check.status = "pass";
	job.check.runs.push(`pass: ${job.check.command}`);
	const facts = await finish(job, {
		answer: `AWS_SECRET_ACCESS_KEY='answer-fake-secret' \u001b[2J`,
		provenance: [{ jobId: job.id, attempt: 1, complete: true, stopFacts: [], toolEffects: [] }],
		failedToolCapture: {
			status: "unavailable",
			warning: `capture unavailable: GITHUB_TOKEN="warning-fake-secret"`,
		},
	});
	assert.equal(facts.failed, false);
	const details = readFileSync(facts.detailsPath, "utf8");
	assert.doesNotMatch(details, /check-fake-secret|answer-fake-secret|warning-fake-secret/);
	assert.ok(details.includes("[REDACTED]"));
	assert.ok(details.includes("\\u001b[2J"));
	const handback = formatHandback(facts);
	assert.equal(handback.split("\n").length, 2);
	assert.doesNotMatch(handback, /check-fake-secret|answer-fake-secret|warning-fake-secret/);
	assert.ok(handback.includes("[REDACTED]"));
	assert.ok(handback.includes("\\u001b[2J"));
});

test("isCheckRun: exact command, with an optional rtk prefix or 2>&1; no pipes or chains", () => {
	const check = "npm run check --prefix extensions";
	const cwd = "/repo/my dir";
	for (const c of [check, `rtk ${check}`, `${check} 2>&1`, `  npm run  check --prefix extensions `])
		assert.equal(isCheckRun(c, check, cwd), true, c);
	for (const c of [`${check} | tail`, `${check}; true`, `${check} || true`, `${check} && echo`, "npm test"])
		assert.equal(isCheckRun(c, check, cwd), false, c);
});

test("isCheckRun: one leading cd to the job cwd counts; any other cd or chain does not", () => {
	const check = "npm run check --prefix extensions";
	const cwd = join(TEST_HOME, "my dir");
	mkdirSync(join(cwd, "extensions"), { recursive: true });
	for (const c of [`cd "${cwd}" && ${check}`, `cd '${cwd}/' && ${check} 2>&1`, `cd . && ${check}`, `cd .; ${check}`])
		assert.equal(isCheckRun(c, check, cwd), true, c);
	for (const c of [
		`cd extensions && ${check}`,
		`cd /other && ${check}`,
		`cd ${cwd.replace(" ", "\\ ")} && ${check}`,
		`cd . && ${check} && echo`,
		`cd . && cd . && ${check}`,
		`cd . || ${check}`,
	])
		assert.equal(isCheckRun(c, check, cwd), false, c);
});

test("checkInCompound: the declared check inside a pipe, chain, or redirect, or with only extra flags, but not alone or with file targets", () => {
	const check = "npm run check";
	const cwd = TEST_HOME;
	for (const c of [
		`${check} 2>&1 | tail -25`,
		`cd ${cwd} && ${check} 2>&1 | tail -20`,
		`${check}; echo "exit $?"`,
		`npm run lint && ${check}`,
		`${check} > /tmp/out.txt 2>&1`,
		`rtk ${check} | head`,
		`${check} -- --test-timeout=60000`,
		`${check} -- --test-timeout=60000 | tail`,
	])
		assert.equal(checkInCompound(c, check, cwd), true, c);
	for (const c of [
		check,
		`cd ${cwd} && ${check}`,
		`${check} 2>&1`,
		`${check} -- test/a.test.mjs`,
		"npm run check:types | tail",
		"node --test test/a.test.mjs | tail",
	])
		assert.equal(checkInCompound(c, check, cwd), false, c);
});

test("isCheckRun: a cd through a symlink to the job cwd counts", () => {
	const check = "npm run check --prefix extensions";
	const real = mkdtempSync(join(TEST_HOME, "real-"));
	const link = join(TEST_HOME, `link-${Date.now()}`);
	symlinkSync(real, link);
	assert.equal(isCheckRun(`cd ${link} && ${check}`, check, real), true);
	assert.equal(isCheckRun(`cd ${real} && ${check}`, check, link), true);
	assert.equal(isCheckRun(`cd ${link}/.. && ${check}`, check, real), false);
});

test("isCheckRun: a cd dir with shell expansion, or a missing dir under &&, does not count", () => {
	const check = "npm test";
	const cwd = TEST_HOME;
	for (const c of [
		"cd $HOME/.. && npm test",
		"cd ~/.. && npm test",
		'cd "$(mktemp -d)/.." && npm test',
		"cd `pwd` && npm test",
		"cd ./* && npm test",
		"cd .? && npm test",
		"cd [.] && npm test",
		`cd ${cwd}/missing/.. && npm test`,
	])
		assert.equal(isCheckRun(c, check, cwd), false, c);
	assert.equal(isCheckRun("cd '.' && npm test", check, cwd), true);
	assert.equal(isCheckRun(`cd ${cwd}/missing/..; npm test`, check, cwd), true);
});

test("implement ids increment across a reload", async () => {
	const a = nextImplementId();
	const reloaded = await import(`../packages/pi-workers/extensions/delegate-implement.ts?reload=${Date.now()}`);
	const b = reloaded.nextImplementId();
	assert.equal(Number(b.slice(2)), Number(a.slice(2)) + 1);
	assert.match(a, /^im\d+$/);
});

// Last: every job above, refused, failed, cancelled, or stopped by shutdown, removed its gh config dir.
test("no gh config dir outlives its job", () => {
	assert.deepEqual(
		readdirSync(TEST_HOME).filter((n) => n.startsWith("me-pi-delegate-gh-")),
		[],
	);
});
