import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

// Pi's theme and renderers read the agent dir: keep HOME, TMPDIR and the agent dir in a temp dir, never the real ~/.pi.
const ROOT = mkdtempSync(join(tmpdir(), "compact-tools-test-"));
process.env.HOME = ROOT;
process.env.TMPDIR = ROOT;
process.env.PI_CODING_AGENT_DIR = join(ROOT, "agent");
// Pi inverts a diff's changed words through chalk, which emits no styles when the output is not a terminal.
process.env.FORCE_COLOR = "3";
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));

const {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	initTheme,
	ToolExecutionComponent,
} = await import("@earendil-works/pi-coding-agent");
const { default: registerCompactTools } = await import("../extensions/compact-tools.ts");

initTheme("dark", false);
let resolver: any;
registerCompactTools({
	registerToolRenderer: (registered: any) => {
		resolver = registered;
	},
} as any);

const PI: Record<string, any> = {
	bash: createBashToolDefinition(ROOT),
	edit: createEditToolDefinition(ROOT),
	write: createWriteToolDefinition(ROOT),
	read: createReadToolDefinition(ROOT),
	// A tool with a call renderer and no result renderer, like `Skill`.
	Skill: { name: "Skill" },
};
const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
const text = (value: string) => [{ type: "text", text: value }];

const UI = { requestRender() {} } as any;

/** A tool row as the transcript draws it, through Pi's own row component: non-empty lines. */
function rawRow(name: string, args: any, result?: any, { expanded = false, partial = false } = {}): string[] {
	const component = new ToolExecutionComponent(
		name,
		"call-1",
		args,
		{},
		resolver(name, () => PI[name]),
		UI,
		ROOT,
	);
	component.markExecutionStarted();
	component.setArgsComplete();
	if (result) component.updateResult({ details: {}, isError: false, ...result }, partial);
	component.setExpanded(expanded);
	const lines = component
		.render(80)
		.map((line: string) => stripVTControlCharacters(line).trimEnd())
		.filter((line: string) => line.trim());
	// Pi redraws a running row every second; settling it stops that timer so the test process can exit.
	if (partial) component.updateResult({ details: {}, isError: false, ...result }, false);
	return lines;
}

/** The same row without its left margin and the bar in front of output lines. */
function row(...args: Parameters<typeof rawRow>): string[] {
	return rawRow(...args).map((line) => line.replace(/^\s*│ ?/, "").trim());
}

test("a finished bash call is one line of facts, then its first output line and its last three", () => {
	const lines = row("bash", { command: "npm test\necho done" }, { content: text(numbered(40)), durationMs: 4200 });
	assert.deepEqual(lines, ["✓ $ npm test ⏎1 · +36 lines · 4.2s", "line 1", "⋮", "line 38", "line 39", "line 40"]);
	const raw = rawRow("bash", { command: "npm test" }, { content: text("one\ntwo") });
	assert.deepEqual(raw, [" ✓ $ npm test", " │ one", " │ two"], "output sits behind a bar in the glyph's column");
});

test("a short bash call shows its whole output, without blank lines or a duration under a second", () => {
	assert.deepEqual(row("bash", { command: "pwd" }, { content: text("/work\n"), durationMs: 20 }), [
		"✓ $ pwd",
		"/work",
	]);
	assert.deepEqual(row("bash", { command: "true" }, { content: text(""), durationMs: 20 }), ["✓ $ true"]);
	const six = row("bash", { command: "ls" }, { content: text("a\n\nb\nc\n\nd\ne\nf\n") });
	assert.deepEqual(six, ["✓ $ ls", "a", "b", "c", "d", "e", "f"]);
});

