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

/** One read-only git call: trimmed stdout on exit 0, undefined on any failure or timeout. */
function git(dir: string, args: string[]): string | undefined {
	const res = spawnSync("git", ["-C", dir, "-c", "core.fsmonitor=false", ...args], {
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		killSignal: "SIGKILL",
		stdio: ["ignore", "pipe", "ignore"],
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
	});
	return res.status === 0 && !res.error ? res.stdout.replace(/\n$/, "") : undefined;
}

/** The checked-out branch at `dir`; `HEAD` when detached; undefined when not a repo or unreadable. */
export function branchOf(dir: string): string | undefined {
	return git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]) || undefined;
}

/**
 * The work tree root containing `dir`, in the caller's spelling of `dir` (git prints the real path: `/private/tmp/…`
 * for `/tmp/…`, a symlink resolved), or undefined when `dir` is in no work tree. A `dir` that doesn't exist yet (a
 * target about to be created and removed) is read from its nearest existing parent.
 */
export function repoRootOf(dir: string): string | undefined {
	let d = posix.normalize(dir);
	while (d !== "/" && !isDir(d)) d = posix.dirname(d);
	const root = git(d, ["rev-parse", "--show-toplevel"]);
	if (!root) return undefined;
	let real: string;
	try {
		real = realpathSync(d);
	} catch {
		return undefined;
	}
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
 * `untracked` counts untracked files too (`git clean`, `rm`); ignored files never count (`node_modules` is clean).
 */
export function dirtIn(repo: string, paths: string[] | undefined, untracked: boolean): Dirt {
	const args = ["status", "--porcelain", untracked ? "--untracked-files=all" : "--untracked-files=no"];
	const out = git(repo, paths?.length ? [...args, "--", ...paths.map((p) => `:(literal)${p}`)] : args);
	if (out === undefined) return "unknown";
	return out.trim() ? "dirty" : "clean";
}
