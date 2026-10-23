import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const {
	FAILED_TOOL_ARTIFACT_LIMITS: LIMITS,
	FAILED_TOOL_ARTIFACT_REDACTION,
	FailedToolArtifactCollector,
	redactSensitiveText,
} = await import("../extensions/delegate-artifacts.ts");

const start = "2026-01-01T00:00:00.000Z";
const end = "2026-01-01T00:00:01.250Z";

function failed(overrides = {}) {
	return {
		attemptIndex: 1,
		requestedModel: "provider/model",
		toolCallId: "call-1",
		toolName: "bash",
		startedAt: start,
		endedAt: end,
		cwd: "/workspace/project",
		rawArgsCommand: "npm test",
		effectiveCommand: "rtk npm test",
		isError: true,
		result: {
			exitCode: 2,
			outputText: "test failed",
			error: "child process failed",
			childDiagnostics: ["one diagnostic"],
			fullOutputPath: "/tmp/full-output.log",
			childDiagnosticReferences: ["/tmp/child-stderr.log"],
		},
		...overrides,
	};
}

function scratch() {
	const path = mkdtempSync(join(tmpdir(), "delegate-artifacts-test-"));
	test.after(() => rmSync(path, { recursive: true, force: true }));
	return path;
}

test("captures only failed calls and distinguishes observed fields from unavailable metadata", () => {
	const collector = new FailedToolArtifactCollector("im1");
	assert.equal(
		collector.record({
			isError: false,
			rawArgsCommand: "PASSWORD=success-only-payload",
			result: { outputText: "successful output" },
		}),
		false,
	);
	assert.equal(collector.record(failed()), true);
	const artifact = collector.snapshot();
	assert.ok(artifact);
	assert.equal(artifact.entries.length, 1);
	const [entry] = artifact.entries;
	assert.equal(entry.isError, true);
	assert.equal(entry.exitCode.value, 2);
	assert.equal(entry.attempt.index, 1);
	assert.equal(entry.attempt.requestedModel.text, "provider/model");
	assert.equal(entry.command.rawArgsCommand.value.text, "npm test");
	assert.equal(entry.command.effectiveCommand.value.text, "rtk npm test");
	assert.equal(entry.elapsedMs, 1250);
	assert.equal(entry.output.value.text, "test failed");
	assert.deepEqual(entry.missingFields, []);
	assert.equal(JSON.stringify(artifact).includes("successful output"), false);
	assert.equal(JSON.stringify(artifact).includes("success-only-payload"), false);

	const missing = new FailedToolArtifactCollector("im2");
	missing.record({
		isError: true,
		toolName: "bash",
		rawArgsCommand: "npm run targeted",
		result: { outputText: "failure", isError: true },
	});
	const missingEntry = missing.snapshot().entries[0];
	assert.equal(missingEntry.command.effectiveCommand.value, null);
	assert.equal(missingEntry.command.effectiveCommand.state, "not-provided");
	assert.equal(missingEntry.exitCode.value, null);
	assert.equal(missingEntry.exitCode.state, "not-provided");
	assert.equal(missingEntry.isError, true, "isError is not promoted to a numeric exit code");
	assert.equal(missingEntry.endedAt, null);
	assert.ok(missingEntry.missingFields.includes("endedAt"));
	assert.ok(missingEntry.missingFields.includes("elapsedMs"));
	assert.ok(missingEntry.missingFields.includes("result.exitCode"));
	assert.ok(missingEntry.missingFields.includes("result.error"));
	assert.ok(missingEntry.missingFields.includes("result.fullOutputPath"));
	assert.ok(missingEntry.missingFields.includes("result.childDiagnostics"));
	assert.ok(missingEntry.missingFields.includes("result.childDiagnosticReferences"));
	missing.noteAnomaly("start-without-end");
	assert.equal(missing.snapshot().capture.anomalies["start-without-end"], 1);
});

test("captures targeted and declared command failures without filtering by check designation", () => {
	const collector = new FailedToolArtifactCollector("im-checks");
	collector.record(
		failed({
			toolCallId: "targeted-test",
			rawArgsCommand: "npm test -- test/delegate-artifacts.test.mjs",
			result: { exitCode: 1, outputText: "targeted test failed" },
		}),
	);
	collector.record(
		failed({
			toolCallId: "declared-check",
			rawArgsCommand: "npm run check --prefix extensions",
			result: { exitCode: 1, outputText: "declared check failed" },
		}),
	);
	const entries = collector.snapshot().entries;
	assert.equal(entries.length, 2);
	assert.deepEqual(
		entries.map((entry) => entry.command.rawArgsCommand.value.text),
		["npm test -- test/delegate-artifacts.test.mjs", "npm run check --prefix extensions"],
	);
	assert.deepEqual(
		entries.map((entry) => entry.output.value.text),
		["targeted test failed", "declared check failed"],
	);
});