test("a leading cd is taken off the command and named only when it leaves the working directory", () => {
	const head = (command: string) => row("bash", { command }, { content: text("") })[0];
	assert.equal(head(`cd ${ROOT} && npm test`), "✓ $ npm test");
	assert.equal(head(`cd ${ROOT}/web && npm test`), "✓ $ npm test · in web");
	assert.equal(head(`cd "${ROOT}/web"\nnpm test\nnpm run lint`), "✓ $ npm test ⏎1 · in web");
	assert.equal(head("cd /srv/app; ls"), "✓ $ ls · in /srv/app");
	assert.equal(head("cd /srv/app"), "✓ $ cd /srv/app");
	assert.equal(head("set -euo pipefail\ncd /srv/app\nls"), "✓ $ ls · in /srv/app");
});

test("a command loses its output plumbing, and a long one is cut in the middle", () => {
	const head = (command: string) => row("bash", { command }, { content: text("") })[0];
	assert.equal(head("npm test -- --grep x 2>&1 | tail -60"), "✓ $ npm test -- --grep x");
	assert.equal(head("rg -n foo src | head -n 40"), "✓ $ rg -n foo src");
	assert.equal(head("make 2>&1 | tee build.log"), "✓ $ make | tee build.log");
	assert.equal(head("tail -5 build.log"), "✓ $ tail -5 build.log");
	assert.equal(
		head("git log | head -3\necho done"),
		"✓ $ git log | head -3 ⏎1",
		"only a one-line command loses its cap",
	);
	const wide = head(`grep ${"x".repeat(200)} file | sort -u`);
	assert.ok(wide.length <= 80, "a long command is cut to one line");
	assert.match(wide, /^✓ \$ grep x+…x* file \| sort -u$/);
});

test("a failed bash call shows a cross and its exit code, and keeps its end from the first error-like line", () => {
	const failed = (output: string) =>
		row("bash", { command: "npm test" }, { content: text(output), isError: true, durationMs: 4200 });
	assert.deepEqual(failed("ls: x: No such file or directory\n\nCommand exited with code 1"), [
		"✗ $ npm test · exit 1 · 4.2s",
		"ls: x: No such file or directory",
	]);
	const dull = failed(`${numbered(40)}\n\nCommand exited with code 2`);
	assert.equal(dull[0], "✗ $ npm test · exit 2 · +35 lines · 4.2s");
	assert.deepEqual(dull.slice(1), numbered(40).split("\n").slice(-5), "no error-like line: the last five");
	const output = [...numbered(30).split("\n"), "Error: boom", ...numbered(8).split("\n")];
	const found = failed(`${output.join("\n")}\n\nCommand exited with code 1`);
	assert.deepEqual(found.slice(1, 3), ["Error: boom", "line 1"], "kept from the first error-like line");
	assert.equal(found.length, 10);
	const old = failed(`Error: early\n${numbered(40)}\n\nCommand exited with code 1`);
	assert.equal(old.length, 6, "an error line more than twenty lines back does not count");
	const wide = failed(`${"z".repeat(100)}\n\nCommand exited with code 1`);
	assert.equal(wide.join("").match(/z/g)?.length, 100, "a long error line wraps instead of being cut");
	assert.deepEqual(failed("Command timed out after 5 seconds"), [
		"✗ $ npm test · 4.2s",
		"Command timed out after 5 seconds",
	]);
});

test("bash shows Pi's output preview while it runs, and Pi's rendering when expanded", () => {
	const result = { content: text(numbered(40)), durationMs: 4200 };
	const running = row("bash", { command: "npm test" }, result, { partial: true });
	assert.equal(running[0], "● $ npm test");
	assert.ok(running.includes("line 36") && !running.includes("line 35"), "running keeps Pi's five-line preview");
	const expanded = row("bash", { command: "npm test\necho done" }, result, { expanded: true });
	assert.ok(expanded.includes("line 1") && expanded.includes("echo done"));
	const failed = row(
		"bash",
		{ command: "false" },
		{ content: text("Command exited with code 1"), isError: true },
		{ expanded: true },
	);
	assert.ok(failed.includes("Command exited with code 1"));
});

