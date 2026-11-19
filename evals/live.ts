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

/** The command pi-live.sh starts: Pi under `env -i` with the sandbox env plus `extra`, writing its session to `sessionDir`. */
export function piCommand(pi: string, sandbox: Sandbox, extra: Record<string, string>, sessionDir: string): string[] {
	const env = Object.entries({ ...sandbox.env, ...extra }).map(([k, v]) => `${k}=${v}`);
	return ["env", "-i", ...env, pi, "--session-dir", sessionDir];
}
