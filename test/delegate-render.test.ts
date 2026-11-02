import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

// Pi sets up its theme before any tool renders; the Markdown theme needs it.
initTheme(undefined, false);

const { activityWidget, pickPersona, progressLines, renderCall, renderResult, SKIN_TONES } = await import(
	"../extensions/delegate-render.ts"
);

// Colours as real ANSI codes, so width checks measure only visible text.
const theme = { fg: (_color, text) => `\x1b[31m${text}\x1b[39m`, bold: (text) => `\x1b[1m${text}\x1b[22m` };
const bgAnsi = { toolPendingBg: "\x1b[44m", toolSuccessBg: "\x1b[42m", toolErrorBg: "\x1b[41m" };
const toolTheme = {
	...theme,
	bg: (color, text) => `${bgAnsi[color]}${text}\x1b[49m`,
};
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const draw = (component, width) => component.render(width).map(strip);
function assertFits(component, width) {
	for (const line of component.render(width))
		assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
}

const run = (over = {}) => ({
	model: "anthropic/claude-haiku-5-5",
	thinking: "low",
	web: false,
	done: true,
	turns: 2,
	cost: 0.0017,
	ms: 6000,
	output: "First line of the answer.\nSecond line with **detail**.",
	...over,
});
const long = "x".repeat(300);
// A random source that returns these values in turn.
const seq =
	(...values) =>
	() =>
		values.shift();
const CHEF = { emoji: "🧑🏽‍🍳", phrase: "letting him cook" };
const ELF = { emoji: "🧝🏻", phrase: "what do your elf-eyes see?" };

test("scouts are elves; other workers are chefs or farmers; every skin tone is reachable", () => {
	assert.deepEqual(
		SKIN_TONES.map((_, i) => pickPersona("scout", seq(i / 5)).emoji),
		["🧝🏻", "🧝🏼", "🧝🏽", "🧝🏾", "🧝🏿"],
	);
	assert.equal(pickPersona("scout", seq(0)).phrase, "what do your elf-eyes see?");
	assert.deepEqual(
		SKIN_TONES.map((_, i) => pickPersona("review", seq(i / 5, 0)).emoji),
		["🧑🏻‍🍳", "🧑🏼‍🍳", "🧑🏽‍🍳", "🧑🏾‍🍳", "🧑🏿‍🍳"],
	);
	assert.deepEqual(
		SKIN_TONES.map((_, i) => pickPersona("review", seq(i / 5, 0.99)).emoji),
		["🧑🏻‍🌾", "🧑🏼‍🌾", "🧑🏽‍🌾", "🧑🏾‍🌾", "🧑🏿‍🌾"],
	);
	for (const role of ["general", "review", "research", "challenge", "implement"]) {
		assert.deepEqual(pickPersona(role, seq(0.99, 0)), { emoji: "🧑🏿‍🍳", phrase: "letting him cook" });
		assert.deepEqual(pickPersona(role, seq(0, 0.5)), { emoji: "🧑🏻‍🌾", phrase: "doing honest work" });
	}
	for (let i = 0; i < 50; i++) {
		const { emoji } = pickPersona("review");
		assert.match(emoji, /^🧑[🏻🏼🏽🏾🏿]\u200d[🍳🌾]$/u);
	}
});

