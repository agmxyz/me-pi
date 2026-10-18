import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Scratch space for the fake pi binary, configs, and pid files.
const TEST_HOME = mkdtempSync(join(tmpdir(), "delegate-test-"));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
process.on("exit", () => {
	try {
		rmSync(TEST_HOME, { recursive: true, force: true });
	} catch {}
});

const {
	default: registerExtension,
	loadConfig,
	pickModel,
	ROLES,
	WORKER_CONTRACT,
	WORKER_TOOLS,
	PROMPT_GUIDELINES,
} = await import("./delegate.ts");

// Keep the developer's real ~/.pi/agent/delegate.json out of every test.
const NO_CONFIG = join(TEST_HOME, "no-delegate.json");
process.env.ME_PI_DELEGATE_CONFIG = NO_CONFIG;

// Fake pi: echoes how it was invoked; FAKE_PI_MODE drives failure and lifecycle fixtures.
const FAKE_BIN = join(TEST_HOME, "fake-pi.mjs");
writeFileSync(
	FAKE_BIN,
	`#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const prompt = args.at(-1) || "";
if (process.env.FAKE_PI_MARKER) appendFileSync(process.env.FAKE_PI_MARKER, prompt.replace(/\\n/g, " ") + "\\n");
const mode = process.env.FAKE_PI_MODE || "";
const emit = (text, { cost = Number(process.env.FAKE_PI_COST || "0.002"), stopReason, content = [] } = {}) => console.log(JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    model: flag("--model") || "default-model",
    usage: { cost: { total: cost } },
    ...(stopReason ? { stopReason } : {}),
    content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "src/a.ts" } }, ...content, { type: "text", text }],
  },
}));
if (mode === "final-over-cap") {
  emit("complete answer", { cost: 5, stopReason: "stop" });
  process.exit(0);
}
if (mode === "length-stop") {
  emit("partial output before token limit", { stopReason: "length" });
  process.exit(0);
}
if (mode === "network-then-crash") {
  emit("partial research", { content: [
    { type: "toolCall", id: "w1", name: "web_search", arguments: { query: "pi skills" } },
    { type: "toolCall", id: "s1", name: "Skill", arguments: { name: "tdd" } },
  ] });
  console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "w1", toolName: "web_search", args: { query: "pi skills" } }));
  console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "f1", toolName: "fetch_content", args: { url: "https://example.com" } }));
  process.stderr.write("worker stderr line\\n");
  process.exit(3);
}
if (mode === "many-calls-then-crash") {
  emit("partial", { content: Array.from({ length: 35 }, (_, i) => ({ type: "toolCall", id: "c" + i, name: "fetch_content", arguments: { url: "https://e.com/" + i } })) });
  process.exit(3);
}
if (mode === "fail-model" && flag("--model") === process.env.FAKE_PI_FAIL_MODEL) {
  process.stderr.write("rate limited\\n");
  process.exit(3);
}
if (mode === "hang") {
  // Ignores SIGTERM, so only the SIGKILL escalation stops it.
  if (process.env.FAKE_PI_PIDFILE) writeFileSync(process.env.FAKE_PI_PIDFILE, String(process.pid));
  process.on("SIGTERM", () => {});
  emit("partial work so far");
  process.stderr.write("worker stderr line\\n");
  setInterval(() => {}, 1000);
} else if (mode === "split-utf8") {
  // Writes one JSON line in two chunks that split the 3-byte "✓" between them.
  const line = Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { cost: { total: 0.001 } }, content: [{ type: "text", text: "ok ✓ done" }] } }) + "\\n");
  const cut = line.indexOf(Buffer.from("✓")) + 1;
  process.stdout.write(line.subarray(0, cut), () => setTimeout(() => process.stdout.write(line.subarray(cut), () => process.exit(0)), 100));
} else if (mode === "group-child-holds-pipes") {
  // A same-group child ignores SIGTERM and keeps the inherited pipes open after the leader exits.
  const child = spawn("sh", ["-c", "trap '' TERM; sleep 60"], { stdio: ["ignore", "inherit", "inherit"] });
  writeFileSync(process.env.FAKE_PI_PIDFILE, String(child.pid));
  emit("leader done");
  process.exit(0);
} else if (mode === "escaped-pipes") {
  // A detached child (outside the worker group) holds the pipes, so "close" never fires.
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
  writeFileSync(process.env.FAKE_PI_PIDFILE, String(child.pid));
  emit("leader done");
  process.exit(0);
} else {
  setTimeout(() => emit([
    "DONE",
    "model=" + (flag("--model") || "default-model"),
    "thinking=" + (flag("--thinking") || "none"),
    "tools=" + (flag("--tools") ?? "default"),
    "session=" + (args.includes("--no-session") ? "none" : "?"),
    "mcp=" + (args.includes("--no-mcp") ? "off" : "on"),
    "role=" + ((flag("--append-system-prompt") || "").match(/Role: ([a-z]+)\\./)?.[1] ?? "none"),
    "workerRun=" + (process.env.ME_PI_RUN || ""),
    "prompt=" + JSON.stringify(prompt),
    (process.env.FAKE_PI_PAD_CHAR || "x").repeat(Number(process.env.FAKE_PI_PAD_BYTES || "0")),
  ].join(" ")), Number(process.env.FAKE_PI_SLEEP_MS || "0"));
}
`,
);
chmodSync(FAKE_BIN, 0o755);