test("colour marks what needs attention: error lines of a failed call, a slow run, the words an edit changed", () => {
	const paint = (name: string, args: any, result: any) => {
		const component = new ToolExecutionComponent(
			name,
			"c",
			args,
			{},
			resolver(name, () => PI[name]),
			UI,
			ROOT,
		);
		component.markExecutionStarted();
		component.setArgsComplete();
		component.updateResult({ details: {}, isError: false, ...result }, false);
		return component.render(80).filter((line: string) => stripVTControlCharacters(line).trim());
	};
	const colourOf = (line: string, word: string) =>
		line
			.slice(0, line.indexOf(word))
			.match(/\x1b\[38[\d;]*m/g)
			?.at(-1);
	const output = "compiling\nError: boom\n\nCommand exited with code 1";
	const failed = paint("bash", { command: "make" }, { content: text(output), isError: true });
	assert.notEqual(colourOf(failed[2], "Error"), colourOf(failed[1], "compiling"), "the error line stands out");
	const passed = paint("bash", { command: "rg Error" }, { content: text("compiling\nError: boom") });
	assert.equal(colourOf(passed[2], "Error"), colourOf(passed[1], "compiling"), "not in a passing call");
	const cut = paint("bash", { command: `grep ${"x".repeat(200)} file | sort -u` }, { content: text("") })[0];
	assert.ok(!cut.slice(0, cut.indexOf("sort -u")).includes("\x1b[0m"), "the end of a cut command keeps its style");
	const time = (durationMs: number) => paint("bash", { command: "make" }, { content: text(""), durationMs })[0];
	assert.notEqual(colourOf(time(45_000), "45.0s"), colourOf(time(5_000), "5.0s"));
	const details = { diff: "-2 limit: 256m\n+2 limit: 1g", patch: "" };
	const edit = paint("edit", { path: "a.yml", edits: [] }, { content: text("ok"), details });
	assert.match(edit[1], /\x1b\[7m256m/, "the changed word is inverted");
});

test("a running call shows whole seconds on its first line, in place of Pi's Elapsed line", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"] });
	let redraws = 0;
	const ui = { requestRender: () => redraws++ } as any;
	const component = new ToolExecutionComponent(
		"bash",
		"c",
		{ command: "make" },
		{},
		resolver("bash", () => PI.bash),
		ui,
		ROOT,
	);
	const shown = () =>
		component
			.render(80)
			.map((line: string) =>
				stripVTControlCharacters(line)
					.replace(/^\s*│ ?/, "")
					.trim(),
			)
			.filter(Boolean);
	component.markExecutionStarted();
	component.setArgsComplete();
	assert.deepEqual(shown(), ["● $ make"]);
	t.mock.timers.tick(12_000);
	assert.ok(redraws >= 12, "the row asks for a redraw every second");
	assert.deepEqual(shown(), ["● $ make · 12s"]);
	component.updateResult({ content: text("step 1"), details: {}, isError: false }, true);
	t.mock.timers.tick(60_000);
	assert.deepEqual(shown(), ["● $ make · 1m 12s", "step 1"]);
	component.updateResult({ content: text("step 1"), details: {}, isError: false, durationMs: 72_300 }, false);
	assert.deepEqual(shown(), ["✓ $ make · 1m 12s", "step 1"]);
	const settled = redraws;
	t.mock.timers.tick(5_000);
	assert.equal(redraws, settled, "a settled row stops redrawing");
});

test("an output line too long for the row is cut, unless it reads like an error: then it gets a second row", () => {
	const plain = row("bash", { command: "cat log" }, { content: text(`ok ${"x".repeat(200)}`) });
	assert.equal(plain.length, 2);
	assert.ok(plain[1].endsWith("…"));
	const output = `2026-11-19T09:36:02Z ${"step ".repeat(12)} ReferenceError: TOUR is not defined ${"y".repeat(200)}`;
	const error = row("bash", { command: "cat log" }, { content: text(output) });
	assert.equal(error.length, 3);
	assert.ok(error[2].includes("ReferenceError: TOUR is not defined") && error[2].endsWith("…"));
});

test("a read shows its path, range and line count, and its error when it failed", () => {
	const path = `${ROOT}/src/a.ts`;
	assert.deepEqual(row("read", { path }, { content: text(numbered(40)) }), ["✓ read src/a.ts · 40 lines"]);
	const part = { content: text(`${numbered(40)}\n\n[12 more lines in file. Use offset=100 to continue.]`) };
	assert.deepEqual(row("read", { path, offset: 60, limit: 40 }, part), ["✓ read src/a.ts:60-99 · 40 lines"]);
	const image = {
		content: [...text("Read image file [image/png]"), { type: "image", data: "", mimeType: "image/png" }],
	};
	assert.deepEqual(row("read", { path: "a.png" }, image), ["✓ read a.png · image"]);
	const failed = row("read", { path }, { content: text("ENOENT: no such file"), isError: true });
	assert.deepEqual(failed, ["✗ read src/a.ts", "ENOENT: no such file"]);
	assert.ok(row("read", { path }, { content: text(numbered(40)) }, { expanded: true }).includes("line 40"));
});

test("a write shows its path and line count; a failed write shows the error", () => {
	const args = { path: `${ROOT}/src/a.ts`, content: numbered(40) };
	assert.deepEqual(row("write", args, { content: text("ok") }), ["✓ write src/a.ts · 40 lines"]);
	assert.ok(row("write", args, { content: text("EACCES: denied"), isError: true }).includes("EACCES: denied"));
	assert.ok(row("write", args, { content: text("ok") }, { expanded: true }).includes("line 40"));
});

test("an edit shows its path, its counts and its first four changed lines; failed it shows Pi's rendering", () => {
	const args = { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] };
	const details = { diff: " 1 same\n-2 old\n+2 new\n+3 added\n 4 same", patch: "" };
	assert.deepEqual(row("edit", args), ["● edit src/a.ts"]);
	assert.deepEqual(row("edit", args, { content: text("ok"), details }), [
		"✓ edit src/a.ts · +2 -1",
		"-2 old",
		"+2 new",
		"+3 added",
	]);
	const big = { diff: Array.from({ length: 9 }, (_, i) => `+${i + 1} new`).join("\n"), patch: "" };
	assert.deepEqual(row("edit", args, { content: text("ok"), details: big }).slice(4), [
		"+4 new",
		"… +5 changed lines",
	]);
	assert.ok(
		row("edit", args, { content: text("ok"), details }, { expanded: true }).some((line) => line.includes("same")),
	);
	const failed = row("edit", args, { content: text("oldText not found"), isError: true });
	assert.ok(failed.includes("oldText not found"));
});

