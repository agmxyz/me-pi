/**
 * bash-truth (guard's proof harness; macOS only, never in CI or the package): runs each command in real /bin/bash (the
 * shell Pi uses on macOS) under sandbox-exec, with every
 * external command a stub (stubs.sh) that logs its argv, and reports what `rm` and `git` actually received.
 *
 * Isolation: `env -i`-style environment (PATH = the stub dir only), sandbox.sb (no network, writes only in the row's
 * fresh temp dir, exec only /bin/bash and the stubs, signals only inside the sandbox), and a hard per-row timeout
 * that SIGKILLs the row's whole process group.
 */
import { spawn } from "node:child_process";
import {
	chmodSync,
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Stubs with behaviour (stubs.sh `case` arms) plus log-only ones every row may meet. */
const CORE = [
	"rm",
	"git",
	"sudo",
	"doas",
	"su",
	"runuser",
	"pkexec",
	"env",
	"timeout",
	"gtimeout",
	"nice",
	"nohup",
	"time",
	"setsid",
	"stdbuf",
	"caffeinate",
	"ionice",
	"unbuffer",
	"rtk",
	"flock",
	"sh",
	"bash",
	"zsh",
	"dash",
	"ksh",
	"mksh",
	"ash",
	"cat",
	"tee",
	"xargs",
	"find",
	"mktemp",
	"ssh",
	"watch",
	"node",
	"python",
	"python3",
	"gh",
	"pi",
	"npm",
	"tail",
];
const PATH_DIRS = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/sbin", "/usr/sbin"];
export const STUB_HOME = "/Users/stub";
/** The real macOS TMPDIR of the harness process (`/var/folders/…/T/`), as Pi's bash would inherit it. */
export const STUB_TMPDIR = process.env.TMPDIR ?? "/tmp/";
export const ROW_TIMEOUT_MS = 5_000;

export interface Call {
	name: string;
	cwd: string;
	gitDir: string;
	gitWorkTree: string;
	/** A `cd`/`pushd`/`popd` ran earlier in this process chain. */
	moved: boolean;
	/** Where to: a logical absolute path, `./rel` from the row's start dir, or "?" when unknown; "" if no cd ran. */
	cwdArg: string;
	argv: string[];
}

export interface Truth {
	/** The row's start dir (bash's `$PWD` before any cd), standing for the session's repo. */
	startDir: string;
	calls: Call[];
	exit: number | null;
	signal: string | null;
	timedOut: boolean;
	stderr: string;
	ms: number;
}

export interface Run {
	dir: string;
	bin: string;
	bashenv: string;
}

/** Makes a fresh run dir: stub bin dir (symlinks to stubs.sh) and the bashenv every bash in a row sources. */
export function prepare(commands: string[]): Run {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "guard-truth-")));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const stub = join(dir, "stubs.sh");
	writeFileSync(stub, readFileSync(join(here, "stubs.sh")));
	chmodSync(stub, 0o755);
	// Every name-like token in the corpus gets a log-only stub, so `foo && rm …` isn't cut short by "command not found".
	const names = new Set(CORE);
	for (const c of commands) for (const t of c.match(/[A-Za-z_][\w.+-]*/g) ?? []) if (t.length <= 40) names.add(t);
	// APFS is case-insensitive: `C` and `c` are one file.
	const made = new Set<string>();
	for (const n of names) {
		if (made.has(n.toLowerCase())) continue;
		made.add(n.toLowerCase());
		symlinkSync(stub, join(bin, n));
	}
	// Path-qualified names (`/usr/bin/env`, `/bin/rm`) can't exec in the sandbox; bash functions with those names
	// route them to the stub. `command /bin/rm` skips functions and is denied: the row is then `unknown`.
	const pathNames = new Set(CORE);
	for (const c of commands)
		for (const m of c.matchAll(/\/(?:[\w.-]+\/)*([A-Za-z_][\w.+-]*)/g)) if (names.has(m[1])) pathNames.add(m[1]);
	const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
	const lines = [
		"# bash-truth: sourced by every bash in a row (BASH_ENV).",
		...[...pathNames].flatMap((n) => PATH_DIRS.map((d) => `${d}/${n}() { ${q(join(bin, n))} "$@"; }`)),
		// `cd`/`pushd` always succeed (a missing dir would cut `cd x && git push` short) and mark the row as moved.
		// STUB_MOVED holds the logical directory the command moved to (absolute), or `?` when unknown (`cd -`, `popd`).
		`cd() { builtin cd "$@" 2>/dev/null || builtin cd "$STUB_ROW_W" 2>/dev/null; stub_moved "$@"; return 0; }`,
		'pushd() { stub_moved "$@"; return 0; }',
		"popd() { export STUB_MOVED='?'; return 0; }",
		// Relative to the row's start dir: `./src`; `?` once unknown (`cd -`, `cd -P x`).
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash source
		'stub_moved() { [[ ${1-} == -- ]] && shift; local t=${1-}; case $t in /*) export STUB_MOVED=$t ;; "" | -*) export STUB_MOVED="?" ;; *) case ${STUB_MOVED-} in "?") ;; "") export STUB_MOVED=./$t ;; *) export STUB_MOVED=$STUB_MOVED/$t ;; esac ;; esac; }',
		// Tests are taken as true, so `[ -d /x ] && rm -rf /x` reaches rm (the real /x isn't visible in the sandbox).
		"test() { return 0; }",
		"[() { return 0; }",
	];
	const bashenv = join(dir, "bashenv");
	writeFileSync(bashenv, `${lines.join("\n")}\n`);
	return { dir, bin, bashenv };
}

