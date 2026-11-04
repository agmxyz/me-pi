/**
 * Checkout lifecycle for the `implement` role: `prepare` locks and validates the branch;
 * `finish` commits leftovers as WIP, validates tripwires, writes details, and releases the lock;
 * `formatHandback` renders the tool result. The worker writes in the real checkout, so the
 * snapshots watch what it must not touch.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { link, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type ArtifactWriteResult, FAILED_TOOL_ARTIFACT_REDACTION, redactSensitiveText } from "./delegate-artifacts.ts";
import { ENV_CHECK, ENV_DENY_DIR, ENV_OUTPUT_DIR, ENV_PARENT, ENV_ROLE } from "./delegate-env.ts";
import { realpathOr } from "./delegate-fence.ts";
import {
	type AttemptProvenance,
	bashExitCode,
	type FailureClass,
	failureClassLine,
	type StopFact,
	type ToolEffectFact,
} from "./delegate-provenance.ts";
import { PROTECTED_BRANCHES } from "./guard.ts";

const run = promisify(execFile);

export type GitSnapshot = {
	// refname -> object id, under refs/heads, refs/tags, and refs/stash (refs/remotes is not watched: fetch moves it).
	refs: Map<string, string>;
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
const MAX_NEW_TOP_LEVEL = 5;
const FIRST_LINE_CAP = 200;

export function nextImplementId(): string {
	const shared = globalThis as any;
	shared[COUNT_KEY] = (shared[COUNT_KEY] ?? 0) + 1;
	return `im${shared[COUNT_KEY]}`;
}

/** Whether the worker's last declared check covers current checkout content: none, pass, fail, or stale. */
export type CheckState = {
	command: string;
	status: "none" | "pass" | "fail" | "stale";
	runs: string[];
	staleReason?: string;
};

export type Checkout = {
	id: string;
	repoRoot: string;
	// The git common dir: the worker may not write inside it, and the lock lives there.
	commonDir: string;
	ref: string;
	branch: string;
	base: string;
	startedAt: number;
	// HEAD's subject starts with `WIP(delegate`: an earlier attempt left work the worker should finish first.
	wipHead: boolean;
	check: CheckState;
	// The filesystem content checked by the most recent successful declared check; excludes Git metadata.
	contentBaseline?: string;
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
	stderr?: string;
	failedToolCapture?: Exclude<ArtifactWriteResult, { status: "empty" }>;
	provenance?: AttemptProvenance[];
	stopFacts?: StopFact[];
	failureClass?: FailureClass;
	// Failures retried on the same model as infra failures before this outcome.
	infraRetries?: string[];
};

export type DeliveredState = {
	check: CheckState["status"];
	commit: "normal" | "none" | "unknown";
	wip: boolean;
	integrity: "clear" | "tripped" | "unknown";
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
	// Top-level directories (`dir/`) and dot-paths the range added: often scratch the task did not ask for.
	newTopLevel?: string[];
	// ✗ lines other than WIP and the check, without the ✗.
	problems: string[];
	check: CheckState;
	delivered: DeliveredState;
	stopFacts: StopFact[];
	outcome: Outcome;
	detailsPath?: string;
	failed: boolean;
};

