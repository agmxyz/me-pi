import assert from "node:assert/strict";
import test from "node:test";
import {
	bgCtx,
	CTX,
	commandCtx,
	fallbackAuthorization,
	HAIKU,
	LUNA,
	OPUS,
	POOL_SET,
	run,
	SONNET,
	setup,
	text,
	trackIntervals,
	tuiCtx,
	waitFor,
} from "./helpers/delegate-harness.ts";

test(
	"the TUI widget shows coalesced foreground and background tool activity by stable ID without payloads",
	{ timeout: 10000 },
	async (t) => {
		const { tool, messages } = setup(t, {
			config: POOL_SET,
			env: { FAKE_PI_MODE: "tool-activity", FAKE_PI_ACTIVITY_DELAY: "1200" },
		});
		const intervals = trackIntervals(t);
		const ui = tuiCtx();
		const first = await run(
			tool,
			{ role: "scout", task: "PRIVATE_TASK_ONE", runs: [{ model: HAIKU }], background: true },
			undefined,
			undefined,
			ui.ctx,
		);
		assert.match(text(first), /^Started background job bg1 /);
		const second = await run(
			tool,
			{ role: "research", task: "PRIVATE_TASK_TWO", runs: [{ model: OPUS }], background: true },
			undefined,
			undefined,
			ui.ctx,
		);
		assert.match(text(second), /^Started background job bg2 /);

		let foregroundDone = false;
		const foreground = tool
			.execute(
				"call-foreground-9",
				{ role: "review", task: "PRIVATE_TASK_THREE", runs: [{ model: LUNA, thinking: "low" }] },
				undefined,
				undefined,
				ui.ctx,
			)
			.then((result) => {
				foregroundDone = true;
				return result;
			});
		await waitFor(
			() => {
				const panel = ui.widget().join("\n");
				return (
					panel.includes("bg1 scout anthropic/claude-haiku-5-5 @off") &&
					panel.includes("bg2 research anthropic/claude-opus-5-5 @max") &&
					panel.includes("fg1 review openai-codex/gpt-6-luna @low") &&
					panel.includes("read") &&
					panel.includes("grep")
				);
			},
			"widget tool-start updates before turn completion",
			2000,
		);
		assert.equal(foregroundDone, false, "foreground tool call is still waiting on its answer");
		const live = ui.widget().join("\n");
		assert.doesNotMatch(
			live,
			/PRIVATE_(?:TASK_ONE|TASK_TWO|TASK_THREE|ARGUMENT|COMMAND|OUTPUT|REASONING|STDERR)|activity answer|stderr/i,
		);
		assert.equal(ui.widget().length, 4, "one heading and three active worker rows");
		assert.deepEqual([...intervals.values()], [1000], "one TUI-only elapsed timer for the active panel");
		const timer = [...intervals.keys()][0];
		const rendersBeforeTick = ui.requests.length;
		timer.callback();
		assert.equal(ui.requests.length, rendersBeforeTick + 1, "each one-second tick refreshes elapsed time");

		assert.equal((await foreground).isError, false);
		await waitFor(() => messages.length === 2, "both background answers");
		assert.deepEqual(ui.widget(), [], "the widget hides when every worker is idle");
		assert.equal(intervals.size, 0, "completion clears the elapsed timer");
	},
);

