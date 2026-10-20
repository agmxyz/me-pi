import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
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
	PROMPT_SNIPPET,
	ROLES,
	WORKER_CONTRACT,
	loadModelSet,
	resolveRun,
	secretPathIn,
	writeBlockedIn,
} = await import("./delegate.ts");
const { progressLines } = await import("./delegate-render.ts");

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
const LUNA = "openai-codex/gpt-6-luna";
const POOL_SET = {
	version: 3,
	scout: {
		models: [
			{ model: LUNA, thinking: "off" },
			{ model: HAIKU, thinking: "off" },
		],
		thinking: "low",
	},
	worker: {
		models: [
			{ model: LUNA, thinking: "max" },
			{ model: OPUS, thinking: "max" },
		],
		thinking: "max",
	},
};

// Fake pi: reads the prompt from stdin, echoes how it was invoked; FAKE_PI_MODE drives failures.
const FAKE_BIN = join(TEST_HOME, "fake-pi.mjs");
writeFileSync(
	FAKE_BIN,
	`#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
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
  if (process.env.FAKE_PI_MARKER) appendFileSync(process.env.FAKE_PI_MARKER, JSON.stringify({ model: flag("--model"), thinking: flag("--thinking"), prompt }) + "\\n");
  if (process.env.FAKE_PI_PIDFILE) writeFileSync(process.env.FAKE_PI_PIDFILE, String(process.pid));
  if (mode === "rate-limit-model" && flag("--model") === process.env.FAKE_PI_FAIL_MODEL) {
    emit("", { stopReason: "error", errorMessage: "429 rate_limit_error: too many requests" });
    process.exit(1);
  }
  if (mode === "rate-limit-models" && process.env.FAKE_PI_FAIL_MODELS?.split(",").includes(flag("--model"))) {
    emit("", { stopReason: "error", errorMessage: "429 rate_limit_error: too many requests" });
    process.exit(1);
  }
  if (mode === "quota-model" && flag("--model") === process.env.FAKE_PI_FAIL_MODEL) {
    emit("", { stopReason: "error", errorMessage: process.env.FAKE_PI_ERROR });
    process.exit(1);
  }
  if (mode === "unavailable-model" && flag("--model") === process.env.FAKE_PI_FAIL_MODEL) {
    emit("", { stopReason: "error", errorMessage: "model not found: unavailable" });
    process.exit(1);
  }
  if (mode === "fail" || (mode === "fail-model" && flag("--model") === process.env.FAKE_PI_FAIL_MODEL)) {
    emit("partial findings", { stopReason: "error", errorMessage: "invalid request: tool schema rejected" });
    process.stderr.write("secret-looking stderr detail\\n");
    process.exit(1);
  }
  if (mode === "fail-round2" && flag("--model") === process.env.FAKE_PI_FAIL_MODEL && prompt.includes("## Round 2")) {
    emit("", { stopReason: "error", errorMessage: "task-specific error in round 2" });
    process.exit(1);
  }
  if (mode === "retry-then-ok") { emit("", { stopReason: "error", errorMessage: "overloaded" }); emit("answer after retry"); process.exit(0); }
  if (mode === "error-exit0") { emit("half", { stopReason: "error", errorMessage: "provider error" }); process.exit(0); }
  if (mode === "write-many") {
    const out = process.env.ME_PI_OUTPUT_DIR;
    writeFileSync(out + "/a\\n[forged label]", "x");
    for (let i = 0; i < 52; i++) writeFileSync(out + "/f" + String(i).padStart(2, "0"), "x");
    emit("wrote many");
    process.exit(0);
  }
  if (mode === "write-draft") {
    const out = process.env.ME_PI_OUTPUT_DIR;
    mkdirSync(out + "/notes");
    writeFileSync(out + "/notes/draft.md", "DRAFT-BODY");
    const sp = flag("--append-system-prompt") || "";
    emit("wrote notes/draft.md tools=" + flag("--tools") + " promptNamesDir=" + (sp.includes("only for files inside " + out + ". Relative paths resolve against the project, not this directory")));
    process.exit(0);
  }
  // implement modes: git runs in the worker's cwd, which is inside its worktree.
  const git = (...a) => spawnSync("git", a, { encoding: "utf8" });
  if (mode === "implement-commit" || mode === "move-ref") {
    writeFileSync("feature.txt", "IMPLEMENT-DIFF-BODY\\n");
    git("add", "-A");
    git("commit", "-q", "-m", "feat: add feature");
    if (mode === "move-ref") git("update-ref", "refs/heads/other", "HEAD");
    emit("changed feature.txt; npm test: pass");
    process.exit(0);
  }
  if (mode === "implement-dirty") { writeFileSync("left.txt", "x\\n"); emit("left it uncommitted"); process.exit(0); }
  if (mode === "implement-hang") {
    writeFileSync("left.txt", "x\\n");
    // Pi's print mode exits on SIGTERM; the marker proves TERM came before any SIGKILL.
    process.on("SIGTERM", () => { appendFileSync(process.env.FAKE_PI_TERMFILE, "TERM\\n"); process.exit(143); });
    emit("working", { stopReason: "toolUse" });
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "echo-env") {
    const e = process.env;
    const keys = Object.keys(e).filter((k) => k.startsWith("GIT_CONFIG_") || k.startsWith("GH_") || k.startsWith("GITHUB_") || k === "ME_PI_ROLE" || k === "ME_PI_OUTPUT_DIR");
    emit("ENV " + JSON.stringify({ env: Object.fromEntries(keys.sort().map((k) => [k, e[k]])), tools: flag("--tools"), approve: args.includes("--approve"), noApprove: args.includes("--no-approve"), cwd: process.cwd() }));
    process.exit(0);
  }
  if (mode === "echo-budget") { emit(process.env.ME_PI_BUDGET || "none"); process.exit(0); }
  if (mode === "echo-system") { emit(flag("--append-system-prompt") || ""); process.exit(0); }
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
    ...(args.includes("--approve") ? ["approve=yes"] : args.includes("--no-approve") ? ["approve=no"] : []),
  ].join(" "));
});
`,
	{ mode: 0o755 },
);

const CTX = { cwd: REPO_ROOT, model: { provider: "anthropic", id: "claude-session" }, thinkingLevel: "high" };
const text = (res) => res.content.map((c) => c.text).join("\n");

