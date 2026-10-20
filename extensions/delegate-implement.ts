/**
 * delegate-implement — the `implement` role's worktree lifecycle (docs/write-worker.md): `prepare` adds a
 * `delegate/*` branch in a temp worktree, `finish` commits leftovers as WIP, reads the facts from git, checks the
 * tripwires, and removes the worktree; `formatFacts` renders the report. A worktree shares refs, config, hooks, and
 * Pi's settings with the main checkout, hence the snapshots. Not a Pi extension; delegate.ts imports it.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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

// Every git call is killed after this long, so a hung git (a lock, a slow filesystem) cannot stall finish.
export const GIT_LIMITS = { timeoutMs: 30_000 };

type GitResult = { ok: boolean; code?: number; out: string; err: string };

async function git(repoRoot: string, args: string[]): Promise<GitResult> {
	try {
		const { stdout, stderr } = await run("git", ["-C", repoRoot, ...args], {
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			timeout: GIT_LIMITS.timeoutMs,
		});
		return { ok: true, out: stdout, err: stderr };
	} catch (err) {
		const e = err as { code?: unknown; killed?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
		const code = typeof e.code === "number" ? e.code : undefined;
		const msg = e.killed
			? `git ${args[0]} timed out after ${GIT_LIMITS.timeoutMs} ms`
			: String(e.stderr || e.message || "").trim();
		return { ok: false, code, out: String(e.stdout ?? ""), err: msg };
	}
}

// Output of a git command the caller depends on; throws with git's message (a tripwire reports it as unavailable).
async function gitOrThrow(repoRoot: string, args: string[], okCodes: number[] = []): Promise<string> {
	const res = await git(repoRoot, args);
	if (!res.ok && !(res.code !== undefined && okCodes.includes(res.code)))
		throw new Error(`git ${args.join(" ")} failed in ${repoRoot}${res.err ? `: ${res.err}` : ""}`);
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

// --- Worktree lifecycle ---------------------------------------------------------------------------

// Shared by reloaded instances, like the background spend in delegate.ts, so ids never repeat in one Pi process.
const COUNT_KEY = Symbol.for("me-pi.delegate.implement-count");
const MAX_COMMITS = 20;
const MAX_STAT_LINES = 30;
const MAX_WIP_FILES = 20;

export function nextImplementId(): string {
	const shared = globalThis as any;
	shared[COUNT_KEY] = (shared[COUNT_KEY] ?? 0) + 1;
	return `im${shared[COUNT_KEY]}`;
}

export type Worktree = {
	id: string;
	repoRoot: string;
	// The cwd inside the repo (`extensions/`, or empty), so the worker starts at the same place.
	prefix: string;
	dir: string;
	workerCwd: string;
	branch: string;
	// The diff runs base..tip; the commit list start..tip (they differ when continuing a branch).
	base: string;
	start: string;
	continued: boolean;
	// Uncommitted files in the main tree; the worker does not get them.
	dirty: number;
	gitBefore: GitSnapshot;
	settingsBefore: string;
	// An empty 0700 dir for GH_CONFIG_DIR, so gh in the worker finds no login; removed by finish.
	ghConfigDir: string;
};

export type Facts = {
	id: string;
	branch: string;
	base: string;
	continued: boolean;
	tip?: string;
	commits: string[];
	commitCount: number;
	diffstat: { summary: string; lines: string[]; more: number };
	diffPath?: string;
	wip?: { sha: string; reason: string; files: string[]; more: number };
	worktree: { removed: boolean; dir: string; reason?: string };
	// ✗ lines other than WIP and the kept worktree, without the ✗.
	problems: string[];
	failed: boolean;
};

const pad = (n: number) => String(n).padStart(2, "0");
// Local time, `YYYYMMDD-HHMMSS`: the counter restarts per Pi process, so the time keeps names unique.
function stamp(d = new Date()): string {
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// Git text with control characters quoted, so it cannot add lines to the result (as listOutput does).
const shown = (text: string) => (/[\x00-\x1f\x7f]/.test(text) ? JSON.stringify(text) : text);

export async function prepare(cwd: string, id: string, branch?: string): Promise<Worktree> {
	const head = await git(cwd, ["rev-parse", "--show-toplevel", "--show-prefix", "HEAD"]);
	if (!head.ok) throw new Error(`implement needs a git repository with a commit at ${cwd}: ${head.err}`);
	const [repoRoot, prefix, headSha] = head.out.split("\n");
	if (branch !== undefined) {
		if (!branch.startsWith("delegate/")) throw new Error(`branch must start with delegate/: ${branch}`);
		if (!(await git(repoRoot, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`])).ok)
			throw new Error(`no such branch: ${branch}`);
	}
	const name = branch ?? `delegate/${stamp()}-${id}`;
	// Everything fallible runs before the worktree exists, so a refusal leaves nothing behind.
	const start =
		branch === undefined ? headSha : (await gitOrThrow(repoRoot, ["rev-parse", `refs/heads/${name}`])).trim();
	const base = branch === undefined ? headSha : (await gitOrThrow(repoRoot, ["merge-base", "HEAD", name])).trim();
	const [status, gitBefore, settingsBefore] = await Promise.all([
		gitOrThrow(repoRoot, ["status", "--porcelain"]),
		snapshotGit(repoRoot),
		settingsResources(),
	]);
	const dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "me-pi-delegate-wt-"));
	let ghConfigDir: string;
	try {
		ghConfigDir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "me-pi-delegate-gh-"));
	} catch (err) {
		await rmdir(dir).catch(() => {});
		throw err;
	}
	const add = await git(
		repoRoot,
		branch === undefined ? ["worktree", "add", "-q", "-b", name, dir, headSha] : ["worktree", "add", "-q", dir, name],
	);
	if (!add.ok) {
		// A half-done add may have registered the worktree or created the branch; undo only what this call made.
		await git(repoRoot, ["worktree", "remove", dir]);
		if (branch === undefined) {
			const tip = await git(repoRoot, ["rev-parse", "--verify", "-q", `refs/heads/${name}`]);
			if (tip.ok && tip.out.trim() === headSha) await git(repoRoot, ["branch", "-D", name]);
		}
		await rmdir(dir).catch(() => {});
		await rmdir(ghConfigDir).catch(() => {});
		throw new Error(`git worktree add failed for ${dir}: ${add.err}`);
	}
	return {
		id,
		repoRoot,
		prefix,
		dir,
		workerCwd: join(dir, prefix),
		branch: name,
		base,
		start,
		continued: branch !== undefined,
		dirty: status.split("\n").filter(Boolean).length,
		gitBefore,
		settingsBefore,
		ghConfigDir,
	};
}

const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
const CUT_PROTOCOLS = ["ssh", "https", "http", "git"];

/**
 * The implement worker's environment: writes fenced to the worktree (ME_PI_OUTPUT_DIR), git remotes cut off by
 * appending `protocol.<p>.allow=never` after any GIT_CONFIG_* the user set, and gh without a login. These
 * prevent accidents, not misuse: `git -c` and `env -u` undo them. Provider keys stay; Pi needs them.
 */
