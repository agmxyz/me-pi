import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { gitTripwires, settingsResources, settingsTripwire, snapshotGit } = await import("./delegate-implement.ts");

const TEST_HOME = mkdtempSync(join(tmpdir(), "delegate-implement-test-"));
process.on("exit", () => rmSync(TEST_HOME, { recursive: true, force: true }));

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