test("keeps non-Bash result summaries without retaining arbitrary tool input", () => {
	const collector = new FailedToolArtifactCollector("im3");
	collector.record(
		failed({
			toolName: "read",
			rawArgsCommand: "must-not-be-retained",
			effectiveCommand: "also-not-retained",
			result: { outputText: "read failed", summary: { message: "missing file", code: "ENOENT" } },
		}),
	);
	const entry = collector.snapshot().entries[0];
	assert.equal(entry.command, null);
	assert.equal(entry.resultSummary.state, "provided");
	assert.match(entry.resultSummary.value.text, /missing file/);
	assert.equal(JSON.stringify(entry).includes("must-not-be-retained"), false);
	assert.equal(JSON.stringify(entry).includes("also-not-retained"), false);
});

test("redacts credentials and known secret paths across all persisted text fields", () => {
	const collector = new FailedToolArtifactCollector("im4");
	collector.record(
		failed({
			cwd: "/Users/fakeuser/.pi/agent/auth.json",
			rawArgsCommand: "API_KEY=command-fake-secret",
			effectiveCommand: "echo 'Bearer command-bearer-secret'",
			result: {
				exitCode: 1,
				outputText: "Authorization: Bearer output-fake-secret; /home/fakeuser/.aws/credentials",
				error: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
				childDiagnostics: ["private key: /Users/fakeuser/.ssh/id_ed25519"],
				fullOutputPath: "/Users/fakeuser/.ssh/worker-output.log",
				childDiagnosticReferences: ["/home/fakeuser/.config/gh/hosts.yml"],
				summary: { access_token: "summary-fake-secret" },
			},
		}),
	);
	const artifact = collector.snapshot();
	const serialized = JSON.stringify(artifact);
	for (const secret of [
		"command-fake-secret",
		"command-bearer-secret",
		"output-fake-secret",
		"summary-fake-secret",
		"ghp_abcdefghijklmnopqrstuvwxyz1234567890",
		"/Users/fakeuser/.pi/agent/auth.json",
		"/home/fakeuser/.aws/credentials",
		"/Users/fakeuser/.ssh/worker-output.log",
		"/home/fakeuser/.config/gh/hosts.yml",
	])
		assert.equal(serialized.includes(secret), false, `did not redact ${secret}`);
	assert.ok(serialized.includes(FAILED_TOOL_ARTIFACT_REDACTION));
	assert.ok(serialized.includes("[REDACTED]"));
	assert.ok(serialized.includes("[REDACTED_PATH]"));
	assert.match(redactSensitiveText('"api_key":"plain-fake-secret"'), /\[REDACTED\]/);
	assert.equal(redactSensitiveText("TOKEN=first=second-secret").includes("second-secret"), false);
	assert.equal(redactSensitiveText("Authorization: Basic basic-auth-secret").includes("basic-auth-secret"), false);
});

test("marks malformed event-derived fields missing instead of coercing them", () => {
	const collector = new FailedToolArtifactCollector("im-malformed");
	assert.equal(collector.record(null), false);
	collector.record({
		isError: true,
		toolName: "bash",
		result: { exitCode: "1", outputText: { text: "not output text" }, childDiagnostics: { text: "not a list" } },
	});
	const entry = collector.snapshot().entries[0];
	assert.equal(entry.exitCode.value, null);
	assert.equal(entry.output.value, null);
	assert.ok(entry.missingFields.includes("result.exitCode"));
	assert.ok(entry.missingFields.includes("result.outputText"));
	assert.ok(entry.missingFields.includes("result.childDiagnostics"));
	assert.ok(collector.snapshot().capture.anomalies["invalid-field"] >= 3);
});

