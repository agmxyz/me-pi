import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

/** `extensions-only` loads the me-pi package alone; `full-rig` adds GLOBAL_AGENTS.md, skills, extra packages and extensions. */
export type Policy = "extensions-only" | "full-rig";

export interface Coordinator {
	provider: string;
	model: string;
	thinking: string;
}

export interface SandboxOptions {
	/** Git repository that holds `ref` (the me-pi checkout). It is cloned, never modified. */
	repo: string;
	ref: string;
	policy: Policy;
	coordinator: Coordinator;
	/** Written as the sandbox's delegate.json. */
	pool: object;
	/** An eval credential file, linked as the sandbox's auth.json. Never the live `~/.pi/agent/auth.json`. */
	auth?: string;
	/** full-rig only: extra skill directories, linked by absolute path. */
	skills?: string[];
	/** full-rig only: extra package sources (`npm:` or git URL specs, or local paths), loaded before me-pi as the live rig does. */
	packages?: string[];
	/** full-rig only: extension files copied into the sandbox's extensions directory. */
	extensions?: string[];
	/** Directories put on the allowlisted PATH, in front of the system ones. */
	path?: string[];
	piVersion: string;
	/** The real home: auth and package paths under its `.pi/` are refused. */
	realHome: string;
	/** Parent of the sandbox root; defaults to the OS temp directory. */
	root?: string;
}

export interface Sandbox {
	root: string;
	home: string;
	agentDir: string;
	tmp: string;
	/** The clone Pi loads me-pi from. */
	src: string;
	commit: string;
	/** The whole environment for Pi; nothing else is inherited. */
	env: Record<string, string>;
}

const SYSTEM_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function inside(path: string, dir: string): boolean {
	const rel = relative(dir, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

function refuseLive(path: string, realHome: string, what: string): string {
	const real = realpathSync(path);
	const live = existsSync(join(realHome, ".pi")) ? realpathSync(join(realHome, ".pi")) : join(realHome, ".pi");
	if (inside(real, live)) throw new Error(`${what} must not come from ${live}: ${path}`);
	return real;
}

/** Clones `ref` at its commit into `dest`, with no remote, so nothing in it can reach the source repository. */
export function cloneAt(repo: string, ref: string, dest: string): string {
	const commit = git(repo, "rev-parse", "--verify", `${ref}^{commit}`);
	execFileSync("git", ["clone", "--quiet", "--local", "--no-checkout", repo, dest], { stdio: "ignore" });
	git(dest, "checkout", "--quiet", "--detach", commit);
	git(dest, "remote", "remove", "origin");
	return commit;
}

/**
 * Builds one isolated Pi home under a new temp root: HOME, TMPDIR, and PI_CODING_AGENT_DIR (= $HOME/.pi/agent, where
 * delegate.json and the worker auth fence also resolve) all point inside it, and Pi loads me-pi from a clone of `ref`
 * through settings, as workers do. No `install.sh`, live settings, or live checkout is touched.
 */
export function createSandbox(opts: SandboxOptions): Sandbox {
	const fullRig = opts.policy === "full-rig";
	const auth = opts.auth && refuseLive(opts.auth, opts.realHome, "auth");
	const extra = fullRig
		? (opts.packages ?? []).map((p) => (/^(npm:|git:|https:)/.test(p) ? p : refuseLive(p, opts.realHome, "package")))
		: [];
	const root = mkdtempSync(join(opts.root ?? tmpdir(), "me-pi-eval-"));
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	const tmp = join(root, "tmp");
	const src = join(root, "src");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(tmp);
	const commit = cloneAt(opts.repo, opts.ref, src);

	writeFileSync(
		join(home, ".gitconfig"),
		"[user]\n\tname = me-pi eval\n\temail = eval@invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n",
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify(
			{
				packages: [...extra, src],
				...(fullRig ? { defaultTools: ["+codemode"] } : {}),
				defaultProvider: opts.coordinator.provider,
				defaultModel: opts.coordinator.model,
				defaultThinkingLevel: opts.coordinator.thinking,
				enableInstallTelemetry: false,
				lastChangelogVersion: opts.piVersion,
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(join(agentDir, "delegate.json"), `${JSON.stringify(opts.pool, null, 2)}\n`);
	if (auth) symlinkSync(auth, join(agentDir, "auth.json"));
	if (fullRig) {
		symlinkSync(join(src, "GLOBAL_AGENTS.md"), join(agentDir, "AGENTS.md"));
		const skills = join(agentDir, "skills");
		mkdirSync(skills);
		for (const name of readdirSync(join(src, "skills")))
			if (existsSync(join(src, "skills", name, "SKILL.md")))
				symlinkSync(join(src, "skills", name), join(skills, name));
		if (opts.extensions?.length) mkdirSync(join(agentDir, "extensions"));
		for (const file of opts.extensions ?? []) cpSync(file, join(agentDir, "extensions", file.split(sep).pop()!));
		for (const dir of opts.skills ?? []) {
			const real = realpathSync(dir);
			symlinkSync(real, join(skills, real.split(sep).pop()!));
		}
	}
	const path = [...(opts.path ?? []), ...SYSTEM_PATH].filter((d, i, all) => all.indexOf(d) === i);
	return {
		root,
		home,
		agentDir,
		tmp,
		src,
		commit,
		env: {
			HOME: home,
			TMPDIR: tmp,
			PI_CODING_AGENT_DIR: agentDir,
			PATH: path.join(":"),
			TERM: "xterm-256color",
			LANG: "en_US.UTF-8",
			PI_TELEMETRY: "0",
			GIT_CONFIG_NOSYSTEM: "1",
		},
	};
}

/** Copies a fixture into a fresh git repo whose first commit is identical across runs. */
export function fixtureRepo(fixture: string, dest: string, env: Record<string, string>): string {
	cpSync(fixture, dest, { recursive: true });
	const date = "2026-01-01T00:00:00Z";
	const run = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: dest,
			stdio: "ignore",
			env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
		});
	run("init", "--quiet", "-b", "main");
	run("add", "-A");
	run("commit", "--quiet", "-m", `init ${fixture.split(sep).pop()}`);
	return git(dest, "rev-parse", "HEAD");
}
