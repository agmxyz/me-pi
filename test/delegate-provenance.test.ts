import assert from "node:assert/strict";
import test from "node:test";

const {
	TOOL_PROVENANCE_DETAIL_KEY,
	bashExitCode,
	bashStatuses,
	eventField,
	eventRecord,
	eventText,
	failedToolResult,
	failedWithoutEffect,
	failureDisposition,
	toolResultText,
} = await import("../packages/pi-workers/extensions/delegate-provenance.ts");

const text = (...parts: string[]) => ({ content: parts.map((t) => ({ type: "text", text: t })) });

test("eventRecord accepts plain objects only", () => {
	for (const value of [undefined, null, 0, "x", true, [], [{ a: 1 }]]) assert.equal(eventRecord(value), undefined);
	const obj = { a: 1 };
	assert.equal(eventRecord(obj), obj);
});

test("eventText returns strings only", () => {
	assert.equal(eventText(undefined, "k"), undefined);
	assert.equal(eventText({ k: 1 }, "k"), undefined);
	assert.equal(eventText({}, "k"), undefined);
	assert.equal(eventText({ k: "" }, "k"), "");
	assert.equal(eventText({ k: "v" }, "k"), "v");
});

test("eventField distinguishes present-but-undefined from absent", () => {
	assert.deepEqual(eventField(undefined, "k"), { present: false });
	assert.deepEqual(eventField({}, "k"), { present: false });
	assert.deepEqual(eventField({ k: undefined }, "k"), { present: true, value: undefined });
	assert.deepEqual(eventField({ k: null }, "k"), { present: true, value: null });
	assert.deepEqual(eventField(Object.create({ k: 1 }), "k"), { present: false }, "inherited fields are absent");
});

test("bashStatuses accepts the canonical structuredContent.exit_code", () => {
	assert.deepEqual(bashStatuses({ structuredContent: { exit_code: 0 } }), {
		exitCode: 0,
		diagnostics: ["structuredContent.exit_code=0"],
	});
	assert.equal(bashExitCode({ structuredContent: { exit_code: 2 } }), 2);
});

test("bashStatuses: aliases alone never authorize an exit code", () => {
	for (const result of [
		{ structuredContent: { exitCode: 1 } },
		{ details: { exit_code: 1 } },
		{ details: { exitCode: 1 } },
		{ exit_code: 1 },
		{ exitCode: 1 },
	]) {
		const status = bashStatuses(result);
		assert.equal(status.exitCode, undefined);
		assert.equal(status.diagnostics.length, 1);
	}
});

test("bashStatuses: agreeing aliases keep the canonical code; any contradiction vetoes it", () => {
	const agree = {
		structuredContent: { exit_code: 3, exitCode: 3 },
		details: { exit_code: 3, exitCode: 3 },
		exit_code: 3,
		exitCode: 3,
	};
	assert.deepEqual(bashStatuses(agree), {
		exitCode: 3,
		diagnostics: [
			"structuredContent.exit_code=3",
			"structuredContent.exitCode=3",
			"details.exit_code=3",
			"details.exitCode=3",
			"exit_code=3",
			"exitCode=3",
		],
	});
	assert.deepEqual(bashStatuses({ structuredContent: { exit_code: 0 }, details: { exitCode: 1 } }), {
		diagnostics: ["structuredContent.exit_code=0", "details.exitCode=1"],
	});
	assert.equal(bashExitCode({ structuredContent: { exit_code: 0 }, exitCode: "0" }), undefined);
});

test("bashStatuses: missing, non-integer, and non-object values", () => {
	for (const value of [undefined, null, "x", 1, []]) assert.deepEqual(bashStatuses(value), { diagnostics: [] });
	assert.deepEqual(bashStatuses({ structuredContent: "nope", details: [] }), { diagnostics: [] });
	assert.deepEqual(bashStatuses({ structuredContent: { exit_code: 1.5 } }), {
		diagnostics: ["structuredContent.exit_code=1.5"],
	});
	assert.deepEqual(bashStatuses({ structuredContent: { exit_code: Number.NaN } }), {
		diagnostics: ["structuredContent.exit_code=NaN"],
	});
	assert.deepEqual(
		bashStatuses({
			structuredContent: { exit_code: "1", exitCode: "secret-token" },
			details: { exit_code: true, exitCode: null },
			exit_code: { nested: 1 },
			exitCode: undefined,
		}),
		{
			diagnostics: [
				"structuredContent.exit_code=string:1",
				"structuredContent.exitCode=string:[REDACTED]",
				"details.exit_code=true",
				"details.exitCode=null",
				"exit_code=object",
				"exitCode=undefined",
			],
		},
	);
	assert.deepEqual(bashStatuses({ structuredContent: { exit_code: "1234" } }).diagnostics, [
		"structuredContent.exit_code=string:[REDACTED]",
	]);
});

test("toolResultText joins text parts and ignores the rest", () => {
	assert.equal(toolResultText(undefined), undefined);
	assert.equal(toolResultText({ content: "x" }), undefined);
	assert.equal(toolResultText({ content: [] }), undefined);
	assert.equal(
		toolResultText({ content: [{ type: "image", data: "x" }, null, { type: "text", text: 1 }] }),
		undefined,
	);
	assert.equal(
		toolResultText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }),
		"a\nb",
	);
	const long = "x".repeat(100_000);
	assert.equal(toolResultText(text(long)), long, "no truncation at this layer");
});

