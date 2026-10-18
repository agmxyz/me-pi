import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

// Scratch space for the fake pi binary, configs, and pid files.
const TEST_HOME = mkdtempSync(join(tmpdir(), "delegate-test-"));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
process.on("exit", () => rmSync(TEST_HOME, { recursive: true, force: true }));

const {
	default: registerExtension,
	LIMITS,
	LOCAL_TOOLS,
	WEB_TOOLS,
	PROMPT_GUIDELINES,
	WORKER_CONTRACT,
	loadModelSet,
	resolveRun,
	secretPathIn,
} = await import("./delegate.ts");

const DEFAULT_LIMITS = { ...LIMITS };
// A failing lifecycle test can leave a worker running, which would keep this process alive.
after(() => {
	for (const pid of globalThis[Symbol.for("me-pi.delegate.groups")] ?? []) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
	}
});
const HAIKU = "anthropic/claude-haiku-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";

// Fake pi: reads the prompt from stdin, echoes how it was invoked; FAKE_PI_MODE drives failures.
const FAKE_BIN = join(TEST_HOME, "fake-pi.mjs");
writeFileSync(
	FAKE_BIN,
	`#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const mode = process.env.FAKE_PI_MODE || "";
const usage = (cost) => ({ input: 10, output: 5, totalTokens: 15, cost: { input: cost / 2, output: cost / 2, total: cost } });
const emit = (text, { cost = 0.002, stopReason = "stop", errorMessage } = {}) => console.log(JSON.stringify({
  type: "message_end",
  message: { role: "assistant", model: (flag("--model") || "session-default").split("/").pop(), usage: usage(cost), stopReason, errorMessage, content: [{ type: "text", text }] },
}));
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { prompt += c; });
process.stdin.on("end", () => {
  if (process.env.FAKE_PI_MARKER) appendFileSync(process.env.FAKE_PI_MARKER, JSON.stringify({ model: flag("--model"), prompt }) + "\\n");
  if (process.env.FAKE_PI_PIDFILE) writeFileSync(process.env.FAKE_PI_PIDFILE, String(process.pid));
  if (mode === "fail" || (mode === "fail-model" && flag("--model") === process.env.FAKE_PI_FAIL_MODEL)) {
    emit("partial findings", { stopReason: "error", errorMessage: "usage limit reached" });
    process.stderr.write("secret-looking stderr detail\\n");
    process.exit(1);
  }
  if (mode === "fail-round2" && flag("--model") === process.env.FAKE_PI_FAIL_MODEL && prompt.includes("## Round 2")) {
    emit("", { stopReason: "error", errorMessage: "rate limited in round 2" });
    process.exit(1);
  }
  if (mode === "retry-then-ok") { emit("", { stopReason: "error", errorMessage: "overloaded" }); emit("answer after retry"); process.exit(0); }
  if (mode === "error-exit0") { emit("half", { stopReason: "error", errorMessage: "provider error" }); process.exit(0); }
  if (mode === "silent") process.exit(0);
  if (mode === "ended-midway") { emit("reading more files", { stopReason: "toolUse" }); process.exit(0); }
  if (mode === "crash") { process.stderr.write("boom: last stderr line\\n"); process.exit(3); }
  if (mode === "hang") { emit("working", { stopReason: "toolUse" }); setInterval(() => {}, 1000); return; }
  if (mode === "expensive") {
    console.log(JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "src/a.ts" } }));
    emit("still going", { cost: 9, stopReason: "toolUse" });
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "final-over-cap") { emit("complete answer", { cost: 9 }); process.exit(0); }
  if (mode === "long") { emit("y".repeat(30 * 1024)); process.exit(0); }
  if (mode === "split-utf8") {
    const line = Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", usage: usage(0.001), stopReason: "stop", content: [{ type: "text", text: "ok ✓ done" }] } }) + "\\n");
    const cut = line.indexOf(Buffer.from("✓")) + 1;
    process.stdout.write(line.subarray(0, cut), () => setTimeout(() => process.stdout.write(line.subarray(cut), () => process.exit(0)), 100));
    return;
  }
  if (mode === "group-child-holds-pipes") {
    // A same-group child ignores SIGTERM and keeps the inherited pipes open after the leader exits.
    const child = spawn("sh", ["-c", "trap '' TERM; sleep 60"], { stdio: ["ignore", "inherit", "inherit"] });
    writeFileSync(process.env.FAKE_PI_CHILDFILE, String(child.pid));
    emit("leader done");
    process.exit(0);
  }
  if (mode === "escaped-pipes") {
    // A detached child (outside the worker group) holds the pipes, so "close" never fires.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
    writeFileSync(process.env.FAKE_PI_CHILDFILE, String(child.pid));
    emit("leader done");
    process.exit(0);
  }
  emit([
    "DONE",
    "model=" + (flag("--model") || "none"),
    "thinking=" + flag("--thinking"),
    "tools=" + flag("--tools"),
    "session=" + (args.includes("--no-session") ? "none" : "?"),
    "mcp=" + (args.includes("--no-mcp") ? "off" : "on"),
    "role=" + ((flag("--append-system-prompt") || "").match(/Role: ([a-z]+)\\./)?.[1] ?? "none"),
    "workerRun=" + (process.env.ME_PI_RUN || ""),
    "prompt=" + JSON.stringify(prompt),
  ].join(" "));
});
`,
	{ mode: 0o755 },
);

