// Shared fake-pi harness and setup helpers for the delegate test files.
// Each test file imports this in its own process, so TEST_HOME, FAKE_BIN and env snapshots are per file.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

// Scratch space for the fake pi binary, configs, and pid files.
const TEST_HOME = mkdtempSync(join(tmpdir(), "delegate-test-"));

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
process.on("exit", () => rmSync(TEST_HOME, { recursive: true, force: true }));

const {
	default: registerExtension,
	LIMITS,
	PROMPT_GUIDELINES,
	PROMPT_SNIPPET,
} = await import("../../packages/pi-workers/extensions/delegate.ts");

const { classifyProviderError } = await import("../../packages/pi-workers/extensions/delegate-attempt.ts");

const {
	ROLES,
	workerContract,
	LOCAL_TOOLS,
	WEB_TOOLS,
} = await import("../../packages/pi-workers/extensions/delegate-worker.ts");

const {
	secretPathIn,
	writeBlockedIn,
} = await import("../../packages/pi-workers/extensions/delegate-fence.ts");

const {
	loadModelSet,
	resolveRun,
} = await import("../../packages/pi-workers/extensions/delegate-config.ts");

const { default: registerGuard } = await import("../../packages/pi-workers/extensions/guard.ts");

const { TOOL_PROVENANCE_DETAIL_KEY } = await import("../../packages/pi-workers/extensions/delegate-provenance.ts");

const { progressLines } = await import("../../packages/pi-workers/extensions/delegate-render.ts");

const { registerDelegateCommand } = await import("../../packages/pi-workers/extensions/delegate-command.ts");

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

const COPILOT = "github-copilot/claude-sonnet-5-5";

// A v3 pool giving every model the same thinking level.
const pool = (models: string[], thinking: string) => ({
	models: models.map((model) => ({ model, thinking })),
	thinking,
});
// Scouts get every model at low; workers start with `workerFirst` (default: the last model) at max.
const modelSet = (models: string[], workerFirst = models.at(-1)) => ({
	version: 3,
	scout: pool(models, "low"),
	worker: pool([workerFirst, ...models.filter((m) => m !== workerFirst)], "max"),
});

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

const ONE_OFF = "google/gemini-test";

const UNAUTHENTICATED = "unauthed/model";

const REGISTRY_MODELS = [HAIKU, SONNET, OPUS, LUNA, ONE_OFF, COPILOT];

function registryFixture({
	catalog = REGISTRY_MODELS,
	available = catalog,
	authenticated,
	oauthProviders = [],
	registeredProviders = [],
} = {}) {
	const model = (id) => {
		const slash = id.indexOf("/");
		return slash > 0
			? {
					provider: id.slice(0, slash),
					id: id.slice(slash + 1),
					name: id.slice(slash + 1),
					api: ["anthropic", "github-copilot"].includes(id.slice(0, slash))
						? "anthropic-messages"
						: "openai-responses",
					baseUrl: `https://${id.slice(0, slash)}.example/v1`,
				}
			: undefined;
	};
	const models = catalog.map(model).filter(Boolean);
	const availableModels = available.map(model).filter(Boolean);
	const authProviders = new Set(authenticated ?? availableModels.map((m) => m.provider));
	return {
		getAll: () => models,
		getAvailable: () => availableModels,
		hasConfiguredAuth: (candidate) => authProviders.has(candidate.provider),
		isUsingOAuth: (candidate) => oauthProviders.includes(candidate.provider),
		getRegisteredProviderIds: () => registeredProviders,
	};
}

