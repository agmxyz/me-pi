/** Driving a sandboxed Pi through pi-live.sh, and the live-rig snapshot every eval runner takes before and after. */
import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Sandbox } from "./sandbox.ts";

const execFile = promisify(execFileCb);
const HERE = dirname(new URL(import.meta.url).pathname);
const PI_LIVE = join(HERE, "..", ".agents", "skills", "pi-live-test", "pi-live.sh");

export const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** What a run must leave untouched in the live rig; Pi sessions and checkouts are left out on purpose (the user may be working). */
export function liveSnapshot(realHome: string): Record<string, string> {
	const agent = join(realHome, ".pi", "agent");
	const read = (f: string) => (existsSync(join(agent, f)) ? sha(readFileSync(join(agent, f))) : "absent");
	const link = (f: string) =>
		existsSync(join(agent, f)) && lstatSync(join(agent, f)).isSymbolicLink()
			? readlinkSync(join(agent, f))
			: "absent";
	return {
		"settings.json": read("settings.json"),
		"delegate.json": read("delegate.json"),
		"AGENTS.md": link("AGENTS.md"),
		skills: existsSync(join(agent, "skills")) ? readdirSync(join(agent, "skills")).sort().join(",") : "absent",
		"auth.json mtime": existsSync(join(agent, "auth.json"))
			? String(statSync(join(agent, "auth.json")).mtimeMs)
			: "absent",
	};
}

// A Unix socket path is capped near 104 bytes, which a sandbox under a deep temp dir can exceed.
export const socketOf = (sandbox: Sandbox) => `/tmp/me-pi-eval-${sha(sandbox.root).slice(0, 12)}.sock`;

/** Runs pi-live.sh on the sandbox's private tmux server; `PI_LIVE_TIMEOUT` and `PI_LIVE_SETTLE` come from this process's env. */
export const piLive = (sandbox: Sandbox, ...args: string[]) =>
	execFile("bash", [PI_LIVE, ...args], {
		env: { ...process.env, PI_LIVE_TMUX_SOCKET: socketOf(sandbox) },
		maxBuffer: 16 * 1024 * 1024,
	});

/** The pid of the process in a pi-live tmux target's pane (Pi itself: `env -i` execs it). */
export async function panePid(sandbox: Sandbox, target: string): Promise<number> {
	const session = target.replace(/^tmux:/, "");
	const { stdout } = await execFile("tmux", ["-S", socketOf(sandbox), "display", "-p", "-t", session, "#{pane_pid}"]);
	const pid = Number(stdout.trim());
	if (!Number.isInteger(pid) || pid <= 0) throw new Error(`no pane pid for ${target}: ${stdout.trim()}`);
	return pid;
}

/** Pids of live processes whose command line contains `marker` (`pgrep -f`, as a literal string). */
export async function processesWith(marker: string): Promise<number[]> {
	const pattern = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	try {
		const { stdout } = await execFile("pgrep", ["-f", pattern]);
		return stdout.split("\n").filter(Boolean).map(Number);
	} catch (err) {
		// pgrep exits 1 when nothing matches.
		if ((err as { code?: number }).code === 1) return [];
		throw err;
	}
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const signal = (pids: number[], sig: NodeJS.Signals) => {
	for (const pid of pids)
		try {
			process.kill(pid, sig);
		} catch {
			// Exited in between.
		}
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Makes sure nothing started for an attempt survives: waits up to `graceMs` for every process whose command line
 * contains `marker` (the sandbox root; delegate workers run in their own process groups, but their args and paths name
 * it) and every pid in `pids` to exit, then SIGTERMs the rest, then SIGKILLs what still lives. Returns how many had to
 * be signalled; throws when any survive SIGKILL.
 */
export async function sweepProcesses(
	marker: string,
	pids: number[] = [],
	{ graceMs = 20_000, termMs = 3_000, pollMs = 250 } = {},
): Promise<number> {
	const left = async () => [...new Set([...(await processesWith(marker)), ...pids.filter(alive)])];
	const until = async (ms: number) => {
		const end = Date.now() + ms;
		let now = await left();
		while (now.length && Date.now() < end) {
			await sleep(pollMs);
			now = await left();
		}
		return now;
	};
	const stragglers = await until(graceMs);
	if (!stragglers.length) return 0;
	signal(stragglers, "SIGTERM");
	const stubborn = await until(termMs);
	signal(stubborn, "SIGKILL");
	const survivors = await until(termMs);
	if (survivors.length) throw new Error(`processes survived SIGKILL: ${survivors.join(", ")}`);
	return stragglers.length;
}

/** The command pi-live.sh starts: Pi under `env -i` with the sandbox env plus `extra`, writing its session to `sessionDir`. */
export function piCommand(pi: string, sandbox: Sandbox, extra: Record<string, string>, sessionDir: string): string[] {
	const env = Object.entries({ ...sandbox.env, ...extra }).map(([k, v]) => `${k}=${v}`);
	return ["env", "-i", ...env, pi, "--session-dir", sessionDir];
}
