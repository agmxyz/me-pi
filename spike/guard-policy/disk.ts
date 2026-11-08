/**
 * Step 1b disk lookups for measuring real session commands, the way a live guard would read them at classify time.
 * Read-only `git` calls, each with a hard timeout, memoized; no hooks or fsmonitor run (`rev-parse`, `config --get`
 * with `core.fsmonitor=false`, `GIT_OPTIONAL_LOCKS=0`). This is an approximation: it reads the disk *now*, not when
 * the session ran the command (branches have moved, repos and temp dirs are gone).
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";
import { guard } from "../guard-parser/guard-rules.ts";
import type { PolicyEnv } from "./policy.ts";

const GIT_TIMEOUT_MS = 3_000;
const memo = new Map<string, string | undefined>();

function git(args: string[]): string | undefined {
	const key = args.join("\0");
	if (memo.has(key)) return memo.get(key);
	let out: string | undefined;
	try {
		out = execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
			encoding: "utf8",
			timeout: GIT_TIMEOUT_MS,
			killSignal: "SIGKILL",
			stdio: ["ignore", "pipe", "ignore"],
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
		}).trim();
	} catch {
		out = undefined;
	}
	memo.set(key, out);
	return out;
}

/** The nearest existing directory at or above `dir` (a target that was since removed has no directory of its own). */
function existingDir(dir: string): { dir: string; exact: boolean } {
	let d = posix.normalize(dir);
	let exact = true;
	while (d !== "/" && !(existsSync(d) && statSync(d).isDirectory())) {
		d = posix.dirname(d);
		exact = false;
	}
	return { dir: d, exact };
}

export interface DiskStats {
	/** Directories looked up that don't exist any more (resolved from their nearest existing parent). */
	missingDirs: Set<string>;
	/** Decision 1: dirs whose branch was read from disk, and dirs that no longer exist (counted as ask). */
	branchRead: Set<string>;
	branchMissing: Set<string>;
}

/**
 * The env for a command run in `cwd` (decisions as named); `stats` collects what the lookups met. `aliases` (a
 * sensitivity check only) maps an old path prefix to where it lives now, for cwd and every lookup.
 */
export function diskEnv(
	cwd: string | undefined,
	stats: DiskStats,
	decisions = ALL,
	aliases: Record<string, string> = {},
): PolicyEnv {
	const alias = (p: string) => {
		for (const [from, to] of Object.entries(aliases))
			if (p === from || p.startsWith(`${from}/`)) return to + p.slice(from.length);
		return p;
	};
	// A root found through an alias, back in the caller's spelling (so `path.startsWith(root)` holds).
	const unalias = (root: string, raw: string) => {
		for (const [from, to] of Object.entries(aliases))
			if ((raw === from || raw.startsWith(`${from}/`)) && (root === to || root.startsWith(`${to}/`)))
				return from + root.slice(to.length);
		return root;
	};
	const env: PolicyEnv = { cwd: cwd === undefined ? undefined : alias(cwd), home: homedir() };
	if (decisions.has(1))
		env.branchOf = (raw) => {
			const dir = alias(raw);
			if (!existsSync(dir)) {
				stats.branchMissing.add(dir);
				return undefined;
			}
			const b = git(["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
			if (b !== undefined) stats.branchRead.add(dir);
			return b;
		};
	if (decisions.has(4))
		env.repoRootOf = (raw) => {
			const dir = alias(raw);
			const { dir: d, exact } = existingDir(dir);
			if (!exact) stats.missingDirs.add(dir);
			const root = git(["-C", d, "rev-parse", "--show-toplevel"]);
			// git prints the real path (`/private/tmp/…` for `/tmp/…`); keep the caller's spelling when they're one place.
			return root === undefined ? undefined : unalias(sameSpelling(root, dir), raw);
		};
	if (decisions.has(5))
		env.remoteUrlOf = (raw, name) => {
			const dir = alias(raw);
			if (!/^[\w.-]+$/.test(name) || !existsSync(dir)) return undefined;
			return git(["-C", dir, "config", "--get", `remote.${name}.url`]);
		};
	if (decisions.has(2)) env.fallback = (text, branch) => guard.classify(text, () => branch);
	if (decisions.has(3)) env.parserTmpdir = true;
	if (decisions.has(6)) env.operandFix = true;
	return env;
}
/** Decisions 1-5 of step 1b, and 6 = the #2625 operand fix. */
export const ALL: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6]);

/** macOS: `/tmp` and `/var` are `/private/tmp` and `/private/var`; git reports the latter. Use the caller's form. */
function sameSpelling(root: string, asked: string): string {
	const r = root.replace(/^\/private(?=\/(?:tmp|var)(?:\/|$))/, "");
	const underPrivate = /^\/(?:tmp|var)(?:\/|$)/.test(r);
	return underPrivate && /^\/private\/(?:tmp|var)(?:\/|$)/.test(asked) ? `/private${r}` : r;
}