test("bounds output at 64 KiB on a UTF-8 boundary and records retained/original byte counts", () => {
	const collector = new FailedToolArtifactCollector("im5");
	const outputText = `${"a".repeat(LIMITS.maxTextBytes - 1)}é`;
	collector.record(failed({ result: { outputText } }));
	const output = collector.snapshot().entries[0].output.value;
	assert.equal(output.bytesOriginal, Buffer.byteLength(outputText, "utf8"));
	assert.equal(output.bytesRetained, LIMITS.maxTextBytes - 1);
	assert.equal(Buffer.byteLength(output.text, "utf8"), LIMITS.maxTextBytes - 1);
	assert.equal(output.text.endsWith("é"), false);
	assert.equal(output.truncated, true);

	const exact = new FailedToolArtifactCollector("im-exact");
	exact.record(failed({ result: { outputText: "x".repeat(LIMITS.maxTextBytes) } }));
	assert.equal(exact.snapshot().entries[0].output.value.truncated, false);
});

test("caps failed records and the complete UTF-8 JSON artifact including overhead", () => {
	const countLimited = new FailedToolArtifactCollector("im6");
	for (let index = 0; index < LIMITS.maxFailedCalls + 1; index++)
		countLimited.record(failed({ toolCallId: `call-${index}`, result: {} }));
	const countArtifact = countLimited.snapshot();
	assert.equal(countArtifact.entries.length, 100);
	assert.equal(countArtifact.capture.failureCount, 101);
	assert.equal(countArtifact.capture.recordedCount, 100);
	assert.equal(countArtifact.capture.omittedCount, 1);
	assert.equal(countArtifact.capture.truncated, true);
	assert.equal(countArtifact.capture.anomalies["record-cap"], 1);

	const aggregate = new FailedToolArtifactCollector("im7");
	for (let index = 0; index < 100; index++)
		aggregate.record(
			failed({
				toolCallId: `bulk-${index}`,
				result: { outputText: "\u0001".repeat(LIMITS.maxTextBytes) },
			}),
		);
	const artifact = aggregate.snapshot();
	assert.equal(artifact.entries.length, 100);
	assert.equal(artifact.capture.truncated, true);
	assert.ok(Buffer.byteLength(JSON.stringify(artifact), "utf8") <= LIMITS.maxArtifactBytes);
	assert.ok(artifact.entries.every((entry) => entry.truncated));
});

test("bounds references and stores full-output paths only as references", () => {
	const directory = scratch();
	const referenced = join(directory, "full-output.log");
	writeFileSync(referenced, "DO NOT COPY THIS FILE CONTENT");
	const collector = new FailedToolArtifactCollector("im8");
	collector.record(
		failed({
			result: {
				outputText: "failure",
				fullOutputPath: referenced,
				childDiagnosticReferences: Array.from({ length: 25 }, (_, index) => `/tmp/child-${index}.log`),
			},
		}),
	);
	const artifact = collector.snapshot();
	const entry = artifact.entries[0];
	assert.equal(entry.references.items.length, LIMITS.maxReferencesPerCall);
	assert.equal(entry.references.omitted, 6);
	assert.equal(entry.references.items[0].kind, "full-output-path");
	assert.equal(entry.references.items[0].value.text, referenced);
	assert.equal(JSON.stringify(artifact).includes("DO NOT COPY THIS FILE CONTENT"), false);
});

test("writes mode-0600 artifacts in mode-0700 directories without overwriting", () => {
	const parent = scratch();
	const directory = join(parent, "job-artifacts");
	const collector = new FailedToolArtifactCollector("im9");
	collector.record(failed());
	const first = collector.write(directory);
	assert.equal(first.status, "written");
	assert.equal(statSync(directory).mode & 0o777, 0o700);
	assert.equal(statSync(first.path).mode & 0o777, 0o600);
	assert.ok(first.bytes <= LIMITS.maxArtifactBytes);
	const original = readFileSync(first.path);
	const second = collector.write(directory);
	assert.equal(second.status, "unavailable");
	assert.match(second.warning, /^capture unavailable:/);
	assert.deepEqual(readFileSync(first.path), original);
});

test("returns empty without creating an artifact and captures storage errors as warning state", () => {
	const parent = scratch();
	const directory = join(parent, "empty-artifacts");
	const empty = new FailedToolArtifactCollector("im10");
	assert.equal(empty.record({ isError: false, result: { outputText: "not retained" } }), false);
	assert.deepEqual(empty.write(directory), { status: "empty" });
	assert.equal(existsSync(directory), false);

	const blocker = join(parent, "not-a-directory");
	writeFileSync(blocker, "file");
	const collector = new FailedToolArtifactCollector("im11");
	collector.record(failed());
	const result = collector.write(blocker);
	assert.equal(result.status, "unavailable");
	assert.match(result.warning, /^capture unavailable:/);
	assert.equal(collector.snapshot().capture.failureCount, 1, "capture I/O does not change the failed-call state");
});