// Best-effort redaction and control escaping keep worker text from adding lines or terminal controls.
const shown = (text: string) =>
	redactSensitiveText(text).replace(
		/[\x00-\x1f\x7f]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
const safeDocument = (text: string) =>
	redactSensitiveText(text).replace(
		/[\x00-\x09\x0b-\x1f\x7f]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);

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

export class ImplementLockRefusal extends Error {
	readonly stopFact: StopFact;

	constructor(message: string, jobId: string, toolCallId?: string) {
		super(message);
		this.name = "ImplementLockRefusal";
		this.stopFact = {
			owner: "implement",
			jobId,
			attempt: 1,
			...(toolCallId ? { toolCallId } : {}),
			cause: "lock-refusal",
			resource: "checkout-lock",
			effect: "denied",
		};
	}
}

// Takes the per-repo lock; a lock whose pid is dead is taken over, a live or unreadable one refuses. A takeover
// renames the stale lock aside and re-checks it, so two takeovers cannot both win.
async function takeLock(lockPath: string, id: string, repoRoot: string, toolCallId?: string): Promise<void> {
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
			throw new ImplementLockRefusal(
				holder
					? `implement job ${holder.id} (pid ${holder.pid}) is already writing in ${repoRoot}; wait for its handback`
					: `${lockPath} is unreadable; another implement job may be starting in ${repoRoot}. Remove it only if none runs.`,
				id,
				toolCallId,
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
			throw new ImplementLockRefusal(
				`another implement job just took the lock in ${repoRoot}; wait for its handback`,
				id,
				toolCallId,
			);
		}
		await rm(aside, { force: true });
	}
	throw new ImplementLockRefusal(`could not take ${lockPath}`, id, toolCallId);
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
export async function prepare(cwd: string, id: string, check: string, toolCallId?: string): Promise<Checkout> {
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
	await takeLock(lockPath, id, repoRoot, toolCallId);
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
			contentBaseline: undefined,
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

/** Hashes checkout content without Git metadata, length-prefixing every path, kind, mode, and payload field. */
export function snapshotContent(repoRoot: string): string {
	const root = resolve(repoRoot);
	const hash = createHash("sha256");
	const field = (value: string | Uint8Array) => {
		const bytes = Buffer.from(value);
		const length = Buffer.allocUnsafe(8);
		length.writeBigUInt64BE(BigInt(bytes.length));
		hash.update(length).update(bytes);
	};
	const visit = (dir: string) => {
		const entries = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.name !== ".git");
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries) {
			const path = join(dir, entry.name);
			const stat = lstatSync(path);
			if (stat.isDirectory()) {
				visit(path);
				continue;
			}
			field(relative(root, path).split(sep).join("/"));
			if (stat.isSymbolicLink()) {
				field("link");
				field(readlinkSync(path));
			} else if (stat.isFile()) {
				field("file");
				field(String(stat.mode & 0o111));
				field(readFileSync(path));
			} else {
				field("other");
				field(String(stat.mode & 0o170000));
			}
		}
	};
	visit(root);
	return hash.digest("hex");
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

// Trailing output redirections, e.g. `> out.txt 2>&1`.
const REDIRECTS = /(?:\s+\d?>>?(?:&\d|\s*[^\s|;&]+))+\s*$/;

/**
 * Whether a bash command runs the declared check inside a pipe, chain, or redirect, or with only extra flags
 * (`check -- --test-timeout=…`), where its result does not count. Extra file targets are a focused run, not the check.
 */
export function checkInCompound(command: string, check: string, cwd: string): boolean {
	if (isCheckRun(command, check, cwd)) return false;
	const want = normalized(check);
	return command.split(/\|\||&&|[|;\n]/).some((part) => {
		const got = normalized(part.replace(REDIRECTS, ""));
		if (got === want) return true;
		if (!got.startsWith(`${want} `)) return false;
		const extra = got
			.slice(want.length)
			.trim()
			.split(/\s+/)
			.filter((arg) => arg !== "--");
		return extra.length > 0 && extra.every((arg) => arg.startsWith("-"));
	});
}

/** Updates check freshness from completed worker tool events; only a passing declared check establishes a baseline. */
export function trackCheck(
	job: Checkout,
	calls: Map<string, { tool: string; command: string }>,
	event: { toolCallId?: unknown; isError?: unknown; result?: unknown },
	cwd: string,
): void {
	const call = calls.get(String(event.toolCallId));
	if (!call) return;
	calls.delete(String(event.toolCallId));
	const { check } = job;
	const stale = (reason: string, detail?: string) => {
		check.status = "stale";
		check.staleReason = reason;
		job.contentBaseline = undefined;
		if (detail) check.runs.push(`stale: ${detail}`);
	};
	if (call.tool === "bash") {
		if (isCheckRun(call.command, check.command, cwd)) {
			job.contentBaseline = undefined;
			delete check.staleReason;
			const exitCode = bashExitCode(event.result);
			if (event.isError === true || (exitCode !== undefined && exitCode !== 0)) {
				check.status = "fail";
				check.runs.push(`fail: ${call.command}`);
				return;
			}
			if (event.isError !== false || exitCode !== 0) {
				stale(
					"declared Bash check result lacks a canonical successful exit status",
					`status unavailable or contradictory: ${call.command}`,
				);
				return;
			}
			try {
				job.contentBaseline = snapshotContent(job.repoRoot);
				check.status = "pass";
				check.runs.push(`pass: ${call.command}`);
			} catch (err) {
				const message = (err as Error).message;
				stale("checkout content could not be verified after the check", `content snapshot unavailable: ${message}`);
			}
		} else if (check.status === "pass") {
			try {
				if (job.contentBaseline === undefined) {
					stale("checkout content could not be verified after the last check", "content baseline unavailable");
					return;
				}
				if (snapshotContent(job.repoRoot) !== job.contentBaseline)
					stale("checkout content changed after the last check");
			} catch (err) {
				stale(
					"checkout content could not be verified after the last check",
					`content snapshot unavailable: ${(err as Error).message}`,
				);
			}
		}
		return;
	}
	if ((call.tool === "edit" || call.tool === "write") && !event.isError && check.status !== "none")
		stale("successful edit/write after the last check");
}

const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
const CUT_PROTOCOLS = ["ssh", "https", "http", "git"];

/**
 * The implement worker's environment: writes fenced to the repo (ME_PI_OUTPUT_DIR) and out of the git dir
 * (ME_PI_DENY_DIR), an orphan stop (ME_PI_PARENT), the declared check (ME_PI_CHECK), git remotes cut off by appending `protocol.<p>.allow=never` after
 * any GIT_CONFIG_* the user set, and gh without a login. These prevent accidents, not misuse: `git -c` and `env -u`
 * undo them. Provider keys stay; Pi needs them.
 */
export function workerEnv(env: NodeJS.ProcessEnv, job: Checkout): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {
		...env,
		[ENV_ROLE]: "implement",
		[ENV_OUTPUT_DIR]: job.repoRoot,
		[ENV_DENY_DIR]: job.commonDir,
		[ENV_PARENT]: String(process.pid),
		[ENV_CHECK]: job.check.command,
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

function capped(text: string, max: number): [string[], number] {
	const lines = text.split("\n").filter(Boolean);
	return [lines.slice(0, max), Math.max(0, lines.length - max)];
}

const num = (text: string, word: string) => Number(text.match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0);

function markIntegrity(facts: Facts, state: DeliveredState["integrity"]): void {
	if (state === "tripped" || facts.delivered.integrity !== "tripped") facts.delivered.integrity = state;
}

function correlatedCompletedBashFailure(fact: StopFact, attempt: AttemptProvenance, allStopFacts: StopFact[]): boolean {
	if (
		fact.owner !== "delegate-parent" ||
		fact.cause !== "tool-failure" ||
		fact.resource !== "tool" ||
		fact.effect !== "completed" ||
		!fact.toolCallId ||
		fact.jobId !== attempt.jobId ||
		fact.attempt !== attempt.attempt
	)
		return false;
	const callId = fact.toolCallId;
	const stopsForCall = allStopFacts.filter(
		(stop) =>
			stop.owner === "delegate-parent" &&
			stop.cause === "tool-failure" &&
			stop.jobId === fact.jobId &&
			stop.attempt === fact.attempt &&
			stop.toolCallId === callId,
	);
	const effectsForCall = attempt.toolEffects.filter(
		(effect) =>
			effect.owner === "pi-runtime" &&
			effect.jobId === fact.jobId &&
			effect.attempt === fact.attempt &&
			effect.toolCallId === callId,
	);
	return (
		stopsForCall.length === 1 &&
		effectsForCall.length === 1 &&
		effectsForCall[0].toolName === "bash" &&
		effectsForCall[0].effect === "completed" &&
		effectsForCall[0].replaySafe === false
	);
}

/** A guard or fence denial is diagnostic when its call's only effect is the denial: the tool never ran. */
function correlatedDenial(fact: StopFact, attempt: AttemptProvenance): boolean {
	if (
		(fact.owner !== "guard" && fact.owner !== "delegate-worker") ||
		(fact.cause !== "guard-denial" && fact.cause !== "worker-fence-denial") ||
		fact.effect !== "denied" ||
		!fact.toolCallId ||
		fact.jobId !== attempt.jobId ||
		fact.attempt !== attempt.attempt
	)
		return false;
	const effects = attempt.toolEffects.filter((effect) => effect.toolCallId === fact.toolCallId);
	return effects.length === 1 && effects[0].effect === "denied";
}

/**
 * Diagnostic only: a completed Bash failure whose parent stop/effect pair is unique, and a correlated denial. Other
 * stops and unresolved effects block; `not-started` is a failure the tool reported before any effect.
 */
function hasUnresolvedProvenance(outcome: Outcome): boolean {
	const attempts = outcome.provenance ?? [];
	if (!attempts.length) return true;
	const allStopFacts = [...(outcome.stopFacts ?? []), ...attempts.flatMap((attempt) => attempt.stopFacts)];
	const allowedFailures = new Set(
		attempts.flatMap((attempt) =>
			attempt.stopFacts
				.filter((fact) => correlatedCompletedBashFailure(fact, attempt, allStopFacts))
				.map((fact) => `${fact.jobId}\0${fact.attempt}\0${fact.toolCallId}`),
		),
	);
	const isDiagnostic = (fact: StopFact) =>
		(fact.toolCallId !== undefined &&
			allowedFailures.has(`${fact.jobId}\0${fact.attempt}\0${fact.toolCallId}`) &&
			fact.owner === "delegate-parent" &&
			fact.cause === "tool-failure" &&
			fact.resource === "tool" &&
			fact.effect === "completed") ||
		attempts.some((attempt) => correlatedDenial(fact, attempt));
	const settled = (effect: ToolEffectFact, attempt: AttemptProvenance) =>
		effect.effect === "completed" ||
		effect.effect === "not-started" ||
		(effect.effect === "denied" &&
			attempt.stopFacts.some((fact) => fact.toolCallId === effect.toolCallId && correlatedDenial(fact, attempt)));
	return (
		allStopFacts.some((fact) => !isDiagnostic(fact)) ||
		attempts.some((attempt) => !attempt.complete || attempt.toolEffects.some((fact) => !settled(fact, attempt)))
	);
}

/**
 * Runs a prepared job so finish always runs exactly once. The body ends the job itself through `end`; if it throws
 * before that, the job ends with `onError`'s outcome and the error is rethrown with the handback appended.
 */
export async function runImplementJob<T>(
	job: Checkout,
	body: (end: (outcome: Outcome) => Promise<Facts>) => Promise<T>,
	onError: (err: unknown) => Outcome,
): Promise<T> {
	let ended: Promise<Facts> | undefined;
	const end = (outcome: Outcome) => {
		ended ??= finish(job, outcome);
		return ended;
	};
	try {
		return await body(end);
	} catch (err: any) {
		if (ended) throw err;
		const facts = await end(onError(err));
		throw new Error(`${err?.message ?? err}\n${formatHandback(facts)}`);
	}
}

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
		delivered: { check: job.check.status, commit: "unknown", wip: false, integrity: "unknown" },
		stopFacts: [...(outcome.stopFacts ?? [])],
		outcome,
		failed: true,
	};
	try {
		await finishSteps(job, facts);
	} catch (err) {
		markIntegrity(facts, "unknown");
		facts.problems.push(`finish failed: ${(err as Error).message}`);
	}
	if (hasUnresolvedProvenance(outcome))
		facts.problems.push("provenance/effect state is incomplete or stopped; acceptance withheld");
	facts.delivered.check = job.check.status;
	facts.delivered.wip ||= facts.wip !== undefined;
	if (facts.delivered.integrity === "tripped") {
		const attempt = outcome.provenance?.at(-1)?.attempt ?? 1;
		facts.stopFacts.push({
			owner: "implement",
			jobId: job.id,
			attempt,
			cause: "integrity-tripwire",
			resource: "integrity",
			effect: "unknown",
		});
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
		facts.delivered.wip ||
		facts.problems.length > 0 ||
		job.check.status !== "pass";
	return facts;
}

async function finishSteps(job: Checkout, facts: Facts): Promise<void> {
	facts.delivered.check = job.check.status;
	facts.delivered.wip = job.wipHead;
	facts.delivered.integrity = "clear";
	// 1. HEAD must still be on the job's branch, or a WIP commit would land elsewhere.
	const head = await git(job.repoRoot, ["symbolic-ref", "-q", "HEAD"]);
	if (!head.ok) {
		markIntegrity(facts, head.code === 1 ? "tripped" : "unknown");
		facts.problems.push(
			head.code === 1
				? `HEAD moved: detached, not ${job.branch}; no WIP commit`
				: `HEAD unreadable: ${head.err || "git symbolic-ref failed"}; no WIP commit`,
		);
	} else if (head.out.trim() !== job.ref) {
		markIntegrity(facts, "tripped");
		facts.problems.push(`HEAD moved: now ${head.out.trim()}, not ${job.branch}; no WIP commit`);
	} else {
		// 2. Leftovers become one WIP commit; ignored files are not added. Hooks and signing are off: this commit
		// only saves work, and a worker may have set core.hooksPath.
		const status = await git(job.repoRoot, ["status", "--porcelain"]);
		if (!status.ok) {
			markIntegrity(facts, "unknown");
			facts.problems.push(`git status failed: ${status.err}`);
		} else if (status.out.trim()) {
			const why = failureLine(facts.outcome.failure) ?? "left uncommitted by the worker";
			const [files, more] = capped(status.out.replace(/^.{3}/gm, ""), MAX_WIP_FILES);
			const add = await git(job.repoRoot, ["add", "-A"]);
			if (!add.ok) markIntegrity(facts, "unknown");
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
			if (!commit.ok) {
				markIntegrity(facts, "unknown");
				facts.problems.push(`WIP commit failed: ${commit.err}; the tree is left dirty`);
			} else {
				const sha = await git(job.repoRoot, ["rev-parse", "--short", "HEAD"]);
				if (!sha.ok) facts.problems.push(`WIP commit made, but its sha is unreadable: ${sha.err}`);
				facts.wip = { sha: sha.ok ? sha.out.trim() : "(unknown)", reason: why, files: files.map(shown), more };
			}
		}
	}
	// 3. The range, read from git: it must descend from the base and hold only new, non-merge commits.
	const tip = await git(job.repoRoot, ["rev-parse", "--verify", "-q", job.ref]);
	if (!tip.ok) {
		markIntegrity(facts, tip.code === 1 ? "tripped" : "unknown");
		facts.problems.push(`branch ${job.branch} is gone: ${tip.err || "not found"}`);
	} else {
		const sha = tip.out.trim();
		facts.tip = sha;
		const subject = await git(job.repoRoot, ["log", "-1", "--format=%s", sha]);
		if (!subject.ok) {
			markIntegrity(facts, "unknown");
			facts.problems.push(`delivered HEAD subject unreadable: ${subject.err}`);
		} else facts.delivered.wip = subject.out.trim().startsWith("WIP(delegate");
		const ancestry = await git(job.repoRoot, ["merge-base", "--is-ancestor", job.base, sha]);
		if (!ancestry.ok) {
			markIntegrity(facts, ancestry.code === 1 ? "tripped" : "unknown");
			facts.problems.push(`${job.branch} no longer descends from the base ${job.base.slice(0, 7)}`);
		}
		// `%h %p %ct %s`, NUL-separated: `%p` is one parent, or several for a merge.
		const log = await git(job.repoRoot, [
			"log",
			"--reverse",
			"--format=%h%x00%p%x00%ct%x00%s",
			`${job.base}..${sha}`,
		]);
		if (!log.ok) {
			markIntegrity(facts, "unknown");
			facts.problems.push(`git log failed: ${log.err}`);
		}
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
		if (merges.length) {
			markIntegrity(facts, "tripped");
			facts.problems.push(`merge commit(s) in the range: ${merges.join(", ")}`);
		}
		if (old.length) {
			markIntegrity(facts, "tripped");
			facts.problems.push(`commit(s) older than the job (fast-forward to existing work?): ${old.join(", ")}`);
		}
		facts.commits = listed.slice(0, MAX_COMMITS).map(shown);
		facts.commitCount = listed.length;
		if (log.ok)
			facts.delivered.commit = commits.some((line) => !line.split("\0")[3]?.startsWith("WIP(delegate"))
				? "normal"
				: "none";
		const short = await git(job.repoRoot, ["diff", "--shortstat", `${job.base}..${sha}`]);
		const stat = await git(job.repoRoot, ["diff", "--stat", `${job.base}..${sha}`]);
		if (!short.ok || !stat.ok) {
			markIntegrity(facts, "unknown");
			facts.problems.push(`git diff --stat failed: ${short.err || stat.err}`);
		}
		facts.files = num(short.out, "files? changed");
		facts.insertions = num(short.out, "insertions?");
		facts.deletions = num(short.out, "deletions?");
		facts.stat = stat.out;
		const added = await git(job.repoRoot, ["diff", "--name-only", "--diff-filter=A", `${job.base}..${sha}`]);
		const existing = await git(job.repoRoot, ["ls-tree", "--name-only", job.base]);
		if (added.ok && existing.ok) {
			const had = new Set(existing.out.split("\n"));
			const tops = added.out
				.split("\n")
				.filter(Boolean)
				.map((path) => (path.includes("/") ? `${path.split("/")[0]}/` : path))
				.filter((top) => !had.has(top.replace(/\/$/, "")) && (top.endsWith("/") || top.startsWith(".")));
			facts.newTopLevel = [...new Set(tops)].sort();
		}
		// 4. Files Pi loads on /reload: the coordinator reviews them before reloading.
		const trust = await git(job.repoRoot, ["diff", "--name-only", `${job.base}..${sha}`, "--", ".pi", ".agents"]);
		if (!trust.ok) {
			markIntegrity(facts, "unknown");
			facts.problems.push(`Tripwire: git diff .pi .agents failed: ${trust.err}`);
		} else if (trust.out.trim()) {
			markIntegrity(facts, "tripped");
			facts.problems.push(
				`Tripwire: .pi or .agents changed (${capped(trust.out, 5)[0].map(shown).join(", ")}); review before /reload`,
			);
		}
	}
	try {
		const [gitAfter, settingsAfter] = await Promise.all([snapshotGit(job.repoRoot), settingsResources()]);
		const trips = [
			...gitTripwires(job.gitBefore, gitAfter, job.ref),
			...settingsTripwire(job.settingsBefore, settingsAfter),
		];
		facts.problems.push(...trips.map((t) => `Tripwire: ${t}`));
		if (trips.length) markIntegrity(facts, "tripped");
	} catch (err) {
		markIntegrity(facts, "unknown");
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
	const checkHistory = [
		...f.check.runs,
		...(f.check.status === "stale"
			? [`stale reason: ${f.check.staleReason ?? "checkout content changed after the last check"}`]
			: []),
	];
	const text = [
		`# ${f.id} ${f.branch} ${f.base.slice(0, 7)}..${f.tip?.slice(0, 7) ?? "(missing)"} ${o.label ?? ""}`.trim(),
		"",
		...section(
			"Delivered state",
			[
				`check: ${f.delivered.check}`,
				`normal commits: ${f.delivered.commit}`,
				`WIP: ${f.delivered.wip ? "present" : "none"}`,
				`integrity: ${f.delivered.integrity}`,
			].join("\n"),
		),
		...section(
			"Stop provenance",
			[
				...f.stopFacts.map(
					(fact) =>
						`${fact.owner} job=${fact.jobId} attempt=${fact.attempt}${fact.toolCallId ? ` tool=${fact.toolCallId}` : ""} cause=${fact.cause} resource=${fact.resource} effect=${fact.effect}`,
				),
				...(f.outcome.provenance ?? []).flatMap((attempt) =>
					attempt.stopFacts.map(
						(fact) =>
							`${fact.owner} job=${fact.jobId} attempt=${fact.attempt}${fact.toolCallId ? ` tool=${fact.toolCallId}` : ""} cause=${fact.cause} resource=${fact.resource} effect=${fact.effect}`,
					),
				),
			].join("\n"),
		),
		...section(
			"Problems",
			[...(f.wip ? [`WIP ${f.wip.sha} (${f.wip.reason}): ${f.wip.files.join(", ")}`] : []), ...f.problems].join(
				"\n",
			),
		),
		...section(`Commits (${f.commitCount}, oldest first)`, f.commits.join("\n")),
		...section("New top-level paths", f.newTopLevel?.map(shown).join("\n")),
		...section("Diffstat", f.stat),
		...section(`Check \`${f.check.command}\`: ${f.check.status}`, checkHistory.join("\n") || "(not run)"),
		...section("Failure", o.failure && `${o.failure}${failureClassLine(o)}`),
		...section("Infra retries", o.infraRetries?.map(shown).join("\n")),
		...section("Answer", o.answer),
		...section("Tools", o.tools?.join("\n")),
		...section("Stderr (tail)", o.stderr),
		...section(
			"Failed tool diagnostics",
			o.failedToolCapture?.status === "written"
				? [
						`Capture: written (${o.failedToolCapture.failureCount} failed tool call(s)${
							o.failedToolCapture.unmatchedStartCount
								? `; ${plural(o.failedToolCapture.unmatchedStartCount, "end-not-observed start")}`
								: ""
						})`,
						`Artifact: ${shown(o.failedToolCapture.path)}`,
						`Truncated: ${o.failedToolCapture.truncated ? "yes" : "no"}`,
						`Redaction: ${FAILED_TOOL_ARTIFACT_REDACTION}`,
					].join("\n")
				: o.failedToolCapture?.warning && shown(o.failedToolCapture.warning),
		),
	].join("\n");
	await writeFile(path, safeDocument(text), { mode: 0o600 });
	return path;
}

const CHECK_MARKS = { pass: "✓", fail: "✗", stale: "stale", none: "not run" };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The tool result: a facts line, the worker's first line with the details path, then BLOCKED and ✗ lines. */
// Absolute because the global policy that points here is loaded in other repos.
export const RECOVERY_POINTER = `Recovery rules: ${fileURLToPath(new URL("../docs/delegate.md", import.meta.url))}#bounded-coordinator-recovery`;

export function formatHandback(f: Facts): string {
	const o = f.outcome;
	const range = `${f.base.slice(0, 7)}..${f.tip?.slice(0, 7) ?? "(missing)"}`;
	const stat = `${plural(f.commitCount, "commit")}, ${plural(f.files, "file")} +${f.insertions} -${f.deletions}`;
	const staleReason = f.check.staleReason ?? "checkout content changed after the last check";
	const checkMark = f.check.status === "stale" ? `stale (${shown(staleReason)})` : CHECK_MARKS[f.check.status];
	const check = `check ${checkMark} \`${shown(f.check.command)}\``;
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
	if (o.failedToolCapture?.status === "written" && f.failed) {
		const unmatched = o.failedToolCapture.unmatchedStartCount ?? 0;
		out.push(
			`Failed-tool diagnostics: ${shown(o.failedToolCapture.path)} (${o.failedToolCapture.failureCount} failed tool call(s)${
				unmatched ? `, ${plural(unmatched, "end-not-observed start")}` : ""
			}${o.failedToolCapture.truncated ? "; truncated" : ""})`,
		);
	} else if (o.failedToolCapture?.status === "unavailable") {
		const warning = `⚠ ${shown(o.failedToolCapture.warning)}`;
		if (f.failed) out.push(warning);
		else out[1] = `${out[1]} ${warning}`;
	}
	if (f.newTopLevel?.length) {
		const [paths, more] = capped(f.newTopLevel.join("\n"), MAX_NEW_TOP_LEVEL);
		const note = `⚠ new top-level paths: ${paths.map(shown).join(", ")}${more ? `, … ${more} more` : ""}; confirm the task asked for them`;
		if (f.failed) out.push(note);
		else out[1] = `${out[1]} ${note}`;
	}
	if (blocked.length > MAX_BLOCKED) out.push(`+${blocked.length - MAX_BLOCKED} more BLOCKED in details`);
	const failure = failureLine(o.failure);
	if (failure) out.push(`✗ ${shown(failure)}${failureClassLine(o)}`);
	if (f.wip) {
		const files = f.wip.files.join(", ") + (f.wip.more ? `, … ${f.wip.more} more` : "");
		// The reason is the failure line above when there is one.
		out.push(`✗ WIP ${f.wip.sha} on ${f.branch}${failure ? "" : ` (${shown(f.wip.reason)})`}: ${files}`);
	}
	if (f.check.status !== "pass") {
		const reason =
			f.check.status === "stale"
				? `stale: ${shown(staleReason)}`
				: { none: "not run", fail: "failed", pass: "" }[f.check.status];
		out.push(`✗ check ${reason}`);
	}
	out.push(...f.problems.map((p) => `✗ ${shown(p)}`));
	if (f.failed) out.push(RECOVERY_POINTER);
	return safeDocument(out.join("\n"));
}
