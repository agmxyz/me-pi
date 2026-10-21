import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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
  // implement modes: git runs in the worker's cwd, the coordinator's checkout.
  const git = (...a) => spawnSync("git", a, { encoding: "utf8" });
  // A tool call as Pi's JSON mode reports it: start, then end with isError.
  let toolId = 0;
  const tool = (toolName, args, isError = false) => {
    const toolCallId = "t" + ++toolId;
    console.log(JSON.stringify({ type: "tool_execution_start", toolCallId, toolName, args }));
    console.log(JSON.stringify({ type: "tool_execution_end", toolCallId, toolName, result: {}, isError }));
  };
  if (mode === "implement-commit" || mode === "move-ref") {
    writeFileSync("feature.txt", "IMPLEMENT-DIFF-BODY\\n");
    git("add", "-A");
    git("commit", "-q", "-m", "feat: add feature");
    if (mode === "move-ref") git("update-ref", "refs/heads/other", "HEAD");
    const ran = process.env.FAKE_PI_RAN ?? "npm test";
    if (ran) tool("bash", { command: ran }, Boolean(process.env.FAKE_PI_CHECK_FAIL));
    if (process.env.FAKE_PI_EDIT_AFTER) tool("edit", { path: "feature.txt" });
    emit("Added feature.txt.\\nIMPLEMENT-DIFF-BODY is in the details only");
    process.exit(0);
  }
  if (mode === "implement-dirty") { writeFileSync("left.txt", "x\\n"); tool("bash", { command: "npm test" }); emit("left it uncommitted"); process.exit(0); }
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
    const keys = Object.keys(e).filter((k) => k.startsWith("GIT_CONFIG_") || k.startsWith("GH_") || k.startsWith("GITHUB_") || k === "ME_PI_ROLE" || k === "ME_PI_OUTPUT_DIR" || k === "ME_PI_DENY_DIR" || k === "ME_PI_PARENT");
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
		globalThis[Symbol.for("me-pi.delegate.job-count")] = 0;
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
	assert.deepEqual(Object.keys(main.handlers), ["session_shutdown", "tool_call"]);
	const { properties, required } = main.tool.parameters;
	assert.deepEqual(required, ["task"]);
	assert.deepEqual(properties.role.enum, ["general", "scout", "research", "review", "challenge", "implement"]);
	assert.equal(properties.check.type, "string");
	assert.equal(properties.branch, undefined);
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
	assert.ok(
		WORKER_CONTRACT.includes(
			"You are the delegated subagent: repo instructions to delegate work to subagents are satisfied by this run; do the delegated task yourself, within your tools, and never list missing sub-agents as BLOCKED.",
		),
	);
	assert.doesNotMatch(WORKER_CONTRACT, /running commands or tests, sub-agents/);
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
	assert.match(text(await pending), /^✗ stopped: session ended/);
	process.env.FAKE_PI_MODE = "";
	assert.equal((await run(tool, { role: "scout", task: "x" })).isError, false, "a fresh shutdown signal");

	const pre = new AbortController();
	pre.abort();
	assert.match(text(await run(tool, { role: "scout", task: "x" }, pre.signal)), /^✗ cancelled before start/);
});

