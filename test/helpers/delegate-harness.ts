// Shared fake-pi harness and setup helpers for the delegate test files.
// Each test file imports this in its own process, so TEST_HOME, FAKE_BIN and env snapshots are per file.
import { execFileSync, spawn } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createBashTool } from "@earendil-works/pi-coding-agent";

// Scratch space for the fake pi binary, configs, and pid files.
const TEST_HOME = mkdtempSync(join(tmpdir(), "delegate-test-"));

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
process.on("exit", () => rmSync(TEST_HOME, { recursive: true, force: true }));

const {
	default: registerExtension,
	classifyProviderError,
	LIMITS,
	LOCAL_TOOLS,
	WEB_TOOLS,
	IMPLEMENT_TOOLS,
	PROMPT_GUIDELINES,
	PROMPT_SNIPPET,
} = await import("../../extensions/delegate.ts");

const {
	ROLES,
	WORKER_CONTRACT,
} = await import("../../extensions/delegate-worker.ts");

const {
	secretPathIn,
	writeBlockedIn,
} = await import("../../extensions/delegate-fence.ts");

const {
	loadModelSet,
	resolveRun,
} = await import("../../extensions/delegate-config.ts");

const { default: registerGuard } = await import("../../extensions/guard.ts");

const { TOOL_PROVENANCE_DETAIL_KEY } = await import("../../extensions/delegate-provenance.ts");

const { progressLines } = await import("../../extensions/delegate-render.ts");

const { registerDelegateCommand } = await import("../../extensions/delegate-command.ts");

const { snapshotContent, trackCheck } = await import("../../extensions/delegate-implement.ts");

const DEFAULT_LIMITS = { ...LIMITS };