// Pins known behavior: the first exit-code alias is recorded even when bashStatuses would veto it (#35).
test("failedToolResult extracts bash fields with first-field fallbacks", () => {
	assert.deepEqual(failedToolResult(undefined, "bash"), {});
	assert.deepEqual(
		failedToolResult(
			{
				...text("content"),
				structuredContent: { exitCode: 2, fullOutputPath: "/s" },
				details: { exit_code: 9, output: "details-out", error: "details-err", childDiagnostics: ["d"] },
				full_output_path: "/r",
				childDiagnosticReferences: ["ref"],
			},
			"bash",
		),
		{
			exitCode: 2,
			outputText: "details-out",
			error: "details-err",
			childDiagnostics: ["d"],
			statusDiagnostics: ["structuredContent.exitCode=2", "details.exit_code=9"],
			fullOutputPath: "/s",
			childDiagnosticReferences: ["ref"],
		},
	);
	assert.deepEqual(failedToolResult({ ...text("only"), output: "top", structuredContent: { output: "sc" } }, "bash"), {
		outputText: "sc",
	});
	assert.deepEqual(failedToolResult(text("only"), "bash"), { outputText: "only" });
	assert.deepEqual(failedToolResult({ error: undefined }, "bash"), { error: undefined });
});

test("failedToolResult summary for non-bash tools", () => {
	assert.deepEqual(failedToolResult(text("c"), "read"), { outputText: "c", summary: "c" });
	assert.deepEqual(failedToolResult({ ...text("c"), structuredContent: { k: 1 } }, "read"), {
		outputText: "c",
		summary: { k: 1 },
	});
	assert.deepEqual(failedToolResult({ structuredContent: { summary: "s" } }, "edit"), { summary: "s" });
	assert.deepEqual(failedToolResult({ structuredContent: { exit_code: 1 } }, "edit"), {
		exitCode: 1,
		summary: { exit_code: 1 },
	});
	assert.deepEqual(failedToolResult({}, undefined), {});
});

test("failedWithoutEffect: read-only tools always", () => {
	for (const tool of ["read", "grep", "find", "ls", "Skill"]) assert.equal(failedWithoutEffect(tool, undefined), true);
});

test("failedWithoutEffect: edit rejected before write", () => {
	for (const message of [
		"Could not find the exact text in a.ts",
		"Could not find edits[2] in a.ts",
		"Found 3 occurrences of x in a.ts",
		"oldText must not be empty in a.ts",
		"edits[0].oldText must not be empty in a.ts",
		"No changes made to a.ts",
		"edits[0] and edits[1] overlap in a.ts",
		"Could not edit file: a.ts",
		"Edit tool input is invalid.",
	])
		assert.equal(failedWithoutEffect("edit", text(message)), true, message);
});

test("failedWithoutEffect: other failures may have had effects", () => {
	assert.equal(failedWithoutEffect("edit", text("EACCES: permission denied")), false);
	assert.equal(failedWithoutEffect("edit", text("prefix Could not edit file: a.ts")), false, "anchored at start");
	assert.equal(failedWithoutEffect("edit", undefined), false);
	assert.equal(failedWithoutEffect("write", text("Could not edit file: a.ts")), false);
	assert.equal(failedWithoutEffect("bash", text("No changes made to a.ts")), false);
	assert.equal(failedWithoutEffect("Read", text("x")), false, "case-sensitive tool names");
});

const marker = (...causes: string[]) => ({
	details: {
		[TOOL_PROVENANCE_DETAIL_KEY]: causes.map((cause) => ({
			owner: "delegate-worker",
			jobId: "j",
			attempt: 1,
			cause,
			resource: "tool",
			effect: "denied",
		})),
	},
});

test("failureDisposition: provenance markers win", () => {
	assert.equal(failureDisposition("bash", marker("guard-denial", "wrap-up-limit")), "budget-blocked");
	assert.equal(failureDisposition("bash", marker("guard-denial")), "guard-denied");
	assert.equal(failureDisposition("read", marker("worker-fence-denial")), "guard-denied");
	assert.equal(failureDisposition(undefined, marker("hard-timeout")), "blocked");
	assert.equal(
		failureDisposition("read", { details: { [TOOL_PROVENANCE_DETAIL_KEY]: [{ cause: "wrap-up-limit" }] } }),
		"read-failed",
		"invalid stop facts are ignored",
	);
});

test("failureDisposition: bash outcomes", () => {
	assert.equal(failureDisposition("bash", { structuredContent: { exit_code: 124 } }), "timeout");
	assert.equal(failureDisposition("bash", text("Command timed out after 30 seconds")), "timeout");
	assert.equal(failureDisposition("bash", { structuredContent: { exit_code: 1 } }), "nonzero-exit");
	assert.equal(failureDisposition("bash", { structuredContent: { exit_code: 0 } }), "unknown");
	assert.equal(failureDisposition("bash", { exitCode: 1 }), "unknown", "alias alone is not authoritative");
	assert.equal(failureDisposition("bash", { structuredContent: { exit_code: 1 }, exitCode: 2 }), "unknown");
});

test("failureDisposition: other tools", () => {
	assert.equal(failureDisposition(undefined, {}), "unknown");
	assert.equal(failureDisposition("read", {}), "read-failed");
	assert.equal(failureDisposition("Skill", {}), "read-failed");
	assert.equal(failureDisposition("edit", text("No changes made to a.ts")), "edit-rejected");
	assert.equal(failureDisposition("edit", text("disk full")), "unknown");
	assert.equal(failureDisposition("write", text("x")), "unknown");
});
