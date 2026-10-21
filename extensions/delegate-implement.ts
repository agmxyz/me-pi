/**
 * delegate-implement — the `implement` role's checkout lifecycle: `prepare` refuses unless the coordinator's checkout
 * is a clean, non-main branch and takes a per-repo lock; `finish` commits leftovers as WIP on that branch, reads the
 * commits from git, checks the tripwires, writes a details file, and releases the lock; `formatHandback` renders the
 * 2-line tool result. The worker writes in the real checkout, so the snapshots watch what it must not touch.
 * Not a Pi extension; delegate.ts imports it.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { link, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { PROTECTED_BRANCHES } from "./guard.ts";

const run = promisify(execFile);

export type GitSnapshot = {
	// refname -> object id, under refs/heads, refs/tags, and refs/stash (refs/remotes is not watched: fetch moves it).
	refs: Map<string, string>;
	// `git config --local --list` output.
	config: string;
	// sha256 over the common dir's hooks/ and info/ files.
	hooks: string;
};

const SETTINGS_RESOURCES = ["packages", "extensions", "skills", "prompts", "themes"];
const LOCK_NAME = "me-pi-implement.lock";
// A commit older than the job start minus this is not the worker's: the branch was fast-forwarded to existing work.
const CLOCK_SKEW_MS = 60_000;

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
	const [refsOut, config, commonDir] = await Promise.all([
		gitOrThrow(repoRoot, [
			"for-each-ref",
			"--format=%(refname) %(objectname)",
			"refs/heads",
			"refs/tags",
			"refs/stash",
		]),
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
	const common = resolve(repoRoot, commonDir.trim());
	const hash = createHash("sha256");
	for (const sub of ["hooks", "info"]) {
		const files = (await filesIn(join(common, sub))).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		for (const [path, mode, content] of files) hash.update(`${sub}/${path}\0${mode}\0`).update(content).update("\0");
	}
	return { refs, config, hooks: hash.digest("hex") };
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

/** What changed between the snapshots that a job must not change. Only `branch` (`refs/heads/x`) may move; new refs are fine. */
export function gitTripwires(before: GitSnapshot, after: GitSnapshot, branch: string): string[] {
	const reasons: string[] = [];
	for (const [ref, sha] of before.refs) {
		if (ref === branch) continue;
		const now = after.refs.get(ref);
		if (now === undefined) reasons.push(`${ref} was deleted during the job`);
		else if (now !== sha) reasons.push(`${ref} moved during the job (${sha.slice(0, 7)} -> ${now.slice(0, 7)})`);
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

// --- Checkout lifecycle ---------------------------------------------------------------------------

// Shared by reloaded instances, like the background spend in delegate.ts, so ids never repeat in one Pi process.
const COUNT_KEY = Symbol.for("me-pi.delegate.implement-count");
const MAX_COMMITS = 20;
const MAX_WIP_FILES = 20;
const MAX_BLOCKED = 3;
const FIRST_LINE_CAP = 200;

export function nextImplementId(): string {
	const shared = globalThis as any;
	shared[COUNT_KEY] = (shared[COUNT_KEY] ?? 0) + 1;
	return `im${shared[COUNT_KEY]}`;
}

/** Whether the worker ran `check` after its last edit: none (never ran), pass, fail, or stale (edited after). */
export type CheckState = { command: string; status: "none" | "pass" | "fail" | "stale"; runs: string[] };

export type Checkout = {
	id: string;
	repoRoot: string;
	// The git common dir: the worker may not write inside it, and the lock lives there.
	commonDir: string;
	// `refs/heads/x` and `x`.
	ref: string;
	branch: string;
	base: string;
	startedAt: number;
	// HEAD's subject starts with `WIP(delegate`: an earlier attempt left work the worker should finish first.
	wipHead: boolean;
	check: CheckState;
	gitBefore: GitSnapshot;
	settingsBefore: string;
	lockPath: string;
	// TMPDIR at prepare: finish writes the details file here even if the environment changed since.
	tmpRoot: string;
	// An empty 0700 dir for GH_CONFIG_DIR, so gh in the worker finds no login; removed by finish.
	ghConfigDir: string;
};

/** What the worker run produced, for the details file and the handback. */
export type Outcome = {
	// Why the run ended without an answer (stopped, cancelled, an error); also the WIP reason.
	failure?: string;
	answer?: string;
	// `[model @thinking $cost 12s]`.
	label?: string;
	tools?: string[];
	fallbacks?: string[];
	stderr?: string;
};

export type Facts = {
	id: string;
	branch: string;
	base: string;
	tip?: string;
	// `sha subject`, oldest first, capped; commitCount is the full count.
	commits: string[];
	commitCount: number;
	files: number;
	insertions: number;
	deletions: number;
	stat: string;
	wip?: { sha: string; reason: string; files: string[]; more: number };
	// ✗ lines other than WIP and the check, without the ✗.
	problems: string[];
	check: CheckState;
	outcome: Outcome;
	detailsPath?: string;
	failed: boolean;
};

// Git and worker text with control characters quoted, so it cannot add lines to the result (as listOutput does).
const shown = (text: string) => (/[\x00-\x1f\x7f]/.test(text) ? JSON.stringify(text) : text);

const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		return err?.code === "EPERM";
	}
};

