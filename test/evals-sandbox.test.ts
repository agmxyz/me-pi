import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSandbox, fixtureRepo, type SandboxOptions } from "../evals/sandbox.ts";

const ID = {
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@invalid",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@invalid",
	GIT_CONFIG_NOSYSTEM: "1",
};

/** A temp me-pi-shaped repo, plus a fake real home whose `.pi/agent/auth.json` must never be linked. */
function fixture(t: any) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "evals-sandbox-")));
	const saved = {
		HOME: process.env.HOME,
		TMPDIR: process.env.TMPDIR,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	};
	Object.assign(process.env, { HOME: dir, TMPDIR: dir, PI_CODING_AGENT_DIR: join(dir, "agent") });
	t.after(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(dir, { recursive: true, force: true });
	});
	const env = { ...process.env, ...ID };
	const repo = join(dir, "repo");
	mkdirSync(join(repo, "skills", "one"), { recursive: true });
	mkdirSync(join(repo, "skills", "not-a-skill"));
	writeFileSync(join(repo, "skills", "one", "SKILL.md"), "---\nname: one\n---\n");
	writeFileSync(join(repo, "GLOBAL_AGENTS.md"), "policy\n");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: "ignore" });
	git("init", "-q", "-b", "main");
	git("add", "-A");
	git("commit", "-qm", "init");
	git("remote", "add", "origin", "https://example.invalid/me-pi.git");
	const realHome = join(dir, "real");
	mkdirSync(join(realHome, ".pi", "agent"), { recursive: true });
	writeFileSync(join(realHome, ".pi", "agent", "auth.json"), "{}");
	writeFileSync(join(dir, "eval-auth.json"), "{}");
	const opts = (over: Partial<SandboxOptions> = {}): SandboxOptions => ({
		repo,
		ref: "main",
		policy: "full-rig",
		coordinator: { provider: "openai-codex", model: "gpt-6.1-sol", thinking: "low" },
		pool: { version: 3 },
		piVersion: "1.5.0",
		realHome,
		root: dir,
		...over,
	});
	return { dir, env, repo, realHome, opts };
}

test("a full-rig sandbox loads me-pi from a remote-less clone and keeps every path inside its root", (t) => {
	const f = fixture(t);
	writeFileSync(join(f.dir, "ext.ts"), "export default () => {};\n");
	const s = createSandbox(
		f.opts({
			auth: join(f.dir, "eval-auth.json"),
			packages: ["npm:pi-web-access@0.46.0"],
			extensions: [join(f.dir, "ext.ts")],
		}),
	);
	assert.equal(readFileSync(join(s.agentDir, "extensions", "ext.ts"), "utf8"), "export default () => {};\n");
	assert.equal(s.agentDir, join(s.home, ".pi", "agent"));
	for (const p of [s.home, s.tmp, s.src]) assert.ok(p.startsWith(`${s.root}/`), p);
	assert.equal(execFileSync("git", ["-C", s.src, "remote"], { encoding: "utf8" }).trim(), "");
	assert.equal(s.commit, execFileSync("git", ["-C", f.repo, "rev-parse", "main"], { encoding: "utf8" }).trim());

	const settings = JSON.parse(readFileSync(join(s.agentDir, "settings.json"), "utf8"));
	assert.deepEqual(settings.packages, ["npm:pi-web-access@0.46.0", s.src]);
	assert.equal(settings.defaultModel, "gpt-6.1-sol");
	assert.equal(settings.enableInstallTelemetry, false);
	assert.deepEqual(JSON.parse(readFileSync(join(s.agentDir, "delegate.json"), "utf8")), { version: 3 });
	assert.equal(readlinkSync(join(s.agentDir, "AGENTS.md")), join(s.src, "GLOBAL_AGENTS.md"));
	assert.equal(readlinkSync(join(s.agentDir, "skills", "one")), join(s.src, "skills", "one"));
	assert.ok(!existsSync(join(s.agentDir, "skills", "not-a-skill")));
	assert.equal(readlinkSync(join(s.agentDir, "auth.json")), join(f.dir, "eval-auth.json"));
	assert.match(readFileSync(join(s.home, ".gitconfig"), "utf8"), /email = eval@invalid/);

	assert.deepEqual(Object.keys(s.env).sort(), [
		"GIT_CONFIG_NOSYSTEM",
		"HOME",
		"LANG",
		"PATH",
		"PI_CODING_AGENT_DIR",
		"PI_TELEMETRY",
		"TERM",
		"TMPDIR",
	]);
	assert.equal(s.env.HOME, s.home);
	assert.equal(s.env.PI_CODING_AGENT_DIR, s.agentDir);
});

test("an extensions-only sandbox has no global policy, skills, or extra packages", (t) => {
	const f = fixture(t);
	writeFileSync(join(f.dir, "ext.ts"), "");
	const s = createSandbox(
		f.opts({
			policy: "extensions-only",
			packages: ["npm:pi-web-access@0.46.0"],
			extensions: [join(f.dir, "ext.ts")],
		}),
	);
	assert.ok(!existsSync(join(s.agentDir, "AGENTS.md")));
	assert.ok(!existsSync(join(s.agentDir, "extensions")));
	assert.ok(!existsSync(join(s.agentDir, "skills")));
	const settings = JSON.parse(readFileSync(join(s.agentDir, "settings.json"), "utf8"));
	assert.deepEqual(settings.packages, [s.src]);
	assert.equal(settings.defaultTools, undefined);
});

test("the live auth.json and live packages are refused", (t) => {
	const f = fixture(t);
	assert.throws(
		() => createSandbox(f.opts({ auth: join(f.realHome, ".pi", "agent", "auth.json") })),
		/auth must not come from/,
	);
	assert.throws(
		() => createSandbox(f.opts({ packages: [join(f.realHome, ".pi", "agent")] })),
		/package must not come from/,
	);
});

test("a fixture repo gets the same first commit every time", (t) => {
	const f = fixture(t);
	const src = join(f.dir, "tiny");
	mkdirSync(src);
	writeFileSync(join(src, "a.txt"), "a\n");
	const env = { ...ID, HOME: f.dir, PATH: process.env.PATH! };
	const one = fixtureRepo(src, join(f.dir, "one"), env);
	const two = fixtureRepo(src, join(f.dir, "two"), env);
	assert.equal(one, two);
});
