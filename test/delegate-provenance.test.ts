import assert from "node:assert/strict";
import test from "node:test";

const { bashExitCode, bashStatuses, eventField, eventRecord, failedWithoutEffect, toolResultText } = await import(
	"../packages/pi-workers/extensions/delegate-provenance.ts"
);

const text = (...parts: string[]) => ({ content: parts.map((t) => ({ type: "text", text: t })) });

test("eventRecord accepts plain objects only", () => {
	for (const value of [undefined, null, 0, "x", true, [], [{ a: 1 }]]) assert.equal(eventRecord(value), undefined);
	const obj = { a: 1 };
	assert.equal(eventRecord(obj), obj);
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