// Fake pi: reads the prompt from stdin, echoes how it was invoked; FAKE_PI_MODE drives failures.
const FAKE_BIN = join(TEST_HOME, "fake-pi.mjs");
writeFileSync(
	FAKE_BIN,
	`#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const mode = process.env.FAKE_PI_MODE || "";
const usage = (cost) => ({ input: 10, output: 5, totalTokens: 15, cost: { input: cost / 2, output: cost / 2, total: cost } });
const emit = (text, { cost = 0.002, stopReason = "stop", errorMessage } = {}) => {
  const selectedModel = flag("--model") || "anthropic/session-default";
  const slash = selectedModel.indexOf("/");
  console.log(JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      provider: slash > 0 ? selectedModel.slice(0, slash) : "",
      model: slash > 0 ? selectedModel.slice(slash + 1) : selectedModel,
      api: "fake-api",
      usage: usage(cost),
      stopReason,
      errorMessage,
      content: [{ type: "text", text }],
    },
  }));
};
const retryable = (errorMessage) => {
  emit("", { stopReason: "error", errorMessage });
  console.log(JSON.stringify({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage }));
};
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { prompt += c; });
process.stdin.on("end", () => {
  if (process.env.FAKE_PI_MARKER) appendFileSync(process.env.FAKE_PI_MARKER, JSON.stringify({ model: flag("--model"), thinking: flag("--thinking"), skills: process.env.ME_PI_SKILLS, prompt }) + "\\n");
  if (process.env.FAKE_PI_PIDFILE) writeFileSync(process.env.FAKE_PI_PIDFILE, String(process.pid));
  if (mode === "rebuttal-rate-limit-model" && prompt.includes("## Round 2 (rebuttal)") && flag("--model") === process.env.FAKE_PI_FAIL_MODEL) {
    retryable("429 rate_limit_error: rebuttal unavailable");
    process.exit(1);
  }
  if (mode === "rate-limit-model" && flag("--model") === process.env.FAKE_PI_FAIL_MODEL) {
    retryable("429 rate_limit_error: too many requests");
    process.exit(1);
  }
  if (mode === "rate-limit-models" && process.env.FAKE_PI_FAIL_MODELS?.split(",").includes(flag("--model"))) {
    retryable("429 rate_limit_error: too many requests");
    process.exit(1);
  }
  if (mode === "rate-limit-delayed" && flag("--model") === process.env.FAKE_PI_FAIL_MODEL) {
    setTimeout(() => { retryable("429 rate_limit_error: too many requests"); process.exit(1); }, Number(process.env.FAKE_PI_RETRY_DELAY || 0));
    return;
  }
  if (mode === "read-then-retry" && flag("--model") === process.env.FAKE_PI_FAIL_MODEL) {
    const toolCallId = "safe-read";
    console.log(JSON.stringify({ type: "tool_execution_start", toolCallId, toolName: "read", args: { path: "README.md" } }));
    console.log(JSON.stringify({ type: "tool_execution_end", toolCallId, toolName: "read", isError: false, result: { content: [{ type: "text", text: "read completed" }] } }));
    retryable("temporary provider failure");
    process.exit(1);
  }
  if (mode === "quota-model" && flag("--model") === process.env.FAKE_PI_FAIL_MODEL) {
    emit("", { stopReason: "error", errorMessage: process.env.FAKE_PI_ERROR });
    process.exit(1);
  }
  if (mode === "malformed-retry" && flag("--model") === process.env.FAKE_PI_FAIL_MODEL) {
    emit("", { stopReason: "error", errorMessage: "temporary provider failure" });
    console.log(JSON.stringify({ type: "auto_retry_start", attempt: 0, maxAttempts: 3 }));
    process.exit(1);
  }
  if (mode === "shell-429" && flag("--model") === process.env.FAKE_PI_FAIL_MODEL) {
    const toolCallId = "shell-429";
    console.log(JSON.stringify({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command: "echo 429 rate_limit_error" } }));
    console.log(JSON.stringify({ type: "tool_execution_end", toolCallId, toolName: "bash", isError: true, result: { content: [{ type: "text", text: "429 rate_limit_error: too many requests" }] } }));
    emit("", { stopReason: "error", errorMessage: "429 rate_limit_error: too many requests" });
    process.exit(1);
  }
  if (mode === "partial-result-then-retry" && flag("--model") === process.env.FAKE_PI_FAIL_MODEL) {
    const toolCallId = "partial-result";
    const args = { command: "printf before-failure" };
    console.log(JSON.stringify({ type: "tool_execution_start", toolCallId, toolName: "bash", args }));
    console.log(JSON.stringify({
      type: "tool_execution_update", toolCallId, toolName: "bash", args,
      partialResult: { content: [{ type: "text", text: "partial output" }], details: {} },
    }));
    console.log(JSON.stringify({
      type: "tool_execution_end", toolCallId, toolName: "bash", isError: true,
      result: { content: [{ type: "text", text: "tool failed after partial output" }], details: {} },
    }));
    retryable("temporary provider failure");
    process.exit(1);
  }
  if (mode === "tool-then-retry" && flag("--model") === process.env.FAKE_PI_FAIL_MODEL) {
    const toolCallId = "prior-effect";
    console.log(JSON.stringify({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command: "printf prior-effect" } }));
    console.log(JSON.stringify({ type: "tool_execution_end", toolCallId, toolName: "bash", isError: false, result: { content: [{ type: "text", text: "prior effect completed" }], structuredContent: { exit_code: 0 } } }));
    retryable("temporary provider failure");
    process.exit(1);
  }
  if (mode === "start-then-retry" && flag("--model") === process.env.FAKE_PI_FAIL_MODEL) {
    console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "unfinished", toolName: "bash", args: { command: "printf maybe-effect" } }));
    retryable("temporary provider failure");
    process.exit(1);
  }
  if (mode === "blocked-owner-event" || mode === "blocked-owner-hang") {
    const toolCallId = "blocked-call";
    const fact = { owner: "guard", jobId: process.env.ME_PI_DELEGATE_JOB_ID, attempt: Number(process.env.ME_PI_DELEGATE_ATTEMPT), toolCallId, cause: "guard-denial", resource: "guard", effect: "denied" };
    console.log(JSON.stringify({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command: "git push origin main" } }));
    console.log(JSON.stringify({ type: "tool_execution_end", toolCallId, toolName: "bash", isError: true, result: { content: [{ type: "text", text: "Blocked by guard" }], details: { __mePiDelegateProvenance: [fact] } } }));
    if (mode === "blocked-owner-hang") {
      emit("still working", { stopReason: "toolUse" });
      setInterval(() => {}, 1000);
      return;
    }
    emit("", { stopReason: "error", errorMessage: "Blocked by guard" });
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
  if (mode === "error-long") { emit("Findings first\\n" + "z".repeat(4000) + "\\nBLOCKED: tests: no bash\\n" + "w".repeat(3000) + "\\nUnverified: all", { stopReason: "error", errorMessage: "provider error" }); process.exit(0); }
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
    emit("wrote notes/draft.md tools=" + flag("--tools") + " promptNamesDir=" + (sp.includes("only to absolute paths inside " + out + " (relative paths resolve against the project)")));
    process.exit(0);
  }
  // A successful tool call as Pi's JSON mode reports it: start, then end.
  let toolId = 0;
  const tool = (toolName, args) => {
    const toolCallId = "t" + ++toolId;
    console.log(JSON.stringify({ type: "tool_execution_start", toolCallId, toolName, args }));
    const result = toolName === "bash" ? { structuredContent: { exit_code: 0 } } : {};
    console.log(JSON.stringify({ type: "tool_execution_end", toolCallId, toolName, result, isError: false }));
  };
  if (mode === "infra-flaky") {
    // Fails the first FAKE_PI_INFRA_FAILS runs with FAKE_PI_ERROR, counting runs in FAKE_PI_COUNTER.
    const runs = (existsSync(process.env.FAKE_PI_COUNTER) ? Number(readFileSync(process.env.FAKE_PI_COUNTER, "utf8")) : 0) + 1;
    writeFileSync(process.env.FAKE_PI_COUNTER, String(runs));
    if (runs <= Number(process.env.FAKE_PI_INFRA_FAILS)) {
      tool("read", { path: "README.md" });
      if (process.env.FAKE_PI_INFRA_EFFECT) tool("bash", { command: "printf effect > effect.txt" });
      emit("", { stopReason: "error", errorMessage: process.env.FAKE_PI_ERROR });
      process.exit(1);
    }
    emit("Answered after run " + runs + ".");
    process.exit(0);
  }
  if (mode === "echo-budget") { emit(process.env.ME_PI_BUDGET || "none"); process.exit(0); }
  if (mode === "echo-system") { emit(flag("--append-system-prompt") || ""); process.exit(0); }
  if (mode === "silent") process.exit(0);
  if (mode === "ended-midway") { emit("reading more files", { stopReason: "toolUse" }); process.exit(0); }
  if (mode === "crash") { process.stderr.write("boom: last stderr line\\n"); process.exit(3); }
  // retry-then-hang needs FAKE_PI_MARKER: the launch appended above makes one line on the first launch.
  if (mode === "retry-then-hang" && readFileSync(process.env.FAKE_PI_MARKER, "utf8").trim().split("\\n").length === 1) {
    setTimeout(() => { retryable("429 rate_limit_error: too many requests"); process.exit(1); }, Number(process.env.FAKE_PI_RETRY_DELAY || 0));
    return;
  }
  // retry-then-* modes need FAKE_PI_MARKER; the first launch costs $0.002 (retryable's reply) before it exits.
  const retryModes = ["retry-then-expensive", "retry-then-echo-budget"];
  if (retryModes.includes(mode) && readFileSync(process.env.FAKE_PI_MARKER, "utf8").trim().split("\\n").length === 1) {
    retryable("429 rate_limit_error: too many requests");
    process.exit(1);
  }
  if (mode === "retry-then-echo-budget") { emit(process.env.ME_PI_BUDGET || "none"); process.exit(0); }
  if (mode === "hang" || mode === "retry-then-hang") { emit("working", { stopReason: "toolUse" }); setInterval(() => {}, 1000); return; }
  if (mode === "tool-activity") {
    const selected = (flag("--model") || "").includes("haiku") ? "read" : "grep";
    const activity = Array.from({ length: 12 }, (_, i) => JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "activity-" + i,
      toolName: i === 10 ? "PRIVATE_REASONING" : i === 11 ? "\\u001b" + selected + "\\n" : selected,
      args: { path: "PRIVATE_ARGUMENT", command: "PRIVATE_COMMAND", output: "PRIVATE_OUTPUT", reasoning: "PRIVATE_REASONING" },
    }));
    process.stdout.write(activity.join("\\n") + "\\n");
    process.stderr.write("PRIVATE_STDERR\\n");
    setTimeout(() => { emit("activity answer"); process.exit(0); }, Number(process.env.FAKE_PI_ACTIVITY_DELAY || 250));
    return;
  }
  if (mode === "expensive" || mode === "retry-then-expensive") {
    console.log(JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "src/a.ts" } }));
    emit("still going", { cost: Number(process.env.FAKE_PI_COST || 9), stopReason: "toolUse" });
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "final-over-cap") { emit("complete answer", { cost: 9 }); process.exit(0); }
  if (mode === "long") { emit("y".repeat(30 * 1024)); process.exit(0); }
  if (mode === "many-blocked") { emit("Findings first\\n" + "z".repeat(4000) + "\\n- BLOCKED: a: x\\nBLOCKED: b: x\\nBLOCKED: c: x\\nBLOCKED: d: x\\nBLOCKED: e: x\\n" + "w".repeat(3000) + "\\nAssumptions: none"); process.exit(0); }
  if (mode === "long-blocked") { emit("Findings first\\n" + "z".repeat(4000) + "\\nBLOCKED: run tests: no bash\\n" + "w".repeat(3000) + "\\nAssumptions: none; unverified: all"); process.exit(0); }
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
    "skills=" + (process.env.ME_PI_SKILLS || "all"),
  ].join(" "));
});
`,
	{ mode: 0o755 },
);