test("each worker keeps one persona across progress, widget rerenders, and the rebuttal round", async (t) => {
	// Math.random is the randomness seam: per worker, one skin tone, then (non-scouts) chef or farmer.
	const draws = [0, 0, 0.99, 0.9];
	t.mock.method(Math, "random", () => draws.shift() ?? 0.5);
	const { tool } = setup(t, {
		config: { models: [HAIKU, OPUS] },
		env: { FAKE_PI_MODE: "tool-activity", FAKE_PI_ACTIVITY_DELAY: "300" },
	});
	const ui = tuiCtx();
	const updates = [];
	const result = await run(
		tool,
		{ role: "review", task: "personas", runs: [{ model: HAIKU }, { model: OPUS }], rebuttal: true },
		undefined,
		(update) => updates.push(update),
		ui.ctx,
	);
	assert.equal(result.isError, false);
	const chef = { emoji: "🧑🏻‍🍳", phrase: "letting him cook" };
	const farmer = { emoji: "🧑🏿‍🌾", phrase: "doing honest work" };
	for (const update of updates)
		assert.deepEqual(
			update.details.view.runs.map((r) => r.persona),
			[chef, farmer],
		);
	assert.ok(
		updates.some((u) => u.details.view.stage === "Rebuttal"),
		"the rebuttal round reported progress",
	);
	const rows = ui.snapshots.flat().filter((line) => line.includes("#"));
	assert.ok(
		rows.some((line) => line.includes(" R2 ")),
		"the widget showed the rebuttal round",
	);
	for (const line of rows) {
		if (line.includes("#1 "))
			assert.match(line, /^🧑🏻‍🍳 fg1#1 review( R2)? anthropic\/claude-haiku-5-5 @\w+ .*· letting him cook$/u);
		else assert.match(line, /^🧑🏿‍🌾 fg1#2 review( R2)? anthropic\/claude-opus-5-5 @\w+ .*· doing honest work$/u);
	}
	assert.deepEqual(
		result.details.view.runs.map((r) => r.persona),
		[undefined, undefined],
		"completed runs show ✓/✗",
	);
});

test("a scout worker is an elf in progress and the widget", async (t) => {
	t.mock.method(Math, "random", () => 0.5);
	const { tool } = setup(t, { env: { FAKE_PI_MODE: "tool-activity", FAKE_PI_ACTIVITY_DELAY: "300" } });
	const ui = tuiCtx();
	const updates = [];
	const result = await run(tool, { role: "scout", task: "look" }, undefined, (u) => updates.push(u), ui.ctx);
	assert.equal(result.isError, false);
	const live = updates.find((u) => !u.details.view.runs[0].done);
	assert.match(live.content[0].text, /^🧝🏽 \S+ @\w+ turn \d+ .*· what do your elf-eyes see\?$/mu);
	const rows = ui.snapshots.flat().filter((line) => line.startsWith("🧝"));
	assert.ok(rows.length, "the widget showed the scout");
	for (const line of rows) assert.match(line, /^🧝🏽 fg1 scout .* @\w+ .*· what do your elf-eyes see\?$/u);
});

test("the elapsed timer stops between rebuttal rounds and restarts for active rows", async (t) => {
	const intervals = trackIntervals(t);
	const { tool } = setup(t, {
		config: { models: [HAIKU, OPUS] },
		env: { FAKE_PI_MODE: "tool-activity", FAKE_PI_ACTIVITY_DELAY: "300" },
	});
	const ui = tuiCtx();
	const pending = run(
		tool,
		{ role: "review", task: "timer lifecycle", runs: [{}, {}], rebuttal: true },
		undefined,
		undefined,
		ui.ctx,
	);
	await waitFor(() => intervals.started.length === 2, "the rebuttal timer restart");
	assert.deepEqual(intervals.cleared, [intervals.started[0]], "the idle round boundary cleared its timer");
	assert.equal(intervals.size, 1, "the second round owns one live timer");
	assert.ok(
		ui.widget().some((line) => line.includes("R2")),
		"the restarted widget shows rebuttal workers",
	);
	assert.equal((await pending).isError, false);
	assert.equal(intervals.size, 0, "the final idle state clears the restarted timer");
	assert.deepEqual(intervals.cleared, intervals.started);
});

test("concurrent foreground calls receive distinct compact widget labels", async (t) => {
	const { tool } = setup(t, {
		env: { FAKE_PI_MODE: "tool-activity", FAKE_PI_ACTIVITY_DELAY: "300" },
	});
	const ui = tuiCtx();
	const first = tool.execute(
		"call_01JAZ9M4X2F1D8B3C5E7|fc_01JAZ9M4X2F1D8B3C5E7",
		{ role: "review", task: "first foreground" },
		undefined,
		undefined,
		ui.ctx,
	);
	const second = tool.execute(
		"call_01JAZ9M4X2F1D8B3C5E8|fc_01JAZ9M4X2F1D8B3C5E8",
		{ role: "research", task: "second foreground" },
		undefined,
		undefined,
		ui.ctx,
	);
	await waitFor(
		() =>
			ui.widget().some((line) => line.includes("fg1 review")) &&
			ui.widget().some((line) => line.includes("fg2 research")),
		"both foreground labels",
	);
	assert.equal((await first).isError, false);
	assert.equal((await second).isError, false);
});

test("the TUI widget keeps the first configured candidate after a provider retry", async (t) => {
	const { tool } = setup(t, {
		config: {
			version: 3,
			scout: { models: [], thinking: "low" },
			worker: {
				models: [
					{ model: HAIKU, thinking: "high" },
					{ model: SONNET, thinking: "low" },
				],
				thinking: "medium",
			},
		},
		env: { FAKE_PI_MODE: "rate-limit-model", FAKE_PI_FAIL_MODEL: HAIKU },
	});
	const ui = tuiCtx();
	const result = await run(
		tool,
		{ role: "review", task: "fallback widget", fallbackAuthorization: fallbackAuthorization([HAIKU, SONNET]) },
		undefined,
		undefined,
		ui.ctx,
	);
	assert.equal(result.isError, true);
	assert.ok(ui.snapshots.some((snapshot) => snapshot.some((line) => line.includes("claude-haiku-5-5 @high"))));
	assert.ok(
		ui.snapshots.every((snapshot) =>
			snapshot.every((line) => !line.includes("claude-sonnet-5-5 @low") && !line.includes("↻")),
		),
		"the disabled fallback never appears as a started worker",
	);
	assert.deepEqual(ui.widget(), [], "the final candidate completion hides the widget");
});

test("the TUI widget shows the rebuttal stage", async (t) => {
	const { tool } = setup(t, { config: { models: [HAIKU, OPUS] } });
	const ui = tuiCtx();
	const result = await run(
		tool,
		{ role: "review", task: "PRIVATE_REBUTTAL_TASK", runs: [{ model: HAIKU }, { model: OPUS }], rebuttal: true },
		undefined,
		undefined,
		ui.ctx,
	);
	assert.equal(result.isError, false);
	assert.ok(ui.snapshots.some((snapshot) => snapshot.some((line) => line.includes("R2"))));
	assert.doesNotMatch(ui.snapshots.flat().join("\n"), /PRIVATE_REBUTTAL_TASK|DONE model=/);
	assert.deepEqual(ui.widget(), [], "the widget hides after the rebuttal finishes");
});

test("the TUI widget cleans up on cancellation and session replacement", async (t) => {
	const intervals = trackIntervals(t);
	const main = setup(t, { env: { FAKE_PI_MODE: "hang" } });
	const ui = tuiCtx();
	const { tool, handlers, commands, messages } = main;
	await run(tool, { role: "scout", task: "cancel me", background: true }, undefined, undefined, ui.ctx);
	await waitFor(() => ui.widget().some((line) => line.includes("bg1 scout")), "background widget row");
	assert.equal(intervals.size, 1);
	await commands.delegate.handler("cancel bg1", commandCtx().ctx);
	await waitFor(() => messages.length === 1, "cancelled report");
	assert.deepEqual(ui.widget(), [], "cancellation hides the idle widget");
	assert.equal(intervals.size, 0, "cancellation clears the elapsed timer");

	await run(tool, { role: "scout", task: "session replacement", background: true }, undefined, undefined, ui.ctx);
	await waitFor(() => ui.widget().some((line) => line.includes("bg2 scout")), "second background widget row");
	assert.equal(intervals.size, 1);
	await handlers.session_shutdown({ reason: "new" });
	assert.deepEqual(ui.widget(), [], "session replacement removes the widget");
	assert.equal(intervals.size, 0, "session replacement clears the elapsed timer");
});

test("non-TUI worker execution creates no widget or elapsed timer", async (t) => {
	const intervals = trackIntervals(t);
	let widgetCalls = 0;
	const { tool } = setup(t, { env: { FAKE_PI_MODE: "tool-activity" } });
	const printCtx = {
		...CTX,
		mode: "print",
		ui: { setWidget: () => widgetCalls++ },
	};
	const printed = await run(tool, { role: "scout", task: "not interactive" }, undefined, undefined, printCtx);
	assert.equal(printed.isError, false);
	assert.equal(widgetCalls, 0, "print mode never touches setWidget");
	assert.equal(intervals.size, 0, "non-TUI calls create no timer");
});

test("background: returns a job id at once, then delivers the answer as a message that starts a turn", async (t) => {
	const { tool, messages } = setup(t);
	const { ctx, statuses } = bgCtx();
	const res = await run(tool, { role: "scout", task: "look around", background: true }, undefined, undefined, ctx);
	assert.equal(res.isError, undefined);
	assert.match(
		text(res),
		/^Started background job bg1 \(.+\)\. Its answer arrives as a later message; \/delegate cancel bg1 stops it\.$/,
	);
	await waitFor(() => messages.length === 1, "the background answer");
	const [{ message, options }] = messages;
	assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
	assert.equal(message.customType, "delegate");
	assert.equal(message.display, true);
	assert.match(message.content, /^Background delegate job bg1:\n\n/);
	assert.ok(message.details.view, "details keep the run view");
	assert.match(statuses[0][1], /^delegate bg: 1 running, \$0\.0000 spent$/);
	assert.match(statuses.at(-1)[1], /^delegate bg: 0 running, \$0\.0\d+ spent$/);
	assert.ok(!statuses.at(-1)[1].endsWith("$0.0000 spent"), "the job's cost is counted");
});

test("background: the turn's abort does not stop a job; /delegate cancel does, without starting a turn", async (t) => {
	const { tool, messages, commands } = setup(t, { env: { FAKE_PI_MODE: "hang" } });
	const turn = new AbortController();
	const { ctx } = bgCtx();
	await run(tool, { role: "scout", task: "x", background: true }, turn.signal, undefined, ctx);
	turn.abort();
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(messages.length, 0, "still running after the turn was aborted");
	const { ctx: cmd, notes } = commandCtx();
	await commands.delegate.handler("status", cmd);
	assert.match(notes[0][0], /Running \(1\):\n {2}bg1 scout: /);
	await commands.delegate.handler("cancel bg1", cmd);
	assert.equal(notes[1][0], "Cancelling background job bg1.");
	await waitFor(() => messages.length === 1, "the cancelled job's report");
	assert.deepEqual(messages[0].options, { triggerTurn: false, deliverAs: "followUp" });
	assert.match(messages[0].message.content, /^Background delegate job bg1 failed:\n\n✗ stopped: cancelled/);
	await commands.delegate.handler("cancel bg1", cmd);
	assert.equal(notes[2][0], "No running background job bg1.");
	await assert.rejects(commands.delegate.handler("cancel", cmd), /Usage: \/delegate cancel <id>/);
});

test("at most 4 workers run at once across foreground and background calls", async (t) => {
	const { tool, commands, messages } = setup(t, { env: { FAKE_PI_MODE: "hang" } });
	const { ctx } = bgCtx();
	await run(tool, { role: "scout", task: "x", runs: [{}, {}, {}], background: true }, undefined, undefined, ctx);
	const over = await run(tool, { role: "scout", task: "y", runs: [{}, {}] });
	assert.equal(over.isError, true);
	assert.match(text(over), /^3 worker\(s\) already running; at most 4 run at once\./);
	const second = await run(tool, { role: "scout", task: "z", background: true }, undefined, undefined, ctx);
	assert.match(text(second), /^Started background job bg2 /);
	const { ctx: cmd } = commandCtx();
	await commands.delegate.handler("cancel bg1", cmd);
	await commands.delegate.handler("cancel bg2", cmd);
	await waitFor(() => messages.length === 2, "both cancelled reports");
});

test("background: a job stopped by session shutdown delivers nothing; background must be a boolean", async (t) => {
	const { tool, handlers, messages } = setup(t, { env: { FAKE_PI_MODE: "hang" } });
	const { ctx } = bgCtx();
	await run(tool, { role: "scout", task: "x", background: true }, undefined, undefined, ctx);
	await handlers.session_shutdown();
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(messages.length, 0);
	const bad = await run(tool, { role: "scout", task: "x", background: "yes" });
	assert.equal(bad.isError, true);
	assert.equal(text(bad), "background must be true or false");
});

test("background spend survives /reload", async (t) => {
	const first = setup(t);
	await run(first.tool, { role: "scout", task: "x", background: true }, undefined, undefined, bgCtx().ctx);
	await waitFor(() => first.messages.length === 1, "the first answer");
	const reloaded = setup(t, { keepHistory: true });
	const { ctx, statuses } = bgCtx();
	await run(reloaded.tool, { role: "scout", task: "y", background: true }, undefined, undefined, ctx);
	assert.match(statuses[0][1], /^delegate bg: 1 running, \$0\.0\d+ spent$/);
	assert.ok(!statuses[0][1].endsWith("$0.0000 spent"), "the first job's spend is kept");
	await waitFor(() => reloaded.messages.length === 1, "the second answer");
});

test("background job ids do not repeat after /reload", async (t) => {
	const first = setup(t);
	const one = await run(first.tool, { role: "scout", task: "x", background: true }, undefined, undefined, bgCtx().ctx);
	assert.match(text(one), /^Started background job bg1 /);
	await waitFor(() => first.messages.length === 1, "the first answer");
	const reloaded = setup(t, { keepHistory: true });
	const two = await run(
		reloaded.tool,
		{ role: "scout", task: "y", background: true },
		undefined,
		undefined,
		bgCtx().ctx,
	);
	assert.match(text(two), /^Started background job bg2 /);
	await waitFor(() => reloaded.messages.length === 1, "the second answer");
});