// A failing lifecycle test can leave a worker running, which would keep this process alive.
after(() => {
	for (const pid of globalThis[Symbol.for("me-pi.delegate.groups")] ?? []) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
	}
});
// Every implement job in this file, however it ended, removed its gh config dir (TEST_HOME and alternate TMPDIRs).
after(() => {
	const roots = [
		TEST_HOME,
		join(TEST_HOME, "missing-tmp"),
		...readdirSync(TEST_HOME)
			.filter((n) => n.startsWith("not-a-dir-"))
			.map((n) => join(TEST_HOME, n)),
	].filter((dir) => existsSync(dir) && statSync(dir).isDirectory());
	assert.deepEqual(
		roots.flatMap((dir) => readdirSync(dir).filter((n) => n.startsWith("me-pi-delegate-gh-"))),
		[],
	);
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
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
async function runAgentLoopFixture() {
  const importFromRepo = (path) => import(pathToFileURL(join(process.env.ME_PI_TEST_ROOT, path)).href);
  const [{ runAgentLoop }, { createBashTool }, { createAssistantMessageEventStream }] = await Promise.all([
    importFromRepo("node_modules/@earendil-works/pi-agent-core/dist/index.js"),
    importFromRepo("node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
    importFromRepo("node_modules/@earendil-works/pi-ai/dist/index.js"),
  ]);
  const commands = JSON.parse(process.env.FAKE_PI_AGENT_COMMANDS || "[]");
  const hook = process.env.FAKE_PI_AGENT_HOOK || "";
  const hookAt = Number(process.env.FAKE_PI_AGENT_HOOK_AT || 1);
  let request = 0;
  const bash = createBashTool(process.cwd(), { exposeSessionEnvironment: false });
  const model = {
    provider: "fixture", id: "fixture", name: "fixture", api: "openai-responses", baseUrl: "http://fixture.invalid",
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false, contextWindow: 8192, maxTokens: 1024,
  };
  const streamFn = () => {
    const step = commands[request++];
    const message = {
      role: "assistant",
      content: step ? [{ type: "toolCall", id: "fixture-" + request, name: "bash", arguments: step }] : [{ type: "text", text: "Finished the local task." }],
      api: "openai-responses", provider: "fixture", model: "fixture",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: step ? "toolUse" : "stop", timestamp: Date.now(),
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: message.stopReason, message });
    stream.end(message);
    return stream;
  };
  const config = {
    model, convertToLlm: (messages) => messages, toolExecution: "sequential",
    afterToolCall: ({ toolCall, result }) => {
      if (request !== hookAt || !hook) return undefined;
      if (hook === "drop-structured") return { content: result.content };
      if (hook === "contradict-success") return { isError: false };
      if (hook === "contradict-error") return { isError: true };
      if (hook === "preserve-status") return { details: { hook: "preserved" } };
      return undefined;
    },
  };
  await runAgentLoop(
    [{ role: "user", content: "Run this hermetic implementation fixture.", timestamp: Date.now() }],
    { messages: [], tools: [bash] },
    config,
    (event) => process.stdout.write(JSON.stringify(event) + "\\n"),
    undefined,
    streamFn,
  );
}
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { prompt += c; });
process.stdin.on("end", () => {
  if (process.env.FAKE_PI_MARKER) appendFileSync(process.env.FAKE_PI_MARKER, JSON.stringify({ model: flag("--model"), thinking: flag("--thinking"), approve: args.includes("--approve"), prompt }) + "\\n");
  if (process.env.FAKE_PI_PIDFILE) writeFileSync(process.env.FAKE_PI_PIDFILE, String(process.pid));
  if (mode === "implement-agent-loop") {
    runAgentLoopFixture().catch((error) => { console.error(error); process.exitCode = 1; });
    return;
  }
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
  const tool = (toolName, args, isError = false, options = {}) => {
    if (process.env.FAKE_PI_EVENT_MARKER) appendFileSync(process.env.FAKE_PI_EVENT_MARKER, toolName + "\\n");
    const toolCallId = options.missingId ? undefined : (options.toolCallId || "t" + ++toolId);
    if (!options.omitStart) console.log(JSON.stringify({ type: "tool_execution_start", toolCallId, toolName, args }));
    if (!options.omitEnd) console.log(JSON.stringify({
      type: "tool_execution_end", toolCallId, toolName: options.endToolName || toolName,
      result: options.result !== undefined ? options.result : !isError && toolName === "bash" ? { structuredContent: { exit_code: 0 } } : {}, isError,
      ...(options.effectiveCommand !== undefined ? { effectiveCommand: options.effectiveCommand } : {}),
    }));
  };
  const runBash = (command) => {
    const toolCallId = "t" + ++toolId;
    console.log(JSON.stringify({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command } }));
    const executed = spawnSync("bash", ["-c", command], { encoding: "utf8" });
    const exitCode = executed.status ?? 1;
    console.log(JSON.stringify({
      type: "tool_execution_end", toolCallId, toolName: "bash", isError: exitCode !== 0,
      result: { structuredContent: { exit_code: exitCode, output: (executed.stdout || "") + (executed.stderr || "") } },
    }));
    return exitCode;
  };
  if (mode === "implement-content-check") {
    const scenario = process.env.FAKE_PI_CONTENT_SCENARIO;
    const check = process.env.FAKE_PI_RAN || "npm test";
    if (scenario === "binary-collision") {
      runBash("printf 'x' > a; printf 'y' > b; git add -A; git commit -m 'feat: baseline collision tree'");
      writeFileSync("feature.txt", "fixed\\n");
      runBash(check);
      runBash("printf 'x\\\\0b\\\\0file\\\\0\\\\060\\\\0y' > a; rm b; false");
      runBash("git add -A");
      runBash("git commit -m 'feat: binary collision'");
    } else {
      runBash("printf 'fixed\\n' > feature.txt");
      runBash(check);
      if (scenario !== "unchanged") {
        runBash("printf 'mutated\\n' > feature.txt; false");
        runBash("git add feature.txt");
        runBash("git commit -m 'feat: mutated content'");
        if (scenario === "rerun") runBash(check);
      } else {
        runBash("git add feature.txt");
        runBash("git commit -m 'feat: checked content'");
      }
    }
    emit("Checked and committed content.");
    process.exit(0);
  }
  if (mode === "implement-review-regression") {
    const scenario = process.env.FAKE_PI_REVIEW_SCENARIO;
    if (scenario === "reuse") {
      tool("read", { path: "a" }, false, { toolCallId: "reused" });
      tool("read", { path: "b" }, false, { toolCallId: "reused" });
    } else if (["conflict", "invalid-alias", "invalid-secret", "success-conflict", "provider"].includes(scenario)) {
      tool("bash", { command: "exit 7" }, scenario !== "success-conflict", { result: { structuredContent: { exit_code: 7 }, ...(["conflict", "success-conflict"].includes(scenario) ? { details: { exitCode: 143 } } : scenario === "invalid-alias" ? { details: { exitCode: "143" } } : scenario === "invalid-secret" ? { details: { exitCode: "TOKEN=synthetic-secret" } } : {}) } });
      if (scenario === "provider") retryable("temporary provider failure");
    } else if (scenario === "success-overflow") {
      for (let i = 0; i < 21; i++) tool("bash", { command: "fixture" }, false, { result: { structuredContent: { exit_code: 0 }, details: { exitCode: "TOKEN=synthetic-secret" } } });
    } else if (scenario === "success-multi") {
      tool("bash", { command: "exit 7" }, false, { toolCallId: "call-seven", result: { structuredContent: { exit_code: 7 } } });
      tool("bash", { command: "exit 8" }, false, { toolCallId: "call-eight", result: { structuredContent: { exit_code: 8 } } });
      tool("bash", { command: "exit 9" }, false, { toolCallId: "call-" + "x".repeat(300), result: { structuredContent: { exit_code: 9 } } });
    } else if (scenario === "success-crash") {
      tool("bash", { command: "exit 7" }, false, { toolCallId: "call-crash", result: { structuredContent: { exit_code: 7 }, details: { exitCode: 143 } } });
      process.stderr.write("boom: last stderr line\\n");
      process.exit(3);
    } else if (scenario === "duplicate-end") {
      tool("bash", { command: "printf completed" }, false, { toolCallId: "call-completed", result: { structuredContent: { exit_code: 0 } } });
      tool("bash", { command: "printf duplicate" }, true, { toolCallId: "call-completed", omitStart: true });
      tool("read", { path: "unique" }, false, { toolCallId: "call-unique" });
    }
    writeFileSync("feature.txt", "fixed\\n");
    git("add", "feature.txt");
    git("commit", "-q", "-m", "feat: fixture");
    const status = scenario === "check-missing" ? {} : scenario === "check-invalid" ? { exit_code: "0" } : { exit_code: 0 };
    tool("bash", { command: "npm test" }, false, { result: { structuredContent: status, ...(["check-conflict", "check-success-conflict"].includes(scenario) ? { details: { exitCode: 143 } } : scenario === "check-match" ? { details: { exitCode: 0 } } : {}) } });
    emit("Finished fixture.");
    process.exit(0);
  }
  if (mode === "implement-artifacts" || mode === "implement-check-artifact-fail" || mode === "implement-read-artifact-fail") {
    const target = "export GITHUB_TOKEN='command-fake-secret' AWS_SECRET_ACCESS_KEY='command-aws-secret' npm run targeted-test";
    if (mode === "implement-artifacts") {
      tool("bash", { command: target }, true, { effectiveCommand: "GITHUB_TOKEN=effective-fake-secret AWS_SECRET_ACCESS_KEY='effective-aws-secret' rtk npm run targeted-test", result: {
        content: [{ type: "text", text: "Targeted failed: GITHUB_TOKEN=target-secret AWS_SECRET_ACCESS_KEY='target-aws-secret'" }],
        error: "AWS_SECRET_ACCESS_KEY='error-fake-secret'",
        structuredContent: { output: "Targeted failed: GITHUB_TOKEN=target-secret AWS_SECRET_ACCESS_KEY='target-aws-secret'", full_output_path: process.env.FAKE_PI_REF },
        details: { exitCode: 7, fullOutputPath: process.env.FAKE_PI_REF },
      } });
      tool("bash", { command: process.env.FAKE_PI_RAN || "npm test" }, false, { result: {
        content: [{ type: "text", text: "declared check passed" }],
        structuredContent: { output: "declared check passed", exit_code: 0 },
      } });
      tool("read", { path: "success-only-argument" }, false, { result: { content: [{ type: "text", text: "success-only-result" }] } });
    } else if (mode === "implement-check-artifact-fail") {
      tool("bash", { command: process.env.FAKE_PI_RAN || "npm test" }, true, { result: {
        content: [{ type: "text", text: "declared check failed" }],
        structuredContent: { output: "declared check failed", exit_code: 1 },
      } });
    } else {
      tool("read", { path: "do-not-capture-input" }, true, { result: {
        content: [{ type: "text", text: "read result failed" }],
        structuredContent: { code: "ENOENT", message: "missing fixture" },
      } });
    }
    if (process.env.FAKE_PI_BLOCK_ARTIFACT) {
      const id = readFileSync(".git/me-pi-implement.lock", "utf8").trim().split(" ")[1];
      const directory = join(process.env.TMPDIR, "me-pi-delegate-" + process.ppid);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, id + "-failed-tools.json"), "do not overwrite");
    }
    emit("Implemented GITHUB_TOKEN=answer-fake-secret.");
    process.exit(0);
  }
  if (mode === "implement-fallback-artifacts") {
    if ((flag("--model") || "").includes("luna")) {
      tool("bash", { command: "npm test" }, true, { result: { content: [{ type: "text", text: "first attempt tool failure" }], structuredContent: { exit_code: 3 } } });
      retryable("429 rate_limit_error: retry artifacts");
      process.exit(1);
    }
    tool("read", { path: "not-retained" }, true, { result: { content: [{ type: "text", text: "fallback tool failure" }] } });
    tool("bash", { command: "npm test" }, false, { result: { structuredContent: { exit_code: 0 } } });
    emit("Fallback completed.");
    process.exit(0);
  }
  if (mode === "implement-artifact-anomalies") {
    tool("bash", { command: "first duplicate command" }, true, { toolCallId: "duplicate" , omitEnd: true });
    tool("bash", { command: "second duplicate command" }, true, { toolCallId: "duplicate", omitEnd: true });
    // Emit one matching end for the duplicate ID, then a failed end without an ID or start.
    console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "duplicate", toolName: "bash", result: { structuredContent: { output: "duplicate failure", exit_code: 2 } }, isError: true }));
    tool("read", {}, true, { missingId: true, omitStart: true, result: { content: [{ type: "text", text: "missing-id failure" }] } });
    tool("bash", { command: "open call" }, false, { omitEnd: true, toolCallId: "never-ended" });
    if (process.env.FAKE_PI_BLOCK_ARTIFACT) {
      const id = readFileSync(".git/me-pi-implement.lock", "utf8").trim().split(" ")[1];
      const directory = join(process.env.TMPDIR, "me-pi-delegate-" + process.ppid);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, id + "-failed-tools.json"), "do not overwrite");
    }
    console.log("{ malformed event");
    if (process.env.FAKE_PI_READY) writeFileSync(process.env.FAKE_PI_READY, "ready");
    emit("working", { stopReason: "toolUse" });
    process.on("SIGTERM", () => process.exit(143));
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "implement-commit" || mode === "move-ref") {
    for (let i = 0; i < Number(process.env.FAKE_PI_TOOL_EVENTS || 0); i++) tool("read", { path: "sub/a.txt" });
    writeFileSync("feature.txt", "IMPLEMENT-DIFF-BODY\\n");
    if (process.env.FAKE_PI_TOOL_EVENTS !== undefined) tool("write", { path: "feature.txt" });
    git("add", "-A");
    git("commit", "-q", "-m", "feat: add feature");
    if (mode === "move-ref") git("update-ref", "refs/heads/other", "HEAD");
    const ran = process.env.FAKE_PI_RAN ?? "npm test";
    if (ran) tool("bash", { command: ran }, Boolean(process.env.FAKE_PI_CHECK_FAIL));
    if (process.env.FAKE_PI_EDIT_AFTER) tool(process.env.FAKE_PI_STALE_TOOL || "edit", { path: "feature.txt" });
    emit("Added feature.txt.\\nIMPLEMENT-DIFF-BODY is in the details only");
    process.exit(0);
  }
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
    if (process.env.ME_PI_ROLE === "implement") {
      writeFileSync("feature.txt", "fixed\\n");
      git("add", "feature.txt");
      git("commit", "-q", "-m", "feat: fixture");
      tool("bash", { command: "npm test" });
    }
    emit("Answered after run " + runs + ".");
    process.exit(0);
  }
  if (mode === "implement-no-effect-failures") {
    // Harmless failures: an edit rejected before writing, a failed read, and a fenced write.
    const jobId = process.env.ME_PI_DELEGATE_JOB_ID;
    const attempt = Number(process.env.ME_PI_DELEGATE_ATTEMPT);
    tool("edit", { path: "src/cli.ts" }, true, { toolCallId: "edit-mismatch", result: { content: [{ type: "text", text: "Could not find edits[1] in /repo/src/cli.ts. The oldText must match exactly including all whitespace and newlines." }], details: {} } });
    tool("read", { path: "missing.txt" }, true, { toolCallId: "read-missing", result: { content: [{ type: "text", text: "ENOENT" }] } });
    const fence = { owner: "delegate-worker", jobId, attempt, toolCallId: "fenced-write", cause: "worker-fence-denial", resource: "guard", effect: "denied" };
    tool("write", { path: "/tmp/scratch.ts" }, true, { toolCallId: "fenced-write", result: { content: [{ type: "text", text: "Blocked: /tmp/scratch.ts is outside the checkout." }], details: { __mePiDelegateProvenance: [fence] } } });
    tool("bash", { command: "timeout 1 node --test" }, true, { toolCallId: "timed-out", result: { structuredContent: { exit_code: 124 } } });
    if (process.env.FAKE_PI_EDIT_WRITE_FAILED) tool("edit", { path: "src/cli.ts" }, true, { toolCallId: "edit-write-failed", result: { content: [{ type: "text", text: "EACCES: permission denied, open 'src/cli.ts'" }] } });
    writeFileSync("feature.txt", "fixed\\n");
    git("add", "feature.txt");
    git("commit", "-q", "-m", "feat: fixture");
    tool("bash", { command: "npm test" });
    emit("Implemented despite harmless tool failures.");
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
		ME_PI_ROLE: undefined,
		ME_PI_SKILLS: undefined,
		ME_PI_DELEGATE_JOB_ID: undefined,
		ME_PI_DELEGATE_ATTEMPT: undefined,
		ME_PI_TEST_ROOT: REPO_ROOT,
		FAKE_PI_EVENT_MARKER: undefined,
		FAKE_PI_TOOL_EVENTS: undefined,
		FAKE_PI_AGENT_COMMANDS: undefined,
		FAKE_PI_AGENT_HOOK: undefined,
		FAKE_PI_AGENT_HOOK_AT: undefined,
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
		globalThis[Symbol.for("me-pi.delegate.background-spend")] = { cost: 0 };
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
	"## Approval (coordinator and implement only)",
	"- protected actions",
	"## Secrets",
	"- never read keys",
].join("\n");

