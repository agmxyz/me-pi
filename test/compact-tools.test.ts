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
	assert.deepEqual(lines, ["✓ $ npm test ⏎1 · 4.2s", "line 1", "⋮ 36 more lines", "line 38", "line 39", "line 40"]);
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
	const output = [...numbered(30).split("\n"), "Error: boom", ...numbered(8).split("\n")];
	const found = failed(`${output.join("\n")}\n\nCommand exited with code 1`);
	assert.deepEqual(
		found.slice(1, 4),
		["⋮ 30 more lines", "Error: boom", "line 1"],
		"kept from the first error-like line",
	);
	assert.equal(found.length, 11);
	const old = failed(`Error: early\n${numbered(40)}\n\nCommand exited with code 1`);
	assert.equal(old.length, 7, "an error line more than twenty lines back does not count");
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

test("an output line too long for the row is cut, unless it reads like an error: then it gets a second row", () => {
	const plain = row("bash", { command: "cat log" }, { content: text(`ok ${"x".repeat(200)}`) });
	assert.equal(plain.length, 2);
	assert.ok(plain[1].endsWith("…"));
	const output = `2026-11-19T09:36:02Z ${"step ".repeat(12)} ReferenceError: TOUR is not defined ${"y".repeat(200)}`;
	const error = row("bash", { command: "cat log" }, { content: text(output) });
	assert.equal(error.length, 3);
	assert.ok(error[2].includes("ReferenceError: TOUR is not defined") && error[2].endsWith("…"));
	const mention = row(
		"bash",
		{ command: "git log" },
		{ content: text(`c8f482c feat: a row for long error lines ${"z".repeat(200)}`) },
	);
	assert.equal(mention.length, 2, "a line that only mentions an error stays one row");
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
	assert.deepEqual(s.screen(), ["", "✓ $ npm install left-pad · 1 line", "", "✓ $ npm run build", "built"]);
});

test("a failure, a write and an edit show as soon as they end, and stay", () => {
	const s = session();
	s.step([ran("npm run lint", "Error: boom\n\nCommand exited with code 1", { isError: true })]);
	assert.deepEqual(s.screen(), ["", "✗ $ npm run lint · exit 1", "Error: boom"]);
	s.step([edited, ["write", { path: "b.ts", content: "one\ntwo\n" }, { content: text("ok") }]]);
	const kept = [
		"",
		"✗ $ npm run lint · exit 1",
		"Error: boom",
		"",
		"✓ edit a.ts · +1 -1",
		"-1 a",
		"+1 b",
		"",
		"✓ write b.ts · 2 lines",
	];
	assert.deepEqual(s.screen(), kept);
	s.step([ran("make", "ok")]);
	s.stop();
	assert.deepEqual(s.screen(), [...kept, "", "✓ $ make", "ok"], "a stopped run shows its last step");
	handlers.message_start({ message: { role: "user" } });
	s.reply("Done.");
	assert.deepEqual(s.screen(), [...kept, "", "✓ $ make", "ok"], "the next prompt changes nothing above it");
});

test("a call that changes nothing keeps no line once a step follows; a stretch of only such calls is a count", () => {
	const s = session();
	s.step([ran("ls", "a\nb"), ["read", { path: "a.ts" }, { content: text("one\ntwo") }]]);
	s.step([ran("npm test", "ok")]);
	assert.deepEqual(s.screen(), ["", "⋮ 2 calls"]);
	s.step([ran("make", "ok")]);
	assert.deepEqual(s.screen(), ["", "⋮ 3 calls"]);
	s.step([ran("git status --short", "")]);
	assert.deepEqual(s.screen(), ["", "✓ $ make · 1 line"], "beside a row that keeps its line there is no count");
	s.step([ran("rg -n foo src", "src/a.ts:1:foo")], "Now the search.");
	s.reply("Found it.");
	assert.deepEqual(
		s.screen(),
		["", "✓ $ make · 1 line", "", "✓ $ rg -n foo src", "src/a.ts:1:foo"],
		"the last step before the reply keeps its output",
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
	assert.deepEqual(drawn("old-2", "make test"), ["", "✓ $ make test", "│ a", "│ b"], "the last step is shown");
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
	assert.deepEqual(slot.lines(), ["", "", " ✓ $ make · 3 lines · 12.3s"]);

	start("2", "read", { path: join(ROOT, "a.ts") });
	start("3", "bash", { command: "npm test" });
	start("nested", "bash", { command: "ls" }, { parentToolCallId: "3" });
	end("2", "read", "one\ntwo");
	end("3", "bash", "Error: boom\n\nCommand exited with code 1", { isError: true });
	assert.deepEqual(
		slot.lines(),
		[" ✓ $ make · 3 lines · 12.3s", " ✓ read a.ts · 2 lines", " ✗ $ npm test · 1 line · exit 1"],
		"a call made by another tool is left out",
	);
	start("4", "bash", { command: "git status" });
	assert.deepEqual(slot.lines(), [" ✓ read a.ts · 2 lines", " ✗ $ npm test · 1 line · exit 1", " ● $ git status"]);

	const before = slot.redraws();
	handlers.agent_end({}, slot.ctx);
	t.mock.timers.tick(5_000);
	assert.equal(slot.redraws(), before, "the stopped area no longer redraws");
	assert.deepEqual(slot.lines(), ["✗ 1 failure open · 4 calls · 12.0s"], "the receipt takes its place");
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
	assert.deepEqual(slot.lines(), ["✗ 1 failure open · 2 files changed · 6 calls · 1m 12s"]);
});
