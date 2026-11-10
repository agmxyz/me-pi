import assert from "node:assert/strict";
import test from "node:test";

const { default: registerSteps } = await import("../extensions/steps.ts");

// Register against a fake Pi in TUI mode; `show()` renders the widget as plain text.
function setup() {
	let tool: any;
	let widget: any;
	const handlers: Record<string, ((event: any, ctx: any) => void)[]> = {};
	registerSteps({
		on: (event: string, handler: any) => {
			handlers[event] ??= [];
			handlers[event].push(handler);
		},
		registerTool: (definition: any) => {
			tool = definition;
		},
	} as any);
	const ui = {
		setWidget: (_key: string, factory: any) => {
			widget = factory?.(null, { fg: (_color: string, text: string) => text });
		},
	};
	const ctx = { mode: "tui", ui, sessionManager: { getBranch: () => [] } };
	const fire = (event: string, payload: any = {}) => {
		for (const handler of handlers[event] ?? []) handler(payload, ctx);
	};
	fire("session_start");
	return {
		show: () => (widget ? widget.render(100).join("\n") : "(hidden)"),
		plan: (params: any) => tool.execute("p", params),
		prompt: () => {
			fire("before_agent_start");
			fire("agent_start");
		},
		toolStart: (id: string, toolName: string, args: any = {}) =>
			fire("tool_execution_start", { toolCallId: id, toolName, args }),
		toolEnd: (id: string) => fire("tool_execution_end", { toolCallId: id }),
		end: (stopReason = "stop") => fire("agent_end", { messages: [{ role: "assistant", stopReason }] }),
	};
}

test("a running plan shows every step with the current one marked", async () => {
	const s = setup();
	s.prompt();
	await s.plan({ steps: ["A", "B", "C"] });
	s.toolStart("b", "bash", { command: "git status --short && ls" });
	assert.equal(s.show(), "● A · Running git status --short\n○ B\n○ C");
});

test("activity follows the tool still running when plan runs beside it", async () => {
	const s = setup();
	s.prompt();
	s.toolStart("p", "plan");
	await s.plan({ steps: ["A", "B"] });
	s.toolStart("b", "bash", { command: "sleep 8; git log" });
	s.toolEnd("p");
	assert.equal(s.show().split("\n")[0], "● A · Running sleep 8; git");
	s.toolEnd("b");
	assert.equal(s.show().split("\n")[0], "● A · Thinking…");
});

test("a plan paused with steps left shows as paused, not done", async () => {
	const s = setup();
	s.prompt();
	await s.plan({ steps: ["A", "B", "C", "D", "E"] });
	await s.plan({ done: 2 });
	s.end();
	assert.equal(s.show(), "◐ 2/5 · next: C");
});

test("a new prompt hides an earlier plan until the model calls plan again", async () => {
	const s = setup();
	s.prompt();
	await s.plan({ steps: ["A", "B", "C", "D", "E"] });
	await s.plan({ done: 2 });
	s.end();
	s.prompt();
	assert.equal(s.show(), "Thinking…");
	s.toolStart("r", "read", { path: "/x/y.ts" });
	assert.equal(s.show(), "Reading y.ts");
	s.end();
	assert.equal(s.show(), "◐ 2/5 · next: C");
	s.prompt();
	await s.plan({ done: 4 });
	assert.equal(s.show(), "✓ A\n✓ B\n✓ C\n✓ D\n● E · Thinking…");
});

test("a normal end completes the plan only when the last step is left", async () => {
	const s = setup();
	s.prompt();
	await s.plan({ steps: ["A", "B", "C"] });
	await s.plan({ done: 2 });
	s.end();
	assert.equal(s.show(), "✓ 3/3 steps");
	s.prompt();
	assert.equal(s.show(), "Thinking…");
});

test("an aborted run keeps the real count", async () => {
	const s = setup();
	s.prompt();
	await s.plan({ steps: ["X", "Y", "Z"] });
	await s.plan({ done: 2 });
	s.end("aborted");
	assert.equal(s.show(), "◐ 2/3 · next: Z");
});