export function workerEnv(env: NodeJS.ProcessEnv, wt: Worktree): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = { ...env, ME_PI_ROLE: "implement", ME_PI_OUTPUT_DIR: wt.dir };
	for (const name of TOKEN_VARS) delete out[name];
	out.GH_CONFIG_DIR = wt.ghConfigDir;
	const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10);
	let i = Number.isFinite(count) && count > 0 ? count : 0;
	for (const protocol of CUT_PROTOCOLS) {
		out[`GIT_CONFIG_KEY_${i}`] = `protocol.${protocol}.allow`;
		out[`GIT_CONFIG_VALUE_${i}`] = "never";
		i++;
	}
	out.GIT_CONFIG_COUNT = String(i);
	return out;
}

/** Whether the worktree's trust-relevant files (`.pi`, `.agents`) equal the base, tracked and untracked. */
export async function trustFilesUnchanged(wt: Worktree): Promise<boolean> {
	const [diff, status] = await Promise.all([
		git(wt.dir, ["diff", "--quiet", wt.base, "--", ".pi", ".agents"]),
		git(wt.dir, ["status", "--porcelain", "--", ".pi", ".agents"]),
	]);
	return diff.ok && status.ok && !status.out.trim();
}

// Lines of output, capped; returns the shown lines and how many were left out.
function capped(text: string, max: number): [string[], number] {
	const lines = text.split("\n").filter(Boolean);
	return [lines.slice(0, max), Math.max(0, lines.length - max)];
}