const CTX = { cwd: REPO_ROOT, model: { provider: "anthropic", id: "claude-session" } };
const text = (res) => res.content.map((c) => c.text).join("\n");

function applyEnv(vars) {
	for (const [k, v] of Object.entries(vars)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

// Sets env vars and limits for one test and restores them afterwards.
function setup(t, { env = {}, config, limits = {} } = {}) {
	const vars = { PI_BIN: FAKE_BIN, ME_PI_RUN: undefined, ...env };
	if (config !== undefined) {
		const path = join(mkdtempSync(join(TEST_HOME, "cfg-")), "delegate.json");
		writeFileSync(path, typeof config === "string" ? config : JSON.stringify(config));
		vars.ME_PI_DELEGATE_CONFIG = path;
	} else vars.ME_PI_DELEGATE_CONFIG = join(TEST_HOME, "missing.json");
	const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
	applyEnv(vars);
	Object.assign(LIMITS, limits);
	t.after(() => {
		applyEnv(saved);
		Object.assign(LIMITS, DEFAULT_LIMITS);
	});
	const tools = {};
	const handlers = {};
	registerExtension({
		registerTool: (d) => {
			tools[d.name] = d;
		},
		on: (event, h) => {
			handlers[event] = h;
		},
	});
	return { tool: tools.delegate, handlers };
}

const run = (tool, params, signal, onUpdate) => tool.execute("call", params, signal, onUpdate, CTX);
const isAlive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
async function waitFor(check, what, ms = 10000) {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}
const waitDead = (pid) => waitFor(() => !isAlive(pid), `pid ${pid} to die`, 5000).then(() => true);
const scratch = (name) => join(mkdtempSync(join(TEST_HOME, `${name}-`)), name);

test("registers delegate in the main session; workers get only the secret-path block", (t) => {
	const main = setup(t);
	assert.ok(main.tool);
	assert.deepEqual(Object.keys(main.handlers), ["session_shutdown"]);
	assert.deepEqual(main.tool.parameters.required, ["role", "task"]);
	assert.deepEqual(main.tool.parameters.properties.role.enum, ["scout", "research", "review", "challenge"]);
	const worker = setup(t, { env: { ME_PI_RUN: "1" } });
	assert.equal(worker.tool, undefined, "no nested delegation");
	assert.deepEqual(Object.keys(worker.handlers), ["tool_call"]);
});

test("workers cannot name secret paths in read, grep, find, or ls", async (t) => {
	const home = homedir();
	const dir = mkdtempSync(join(TEST_HOME, "secrets-"));
	writeFileSync(join(dir, "notes.txt"), "x");
	symlinkSync(join(home, ".ssh", "id_ed25519"), join(dir, "innocent-link"));
	for (const [tool, input] of [
		["read", { path: "~/.ssh/id_ed25519" }],
		["read", { path: join(home, ".pi/agent/auth.json") }],
		["read", { path: "@.env" }],
		["read", { path: ".env.local" }],
		["read", { path: ".ENV" }],
		["read", { path: ".envrc" }],
		["read", { path: "~/.SSH/id_rsa" }],
		["read", { path: "sub/.npmrc" }],
		["read", { path: "../.git-credentials" }],
		["read", { path: "certs/server.pem" }],
		["read", { path: "innocent-link" }],
		["grep", { pattern: "x", path: "~/.aws" }],
		["grep", { pattern: "TOKEN", path: ".", glob: "**/.env*" }],
		["grep", { pattern: "x", glob: "{*.ts,id_rsa}" }],
		["find", { pattern: "~/.ssh/*" }],
		["ls", { path: "~/.ssh" }],
	]) {
		assert.ok(secretPathIn(tool, input, dir), `${tool} ${JSON.stringify(input)} should be blocked`);
	}
	for (const [tool, input] of [
		["read", { path: "notes.txt" }],
		["read", { path: ".env.example" }],
		["read", { path: "deploy/id_ed25519.pub" }],
		["read", { path: "src/monkey.ts" }],
		["read", { path: join(home, ".pi/agent/delegate.json") }],
		["grep", { pattern: ".env", glob: "*.ts" }],
		["find", { pattern: "**/*.test.mjs" }],
		["web_search", { path: "~/.ssh" }],
	]) {
		assert.equal(secretPathIn(tool, input, dir), undefined, `${tool} ${JSON.stringify(input)} should pass`);
	}
	const hook = setup(t, { env: { ME_PI_RUN: "1" } }).handlers.tool_call;
	const blocked = await hook({ toolName: "read", input: { path: "~/.ssh/id_rsa" } }, { cwd: dir });
	assert.match(blocked.reason, /\.ssh\/id_rsa may hold secrets; delegated workers cannot read it/);
	assert.equal(await hook({ toolName: "read", input: { path: "notes.txt" } }, { cwd: dir }), undefined);
});

test("model set: scout uses the first model at low; other roles default, else last, at high", () => {
	const set = { models: [HAIKU, SONNET, OPUS] };
	assert.deepEqual(resolveRun("scout", {}, set), { model: HAIKU, thinking: "low" });
	assert.deepEqual(resolveRun("scout", { thinking: "high" }, set), { model: HAIKU, thinking: "low" });
	assert.deepEqual(resolveRun("scout", { thinking: "off" }, set), { model: HAIKU, thinking: "off" });
	assert.deepEqual(resolveRun("scout", { model: SONNET }, set), { model: SONNET, thinking: "low" });
	assert.deepEqual(resolveRun("review", {}, set), { model: OPUS, thinking: "high" });
	assert.deepEqual(resolveRun("review", {}, { ...set, default: SONNET }), { model: SONNET, thinking: "high" });
	assert.deepEqual(resolveRun("challenge", { model: OPUS, thinking: "medium" }, set), {
		model: OPUS,
		thinking: "medium",
	});
	assert.throws(() => resolveRun("review", { model: "openai/gpt-x" }, set), /not in the delegate set: anthropic/);
	// No set: the session model, any model allowed.
	assert.deepEqual(resolveRun("scout", {}, { models: [] }, "x/session"), { model: "x/session", thinking: "low" });
	assert.deepEqual(resolveRun("review", { model: "y/m" }, { models: [] }, "x/session"), {
		model: "y/m",
		thinking: "high",
	});
});

test("the model set file is validated loudly", (t) => {
	const write = (content) => {
		const path = scratch("delegate.json");
		writeFileSync(path, content);
		return path;
	};
	assert.deepEqual(loadModelSet(join(TEST_HOME, "nope.json")), { models: [] });
	assert.deepEqual(loadModelSet(write(JSON.stringify({ models: [HAIKU, OPUS], default: OPUS }))), {
		models: [HAIKU, OPUS],
		default: OPUS,
	});
	for (const [content, error] of [
		["{", /delegate config .*: /],
		["[]", /expected a JSON object/],
		[JSON.stringify({ models: [HAIKU], tiers: {} }), /unknown key\(s\) tiers \(allowed: models, default\)/],
		[JSON.stringify({ models: [{ id: HAIKU }] }), /"models" must be an array of model ids/],
		[JSON.stringify({ models: [HAIKU, HAIKU] }), /lists a model twice/],
		[JSON.stringify({ models: [HAIKU], default: OPUS }), /"default" must be one of "models"/],
	]) {
		assert.throws(() => loadModelSet(write(content)), error);
	}
	const { tool } = setup(t, { config: JSON.stringify({ models: "x" }) });
	return run(tool, { role: "scout", task: "x" }).then((res) => {
		assert.equal(res.isError, true);
		assert.match(text(res), /"models" must be an array/);
	});
});

test("the schema offers only the set's models", (t) => {
	const { tool } = setup(t, { config: { models: [HAIKU, OPUS] } });
	assert.deepEqual(tool.parameters.properties.runs.items.properties.model.enum, [HAIKU, OPUS]);
	assert.equal(setup(t).tool.parameters.properties.runs.items.properties.model.enum, undefined);
});

test("a scout runs read-only, one-shot, marked as a worker, with the prompt on stdin", async (t) => {
	const { tool } = setup(t, { config: { models: [HAIKU, OPUS] } });
	const updates = [];
	const res = await run(tool, { role: "scout", task: "-- find foo" }, undefined, (u) => updates.push(u));
	assert.equal(res.isError, false, text(res));
	assert.match(
		text(res),
		new RegExp(
			`^DONE model=${HAIKU} thinking=low tools=${LOCAL_TOOLS} session=none mcp=off role=scout workerRun=1 prompt="Task:\\\\n-- find foo"`,
		),
	);
	assert.match(text(res), /\n\[claude-haiku-5-5 @low \$0\.0020 \d+s\]$/);
	assert.equal(res.usage.cost.total, 0.002);
	assert.equal(res.usage.totalTokens, 15);
	assert.ok(updates.length >= 1, "streams progress");
	assert.match(WORKER_CONTRACT, /cannot edit files, run commands, delegate, or commit/);
});

test("roles get their tools: only research and challenge reach the web", async (t) => {
	const { tool } = setup(t, { config: { models: [HAIKU, OPUS] } });
	for (const [role, tools] of [
		["review", LOCAL_TOOLS],
		["research", WEB_TOOLS],
		["challenge", WEB_TOOLS],
	]) {
		const res = await run(tool, { role, task: "x" });
		assert.match(text(res), new RegExp(`model=${OPUS} thinking=high tools=${tools} `), role);
	}
});

test("bad calls are refused before any worker starts", async (t) => {
	const marker = scratch("marker");
	const { tool } = setup(t, { env: { FAKE_PI_MARKER: marker }, config: { models: [HAIKU, OPUS] } });
	for (const [params, error] of [
		[{ role: "implement", task: "x" }, /role must be one of scout, research, review, challenge/],
		[{ role: "scout", task: "  " }, /task must be a non-empty string/],
		[{ role: "review", task: "x", runs: [] }, /runs must have 1-4 entries/],
		[{ role: "review", task: "x", runs: Array(5).fill({}) }, /runs must have 1-4 entries/],
		[{ role: "review", task: "x", rebuttal: true }, /rebuttal needs at least 2 runs/],
		[{ role: "review", task: "x", runs: ["x"] }, /runs\[0\] must be \{ model\?: string, thinking\?: off\|/],
		[{ role: "review", task: "x", runs: [{}, { thinking: "huge" }] }, /runs\[1\] must be/],
		[{ role: "review", task: "x", model: OPUS }, /unknown parameter\(s\) model; set model and thinking inside runs/],
		[{ role: "review", task: "x", runs: [{ model: "openai/gpt-x" }] }, /not in the delegate set/],
	]) {
		const res = await run(tool, params);
		assert.equal(res.isError, true, JSON.stringify(params));
		assert.match(text(res), error);
	}
	assert.equal(existsSync(marker), false, "no worker started");
});

test("several runs answer the same task in parallel; usage is summed", async (t) => {
	const { tool } = setup(t, { config: { models: [HAIKU, SONNET, OPUS] } });
	const res = await run(tool, {
		role: "review",
		task: "q",
		runs: [{ model: SONNET }, { model: OPUS, thinking: "medium" }],
	});
	assert.equal(res.isError, false);
	const out = text(res);
	assert.match(out, new RegExp(`model=${SONNET} thinking=high`));
	assert.match(out, new RegExp(`model=${OPUS} thinking=medium`));
	assert.match(out, /Total: 2 runs, \$0\.0040\.$/);
	assert.equal(res.usage.cost.total, 0.004);
});

test("rebuttal returns only round 2; each worker saw its own and the others' answers", async (t) => {
	const marker = scratch("marker");
	const { tool } = setup(t, { env: { FAKE_PI_MARKER: marker }, config: { models: [HAIKU, SONNET, OPUS] } });
	const res = await run(tool, {
		role: "challenge",
		task: "plan",
		runs: [{ model: SONNET }, { model: OPUS }],
		rebuttal: true,
	});
	assert.equal(res.isError, false, text(res));
	const calls = readFileSync(marker, "utf8").trim().split("\n").map(JSON.parse);
	const round2 = calls.filter((c) => c.prompt.includes("## Round 2 (rebuttal)"));
	assert.equal(round2.length, 2);
	const sonnet2 = round2.find((c) => c.model === SONNET).prompt;
	assert.match(
		sonnet2,
		new RegExp(`You already answered this task in round 1\\. Your round-1 answer:\\n\\nDONE model=${SONNET}`),
	);
	assert.match(sonnet2, new RegExp(`### ${OPUS}\\nDONE model=${OPUS}`));
	assert.match(sonnet2, /Changed: yes\|no/);
	const out = text(res);
	assert.equal(out.match(/## Round 2 \(rebuttal\)/g)?.length, 2, "only round-2 answers come back");
	assert.equal(out.match(/^DONE /gm)?.length, 2, "round-1 answers stay in details");
	const saved = out.match(/Total: 4 runs, \$0\.0080\. Round-1 answers: (\S+)$/);
	assert.ok(saved, out.slice(-200));
	assert.match(readFileSync(saved[1], "utf8"), new RegExp(`^## ${SONNET} \\(round 1\\)\\n\\nDONE model=${SONNET}`));
	assert.equal(res.details.round1.length, 2);
	assert.equal(res.usage.cost.total, 0.008);
});

test("a failed round-2 run falls back to its round-1 answer, in request order", async (t) => {
	const { tool } = setup(t, {
		env: { FAKE_PI_MODE: "fail-round2", FAKE_PI_FAIL_MODEL: SONNET },
		config: { models: [HAIKU, SONNET, OPUS] },
	});
	const res = await run(tool, {
		role: "review",
		task: "q",
		runs: [{ model: SONNET }, { model: OPUS }],
		rebuttal: true,
	});
	assert.equal(res.isError, true);
	const [first, second] = text(res).split("\n\n---\n\n");
	assert.match(
		first,
		new RegExp(`^✗ round 2 failed: exit 1: rate limited in round 2\\nRound-1 answer:\\nDONE model=${SONNET}`),
	);
	assert.match(second, /^DONE model=anthropic\/claude-opus-5-5 .*## Round 2 \(rebuttal\)/);
});

test("rebuttal is skipped and flagged when fewer than two runs succeed", async (t) => {
	const { tool } = setup(t, {
		env: { FAKE_PI_MODE: "fail-model", FAKE_PI_FAIL_MODEL: OPUS },
		config: { models: [SONNET, OPUS] },
	});
	const res = await run(tool, {
		role: "review",
		task: "q",
		runs: [{ model: SONNET }, { model: OPUS }],
		rebuttal: true,
	});
	assert.equal(res.isError, true);
	assert.match(text(res), /Rebuttal skipped: only 1 run\(s\) succeeded in round 1\.$/);
});

test("a failure is one line plus a bounded partial answer; stderr stays out of the model's view", async (t) => {
	const { tool } = setup(t, { env: { FAKE_PI_MODE: "fail" } });
	const res = await run(tool, { role: "scout", task: "x" });
	assert.equal(res.isError, true);
	assert.match(text(res), /^✗ exit 1: usage limit reached\nPartial answer:\npartial findings\n\[/);
	assert.doesNotMatch(text(res), /secret-looking stderr/);
	assert.match(res.details.round1[0].stderr, /secret-looking stderr detail/);

	const crash = await run(setup(t, { env: { FAKE_PI_MODE: "crash" } }).tool, { role: "scout", task: "x" });
	assert.match(text(crash), /^✗ exit 3: boom: last stderr line\n/);
	const missing = await run(setup(t, { env: { PI_BIN: join(TEST_HOME, "no-such-pi") } }).tool, {
		role: "scout",
		task: "x",
	});
	assert.match(text(missing), /^✗ could not start pi: spawn .*no-such-pi ENOENT/);
});

test("only the latest reply decides success; an empty or errored run fails", async (t) => {
	const retry = await run(setup(t, { env: { FAKE_PI_MODE: "retry-then-ok" } }).tool, { role: "scout", task: "x" });
	assert.equal(retry.isError, false, text(retry));
	assert.match(text(retry), /^answer after retry\n/);
	const errored = await run(setup(t, { env: { FAKE_PI_MODE: "error-exit0" } }).tool, { role: "scout", task: "x" });
	assert.equal(errored.isError, true);
	assert.match(text(errored), /^✗ provider error\nPartial answer:\nhalf\n/);
	const silent = await run(setup(t, { env: { FAKE_PI_MODE: "silent" } }).tool, { role: "scout", task: "x" });
	assert.equal(silent.isError, true);
	assert.match(text(silent), /^✗ worker produced no answer\n/);
	const midway = await run(setup(t, { env: { FAKE_PI_MODE: "ended-midway" } }).tool, { role: "scout", task: "x" });
	assert.equal(midway.isError, true);
	assert.match(text(midway), /^✗ worker ended without a final answer\nPartial answer:\nreading more files\n/);
});

test("a full answer that cannot be saved is reported, not thrown", async (t) => {
	const blocker = scratch("not-a-dir");
	writeFileSync(blocker, "");
	const { tool } = setup(t, { env: { FAKE_PI_MODE: "long", TMPDIR: blocker } });
	const res = await run(tool, { role: "scout", task: "x" });
	assert.match(text(res), /\[answer truncated at 12288 bytes\] Full answer: \(not saved: .*\)\n\[/);
});

test("answers are capped for the main context without splitting UTF-8", async (t) => {
	const long = await run(setup(t, { env: { FAKE_PI_MODE: "long" } }).tool, { role: "scout", task: "x" });
	const m = text(long).match(/^y{12288}\n\[answer truncated at 12288 bytes\] Full answer: (\S+)\n\[/);
	assert.ok(m, text(long).slice(-200));
	assert.equal(readFileSync(m[1], "utf8"), "y".repeat(30 * 1024));
	assert.equal(statSync(m[1]).mode & 0o777, 0o600);
	const split = await run(setup(t, { env: { FAKE_PI_MODE: "split-utf8" } }).tool, { role: "scout", task: "x" });
	assert.match(text(split), /^ok ✓ done\n/);
});

test("the cost cap stops a continuing worker but keeps a final answer", { timeout: 20000 }, async (t) => {
	const capped = await run(setup(t, { env: { FAKE_PI_MODE: "expensive" } }).tool, { role: "scout", task: "x" });
	assert.equal(capped.isError, true);
	assert.match(text(capped), /^✗ stopped: cost cap \$5 reached\nPartial answer:\nstill going/);
	assert.deepEqual(capped.details.round1[0].tools, ["read src/a.ts"]);
	const final = await run(setup(t, { env: { FAKE_PI_MODE: "final-over-cap" } }).tool, { role: "scout", task: "x" });
	assert.equal(final.isError, false);
	assert.match(text(final), /^complete answer\n/);
});

test("timeout SIGKILLs the worker group", { timeout: 20000 }, async (t) => {
	const pidFile = scratch("pid");
	const { tool } = setup(t, {
		env: { FAKE_PI_MODE: "hang", FAKE_PI_PIDFILE: pidFile },
		limits: { scoutTimeoutSecs: 0.5 },
	});
	const started = Date.now();
	const res = await run(tool, { role: "scout", task: "x" });
	assert.match(text(res), /^✗ stopped: timeout after 0\.5s\nPartial answer:\nworking/);
	assert.ok(Date.now() - started < 4000);
	assert.ok(await waitDead(Number(readFileSync(pidFile, "utf8"))));
});

test("abort and session shutdown stop running workers; later calls still work", { timeout: 20000 }, async (t) => {
	const pidFile = scratch("pid");
	const { tool, handlers } = setup(t, { env: { FAKE_PI_MODE: "hang", FAKE_PI_PIDFILE: pidFile } });
	const controller = new AbortController();
	const aborted = run(tool, { role: "scout", task: "x" }, controller.signal);
	await waitFor(() => existsSync(pidFile), "worker start");
	controller.abort();
	assert.match(text(await aborted), /^✗ stopped: cancelled/);
	assert.ok(await waitDead(Number(readFileSync(pidFile, "utf8"))));

	rmSync(pidFile);
	const pending = run(tool, { role: "scout", task: "x" });
	await waitFor(() => existsSync(pidFile), "worker start");
	await handlers.session_shutdown();
	assert.match(text(await pending), /^✗ stopped: cancelled/);
	process.env.FAKE_PI_MODE = "";
	assert.equal((await run(tool, { role: "scout", task: "x" })).isError, false, "a fresh shutdown signal");

	const pre = new AbortController();
	pre.abort();
	assert.match(text(await run(tool, { role: "scout", task: "x" }, pre.signal)), /^✗ cancelled before start/);
});

test(
	"leader exit kills a same-group child holding the pipes; an escaped one is bounded",
	{ timeout: 20000 },
	async (t) => {
		const childFile = scratch("child");
		const same = setup(t, { env: { FAKE_PI_MODE: "group-child-holds-pipes", FAKE_PI_CHILDFILE: childFile } });
		const res = await run(same.tool, { role: "scout", task: "x" });
		assert.equal(res.isError, false, text(res));
		assert.ok(await waitDead(Number(readFileSync(childFile, "utf8"))), "same-group child killed");

		const escapedFile = scratch("escaped");
		const escaped = setup(t, { env: { FAKE_PI_MODE: "escaped-pipes", FAKE_PI_CHILDFILE: escapedFile } });
		t.after(() => {
			if (existsSync(escapedFile)) process.kill(Number(readFileSync(escapedFile, "utf8")), "SIGKILL");
		});
		const started = Date.now();
		const bounded = await run(escaped.tool, { role: "scout", task: "x" });
		assert.ok(Date.now() - started < 4000);
		// The answer was complete, so it counts; the stray pipe holder is noted in the details.
		assert.equal(bounded.isError, false, text(bounded));
		assert.match(text(bounded), /^leader done\n/);
		assert.match(
			bounded.details.round1[0].stderr,
			/after the final answer: worker exited but its output pipes stayed open/,
		);
	},
);

test("normal main-process exit SIGKILLs live workers", { timeout: 20000 }, async () => {
	const pidFile = scratch("pid");
	const script = join(TEST_HOME, "parent-exit.mjs");
	writeFileSync(
		script,
		`
import register from ${JSON.stringify(new URL("./delegate.ts", import.meta.url).href)};
import { existsSync } from "node:fs";
let delegate;
register({ registerTool: (d) => { delegate = d; }, on: () => {} });
void delegate.execute("p", { role: "scout", task: "hold" }, undefined, undefined, { cwd: ${JSON.stringify(REPO_ROOT)} });
const deadline = Date.now() + 10000;
while (!existsSync(${JSON.stringify(pidFile)}) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
process.exit(existsSync(${JSON.stringify(pidFile)}) ? 0 : 2);
`,
	);
	const env = { ...process.env, PI_BIN: FAKE_BIN, FAKE_PI_MODE: "hang", FAKE_PI_PIDFILE: pidFile };
	delete env.ME_PI_RUN;
	env.ME_PI_DELEGATE_CONFIG = join(TEST_HOME, "missing.json");
	const child = spawn(process.execPath, [script], { env, stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (c) => {
		stderr += c;
	});
	assert.equal(await new Promise((r) => child.once("close", r)), 0, stderr);
	assert.ok(await waitDead(Number(readFileSync(pidFile, "utf8"))), "exit handler killed the worker");
});

test("guidelines keep delegation proportionate and require reviews and BLOCKED handling", () => {
	const all = PROMPT_GUIDELINES.join("\n");
	assert.match(all, /more than about 3 files you will not edit/);
	assert.match(all, /do not edit those files until the review returns/);
	assert.match(all, /`rebuttal: true`/);
	assert.match(all, /BLOCKED/);
});