// A tool context that records the status line.
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

// --- implement ---

const CHECK = "npm test";

// A temp repo on `goal/x` with one commit and a branch `other`, as test/install.test.sh sets up its fixture.
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
	writeFileSync(
		join(repo, "verify.mjs"),
		'import { readFileSync } from "node:fs";\nif (!["fixed", "mutated"].includes(readFileSync("feature.txt", "utf8").trim())) { console.error("fixture not repaired"); process.exitCode = 1; }\n',
	);
	writeFileSync(
		join(repo, "package.json"),
		`${JSON.stringify({ private: true, scripts: { test: "node verify.mjs" } })}\n`,
	);
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

export { TEST_HOME, REPO_ROOT, registerExtension, classifyProviderError, LIMITS, LOCAL_TOOLS, WEB_TOOLS, IMPLEMENT_TOOLS, PROMPT_GUIDELINES, PROMPT_SNIPPET, ROLES, WORKER_CONTRACT, loadModelSet, resolveRun, secretPathIn, writeBlockedIn, trackCheck, registerGuard, TOOL_PROVENANCE_DETAIL_KEY, progressLines, registerDelegateCommand, snapshotContent, DEFAULT_LIMITS, HAIKU, SONNET, OPUS, LUNA, COPILOT, POOL_SET, pool, modelSet, ONE_OFF, UNAUTHENTICATED, REGISTRY_MODELS, registryFixture, FAKE_BIN, CTX, text, applyEnv, setupEnvironments, setup, run, isAlive, waitFor, waitDead, scratch, commandCtx, statusFor, POLICY, bgCtx, tuiCtx, trackIntervals, CHECK, implementRepo, implementEnv, implement, workerStarted };