const CTX = { cwd: REPO_ROOT, model: { provider: "anthropic", id: "claude-session" }, thinkingLevel: "medium" };

// Restores each variable to its value before the test's first change.
const envSaved = new WeakMap();
function withEnv(t, vars) {
	if (!envSaved.has(t)) {
		const saved = {};
		envSaved.set(t, saved);
		t.after(() => {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		});
	}
	const saved = envSaved.get(t);
	for (const [key, value] of Object.entries(vars)) {
		if (!(key in saved)) saved[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function register(t, { workerRun } = {}) {
	withEnv(t, { ME_PI_RUN: workerRun });
	const tools = {};
	const handlers = {};
	const commands = {};
	registerExtension({
		registerTool: (definition) => {
			tools[definition.name] = definition;
		},
		on: (event, handler) => {
			handlers[event] = handler;
		},
		registerCommand: (name, definition) => {
			commands[name] = definition;
		},
	});
	return { tools, handlers, commands };
}

function delegateTool(t, env = {}) {
	withEnv(t, { PI_BIN: FAKE_BIN, ...env });
	return register(t);
}

function writeConfig(t, content) {
	const path = join(TEST_HOME, `delegate-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
	withEnv(t, { ME_PI_DELEGATE_CONFIG: path });
	return path;
}

const LIST = {
	models: [
		{ id: "openai/gpt-cheap", tier: "cheap", thinking: "off" },
		{ id: "anthropic/claude-strong", tier: "strong", thinking: "medium" },
		{ id: "openai/gpt-strong", tier: "strong" },
	],
};

const run = (tools, params, signal, onUpdate) => tools.delegate.execute("c1", params, signal, onUpdate, CTX);
const text = (res) => res.content[0].text;
const markerLines = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(check, what, ms = 10000) {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

async function waitDead(pid, ms = 5000) {
	const deadline = Date.now() + ms;
	while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
	return !isAlive(pid);
}

function killGroup(pidFile) {
	if (!existsSync(pidFile)) return;
	try {
		process.kill(-Number(readFileSync(pidFile, "utf8")), "SIGKILL");
	} catch (err) {
		if (err?.code !== "ESRCH") throw err;
	}
}

test("main session registers delegate and no commands; workers do not register it", (t) => {
	const main = register(t);
	const tool = main.tools.delegate;
	assert.ok(tool, "delegate registered in the main session");
	assert.ok(main.handlers.session_shutdown, "shutdown cleanup registered");
	assert.ok(tool.promptSnippet);
	assert.equal(tool.promptGuidelines, PROMPT_GUIDELINES);
	assert.deepEqual(Object.keys(main.commands), [], "no /setup-delegate or /coordinate");
	assert.deepEqual(tool.parameters.properties.role.enum, ["scout", "research", "review", "challenge"]);
	for (const removed of ["tools", "approval", "session", "skills", "panel"])
		assert.equal(tool.parameters.properties[removed], undefined, `${removed} removed`);
	assert.equal(register(t, { workerRun: "1" }).tools.delegate, undefined, "no delegate inside a worker");
});

test("workers are read-only, one-shot, marked as workers, and get the contract and role", async (t) => {
	const { tools } = delegateTool(t);
	const updates = [];
	const res = await run(tools, { task: "find foo", role: "scout" }, undefined, (u) => updates.push(u));
	assert.equal(res.isError, false);
	assert.equal(WORKER_TOOLS, "read,grep,find,ls,web_search,fetch_content,get_search_content,Skill");
	assert.match(text(res), new RegExp(`tools=${WORKER_TOOLS} session=none mcp=off role=scout workerRun=1`));
	assert.match(text(res), /prompt="Task:\\nfind foo"/);
	assert.match(text(res), /\[worker exit=0 turns=1 cost=\$0\.0020 \d+s anthropic\/claude-session @low\]$/);
	assert.ok(updates.length >= 1, "streams progress");
	assert.match(WORKER_CONTRACT, /read-only/);
	assert.match(WORKER_CONTRACT, /cannot edit files, run commands, delegate, or commit/);
	assert.match(WORKER_CONTRACT, /Never use fetch_content's `auth` option/);
	assert.match(WORKER_CONTRACT, /Never report success over a BLOCKED step/);
});

test("roles pick model and thinking from the list; task values win; empty list uses the session model", async (t) => {
	writeConfig(t, LIST);
	const { tools } = delegateTool(t);
	const scout = await run(tools, { task: "x", role: "scout" });
	assert.match(text(scout), /model=openai\/gpt-cheap thinking=off/, "listed thinking beats role default");
	const research = await run(tools, { task: "x", role: "research" });
	assert.match(text(research), /model=anthropic\/claude-strong thinking=medium/, "first strong model");
	const unlistedThinking = await run(tools, { task: "x", role: "research", model: "openai/gpt-strong" });
	assert.match(text(unlistedThinking), /model=openai\/gpt-strong thinking=high/, "no listed thinking: role default");
	const explicit = await run(tools, { task: "x", role: "scout", model: "any/unlisted", thinking: "max" });
	assert.match(text(explicit), /model=any\/unlisted thinking=max/, "task values win, unlisted models allowed");

	writeConfig(t, { models: [] });
	const empty = await run(tools, { task: "x", role: "review" });
	assert.match(text(empty), /model=anthropic\/claude-session thinking=high/);
});

test("review and challenge prefer another family than the session, and say when they cannot", async (t) => {
	writeConfig(t, LIST);
	const { tools } = delegateTool(t);
	for (const role of ["review", "challenge"]) {
		const res = await run(tools, { task: "x", role });
		assert.match(text(res), /model=openai\/gpt-strong thinking=high/, `${role} skips the session's anthropic family`);
		assert.doesNotMatch(text(res), /note:/);
	}
	writeConfig(t, { models: [{ id: "anthropic/claude-strong", tier: "strong" }] });
	const fallback = await run(tools, { task: "x", role: "review" });
	assert.match(text(fallback), /model=anthropic\/claude-strong/);
	assert.match(
		text(fallback),
		/\(note: same model family as the session \(anthropic\): no strong model of another family is listed\)/,
	);
	assert.equal(pickModel(ROLES.review, loadConfig(), "anthropic").id, "anthropic/claude-strong");
});

test("the model list is validated loudly when the tool runs", async (t) => {
	const { tools } = delegateTool(t);
	const cases = [
		["{not json", /invalid .*delegate-.*\.json/],
		[{ profiles: {} }, /unknown key\(s\) profiles; only "models"/],
		[{ models: {} }, /models must be an array/],
		[{ models: [{ id: "a/b", tier: "cheap", thinkng: "low" }] }, /models\[0\] has unknown key\(s\) thinkng/],
		[{ models: [{ id: "a/b", tier: "fast" }] }, /a\/b\.tier must be one of cheap, strong/],
		[
			{
				models: [
					{ id: "a/b", tier: "cheap" },
					{ id: "a/b", tier: "cheap" },
				],
			},
			/a\/b is listed twice as cheap/,
		],
		[{ models: [{ id: "a/b", tier: "cheap", thinking: "huge" }] }, /a\/b\.thinking must be one of/],
		[{ models: [{ id: "a/b", tier: "cheap", family: "" }] }, /a\/b\.family must be a non-empty string/],
	];
	for (const [content, error] of cases) {
		writeConfig(t, content);
		const res = await run(tools, { task: "x", role: "scout" });
		assert.equal(res.isError, true);
		assert.match(text(res), error);
	}
	writeConfig(t, {
		models: [
			{ id: "openrouter/z-ai/glm", tier: "cheap" },
			{ id: "x/claude-y", tier: "strong", family: "custom" },
		],
	});
	assert.deepEqual(
		loadConfig().map((m) => m.family),
		["openrouter", "custom"],
	);
});

test("the schema lists the user's models with tier, family, and thinking", (t) => {
	writeConfig(t, LIST);
	const { tools } = register(t);
	assert.match(
		tools.delegate.parameters.properties.model.description,
		/openai\/gpt-cheap \(cheap, openai, thinking off\)/,
	);
});

test("parallel tasks run with their own model and thinking; bad shapes are rejected", async (t) => {
	const { tools } = delegateTool(t);
	const res = await run(tools, {
		tasks: [
			{ task: "a", role: "review", model: "anthropic/claude-opus-5-5", thinking: "medium" },
			{ task: "a", role: "review", model: "openai-codex/gpt-6.1-sol", thinking: "high" },
		],
	});
	assert.equal(res.isError, false);
	assert.match(text(res), /### \[#1\][\s\S]*model=anthropic\/claude-opus-5-5 thinking=medium/);
	assert.match(text(res), /### \[#2\][\s\S]*model=openai-codex\/gpt-6\.1-sol thinking=high/);

	const bad = [
		[{}, /Provide either \{ task, role \} or \{ tasks/],
		[{ task: "a", role: "scout", tasks: [{ task: "b", role: "scout" }] }, /Provide either/],
		[{ tasks: [{ task: "a", role: "scout" }], role: "scout" }, /set role inside each task/],
		[
			{ tasks: Array.from({ length: 9 }, () => ({ task: "a", role: "scout" })) },
			/Too many parallel tasks \(9; max 8\)/,
		],
		[{ task: "a", role: "scout", rebuttal: true }, /rebuttal needs \{ tasks: \[\.\.\.\] \} with at least two tasks/],
		[
			{ tasks: [{ task: "a", role: "scout" }, { role: "scout" }] },
			/tasks\[1\] needs a non-empty "task" and a "role"/,
		],
		[{ tasks: [{ task: "  ", role: "scout" }] }, /tasks\[0\] needs a non-empty "task"/],
		[{ tasks: [{ task: "a" }] }, /tasks\[0\] needs a non-empty "task" and a "role"/],
		[
			{
				rebuttal: true,
				tasks: [
					{ task: "x".repeat(110 * 1024), role: "review" },
					{ task: "y", role: "review" },
				],
			},
			/tasks\[0\] is too large for a rebuttal round \(max 106496 bytes\)/,
		],
		[{ task: "a", role: "scout", timeoutSecs: 0 }, /timeoutSecs must be a positive number/],
		[{ task: "a", role: "scout", costCapUsd: -1 }, /costCapUsd must be a positive number/],
	];
	for (const [params, error] of bad) {
		const r = await run(tools, params);
		assert.equal(r.isError, true);
		assert.match(text(r), error);
	}
	const noRole = await run(tools, { task: "a" });
	assert.match(text(noRole), /role is required: one of scout, research, review, challenge\./);
	const unknownRole = await run(tools, { task: "a", role: "implement" });
	assert.match(text(unknownRole), /unknown role "implement" \(known: scout, research, review, challenge\)/);
});

test("rebuttal gives each successful worker its own answer and the others', then reports both rounds", async (t) => {
	const marker = join(TEST_HOME, "rebuttal-marker");
	const { tools } = delegateTool(t, { FAKE_PI_MARKER: marker });
	const res = await run(tools, {
		rebuttal: true,
		tasks: [
			{ task: "judge plan", role: "challenge", model: "m/a" },
			{ task: "judge plan", role: "challenge", model: "m/b" },
		],
	});
	assert.equal(res.isError, false);
	const out = text(res);
	assert.match(out, /## Round 1 \(independent\)[\s\S]*### \[#1\][\s\S]*### \[#2\][\s\S]*## Round 2 \(rebuttal\)/);
	assert.match(out, /### \[#1 rebuttal\][\s\S]*### \[#2 rebuttal\][\s\S]*Total: 4 workers, cost \$0\.0080\./);
	const round2 = markerLines(marker).filter((l) => l.includes("Round 2 (rebuttal)"));
	assert.equal(round2.length, 2);
	const forA = round2.find((l) => /Your answer:\s+DONE model=m\/a/.test(l));
	assert.ok(forA, "worker A sees its own round-1 answer");
	assert.match(forA, /### Worker #2 \(m\/b\) DONE model=m\/b/, "and B's answer");
	assert.match(forA, /Changed: yes\|no/);
	assert.match(forA, /model=m\/a/);
});

test("rebuttal is reported unavailable when fewer than two workers succeed", async (t) => {
	const { tools } = delegateTool(t, { FAKE_PI_MODE: "fail-model", FAKE_PI_FAIL_MODEL: "m/b" });
	const res = await run(tools, {
		rebuttal: true,
		tasks: [
			{ task: "q", role: "review", model: "m/a" },
			{ task: "q", role: "review", model: "m/b" },
		],
	});
	assert.equal(res.isError, true);
	assert.match(text(res), /rate limited/);
	assert.match(text(res), /Unavailable: only 1 worker\(s\) succeeded in round 1; at least two are required\./);
});

test("a crash reports partial output, recent tools, network calls (not local reads), and stderr", async (t) => {
	const { tools } = delegateTool(t, { FAKE_PI_MODE: "network-then-crash" });
	const res = await run(tools, { task: "x", role: "research" });
	assert.equal(res.isError, true);
	const out = text(res);
	assert.match(out, /Partial output:\npartial research/);
	assert.match(out, /Recent tools:\n→ read src\/a\.ts\n→ web_search\n→ Skill tdd\n→ fetch_content/);
	assert.match(
		out,
		/Network tool calls \(2\):\n→ web_search \{"query":"pi skills"\}\n→ fetch_content \{"url":"https:\/\/example\.com"\}/,
	);
	assert.doesNotMatch(out, /Network tool calls[\s\S]*→ (read|Skill) /, "local reads and Skill are not network calls");
	assert.match(out, /stderr \(tail\):\nworker stderr line/);
	assert.match(out, /\[worker exit=3 /);
	assert.doesNotMatch(out, /Remote effects/);
});

test("network call previews are bounded", async (t) => {
	const { tools } = delegateTool(t, { FAKE_PI_MODE: "many-calls-then-crash" });
	const res = await run(tools, { task: "x", role: "research" });
	assert.match(text(res), /Network tool calls \(35\):/);
	assert.match(text(res), /\(5 more not shown\)/);
});

test("a token-limit stop is a failure with partial output", async (t) => {
	const { tools } = delegateTool(t, { FAKE_PI_MODE: "length-stop" });
	const res = await run(tools, { task: "x", role: "scout" });
	assert.equal(res.isError, true);
	assert.match(text(res), /Partial output:\npartial output before token limit/);
});

test("cost cap stops the worker; large partial output cannot push out diagnostics", async (t) => {
	const { tools } = delegateTool(t, { FAKE_PI_COST: "5.0", FAKE_PI_PAD_BYTES: String(70 * 1024) });
	const res = await run(tools, { task: "x", role: "scout", costCapUsd: 0.5 });
	assert.equal(res.isError, true);
	assert.match(text(res), /^stopped early: cost-cap/);
	assert.match(text(res), /\[Output truncated at \d+ bytes\]/);
	assert.match(text(res), /Recent tools:\n→ read src\/a\.ts/);
});

test("a final reply that crosses the cost cap keeps the answer with a note", async (t) => {
	const { tools } = delegateTool(t, { FAKE_PI_MODE: "final-over-cap" });
	const res = await run(tools, { task: "x", role: "scout", costCapUsd: 0.5 });
	assert.equal(res.isError, false);
	assert.match(text(res), /^complete answer/);
	assert.match(text(res), /\(note: the final reply crossed the cost cap \(\$0\.5\); the answer is complete\)$/);
});

test("truncation never splits a multibyte character", async (t) => {
	const { tools } = delegateTool(t, { FAKE_PI_PAD_CHAR: "✓", FAKE_PI_PAD_BYTES: String(20 * 1024) });
	const res = await run(tools, { task: "x", role: "scout" });
	assert.match(text(res), /✓\n\n\[Output truncated at 51200 bytes\]/);
	assert.doesNotMatch(text(res), /\uFFFD/);
});

test("rebuttal answers share one budget, so eight long answers still fit the prompt cap", async (t) => {
	const marker = join(TEST_HOME, "rebuttal-budget-marker");
	const { tools } = delegateTool(t, { FAKE_PI_MARKER: marker, FAKE_PI_PAD_BYTES: String(30 * 1024) });
	const res = await run(tools, {
		rebuttal: true,
		tasks: Array.from({ length: 8 }, (_, i) => ({ task: "q", role: "review", model: `m/${i}` })),
	});
	assert.equal(res.isError, false, text(res).slice(0, 500));
	assert.doesNotMatch(text(res), /prompt is \d+ bytes/);
	const round2 = markerLines(marker).filter((l) => l.includes("Round 2 (rebuttal)"));
	assert.equal(round2.length, 8);
	assert.equal(round2[0].match(/\[Output truncated at 10240 bytes\]/g)?.length, 8, "own + 7 others, 10 KiB each");
});

test("a UTF-8 character split across output chunks is decoded intact", async (t) => {
	const { tools } = delegateTool(t, { FAKE_PI_MODE: "split-utf8" });
	const res = await run(tools, { task: "x", role: "scout" });
	assert.match(text(res), /^ok ✓ done/);
});

test("rebuttal answers shrink to fit beside a large task", async (t) => {
	const marker = join(TEST_HOME, "rebuttal-large-task-marker");
	const { tools } = delegateTool(t, { FAKE_PI_MARKER: marker, FAKE_PI_PAD_BYTES: String(30 * 1024) });
	const task = `review this diff:\n${"d".repeat(60 * 1024)}`;
	const res = await run(tools, {
		rebuttal: true,
		tasks: Array.from({ length: 4 }, (_, i) => ({ task, role: "review", model: `m/${i}` })),
	});
	assert.equal(res.isError, false, text(res).slice(-500));
	assert.doesNotMatch(text(res), /prompt is \d+ bytes/);
	assert.equal(markerLines(marker).filter((l) => l.includes("Round 2 (rebuttal)")).length, 4);
});

test("timeout escalates to SIGKILL for a worker that ignores SIGTERM", async (t) => {
	const pidFile = join(TEST_HOME, "timeout.pid");
	const { tools } = delegateTool(t, { FAKE_PI_MODE: "hang", FAKE_PI_PIDFILE: pidFile });
	const res = await run(tools, { task: "x", role: "scout", timeoutSecs: 1 });
	assert.equal(res.isError, true);
	assert.match(text(res), /stopped early: timeout/);
	assert.match(text(res), /Partial output:\npartial work so far/);
	assert.ok(await waitDead(Number(readFileSync(pidFile, "utf8"))), "worker killed");
});

test("invalid env limits fail loudly instead of disabling the cap", async (t) => {
	const { tools } = delegateTool(t, { ME_PI_DELEGATE_COST_CAP: "nope" });
	await assert.rejects(run(tools, { task: "x", role: "scout" }), /ME_PI_DELEGATE_COST_CAP must be a positive number/);
});

test("abort stops a running worker with structured failure evidence", async (t) => {
	const pidFile = join(TEST_HOME, "abort.pid");
	const { tools } = delegateTool(t, { FAKE_PI_MODE: "hang", FAKE_PI_PIDFILE: pidFile });
	const controller = new AbortController();
	const pending = run(tools, { task: "x", role: "scout", timeoutSecs: 60 }, controller.signal);
	await waitFor(() => existsSync(pidFile), "worker pid file");
	await new Promise((r) => setTimeout(r, 200));
	controller.abort();
	const res = await pending;
	assert.equal(res.isError, true);
	assert.match(text(res), /stopped early: aborted/);
	assert.ok(await waitDead(Number(readFileSync(pidFile, "utf8"))), "worker killed");
});

test("an already-aborted signal cancels every task without spawning", async (t) => {
	const marker = join(TEST_HOME, "aborted-marker");
	const { tools } = delegateTool(t, { FAKE_PI_MARKER: marker });
	const controller = new AbortController();
	controller.abort();
	const res = await run(
		tools,
		{ tasks: Array.from({ length: 3 }, () => ({ task: "x", role: "scout" })) },
		controller.signal,
	);
	assert.equal(res.isError, true);
	assert.equal(markerLines(marker).length, 0);
	assert.equal(text(res).match(/cancelled before start/g)?.length, 3);
});

test("session_shutdown stops running workers and cancels queued ones; later calls still work", async (t) => {
	const marker = join(TEST_HOME, "queue-marker");
	const { tools, handlers } = delegateTool(t, { FAKE_PI_MARKER: marker, FAKE_PI_SLEEP_MS: "20000" });
	const pending = run(tools, { tasks: Array.from({ length: 5 }, () => ({ task: "x", role: "scout" })) });
	await waitFor(() => markerLines(marker).length >= 4, "four running workers");
	const started = Date.now();
	await handlers.session_shutdown({ reason: "quit" }, {});
	assert.ok(Date.now() - started < 8000, "shutdown waits only for the stop");
	const res = await pending;
	assert.equal(markerLines(marker).length, 4, "fifth task never spawned");
	assert.match(text(res), /### \[#1\]\n\nstopped early: aborted/);
	assert.match(text(res), /### \[#5\]\n\ncancelled before start/);
	withEnv(t, { FAKE_PI_SLEEP_MS: undefined });
	assert.equal((await run(tools, { task: "after", role: "scout" })).isError, false);
});

test("leader exit still kills a same-group child holding its pipes", async (t) => {
	const pidFile = join(TEST_HOME, "group-child.pid");
	t.after(() => killGroup(pidFile));
	const { tools } = delegateTool(t, { FAKE_PI_MODE: "group-child-holds-pipes", FAKE_PI_PIDFILE: pidFile });
	const started = Date.now();
	const res = await run(tools, { task: "x", role: "scout" });
	assert.ok(Date.now() - started < 5000, "not blocked by the child's sleep");
	assert.equal(res.isError, false);
	assert.match(text(res), /leader done/);
	assert.ok(await waitDead(Number(readFileSync(pidFile, "utf8"))), "child killed");
});

test("completion is bounded when a process outside the group holds the pipes", async (t) => {
	const pidFile = join(TEST_HOME, "escaped.pid");
	t.after(() => killGroup(pidFile));
	const warnings = [];
	const onWarning = (w) => warnings.push(w.message);
	process.on("warning", onWarning);
	t.after(() => process.off("warning", onWarning));
	const { tools } = delegateTool(t, { FAKE_PI_MODE: "escaped-pipes", FAKE_PI_PIDFILE: pidFile });
	const started = Date.now();
	const res = await run(tools, { task: "x", role: "scout", timeoutSecs: 20 });
	assert.ok(Date.now() - started < 6000);
	assert.equal(res.isError, true);
	assert.match(text(res), /output pipes remained open 3s after it exited: a process outside its group holds them/);
	await new Promise((r) => setImmediate(r));
	assert.ok(
		warnings.some((m) => /output pipes remained open/.test(m)),
		"process warning emitted",
	);
});

test("signal failures are reported, not swallowed", async (t) => {
	const { tools } = delegateTool(t, { FAKE_PI_SLEEP_MS: "3000" });
	const realKill = process.kill;
	process.kill = (pid, sig) => {
		if (pid < 0 && sig === "SIGTERM") throw Object.assign(new Error("not permitted"), { code: "EPERM" });
		return realKill.call(process, pid, sig);
	};
	t.after(() => {
		process.kill = realKill;
	});
	const res = await run(tools, { task: "x", role: "scout", timeoutSecs: 1 });
	assert.equal(res.isError, true);
	assert.match(text(res), /SIGTERM to worker group \d+ failed: not permitted/);
});

test("prompts are sent behind a fixed header; bad cwd and oversized prompts fail before spawn", async (t) => {
	const marker = join(TEST_HOME, "prespawn-marker");
	const { tools } = delegateTool(t, { FAKE_PI_MARKER: marker });
	const dash = await run(tools, { task: "--help @file", role: "scout" });
	assert.match(text(dash), /prompt="Task:\\n--help @file"/);
	const before = markerLines(marker).length;
	const badCwd = await run(tools, { task: "x", role: "scout", cwd: join(TEST_HOME, "missing") });
	assert.match(text(badCwd), /cwd is not a directory/);
	const big = await run(tools, { task: "x".repeat(121 * 1024), role: "scout" });
	assert.match(text(big), /prompt is \d+ bytes \(max 122880\); put large context in a file/);
	assert.equal(markerLines(marker).length, before, "neither spawned");
});

test("spawn failure reports that the worker never started", async (t) => {
	const { tools } = delegateTool(t, { PI_BIN: join(TEST_HOME, "no-such-pi") });
	const res = await run(tools, { task: "x", role: "scout" });
	assert.equal(res.isError, true);
	assert.match(text(res), /could not start worker: .*ENOENT/);
});

test("normal main-process exit SIGKILLs live worker groups", async () => {
	const pidFile = join(TEST_HOME, "parent-exit.pid");
	const script = join(TEST_HOME, "parent-exit.mjs");
	writeFileSync(
		script,
		`
import register from ${JSON.stringify(new URL("./delegate.ts", import.meta.url).href)};
import { existsSync } from "node:fs";
let delegate;
register({ registerTool: (d) => { delegate = d; }, on: () => {} });
void delegate.execute("p", { task: "hold", role: "scout", timeoutSecs: 60 }, undefined, undefined, { cwd: ${JSON.stringify(REPO_ROOT)} });
const deadline = Date.now() + 10000;
while (!existsSync(${JSON.stringify(pidFile)}) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
process.exit(existsSync(${JSON.stringify(pidFile)}) ? 0 : 2);
`,
	);
	const env = { ...process.env, PI_BIN: FAKE_BIN, FAKE_PI_MODE: "hang", FAKE_PI_PIDFILE: pidFile };
	delete env.ME_PI_RUN;
	const child = spawn(process.execPath, [script], { env, stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (c) => {
		stderr += c;
	});
	const code = await new Promise((r) => child.once("close", r));
	assert.equal(code, 0, stderr);
	assert.ok(await waitDead(Number(readFileSync(pidFile, "utf8"))), "exit handler killed the worker");
});

test("guidelines describe read-only workers, reviews, multi-model rebuttal, and BLOCKED lines", () => {
	const all = PROMPT_GUIDELINES.join("\n");
	assert.match(all, /Workers are read-only/);
	assert.match(all, /do not edit those files until the review returns/);
	assert.match(all, /rebuttal: true/);
	assert.match(all, /BLOCKED/);
});
