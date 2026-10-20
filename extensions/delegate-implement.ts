/**
 * delegate-implement — git-state tripwires for the `implement` role (docs/write-worker.md).
 * A worker's worktree shares refs, config, hooks, and Pi's settings with the main checkout, so the
 * extension snapshots them before spawn and compares after finish. Not a Pi extension; delegate.ts imports it.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type GitSnapshot = {
	// refname -> object id, under refs/heads, refs/tags, and refs/stash.
	refs: Map<string, string>;
	// The main checkout's current branch (`refs/heads/x`), undefined when detached, and its tip.
	branch?: string;
	tip?: string;
	// `git config --local --list` output.
	config: string;
	// sha256 over the common dir's hooks/ and info/ files.
	hooks: string;
};

// Branches a job may move: its own, and the main session's (main keeps working during a job).
const DELEGATE_BRANCH = /^refs\/heads\/delegate\//;
const SETTINGS_RESOURCES = ["packages", "extensions", "skills", "prompts", "themes"];

async function git(repoRoot: string, args: string[]): Promise<{ ok: boolean; code?: number; out: string }> {
	try {
		const { stdout } = await run("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
		return { ok: true, out: stdout };
	} catch (err) {
		const e = err as { code?: unknown; stdout?: unknown };
		return { ok: false, code: typeof e.code === "number" ? e.code : undefined, out: String(e.stdout ?? "") };
	}
}

// Output of a git command a tripwire depends on; throws so the caller can report the tripwire as unavailable.
async function gitOrThrow(repoRoot: string, args: string[], okCodes: number[] = []): Promise<string> {
	const res = await git(repoRoot, args);
	if (!res.ok && !(res.code !== undefined && okCodes.includes(res.code)))
		throw new Error(`git ${args.join(" ")} failed in ${repoRoot}`);
	return res.out;
}

// Every file or symlink under dir as [relative path, executable bits, content or link target]; a missing dir is empty.
async function filesIn(dir: string): Promise<[string, number, Buffer | string][]> {
	const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
	const paths = entries.filter((e) => e.isFile() || e.isSymbolicLink()).map((e) => join(e.parentPath, e.name));
	return Promise.all(
		paths.map(async (p): Promise<[string, number, Buffer | string]> => {
			const stat = await lstat(p);
			const content = stat.isSymbolicLink() ? `-> ${await readlink(p)}` : await readFile(p);
			return [relative(dir, p), stat.mode & 0o111, content];
		}),
	);
}

export async function snapshotGit(repoRoot: string): Promise<GitSnapshot> {
	const [refsOut, branchOut, config, commonDir] = await Promise.all([
		gitOrThrow(repoRoot, [
			"for-each-ref",
			"--format=%(refname) %(objectname)",
			"refs/heads",
			"refs/tags",
			"refs/stash",
		]),
		git(repoRoot, ["symbolic-ref", "-q", "HEAD"]),
		// Exit 1 with no output: no local entries.
		gitOrThrow(repoRoot, ["config", "--local", "--list"], [1]),
		gitOrThrow(repoRoot, ["rev-parse", "--git-common-dir"]),
	]);
	const refs = new Map(
		refsOut
			.split("\n")
			.filter(Boolean)
			.map((line) => line.split(" ") as [string, string]),
	);
	const branch = branchOut.ok ? branchOut.out.trim() : undefined;
	const common = resolve(repoRoot, commonDir.trim());
	const hash = createHash("sha256");
	for (const sub of ["hooks", "info"]) {
		const files = (await filesIn(join(common, sub))).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		for (const [path, mode, content] of files) hash.update(`${sub}/${path}\0${mode}\0`).update(content).update("\0");
	}
	return { refs, branch, tip: branch ? refs.get(branch) : undefined, config, hooks: hash.digest("hex") };
}

// Lines only in a, prefixed with sign.
const missingFrom = (a: string, b: string, sign: string) => {
	const other = new Set(b.split("\n"));
	return a
		.split("\n")
		.filter((l) => l && !other.has(l))
		.map((l) => `${sign}${l}`);
};
// Upstream tracking that the main session's `push -u` or `branch -u` writes.
const TRACKING = /^[-+]branch\..+\.(?:remote|merge)=/;

export async function gitTripwires(before: GitSnapshot, after: GitSnapshot, repoRoot: string): Promise<string[]> {
	const reasons: string[] = [];
	// The main session may commit on its branch or switch to another one during the job.
	const mainBranches = [...new Set([before.branch, after.branch])].filter((b): b is string => b !== undefined);
	for (const [ref, sha] of before.refs) {
		if (DELEGATE_BRANCH.test(ref) || mainBranches.includes(ref)) continue;
		const now = after.refs.get(ref);
		if (now === undefined) reasons.push(`${ref} was deleted during the job`);
		else if (now !== sha) reasons.push(`${ref} moved during the job (${sha.slice(0, 7)} -> ${now.slice(0, 7)})`);
	}
	for (const branch of mainBranches) {
		const old = before.refs.get(branch);
		if (old === undefined) continue;
		const now = after.refs.get(branch);
		if (now === undefined) reasons.push(`main branch ${branch} was deleted during the job`);
		else if (now !== old && !(await git(repoRoot, ["merge-base", "--is-ancestor", old, now])).ok)
			reasons.push(`main branch ${branch} moved to a non-descendant (${old.slice(0, 7)} -> ${now.slice(0, 7)})`);
	}
	// Tracking lines may be added or changed; removing one still flags.
	const added = missingFrom(after.config, before.config, "+");
	const keyOf = (l: string) => l.slice(1, l.indexOf("="));
	const changedKeys = new Set(added.map(keyOf));
	const diff = [
		...missingFrom(before.config, after.config, "-").filter((l) => !TRACKING.test(l) || !changedKeys.has(keyOf(l))),
		...added.filter((l) => !TRACKING.test(l)),
	];
	if (diff.length) reasons.push(`local git config changed: ${diff.join(", ")}`);
	if (before.hooks !== after.hooks) reasons.push("files under the git common dir's hooks/ or info/ changed");
	return reasons;
}

// The resource keys of Pi's settings.json as JSON; Pi also writes defaultModel and thinking there, which are ignored.
export async function settingsResources(
	agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
): Promise<string> {
	const raw = await readFile(join(agentDir, "settings.json"), "utf8").catch(() => "{}");
	let settings: Record<string, unknown> = {};
	try {
		settings = JSON.parse(raw) ?? {};
	} catch {
		// Unparseable: compare the raw text instead.
		return raw;
	}
	return JSON.stringify(Object.fromEntries(SETTINGS_RESOURCES.map((k) => [k, settings[k]])));
}

export function settingsTripwire(before: string, after: string): string[] {
	return before === after ? [] : [`Pi settings resources changed during the job: ${before} -> ${after}`];
}
