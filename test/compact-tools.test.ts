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
const { visibleWidth } = await import("@earendil-works/pi-tui");

initTheme("dark", false);
let resolver: any;
const handlers: Record<string, (event: any, ctx?: any) => void> = {};
registerCompactTools({
	registerToolRenderer: (registered: any) => {
		resolver = registered;
	},
	on(name: string, handler: any) {
		handlers[name] = handler;
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
function rawRow(
	name: string,
	args: any,
	result?: any,
	{ expanded = false, partial = false, width = 80 } = {},
): string[] {
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
		.render(width)
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

test("a finished bash call is one line: what ran, how many lines it printed, how long it took", () => {
	const lines = row("bash", { command: "npm test\necho done" }, { content: text(numbered(40)), durationMs: 4200 });
	assert.deepEqual(lines, ["? $ npm test ⏎1 · 40 lines · 4.2s"]);
	assert.deepEqual(row("bash", { command: "pwd" }, { content: text("/work\n"), durationMs: 20 }), [
		"✓ $ pwd · 1 line",
	]);
	assert.deepEqual(
		row("bash", { command: "ls" }, { content: text("a\n\nb\n") }),
		["✓ $ ls · 2 lines"],
		"blank lines do not count",
	);
	assert.deepEqual(row("bash", { command: "true" }, { content: text(""), durationMs: 20 }), ["✓ $ true"]);
	assert.deepEqual(
		row("bash", { command: "cp a b" }, { content: text("(no output)") }),
		["✓ $ cp a b"],
		"Pi's stand-in for no output is not a line",
	);
	const failed = row(
		"bash",
		{ command: "false" },
		{ content: text("(no output)\n\nCommand exited with code 1"), isError: true },
	);
	assert.deepEqual(failed, ["✗ $ false · exit 1"]);
	const raw = rawRow(
		"bash",
		{ command: "make" },
		{ content: text("Error: boom\n\nCommand exited with code 2"), isError: true },
	);
	assert.deepEqual(
		raw,
		[" ✗ $ make · exit 2", " │ Error: boom"],
		"a failure's output sits behind a bar in the glyph's column",
	);
});

test("a leading cd is taken off the command and named only when it leaves the working directory", () => {
	const head = (command: string) => row("bash", { command }, { content: text("") })[0];
	assert.equal(head(`cd ${ROOT} && npm test`), "✓ $ npm test");
	assert.equal(head(`cd ${ROOT}/web && npm test`), "✓ $ npm test · in web");
	assert.equal(head(`cd "${ROOT}/web"\nnpm test\nnpm run lint`), "? $ npm test ⏎1 · in web");
	assert.equal(head(`cd "${ROOT}/web"\nnpm test`), "✓ $ npm test · in web");
	assert.equal(head("cd /srv/app; ls"), "✓ $ ls · in /srv/app");
	assert.equal(head("cd /srv/app"), "✓ $ cd /srv/app");
	const narrow = rawRow("bash", { command: `cd /srv/${"deep/".repeat(20)}pi-tui/dist && rg -n foo` }, undefined, {
		width: 51,
	});
	assert.ok(
		narrow.every((line) => visibleWidth(line) <= 51),
		"a directory too long for the terminal is cut, not drawn past its edge",
	);
	assert.deepEqual(
		narrow.map((line) => line.trim()),
		["● $ rg -n foo · in …/deep/pi-tui/dist"],
		"a long directory keeps its end, and the command keeps its room",
	);
	assert.deepEqual(
		row("bash", { command: `cd /srv/${"deep/".repeat(6)}pi-tui/dist && ls` }, { content: text("") }),
		[`✓ $ ls · in /srv/${"deep/".repeat(6)}pi-tui/dist`],
		"a directory longer than half the line stays whole while the row fits",
	);
	assert.equal(head("set -euo pipefail\ncd /srv/app\nls"), "✓ $ ls · in /srv/app");
});

test("a passing ; or newline sequence shows ?: only its last statement's exit code was seen", () => {
	const head = (command: string) => row("bash", { command }, { content: text("") })[0];
	assert.equal(head("./check.sh; git status"), "? $ ./check.sh; git status");
	assert.equal(head("cd /srv/app\n./check.sh\ngit status"), "? $ ./check.sh ⏎1 · in /srv/app");
	assert.equal(head("cd /srv/app; ls"), "✓ $ ls · in /srv/app");
	assert.equal(head("npm test && npm run lint"), "✓ $ npm test && npm run lint", "&& stops at a failure");
	assert.equal(head("set -e\n./check.sh\ngit status"), "✓ $ ./check.sh ⏎1", "errexit stops at a failure");
	assert.equal(head("set -euo pipefail\ncd /srv/app\n./check.sh; ls"), "✓ $ ./check.sh; ls · in /srv/app");
	assert.equal(head('echo "a; b"'), '✓ $ echo "a; b"', "a quoted ; is not a separator");
	assert.equal(head("ls;"), "✓ $ ls;", "nothing after the ;");
	const failed = row("bash", { command: "a; b" }, { content: text("Command exited with code 1"), isError: true });
	assert.equal(failed[0], "✗ $ a; b · exit 1");
});

test("a command loses its output plumbing, and a long one is cut in the middle", () => {
	const head = (command: string) => row("bash", { command }, { content: text("") })[0];
	assert.equal(head("npm test -- --grep x 2>&1 | tail -60"), "✓ $ npm test -- --grep x");
	assert.equal(head("rg -n foo src | head -n 40"), "✓ $ rg -n foo src");
	assert.equal(head("make 2>&1 | tee build.log"), "✓ $ make | tee build.log");
	assert.equal(head("tail -5 build.log"), "✓ $ tail -5 build.log");
	assert.equal(
		head("git log | head -3\necho done"),
		"? $ git log | head -3 ⏎1",
		"only a one-line command loses its cap",
	);
	const wide = head(`grep ${"x".repeat(200)} file | sort -u`);
	assert.ok(wide.length <= 80, "a long command is cut to one line");
	assert.match(wide, /^✓ \$ grep x+…x* file \| sort -u$/);
	const barely = head(`echo ${"x".repeat(70)} done`);
	assert.match(barely, /^✓ \$ echo x+…$/, "a command only a little too long is cut at its end");
	assert.ok(barely.length >= 78);
});

test("a failed bash call shows a cross and its exit code, and keeps its end from the first error-like line", () => {
	const failed = (output: string) =>
		row("bash", { command: "npm test" }, { content: text(output), isError: true, durationMs: 4200 });
	assert.deepEqual(failed("ls: x: No such file or directory\n\nCommand exited with code 1"), [
		"✗ $ npm test · exit 1 · 4.2s",
		"ls: x: No such file or directory",
	]);
	const dull = failed(`${numbered(40)}\n\nCommand exited with code 2`);
	assert.deepEqual(dull.slice(0, 2), ["✗ $ npm test · exit 2 · 4.2s", "⋮ 35 more lines"]);
	assert.deepEqual(dull.slice(2), numbered(40).split("\n").slice(-5), "no error-like line: the last five");
	const output = [...numbered(30).split("\n"), "Error: boom", ...numbered(6).split("\n")];
	const found = failed(`${output.join("\n")}\n\nCommand exited with code 1`);
	assert.deepEqual(
		found.slice(1, 4),
		["⋮ 30 more lines", "Error: boom", "line 1"],
		"kept from the first error-like line",
	);
	assert.equal(found.length, 9);
	const report = [
		"✖ a breaks",
		"pass 0",
		"fail 1",
		"running b",
		"ok b",
		"ok c",
		"ok d",
		"✖ a breaks",
		"Error: 1 broke",
	];
	assert.deepEqual(
		failed(`${numbered(4)}\n${report.join("\n")}\n\nCommand exited with code 1`).slice(1),
		["⋮ 10 more lines", "fail 1", "✖ a breaks", "Error: 1 broke"],
		"an end longer than eight lines shows only its error-like lines, each once",
	);
	const runner = [
		"✖ prices keep two decimals",
		"  AssertionError: Expected values to be strictly equal:",
		"    actual: '$19.5',",
		"    expected: '$19.05',",
		"✔ more than the stock cannot",
		"ℹ pass 2",
		"ℹ fail 0",
		"ok 3 - invalid input is refused",
		"Error: some tests fail",
	];
	const zero = failed(`Error: 0 is not a valid port\n${numbered(8)}\nfailed: 0\n\nCommand exited with code 1`);
	assert.deepEqual(
		zero.slice(1),
		["⋮ 9 more lines", "Error: 0 is not a valid port"],
		"a zero in an error is no pass, a count of none is",
	);
	assert.deepEqual(
		failed(`${runner.join("\n")}\n\nCommand exited with code 1`).slice(1),
		["⋮ 4 more lines", runner[0], runner[1].trim(), runner[2].trim(), runner[3].trim(), runner[8]],
		"lines that report a pass are left out, and the values of a failed comparison are kept",
	);
	const many = Array.from({ length: 15 }, (_, i) => `Error: ${i + 1}`).join("\n");
	assert.deepEqual(
		failed(`${many}\n\nCommand exited with code 1`).slice(1, 3),
		["⋮ 7 more lines", "Error: 8"],
		"at most eight of them, the newest",
	);
	const old = failed(`Error: early\n${numbered(40)}\n\nCommand exited with code 1`);
	assert.equal(old.length, 7, "an error line more than twenty lines back does not count");
	const wide = failed(`${"z".repeat(100)}\n\nCommand exited with code 1`);
	assert.equal(wide.join("").match(/z/g)?.length, 100, "a long error line wraps instead of being cut");
	const huge = failed(`Error: ${"z".repeat(400)}\n\nCommand exited with code 1`);
	assert.ok(huge.length === 3 && huge[2].endsWith("…"), "one line takes two rows at most and keeps its start");
	assert.deepEqual(failed("Command timed out after 5 seconds"), [
		"✗ $ npm test · 4.2s",
		"Command timed out after 5 seconds",
	]);
});

test("bash shows Pi's output preview while it runs, and Pi's rendering when expanded", () => {
	const result = { content: text(numbered(40)), durationMs: 4200 };
	const running = row("bash", { command: "npm test" }, result, { partial: true });
	assert.equal(running[0], "● $ npm test");
	assert.ok(running.includes("line 36") && !running.includes("line 35"), "a row not held back keeps Pi's preview");
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

test("colour marks what needs attention: the error lines of a failed call and a slow run", () => {
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
	const cut = paint("bash", { command: `grep ${"x".repeat(200)} file | sort -u` }, { content: text("") })[0];
	assert.ok(!cut.slice(0, cut.indexOf("sort -u")).includes("\x1b[0m"), "the end of a cut command keeps its style");
	const time = (durationMs: number) => paint("bash", { command: "make" }, { content: text(""), durationMs })[0];
	assert.notEqual(colourOf(time(45_000), "45.0s"), colourOf(time(5_000), "5.0s"));
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

test("an edit shows its path and its counts of added and removed lines; failed it shows Pi's rendering", () => {
	const args = { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] };
	const details = { diff: " 1 same\n-2 old\n+2 new\n+3 added\n 4 same", patch: "" };
	assert.deepEqual(row("edit", args), ["● edit src/a.ts"]);
	assert.deepEqual(row("edit", args, { content: text("ok"), details }), ["✓ edit src/a.ts · +2 -1"]);
	assert.ok(
		row("edit", args, { content: text("ok"), details }, { expanded: true }).some((line) => line.includes("same")),
		"expanded, the changed lines are there",
	);
	const failed = row("edit", args, { content: text("oldText not found"), isError: true });
	assert.ok(failed.includes("oldText not found"));
});

test("a tool without renderers shows its arguments and a line count, and the end of a failure", () => {
	assert.deepEqual(row("mcp__x__y", { key: "WEB-88" }, { content: text(numbered(40)) }), [
		"✓ mcp__x__y key=WEB-88 · 40 lines",
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
	const call = { invalidate() {}, render: () => ["mine"] };
	const seen: unknown[] = [];
	PI.custom = {
		renderShell: "self",
		renderCall: (_args: unknown, _theme: unknown, context: any) => {
			seen.push(context.lastComponent);
			return call;
		},
		renderResult: () => ({ invalidate() {}, render: () => [] }),
	};
	assert.deepEqual(
		row("custom", {}, { content: text("ok") }),
		["mine"],
		"a tool that draws its own shell keeps its lines",
	);
	assert.equal(seen.at(-1), call, "and is handed back the component it made");
});

const IDLE = { isIdle: () => true, sessionManager: { getBranch: () => [] } };

/** A transcript as Pi builds it: each step is one assistant message, with optional text before its calls. */
function session() {
	handlers.session_start({}, IDLE);
	handlers.message_start({ message: { role: "user" } });
	const rows: any[] = [];
	let count = 0;
	const says = (content: any[]) => {
		const message = { role: "assistant", content };
		handlers.message_start({ message });
		handlers.message_end({ message });
	};
	return {
		step(calls: [string, any, any][], text = "") {
			const ids = calls.map(() => `call-${count++}`);
			says([
				...(text ? [{ type: "text", text }] : []),
				...calls.map(([name, args], i) => ({ type: "toolCall", id: ids[i], name, arguments: args })),
			]);
			calls.forEach(([name, args, result], i) => {
				const component = new ToolExecutionComponent(
					name,
					ids[i],
					args,
					{},
					resolver(name, () => PI[name]),
					UI,
					ROOT,
				);
				component.markExecutionStarted();
				component.setArgsComplete();
				if (result) component.updateResult({ details: {}, isError: false, ...result }, false);
				rows.push(component);
			});
		},
		/** A running call prints: Pi gives the row a partial result. */
		print: (index: number, output: string) =>
			rows[index].updateResult({ content: text(output), details: {}, isError: false }, true),
		/** Ends every row still running, which stops the timer Pi keeps for it. */
		finish() {
			for (const row of rows) row.updateResult({ content: text(""), details: {}, isError: false }, false);
		},
		reply: (text: string) => says([{ type: "text", text }]),
		stop: () => handlers.agent_end({}, { hasUI: false }),
		expand() {
			for (const row of rows) row.setExpanded(true);
		},
		/** Every row's lines, blank ones included, without the bar. */
		screen: () =>
			rows.flatMap((row) =>
				row.render(80).map((line: string) =>
					stripVTControlCharacters(line)
						.replace(/^\s*│ ?/, "")
						.trimEnd()
						.trim(),
				),
			),
	};
}
const ran = (command: string, output: string, more = {}): [string, any, any] => [
	"bash",
	{ command },
	{ content: text(output), ...more },
];
const edited: [string, any, any] = [
	"edit",
	{ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] },
	{ content: text("ok"), details: { diff: "-1 a\n+1 b" } },
];

test("a call stays out of the transcript until the next step shows what became of it", () => {
	const running = session();
	running.step([["bash", { command: "npm install" }, undefined]]);
	assert.deepEqual(running.screen(), [], "a running call shows only in the live area");
	const s = session();
	s.step([ran("npm install left-pad", "added 1 package")]);
	assert.deepEqual(s.screen(), [], "a finished call waits for the step after it");
	s.step([ran("npm run build", "built")]);
	assert.deepEqual(s.screen(), ["", "✓ $ npm install left-pad · 1 line"], "followed by a step: one line");
	s.reply("Built.");
	assert.deepEqual(
		s.screen(),
		["", "✓ $ npm install left-pad · 1 line", "✓ $ npm run build · 1 line"],
		"the last step shows when the reply starts, without its output",
	);
});

test("a call made with one that shows at once shows with it, so no line is added above a drawn row", () => {
	const s = session();
	s.step([ran("make", "ok"), ran("npm run lint", "Error: boom\n\nCommand exited with code 1", { isError: true })]);
	assert.deepEqual(s.screen(), ["", "✓ $ make · 1 line", "", "✗ $ npm run lint · exit 1", "Error: boom"]);
	const later = session();
	later.step([ran("npm run lint", "Error: boom\n\nCommand exited with code 1", { isError: true }), ran("make", "ok")]);
	assert.deepEqual(later.screen(), ["", "✗ $ npm run lint · exit 1", "Error: boom"], "a call below it still waits");
	const slot = widgetSlot();
	handlers.agent_start({}, slot.ctx);
	const running = session();
	running.step([
		["bash", { command: "sleep 3" }, undefined],
		ran("false", "Command exited with code 1", { isError: true }),
	]);
	running.print(0, "tick 1\ntick 2");
	handlers.tool_execution_start({ toolCallId: "call-0", toolName: "bash", args: { command: "sleep 3" } }, slot.ctx);
	assert.deepEqual(
		running.screen(),
		["", "● $ sleep 3", "", "✗ $ false · exit 1"],
		"one still running takes its line at once, so none is added above the failure later",
	);
	assert.deepEqual(slot.lines(), ["", "", ""], "and is not in the live area as well");
	handlers.agent_end({}, slot.ctx);
	running.finish();
	const lookup = session();
	lookup.step([ran("ls", "a"), ran("false", "Command exited with code 1", { isError: true })]);
	lookup.step([ran("make", "ok")]);
	lookup.step([ran("true", "")]);
	assert.deepEqual(
		lookup.screen(),
		["", "✓ $ ls · 1 line", "✗ $ false · exit 1", "✓ $ make · 1 line"],
		"a call that changes nothing keeps the line it was drawn with",
	);
	// `plan` draws its own row here, and draws it as soon as it is called.
	const own = session();
	own.step([ran("ls", "a"), ["plan", {}, { content: text("ok") }]]);
	const drawn = ["", "✓ $ ls · 1 line", "", "✓ plan 2/5", "step three"];
	assert.deepEqual(own.screen(), drawn, "a call made before a tool that draws its own row shows with it");
	own.step([ran("make", "ok")]);
	own.step([ran("true", "")]);
	assert.deepEqual(own.screen(), [...drawn, "", "✓ $ make · 1 line"], "and keeps its line");
	PI.hush = {
		renderShell: "self",
		renderCall: () => ({ invalidate() {}, render: () => [] }),
		renderResult: () => ({ invalidate() {}, render: () => [] }),
	};
	const none = session();
	none.step([ran("ls", "a"), ["hush", {}, { content: text("ok") }]]);
	assert.deepEqual(none.screen(), [], "beside a tool whose row is empty, as the plan tool's is, the call still waits");
	none.step([ran("make", "ok")]);
	none.step([ran("true", "")]);
	assert.deepEqual(
		none.screen(),
		["", "⋮ 1 call, nothing changed", "✓ $ make · 1 line"],
		"and rows close up across the empty one",
	);
});

test("a heading drawn by a tool with its own shell stands above the first row of its message", () => {
	// As the `plan` tool draws a step it started: one line for the call, none for the result. The line comes
	// from what the result left in the row's state, so the call has nothing to draw until the result is in.
	PI.step = {
		renderShell: "self",
		renderCall: (_args: any, _theme: any, context: any) => ({
			invalidate() {},
			render: () => (context.state.title ? [` ▸ ${context.state.title}`] : []),
		}),
		renderResult: (result: any, _options: any, _theme: any, context: any) => {
			context.state.title = result.details?.title;
			return { invalidate() {}, render: () => [] };
		},
	};
	const step = (title?: string): [string, any, any] => ["step", {}, { content: text("ok"), details: { title } }];
	const s = session();
	s.step([ran("ls", "a"), step("Find it")]);
	assert.deepEqual(s.screen(), [], "the heading waits with the row it stands above");
	s.step([ran("rg greet", "a")]);
	s.step([edited, step("Fix it")]);
	const drawn = ["", "▸ Find it", "⋮ 2 calls, nothing changed", "", "▸ Fix it", "✓ edit a.ts · +1 -1"];
	assert.deepEqual(
		s.screen(),
		drawn,
		"though the tool was called last, and calls that keep no line are counted under it",
	);
	s.step([ran("make", "ok"), step()]);
	s.step([step("Report")]);
	s.reply("done");
	assert.deepEqual(
		s.screen(),
		[...drawn, "✓ $ make · 1 line", "", "▸ Report"],
		"a call with no heading leaves nothing, and a heading alone in its message stands at its own place",
	);
	s.expand();
	assert.equal(s.screen().filter((line) => line === "▸ Find it").length, 1, "expanded, each heading shows once");
});

test("a command names its directory only when it differs from the command row above", () => {
	const s = session();
	s.step([ran("cd /srv/app && make", "ok")]);
	s.step([ran("cd /srv/app && rg foo", "a.ts:1:foo")]);
	s.step([ran("cd /srv/app && make install", "ok")]);
	s.step([edited]);
	s.step([ran("cd /srv/app && make clean", "ok")]);
	s.step([ran("make", "ok")]);
	s.step([ran("cd /srv/web && make", "ok")]);
	s.reply("Done.");
	assert.deepEqual(s.screen(), [
		"",
		"✓ $ make · 1 line · in /srv/app",
		"✓ $ make install · 1 line",
		"✓ edit a.ts · +1 -1",
		"✓ $ make clean · 1 line",
		"✓ $ make · 1 line · in .",
		"✓ $ make · 1 line · in /srv/web",
	]);
});

test("a failure, a write and an edit show as soon as they end, and stay", () => {
	const s = session();
	s.step([ran("npm run lint", "Error: boom\n\nCommand exited with code 1", { isError: true })]);
	assert.deepEqual(s.screen(), ["", "✗ $ npm run lint · exit 1", "Error: boom"]);
	s.step([edited, ["write", { path: "b.ts", content: "one\ntwo\n" }, { content: text("ok") }]]);
	const kept = ["", "✗ $ npm run lint · exit 1", "Error: boom", "", "✓ edit a.ts · +1 -1", "✓ write b.ts · 2 lines"];
	assert.deepEqual(s.screen(), kept);
	s.step([ran("make", "ok")]);
	s.stop();
	assert.deepEqual(s.screen(), [...kept, "✓ $ make · 1 line"], "a stopped run shows its last step");
	handlers.message_start({ message: { role: "user" } });
	s.reply("Done.");
	assert.deepEqual(s.screen(), [...kept, "✓ $ make · 1 line"], "the next prompt changes nothing above it");
});

test("control characters in a command, a path or output do not reach the screen", () => {
	const raw = (lines: string[]) => lines.some((line) => /[\x00-\x08\x0b-\x1f\x7f]/.test(line));
	const failed = rawRow(
		"bash",
		{ command: "make\bx\x07" },
		{ content: text("spin\b\b\x07done\rok\nCommand exited with code 1"), isError: true },
	);
	assert.ok(!raw(failed), JSON.stringify(failed));
	assert.ok(
		failed.some((line) => line.includes("spindoneok")),
		"the printable text stays",
	);
	const place = rawRow("bash", { command: "cd /srv/a\x07b && make" }, { content: text("no"), isError: true });
	assert.ok(!raw(place) && place[0].includes("in /srv/ab"), JSON.stringify(place));
	const slot = widgetSlot();
	handlers.agent_start({}, slot.ctx);
	handlers.tool_execution_start({ toolCallId: "c", toolName: "bash", args: { command: "mak\x07e" } }, slot.ctx);
	handlers.tool_execution_end({ toolCallId: "c", toolName: "bash", result: { content: text("x") }, isError: true });
	handlers.agent_end({}, slot.ctx);
	assert.ok(!raw(slot.lines() ?? []) && slot.lines()?.[0].includes("✗ open: make"), JSON.stringify(slot.lines()));
	const read = rawRow("read", { path: "a\x07b\nc.ts" }, { content: text("ENOENT"), isError: true });
	assert.ok(!raw(read) && read[0].includes("read ab c.ts"), JSON.stringify(read));
});

test("a write or edit that failed and Pi draws ends the run of folded rows above it", () => {
	const failedEdit: [string, any, any] = [
		"edit",
		{ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] },
		{ content: text("oldText not found"), isError: true },
	];
	const s = session();
	s.step([ran("ls", "a"), failedEdit]);
	const screen = s.screen();
	assert.ok(screen.includes("✓ $ ls · 1 line"), screen.join("\n"));
	assert.ok(screen.includes("oldText not found"));
	const tally = screen.indexOf("✓ $ ls · 1 line");
	assert.ok(
		tally < screen.findIndex((line) => line.includes("oldText not found")),
		"the ls row stays above the failure",
	);
});

test("a call that changes nothing keeps no line once a step follows; a stretch that opens with such calls counts them", () => {
	const s = session();
	s.step([ran("ls", "a\nb"), ["read", { path: "a.ts" }, { content: text("one\ntwo") }]]);
	s.step([ran("npm test", "ok")]);
	assert.deepEqual(s.screen(), ["", "⋮ 2 calls, nothing changed"]);
	s.step([ran("make", "ok")]);
	assert.deepEqual(s.screen(), ["", "⋮ 3 calls, nothing changed"], "a passing check changes nothing either");
	s.step([ran("git status --short", "")]);
	assert.deepEqual(
		s.screen(),
		["", "⋮ 3 calls, nothing changed", "✓ $ make · 1 line"],
		"the count stays above later rows",
	);
	s.step([ran("ls", "a")]);
	assert.deepEqual(
		s.screen(),
		["", "⋮ 3 calls, nothing changed", "✓ $ make · 1 line"],
		"after a row with a line there is no count",
	);
	s.step([ran("rg -n foo src", "src/a.ts:1:foo")], "Now the search.");
	const spoken = ["", "⋮ 3 calls, nothing changed", "✓ $ make · 1 line", "✓ $ ls · 1 line"];
	assert.deepEqual(s.screen(), spoken, "a step that text follows shows with its line, also a lookup");
	s.step([ran("wc -l a.ts", "3 a.ts")]);
	assert.deepEqual(
		s.screen(),
		[...spoken, "", "⋮ 1 call, nothing changed"],
		"and keeps it when more steps follow: a line once drawn stays",
	);
	s.reply("Found it.");
	assert.deepEqual(
		s.screen(),
		[...spoken, "", "⋮ 1 call, nothing changed", "✓ $ wc -l a.ts · 1 line"],
		"as does the last step before the reply",
	);
});

test("only a command made of programs known to change nothing loses its line", () => {
	const kept = (command: string) => {
		const s = session();
		s.step([ran("make", "ok")]);
		s.step([ran(command, "x")]);
		s.step([ran("make", "ok")]);
		return s.screen().length === 3;
	};
	const nothing = [
		"rg -n foo src | head -5",
		"git status --short && git log --oneline -3",
		"cd /tmp/x && git -C ../y diff --stat 2>&1 | tail -3",
		"npm test",
		"npm run check --prefix extensions",
		"for f in a b; do wc -l $f; done",
		"N=$(ls | wc -l); echo $N",
		"python3 - <<'EOF'\nimport json\nprint(json.load(open('a.json'))['x'])\nEOF",
		"ls 2>/dev/null",
		"git branch --show-current",
		"gh pr view 12 --json state",
		"pi --help",
		"sed -n 3,9p a.ts",
		"npx tsc --noEmit -p .",
		"git branch -a --sort=-committerdate",
		"git reflog -5",
		"gh api repos/o/r/pulls/3 --jq .state",
		"ls &>/dev/null",
		"awk '{print $1}' a.txt | sort -u",
		"sed -n '3,9p;20p' a.ts | head -3",
		"sed -n '/^function a/,/^}/p' a.ts",
		"sed -nE '/a|b/p' a.ts",
		"git fetch -q origin",
		"git fetch origin main",
		"uv run --offline ruff check src",
		"shellcheck install.sh",
		"git diff main > /tmp/pr.diff",
		"mkdir -p /tmp/lab && npm test 2>&1 | tee /tmp/lab/test.log | tail -3",
		"sleep 2 & wait",
		"fd -e ts src",
	];
	const changes = [
		"npm install",
		"rm -rf build",
		"ls > out.txt",
		"git commit -m 'fix: x'",
		"git branch -D old",
		"gh pr merge 12",
		"find . -name '*.tmp' -delete",
		"sed -i '' s/a/b/ a.ts",
		"./deploy.sh",
		"echo $(rm a.ts)",
		"python3 - <<'EOF'\nopen('a.txt', 'w').write('x')\nEOF",
		"cat > a.txt <<'EOF'\nhello\nEOF",
		"npx biome check --write .",
		"env rm -rf build",
		"sed -n -i s/a/b/p a.ts",
		"find . -execdir rm {} +",
		"find . -fprint out.txt",
		"git fetch --prune",
		"git reflog expire --expire=now --all",
		"git branch --unset-upstream",
		"git log --output=log.txt",
		"gh api repos/o/r/issues -XPOST",
		"gh api repos/o/r/issues --raw-field title=x",
		"cat <(rm -rf x)",
		"ls &> out.txt",
		"sort -o out.txt in.txt",
		"uniq in.txt out.txt",
		"awk '{print > \"out.txt\"}' in.txt",
		"npx tsc -p .",
		"npm test -- -u",
		"sed -i.bak s/a/b/ a.ts",
		"sed 's/a/b/w out.txt' a.ts",
		"sed 's/a/b/' a.ts",
		"sed -n '1w out.txt' a.ts",
		"sed -n '1p' -i a.ts",
		"sed -n '/a/p' -e 'w out.txt' a.ts",
		"sed 's/.*/touch x/e' a.ts",
		"npm test | tee /tmp/log ~/.bashrc",
		"mkdir -p /tmp/x src/new",
		"git fetch --set-upstream origin main",
		"git fetch --unshallow",
		"git fetch origin tag v1",
		"shfmt -d -w a.sh",
		"ruff check --add-noqa src",
		"git fetch origin +main:main",
		"git fetch -p",
		"uv run ruff format src",
		"git diff main > pr.diff",
		"cp a.ts /tmp/a.ts",
		"cd /tmp/work && ls > /tmp/work/list.txt",
		"echo x > /tmp/../etc/hosts",
		"echo x > /tmp/$DIR/hosts",
		`ls > ${ROOT.replace(/^\/private/, "")}/list.txt`,
		"ls & rm -rf x",
		"fd -e tmp -x rm",
		"fd -e tmp -X rm",
		"fd -e tmp --exec rm",
		"npm run lint -- --fix",
		"cargo clippy --fix",
	];
	assert.deepEqual(nothing.filter(kept), [], "these change nothing");
	assert.deepEqual(
		changes.filter((command) => !kept(command)),
		[],
		"these may change something, as does any program not known",
	);
});

test("expanded rows are Pi's rendering, each on its own", () => {
	const s = session();
	s.step([ran("ls", "a")]);
	s.step([ran("pwd", "/x")]);
	s.step([ran("true", "")]);
	s.expand();
	const screen = s.screen();
	assert.ok(screen.includes("a") && screen.includes("/x"), "expanding shows the hidden output again");
	assert.equal(screen.filter((line) => line.startsWith("$ ")).length, 3, "also the step nothing has followed yet");
});

test("a resumed session folds the rows it draws from its history", () => {
	const call = (id: string, command: string) => ({ type: "toolCall", id, name: "bash", arguments: { command } });
	const branch = [
		{ type: "message", message: { role: "user", content: "go" } },
		{ type: "message", message: { role: "assistant", content: [call("old-1", "make")] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "old-1" } },
		{ type: "message", message: { role: "assistant", content: [call("old-2", "make test")] } },
	];
	const drawn = (id: string, command: string) => {
		const component = new ToolExecutionComponent(
			"bash",
			id,
			{ command },
			{},
			resolver("bash", () => PI.bash),
			UI,
			ROOT,
		);
		component.updateResult({ content: text("a\nb"), details: {}, isError: false }, false);
		return component.render(80).map((line: string) => stripVTControlCharacters(line).trim());
	};
	handlers.session_start({}, { isIdle: () => true, sessionManager: { getBranch: () => branch } });
	assert.deepEqual(drawn("old-1", "make"), ["", "✓ $ make · 2 lines"]);
	assert.deepEqual(
		drawn("old-2", "make test"),
		["", "✓ $ make · 2 lines", "✓ $ make test · 2 lines"],
		"the last step is shown",
	);
	handlers.session_start({}, { isIdle: () => false, sessionManager: { getBranch: () => branch } });
	assert.deepEqual(drawn("old-2", "make test"), [], "with a run under way, its last step is still held back");
});

test("a failed command folds once the same command passes on a later run", () => {
	const s = session();
	const failure = "Error: boom\n\nCommand exited with code 1";
	s.step([ran("make", failure, { isError: true })]);
	s.step([ran("touch a", "")]);
	s.step([ran("make", failure, { isError: true })]);
	assert.equal(s.screen().filter((line) => line === "Error: boom").length, 2, "both still open");
	s.step([ran("make", "ok")]);
	s.step([ran("true", "")]);
	assert.deepEqual(s.screen(), [
		"",
		"✗ $ make · exit 1 · passed later",
		"✓ $ touch a",
		"✗ $ make · exit 1 · passed later",
		"✓ $ make · 1 line",
	]);
	const other = session();
	other.step([ran("pytest tests/a.py 2>&1 | tail -20", failure, { isError: true })]);
	other.step([ran("pytest tests/a.py 2>&1 | tail -20", "1 failed")]);
	other.step([ran("true", "")]);
	assert.ok(other.screen().includes("Error: boom"), "a piped run that passes proves nothing: tail passed, not pytest");
	other.step([ran("uv run --offline pytest tests/a.py", "1 passed")]);
	other.step([ran("pytest tests/b.py", "1 passed")]);
	other.step([ran("true", "")]);
	assert.deepEqual(
		other.screen(),
		[
			"",
			"✗ $ pytest tests/a.py · exit 1 · passed later",
			"✓ $ pytest tests/a.py · 1 line",
			"✓ $ uv run --offline pytest tests/a.py · 1 line",
		],
		"the same command with other plumbing or behind a runner settles it, and that passing run keeps its line",
	);
	const chain = session();
	chain.step([ran("./check.sh", failure, { isError: true })]);
	chain.step([ran("./check.sh; git status --short", "ok")]);
	chain.step([ran("cd sub && ./check.sh", "ok")]);
	chain.step([ran("./check.sh || true", "ok")]);
	chain.step([ran("true", "")]);
	assert.ok(
		chain.screen().includes("Error: boom"),
		"a part that may have failed unseen, or ran elsewhere, proves nothing",
	);
	chain.step([ran("./check.sh 2>&1 && git diff --check && git status --short", "ok")]);
	chain.step([ran("true", "")]);
	const settled = chain.screen();
	assert.equal(settled[1], "✗ $ ./check.sh · exit 1 · passed later", "each command of a passing && chain passed");
	assert.match(
		settled.at(-1) ?? "",
		/^✓ \$ \.\/check\.sh .*&& git status --short · 1 line$/,
		"and the chain keeps its line",
	);
});

test("a failed command that has scrolled away keeps its output when the command passes", (t) => {
	const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	Object.defineProperty(process.stdout, "rows", { value: 28, configurable: true });
	t.after(() => {
		if (rows) Object.defineProperty(process.stdout, "rows", rows);
		else delete (process.stdout as any).rows;
	});
	const failure = "Error: boom\n\nCommand exited with code 1";
	const near = session();
	near.step([ran("make", failure, { isError: true })]);
	near.step([ran("touch a", "")]);
	near.step([ran("make", "ok")]);
	near.step([ran("true", "")]);
	assert.deepEqual(
		near.screen(),
		["", "✗ $ make · exit 1 · passed later", "✓ $ touch a", "✓ $ make · 1 line"],
		"still on screen, it shrinks",
	);
	const far = session();
	far.step([ran("make", failure, { isError: true })]);
	for (let i = 0; i < 30; i++) far.step([ran(`touch ${i}`, "")]);
	const before = far.screen();
	far.step([ran("make", "ok")]);
	far.step([ran("true", "")]);
	assert.deepEqual(far.screen().slice(0, before.length), before, "no line above the bottom of the screen changed");
	assert.equal(far.screen().at(-1), "✓ $ make · 1 line", "the passing run shows below");
	const folded = session();
	folded.step([ran("make", failure, { isError: true })]);
	folded.step(Array.from({ length: 20 }, (_, i) => ran(`ls ${i}`, "a")));
	folded.step([ran("make", "ok")]);
	folded.step([ran("true", "")]);
	assert.equal(
		folded.screen()[1],
		"✗ $ make · exit 1 · passed later",
		"calls folded into a count line take no rows of their own",
	);
	const spoken = session();
	spoken.step([ran("make", failure, { isError: true })]);
	spoken.reply(Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"));
	spoken.step([ran("make", "ok")]);
	spoken.step([ran("true", "")]);
	assert.ok(spoken.screen().includes("Error: boom"), "text below the row counts toward the screen as well");
});

test("only the first pass after a failure keeps its line; later passes change nothing again", () => {
	const failure = "Error: boom\n\nCommand exited with code 1";
	const s = session();
	s.step([ran("npm test", failure, { isError: true })]);
	s.step([ran("npm test", "ok")]);
	s.step([ran("npm test", "ok")]);
	s.step([ran("true", "")]);
	const screen = s.screen();
	assert.equal(screen.filter((line) => line === "✓ $ npm test · 1 line").length, 1, screen.join("\n"));
});

test("a row a tool with its own shell drew counts by its lines, so a failure above it still shrinks", (t) => {
	const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	Object.defineProperty(process.stdout, "rows", { value: 60, configurable: true });
	t.after(() => {
		if (rows) Object.defineProperty(process.stdout, "rows", rows);
		else delete (process.stdout as any).rows;
	});
	PI.mark = {
		renderShell: "self",
		renderCall: () => ({ invalidate() {}, render: () => [" ▸ a step"] }),
		renderResult: () => ({ invalidate() {}, render: () => [] }),
	};
	const s = session();
	s.step([ran("make", "Error: boom\n\nCommand exited with code 1", { isError: true })]);
	s.step([["mark", {}, { content: text("ok") }]]);
	s.step([ran("make", "ok")]);
	s.step([ran("true", "")]);
	assert.ok(s.screen().includes("✗ $ make · exit 1 · passed later"), s.screen().join("\n"));
});

/** A stand-in for Pi's widget slot: `lines()` is what the slot shows at 60 columns. */
function widgetSlot() {
	const theme = { fg: (_role: string, value: string) => value, bold: (value: string) => value };
	let content: any;
	let redraws = 0;
	const ui = {
		theme,
		setWidget(_key: string, next: any) {
			content?.dispose?.();
			content = typeof next === "function" ? next({ requestRender: () => redraws++ }, theme) : next;
		},
	};
	return {
		ctx: { hasUI: true, cwd: ROOT, ui },
		redraws: () => redraws,
		lines: (): string[] | undefined =>
			(Array.isArray(content) ? content : content?.render(60))?.map((line: string) =>
				stripVTControlCharacters(line).trimEnd(),
			),
	};
}

test("while the agent works, three lines above the editor show its last calls and the running one's time", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"] });
	const slot = widgetSlot();
	const start = (toolCallId: string, toolName: string, args: any, more = {}) =>
		handlers.tool_execution_start({ toolCallId, toolName, args, ...more }, slot.ctx);
	const end = (toolCallId: string, toolName: string, output: string, more = {}) =>
		handlers.tool_execution_end({ toolCallId, toolName, result: { content: text(output) }, isError: false, ...more });

	handlers.agent_start({}, slot.ctx);
	assert.equal(slot.lines(), undefined, "nothing before the first call");
	start("1", "bash", { command: "make" });
	assert.deepEqual(slot.lines(), ["", "", " ● $ make"], "blank lines keep the height at three");
	t.mock.timers.tick(12_000);
	assert.ok(slot.redraws() >= 12, "the area redraws every second");
	assert.deepEqual(slot.lines(), ["", "", " ● $ make · 12s"]);
	handlers.tool_execution_update({ toolCallId: "1", partialResult: { content: text("step 1\nstep 2\nstep 3") } });
	assert.deepEqual(slot.lines(), [" ● $ make · 12s", " │ step 2", " │ step 3"], "with the end of its output");
	end("1", "bash", "step 1\nstep 2\nstep 3", { durationMs: 12_300 });
	assert.deepEqual(
		slot.lines(),
		[" ✓ $ make · 3 lines · 12.3s", " │ step 2", " │ step 3"],
		"the newest call keeps the end of its output once it is done",
	);

	start("2", "read", { path: join(ROOT, "a.ts") });
	start("3", "bash", { command: "npm test" });
	start("nested", "bash", { command: "ls" }, { parentToolCallId: "3" });
	end("2", "read", "one\ntwo");
	assert.deepEqual(
		slot.lines(),
		[" ✓ $ make · 3 lines · 12.3s", " ✓ read a.ts · 2 lines", " ● $ npm test"],
		"a call made by another tool is left out",
	);
	end("3", "bash", "Error: boom\n\nCommand exited with code 1", { isError: true });
	start("4", "edit", { path: join(ROOT, "a.ts") });
	end("4", "edit", "ok");
	assert.deepEqual(
		slot.lines(),
		["", " ✓ $ make · 3 lines · 12.3s", " ✓ read a.ts · 2 lines"],
		"a failure and an edit are in the transcript once they end",
	);
	// The next message starts: the transcript now has the rows of the step before it.
	const calls = ["1", "2", "3", "4"].map((id) => ({ type: "toolCall", id, name: "bash", arguments: {} }));
	const next = { type: "toolCall", id: "5", name: "bash", arguments: { command: "git status" } };
	handlers.session_start({}, IDLE);
	for (const content of [calls, [next]]) {
		handlers.message_start({ message: { role: "assistant", content } });
		handlers.message_end({ message: { role: "assistant", content } });
	}
	start("5", "bash", { command: "git status" });
	assert.deepEqual(slot.lines(), ["", "", " ● $ git status"], "a call leaves the area when its row is drawn");

	const before = slot.redraws();
	handlers.agent_end({}, slot.ctx);
	t.mock.timers.tick(5_000);
	assert.equal(slot.redraws(), before, "the stopped area no longer redraws");
	assert.deepEqual(
		slot.lines(),
		["✗ open: npm test · exit 1 · 1 file changed · 5 calls · 12.0s"],
		"the receipt takes its place",
	);
	handlers.agent_start({}, slot.ctx);
	assert.equal(slot.lines(), undefined, "a new run clears the receipt");
});

test("when the agent stops, one line sums up the run: open failures, files changed, calls, time", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"] });
	const slot = widgetSlot();
	const call = (id: string, toolName: string, args: any, isError = false) => {
		handlers.tool_execution_start({ toolCallId: id, toolName, args }, slot.ctx);
		handlers.tool_execution_end({ toolCallId: id, toolName, result: { content: [] }, isError });
	};

	handlers.agent_start({}, slot.ctx);
	handlers.agent_end({}, slot.ctx);
	assert.equal(slot.lines(), undefined, "a run without a call has no receipt");

	handlers.agent_start({}, slot.ctx);
	call("1", "bash", { command: "npm test" }, true);
	call("2", "edit", { path: "a.ts" });
	call("3", "edit", { path: "a.ts" });
	call("4", "write", { path: "b.ts" });
	call("5", "bash", { command: "npm run lint" }, true);
	call("6", "bash", { command: "npm test" });
	t.mock.timers.tick(72_000);
	handlers.agent_end({}, slot.ctx);
	assert.deepEqual(slot.lines(), ["✗ open: npm run lint · 2 files changed · 6 calls · 1m 12s"]);

	handlers.agent_start({}, slot.ctx);
	const failed = (id: string, command: string, code: number) => {
		handlers.tool_execution_start({ toolCallId: id, toolName: "bash", args: { command } }, slot.ctx);
		const result = { content: text(`boom\n\nCommand exited with code ${code}`) };
		handlers.tool_execution_end({ toolCallId: id, toolName: "bash", result, isError: true });
	};
	failed("7", "make", 2);
	failed("8", `pytest ${"tests/a_long_name.py ".repeat(4)}2>&1 | tail -5`, 1);
	handlers.agent_end({}, slot.ctx);
	assert.deepEqual(
		slot.lines(),
		["✗ open: pytest tests/a_long_n…ng_name.py · exit 1 (+1 more) · 2 calls · 0.0s"],
		"the newest open failure is named with its exit code, cut in the middle; the others are counted",
	);

	handlers.agent_start({}, slot.ctx);
	call("r", "read", { path: "missing.ts" }, true);
	handlers.tool_execution_start({ toolCallId: "g", toolName: "bash", args: { command: "rg nothing src" } }, slot.ctx);
	const none = { content: text("(no output)\n\nCommand exited with code 1") };
	handlers.tool_execution_end({ toolCallId: "g", toolName: "bash", result: none, isError: true });
	handlers.tool_execution_start(
		{ toolCallId: "n", toolName: "bash", args: { command: "x" }, parentToolCallId: "p" },
		slot.ctx,
	);
	handlers.tool_execution_end({
		toolCallId: "n",
		toolName: "bash",
		result: { content: [] },
		isError: true,
		parentToolCallId: "p",
	});
	handlers.agent_end({}, slot.ctx);
	assert.deepEqual(
		slot.lines(),
		["2 calls · 0.0s"],
		"a lookup that found nothing, and a call made inside another tool, leave nothing open",
	);

	handlers.agent_start({}, slot.ctx);
	failed("9", "./check.sh", 1);
	call("10", "bash", { command: "./check.sh; git status" });
	handlers.agent_end({}, slot.ctx);
	assert.deepEqual(
		slot.lines(),
		["✗ open: ./check.sh · exit 1 · 2 calls · 0.0s"],
		"after `;` it may have failed unseen",
	);
	handlers.agent_start({}, slot.ctx);
	failed("11", "./check.sh", 1);
	call("12", "bash", { command: "./check.sh && git diff --check" });
	handlers.agent_end({}, slot.ctx);
	assert.deepEqual(slot.lines(), ["2 calls · 0.0s"], "a passing && chain settles each of its commands");
	const unproven = [
		"./check.sh |& cat && true",
		"./check.sh &> /dev/null && true",
		"echo $(./check.sh) && ./check.sh",
		"echo `date` && ./check.sh",
		"true &&\n./check.sh",
		"./check.sh & wait && true",
		"source env.sh && ./check.sh",
		"export CI=1 && ./check.sh",
		"git stash && ./check.sh",
	];
	for (const [index, command] of unproven.entries()) {
		handlers.agent_start({}, slot.ctx);
		failed(`f${index}`, "./check.sh", 1);
		call(`p${index}`, "bash", { command });
		handlers.agent_end({}, slot.ctx);
		assert.match(slot.lines()?.[0] ?? "", /^✗ open: \.\/check\.sh/, `${JSON.stringify(command)} settles nothing`);
	}
});

test("no row draws past a terminal narrower than its minimum room", () => {
	const rows = [
		rawRow(
			"bash",
			{ command: "make" },
			{ content: text("Error: boom\n\nCommand exited with code 2"), isError: true },
			{ width: 4 },
		),
		rawRow("bash", { command: "make" }, { content: text("step 1\nstep 2") }, { width: 4, partial: true }),
		rawRow("Skill", { name: "tdd" }, { content: text("loaded") }, { width: 4 }),
	];
	for (const lines of rows)
		assert.ok(
			lines.every((line) => visibleWidth(line) <= 4),
			JSON.stringify(lines),
		);
});