// `<pid> <id>`, or undefined when the content is empty or unparseable (treated as live: a holder may be writing it).
const lockHolder = (content: string) => {
	const m = content.trim().match(/^(\d+) (\S+)$/);
	return m ? { pid: Number(m[1]), id: m[2] } : undefined;
};

// Links a fully written temp file to the lock path: the lock appears atomically, with its content, or not at all.
async function linkLock(lockPath: string, id: string): Promise<void> {
	const temp = `${lockPath}.${process.pid}.${id}.tmp`;
	await writeFile(temp, `${process.pid} ${id}\n`, { mode: 0o600 });
	try {
		await link(temp, lockPath);
	} finally {
		await rm(temp, { force: true });
	}
}

// Takes the per-repo lock; a lock whose pid is dead is taken over, a live or unreadable one refuses. A takeover
// renames the stale lock aside and re-checks it, so two takeovers cannot both win.
async function takeLock(lockPath: string, id: string, repoRoot: string): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await linkLock(lockPath, id);
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;
		}
		const content = await readFile(lockPath, "utf8").catch(() => undefined);
		if (content === undefined) continue; // Released meanwhile.
		const holder = lockHolder(content);
		if (!holder || isAlive(holder.pid))
			throw new Error(
				holder
					? `implement job ${holder.id} (pid ${holder.pid}) is already writing in ${repoRoot}; wait for its handback`
					: `${lockPath} is unreadable; another implement job may be starting in ${repoRoot}. Remove it only if none runs.`,
			);
		const aside = `${lockPath}.${process.pid}.${id}.stale`;
		try {
			await rename(lockPath, aside);
		} catch (err: any) {
			if (err?.code === "ENOENT") continue;
			throw err;
		}
		const moved = await readFile(aside, "utf8").catch(() => "");
		if (moved !== content) {
			// Another takeover won between the read and the rename: put its lock back.
			await link(aside, lockPath).catch(() => {});
			await rm(aside, { force: true });
			throw new Error(`another implement job just took the lock in ${repoRoot}; wait for its handback`);
		}
		await rm(aside, { force: true });
	}
	throw new Error(`could not take ${lockPath}`);
}

async function releaseLock(lockPath: string, id: string): Promise<void> {
	const content = await readFile(lockPath, "utf8").catch(() => "");
	if (content.trim().split(" ")[1] === id) await rm(lockPath, { force: true });
}

// A failure's first line, capped: the WIP subject and the ✗ line.
const failureLine = (failure: string | undefined) =>
	failure?.trim() ? failure.trim().split("\n")[0].slice(0, FIRST_LINE_CAP) : undefined;

// Paths under the git dir that mean an operation is in progress.
const IN_PROGRESS = [
	["MERGE_HEAD", "a merge"],
	["rebase-merge", "a rebase"],
	["rebase-apply", "a rebase or am"],
	["CHERRY_PICK_HEAD", "a cherry-pick"],
	["REVERT_HEAD", "a revert"],
];