test("a tool without renderers shows its arguments and a line count, short output whole, a failure's end", () => {
	assert.deepEqual(row("mcp__x__y", { key: "WEB-88" }, { content: text(numbered(40)) }), [
		"✓ mcp__x__y key=WEB-88 · 40 lines",
	]);
	assert.deepEqual(row("mcp__x__y", { key: "WEB-88" }, { content: text("one\ntwo") }), [
		"✓ mcp__x__y key=WEB-88",
		"one",
		"two",
	]);
	const expanded = row("mcp__x__y", { key: "WEB-88" }, { content: text(numbered(40)) }, { expanded: true });
	assert.ok(expanded.includes("line 1") && expanded.includes("line 40"));
	const failed = row("mcp__x__y", {}, { content: text(numbered(40)), isError: true });
	assert.ok(failed.includes("line 21") && !failed.includes("line 20"));
});

test("a tool that draws its own row keeps its lines, behind the glyph and without the box", () => {
	PI.plan = {
		renderCall: () => ({ invalidate() {}, render: () => ["plan 2/5"] }),
		renderResult: () => ({ invalidate() {}, render: () => ["step three", ""] }),
	};
	assert.deepEqual(row("plan", {}, { content: text("ok") }), ["✓ plan 2/5", "step three"]);
	const own = { renderShell: "self", renderCall: () => undefined, renderResult: () => undefined };
	assert.equal(
		resolver("custom", () => own),
		own,
		"a tool that draws its own shell is left alone",
	);
});