export async function finish(wt: Worktree, reason?: string): Promise<Facts> {
	const facts: Facts = {
		id: wt.id,
		branch: wt.branch,
		base: wt.base,
		continued: wt.continued,
		commits: [],
		commitCount: 0,
		diffstat: { summary: "", lines: [], more: 0 },
		worktree: { removed: false, dir: wt.dir },
		problems: [],
		failed: false,
	};
	// 1. The worker must still be on the job's branch, and the branch must exist, or a WIP commit would land elsewhere.
	const head = await git(wt.dir, ["symbolic-ref", "-q", "HEAD"]);
	const branchRef = await git(wt.repoRoot, ["rev-parse", "--verify", "-q", `refs/heads/${wt.branch}`]);
	let keep: string | undefined;
	if (!head.ok) {
		// Exit 1 means detached; anything else is an error, not a claim about HEAD.
		facts.problems.push(
			head.code === 1
				? `worktree HEAD is detached, not ${wt.branch}`
				: `worktree HEAD unreadable: ${head.err || "git symbolic-ref failed"}`,
		);
		keep = "HEAD is not on the job's branch";
	} else if (head.out.trim() !== `refs/heads/${wt.branch}`) {
		facts.problems.push(`worktree HEAD is ${head.out.trim()}, not ${wt.branch}`);
		keep = "HEAD is not on the job's branch";
	} else if (!branchRef.ok) {
		facts.problems.push(`branch ${wt.branch} is gone: ${branchRef.err || "not found"}`);
		keep = "the job's branch is gone";
	} else {
		// 2. Leftovers become one WIP commit; ignored files are not added. Hooks and signing are off: this commit
		// only saves work, and a worker may have set core.hooksPath.
		const status = await git(wt.dir, ["status", "--porcelain"]);
		if (!status.ok) keep = `git status failed: ${status.err}`;
		else if (status.out.trim()) {
			const why = reason ?? "left uncommitted by the worker";
			const [files, more] = capped(status.out.replace(/^.{3}/gm, ""), MAX_WIP_FILES);
			const add = await git(wt.dir, ["add", "-A"]);
			const commit = add.ok
				? await git(wt.dir, [
						"-c",
						"core.hooksPath=/dev/null",
						"-c",
						"commit.gpgsign=false",
						"commit",
						"-q",
						"--no-verify",
						"-m",
						`WIP(delegate ${wt.id}): ${why}`,
					])
				: add;
			if (!commit.ok) keep = `WIP commit failed: ${commit.err}`;
			else {
				const sha = await git(wt.dir, ["rev-parse", "--short", "HEAD"]);
				if (!sha.ok) facts.problems.push(`WIP commit made, but its sha is unreadable: ${sha.err}`);
				facts.wip = { sha: sha.ok ? sha.out.trim() : "(unknown)", reason: why, files: files.map(shown), more };
			}
		}
	}
	// 3. Facts, read from git.
	const tip = await git(wt.repoRoot, ["rev-parse", "--verify", "-q", `refs/heads/${wt.branch}`]);
	if (!tip.ok) {
		if (branchRef.ok) facts.problems.push(`branch ${wt.branch} is gone: ${tip.err || "not found"}`);
	} else {
		const sha = tip.out.trim();
		facts.tip = sha;
		if (!(await git(wt.repoRoot, ["merge-base", "--is-ancestor", wt.start, sha])).ok)
			facts.problems.push(`branch no longer contains its start ${wt.start.slice(0, 7)}`);
		const log = await git(wt.repoRoot, ["log", "--reverse", "--format=%h %s", `${wt.start}..${sha}`]);
		if (!log.ok) facts.problems.push(`git log failed: ${log.err}`);
		const [commits, moreCommits] = capped(log.out, MAX_COMMITS);
		facts.commits = commits.map(shown);
		facts.commitCount = commits.length + moreCommits;
		const statRes = await git(wt.repoRoot, ["diff", "--stat", `${wt.base}..${sha}`]);
		if (!statRes.ok) facts.problems.push(`git diff --stat failed: ${statRes.err}`);
		const stat = statRes.out.split("\n").filter(Boolean);
		const summary = stat.pop()?.trim() ?? "";
		facts.diffstat = {
			summary: summary || "no changes",
			lines: stat.slice(0, MAX_STAT_LINES).map((l) => shown(l.trim())),
			more: Math.max(0, stat.length - MAX_STAT_LINES),
		};
		// Git writes the diff straight into a file that is 0600 before any content lands, never through memory.
		try {
			const dir = join(tmpdir(), `me-pi-delegate-${process.pid}`);
			await mkdir(dir, { recursive: true, mode: 0o700 });
			const path = join(dir, `${wt.id}.diff`);
			await writeFile(path, "", { mode: 0o600 });
			await chmod(path, 0o600);
			const diff = await git(wt.repoRoot, ["diff", "--no-ext-diff", `--output=${path}`, `${wt.base}..${sha}`]);
			if (diff.ok) facts.diffPath = path;
			else facts.problems.push(`diff not saved: ${diff.err}`);
		} catch (err) {
			facts.problems.push(`diff not saved: ${(err as Error).message}`);
		}
	}
	// 4. Tripwires against fresh snapshots.
	try {
		const [gitAfter, settingsAfter] = await Promise.all([snapshotGit(wt.repoRoot), settingsResources()]);
		const trips = [
			...(await gitTripwires(wt.gitBefore, gitAfter, wt.repoRoot)),
			...settingsTripwire(wt.settingsBefore, settingsAfter),
		];
		facts.problems.push(...trips.map((t) => `Tripwire: ${t}`));
	} catch (err) {
		facts.problems.push(`Tripwire: tripwire unavailable: ${(err as Error).message}`);
	}
	// 5. Remove the worktree; git refuses one with untracked files, which are kept for the user.
	if (keep === undefined) {
		const removed = await git(wt.repoRoot, ["worktree", "remove", wt.dir]);
		if (removed.ok) facts.worktree.removed = true;
		else keep = removed.err || "git worktree remove failed";
	}
	facts.worktree.reason = keep;
	await rm(wt.ghConfigDir, { recursive: true, force: true }).catch(() => {});
	facts.failed = facts.wip !== undefined || facts.problems.length > 0 || !facts.worktree.removed;
	return facts;
}