test("a session-ended abort before worker start reports the session shutdown reason", async (t) => {
	const marker = scratch("pre-aborted-session-end");
	const { tool } = setup(t, { env: { FAKE_PI_MARKER: marker } });
	const sessionEnded = new AbortController();
	sessionEnded.abort("session ended");
	const res = await run(tool, { role: "scout", task: "x" }, sessionEnded.signal);
	assert.match(text(res), /^✗ session ended before start/);
	assert.equal(existsSync(marker), false, "worker did not start");
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
	assert.ok(
		all.includes(
			"Meet repo instructions to delegate to subagents by using delegate workers; their review rules are met by your goal-end review.",
		),
	);
	assert.match(all, /Delegate any change whose files you have not read or that takes many steps/);
	assert.match(
		all,
		/Delegate reading more than about 3 files you will not edit, research, reviews, and plan challenges\./,
	);
	assert.match(all, /You push, open PRs, merge, and delete branches, under the Approval rules\./);
	assert.match(all, /Before one of your own commits that touches 2\+ files/);
	assert.match(all, /do not edit those files until the review returns/);
	assert.match(all, /`rebuttal: true`/);
	assert.match(all, /BLOCKED/);
	assert.match(
		all,
		/`git switch -c goal\/<slug>` if on main\/master, note the goal base SHA\. Use `background: true`/,
	);
	assert.match(all, /Until the handback, do not edit, commit, or switch branches in that repo/);
	assert.match(all, /Trust a ✓ handback: no diff read, no review, no re-check/);
	assert.match(all, /Tripwire ✗: stop and tell the user/);
	assert.match(
		all,
		/tell the reviewer each `check` that passed on the final commit \(from the handbacks\) so it does not report the check as BLOCKED/,
	);
	assert.match(all, /Never push a range containing a `WIP\(delegate` commit/);
	assert.match(all, /one background `implement` per ticket, in dependency order, on the goal branch/);
	assert.match(all, /worktree, reset, merger, and cleanup steps are no-ops/);
	assert.match(all, /`scout` or general with `output: true`; pass its directory to later tasks/);
	assert.match(all, /two `review` calls in one turn, one for standards and one for the spec/);
	assert.match(all, /commit the spec and tickets before the first job/);
	assert.match(all, /the worker must not ask questions: decide per the spec, and list open questions as BLOCKED/);
	assert.match(
		all,
		/A ticket is done only on a ✓ handback; the worker closes a local ticket only in its passing commit/,
	);
	assert.match(all, /write `gh issue view` output to temp files and pass the paths; close nothing per job/);
	assert.match(
		all,
		/after the goal review, put `Closes #N` in the PR body, or close issues only with the user's approval/,
	);
	assert.doesNotMatch(all, /close issues yourself/);
	assert.match(
		all,
		/agree its test seams with the user \(or take them from the ticket\/spec\) and list them in the task as confirmed/,
	);
	assert.match(
		all,
		/after the first ✓, push the goal branch and open a draft PR with `Closes #N`; mark it ready at goal end/,
	);
	assert.match(
		all,
		/two calls, standards and spec, when following code-review; pass the path to the code-review skill's SKILL\.md/,
	);
	assert.match(all, /\(this overrides a skill's fix-all step\)/);
	assert.match(
		all,
		/On each ✓ handback, start the next ready ticket in the same turn; never say you are waiting without a running job/,
	);
	assert.match(all, /the last job's `check` is the full suite/);
	assert.match(
		all,
		/At most one fix job, for high\/medium findings; report spec ambiguities and the rest to the user \(this overrides a skill's fix-all step\), no re-review loop/,
	);
	assert.doesNotMatch(all, /fix findings by follow-up/);
	assert.doesNotMatch(all, /git merge|delegate\/\*/);
	assert.match(
		PROMPT_SNIPPET,
		/one `implement` worker edits, runs `check`, and commits on your current branch \(clean tree, not main\/master, one per repo\); you get a 2-line handback/,
	);
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

test("background job ids do not repeat after /reload", async (t) => {
	const first = setup(t);
	const one = await run(first.tool, { role: "scout", task: "x", background: true }, undefined, undefined, bgCtx().ctx);
	assert.match(text(one), /^Started background job bg1 /);
	await waitFor(() => first.messages.length === 1, "the first answer");
	const reloaded = setup(t, { keepHistory: true });
	const two = await run(
		reloaded.tool,
		{ role: "scout", task: "y", background: true },
		undefined,
		undefined,
		bgCtx().ctx,
	);
	assert.match(text(two), /^Started background job bg2 /);
	await waitFor(() => reloaded.messages.length === 1, "the second answer");
});

// --- implement ---

const CHECK = "npm test";
// A temp repo on `goal/x` with one commit and a branch `other`, as bin/install.test.sh sets up its fixture.
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
	git("switch", "-q", "-c", "goal/x");
	const real = realpathSync(repo);
	return {
		repo,
		real,
		git,
		lock: join(real, ".git", "me-pi-implement.lock"),
		ctx: { ...CTX, cwd: repo, isProjectTrusted: () => false },
	};
}
const implementEnv = (mode, extra = {}) => ({
	FAKE_PI_MODE: mode,
	PI_CODING_AGENT_DIR: mkdtempSync(join(TEST_HOME, "agent-")),
	...extra,
});
const implement = (extra = {}) => ({ role: "implement", task: "add a feature", check: CHECK, ...extra });
// Resolves once a hang-mode worker has written the file it writes before it waits.
const workerStarted = (repo) => waitFor(() => existsSync(join(repo, "left.txt")), "the worker to start");

test("implement commits on the current branch; the result is a 2-line handback and a 0600 details file", async (t) => {
	const { tool, commands } = setup(t, { env: implementEnv("implement-commit") });
	const { git, lock, ctx } = implementRepo();
	const head = git("rev-parse", "HEAD");
	const updates = [];
	const res = await run(tool, implement(), undefined, (u) => updates.push(u), ctx);
	const out = text(res);
	assert.equal(res.isError, false, out);
	const tip = git("rev-parse", "HEAD");
	const lines = out.split("\n");
	assert.equal(lines.length, 2, out);
	assert.match(
		lines[0],
		new RegExp(
			`^✓ im\\d+ goal/x ${head.slice(0, 7)}\\.\\.${tip.slice(0, 7)}: 1 commit, 1 file \\+1 -0; check ✓ \`npm test\` \\[.+\\]$`,
		),
	);
	const detailsPath = lines[1].match(/^Added feature\.txt\. Details: (\S+)$/)[1];
	assert.equal(statSync(detailsPath).mode & 0o777, 0o600);
	assert.match(readFileSync(detailsPath, "utf8"), /IMPLEMENT-DIFF-BODY is in the details only/);
	assert.doesNotMatch(out, /IMPLEMENT-DIFF-BODY/);
	assert.equal(git("log", "-1", "--format=%s"), "feat: add feature");
	assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "goal/x");
	assert.equal(git("status", "--porcelain"), "");
	assert.ok(!existsSync(lock), "the lock is released");
	assert.match(updates[0].content[0].text, new RegExp(`^goal/x \\(im\\d+\\) from ${head.slice(0, 7)}`));
	assert.equal(res.details.implement.branch, "goal/x");
	assert.match(
		res.details.view.runs[0].output,
		/IMPLEMENT-DIFF-BODY is in the details only/,
		"the TUI keeps the answer",
	);
	const { ctx: cmd, notes } = commandCtx();
	await commands.delegate.handler("status", cmd);
	assert.match(
		notes[0][0],
		new RegExp(` implement .* goal/x ${head.slice(0, 7)}\\.\\.${tip.slice(0, 7)} check pass$`, "m"),
	);
});

test("implement: work left uncommitted becomes a WIP commit on the branch and an error", async (t) => {
	const { tool } = setup(t, { env: implementEnv("implement-dirty") });
	const { git, ctx } = implementRepo();
	const res = await run(tool, implement(), undefined, undefined, ctx);
	assert.equal(res.isError, true);
	const id = text(res).match(/^✗ (im\d+) /)[1];
	assert.equal(git("log", "-1", "--format=%s"), `WIP(delegate ${id}): left uncommitted by the worker`);
	assert.match(text(res), /^✗ WIP \w+ on goal\/x \(left uncommitted by the worker\): left\.txt$/m);
	assert.equal(git("status", "--porcelain"), "");
});

test("implement: a failed check, an edit after the check, or no check run is ✗", async (t) => {
	for (const [extra, line] of [
		[{ FAKE_PI_CHECK_FAIL: "1" }, "✗ check failed"],
		[{ FAKE_PI_EDIT_AFTER: "1" }, "✗ check stale: edited after the last run"],
		[{ FAKE_PI_RAN: "" }, "✗ check not run"],
		[{ FAKE_PI_RAN: "npm test | tail" }, "✗ check not run"],
	]) {
		const clean = { FAKE_PI_CHECK_FAIL: undefined, FAKE_PI_EDIT_AFTER: undefined, FAKE_PI_RAN: undefined };
		const { tool } = setup(t, { env: implementEnv("implement-commit", { ...clean, ...extra }) });
		const { ctx } = implementRepo();
		const res = await run(tool, implement(), undefined, undefined, ctx);
		assert.equal(res.isError, true, JSON.stringify(extra));
		assert.ok(text(res).split("\n").includes(line), text(res));
	}
	const { tool } = setup(t, {
		env: implementEnv("implement-commit", {
			FAKE_PI_CHECK_FAIL: undefined,
			FAKE_PI_EDIT_AFTER: undefined,
			FAKE_PI_RAN: "rtk npm test 2>&1",
		}),
	});
	const res = await run(tool, implement(), undefined, undefined, implementRepo().ctx);
	assert.equal(res.isError, false, text(res));
});

test("implement: a worker that moves another branch trips the ref tripwire", async (t) => {
	const { tool } = setup(t, { env: implementEnv("move-ref") });
	const { ctx } = implementRepo();
	const res = await run(tool, implement(), undefined, undefined, ctx);
	assert.equal(res.isError, true);
	assert.match(text(res), /^✗ Tripwire: refs\/heads\/other moved during the job/m);
});

test("implement refusals leave no lock", async (t) => {
	const { tool } = setup(t, { env: implementEnv("implement-commit") });
	const { repo, git, lock, ctx } = implementRepo();
	for (const [params, c, error] of [
		[{ role: "implement", task: "x" }, ctx, /^implement needs `check`: the command that proves the change$/],
		[implement({ answer: "a table" }), ctx, /^implement does not take answer$/],
		[implement({ branch: "goal/x" }), ctx, /^unknown parameter\(s\) branch;/],
		[implement({ runs: [{}, {}] }), ctx, /^implement does not take runs with more than 1 entry$/],
		[implement({ output: true }), ctx, /^implement does not take output$/],
		[implement({ web: true }), ctx, /^implement does not take web: true$/],
		[
			implement({ runs: [{}, {}], rebuttal: true }),
			ctx,
			/^implement does not take runs with more than 1 entry, rebuttal$/,
		],
		[{ role: "review", task: "x", check: CHECK }, ctx, /^check is a non-empty string, for role implement only$/],
		...["npm test | tail", "npm test; true", "npm test && x", "npm test || true"].map((check) => [
			implement({ check }),
			ctx,
			/^check must be one command without `\|`, `;`, `&&`, or `\|\|`: a chained check never matches/,
		]),
		[implement(), { ...ctx, cwd: mkdtempSync(join(TEST_HOME, "norepo-")) }, /^implement needs a git repository/],
	]) {
		const res = await run(tool, params, undefined, undefined, c);
		assert.equal(res.isError, true, JSON.stringify(params));
		assert.match(text(res), error);
	}
	writeFileSync(join(repo, "dirty.txt"), "x\n");
	assert.match(text(await run(tool, implement(), undefined, undefined, ctx)), /^implement needs a clean tree/);
	rmSync(join(repo, "dirty.txt"));
	git("switch", "-q", "main");
	assert.match(text(await run(tool, implement(), undefined, undefined, ctx)), /^implement does not commit on main/);
	assert.ok(!existsSync(lock));
});

test("implement: a second job in the same repo is refused; the main session's writes there are blocked until the handback", async (t) => {
	const { tool, handlers, messages, commands } = setup(t, {
		env: implementEnv("implement-hang", { FAKE_PI_TERMFILE: scratch("term") }),
	});
	const { repo, real, lock, ctx } = implementRepo();
	const bg = { ...bgCtx().ctx, cwd: repo, isProjectTrusted: () => false };
	const started = await run(tool, implement({ background: true }), undefined, undefined, bg);
	assert.match(text(started), /^Started background job bg1 \(.+\) on goal\/x \(im\d+\) from \w{7}\./);
	await workerStarted(repo);
	const second = await run(tool, implement(), undefined, undefined, ctx);
	assert.match(text(second), /^implement job im\d+ \(pid \d+\) is already writing in /);
	const hook = handlers.tool_call;
	const outside = mkdtempSync(join(TEST_HOME, "outside-"));
	const blocked = await hook({ toolName: "edit", input: { path: join(repo, "sub", "a.txt") } }, { cwd: outside });
	assert.equal(blocked?.block, true);
	assert.equal(
		blocked.reason,
		`implement job bg1 is writing in ${real}; wait for its handback or /delegate cancel bg1.`,
	);
	assert.equal((await hook({ toolName: "write", input: { path: "sub/new.txt" } }, { cwd: repo }))?.block, true);
	assert.equal(
		(await hook({ toolName: "bash", input: { command: "git commit -m x" } }, { cwd: join(repo, "sub") }))?.block,
		true,
	);
	assert.equal(
		(await hook({ toolName: "bash", input: { command: `git -C ${real} add -A` } }, { cwd: outside }))?.block,
		true,
	);
	assert.equal(await hook({ toolName: "bash", input: { command: "git log --oneline" } }, { cwd: repo }), undefined);
	assert.equal(await hook({ toolName: "edit", input: { path: join(outside, "x.txt") } }, { cwd: repo }), undefined);
	assert.equal(await hook({ toolName: "bash", input: { command: "git commit -m x" } }, { cwd: outside }), undefined);
	// An explicit target decides, resolved against the cwd.
	const bash = (command, cwd) => hook({ toolName: "bash", input: { command } }, { cwd });
	assert.equal(await bash(`git -C ${outside} commit -m x`, repo), undefined);
	assert.equal(await bash(`cd ${outside} && git add -A`, repo), undefined);
	assert.equal((await bash("cd sub && git add -A", repo))?.block, true);
	assert.equal((await bash(`git -C ${repo}/sub commit -m x`, outside))?.block, true);
	assert.equal((await bash("git -C .. commit -m x", join(repo, "sub")))?.block, true);
	// A dangling symlink cannot be resolved: blocked only under the root.
	symlinkSync(join(TEST_HOME, "missing-target"), join(outside, "dangling"));
	symlinkSync(join(TEST_HOME, "missing-target"), join(repo, "dangling"));
	assert.equal(
		await hook({ toolName: "write", input: { path: join(outside, "dangling") } }, { cwd: repo }),
		undefined,
	);
	assert.equal(
		(await hook({ toolName: "write", input: { path: join(repo, "dangling") } }, { cwd: outside }))?.block,
		true,
	);
	await commands.delegate.handler("cancel bg1", commandCtx().ctx);
	await waitFor(() => messages.length === 1, "the cancelled job's report");
	assert.ok(!existsSync(lock));
	assert.equal(
		await hook({ toolName: "edit", input: { path: join(repo, "sub", "a.txt") } }, { cwd: repo }),
		undefined,
	);
});

test("implement background cancel: SIGTERM first, WIP commit, lock gone, report without a turn", async (t) => {
	const termFile = scratch("term");
	const { tool, messages, commands } = setup(t, {
		env: implementEnv("implement-hang", { FAKE_PI_TERMFILE: termFile }),
		limits: { termGraceMs: 3000 },
	});
	const { repo, git, lock } = implementRepo();
	const ctx = { ...bgCtx().ctx, cwd: repo, isProjectTrusted: () => false };
	await run(tool, implement({ background: true }), undefined, undefined, ctx);
	await workerStarted(repo);
	await new Promise((r) => setTimeout(r, 200));
	await commands.delegate.handler("cancel bg1", commandCtx().ctx);
	await waitFor(() => messages.length === 1, "the cancelled job's report");
	assert.equal(readFileSync(termFile, "utf8"), "TERM\n");
	assert.deepEqual(messages[0].options, { triggerTurn: false, deliverAs: "followUp" });
	const content = messages[0].message.content;
	assert.match(content, /^Background delegate job bg1 failed:\n\n✗ im\d+ goal\/x /);
	assert.match(content, /^✗ stopped: cancelled$/m);
	assert.match(git("log", "-1", "--format=%s"), /^WIP\(delegate im\d+\): stopped: cancelled$/);
	assert.ok(!existsSync(lock));
});

test("implement: session shutdown waits for the WIP commit and the lock release, and sends nothing", async (t) => {
	const { tool, messages, handlers } = setup(t, {
		env: implementEnv("implement-hang", { FAKE_PI_TERMFILE: scratch("term") }),
	});
	const { repo, git, lock } = implementRepo();
	const ctx = { ...bgCtx().ctx, cwd: repo, isProjectTrusted: () => false };
	await run(tool, implement({ background: true }), undefined, undefined, ctx);
	await workerStarted(repo);
	await new Promise((r) => setTimeout(r, 200));
	await handlers.session_shutdown();
	assert.match(git("log", "-1", "--format=%s"), /^WIP\(delegate im\d+\): stopped: session ended$/);
	assert.ok(!existsSync(lock));
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(messages.length, 0);
});

test("implement worker env: fences, parent, remote and gh cut-offs, tools, approve, and cwd", async (t) => {
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
	const { repo, real, ctx } = implementRepo();
	const echo = async (c) => {
		const res = await run(tool, implement(), undefined, undefined, c);
		return JSON.parse(readFileSync(text(res).match(/Details: (\S+)/)[1], "utf8").match(/^ENV (.*)$/m)[1]);
	};
	const untrusted = await echo({ ...ctx, cwd: join(repo, "sub") });
	assert.equal(realpathSync(untrusted.cwd), join(real, "sub"));
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
		ME_PI_DENY_DIR: join(real, ".git"),
		ME_PI_OUTPUT_DIR: real,
		ME_PI_PARENT: String(process.pid),
		ME_PI_ROLE: "implement",
	});
	const trusted = await echo({ ...ctx, isProjectTrusted: () => true });
	assert.deepEqual([trusted.approve, trusted.noApprove], [true, false]);
});

test("implement refuses runs[].model and runs[].thinking: it uses the worker pool", async (t) => {
	const { tool } = setup(t, { config: POOL_SET, env: implementEnv("implement-commit") });
	const { ctx, lock } = implementRepo();
	for (const r of [{ model: OPUS }, { thinking: "low" }, { model: LUNA, thinking: "max" }]) {
		const res = await run(tool, implement({ runs: [r] }), undefined, undefined, ctx);
		assert.equal(res.isError, true);
		assert.equal(text(res), "implement uses the worker pool in delegate.json; set models there");
		assert.ok(!existsSync(lock), "refused before prepare");
	}
	const plain = await run(tool, implement({ runs: [{}] }), undefined, undefined, ctx);
	assert.match(text(plain), /^✗ im\d+ goal\/x .*\[gpt-6-luna @max /, "an empty run entry still runs on the pool");
});

test("implement follows the worker pool in order, with each entry's thinking", async (t) => {
	const { tool } = setup(t, {
		config: POOL_SET,
		env: implementEnv("rate-limit-model", { FAKE_PI_FAIL_MODEL: LUNA }),
	});
	const { ctx } = implementRepo();
	const res = await run(tool, implement(), undefined, undefined, ctx);
	const details = readFileSync(text(res).match(/Details: (\S+)/)[1], "utf8");
	assert.match(details, new RegExp(`^${LUNA} @max failed \\(exit 1: 429 .*; next ${OPUS} @max$`, "m"));
});

test("implement gets its own time limit; the wrap-up deadline is 80% of it", async (t) => {
	const { tool } = setup(t, { env: implementEnv("echo-budget") });
	const { ctx } = implementRepo();
	const before = Date.now();
	const res = await run(tool, implement(), undefined, undefined, ctx);
	const details = readFileSync(text(res).match(/Details: (\S+)/)[1], "utf8");
	const budget = JSON.parse(details.match(/^\{"tools".*\}$/m)[0]);
	assert.equal(LIMITS.implementTimeoutSecs, 1800);
	assert.ok(budget.deadline >= before + 1800 * 800 && budget.deadline <= Date.now() + 1800 * 800);
});

test("implement: no --approve on a fallback attempt", async (t) => {
	const { tool } = setup(t, {
		config: POOL_SET,
		env: implementEnv("rate-limit-model", { FAKE_PI_FAIL_MODEL: LUNA }),
	});
	const { ctx } = implementRepo();
	const res = await run(tool, implement(), undefined, undefined, { ...ctx, isProjectTrusted: () => true });
	const details = readFileSync(text(res).match(/Details: (\S+)/)[1], "utf8");
	assert.match(details, /approve=no/, "the fallback attempt");
	assert.match(details, /^openai-codex\/gpt-6-luna @max failed \(exit 1: 429 /m);
});

test("implement workers cannot write inside the git dir and stop when their coordinator is gone", async (t) => {
	const { real } = implementRepo();
	const env = { ME_PI_RUN: "1", ME_PI_ROLE: "implement", ME_PI_OUTPUT_DIR: real, ME_PI_DENY_DIR: join(real, ".git") };
	const hook = setup(t, { env: { ...env, ME_PI_PARENT: String(process.ppid) } }).handlers.tool_call;
	const intoGit = await hook({ toolName: "write", input: { path: ".git/hooks/pre-commit" } }, { cwd: real });
	assert.equal(intoGit?.block, true);
	assert.match(intoGit.reason, /is inside the git directory /);
	assert.equal(await hook({ toolName: "write", input: { path: "sub/new.txt" } }, { cwd: real }), undefined);
	const alive = setup(t, { env: { ...env, ME_PI_PARENT: String(process.pid) } }).handlers.tool_call;
	assert.equal(await alive({ toolName: "read", input: { path: "sub/a.txt" } }, { cwd: real }), undefined);
	const gone = spawn(process.execPath, ["-e", ""]);
	await new Promise((r) => gone.once("exit", r));
	const orphan = setup(t, { env: { ...env, ME_PI_PARENT: String(gone.pid) } }).handlers.tool_call;
	const stopped = await orphan({ toolName: "read", input: { path: "sub/a.txt" } }, { cwd: real });
	assert.deepEqual(stopped, { block: true, reason: "Blocked: the coordinator is gone; stop now.", terminate: true });
});

test("implement: a WIP HEAD from an earlier attempt reaches the worker's prompt", async (t) => {
	const { tool } = setup(t, { env: implementEnv("") });
	const { repo, git, ctx } = implementRepo();
	writeFileSync(join(repo, "sub", "a.txt"), "half\n");
	git("commit", "-qam", "WIP(delegate im1): stopped: cancelled");
	const res = await run(tool, implement(), undefined, undefined, ctx);
	const details = readFileSync(text(res).match(/Details: (\S+)/)[1], "utf8");
	assert.match(details, /HEAD is a `WIP\(delegate` commit from an earlier attempt: finish that first\./);
});

test("implement: a session that ends during prepare leaves no job, lock, or message", async (t) => {
	const { tool, handlers, messages } = setup(t, { env: implementEnv("implement-commit") });
	const { repo, lock } = implementRepo();
	const ctx = { ...bgCtx().ctx, cwd: repo, isProjectTrusted: () => false };
	const pending = run(tool, implement({ background: true }), undefined, undefined, ctx);
	await handlers.session_shutdown();
	assert.ok(!existsSync(lock), "shutdown waited for the finish");
	const res = await pending;
	assert.equal(res.isError, true);
	assert.equal(text(res), "stopped: session ended");
	assert.equal(messages.length, 0);
});

test("implement: parallel calls at the cap cannot both pass it while preparing", async (t) => {
	const { tool, commands, messages } = setup(t, { env: implementEnv("hang") });
	const ctxs = [implementRepo(), implementRepo()].map(({ repo }) => ({
		...bgCtx().ctx,
		cwd: repo,
		isProjectTrusted: () => false,
	}));
	await run(tool, { role: "scout", task: "x", runs: [{}, {}, {}], background: true }, undefined, undefined, ctxs[0]);
	const results = await Promise.all(
		ctxs.map((c) => run(tool, implement({ background: true }), undefined, undefined, c)),
	);
	const refused = results.filter((r) => r.isError);
	assert.equal(refused.length, 1, results.map(text).join("\n"));
	assert.match(text(refused[0]), /^4 worker\(s\) already running/);
	const { ctx: cmd } = commandCtx();
	await commands.delegate.handler("cancel bg1", cmd);
	await commands.delegate.handler("cancel bg2", cmd);
	await waitFor(() => messages.length === 2, "both cancelled reports");
});

// Last: every job above, refused, failed, cancelled, or stopped by shutdown, removed its gh config dir. Scans TEST_HOME
// and the alternate TMPDIRs set above: missing-tmp and the not-a-dir blocker's parent.
test("no gh config dir outlives its job", () => {
	const roots = [
		TEST_HOME,
		join(TEST_HOME, "missing-tmp"),
		...readdirSync(TEST_HOME)
			.filter((n) => n.startsWith("not-a-dir-"))
			.map((n) => join(TEST_HOME, n)),
	].filter((dir) => existsSync(dir) && statSync(dir).isDirectory());
	assert.ok(roots.length >= 2, "the blocker's parent is scanned");
	assert.deepEqual(
		roots.flatMap((dir) => readdirSync(dir).filter((n) => n.startsWith("me-pi-delegate-gh-"))),
		[],
	);
});