/** Refuses, leaving nothing behind, unless `cwd` is a clean checkout on a non-main branch with no job writing in it. */
export async function prepare(cwd: string, id: string, check: string): Promise<Checkout> {
	const dirs = await git(cwd, [
		"rev-parse",
		"--path-format=absolute",
		"--show-toplevel",
		"--git-dir",
		"--git-common-dir",
	]);
	const head = dirs.ok ? await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]) : dirs;
	if (!head.ok)
		throw new Error(`implement needs a git repository with a commit at ${cwd}${head.err ? `: ${head.err}` : ""}`);
	const [repoRoot, gitDir, commonDir] = dirs.out.split("\n");
	const base = head.out.trim();
	const symbolic = await git(repoRoot, ["symbolic-ref", "-q", "HEAD"]);
	if (!symbolic.ok)
		throw new Error("implement needs HEAD on a branch, not detached; `git switch -c goal/<slug>` first");
	const ref = symbolic.out.trim();
	const branch = ref.replace(/^refs\/heads\//, "");
	if (PROTECTED_BRANCHES.has(branch))
		throw new Error(`implement does not commit on ${branch}; \`git switch -c goal/<slug>\` first`);
	// The lock first, so a job already writing here is named rather than reported as a dirty tree.
	const lockPath = join(commonDir, LOCK_NAME);
	await takeLock(lockPath, id, repoRoot);
	try {
		const busy = IN_PROGRESS.find(([path]) => existsSync(join(gitDir, path)));
		if (busy) throw new Error(`${busy[1]} is in progress in ${repoRoot}; finish or abort it first`);
		const status = await gitOrThrow(repoRoot, ["status", "--porcelain"]);
		if (status.trim())
			throw new Error(
				`implement needs a clean tree; commit your work first (${status.split("\n").filter(Boolean).length} changed or untracked file(s))`,
			);
		const [gitBefore, settingsBefore, subject] = await Promise.all([
			snapshotGit(repoRoot),
			settingsResources(),
			gitOrThrow(repoRoot, ["log", "-1", "--format=%s"]),
		]);
		const tmpRoot = process.env.TMPDIR || tmpdir();
		const ghConfigDir = await mkdtemp(join(tmpRoot, "me-pi-delegate-gh-"));
		return {
			id,
			repoRoot,
			commonDir,
			ref,
			branch,
			base,
			startedAt: Date.now(),
			wipHead: subject.startsWith("WIP(delegate"),
			check: { command: check, status: "none", runs: [] },
			gitBefore,
			settingsBefore,
			lockPath,
			tmpRoot,
			ghConfigDir,
		};
	} catch (err) {
		await releaseLock(lockPath, id);
		throw err;
	}
}

// A command as the check compares it: whitespace collapsed, a leading `rtk ` and a trailing `2>&1` dropped.
const normalized = (command: string) =>
	command
		.trim()
		.replace(/\s+/g, " ")
		.replace(/^rtk /, "")
		.replace(/ ?2>&1$/, "");

/** A path through its symlinks (macOS /tmp is /private/tmp), or as given when it does not exist. */
export function realpathOr(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path; // Missing path: nothing to resolve; the tool reports it.
	}
}

