import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME } from "./delegate-config.ts";

/** A path through its symlinks (macOS /tmp is /private/tmp), or as given when it does not exist. */
export function realpathOr(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path; // Missing path: nothing to resolve; the tool reports it.
	}
}

/** `~` and `~/…` under HOME; every other form (`~user/…`, `a/~/b`) as given. */
export function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? join(HOME, path.slice(1)) : path;
}

/** The absolute path Pi's `edit` and `write` tools give a `path` argument: `@`, `~`, `~/…`, and `file://` forms too. */
export function toolPath(path: string, cwd: string): string {
	const given = path.replace(UNICODE_SPACES, " ").replace(/^@/, "");
	if (/^file:\/\//.test(given)) {
		try {
			return fileURLToPath(given);
		} catch {} // Malformed: the tool reports it.
	}
	return resolve(cwd, expandHome(given));
}

// --- Secret paths (enforced inside workers) -------------------------------------------------------

// Paths that commonly hold credentials. Workers are blocked from naming them in read/grep/find/ls;
// a broad search over a parent directory can still match inside them, so this narrows, not seals.
const HOME_SECRETS = [
	".ssh",
	".gnupg",
	".aws",
	".azure",
	".kube",
	".docker/config.json",
	".config/gh",
	".config/gcloud",
];
// Both the home path and its resolved form, lowercased: macOS and Windows filesystems ignore case.
const SECRET_PATHS = [...new Set([HOME, realpathOr(HOME)])].flatMap((home) =>
	[...HOME_SECRETS, ".pi/agent/auth.json"].map((p) => join(home, p).toLowerCase()),
);
// Credential files by name, anywhere; public keys and example files are not secret.
const SECRET_NAMES =
	/^(?:\.env(?:rc|\..+)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)\S*|.+\.(?:pem|key|p12|pfx))$/;
const NOT_SECRET = /\.(?:example|sample|template|pub)$/;
// A glob (grep's `glob`, find's `pattern`) that names a secret file or directory, such as `**/.env*`.
const SECRET_GLOB =
	/(?:^|[/{,*])(?:\.env|\.ssh|\.gnupg|\.aws|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)|auth\.json)|\.(?:pem|key|p12|pfx)(?:$|[},])/i;

function isSecretPath(path: string): boolean {
	const lower = path.toLowerCase();
	const name = basename(lower);
	if (SECRET_NAMES.test(name) && !NOT_SECRET.test(name)) return true;
	return SECRET_PATHS.some((p) => lower === p || lower.startsWith(`${p}/`));
}

/** The secret path or glob a worker's read/grep/find/ls call names (also after symlinks), if any. */
export function secretPathIn(toolName: string, input: unknown, cwd: string): string | undefined {
	if (!["read", "grep", "find", "ls"].includes(toolName)) return undefined;
	const fields = (input ?? {}) as { path?: unknown; glob?: unknown; pattern?: unknown };
	const glob = toolName === "grep" ? fields.glob : toolName === "find" ? fields.pattern : undefined;
	if (typeof glob === "string" && SECRET_GLOB.test(glob)) return glob;
	if (typeof fields.path !== "string" || !fields.path.trim()) return undefined;
	const given = fields.path.trim().replace(/^@/, "");
	const absolute = resolve(cwd, expandHome(given));
	return [absolute, ...resolvedForms(absolute)].find(isSecretPath);
}

const MAX_LINK_HOPS = 40;

// The path through its symlinks; when that fails (a dangling link), each hop of the readlink chain instead,
// so a link to a missing secret path is still caught.
function resolvedForms(absolute: string): string[] {
	try {
		return [realpathSync.native(absolute)];
	} catch {
		const hops: string[] = [];
		let current = absolute;
		for (let i = 0; i < MAX_LINK_HOPS; i++) {
			const next = followFirstLink(current);
			if (next === undefined) break;
			hops.push(next);
			current = next;
		}
		return hops;
	}
}

// The path with its first symlink component replaced by the link's target, or undefined when none is a link.
function followFirstLink(absolute: string): string | undefined {
	const parts = absolute.split(sep).filter(Boolean);
	let prefix: string = sep;
	for (let i = 0; i < parts.length; i++) {
		prefix = join(prefix, parts[i]);
		let target: string;
		try {
			if (!lstatSync(prefix).isSymbolicLink()) continue;
			target = readlinkSync(prefix);
		} catch {
			return undefined; // Missing component: nothing further to follow.
		}
		return join(resolve(dirname(prefix), target), ...parts.slice(i + 1));
	}
	return undefined;
}

// --- Draft output (enforced inside workers) -------------------------------------------------------

/** The resolved path of a missing file: its nearest existing ancestor with symlinks resolved, plus the rest. */
// Undefined when an existing entry cannot be resolved, such as a dangling symlink that a write would follow.
export function realTarget(absolute: string): string | undefined {
	let dir = absolute;
	const rest: string[] = [];
	const exists = (p: string) => {
		try {
			return Boolean(lstatSync(p));
		} catch {
			return false;
		}
	};
	while (!exists(dir) && dirname(dir) !== dir) {
		rest.unshift(basename(dir));
		dir = dirname(dir);
	}
	try {
		return join(realpathSync.native(dir), ...rest);
	} catch {
		return undefined;
	}
}

// Pi turns these into plain spaces before it resolves a path (normalizePath).
export const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Why a worker's write/edit call is blocked, or undefined when its path is inside `outDir` and not inside `denyDir`
 * (implement: the git common dir) or `outDir`'s own `.git`. `~` and `file:` paths are refused rather than expanded, so this check cannot
 * resolve them differently from Pi.
 */
export function writeBlockedIn(
	toolName: string,
	input: unknown,
	cwd: string,
	outDir?: string,
	denyDir?: string,
): string | undefined {
	if (toolName !== "write" && toolName !== "edit") return undefined;
	if (!outDir) return "delegated workers cannot write files without `output: true`";
	const path = (input as { path?: unknown } | undefined)?.path;
	if (typeof path !== "string" || !path) return "no path";
	const given = path.replace(UNICODE_SPACES, " ").replace(/^@/, "");
	if (/^(?:~|file:)/i.test(given)) return `use an absolute path inside ${outDir}, not ${path}`;
	const target = realTarget(resolve(cwd, given));
	if (!target) return `${path} cannot be resolved`;
	const inside = relative(realpathOr(outDir), target);
	if (notStrictlyInside(inside))
		return isAbsolute(given) ? `${path} is outside ${outDir}` : relativeHint(path, target, outDir, given);
	// A linked worktree's `.git` is a file outside the git directory that points into it.
	if (denyDir && inside === ".git") return `${path} is the checkout's link to the git directory`;
	const denied = denyDir && relative(realpathOr(denyDir), target);
	if (denied !== undefined && (denied === "" || !notStrictlyInside(denied)))
		return `${path} is inside the git directory ${denyDir}`;
	return undefined;
}

const notStrictlyInside = (rel: string) => !rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);

// Tasks often name a relative path, which Pi resolves against the project: say where it went and where to write.
function relativeHint(path: string, target: string, outDir: string, given: string): string {
	const suggested = join(outDir, given);
	const hint = notStrictlyInside(relative(outDir, suggested)) ? "" : `; write to ${suggested} instead`;
	return `${path} resolves to ${target}, outside ${outDir}${hint}`;
}

export const within = (root: string, target: string) => {
	const rel = relative(realpathOr(root), target);
	return rel === "" || !notStrictlyInside(rel);
};