function applyEnv(vars) {
	for (const [k, v] of Object.entries(vars)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

// Sets env vars and limits for one test and restores them afterwards.
function setup(t, { env = {}, config, limits = {}, keepHistory = false } = {}) {
	const vars = {
		PI_BIN: FAKE_BIN,
		ME_PI_RUN: undefined,
		ME_PI_OUTPUT_DIR: undefined,
		ME_PI_BUDGET: undefined,
		ME_PI_ROLE: undefined,
		TMPDIR: TEST_HOME,
		...env,
	};
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
	const commands = {};
	const messages = [];
	const pi = {
		sendMessage: (message, options) => messages.push({ message, options }),
		registerTool: (d) => {
			tools[d.name] = d;
		},
		registerCommand: (name, options) => {
			commands[name] = options;
		},
		getAllTools: () => Object.values(tools).map((d) => ({ name: d.name })),
		on: (event, h) => {
			handlers[event] = h;
		},
	};
	// The call history survives reloads on globalThis; each test starts empty unless it simulates a reload.
	if (!keepHistory) {
		globalThis[Symbol.for("me-pi.delegate.history")] = [];
		globalThis[Symbol.for("me-pi.delegate.background-spend")] = { cost: 0 };
	}
	registerExtension(pi);
	return { tool: tools.delegate, handlers, commands, pi, messages };
}

const run = (tool, params, signal, onUpdate, ctx = CTX) => tool.execute("call", params, signal, onUpdate, ctx);
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
	const { properties, required } = main.tool.parameters;
	assert.deepEqual(required, ["task"]);
	assert.deepEqual(properties.role.enum, ["general", "scout", "research", "review", "challenge", "implement"]);
	assert.equal(properties.branch.type, "string");
	assert.equal(properties.web.type, "boolean");
	assert.equal(properties.answer.maxLength, 400);
	assert.equal(properties.output.type, "boolean");
	assert.equal(typeof main.tool.renderCall, "function");
	assert.equal(typeof main.tool.renderResult, "function");
	const worker = setup(t, { env: { ME_PI_RUN: "1" } });
	assert.equal(worker.tool, undefined, "no nested delegation");
	assert.deepEqual(Object.keys(worker.handlers).sort(), ["message_end", "tool_call"]);
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

test("implement workers' bash calls are checked against the worker-only rules", async (t) => {
	const bash = (command) => ({ toolName: "bash", input: { command } });
	const hook = setup(t, { env: { ME_PI_RUN: "1", ME_PI_ROLE: "implement" } }).handlers.tool_call;
	const blocked = await hook(bash("git push origin x"), { cwd: REPO_ROOT });
	assert.equal(blocked?.block, true);
	assert.match(blocked.reason, /^Blocked: git push is main-session only; list it as BLOCKED\.$/);
	assert.equal(await hook(bash("npm test"), { cwd: REPO_ROOT }), undefined);
	const other = setup(t, { env: { ME_PI_RUN: "1" } }).handlers.tool_call;
	assert.equal(await other(bash("git push origin x"), { cwd: REPO_ROOT }), undefined);
});

test("workers get a wrap-up budget: tool calls, 80% of the time limit, 80% of the cost cap", async (t) => {
	const { tool } = setup(t, { config: { models: [HAIKU, OPUS] }, env: { FAKE_PI_MODE: "echo-budget" } });
	for (const [role, tools, secs] of [
		["scout", 30, 300],
		["review", 100, 900],
	]) {
		const before = Date.now();
		const res = await run(tool, { role, task: "x" });
		const budget = JSON.parse(text(res).split("\n")[0]);
		assert.equal(budget.tools, tools, role);
		assert.equal(budget.cost, 4, role);
		assert.ok(budget.deadline >= before + secs * 800 && budget.deadline <= Date.now() + secs * 800, role);
	}
});

test("past the wrap-up budget, a worker's tool calls are blocked with an answer-now reason", async (t) => {
	const far = Date.now() + 60_000;
	const worker = (budget) => setup(t, { env: { ME_PI_RUN: "1", ME_PI_BUDGET: JSON.stringify(budget) } }).handlers;
	const call = (h) => h.tool_call({ toolName: "read", input: { path: "README.md" } }, { cwd: REPO_ROOT });

	const counted = worker({ tools: 2, deadline: far, cost: 1 });
	assert.equal(await call(counted), undefined);
	assert.equal(await call(counted), undefined);
	const over = await call(counted);
	assert.equal(
		over.reason,
		"Blocked: budget reached (2 tool calls). Stop using tools; give your final answer now, and list what is unverified.",
	);
	// Three ignored blocks are allowed; the fourth also terminates the run.
	assert.deepEqual(
		[over.terminate, (await call(counted)).terminate, (await call(counted)).terminate],
		[false, false, false],
	);
	assert.equal((await call(counted)).terminate, true);
	// The budget check comes first: an over-budget call to a secret path gets the budget reason.
	const spentFirst = worker({ tools: 0, deadline: far, cost: 1 });
	const secret = await spentFirst.tool_call({ toolName: "read", input: { path: ".env" } }, { cwd: REPO_ROOT });
	assert.match(secret.reason, /budget reached/);

	const priced = worker({ tools: 100, deadline: far, cost: 0.5 });
	const usage = (cost) => ({ cost: { total: cost } });
	await priced.message_end({ message: { role: "user", usage: usage(9) } });
	await priced.message_end({ message: { role: "assistant", usage: usage(0.3) } });
	assert.equal(await call(priced), undefined);
	await priced.message_end({ message: { role: "assistant", usage: usage(0.2) } });
	assert.match((await call(priced)).reason, /budget reached \(\$0\.50 cost\)/);

	const single = worker({ tools: 1, deadline: far, cost: 1 });
	await call(single);
	assert.match((await call(single)).reason, /budget reached \(1 tool call\)\./);

	const late = worker({ tools: 100, deadline: Date.now() - 1, cost: 1 });
	assert.match((await call(late)).reason, /budget reached \(time\)/);

	const unbounded = setup(t, { env: { ME_PI_RUN: "1", ME_PI_BUDGET: undefined } }).handlers;
	for (let i = 0; i < 150; i++) assert.equal(await call(unbounded), undefined);
	assert.throws(() => setup(t, { env: { ME_PI_RUN: "1", ME_PI_BUDGET: '{"tools":1}' } }), /invalid ME_PI_BUDGET/);
});

test("workers write only inside their own output directory", async (t) => {
	const out = mkdtempSync(join(TEST_HOME, "out-"));
	const cwd = mkdtempSync(join(TEST_HOME, "cwd-"));
	symlinkSync(TEST_HOME, join(out, "escape-link"));
	for (const [tool, input] of [
		["write", { path: join(cwd, "x.md") }],
		["write", { path: "x.md" }],
		["write", { path: join(out, "../x.md") }],
		["write", { path: out }],
		["write", { path: `${out}-sibling/x.md` }],
		["write", { path: join(out, "escape-link/x.md") }],
		["write", { path: "~/x.md" }],
		["write", { path: `file://${out}/x.md` }],
		["write", {}],
		["edit", { path: join(cwd, "x.md") }],
	]) {
		assert.ok(writeBlockedIn(tool, input, cwd, out), `${tool} ${JSON.stringify(input)} should be blocked`);
	}
	for (const input of [{ path: join(out, "a.md") }, { path: `@${out}/new/dir/b.md` }, { path: join(out, "..x.md") }]) {
		assert.equal(writeBlockedIn("write", input, cwd, out), undefined, `${JSON.stringify(input)} should pass`);
	}
	// Pi expands these to $HOME and a file URL, so they are refused even where they would resolve inside.
	assert.match(writeBlockedIn("write", { path: "~/x.md" }, out, out), /use an absolute path inside/);
	assert.match(writeBlockedIn("write", { path: "file:x.md" }, out, out), /use an absolute path inside/);
	// A dangling symlink inside: the write would follow it out.
	symlinkSync(join(cwd, "made-by-write.md"), join(out, "dangling.md"));
	assert.match(writeBlockedIn("write", { path: join(out, "dangling.md") }, cwd, out), /cannot be resolved/);
	// Pi writes `a<NBSP>b/x.md` to `a b/x.md`; a symlink named with the NBSP must not decide the check.
	mkdirSync(join(cwd, "a b"));
	symlinkSync(out, join(cwd, "a\u00A0b"));
	assert.match(writeBlockedIn("write", { path: join(cwd, "a\u00A0b/x.md") }, cwd, out), /is outside/);
	// A relative path resolves against the project: the reason says where it went and where to write.
	const rel = writeBlockedIn("write", { path: "notes/x.md" }, cwd, out);
	assert.ok(rel.startsWith("notes/x.md resolves to "), rel);
	assert.ok(rel.endsWith(`, outside ${out}; write to ${join(out, "notes/x.md")} instead`), rel);
	assert.doesNotMatch(writeBlockedIn("write", { path: "../x.md" }, cwd, out), /write to/);
	assert.doesNotMatch(writeBlockedIn("write", { path: "." }, cwd, out), /write to/);
	// A suggestion through a symlink that leaves the directory is still blocked when followed.
	symlinkSync(cwd, join(out, "linked"));
	const viaLink = writeBlockedIn("write", { path: "linked/x.md" }, cwd, out);
	assert.ok(viaLink.endsWith(`; write to ${join(out, "linked/x.md")} instead`), viaLink);
	assert.match(writeBlockedIn("write", { path: join(out, "linked/x.md") }, cwd, out), /is outside/);
	assert.equal(
		writeBlockedIn("write", { path: join(cwd, "x.md") }, cwd, out),
		`${join(cwd, "x.md")} is outside ${out}`,
	);
	assert.equal(writeBlockedIn("read", { path: join(cwd, "x.md") }, cwd, out), undefined);
	assert.match(writeBlockedIn("write", { path: join(out, "a.md") }, cwd, ""), /without `output: true`/);

	const hook = setup(t, { env: { ME_PI_RUN: "1", ME_PI_OUTPUT_DIR: out } }).handlers.tool_call;
	const blocked = await hook({ toolName: "write", input: { path: join(cwd, "x.md") } }, { cwd });
	assert.match(blocked.reason, /^Blocked: .*x\.md is outside /);
	assert.equal(await hook({ toolName: "write", input: { path: join(out, "a.md") } }, { cwd }), undefined);
	const noOutput = setup(t, { env: { ME_PI_RUN: "1", ME_PI_OUTPUT_DIR: "" } }).handlers.tool_call;
	assert.ok((await noOutput({ toolName: "write", input: { path: join(out, "a.md") } }, { cwd })).block);
});

test("output: each worker gets write and a fresh 0700 directory; the result lists files, not contents", async (t) => {
	const { tool } = setup(t, { config: { models: [HAIKU, OPUS] }, env: { FAKE_PI_MODE: "write-draft" } });
	const res = await run(tool, { task: "draft", output: true, runs: [{ model: HAIKU }, { model: OPUS }] });
	assert.equal(res.isError, false, text(res));
	assert.doesNotMatch(text(res), /DRAFT-BODY/);
	const dirs = [...text(res).matchAll(/\nFiles in (\S+): notes\/draft\.md \(10 B\)\n/g)].map((m) => m[1]);
	assert.equal(dirs.length, 2, text(res));
	assert.notEqual(dirs[0], dirs[1]);
	for (const dir of dirs) {
		assert.equal(statSync(dir).mode & 0o777, 0o700);
		assert.equal(readFileSync(join(dir, "notes/draft.md"), "utf8"), "DRAFT-BODY");
	}
	assert.match(text(res), new RegExp(`tools=${LOCAL_TOOLS},write promptNamesDir=true`));
});

test("output with rebuttal: round 2 gets new directories and the round-1 file lists", async (t) => {
	const marker = scratch("marker");
	const { tool } = setup(t, {
		config: { models: [HAIKU, OPUS] },
		env: { FAKE_PI_MODE: "write-draft", FAKE_PI_MARKER: marker },
	});
	const res = await run(tool, { task: "d", output: true, runs: [{ model: HAIKU }, { model: OPUS }], rebuttal: true });
	assert.equal(res.isError, false, text(res));
	const dirsOf = (s) => [...s.matchAll(/Files in (\S+): notes\/draft\.md \(10 B\)/g)].map((m) => m[1]);
	const round1File = text(res).match(/Round-1 answers: (\S+)/)[1];
	const round1Dirs = dirsOf(readFileSync(round1File, "utf8"));
	const round2Dirs = dirsOf(text(res));
	assert.equal(new Set([...round1Dirs, ...round2Dirs]).size, 4, text(res));
	const round2 = readFileSync(marker, "utf8")
		.trim()
		.split("\n")
		.map(JSON.parse)
		.filter((c) => c.prompt.includes("## Round 2"));
	for (const c of round2) assert.deepEqual(dirsOf(c.prompt).sort(), [...round1Dirs].sort());
});

test("output: the file list is capped and quotes names with control characters", async (t) => {
	const { tool } = setup(t, { config: { models: [HAIKU, OPUS] }, env: { FAKE_PI_MODE: "write-many" } });
	const res = text(await run(tool, { task: "x", output: true }));
	assert.match(res, /: "a\\n\[forged label\]" \(1 B\), f00 \(1 B\), /);
	assert.match(res, /, f48 \(1 B\), \u2026 3 more\n\[claude-opus-5-5 /);
	assert.equal(res.split("\n").length, 3, res);
});

test("output: a failed round-2 run lists its own directory", async (t) => {
	const { tool } = setup(t, {
		config: { models: [HAIKU, OPUS] },
		env: { FAKE_PI_MODE: "fail-round2", FAKE_PI_FAIL_MODEL: OPUS },
	});
	const res = await run(tool, { task: "x", output: true, runs: [{ model: HAIKU }, { model: OPUS }], rebuttal: true });
	assert.match(
		text(res),
		/round 2 failed: exit 1: task-specific error in round 2\nFiles in \S+: none written\nRound-1 answer:/,
	);
	// The TUI view names the failed round-2 run's directory too, and the rounds do not repeat the answers.
	assert.match(
		res.details.view.runs[1].round2Failure,
		/^exit 1: task-specific error in round 2; Files in \S+: none written$/,
	);
	assert.equal(res.details.round1[0].output, undefined);
	assert.equal(res.details.round2[0].output, undefined);
	assert.match(res.details.round1[0].outDir, /me-pi-delegate-out-/);
});

test("output: a failed run still lists its files; a failed mkdtemp is reported", async (t) => {
	const failed = setup(t, { config: { models: [HAIKU, OPUS] }, env: { FAKE_PI_MODE: "fail" } });
	assert.match(text(await run(failed.tool, { task: "x", output: true })), /\nFiles in \S+: none written\n\[/);
	const noTmp = setup(t, { config: { models: [HAIKU, OPUS] }, env: { TMPDIR: join(TEST_HOME, "missing-tmp") } });
	const res = await run(noTmp.tool, { task: "x", output: true });
	assert.equal(res.isError, true);
	assert.match(text(res), /^\u2717 could not create the output directory: ENOENT/);
});

test("output with no files written says so; without output there is no write tool", async (t) => {
	const none = setup(t, { config: { models: [HAIKU, OPUS] } });
	const empty = text(await run(none.tool, { task: "x", output: true }));
	assert.match(empty, /^DONE .*tools=read,grep,find,ls,Skill,write .*\nFiles in \S+: none written\n\[/);
	const without = text(await run(none.tool, { task: "x" }));
	assert.doesNotMatch(without, /Files in|,write/);
});

test("model pools resolve per-model thinking, ordered fallbacks, and explicit overrides", () => {
	assert.deepEqual(resolveRun("scout", {}, POOL_SET), {
		model: LUNA,
		candidates: [
			{ model: LUNA, thinking: "off" },
			{ model: HAIKU, thinking: "off" },
		],
		thinking: "off",
	});
	assert.deepEqual(resolveRun("review", {}, POOL_SET), {
		model: LUNA,
		candidates: [
			{ model: LUNA, thinking: "max" },
			{ model: OPUS, thinking: "max" },
		],
		thinking: "max",
	});
	assert.deepEqual(resolveRun("research", { model: OPUS, thinking: "high" }, POOL_SET), {
		model: OPUS,
		candidates: [
			{ model: OPUS, thinking: "high" },
			{ model: LUNA, thinking: "high" },
		],
		thinking: "high",
	});
	assert.deepEqual(resolveRun("review", { model: HAIKU }, POOL_SET), {
		model: HAIKU,
		candidates: [{ model: HAIKU, thinking: "off" }],
		thinking: "off",
	});
	assert.deepEqual(resolveRun("scout", { thinking: "high" }, POOL_SET), {
		model: LUNA,
		candidates: [
			{ model: LUNA, thinking: "low" },
			{ model: HAIKU, thinking: "low" },
		],
		thinking: "low",
	});
});

test("a rate-limited worker falls back through its pool and reports both attempts", async (t) => {
	const marker = scratch("fallback-marker");
	const { tool } = setup(t, {
		config: {
			version: 2,
			scout: { models: [LUNA], thinking: "low" },
			worker: { models: [HAIKU, SONNET], thinking: "max" },
		},
		env: { FAKE_PI_MODE: "rate-limit-model", FAKE_PI_FAIL_MODEL: HAIKU, FAKE_PI_MARKER: marker },
	});
	const res = await run(tool, { role: "review", task: "x" });
	assert.equal(res.isError, false, text(res));
	const calls = readFileSync(marker, "utf8").trim().split("\n").map(JSON.parse);
	assert.deepEqual(
		calls.map((c) => [c.model, c.thinking]),
		[
			[HAIKU, "max"],
			[SONNET, "max"],
		],
	);
	assert.equal(res.details.round1[0].requested.model, SONNET);
	assert.deepEqual(res.details.round1[0].fallbackAttempts, [
		{
			model: HAIKU,
			thinking: "max",
			failure: "exit 1: 429 rate_limit_error: too many requests",
			nextModel: SONNET,
			nextThinking: "max",
		},
	]);
	assert.match(text(res), /claude-haiku-5-5.*rate_limit_error.*trying anthropic\/claude-sonnet-5-5/s);
	assert.equal(res.usage.cost.total, 0.004);
});

test("usage-limit and quota errors also fall through the worker pool", async (t) => {
	// One setup, so its env restore runs once; each case only swaps the error text.
	const { tool } = setup(t, {
		config: {
			version: 2,
			scout: { models: [LUNA], thinking: "low" },
			worker: { models: [HAIKU, SONNET], thinking: "max" },
		},
		env: { FAKE_PI_MODE: "quota-model", FAKE_PI_FAIL_MODEL: HAIKU, FAKE_PI_ERROR: "" },
	});
	for (const error of [
		"Codex error: The usage limit has been reached",
		"429 quota exceeded for this project",
		"insufficient_quota: check your plan",
	]) {
		process.env.FAKE_PI_ERROR = error;
		const res = await run(tool, { role: "review", task: "x" });
		assert.equal(res.isError, false, text(res));
		assert.equal(res.details.round1[0].requested.model, SONNET, error);
		assert.equal(res.details.round1[0].fallbackAttempts[0].failure, `exit 1: ${error}`);
	}
});

test("fallback attempts share the worker cost cap", async (t) => {
	const marker = scratch("fallback-cost-marker");
	const { tool } = setup(t, {
		config: {
			version: 2,
			scout: { models: [LUNA], thinking: "low" },
			worker: { models: [HAIKU, SONNET, OPUS], thinking: "max" },
		},
		env: {
			FAKE_PI_MODE: "rate-limit-models",
			FAKE_PI_FAIL_MODELS: `${HAIKU},${SONNET}`,
			FAKE_PI_MARKER: marker,
		},
		limits: { costCapUsd: 0.003 },
	});
	const res = await run(tool, { role: "review", task: "x" });
	assert.equal(res.isError, true);
	const calls = readFileSync(marker, "utf8").trim().split("\n").map(JSON.parse);
	assert.deepEqual(
		calls.map((call) => call.model),
		[HAIKU, SONNET],
	);
	assert.match(text(res), /stopped: cost cap \$0\.001 reached/);
	assert.equal(res.usage.cost.total, 0.004);
});

test("per-model thinking follows each ordered candidate during fallback", async (t) => {
	const marker = scratch("per-model-thinking-marker");
	const { tool } = setup(t, {
		config: {
			version: 3,
			scout: { models: [{ model: LUNA, thinking: "off" }], thinking: "low" },
			worker: {
				models: [
					{ model: LUNA, thinking: "max" },
					{ model: OPUS, thinking: "low" },
				],
				thinking: "max",
			},
		},
		env: { FAKE_PI_MODE: "unavailable-model", FAKE_PI_FAIL_MODEL: LUNA, FAKE_PI_MARKER: marker },
	});
	const res = await run(tool, { role: "review", task: "x" });
	assert.equal(res.isError, false, text(res));
	const calls = readFileSync(marker, "utf8").trim().split("\n").map(JSON.parse);
	assert.deepEqual(
		calls.map(({ model, thinking }) => [model, thinking]),
		[
			[LUNA, "max"],
			[OPUS, "low"],
		],
	);
	assert.equal(res.details.round1[0].requested.model, OPUS);
	assert.equal(res.details.round1[0].requested.thinking, "low");
});

test("model-unavailable errors fall through the same ordered worker pool", async (t) => {
	const marker = scratch("unavailable-marker");
	const { tool } = setup(t, {
		config: {
			version: 2,
			scout: { models: [LUNA], thinking: "off" },
			worker: { models: [HAIKU, SONNET], thinking: "max" },
		},
		env: { FAKE_PI_MODE: "unavailable-model", FAKE_PI_FAIL_MODEL: HAIKU, FAKE_PI_MARKER: marker },
	});
	const res = await run(tool, { role: "research", task: "x" });
	assert.equal(res.isError, false, text(res));
	assert.deepEqual(
		readFileSync(marker, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).model),
		[HAIKU, SONNET],
	);
	assert.match(text(res), /model not found: unavailable.*trying anthropic\/claude-sonnet-5-5/s);
});

test("non-availability failures do not trigger pool fallback", async (t) => {
	const marker = scratch("no-fallback-marker");
	const { tool } = setup(t, {
		config: {
			...POOL_SET,
			worker: {
				models: [
					{ model: HAIKU, thinking: "max" },
					{ model: SONNET, thinking: "max" },
				],
				thinking: "max",
			},
		},
		env: { FAKE_PI_MODE: "fail-model", FAKE_PI_FAIL_MODEL: HAIKU, FAKE_PI_MARKER: marker },
	});
	const res = await run(tool, { role: "review", task: "x" });
	assert.equal(res.isError, true);
	const calls = readFileSync(marker, "utf8").trim().split("\n").map(JSON.parse);
	assert.deepEqual(
		calls.map((call) => call.model),
		[HAIKU],
	);
	assert.equal(res.details.round1[0].fallbackAttempts.length, 0);
});

test("v1 and v2 configs migrate to per-model levels, and empty pools use the session model", () => {
	const path = scratch("legacy-delegate.json");
	writeFileSync(path, JSON.stringify({ models: [HAIKU, SONNET, OPUS], default: SONNET }));
	const set = loadModelSet(path);
	assert.deepEqual(set, {
		version: 3,
		scout: {
			models: [HAIKU, SONNET, OPUS].map((model) => ({ model, thinking: "low" })),
			thinking: "low",
		},
		worker: {
			models: [SONNET, HAIKU, OPUS].map((model) => ({ model, thinking: "max" })),
			thinking: "max",
		},
	});
	assert.deepEqual(resolveRun("review", { model: OPUS, thinking: "medium" }, set), {
		model: OPUS,
		candidates: [
			{ model: OPUS, thinking: "medium" },
			{ model: SONNET, thinking: "medium" },
			{ model: HAIKU, thinking: "medium" },
		],
		thinking: "medium",
	});
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { models: [HAIKU, SONNET, OPUS], default: SONNET });

	const v2Path = scratch("v2-delegate.json");
	writeFileSync(
		v2Path,
		JSON.stringify({
			version: 2,
			scout: { models: [HAIKU], thinking: "off" },
			worker: { models: [LUNA, OPUS], thinking: "max" },
		}),
	);
	const v2 = loadModelSet(v2Path);
	assert.equal(JSON.parse(readFileSync(v2Path, "utf8")).version, 2, "reading a legacy config does not rewrite it");
	assert.deepEqual(v2, {
		version: 3,
		scout: { models: [{ model: HAIKU, thinking: "off" }], thinking: "off" },
		worker: {
			models: [LUNA, OPUS].map((model) => ({ model, thinking: "max" })),
			thinking: "max",
		},
	});
	assert.deepEqual(resolveRun("scout", { thinking: "high" }, v2), {
		model: HAIKU,
		candidates: [{ model: HAIKU, thinking: "low" }],
		thinking: "low",
	});
	assert.deepEqual(resolveRun("review", {}, v2), {
		model: LUNA,
		candidates: [
			{ model: LUNA, thinking: "max" },
			{ model: OPUS, thinking: "max" },
		],
		thinking: "max",
	});
	assert.throws(() => resolveRun("review", { model: "openai/gpt-x" }, v2), /not in the delegate pools/);

	const empty = loadModelSet(join(TEST_HOME, "nope.json"));
	assert.deepEqual(resolveRun("scout", {}, empty, "x/session", "off"), {
		model: "x/session",
		candidates: [{ model: "x/session", thinking: "off" }],
		thinking: "off",
	});
	assert.deepEqual(resolveRun("review", { model: "y/m" }, empty, "x/session", "medium"), {
		model: "y/m",
		candidates: [{ model: "y/m", thinking: "medium" }],
		thinking: "medium",
	});
	assert.throws(() => resolveRun("review", {}, empty, "x/session"), /main session's thinking level is unknown/);
});

function commandCtx({ available = [HAIKU, SONNET, OPUS] } = {}) {
	const notes = [];
	const ctx = {
		hasUI: true,
		modelRegistry: {
			getAvailable: () =>
				available.map((m) => {
					const cut = m.indexOf("/");
					const [provider, id] = [m.slice(0, cut), m.slice(cut + 1)];
					return { provider, id, name: id, cost: { input: 1, output: 5 } };
				}),
		},
		ui: { notify: (message, type) => notes.push([message, type]) },
	};
	return { ctx, notes };
}

test("/delegate status: the set with availability, missing tools, running and recent calls", async (t) => {
	assert.deepEqual(setup(t, { env: { ME_PI_RUN: "1" } }).commands, {}, "workers get no command");
	const main = setup(t, {
		config: {
			version: 3,
			scout: {
				thinking: "low",
				models: [
					{ model: HAIKU, thinking: "low" },
					{ model: OPUS, thinking: "off" },
				],
			},
			worker: {
				thinking: "max",
				models: [
					{ model: OPUS, thinking: "max" },
					{ model: HAIKU, thinking: "low" },
				],
			},
		},
	});
	assert.deepEqual(
		main.commands.delegate.getArgumentCompletions("").map((c) => c.value),
		["status", "models", "cancel"],
	);
	assert.deepEqual(
		main.commands.delegate.getArgumentCompletions("m").map((c) => c.value),
		["models"],
	);
	const status = async () => {
		const { ctx, notes } = commandCtx({ available: [HAIKU] });
		await main.commands.delegate.handler("", ctx);
		return notes[0][0];
	};
	const before = await status();
	assert.ok(before.includes(`Scout pool: 1. ${HAIKU} (low) ✓; 2. ${OPUS} (off) ✗ not available`));
	assert.ok(
		before.includes(`Worker pool: 1. ${OPUS} (max) ✗ not available (no login or unknown id); 2. ${HAIKU} (low) ✓`),
	);
	assert.match(before, /\nTools: missing Skill \(this repo's extensions\/skill\.ts\), web_search \(pi-web-access\)/);
	assert.match(before, /\nRunning: none\nLast calls: none$/);

	await run(main.tool, { task: "x", runs: [{ model: HAIKU }] });
	const after = await status();
	assert.match(after, /\nRunning: none\n/, "a finished call leaves the running list");
	assert.match(after, /\nLast 1 calls, \$0\.0020:\n {2}\d\d:\d\d \u2713 general claude-haiku-5-5 \$0\.0020 \d+s$/);

	// A reloaded instance keeps the history.
	const reloaded = setup(t, { config: { models: [HAIKU, OPUS] }, keepHistory: true });
	const kept = commandCtx();
	await reloaded.commands.delegate.handler("", kept.ctx);
	assert.match(kept.notes[0][0], /\nLast 1 calls, \$0\.0020:/);

	const hanging = setup(t, { config: { models: [HAIKU, OPUS] }, env: { FAKE_PI_MODE: "hang" } });
	const controller = new AbortController();
	const pending = run(hanging.tool, { role: "review", task: "x" }, controller.signal);
	await new Promise((r) => setTimeout(r, 300));
	const { ctx, notes } = commandCtx();
	await hanging.commands.delegate.handler("status", ctx);
	assert.match(notes[0][0], /\nRunning \(1\):\n {2}review: claude-opus-5-5 \d+s\n/);
	controller.abort();
	await pending;

	const broken = setup(t, { config: { models: [HAIKU], extra: 1 } });
	const bad = commandCtx();
	await broken.commands.delegate.handler("status", bad.ctx);
	assert.match(bad.notes[0][0], /\n {2}\u2717 delegate config .*: unknown key\(s\) extra/);
	await assert.rejects(
		broken.commands.delegate.handler("nope", bad.ctx),
		/^Error: Unknown \/delegate subcommand "nope"\. Use: status, models, cancel\.$/,
	);
});

test("/delegate status without a config names the main session model and thinking", async (t) => {
	const main = setup(t);
	const { ctx, notes } = commandCtx();
	await main.commands.delegate.handler("status", ctx);
	assert.ok(
		notes[0][0].includes("Scout pool: main session model (main session thinking, capped at low, no fallback models)"),
	);
	assert.ok(notes[0][0].includes("Worker pool: main session model (main session thinking, no fallback models)"));
});

test("/delegate status keeps the last 20 calls", async (t) => {
	const main = setup(t, { config: { models: [HAIKU, OPUS] } });
	for (let i = 0; i < 21; i++) await run(main.tool, { task: "x", runs: [{ model: HAIKU }] });
	const { ctx, notes } = commandCtx();
	await main.commands.delegate.handler("", ctx);
	assert.match(notes[0][0], /\nLast 20 calls, \$0\.0400:\n/);
	assert.equal(notes[0][0].split("\n").filter((l) => l.includes("general claude-haiku")).length, 20);
});

test("/delegate models directs users to edit JSON manually without writing it", async (t) => {
	const main = setup(t, { config: POOL_SET });
	const path = process.env.ME_PI_DELEGATE_CONFIG;
	const original = readFileSync(path, "utf8");
	const { ctx, notes } = commandCtx();
	await main.commands.delegate.handler("models", ctx);
	assert.deepEqual(notes, [[`Edit ${path} to set ordered models and per-model thinking, then run /reload.`, "info"]]);
	assert.equal(readFileSync(path, "utf8"), original);
});

test("v3 model configs validate per-model thinking", (t) => {
	const write = (content) => {
		const path = scratch("delegate.json");
		writeFileSync(path, content);
		return path;
	};
	assert.deepEqual(loadModelSet(join(TEST_HOME, "nope.json")), {
		version: 3,
		scout: { models: [] },
		worker: { models: [] },
	});
	assert.deepEqual(
		loadModelSet(write(JSON.stringify({ version: 3, scout: { models: [] }, worker: { models: [] } }))),
		{ version: 3, scout: { models: [] }, worker: { models: [] } },
		"pool-level thinking is optional",
	);
	assert.deepEqual(loadModelSet(write(JSON.stringify(POOL_SET))), POOL_SET);
	assert.equal(loadModelSet(write(JSON.stringify(POOL_SET))).worker.models[1].thinking, "max");
	for (const [content, error] of [
		["{", /delegate config .*: /],
		["[]", /expected a JSON object/],
		[JSON.stringify({ models: [HAIKU], tiers: {} }), /unknown key\(s\) tiers \(allowed: models, default\)/],
		[JSON.stringify({ models: [{ id: HAIKU }] }), /models.*must be an array of model ids/],
		[JSON.stringify({ models: [HAIKU, HAIKU] }), /models.*lists a model twice/],
		[JSON.stringify({ models: [HAIKU], default: OPUS }), /"default" must be one of "models"/],
		[JSON.stringify({ version: 4 }), /unsupported version 4 \(expected 2 or 3\)/],
		[
			JSON.stringify({
				version: 3,
				scout: { models: [{ model: HAIKU, thinking: "high" }], thinking: "low" },
				worker: { models: [], thinking: "max" },
			}),
			/scout.models\[0\].thinking must be one of low, off/,
		],
		[
			JSON.stringify({
				version: 3,
				scout: { models: [], thinking: "low" },
				worker: {
					models: [
						{ model: HAIKU, thinking: "medium" },
						{ model: HAIKU, thinking: "low" },
					],
					thinking: "max",
				},
			}),
			/worker.models lists model .* twice/,
		],
	]) {
		assert.throws(() => loadModelSet(write(content)), error);
	}
	const { tool } = setup(t, { config: JSON.stringify({ models: "x" }) });
	return run(tool, { role: "scout", task: "x" }).then((res) => {
		assert.equal(res.isError, true);
		assert.match(text(res), /models.*must be an array/);
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

test("each worker gets the contract and its role's answer format", async (t) => {
	const { tool } = setup(t, { config: { models: [HAIKU, OPUS] }, env: { FAKE_PI_MODE: "echo-system" } });
	for (const role of ["scout", "research", "review", "challenge"]) {
		const res = await run(tool, { role, task: "x" });
		assert.equal(res.isError, false, text(res));
		assert.ok(text(res).startsWith(WORKER_CONTRACT), role);
		assert.ok(text(res).includes(`Role: ${role}. Final answer format: ${ROLES[role].answer}`), role);
	}
});

test("roles get their tools: only research and challenge reach the web", async (t) => {
	const { tool } = setup(t, { config: { models: [HAIKU, OPUS] } });
	for (const [role, tools] of [
		["review", LOCAL_TOOLS],
		["research", WEB_TOOLS],
		["challenge", WEB_TOOLS],
	]) {
		const res = await run(tool, { role, task: "x" });
		assert.match(text(res), new RegExp(`model=${OPUS} thinking=max tools=${tools} `), role);
	}
});

test("without a model config, workers use the main session model", async (t) => {
	const marker = scratch("session-model-marker");
	const { tool } = setup(t, { env: { FAKE_PI_MARKER: marker } });
	const sessionContext = { ...CTX, thinkingLevel: "medium" };
	const general = await run(tool, { task: "x" }, undefined, undefined, sessionContext);
	const scout = await run(tool, { role: "scout", task: "x" }, undefined, undefined, sessionContext);
	assert.equal(general.isError, false, text(general));
	assert.equal(scout.isError, false, text(scout));
	assert.deepEqual(
		readFileSync(marker, "utf8")
			.trim()
			.split("\n")
			.map((line) => {
				const { model, thinking } = JSON.parse(line);
				return [model, thinking];
			}),
		[
			["anthropic/claude-session", "medium"],
			["anthropic/claude-session", "low"],
		],
	);
});

test("the default role is general: local tools, first worker model, max thinking, no answer format", async (t) => {
	const { tool } = setup(t, {
		config: { models: [HAIKU, SONNET, OPUS], default: SONNET },
		env: { FAKE_PI_MODE: "echo-system" },
	});
	const system = text(await run(tool, { task: "x" }));
	assert.ok(system.startsWith(`${WORKER_CONTRACT}\nRole: general.\n[claude-sonnet-5-5 @max `), system);
	process.env.FAKE_PI_MODE = "";
	const res = await run(tool, { task: "x" });
	assert.equal(res.isError, false, text(res));
	assert.match(text(res), new RegExp(`^DONE model=${SONNET} thinking=max tools=${LOCAL_TOOLS} .* role=general `));
});

test("web overrides the role's tools and adds a badge to progress and results", async (t) => {
	const { tool } = setup(t, { config: { models: [HAIKU, OPUS] } });
	const progress = [];
	const onUpdate = (u) => progress.push(text(u));
	const on = await run(tool, { role: "review", task: "x", web: true }, undefined, onUpdate);
	assert.match(text(on), new RegExp(`thinking=max tools=${WEB_TOOLS} .* role=review `));
	assert.match(text(on), /\n\[claude-opus-5-5 @max web \$0\.0020 \d+s\]$/);
	assert.ok(progress.length && progress.every((p) => p.startsWith("Workers [web]\n")), progress.join("|"));
	progress.length = 0;
	const off = await run(tool, { role: "research", task: "x", web: false }, undefined, onUpdate);
	assert.match(text(off), new RegExp(`thinking=max tools=${LOCAL_TOOLS} .* role=research `));
	assert.match(text(off), /\n\[claude-opus-5-5 @max \$0\.0020 \d+s\]$/);
	assert.ok(progress.length && progress.every((p) => p.startsWith("Workers\n")), progress.join("|"));
});

test("web does not lift scout's thinking cap", async (t) => {
	const { tool } = setup(t, { config: { models: [HAIKU, OPUS] } });
	const res = await run(tool, { role: "scout", task: "x", web: true, runs: [{ thinking: "high" }] });
	assert.match(text(res), new RegExp(`^DONE model=${HAIKU} thinking=low tools=${WEB_TOOLS} .* role=scout `));
	assert.match(text(res), /\n\[claude-haiku-5-5 @low web \$/);
});

test("a call's answer replaces the role's format, up to 400 characters", async (t) => {
	const { tool } = setup(t, { config: { models: [HAIKU, OPUS] }, env: { FAKE_PI_MODE: "echo-system" } });
	const prompt = (role, format) => `${WORKER_CONTRACT}\nRole: ${role}. Final answer format: ${format}\n[`;
	const review = text(await run(tool, { role: "review", task: "x", answer: "  a table: option | risk \n" }));
	assert.ok(review.startsWith(prompt("review", "a table: option | risk")), review);
	const longest = text(await run(tool, { task: "x", answer: "y".repeat(400) }));
	assert.ok(longest.startsWith(prompt("general", "y".repeat(400))), longest);
});

test("bad calls are refused before any worker starts", async (t) => {
	const marker = scratch("marker");
	const { tool } = setup(t, { env: { FAKE_PI_MARKER: marker }, config: { models: [HAIKU, OPUS] } });
	for (const [params, error] of [
		[{ role: "planner", task: "x" }, /role must be one of general, scout, research, review, challenge, implement$/],
		[{ role: "constructor", task: "x" }, /role must be one of/],
		[{ role: "__proto__", task: "x" }, /role must be one of/],
		[{ role: "scout", task: "  " }, /task must be a non-empty string/],
		[{ task: "x", web: "yes" }, /web must be true or false/],
		[{ task: "x", output: 1 }, /output must be true or false/],
		[{ task: "x", answer: "" }, /answer must be a non-empty string of at most 400 characters/],
		[{ task: "x", answer: " \n " }, /answer must be a non-empty string of at most 400 characters/],
		[{ task: "x", answer: "y".repeat(401) }, /answer must be a non-empty string of at most 400 characters/],
		[{ role: "review", task: "x", runs: [] }, /runs must have 1-4 entries/],
		[{ role: "review", task: "x", runs: Array(5).fill({}) }, /runs must have 1-4 entries/],
		[{ role: "review", task: "x", rebuttal: true }, /rebuttal needs at least 2 runs/],
		[{ role: "review", task: "x", runs: ["x"] }, /runs\[0\] must be \{ model\?: string, thinking\?: off\|/],
		[{ role: "review", task: "x", runs: [{}, { thinking: "huge" }] }, /runs\[1\] must be/],
		[{ role: "review", task: "x", model: OPUS }, /unknown parameter\(s\) model; set model and thinking inside runs/],
		[{ role: "review", task: "x", runs: [{ model: "openai/gpt-x" }] }, /not in the delegate pools/],
	]) {
		const res = await run(tool, params);
		assert.equal(res.isError, true, JSON.stringify(params));
		assert.match(text(res), error);
	}
	assert.equal(existsSync(marker), false, "no worker started");
});

test("details carry a view for the TUI: progress per round, then the reported runs and the footer", async (t) => {
	const { tool } = setup(t, {
		config: { models: [HAIKU, OPUS] },
		env: { FAKE_PI_MODE: "fail-round2", FAKE_PI_FAIL_MODEL: OPUS },
	});
	const updates = [];
	const res = await run(
		tool,
		{ task: "x", web: true, runs: [{ model: HAIKU }, { model: OPUS }], rebuttal: true },
		undefined,
		(u) => updates.push(u),
	);
	const stages = [...new Set(updates.map((u) => u.details.view.stage))];
	assert.deepEqual(stages, ["Workers", "Rebuttal"]);
	const last = updates.at(-1);
	assert.equal(last.content[0].text, progressLines(last.details.view).join("\n"));
	assert.match(
		last.content[0].text,
		/^Rebuttal \[web\]\n\u2713 claude-haiku-5-5 turn 1 \$0\.0020\n\u2717 claude-opus-5-5/,
	);
	const view = res.details.view;
	assert.equal(view.stage, "Done");
	assert.deepEqual(
		view.runs.map((r) => [r.model, r.thinking, r.web, r.done, r.round2Failure ?? null]),
		[
			[HAIKU, "max", true, true, null],
			[OPUS, "max", true, true, "exit 1: task-specific error in round 2"],
		],
	);
	assert.match(view.runs[0].output, /## Round 2/);
	assert.match(view.footer, /^Total: 4 runs, \$0\.0080\. Round-1 answers: /);
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
	assert.match(out, new RegExp(`model=${SONNET} thinking=max`));
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
	assert.match(sonnet2, /Carry forward every objection, yours or theirs, that is still open\./);
	assert.match(
		sonnet2,
		/Final answer in the format your system prompt or the task sets, then `Changed: yes\|no` with the reason and, for each change, what changed and why\./,
	);
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
		new RegExp(`^✗ round 2 failed: exit 1: task-specific error in round 2\\nRound-1 answer:\\nDONE model=${SONNET}`),
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
	assert.match(text(res), /^✗ exit 1: invalid request: tool schema rejected\nPartial answer:\npartial findings\n\[/);
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
register({ registerTool: (d) => { delegate = d; }, registerCommand: () => {}, on: () => {} });
void delegate.execute("p", { role: "scout", task: "hold" }, undefined, undefined, { cwd: ${JSON.stringify(REPO_ROOT)}, thinkingLevel: "low" });
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
	assert.match(all, /one `implement` worker edits, runs the checks, and commits on its own `delegate\/\*` branch/);
	assert.match(all, /For `implement`, set `background: true`\. The worker starts from your HEAD commit/);
	assert.match(all, /Merge only a result with no ✗ line/);
	assert.match(all, /under the Approval rules/);
	assert.match(all, /never undo the merge without approval/);
	assert.match(PROMPT_SNIPPET, /one `implement` worker that commits on its own branch/);
});

// A tool context that records the status line.
const bgCtx = () => {
	const statuses = [];
	return { ctx: { ...CTX, ui: { setStatus: (key, value) => statuses.push([key, value]) } }, statuses };
};

test("background: returns a job id at once, then delivers the answer as a message that starts a turn", async (t) => {
	const { tool, messages } = setup(t);
	const { ctx, statuses } = bgCtx();
	const res = await run(tool, { role: "scout", task: "look around", background: true }, undefined, undefined, ctx);
	assert.equal(res.isError, undefined);
	assert.match(
		text(res),
		/^Started background job bg1 \(.+\)\. Its answer arrives as a later message; \/delegate cancel bg1 stops it\.$/,
	);
	await waitFor(() => messages.length === 1, "the background answer");
	const [{ message, options }] = messages;
	assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
	assert.equal(message.customType, "delegate");
	assert.equal(message.display, true);
	assert.match(message.content, /^Background delegate job bg1:\n\n/);
	assert.ok(message.details.view, "details keep the run view");
	assert.match(statuses[0][1], /^delegate bg: 1 running, \$0\.0000 spent$/);
	assert.match(statuses.at(-1)[1], /^delegate bg: 0 running, \$0\.0\d+ spent$/);
	assert.ok(!statuses.at(-1)[1].endsWith("$0.0000 spent"), "the job's cost is counted");
});

test("background: the turn's abort does not stop a job; /delegate cancel does, without starting a turn", async (t) => {
	const { tool, messages, commands } = setup(t, { env: { FAKE_PI_MODE: "hang" } });
	const turn = new AbortController();
	const { ctx } = bgCtx();
	await run(tool, { role: "scout", task: "x", background: true }, turn.signal, undefined, ctx);
	turn.abort();
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(messages.length, 0, "still running after the turn was aborted");
	const { ctx: cmd, notes } = commandCtx();
	await commands.delegate.handler("status", cmd);
	assert.match(notes[0][0], /Running \(1\):\n {2}bg1 scout: /);
	await commands.delegate.handler("cancel bg1", cmd);
	assert.equal(notes[1][0], "Cancelling background job bg1.");
	await waitFor(() => messages.length === 1, "the cancelled job's report");
	assert.deepEqual(messages[0].options, { triggerTurn: false, deliverAs: "followUp" });
	assert.match(messages[0].message.content, /^Background delegate job bg1 failed:\n\n✗ stopped: cancelled/);
	await commands.delegate.handler("cancel bg1", cmd);
	assert.equal(notes[2][0], "No running background job bg1.");
	await assert.rejects(commands.delegate.handler("cancel", cmd), /Usage: \/delegate cancel <id>/);
});

test("at most 4 workers run at once across foreground and background calls", async (t) => {
	const { tool, commands, messages } = setup(t, { env: { FAKE_PI_MODE: "hang" } });
	const { ctx } = bgCtx();
	await run(tool, { role: "scout", task: "x", runs: [{}, {}, {}], background: true }, undefined, undefined, ctx);
	const over = await run(tool, { role: "scout", task: "y", runs: [{}, {}] });
	assert.equal(over.isError, true);
	assert.match(text(over), /^3 worker\(s\) already running; at most 4 run at once\./);
	const second = await run(tool, { role: "scout", task: "z", background: true }, undefined, undefined, ctx);
	assert.match(text(second), /^Started background job bg2 /);
	const { ctx: cmd } = commandCtx();
	await commands.delegate.handler("cancel bg1", cmd);
	await commands.delegate.handler("cancel bg2", cmd);
	await waitFor(() => messages.length === 2, "both cancelled reports");
});

test("background: a job stopped by session shutdown delivers nothing; background must be a boolean", async (t) => {
	const { tool, handlers, messages } = setup(t, { env: { FAKE_PI_MODE: "hang" } });
	const { ctx } = bgCtx();
	await run(tool, { role: "scout", task: "x", background: true }, undefined, undefined, ctx);
	await handlers.session_shutdown();
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(messages.length, 0);
	const bad = await run(tool, { role: "scout", task: "x", background: "yes" });
	assert.equal(bad.isError, true);
	assert.equal(text(bad), "background must be true or false");
});

test("background spend survives /reload", async (t) => {
	const first = setup(t);
	await run(first.tool, { role: "scout", task: "x", background: true }, undefined, undefined, bgCtx().ctx);
	await waitFor(() => first.messages.length === 1, "the first answer");
	const reloaded = setup(t, { keepHistory: true });
	const { ctx, statuses } = bgCtx();
	await run(reloaded.tool, { role: "scout", task: "y", background: true }, undefined, undefined, ctx);
	assert.match(statuses[0][1], /^delegate bg: 1 running, \$0\.0\d+ spent$/);
	assert.ok(!statuses[0][1].endsWith("$0.0000 spent"), "the first job's spend is kept");
	await waitFor(() => reloaded.messages.length === 1, "the second answer");
});

// --- implement ---

// A temp repo with one commit on main and a branch `other`, as bin/install.test.sh sets up its fixture.
function implementRepo() {
	const repo = mkdtempSync(join(TEST_HOME, "impl-repo-"));
	const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
	git("init", "-q", "--template=", "-b", "main");
	git("config", "core.hooksPath", "/dev/null");
	git("config", "commit.gpgsign", "false");
	git("config", "user.email", "implement-test@example.invalid");
	git("config", "user.name", "Implement Test");
	mkdirSync(join(repo, "sub"));
	writeFileSync(join(repo, "sub", "a.txt"), "a\n");
	git("add", "-A");
	git("commit", "-q", "-m", "initial");
	git("branch", "other");
	return { repo, git, ctx: { ...CTX, cwd: repo, isProjectTrusted: () => false } };
}
const implementEnv = (mode, extra = {}) => ({
	FAKE_PI_MODE: mode,
	PI_CODING_AGENT_DIR: mkdtempSync(join(TEST_HOME, "agent-")),
	...extra,
});
// Resolves once the worker's worktree holds the file the hang modes write before they wait.
const workerStarted = (git) =>
	waitFor(() => {
		const dirs = git("worktree", "list", "--porcelain")
			.split("\n")
			.filter((l) => l.startsWith("worktree "))
			.slice(1);
		return dirs.some((d) => existsSync(join(d.slice(9), "left.txt")));
	}, "the worker to start");
const branchOf = (res) => text(res).match(/^Branch: (delegate\/\S+) @ (\w+)/m);

test("implement commits on its own branch; the result has branch facts, not the diff", async (t) => {
	const { tool } = setup(t, { env: implementEnv("implement-commit") });
	const { repo, git, ctx } = implementRepo();
	writeFileSync(join(repo, "dirty.txt"), "uncommitted\n");
	const head = git("rev-parse", "HEAD");
	const updates = [];
	const res = await run(tool, { role: "implement", task: "add a feature" }, undefined, (u) => updates.push(u), ctx);
	const out = text(res);
	assert.equal(res.isError, false, out);
	assert.ok(out.startsWith("changed feature.txt; npm test: pass"), out);
	const [, branch, tip] = branchOf(res);
	assert.match(branch, /^delegate\/\d{8}-\d{6}-im\d+$/, "a foreground call uses an im<n> id");
	assert.equal(git("rev-parse", "--short=7", branch), tip);
	assert.match(out, /^Commits \(1, oldest first\):\n {2}\w+ feat: add feature$/m);
	assert.match(out, /^Diffstat: 1 file changed, 1 insertion\(\+\)$/m);
	assert.match(out, /^Worktree: removed$/m);
	assert.doesNotMatch(out, /IMPLEMENT-DIFF-BODY|\u2717/);
	const diffPath = out.match(/^Diff: (\S+) \(0600, base\.\.tip\)$/m)[1];
	assert.equal(statSync(diffPath).mode & 0o777, 0o600);
	assert.match(readFileSync(diffPath, "utf8"), /IMPLEMENT-DIFF-BODY/);
	assert.equal(git("worktree", "list").split("\n").length, 1, "the worktree is gone");
	assert.equal(git("rev-parse", "HEAD"), head);
	assert.equal(git("status", "--porcelain"), "?? dirty.txt");
	assert.match(
		updates[0].content[0].text,
		new RegExp(`^${branch.replace("/", "\\/")} \\(im\\d+\\) from ${head.slice(0, 7)}; 1 uncommitted file\\(s\\)`),
	);
	assert.equal(res.details.implement.branch, branch);
});

test("implement: work left uncommitted becomes a WIP commit and an error", async (t) => {
	const { tool } = setup(t, { env: implementEnv("implement-dirty") });
	const { git, ctx } = implementRepo();
	const res = await run(tool, { role: "implement", task: "x" }, undefined, undefined, ctx);
	assert.equal(res.isError, true);
	const [, branch] = branchOf(res);
	const id = branch.match(/-(im\d+)$/)[1];
	assert.equal(git("log", "-1", "--format=%s", branch), `WIP(delegate ${id}): left uncommitted by the worker`);
	assert.match(text(res), /^\u2717 WIP \w+ \(left uncommitted by the worker\): left\.txt\. Do not merge/m);
});

test("implement: a worker that moves another branch trips the ref tripwire", async (t) => {
	const { tool } = setup(t, { env: implementEnv("move-ref") });
	const { ctx } = implementRepo();
	const res = await run(tool, { role: "implement", task: "x" }, undefined, undefined, ctx);
	assert.equal(res.isError, true);
	assert.match(text(res), /^\u2717 Tripwire: refs\/heads\/other moved during the job/m);
});

test("implement background cancel: SIGTERM first, WIP commit, report without a turn", async (t) => {
	const termFile = join(mkdtempSync(join(TEST_HOME, "term-")), "term");
	const { tool, messages, commands } = setup(t, {
		env: implementEnv("implement-hang", { FAKE_PI_TERMFILE: termFile }),
		limits: { termGraceMs: 3000 },
	});
	const { repo, git } = implementRepo();
	const ctx = { ...bgCtx().ctx, cwd: repo, isProjectTrusted: () => false };
	const head = git("rev-parse", "HEAD");
	const started = await run(tool, { role: "implement", task: "x", background: true }, undefined, undefined, ctx);
	assert.match(
		text(started),
		new RegExp(
			`^Started background job bg1 \\(.+\\) on delegate/\\S+ \\(im\\d+\\) from ${head.slice(0, 7)}; 0 uncommitted`,
		),
	);
	await workerStarted(git);
	await new Promise((r) => setTimeout(r, 200));
	await commands.delegate.handler("cancel bg1", commandCtx().ctx);
	await waitFor(() => messages.length === 1, "the cancelled job's report");
	assert.equal(readFileSync(termFile, "utf8"), "TERM\n");
	assert.deepEqual(messages[0].options, { triggerTurn: false, deliverAs: "followUp" });
	const content = messages[0].message.content;
	assert.match(content, /^Background delegate job bg1 failed:\n\n\u2717 stopped: cancelled/);
	const branch = content.match(/^Branch: (delegate\/\S+) @/m)[1];
	assert.match(git("log", "-1", "--format=%s", branch), /^WIP\(delegate im\d+\): stopped: cancelled$/);
	assert.equal(git("worktree", "list").split("\n").length, 1);
});

test("implement: session shutdown waits for the WIP commit and sends nothing", async (t) => {
	const termFile = join(mkdtempSync(join(TEST_HOME, "term-")), "term");
	const { tool, messages, handlers } = setup(t, {
		env: implementEnv("implement-hang", { FAKE_PI_TERMFILE: termFile }),
	});
	const { repo, git } = implementRepo();
	const ctx = { ...bgCtx().ctx, cwd: repo, isProjectTrusted: () => false };
	const started = await run(tool, { role: "implement", task: "x", background: true }, undefined, undefined, ctx);
	const branch = text(started).match(/ on (delegate\/\S+) /)[1];
	await workerStarted(git);
	await new Promise((r) => setTimeout(r, 200));
	await handlers.session_shutdown();
	assert.match(git("log", "-1", "--format=%s", branch), /^WIP\(delegate im\d+\): stopped: cancelled$/);
	assert.equal(git("worktree", "list").split("\n").length, 1);
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(messages.length, 0);
});

test("implement worker env: remote and gh cut-offs, tools, approve, and cwd", async (t) => {
	const { tool } = setup(t, {
		env: implementEnv("echo-env", {
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "user.name",
			GIT_CONFIG_VALUE_0: "Preset",
			GH_TOKEN: "t1",
			GITHUB_TOKEN: "t2",
			GH_ENTERPRISE_TOKEN: "t3",
			GITHUB_ENTERPRISE_TOKEN: "t4",
		}),
	});
	const { repo, ctx } = implementRepo();
	const echo = async (params, c) => {
		const res = await run(tool, { role: "implement", task: "x", ...params }, undefined, undefined, c);
		return { res, ...JSON.parse(text(res).match(/^ENV (.*)$/m)[1]) };
	};
	const untrusted = await echo({}, { ...ctx, cwd: join(repo, "sub") });
	const wtDir = untrusted.env.ME_PI_OUTPUT_DIR;
	assert.match(wtDir, /me-pi-delegate-wt-/);
	assert.equal(untrusted.cwd, join(realpathSync(TEST_HOME), basename(wtDir), "sub"));
	assert.equal(untrusted.tools, "read,grep,find,ls,Skill,edit,write,bash");
	assert.deepEqual([untrusted.approve, untrusted.noApprove], [false, true]);
	const { GH_CONFIG_DIR, ...env } = untrusted.env;
	assert.match(GH_CONFIG_DIR, /me-pi-delegate-gh-/);
	assert.ok(!existsSync(GH_CONFIG_DIR), "finish removes the gh config dir");
	assert.deepEqual(env, {
		GIT_CONFIG_COUNT: "5",
		GIT_CONFIG_KEY_0: "user.name",
		GIT_CONFIG_KEY_1: "protocol.ssh.allow",
		GIT_CONFIG_KEY_2: "protocol.https.allow",
		GIT_CONFIG_KEY_3: "protocol.http.allow",
		GIT_CONFIG_KEY_4: "protocol.git.allow",
		GIT_CONFIG_VALUE_0: "Preset",
		GIT_CONFIG_VALUE_1: "never",
		GIT_CONFIG_VALUE_2: "never",
		GIT_CONFIG_VALUE_3: "never",
		GIT_CONFIG_VALUE_4: "never",
		ME_PI_OUTPUT_DIR: wtDir,
		ME_PI_ROLE: "implement",
	});
	const trusted = { ...ctx, isProjectTrusted: () => true };
	const fresh = await echo({}, trusted);
	assert.deepEqual([fresh.approve, fresh.noApprove], [true, false]);
	const prior = fresh.res.details.implement.branch;
	const continued = await echo({ branch: prior }, trusted);
	assert.deepEqual([continued.approve, continued.noApprove], [false, true], "no --approve when continuing a branch");
});

test("implement: no --approve on a fallback attempt or when .pi differs from the base", async (t) => {
	const { tool } = setup(t, {
		config: POOL_SET,
		env: implementEnv("rate-limit-model", { FAKE_PI_FAIL_MODEL: LUNA }),
	});
	const { repo, git, ctx } = implementRepo();
	const trusted = { ...ctx, isProjectTrusted: () => true };
	const fallback = await run(tool, { role: "implement", task: "x" }, undefined, undefined, trusted);
	assert.match(
		text(fallback),
		/tools=read,grep,find,ls,Skill,edit,write,bash .* approve=no$/m,
		"the fallback attempt",
	);
	const { trustFilesUnchanged, prepare } = await import("./delegate-implement.ts");
	mkdirSync(join(repo, ".pi"));
	writeFileSync(join(repo, ".pi", "x.ts"), "1\n");
	git("add", "-A");
	git("commit", "-q", "-m", "pi");
	const wt = await prepare(repo, "im900");
	assert.equal(await trustFilesUnchanged(wt), true);
	writeFileSync(join(wt.dir, ".pi", "x.ts"), "2\n");
	assert.equal(await trustFilesUnchanged(wt), false, "a tracked change");
	execFileSync("git", ["-C", wt.dir, "checkout", "-q", "--", ".pi"]);
	writeFileSync(join(wt.dir, ".pi", "new.ts"), "x\n");
	assert.equal(await trustFilesUnchanged(wt), false, "an untracked file");
	execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wt.dir]);
});

test("implement refusals", async (t) => {
	const { tool } = setup(t, { env: implementEnv("implement-commit") });
	const { git, ctx } = implementRepo();
	git("branch", "feature");
	for (const [params, c, error] of [
		[{ role: "implement", task: "x", runs: [{}, {}] }, ctx, /^implement does not take runs with more than 1 entry$/],
		[{ role: "implement", task: "x", output: true }, ctx, /^implement does not take output$/],
		[{ role: "implement", task: "x", web: true }, ctx, /^implement does not take web: true$/],
		[
			{ role: "implement", task: "x", runs: [{}, {}], rebuttal: true },
			ctx,
			/^implement does not take runs with more than 1 entry, rebuttal$/,
		],
		[
			{ role: "review", task: "x", branch: "delegate/x" },
			ctx,
			/^branch is a non-empty string, for role implement only$/,
		],
		[{ role: "implement", task: "x", branch: "feature" }, ctx, /^branch must start with delegate\/: feature$/],
		[{ role: "implement", task: "x", branch: "delegate/missing" }, ctx, /^no such branch: delegate\/missing$/],
		[
			{ role: "implement", task: "x" },
			{ ...ctx, cwd: mkdtempSync(join(TEST_HOME, "norepo-")) },
			/^implement needs a git repository/,
		],
	]) {
		const res = await run(tool, params, undefined, undefined, c);
		assert.equal(res.isError, true, JSON.stringify(params));
		assert.match(text(res), error);
	}
	assert.equal(git("worktree", "list").split("\n").length, 1);
});

test("implement: a session that ends during prepare leaves no job, worktree, or message", async (t) => {
	const { tool, handlers, messages } = setup(t, { env: implementEnv("implement-commit") });
	const { repo, git } = implementRepo();
	const ctx = { ...bgCtx().ctx, cwd: repo, isProjectTrusted: () => false };
	const pending = run(tool, { role: "implement", task: "x", background: true }, undefined, undefined, ctx);
	await handlers.session_shutdown();
	assert.equal(git("worktree", "list").split("\n").length, 1, "shutdown waited for the finish");
	const res = await pending;
	assert.equal(res.isError, true);
	assert.equal(text(res), "stopped: session ended");
	assert.equal(messages.length, 0);
});

test("implement: parallel calls at the cap cannot both pass it while preparing", async (t) => {
	const { tool, commands, messages } = setup(t, { env: implementEnv("hang") });
	const { repo } = implementRepo();
	const ctx = { ...bgCtx().ctx, cwd: repo, isProjectTrusted: () => false };
	await run(tool, { role: "scout", task: "x", runs: [{}, {}, {}], background: true }, undefined, undefined, ctx);
	const results = await Promise.all(
		[1, 2].map(() => run(tool, { role: "implement", task: "x", background: true }, undefined, undefined, ctx)),
	);
	const refused = results.filter((r) => r.isError);
	assert.equal(refused.length, 1, results.map(text).join("\n"));
	assert.match(text(refused[0]), /^4 worker\(s\) already running/);
	const { ctx: cmd } = commandCtx();
	await commands.delegate.handler("cancel bg1", cmd);
	await commands.delegate.handler("cancel bg2", cmd);
	await waitFor(() => messages.length === 2, "both cancelled reports");
});

test("implement: a cwd missing from the commit starts the worker at the worktree root; status shows the branch", async (t) => {
	const { tool, commands } = setup(t, { env: implementEnv("echo-env") });
	const { repo, ctx } = implementRepo();
	mkdirSync(join(repo, "untracked"));
	const updates = [];
	const res = await run(tool, { role: "implement", task: "x" }, undefined, (u) => updates.push(u), {
		...ctx,
		cwd: join(repo, "untracked"),
	});
	const echoed = JSON.parse(text(res).match(/^ENV (.*)$/m)[1]);
	assert.equal(echoed.cwd, join(realpathSync(TEST_HOME), basename(echoed.env.ME_PI_OUTPUT_DIR)));
	assert.match(
		updates[0].content[0].text,
		/untracked\/ is not in the commit; the worker starts at the worktree root\./,
	);
	const { ctx: cmd, notes } = commandCtx();
	await commands.delegate.handler("status", cmd);
	const branch = res.details.implement.branch;
	assert.match(notes[0][0], new RegExp(` implement .* ${branch.replace("/", "\\/")}@[0-9a-f]{7}$`, "m"));
});
