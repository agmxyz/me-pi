import { mkdirSync } from "node:fs";
import { join } from "node:path";

const KEYS = ["HOME", "TMPDIR", "PI_CODING_AGENT_DIR", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"] as const;

/**
 * Points HOME, TMPDIR and PI_CODING_AGENT_DIR into `root` for the code under test (guard runs git, which reads HOME's
 * config) and restores them after the test; no system or real-home git config is read.
 */
export function isolate(t: { after(fn: () => void): void }, root: string): void {
	const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
	t.after(() => {
		for (const k of KEYS)
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
	});
	const home = join(root, "home");
	mkdirSync(join(home, "tmp"), { recursive: true });
	Object.assign(process.env, {
		HOME: home,
		TMPDIR: join(home, "tmp"),
		PI_CODING_AGENT_DIR: join(home, "agent"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
	});
}
