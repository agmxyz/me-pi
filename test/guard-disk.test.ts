import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	branchOf,
	dirtIn,
	remoteUrlOf,
	repoRootOf,
	startBudget,
} from "../packages/pi-workers/extensions/guard-disk.ts";

// A scratch repo under the OS temp dir; HOME points there so no user git config is read.
function scratch(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "guard-disk-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	mkdirSync(repo);
	const env = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1" };
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env, stdio: "pipe" });
	git("init", "-q", "-b", "feat");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
	writeFileSync(join(repo, "a.txt"), "a\n");
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, "src", "b.txt"), "b\n");
	git("add", ".");
	git("commit", "-q", "-m", "init");
	git("remote", "add", "origin", "git@github.com:me/app.git");
	return { root, repo, git };
}

test("reads branch, repo root, and remote URL; undefined outside a repo", (t) => {
	const { root, repo, git } = scratch(t);
	assert.equal(branchOf(repo), "feat");
	assert.equal(branchOf(root), undefined);
	assert.equal(repoRootOf(join(repo, "src")), repo);
	assert.equal(repoRootOf(join(repo, "src", "not", "yet")), repo, "a missing dir reads from its nearest parent");
	assert.equal(repoRootOf(root), undefined);
	assert.equal(remoteUrlOf(repo, "origin"), "git@github.com:me/app.git");
	assert.equal(remoteUrlOf(repo, "nope"), undefined);
	assert.equal(remoteUrlOf(repo, "a b"), undefined, "a remote name that isn't a plain word is never looked up");
	git("checkout", "-q", "--detach");
	assert.equal(branchOf(repo), "HEAD");
});

test("keeps the caller's spelling of the root through a symlink", (t) => {
	const { root, repo } = scratch(t);
	const link = join(root, "link");
	symlinkSync(repo, link);
	assert.equal(repoRootOf(join(link, "src")), link);
	assert.equal(repoRootOf(realpathSync(join(repo, "src"))), realpathSync(repo));
});

test("dirtIn: tracked changes, untracked files only when asked, ignored files never", (t) => {
	const { repo } = scratch(t);
	assert.equal(dirtIn(repo, undefined, true), "clean");
	mkdirSync(join(repo, "node_modules"));
	writeFileSync(join(repo, "node_modules", "x.js"), "x\n");
	assert.equal(dirtIn(repo, ["node_modules"], true), "clean", "gitignored paths count as clean");
	writeFileSync(join(repo, "src", "new.txt"), "n\n");
	assert.equal(dirtIn(repo, ["src"], false), "clean", "untracked files don't count for reset/checkout");
	assert.equal(dirtIn(repo, ["src"], true), "dirty");
	assert.equal(dirtIn(repo, ["a.txt"], true), "clean", "only the affected paths count");
	writeFileSync(join(repo, "a.txt"), "changed\n");
	assert.equal(dirtIn(repo, ["a.txt"], false), "dirty");
	assert.equal(dirtIn(repo, ["*"], false), "clean", "paths are literal, not pathspec globs");
	assert.equal(dirtIn(join(repo, "..", "missing"), undefined, false), "unknown");
});

test("dirtIn counts ignored files only when asked (git clean -x)", (t) => {
	const { repo } = scratch(t);
	mkdirSync(join(repo, "node_modules"));
	writeFileSync(join(repo, "node_modules", "x.js"), "x\n");
	assert.equal(dirtIn(repo, undefined, true), "clean");
	assert.equal(dirtIn(repo, undefined, true, true), "dirty");
});

test("a spent lookup budget reads unknown, and a failing git reads unknown", (t) => {
	const { repo } = scratch(t);
	t.after(() => startBudget(60_000));
	startBudget(0);
	assert.equal(dirtIn(repo, undefined, true), "unknown", "no budget left: no git call, the caller asks");
	assert.equal(repoRootOf(repo), undefined);
	startBudget(60_000);
	assert.equal(dirtIn(repo, undefined, true), "clean");
	const path = process.env.PATH;
	t.after(() => {
		process.env.PATH = path;
	});
	process.env.PATH = "/nonexistent";
	assert.equal(dirtIn(repo, undefined, true), "unknown", "git can't run");
	assert.equal(branchOf(repo), undefined);
});