const CTX = {
	cwd: REPO_ROOT,
	model: { provider: "anthropic", id: "claude-session" },
	thinkingLevel: "high",
	modelRegistry: registryFixture(),
};

const text = (res) => res.content.map((c) => c.text).join("\n");

function applyEnv(vars) {
	for (const [k, v] of Object.entries(vars)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

// Multiple setups in one test share one original environment snapshot.
const setupEnvironments = new WeakMap();

// Sets env vars and limits for one test and restores them afterwards.
function setup(t, { env = {}, config, limits = {}, keepHistory = false, withGuard = false } = {}) {
	const vars = {
		PI_BIN: FAKE_BIN,
		ME_PI_RUN: undefined,
		ME_PI_OUTPUT_DIR: undefined,
		ME_PI_BUDGET: undefined,
		ME_PI_SKILLS: undefined,
		ME_PI_DELEGATE_JOB_ID: undefined,
		ME_PI_DELEGATE_ATTEMPT: undefined,
		// The coordinator's opt-in status (an eval-style session sets them): off unless a test asks.
		ME_PI_STATUS_LOG: undefined,
		ME_PI_SPEND_BUDGET_USD: undefined,
		TMPDIR: TEST_HOME,
		...env,
	};
	if (config !== undefined) {
		const path = join(mkdtempSync(join(TEST_HOME, "cfg-")), "delegate.json");
		writeFileSync(path, typeof config === "string" ? config : JSON.stringify(config));
		vars.ME_PI_DELEGATE_CONFIG = path;
	} else vars.ME_PI_DELEGATE_CONFIG = join(TEST_HOME, "missing.json");
	let saved = setupEnvironments.get(t);
	if (!saved) {
		saved = {};
		setupEnvironments.set(t, saved);
		t.after(() => {
			applyEnv(saved);
			Object.assign(LIMITS, DEFAULT_LIMITS);
			setupEnvironments.delete(t);
		});
	}
	for (const k of Object.keys(vars)) {
		if (!Object.hasOwn(saved, k)) saved[k] = process.env[k];
	}
	applyEnv(vars);
	// Same-model infra retries are off unless a test asks for them: other tests classify the first attempt.
	Object.assign(LIMITS, { infraRetryDelaysMs: [] }, limits);
	const tools = {};
	const handlers = {};
	const registeredHandlers = new Map();
	const eventHandlers = new Map();
	const events = {
		on: (name, handler) => {
			const listeners = eventHandlers.get(name) ?? [];
			listeners.push(handler);
			eventHandlers.set(name, listeners);
		},
		emit: (name, value) => {
			for (const handler of eventHandlers.get(name) ?? []) handler(value);
		},
	};
	const commands = {};
	const messages = [];
	const pi = {
		events,
		sendMessage: (message, options) => messages.push({ message, options }),
		registerTool: (d) => {
			tools[d.name] = d;
		},
		registerCommand: (name, options) => {
			commands[name] = options;
		},
		getAllTools: () => Object.values(tools).map((d) => ({ name: d.name })),
		on: (event, h) => {
			const listeners = registeredHandlers.get(event) ?? [];
			listeners.push(h);
			registeredHandlers.set(event, listeners);
			handlers[event] = async (...args) => {
				let result: any;
				for (const listener of listeners) {
					const next = await listener(...args);
					if (next !== undefined) result = next;
					if (event === "tool_call" && next?.block) break;
				}
				return result;
			};
		},
	};
	// The call history survives reloads on globalThis; each test starts empty unless it simulates a reload.
	if (!keepHistory) {
		globalThis[Symbol.for("me-pi.delegate.history")] = [];
		globalThis[Symbol.for("me-pi.delegate.job-count")] = 0;
	}
	registerExtension(pi);
	if (withGuard) registerGuard(pi);
	return { tool: tools.delegate, handlers, commands, pi, events, messages };
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

function commandCtx({ available = [HAIKU, SONNET, OPUS], catalog = available } = {}) {
	const notes = [];
	const ctx = {
		hasUI: true,
		modelRegistry: registryFixture({ catalog, available }),
		ui: { notify: (message, type) => notes.push([message, type]) },
	};
	return { ctx, notes };
}

function statusFor(active) {
	const commands = {};
	registerDelegateCommand(
		{
			registerCommand: (name, options) => {
				commands[name] = options;
			},
			getAllTools: () => [],
		},
		{
			configPath: () => "/delegate.json",
			loadModelSet: () => POOL_SET,
			history: [],
			active,
			cancel: (id) => `cancel ${id}`,
		},
	);
	return async () => {
		const { ctx, notes } = commandCtx();
		await commands.delegate.handler("status", ctx);
		return notes[0][0];
	};
}

const POLICY = [
	"## Output",
	"- lead with the result",
	"## Recovery (coordinator only)",
	"- coordinator ledger",
	"",
	"## Approval (coordinator only)",
	"- protected actions",
	"## Secrets",
	"- never read keys",
].join("\n");

// A tool context that records status-line writes (delegate sets none).
const bgCtx = () => {
	const statuses = [];
	return { ctx: { ...CTX, ui: { setStatus: (key, value) => statuses.push([key, value]) } }, statuses };
};

function tuiCtx() {
	const updates = [];
	const requests = [];
	const snapshots = [];
	let component: any;
	const tui = {
		requestRender: () => {
			requests.push(Date.now());
			snapshots.push(component?.render(240) ?? []);
		},
	};
	const ui = {
		setStatus: () => {},
		setWidget: (key, content) => {
			updates.push([key, content]);
			component =
				content === undefined
					? undefined
					: typeof content === "function"
						? content(tui, { fg: (_color, value) => value })
						: { render: () => content };
		},
	};
	return {
		ctx: { ...CTX, mode: "tui", ui },
		updates,
		requests,
		snapshots,
		widget: (width = 240) => component?.render(width) ?? [],
	};
}

function trackIntervals(t) {
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	const active = new Map();
	active.started = [];
	active.cleared = [];
	let nextId = 0;
	globalThis.setInterval = (callback, delay) => {
		const handle = { id: ++nextId, callback, delay, unref() {} };
		active.set(handle, delay);
		active.started.push(handle);
		return handle;
	};
	globalThis.clearInterval = (handle) => {
		if (active.delete(handle)) active.cleared.push(handle);
	};
	t.after(() => {
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	});
	return active;
}

export { TEST_HOME, REPO_ROOT, registerExtension, classifyProviderError, LIMITS, LOCAL_TOOLS, WEB_TOOLS, PROMPT_GUIDELINES, PROMPT_SNIPPET, ROLES, workerContract, loadModelSet, resolveRun, secretPathIn, writeBlockedIn, registerGuard, TOOL_PROVENANCE_DETAIL_KEY, progressLines, registerDelegateCommand, DEFAULT_LIMITS, HAIKU, SONNET, OPUS, LUNA, COPILOT, POOL_SET, pool, modelSet, ONE_OFF, UNAUTHENTICATED, REGISTRY_MODELS, registryFixture, FAKE_BIN, CTX, text, applyEnv, setupEnvironments, setup, run, isAlive, waitFor, waitDead, scratch, commandCtx, statusFor, POLICY, bgCtx, tuiCtx, trackIntervals };