test("the activity widget is compact, bounded, themed, sanitized, and Unicode-width-safe", () => {
	const colors = [];
	const widgetTheme = {
		fg: (color, text) => {
			colors.push(color);
			return `\x1b[31m${text}\x1b[39m`;
		},
	};
	const startedAt = Date.now() - 2500;
	const rows = Array.from({ length: 6 }, (_, index) => ({
		id: "bg1",
		worker: index + 1,
		workerCount: 6,
		role: index === 0 ? "scout" : "review",
		model: "anthropic/claude-haiku-5-5",
		thinking: "low",
		startedAt,
		lastTool: index === 0 ? "read" : "grep",
		stage: index === 0 ? "Rebuttal" : "Workers",
		persona: index === 0 ? ELF : CHEF,
	}));
	const component = activityWidget(() => rows, widgetTheme);
	const lines = draw(component, 200);
	assert.equal(lines.length, 6, "heading, at most four workers, and overflow count");
	assert.match(
		lines[1],
		/^🧝🏻 bg1#1 scout R2 anthropic\/claude-haiku-5-5 @low 2s · read · what do your elf-eyes see\?$/,
	);
	assert.match(lines[4], /^🧑🏽‍🍳 bg1#4 review anthropic\/claude-haiku-5-5 @low 2s · grep · letting him cook$/);
	const withoutElapsed = (line) => line.replace(/@low \d+s/, "@low <elapsed>");
	assert.deepEqual(
		draw(component, 200).map(withoutElapsed),
		lines.map(withoutElapsed),
		"a rerender keeps each worker's persona",
	);
	assert.equal(lines[5], "… 2 more workers");
	assert.ok(colors.includes("warning") && colors.includes("accent") && colors.includes("muted"));
	assert.ok(colors.includes("dim") && colors.includes("toolTitle"));
	for (const width of [1, 2, 8, 14, 20, 40]) assertFits(component, width);
	assert.deepEqual(activityWidget(() => [], widgetTheme).render(80), []);

	const hostile = activityWidget(
		() => [
			{
				...rows[0],
				id: "call\u001b[31m\nsecond",
				model: "provider/model\u001b[2J",
				lastTool: "read\n",
			},
		],
		widgetTheme,
	);
	const hostileText = draw(hostile, 200).join("\n");
	assert.match(hostileText, /call second/);
	assert.doesNotMatch(hostileText, /\u001b/);
});

test("long native foreground IDs use compact labels so role, model, and thinking fit at 90 columns", () => {
	const nativeCallId = "call_01JAZ9M4X2F1D8B3C5E7|fc_01JAZ9M4X2F1D8B3C5E7";
	const component = activityWidget(
		() => [
			{
				id: nativeCallId,
				displayId: "fg1",
				worker: 1,
				workerCount: 1,
				role: "review",
				model: "openai-codex/gpt-6-luna",
				thinking: "low",
				startedAt: Date.now(),
				stage: "Workers",
				persona: { emoji: "🧑🏾‍🌾", phrase: "doing honest work" },
			},
		],
		theme,
	);
	const [row] = draw(component, 90).slice(1);
	assert.match(row, /🧑🏾‍🌾 fg1 review openai-codex\/gpt-6-luna @low/);
	assert.doesNotMatch(row, /call_|fc_/);
	assertFits(component, 90);
});

test("an implement call preview shows its check", () => {
	const call = renderCall({ role: "implement", task: "Add x", check: "npm test\nmore" }, theme);
	assert.deepEqual(draw(call, 200), ["delegate implement default check `npm test` Add x"]);
});

test("the call preview is one line: role, models with thinking, badges, the task's first line", () => {
	const call = renderCall(
		{
			task: "Find the bug\nwith more lines",
			web: true,
			rebuttal: true,
			output: true,
			runs: [{ model: "anthropic/claude-haiku-5-5", thinking: "low" }, { model: "anthropic/claude-sonnet-5-5" }],
		},
		theme,
	);
	assert.deepEqual(draw(call, 200), [
		"delegate general claude-haiku-5-5@low, claude-sonnet-5-5 [web, rebuttal, output] Find the bug",
	]);
	assert.deepEqual(draw(renderCall({ role: "scout", task: "x" }, theme), 200), ["delegate scout default x"]);
	// Arguments still streaming in.
	assert.deepEqual(draw(renderCall({}, theme), 200), ["delegate general default ..."]);
	for (const width of [10, 40]) assertFits(renderCall({ task: long, runs: [{ model: long }] }, theme), width);
});

test("truncation ellipses retain the pending, success, and error tool backgrounds", () => {
	const statuses = [
		{
			name: "pending",
			background: "toolPendingBg",
			component: () => renderCall({ task: long }, toolTheme, { isPartial: true, isError: false }),
		},
		{
			name: "success",
			background: "toolSuccessBg",
			component: () =>
				renderResult(
					{ content: [], details: { view: { stage: "Done", web: false, runs: [run({ output: long })] } } },
					{ expanded: false, isPartial: false },
					toolTheme,
					{ isPartial: false, isError: false },
				),
		},
		{
			name: "error",
			background: "toolErrorBg",
			component: () =>
				renderResult(
					{ content: [], details: { view: { stage: "Done", web: false, runs: [run({ failure: long })] } } },
					{ expanded: false, isPartial: false },
					toolTheme,
					{ isPartial: false, isError: true },
				),
		},
	];

	for (const { name, background, component: makeComponent } of statuses) {
		const component = makeComponent();
		const width = 80;
		const line = component.render(width)[0];
		assert.ok(line.includes(`\x1b[0m${bgAnsi[background]}...\x1b[49m\x1b[0m`), `${name}: ${JSON.stringify(line)}`);
		for (const bound of [1, 8, 40, width]) assertFits(component, bound);
	}

	const plainTheme = { fg: (_color, text) => text, bold: (text) => text };
	const plainLine = renderCall({ role: "scout", task: long }, plainTheme).render(40)[0];
	assert.equal(strip(plainLine), "delegate scout default xxxxxxxxxxxxxx...");
	assert.doesNotMatch(plainLine, /\x1b\[(?:41|42|44)m/);
});

test("progress shows the stage and one line per run; the plain text is what non-TUI modes get", () => {
	const view = {
		stage: "Rebuttal",
		web: true,
		runs: [
			run({ done: false, lastTool: "read src/a.ts", persona: CHEF }),
			run({ done: false, model: "anthropic/claude-sonnet-5-5", thinking: "off", persona: ELF }),
			run({ failure: "exit 1", persona: CHEF }),
			run({ persona: CHEF }),
		],
	};
	assert.deepEqual(progressLines(view), [
		"Rebuttal [web]",
		"🧑🏽‍🍳 claude-haiku-5-5 @low turn 2 $0.0017 read src/a.ts · letting him cook",
		"🧝🏻 claude-sonnet-5-5 @off turn 2 $0.0017 · what do your elf-eyes see?",
		"✗ claude-haiku-5-5 @low turn 2 $0.0017",
		"✓ claude-haiku-5-5 @low turn 2 $0.0017",
	]);
	assert.doesNotMatch(progressLines(view).join("\n"), /--\*/);
	const partial = renderResult({ content: [], details: { view } }, { expanded: false, isPartial: true }, theme);
	assert.deepEqual(draw(partial, 200), progressLines(view));
	for (const width of [8, 30]) assertFits(partial, width);
});

test("expanded partial progress shows bounded per-run activity while collapsed progress stays compact", () => {
	const view = {
		stage: "Workers",
		web: false,
		runs: [
			run({
				model: "provider/worker-a",
				thinking: "high",
				done: false,
				turns: 1,
				lastTool: "read",
				activity: ["grep", "read"],
				output: "ANSWER_SECRET",
			}),
			run({
				model: "provider/worker-b",
				thinking: "low",
				failure: "exit 1",
				lastTool: "web_search",
				activity: ["web_search"],
			}),
		],
	};
	const collapsed = renderResult({ content: [], details: { view } }, { expanded: false, isPartial: true }, theme);
	assert.deepEqual(draw(collapsed, 200), [
		"Workers",
		"🧑‍🍳 worker-a @high turn 1 $0.0017 read",
		"✗ worker-b @low turn 2 $0.0017 web_search",
	]);
	const expanded = renderResult({ content: [], details: { view } }, { expanded: true, isPartial: true }, theme);
	assert.deepEqual(draw(expanded, 200), [
		"Workers",
		"🧑‍🍳 worker-a @high turn 1 $0.0017 read",
		"  grep",
		"  read",
		"✗ worker-b @low turn 2 $0.0017 web_search",
		"  web_search",
	]);
	assert.doesNotMatch(draw(expanded, 200).join("\n"), /ANSWER_SECRET/);
	for (const width of [8, 20, 40]) assertFits(expanded, width);

	const unusual = renderResult(
		{
			content: [],
			details: { view: { ...view, runs: [run({ done: false, lastTool: "🚀\nread", activity: ["工具 e\u0301"] })] } },
		},
		{ expanded: true, isPartial: true },
		theme,
	);
	for (const width of [1, 8, 20]) assertFits(unusual, width);
});

test("a collapsed result has one line per run, its first answer line or its problem, and the footer", () => {
	const view = {
		stage: "Done",
		web: true,
		runs: [
			run({ web: true }),
			run({ failure: "stopped: timeout after 300s", output: "partial" }),
			run({ round2Failure: "rate limited" }),
			run({ outDir: "/tmp/out", files: ["a.md (3 B)", "b.md (4 B)"] }),
			run({ output: "" }),
			run({ output: "## **Bold** and `code`\nmore" }),
		],
		footer: "Total: 5 runs, $0.0085.",
	};
	const result = renderResult({ content: [], details: { view } }, { expanded: false, isPartial: false }, theme);
	assert.deepEqual(draw(result, 200), [
		"✓ claude-haiku-5-5 @low web $0.0017 6s First line of the answer.",
		"✗ claude-haiku-5-5 @low $0.0017 6s stopped: timeout after 300s",
		"✗ claude-haiku-5-5 @low $0.0017 6s round 2 failed: rate limited (round-1 answer kept)",
		"✓ claude-haiku-5-5 @low $0.0017 6s · 2 files First line of the answer.",
		"✓ claude-haiku-5-5 @low $0.0017 6s (empty answer)",
		"✓ claude-haiku-5-5 @low $0.0017 6s Bold and code",
		"Total: 5 runs, $0.0085.",
	]);
	for (const width of [12, 50]) assertFits(result, width);
});

test("an expanded result shows each answer as Markdown, its problem, and its files, within the width", () => {
	const view = {
		stage: "Done",
		web: false,
		runs: [
			run({ output: `# Findings\n\n- ${long}` }),
			run({ round2Failure: "rate limited", outDir: `/tmp/${long}`, files: [] }),
		],
		footer: `Round-1 answers: /tmp/${long}`,
	};
	const result = renderResult({ content: [], details: { view } }, { expanded: true, isPartial: false }, theme);
	const text = draw(result, 60).join("\n");
	assert.match(text, /^✓ claude-haiku-5-5 @low \$0\.0017 6s\n/);
	assert.match(text, /Findings/);
	assert.ok(text.includes("x".repeat(40)), "the long answer is wrapped, not cut");
	assert.match(text, /round 2 failed: rate limited \(round-1 answer kept\)/);
	// The long directory path wraps instead of being cut.
	assert.ok(text.replace(/\s/g, "").includes(`Filesin/tmp/${long}:nonewritten`), text);
	assert.match(text, /Round-1 answers:/);
	for (const width of [20, 60]) assertFits(result, width);
});

test("results without a view (refused calls, older sessions) show their text", () => {
	const result = renderResult(
		{ content: [{ type: "text", text: "role must be one of general\nsecond" }] },
		{ expanded: false, isPartial: false },
		theme,
	);
	assert.deepEqual(
		draw(result, 200).map((l) => l.trimEnd()),
		["role must be one of general", "second"],
	);
	assertFits(result, 10);

	const lines = ["1", "2", "3", "4", "5", "6", "7", long].join("\n");
	const many = (expanded) =>
		renderResult({ content: [{ type: "text", text: lines }] }, { expanded, isPartial: false }, theme);
	assert.deepEqual(
		draw(many(false), 200).map((l) => l.trimEnd()),
		["1", "2", "3", "4", "5", "\u2026 (3 more lines)"],
	);
	const expanded = draw(many(true), 40).join("");
	assert.ok(expanded.replace(/\s/g, "").endsWith(long), "expanded wraps long lines instead of cutting them");
	assertFits(many(true), 40);
});

test("line breaks inside a single line are flattened; previews skip code fences", () => {
	const view = {
		stage: "Done",
		web: false,
		runs: [run({ failure: "exit 1: first\nsecond\rthird" }), run({ output: "```ts\nconst x = 1;\n```" })],
	};
	const result = renderResult({ content: [], details: { view } }, { expanded: false, isPartial: false }, theme);
	const raw = result.render(200);
	assert.equal(raw.length, 2);
	assert.ok(
		raw.every((l) => !/[\r\n]/.test(l)),
		JSON.stringify(raw),
	);
	assert.deepEqual(draw(result, 200), [
		"\u2717 claude-haiku-5-5 @low $0.0017 6s exit 1: first second third",
		"\u2713 claude-haiku-5-5 @low $0.0017 6s const x = 1;",
	]);
	const progress = renderResult(
		{
			content: [],
			details: { view: { ...view, stage: "Workers", runs: [run({ done: false, lastTool: "grep a\nb" })] } },
		},
		{ expanded: false, isPartial: true },
		theme,
	);
	assert.deepEqual(draw(progress, 200), ["Workers", "🧑‍🍳 claude-haiku-5-5 @low turn 2 $0.0017 grep a b"]);
});
