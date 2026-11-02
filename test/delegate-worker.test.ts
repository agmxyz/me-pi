import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Checkout } from "../extensions/delegate-implement.ts";
import {
	IMPLEMENT_TOOLS,
	type Job,
	LOCAL_TOOLS,
	ROLES,
	readWorkerEnv,
	scopeWorkerPrompt,
	workerLaunch,
	workerSystemPrompt,
} from "../extensions/delegate-worker.ts";

const POLICY = readFileSync(new URL("../GLOBAL_AGENTS.md", import.meta.url), "utf8");
const headings = (text: string) => text.split("\n").filter((line) => line.startsWith("## "));
const scoped = (implement: boolean) => {
	const options = { contextFiles: [{ content: POLICY }] };
	scopeWorkerPrompt(options, { implement });
	return headings(options.contextFiles[0].content);
};

test("scopeWorkerPrompt keeps exactly the sections each worker kind may use from the real GLOBAL_AGENTS.md", () => {
	const all = headings(POLICY);
	const coordinatorOnly = all.filter((h) => h.includes("(coordinator only)"));
	const implementToo = all.filter((h) => h.includes("(coordinator and implement only)"));
	// A renamed marker would make the filter keep the section silently; both kinds must exist.
	assert.ok(coordinatorOnly.length > 0, "GLOBAL_AGENTS.md has a (coordinator only) section");
	assert.ok(implementToo.length > 0, "GLOBAL_AGENTS.md has a (coordinator and implement only) section");
	const shared = all.filter((h) => !coordinatorOnly.includes(h) && !implementToo.includes(h));
	assert.ok(shared.length > 0);
	assert.deepEqual(scoped(false), shared);
	assert.deepEqual(
		scoped(true),
		all.filter((h) => !coordinatorOnly.includes(h)),
	);
});

const BUDGET = { tools: 60, deadline: 1_700_000_000_000, cost: 4 };
const BASE = { PATH: "/bin", GH_TOKEN: "secret", GIT_CONFIG_COUNT: "1" };

test("workerLaunch builds a scout's read-only args and protocol env", () => {
	const job: Job = { ...ROLES.scout, role: "scout", output: false, jobId: "job-1", skills: ["pr"] };
	const { args, env } = workerLaunch(
		job,
		{ run: { model: "p/m", thinking: "low" }, outDir: undefined, attemptIndex: 2, budget: BUDGET },
		BASE,
	);
	assert.deepEqual(args, [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-mcp",
		"--tools",
		LOCAL_TOOLS,
		"--thinking",
		"low",
		"--append-system-prompt",
		workerSystemPrompt(job),
		"--model",
		"p/m",
	]);
	assert.deepEqual(env, {
		...BASE,
		ME_PI_RUN: "1",
		ME_PI_ROLE: "scout",
		ME_PI_OUTPUT_DIR: "",
		ME_PI_SKILLS: '["pr"]',
		ME_PI_DELEGATE_JOB_ID: "job-1",
		ME_PI_DELEGATE_ATTEMPT: "2",
		ME_PI_BUDGET: JSON.stringify(BUDGET),
	});
	const read = readWorkerEnv(env);
	assert.equal(read.implement, false);
	assert.deepEqual(read.skills, ["pr"]);
	assert.deepEqual(read.budget, BUDGET);
	assert.deepEqual(read.identity, { jobId: "job-1", attempt: 2 });
});

test("workerLaunch gives implement its tools, trust flag, and fenced env", () => {
	const checkout = {
		repoRoot: "/repo",
		commonDir: "/repo/.git",
		branch: "feat",
		check: { command: "npm test" },
		ghConfigDir: "/tmp/gh",
	} as unknown as Checkout;
	const job: Job = {
		...ROLES.implement,
		role: "implement",
		output: false,
		jobId: "job-2",
		implement: { job: checkout, trusted: true, pids: new Set(), artifacts: undefined as never },
	};
	const attempt = {
		run: { thinking: "high" },
		outDir: undefined,
		attemptIndex: 1,
		budget: { ...BUDGET, tools: null },
	};
	const { args, env } = workerLaunch(job, { ...attempt, approve: true }, BASE);
	assert.deepEqual(args.slice(0, 8), [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-mcp",
		"--tools",
		IMPLEMENT_TOOLS,
		"--approve",
	]);
	assert.deepEqual(args.slice(8, 11), ["--thinking", "high", "--append-system-prompt"]);
	assert.ok(!args.includes("--model"));
	assert.equal(workerLaunch(job, attempt, BASE).args[7], "--no-approve");
	assert.deepEqual(env, {
		PATH: "/bin",
		GIT_CONFIG_COUNT: "5",
		ME_PI_RUN: "1",
		ME_PI_ROLE: "implement",
		ME_PI_OUTPUT_DIR: "/repo",
		ME_PI_SKILLS: "",
		ME_PI_DELEGATE_JOB_ID: "job-2",
		ME_PI_DELEGATE_ATTEMPT: "1",
		ME_PI_BUDGET: JSON.stringify({ ...BUDGET, tools: null }),
		ME_PI_DENY_DIR: "/repo/.git",
		ME_PI_PARENT: String(process.pid),
		ME_PI_CHECK: "npm test",
		GH_CONFIG_DIR: "/tmp/gh",
		GIT_CONFIG_KEY_1: "protocol.ssh.allow",
		GIT_CONFIG_VALUE_1: "never",
		GIT_CONFIG_KEY_2: "protocol.https.allow",
		GIT_CONFIG_VALUE_2: "never",
		GIT_CONFIG_KEY_3: "protocol.http.allow",
		GIT_CONFIG_VALUE_3: "never",
		GIT_CONFIG_KEY_4: "protocol.git.allow",
		GIT_CONFIG_VALUE_4: "never",
	});
	const read = readWorkerEnv(env);
	assert.equal(read.implement, true);
	assert.equal(read.check, "npm test");
	assert.equal(read.parent, process.pid);
	assert.equal(read.outputDir, "/repo");
	assert.equal(read.denyDir, "/repo/.git");
	assert.equal(read.skills, undefined);
});