export function formatFacts(f: Facts): string {
	const short = (sha: string) => sha.slice(0, 7);
	const lines = [
		`Branch: ${f.branch} @ ${f.tip ? short(f.tip) : "(missing)"} (${f.continued ? `continued as ${f.id}; base ${short(f.base)}, merge-base with your HEAD` : `base ${short(f.base)}, your HEAD at start`})`,
		`Commits (${f.commitCount}, oldest first):`,
		...f.commits.map((c) => `  ${c}`),
	];
	if (f.commitCount > f.commits.length) lines.push(`  \u2026 ${f.commitCount - f.commits.length} more`);
	lines.push(`Diffstat: ${f.diffstat.summary}`, ...f.diffstat.lines.map((l) => `  ${l}`));
	if (f.diffstat.more) lines.push(`  \u2026 ${f.diffstat.more} more`);
	if (f.diffPath) lines.push(`Diff: ${f.diffPath} (0600, base..tip)`);
	lines.push(`Worktree: ${f.worktree.removed ? "removed" : `kept at ${f.worktree.dir}`}`);
	if (f.wip) {
		const files = f.wip.files.join(", ") + (f.wip.more ? `, \u2026 ${f.wip.more} more` : "");
		lines.push(
			`\u2717 WIP ${f.wip.sha} (${shown(f.wip.reason)}): ${files}. Do not merge; continue with branch: "${f.branch}".`,
		);
	}
	lines.push(...f.problems.map((p) => `\u2717 ${shown(p)}`));
	if (!f.worktree.removed) lines.push(`\u2717 Worktree kept at ${f.worktree.dir}: ${shown(f.worktree.reason ?? "")}`);
	return lines.join("\n");
}