// One leading `cd <dir> &&` or `cd <dir>;`, `<dir>` bare or quoted.
const LEADING_CD = /^\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|'"]+)\s*(&&|;)\s*/;
// Shell expansion in a bare or double-quoted dir: the dir it names is not the text.
const EXPANDS = /[$`\\~*?[]/;

/**
 * Whether a bash command is the job's check, run alone from `cwd`: one leading `cd <dir> &&` (or `;`) is allowed
 * when `<dir>` is literal and resolves to `cwd` (under `&&`, it must exist); any other pipe or `;`/`&&`/`||` chain
 * never counts.
 */
export function isCheckRun(command: string, check: string, cwd: string): boolean {
	const cd = LEADING_CD.exec(command);
	if (cd) {
		const [whole, raw, sep] = cd;
		if (!raw.startsWith("'") && EXPANDS.test(raw)) return false;
		const given = raw.replace(/^(["'])(.*)\1$/, "$2");
		// Unnormalized, as the shell walks it: `missing/..` fails there.
		if (sep === "&&" && !existsSync(isAbsolute(given) ? given : `${cwd}/${given}`)) return false;
		const dir = resolve(cwd, given);
		if (realpathOr(dir) !== realpathOr(resolve(cwd))) return false;
		command = command.slice(whole.length);
	}
	if (/[|;&]/.test(command.replace(/ ?2>&1\s*$/, ""))) return false;
	return normalized(command) === normalized(check);
}

const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
const CUT_PROTOCOLS = ["ssh", "https", "http", "git"];

/**
 * The implement worker's environment: writes fenced to the repo (ME_PI_OUTPUT_DIR) and out of the git dir
 * (ME_PI_DENY_DIR), an orphan stop (ME_PI_PARENT), git remotes cut off by appending `protocol.<p>.allow=never` after
 * any GIT_CONFIG_* the user set, and gh without a login. These prevent accidents, not misuse: `git -c` and `env -u`
 * undo them. Provider keys stay; Pi needs them.
 */
export function workerEnv(env: NodeJS.ProcessEnv, job: Checkout): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {
		...env,
		ME_PI_ROLE: "implement",
		ME_PI_OUTPUT_DIR: job.repoRoot,
		ME_PI_DENY_DIR: job.commonDir,
		ME_PI_PARENT: String(process.pid),
	};
	for (const name of TOKEN_VARS) delete out[name];
	out.GH_CONFIG_DIR = job.ghConfigDir;
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

// Lines of output, capped; returns the shown lines and how many were left out.
function capped(text: string, max: number): [string[], number] {
	const lines = text.split("\n").filter(Boolean);
	return [lines.slice(0, max), Math.max(0, lines.length - max)];
}

const num = (text: string, word: string) => Number(text.match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0);

/** Ends a job; never throws. Commits leftovers as WIP on the job's branch, checks the range and tripwires. */
export async function finish(job: Checkout, outcome: Outcome = {}): Promise<Facts> {
	const facts: Facts = {
		id: job.id,
		branch: job.branch,
		base: job.base,
		commits: [],
		commitCount: 0,
		files: 0,
		insertions: 0,
		deletions: 0,
		stat: "",
		problems: [],
		check: job.check,
		outcome,
		failed: true,
	};
	try {
		await finishSteps(job, facts);
	} catch (err) {
		facts.problems.push(`finish failed: ${(err as Error).message}`);
	}
	try {
		facts.detailsPath = await writeDetails(facts, job.tmpRoot);
	} catch (err) {
		facts.problems.push(`details not saved: ${(err as Error).message}`);
	}
	await releaseLock(job.lockPath, job.id).catch(() => {});
	await rm(job.ghConfigDir, { recursive: true, force: true }).catch(() => {});
	facts.failed =
		Boolean(outcome.failure) ||
		!outcome.answer?.trim() ||
		facts.wip !== undefined ||
		facts.problems.length > 0 ||
		job.check.status !== "pass";
	return facts;
}

async function finishSteps(job: Checkout, facts: Facts): Promise<void> {
	// 1. HEAD must still be on the job's branch, or a WIP commit would land elsewhere.
	const head = await git(job.repoRoot, ["symbolic-ref", "-q", "HEAD"]);
	if (!head.ok)
		facts.problems.push(
			head.code === 1
				? `HEAD moved: detached, not ${job.branch}; no WIP commit`
				: `HEAD unreadable: ${head.err || "git symbolic-ref failed"}; no WIP commit`,
		);
	else if (head.out.trim() !== job.ref)
		facts.problems.push(`HEAD moved: now ${head.out.trim()}, not ${job.branch}; no WIP commit`);
	else {
		// 2. Leftovers become one WIP commit; ignored files are not added. Hooks and signing are off: this commit
		// only saves work, and a worker may have set core.hooksPath.
		const status = await git(job.repoRoot, ["status", "--porcelain"]);
		if (!status.ok) facts.problems.push(`git status failed: ${status.err}`);
		else if (status.out.trim()) {
			const why = failureLine(facts.outcome.failure) ?? "left uncommitted by the worker";
			const [files, more] = capped(status.out.replace(/^.{3}/gm, ""), MAX_WIP_FILES);
			const add = await git(job.repoRoot, ["add", "-A"]);
			const commit = add.ok
				? await git(job.repoRoot, [
						"-c",
						"core.hooksPath=/dev/null",
						"-c",
						"commit.gpgsign=false",
						"commit",
						"-q",
						"--no-verify",
						"-m",
						`WIP(delegate ${job.id}): ${why}`,
					])
				: add;
			if (!commit.ok) facts.problems.push(`WIP commit failed: ${commit.err}; the tree is left dirty`);
			else {
				const sha = await git(job.repoRoot, ["rev-parse", "--short", "HEAD"]);
				if (!sha.ok) facts.problems.push(`WIP commit made, but its sha is unreadable: ${sha.err}`);
				facts.wip = { sha: sha.ok ? sha.out.trim() : "(unknown)", reason: why, files: files.map(shown), more };
			}
		}
	}
	// 3. The range, read from git: it must descend from the base and hold only new, non-merge commits.
	const tip = await git(job.repoRoot, ["rev-parse", "--verify", "-q", job.ref]);
	if (!tip.ok) facts.problems.push(`branch ${job.branch} is gone: ${tip.err || "not found"}`);
	else {
		const sha = tip.out.trim();
		facts.tip = sha;
		if (!(await git(job.repoRoot, ["merge-base", "--is-ancestor", job.base, sha])).ok)
			facts.problems.push(`${job.branch} no longer descends from the base ${job.base.slice(0, 7)}`);
		// `%h %p %ct %s`, NUL-separated: `%p` is one parent, or several for a merge.
		const log = await git(job.repoRoot, [
			"log",
			"--reverse",
			"--format=%h%x00%p%x00%ct%x00%s",
			`${job.base}..${sha}`,
		]);
		if (!log.ok) facts.problems.push(`git log failed: ${log.err}`);
		const commits = log.out.split("\n").filter(Boolean);
		const oldest = (job.startedAt - CLOCK_SKEW_MS) / 1000;
		const merges: string[] = [];
		const old: string[] = [];
		const listed = commits.map((line) => {
			const [hash, parents, time, subject] = line.split("\0");
			if (parents.split(" ").length > 1) merges.push(hash);
			if (Number(time) < oldest) old.push(hash);
			return `${hash} ${subject}`;
		});
		if (merges.length) facts.problems.push(`merge commit(s) in the range: ${merges.join(", ")}`);
		if (old.length)
			facts.problems.push(`commit(s) older than the job (fast-forward to existing work?): ${old.join(", ")}`);
		facts.commits = listed.slice(0, MAX_COMMITS).map(shown);
		facts.commitCount = listed.length;
		const short = await git(job.repoRoot, ["diff", "--shortstat", `${job.base}..${sha}`]);
		const stat = await git(job.repoRoot, ["diff", "--stat", `${job.base}..${sha}`]);
		if (!short.ok || !stat.ok) facts.problems.push(`git diff --stat failed: ${short.err || stat.err}`);
		facts.files = num(short.out, "files? changed");
		facts.insertions = num(short.out, "insertions?");
		facts.deletions = num(short.out, "deletions?");
		facts.stat = stat.out;
		// 4. Files Pi loads on /reload: the coordinator reviews them before reloading.
		const trust = await git(job.repoRoot, ["diff", "--name-only", `${job.base}..${sha}`, "--", ".pi", ".agents"]);
		if (!trust.ok) facts.problems.push(`Tripwire: git diff .pi .agents failed: ${trust.err}`);
		else if (trust.out.trim())
			facts.problems.push(
				`Tripwire: .pi or .agents changed (${capped(trust.out, 5)[0].map(shown).join(", ")}); review before /reload`,
			);
	}
	try {
		const [gitAfter, settingsAfter] = await Promise.all([snapshotGit(job.repoRoot), settingsResources()]);
		const trips = [
			...gitTripwires(job.gitBefore, gitAfter, job.ref),
			...settingsTripwire(job.settingsBefore, settingsAfter),
		];
		facts.problems.push(...trips.map((t) => `Tripwire: ${t}`));
	} catch (err) {
		facts.problems.push(`Tripwire: tripwire unavailable: ${(err as Error).message}`);
	}
}

// 5. Everything the handback leaves out, in a 0600 file the coordinator reads only when it needs to.
async function writeDetails(f: Facts, tmpRoot: string): Promise<string> {
	const dir = join(tmpRoot, `me-pi-delegate-${process.pid}`);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, `${f.id}.md`);
	const o = f.outcome;
	const section = (title: string, body: string | undefined) =>
		body?.trim() ? [`## ${title}`, "", body.trim(), ""] : [];
	const text = [
		`# ${f.id} ${f.branch} ${f.base.slice(0, 7)}..${f.tip?.slice(0, 7) ?? "(missing)"} ${o.label ?? ""}`.trim(),
		"",
		...section(
			"Problems",
			[...(f.wip ? [`WIP ${f.wip.sha} (${f.wip.reason}): ${f.wip.files.join(", ")}`] : []), ...f.problems].join(
				"\n",
			),
		),
		...section(`Commits (${f.commitCount}, oldest first)`, f.commits.join("\n")),
		...section("Diffstat", f.stat),
		...section(`Check \`${f.check.command}\`: ${f.check.status}`, f.check.runs.join("\n") || "(not run)"),
		...section("Failure", o.failure),
		...section("Answer", o.answer),
		...section("Tools", o.tools?.join("\n")),
		...section("Fallbacks", o.fallbacks?.join("\n")),
		...section("Stderr (tail)", o.stderr),
	].join("\n");
	await writeFile(path, text, { mode: 0o600 });
	return path;
}

