import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	branchOf,
	dirtIn,
	isCheckoutRef,
	pushUrlsOf,
	remoteUrlOf,
	repoRootOf,
	startBudget,
	urlRewritesOf,
} from "../packages/pi-workers/extensions/guard-disk.ts";
import { isolate } from "./helpers/isolate.ts";

// A scratch repo under the OS temp dir; HOME points there so no user git config is read.
function scratch(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "guard-disk-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	isolate(t, root);
	const repo = join(root, "repo");
	mkdirSync(repo);
	const env = { ...process.env };
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
	assert.equal(repoRootOf(root), null, "git says: not a repo");
	assert.equal(remoteUrlOf(repo, "origin"), "git@github.com:me/app.git");
	assert.equal(remoteUrlOf(repo, "nope"), undefined);
	assert.equal(remoteUrlOf(repo, "a b"), undefined, "a remote name that isn't a plain word is never looked up");
	git("checkout", "-q", "--detach");
	assert.equal(branchOf(repo), "HEAD");
});

test("reads the URLs a push goes to: pushurl and insteadOf rewrites applied", (t) => {
	const { repo, git } = scratch(t);
	assert.deepEqual(pushUrlsOf(repo, "origin"), ["git@github.com:me/app.git"]);
	assert.deepEqual(urlRewritesOf(repo), []);
	git("remote", "add", "local", "../bare.git");
	git("config", "remote.local.pushurl", "https://example.invalid/x.git");
	assert.deepEqual(pushUrlsOf(repo, "local"), ["https://example.invalid/x.git"]);
	git("remote", "add", "rw", "../other.git");
	git("config", "url.https://example.invalid/.pushInsteadOf", "../other.git");
	assert.deepEqual(pushUrlsOf(repo, "rw"), ["https://example.invalid/"]);
	assert.deepEqual(urlRewritesOf(repo), ["../other.git"]);
	assert.equal(pushUrlsOf(repo, "nope"), undefined);
	assert.equal(pushUrlsOf(repo, "a b"), undefined);
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
	assert.equal(repoRootOf(repo), undefined, 'no budget: unknown, not "not a repo"');
	startBudget(60_000);
	assert.equal(dirtIn(repo, undefined, true), "clean");
	const path = process.env.PATH;
	t.after(() => {
		process.env.PATH = path;
	});
	process.env.PATH = "/nonexistent";
	assert.equal(dirtIn(repo, undefined, true), "unknown", "git can't run");
	assert.equal(branchOf(repo), undefined);
	assert.equal(repoRootOf(repo), undefined, 'git can\'t run: unknown, not "not a repo"');
	assert.equal(remoteUrlOf(repo, "origin"), undefined);
});

test("isCheckoutRef: branches, tags, commits and remote-tracking names are refs; a directory is not", (t) => {
	const { repo, git } = scratch(t);
	git("branch", "other");
	git("tag", "v1");
	assert.equal(isCheckoutRef(repo, "feat"), true);
	assert.equal(isCheckoutRef(repo, "other"), true);
	assert.equal(isCheckoutRef(repo, "v1"), true);
	assert.equal(isCheckoutRef(repo, "HEAD~0"), true);
	assert.equal(isCheckoutRef(repo, "src"), false, "a directory");
	assert.equal(isCheckoutRef(repo, "nosuch"), false);
	assert.equal(isCheckoutRef(repo, "-f"), undefined, "an option is never looked up");
	startBudget(0);
	t.after(() => startBudget(60_000));
	assert.equal(isCheckoutRef(repo, "feat"), undefined, "no budget: unknown");
});
