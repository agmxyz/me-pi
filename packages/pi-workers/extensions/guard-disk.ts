/**
 * guard's live disk reads, made when a bash command is about to run: a directory's branch, repo root, a remote's URL,
 * and whether a repo has uncommitted work under some paths. Read-only `git` with a hard timeout; no hooks, fsmonitor, or
 * optional locks run. A failed, timed-out, or refused read is `undefined` (status: `unknown`), which the policy treats
 * as the risky answer.
 */

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { posix } from "node:path";

export const GIT_TIMEOUT_MS = 3_000;
/** All lookups for one command share this budget, so many targets can't stack timeouts; past it, reads are unknown. */
export const DECISION_BUDGET_MS = 5_000;

let deadline = Number.POSITIVE_INFINITY;
/** Starts one command's lookup budget (`guard.ts` calls it per decision). */
export function startBudget(ms = DECISION_BUDGET_MS): void {
	deadline = Date.now() + ms;
}

/**
 * One read-only git call: trimmed stdout on exit 0 (`out`), else undefined; `notRepo` when git said `dir` is in no
 * repository (anything else — a timeout, a spent budget, git missing or failing — is unknown).
 */
function gitCall(
	dir: string,
	args: string[],
): { out: string | undefined; notRepo: boolean; status: number | undefined } {
	const left = Math.min(GIT_TIMEOUT_MS, deadline - Date.now());
	if (left <= 0) return { out: undefined, notRepo: false, status: undefined };
	const res = spawnSync("git", ["-C", dir, "-c", "core.fsmonitor=false", ...args], {
		encoding: "utf8",
		timeout: left,
		killSignal: "SIGKILL",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
	});
	const ok = res.status === 0 && !res.error;
	const notRepo = res.status === 128 && /not a git repository/.test(res.stderr ?? "");
	return {
		out: ok ? res.stdout.replace(/\n$/, "") : undefined,
		notRepo,
		status: res.error ? undefined : (res.status ?? undefined),
	};
}

/**
 * Whether `git checkout NAME` (one operand, no `--`) would switch to a ref rather than overwrite a path named NAME,
 * by git's own rule: NAME resolves to a commit (`rev-parse --verify --quiet NAME^{commit}`), or names exactly a
 * remote-tracking branch `refs/remotes/<remote>/NAME` (checkout's branch guess). `false`: not a ref, so a path;
 * undefined: unknown (a failed or timed-out read, an odd name), which the policy treats as possibly a path.
 */
export function isCheckoutRef(dir: string, name: string): boolean | undefined {
	if (!/^[\w./@{}^~+-]+$/.test(name) || name.startsWith("-")) return undefined;
	const commit = gitCall(dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${name}^{commit}`]);
	if (commit.status === 0) return true;
	if (commit.status !== 1) return undefined;
	const guess = gitCall(dir, ["for-each-ref", "--format=%(refname)", `refs/remotes/*/${name}`]);
	if (guess.status !== 0 || guess.out === undefined) return undefined;
	return guess.out.trim() !== "";
}
const git = (dir: string, args: string[]) => gitCall(dir, args).out;

/** The checked-out branch at `dir`; `HEAD` when detached; undefined when not a repo or unreadable. */
export function branchOf(dir: string): string | undefined {
	return git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]) || undefined;
}

/**
 * The work tree root containing `dir`, in the caller's spelling of `dir` (git prints the real path: `/private/tmp/…`
 * for `/tmp/…`, a symlink resolved); `null` when git says `dir` is in no work tree; undefined when that can't be read
 * (git failing, a timeout, a spent budget), which the policy treats as possibly a repo. A `dir` that doesn't exist yet
 * (a target about to be created and removed) is read from its nearest existing parent.
 */
export function repoRootOf(dir: string): string | null | undefined {
	let d = posix.normalize(dir);
	while (d !== "/" && !isDir(d)) d = posix.dirname(d);
	const { out: root, notRepo } = gitCall(d, ["rev-parse", "--show-toplevel"]);
	if (!root) return notRepo ? null : undefined;
	let real: string;
	try {
		real = realpathSync(d);
	} catch {
		return undefined;
	}
	// Climb from `d` as many levels as the real path sits below the root. If `d` is itself a symlink into a repo's
	// subdirectory, this may name the symlink's parent instead of a root; that's safe: `git status` there fails and the
	// dirty check reads `unknown`, which asks.
	const rel = posix.relative(root, real);
	if (rel.startsWith("..")) return root;
	return rel === "" ? d : posix.resolve(d, ...rel.split("/").map(() => ".."));
}

function isDir(p: string): boolean {
	try {
		return existsSync(p) && statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** Remote `name`'s configured URL in the repo at `dir`, or undefined. */
export function remoteUrlOf(dir: string, name: string): string | undefined {
	if (!/^[\w.-]+$/.test(name)) return undefined;
	return git(dir, ["config", "--get", `remote.${name}.url`]) || undefined;
}

export type Dirt = "clean" | "dirty" | "unknown";

/**
 * Whether the repo at `repo` has uncommitted changes under `paths` (relative to the repo; undefined = the whole tree).
 * `untracked` counts untracked files too (`git clean`, `rm`); gitignored files count only with `ignored` (`git clean
 * -x`/`-X` deletes them); otherwise `node_modules` is clean.
 */
export function dirtIn(repo: string, paths: string[] | undefined, untracked: boolean, ignored = false): Dirt {
	const args = ["status", "--porcelain", untracked ? "--untracked-files=all" : "--untracked-files=no"];
	if (ignored) args.push("--ignored=matching");
	// `icase`: on a case-insensitive disk (macOS's default) `rm -rf SRC` removes `src`; matching without case only
	// over-matches (asks more) on a case-sensitive one.
	const out = git(repo, paths?.length ? [...args, "--", ...paths.map((p) => `:(literal,icase)${p}`)] : args);
	if (out === undefined) return "unknown";
	return out.trim() ? "dirty" : "clean";
}