const CHECK_MARKS = { pass: "✓", fail: "✗", stale: "stale (edited after)", none: "not run" };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The tool result: a facts line, the worker's first line with the details path, then BLOCKED and ✗ lines. */
export function formatHandback(f: Facts): string {
	const o = f.outcome;
	const range = `${f.base.slice(0, 7)}..${f.tip?.slice(0, 7) ?? "(missing)"}`;
	const stat = `${plural(f.commitCount, "commit")}, ${plural(f.files, "file")} +${f.insertions} -${f.deletions}`;
	const check = `check ${CHECK_MARKS[f.check.status]} \`${shown(f.check.command)}\``;
	const head = `${f.failed ? "✗" : "✓"} ${f.id} ${f.branch} ${range}: ${stat}; ${check}${o.label ? ` ${o.label}` : ""}`;
	const lines = (o.answer ?? "").split("\n").map((l) => l.trim());
	const first = shown((lines.find((l) => l && !l.startsWith("BLOCKED:")) ?? "(no answer)").slice(0, FIRST_LINE_CAP));
	const details = f.detailsPath ? `${/[.!?]$/.test(first) ? "" : "."} Details: ${f.detailsPath}` : "";
	const blocked = lines.filter((l) => l.startsWith("BLOCKED:"));
	const out = [
		head,
		`${first}${details}`,
		...blocked.slice(0, MAX_BLOCKED).map((l) => shown(l.slice(0, FIRST_LINE_CAP))),
	];
	if (blocked.length > MAX_BLOCKED) out.push(`+${blocked.length - MAX_BLOCKED} more BLOCKED in details`);
	const failure = failureLine(o.failure);
	if (failure) out.push(`✗ ${shown(failure)}`);
	if (f.wip) {
		const files = f.wip.files.join(", ") + (f.wip.more ? `, … ${f.wip.more} more` : "");
		// The reason is the failure line above when there is one.
		out.push(`✗ WIP ${f.wip.sha} on ${f.branch}${failure ? "" : ` (${shown(f.wip.reason)})`}: ${files}`);
	}
	if (f.check.status !== "pass")
		out.push(
			`✗ check ${{ none: "not run", fail: "failed", stale: "stale: edited after the last run", pass: "" }[f.check.status]}`,
		);
	out.push(...f.problems.map((p) => `✗ ${shown(p)}`));
	return out.join("\n");
}