let rowCount = 0;

/** Runs one command; resolves with what the stubs logged. Never rejects on the command's own failure. */
export function truth(run: Run, command: string, opts: { tmpdir?: string } = {}): Promise<Truth> {
	const row = join(run.dir, `row${rowCount++}`);
	const w = join(row, "w");
	mkdirSync(w, { recursive: true });
	const logPath = join(row, "log");
	const log = openSync(logPath, "w");
	const env: Record<string, string> = {
		PATH: run.bin,
		HOME: STUB_HOME,
		USER: "stub",
		LANG: "C",
		BASH_ENV: run.bashenv,
		STUB_ROW_W: w,
	};
	const td = opts.tmpdir ?? STUB_TMPDIR;
	if (td !== "") env.TMPDIR = td;
	const started = performance.now();
	const child = spawn(
		"/usr/bin/sandbox-exec",
		["-D", `RUN=${run.dir}`, "-D", `ROW=${row}`, "-f", join(here, "sandbox.sb"), "/bin/bash", "-c", command],
		{
			cwd: w,
			env,
			detached: true,
			stdio: ["ignore", "ignore", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", log],
		},
	);
	closeSync(log);
	let stderr = "";
	child.stderr!.on("data", (d) => {
		if (stderr.length < 20_000) stderr += d;
	});
	return new Promise((resolve) => {
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {}
		}, ROW_TIMEOUT_MS);
		child.on("close", (exit, signal) => {
			clearTimeout(timer);
			// Anything still alive in the group (a backgrounded job) goes too.
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {}
			resolve({
				startDir: w,
				calls: parseLog(readFileSync(logPath)),
				exit,
				signal,
				timedOut,
				stderr,
				ms: performance.now() - started,
			});
		});
	});
}

/** Records are NUL-separated: name, cwd, GIT_DIR, GIT_WORK_TREE, STUB_MOVED, argc, args... */
function parseLog(buf: Buffer): Call[] {
	const f = buf.toString("utf8").split("\0");
	const calls: Call[] = [];
	let i = 0;
	while (i + 6 <= f.length - 1) {
		const [name, cwd, gitDir, gitWorkTree, moved, argc] = f.slice(i, i + 6);
		const n = Number(argc);
		if (!Number.isInteger(n)) throw new Error(`corrupt stub log at field ${i}: ${JSON.stringify(f.slice(i, i + 7))}`);
		calls.push({
			name,
			cwd,
			gitDir,
			gitWorkTree,
			moved: moved !== "",
			cwdArg: moved,
			argv: f.slice(i + 6, i + 6 + n),
		});
		i += 6 + n;
	}
	return calls;
}
