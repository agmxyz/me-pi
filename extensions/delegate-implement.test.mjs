import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
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
	formatFacts,
	gitTripwires,
	nextImplementId,
	prepare,
	settingsResources,
	settingsTripwire,
	snapshotGit,
} = await import("./delegate-implement.ts");

const TEST_HOME = mkdtempSync(join(tmpdir(), "delegate-implement-test-"));
process.on("exit", () => rmSync(TEST_HOME, { recursive: true, force: true }));
// Worktrees go to TMPDIR and Pi settings to PI_CODING_AGENT_DIR; both stay inside TEST_HOME.
process.env.TMPDIR = TEST_HOME;
process.env.PI_CODING_AGENT_DIR = join(TEST_HOME, "agent");

// A temp repo with one commit on main, as bin/install.test.sh sets up its fixture.
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

// Commits on the current branch and returns the new tip.
function commit(git, repo, name) {
	writeFileSync(join(repo, name), `${name}\n`);
	git("add", "-A");
	git("commit", "-q", "-m", name);
	return git("rev-parse", "HEAD");
}

async function tripwires(repo, change) {
	const before = await snapshotGit(repo);
	change();
	return gitTripwires(before, await snapshotGit(repo), repo);
}

test("no change trips nothing; new refs and delegate/* moves are fine", async () => {
	const { repo, git } = fixture();
	git("branch", "delegate/x");
	assert.deepEqual(await tripwires(repo, () => {}), []);
	const base = git("rev-parse", "HEAD");
	assert.deepEqual(
		await tripwires(repo, () => {
			git("switch", "-q", "delegate/x");
			commit(git, repo, "b.txt");
			git("switch", "-q", "main");
			git("branch", "new-branch", base);
		}),
		[],
	);
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

test("the main branch may fast-forward, not move to a non-descendant", async () => {
	const { repo, git } = fixture();
	assert.deepEqual(await tripwires(repo, () => commit(git, repo, "b.txt")), []);
	const first = git("rev-list", "--max-parents=0", "HEAD");
	const reset = await tripwires(repo, () => git("update-ref", "refs/heads/main", first));
	assert.equal(reset.length, 1);
	assert.match(reset[0], /^main branch refs\/heads\/main moved to a non-descendant/);
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

test("the main session switching branches and committing there is fine; resetting it is not", async () => {
	const { repo, git } = fixture();
	git("branch", "feature");
	const first = git("rev-parse", "HEAD");
	assert.deepEqual(
		await tripwires(repo, () => {
			git("switch", "-q", "feature");
			commit(git, repo, "b.txt");
		}),
		[],
	);
	git("switch", "-q", "main");
	commit(git, repo, "c.txt");
	const reset = await tripwires(repo, () => {
		git("switch", "-q", "feature");
		git("update-ref", "refs/heads/main", first);
	});
	assert.equal(reset.length, 1);
	assert.match(reset[0], /^main branch refs\/heads\/main moved to a non-descendant/);
	git("switch", "-q", "main");
	const created = await tripwires(repo, () => git("switch", "-q", "-c", "fresh"));
	assert.deepEqual(created, []);
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

// --- Worktree lifecycle ---

const worktrees = () => readdirSync(TEST_HOME).filter((n) => n.startsWith("me-pi-delegate-wt-"));

test("prepare and finish: worker commits on its branch; facts come from git, the diff only from its file", async () => {
	const { repo, git } = fixture();
	mkdirSync(join(repo, "sub"));
	writeFileSync(join(repo, "sub", "s.txt"), "s\n");
	git("add", "-A");
	git("commit", "-q", "-m", "sub");
	writeFileSync(join(repo, "dirty.txt"), "uncommitted\n");
	const head = git("rev-parse", "HEAD");
	const wt = await prepare(join(repo, "sub"), "im90");
	assert.match(wt.branch, /^delegate\/\d{8}-\d{6}-im90$/);
	assert.equal(wt.base, head);
	assert.equal(wt.workerCwd, join(wt.dir, "sub/"));
	assert.equal(wt.dirty, 1);
	assert.ok(!existsSync(join(wt.dir, "dirty.txt")), "the worker does not get uncommitted files");
	const wgit = (...args) => execFileSync("git", ["-C", wt.dir, ...args], { encoding: "utf8" }).trim();
	writeFileSync(join(wt.dir, "new.txt"), "SECRET-DIFF-CONTENT\n");
	wgit("add", "-A");
	wgit("commit", "-q", "-m", "feat: new");
	const tip = wgit("rev-parse", "HEAD");
	const facts = await finish(wt);
	const out = formatFacts(facts);
	assert.equal(facts.failed, false, out);
	assert.ok(
		out.startsWith(`Branch: ${wt.branch} @ ${tip.slice(0, 7)} (base ${head.slice(0, 7)}, your HEAD at start)`),
		out,
	);
	assert.match(out, /^Commits \(1, oldest first\):\n {2}\w{7,} feat: new$/m);
	assert.match(out, /^Diffstat: 1 file changed, 1 insertion\(\+\)$/m);
	assert.match(out, /^ {2}new\.txt \| 1 \+$/m);
	assert.match(out, /^Worktree: removed$/m);
	assert.doesNotMatch(out, /\u2717|SECRET-DIFF-CONTENT/);
	assert.match(
		out,
		new RegExp(`^Diff: ${facts.diffPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(0600, base\\.\\.tip\\)$`, "m"),
	);
	assert.equal(statSync(facts.diffPath).mode & 0o777, 0o600);
	assert.match(readFileSync(facts.diffPath, "utf8"), /SECRET-DIFF-CONTENT/);
	assert.ok(!existsSync(wt.dir), "worktree removed");
	assert.equal(git("rev-parse", `refs/heads/${wt.branch}`), tip);
	assert.equal(git("rev-parse", "HEAD"), head);
	assert.equal(git("status", "--porcelain"), "?? dirty.txt");
});

test("finish commits leftovers as WIP and reports it as a failure", async () => {
	const { repo } = fixture();
	const wt = await prepare(repo, "im91");
	writeFileSync(join(wt.dir, "a.txt"), "changed\n");
	writeFileSync(join(wt.dir, "b.txt"), "b\n");
	const facts = await finish(wt, "stopped: timeout after 900s");
	const out = formatFacts(facts);
	assert.equal(facts.failed, true);
	assert.ok(facts.wip);
	assert.match(
		out,
		new RegExp(
			`^\u2717 WIP ${facts.wip.sha} \\(stopped: timeout after 900s\\): a\\.txt, b\\.txt\\. Do not merge; continue with branch: "${wt.branch}"\\.$`,
			"m",
		),
	);
	const subject = execFileSync("git", ["-C", repo, "log", "-1", "--format=%s", wt.branch], {
		encoding: "utf8",
	}).trim();
	assert.equal(subject, "WIP(delegate im91): stopped: timeout after 900s");
	assert.match(out, /^Worktree: removed$/m);
	const plain = await prepare(repo, "im92");
	writeFileSync(join(plain.dir, "c.txt"), "c\n");
	assert.equal((await finish(plain)).wip.reason, "left uncommitted by the worker");
});

test("finish keeps the worktree and skips WIP when the worker left its branch", async () => {
	const { repo, git } = fixture();
	git("branch", "other");
	const wt = await prepare(repo, "im93");
	execFileSync("git", ["-C", wt.dir, "switch", "-q", "--detach"]);
	writeFileSync(join(wt.dir, "x.txt"), "x\n");
	const facts = await finish(wt);
	const out = formatFacts(facts);
	assert.equal(facts.failed, true);
	assert.equal(facts.wip, undefined);
	assert.match(out, new RegExp(`^\u2717 worktree HEAD is detached, not ${wt.branch}$`, "m"));
	assert.match(out, new RegExp(`^\u2717 Worktree kept at ${wt.dir}: `, "m"));
	assert.ok(existsSync(join(wt.dir, "x.txt")));
});

test("a continued branch lists commits from its tip at start, and diffs from the merge-base", async () => {
	const { repo, git } = fixture();
	const first = await prepare(repo, "im94");
	writeFileSync(join(first.dir, "one.txt"), "1\n");
	execFileSync("git", ["-C", first.dir, "add", "-A"]);
	execFileSync("git", ["-C", first.dir, "commit", "-q", "-m", "one"]);
	await finish(first);
	const head = git("rev-parse", "HEAD");
	const wt = await prepare(repo, "im95", first.branch);
	assert.equal(wt.branch, first.branch);
	assert.equal(wt.base, head);
	writeFileSync(join(wt.dir, "two.txt"), "2\n");
	execFileSync("git", ["-C", wt.dir, "add", "-A"]);
	execFileSync("git", ["-C", wt.dir, "commit", "-q", "-m", "two"]);
	const out = formatFacts(await finish(wt));
	assert.match(out, /merge-base with your HEAD/);
	assert.match(out, /^Commits \(1, oldest first\):\n {2}\w+ two$/m);
	assert.match(out, /^Diffstat: 2 files changed, 2 insertions\(\+\)$/m);
});

test("prepare refuses bad branches, non-repos, and empty repos, and leaves no temp dir", async () => {
	const { repo, git } = fixture();
	git("branch", "feature");
	const before = worktrees().length;
	await assert.rejects(prepare(repo, "im96", "feature"), /branch must start with delegate\/: feature/);
	await assert.rejects(prepare(repo, "im96", "delegate/missing"), /no such branch: delegate\/missing/);
	await assert.rejects(prepare(mkdtempSync(join(TEST_HOME, "plain-")), "im96"), /implement needs a git repository/);
	const empty = mkdtempSync(join(TEST_HOME, "empty-"));
	execFileSync("git", ["init", "-q", "--template=", empty]);
	await assert.rejects(prepare(empty, "im96"), /implement needs a git repository with a commit/);
	git("branch", "delegate/taken");
	const busy = await prepare(repo, "im97", "delegate/taken");
	const refs = git("for-each-ref", "--format=%(refname)");
	await assert.rejects(prepare(repo, "im98", "delegate/taken"), /git worktree add failed for .*me-pi-delegate-wt-/);
	assert.equal(git("for-each-ref", "--format=%(refname)"), refs, "a refused add leaves no branch");
	assert.equal(worktrees().length, before + 1, "only the live worktree's dir remains");
	await finish(busy);
});

test("implement ids increment across a reload", async () => {
	const a = nextImplementId();
	const reloaded = await import(`./delegate-implement.ts?reload=${Date.now()}`);
	const b = reloaded.nextImplementId();
	assert.equal(Number(b.slice(2)), Number(a.slice(2)) + 1);
	assert.match(a, /^im\d+$/);
});

test("the WIP commit ignores hooks and signing the worker configured; odd reasons stay on one line", async () => {
	const { repo } = fixture();
	const wt = await prepare(repo, "im80");
	const wgit = (...args) => execFileSync("git", ["-C", wt.dir, ...args], { encoding: "utf8" });
	// Worktree-local config, so the main repo's tripwire is unaffected by the setup itself.
	wgit("config", "extensions.worktreeConfig", "true");
	wgit("config", "--worktree", "commit.gpgsign", "true");
	wgit("config", "--worktree", "gpg.program", "false");
	writeFileSync(join(wt.dir, "a.txt"), "changed\n");
	const facts = await finish(wt, "stopped:\nline two");
	assert.ok(facts.wip, formatFacts(facts));
	const out = formatFacts(facts);
	assert.match(out, /^\u2717 WIP \w+ \("stopped:\\nline two"\): a\.txt\./m);
	assert.doesNotMatch(out, /^line two/m);
});

test("finish keeps the worktree, without WIP, when the job's branch was deleted", async () => {
	const { repo, git } = fixture();
	const wt = await prepare(repo, "im81");
	writeFileSync(join(wt.dir, "a.txt"), "changed\n");
	git("update-ref", "-d", `refs/heads/${wt.branch}`);
	const facts = await finish(wt);
	assert.equal(facts.wip, undefined);
	assert.equal(facts.worktree.removed, false);
	assert.match(formatFacts(facts), new RegExp(`^\u2717 branch ${wt.branch} is gone`, "m"));
});

test("finish flags a branch that no longer contains its start", async () => {
	const { repo, git } = fixture();
	const first = await prepare(repo, "im82");
	writeFileSync(join(first.dir, "one.txt"), "1\n");
	execFileSync("git", ["-C", first.dir, "add", "-A"]);
	execFileSync("git", ["-C", first.dir, "commit", "-q", "-m", "one"]);
	await finish(first);
	const wt = await prepare(repo, "im83", first.branch);
	execFileSync("git", ["-C", wt.dir, "reset", "-q", "--hard", git("rev-parse", "HEAD")]);
	const out = formatFacts(await finish(wt));
	assert.match(out, new RegExp(`^\u2717 branch no longer contains its start ${wt.start.slice(0, 7)}$`, "m"));
});

test("finish never throws; git timeouts become problems", async (t) => {
	const { repo } = fixture();
	const wt = await prepare(repo, "im84");
	const saved = GIT_LIMITS.timeoutMs;
	t.after(() => {
		GIT_LIMITS.timeoutMs = saved;
	});
	GIT_LIMITS.timeoutMs = 1;
	const facts = await finish(wt);
	GIT_LIMITS.timeoutMs = saved;
	assert.equal(facts.failed, true);
	assert.match(formatFacts(facts), /timed out after 1 ms/);
	execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wt.dir]);
});
