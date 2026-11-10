import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

// The on/off choice is saved under the agent dir: keep HOME, TMPDIR and the agent dir in a temp dir,
// never the real ~/.pi.
const ROOT = mkdtempSync(join(tmpdir(), "steps-test-"));
const AGENT_DIR = join(ROOT, "agent");
process.env.HOME = ROOT;
process.env.TMPDIR = ROOT;
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));
const SETTINGS = join(AGENT_DIR, "steps.json");

const { default: registerSteps } = await import("../extensions/steps.ts");

// Register against a fake Pi; `show()` renders the widget as plain text. `branch` is the session's entries.
function setup({ mode = "tui", branch = [] as any[] } = {}) {
	let tool: any;
	let widget: any;
	let renders = 0;
	const entries: any[] = [];
	let active = ["read", "bash"];
	const notes: string[] = [];
	const commands: Record<string, any> = {};
	const handlers: Record<string, ((event: any, ctx: any) => void)[]> = {};
	registerSteps({
		on: (event: string, handler: any) => {
			handlers[event] ??= [];
			handlers[event].push(handler);
		},
		registerTool: (definition: any) => {
			tool = definition;
			if (definition.defaultActive !== false) active = [...active, definition.name];
		},
		registerCommand: (name: string, options: any) => {
			commands[name] = options;
		},
		appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
	} as any);
	const ui = {
		setWidget: (_key: string, factory: any) => {
			widget?.dispose?.();
			const tui = {
				requestRender: () => {
					renders++;
				},
			};
			widget = factory?.(tui, { fg: (_color: string, text: string) => text });
		},
		notify: (text: string, level: string) => notes.push(`${level}: ${text}`),
	};
	const ctx = { mode, ui, sessionManager: { getBranch: () => [...branch, ...entries] } };
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
		end: (stopReason = "stop") => fire("agent_end", { messages: [{ role: "assistant", stopReason }] }),
		command: (args: string) => commands.steps.handler(args, ctx),
		fire,
		tool: () => tool,
		entries,
		renders: () => renders,
		active: () => active,
		notes,
	};
}

// A fixed clock: `wait(ms)` moves time forward for the step timer.
let now = 0;
const wait = (ms: number) => {
	now += ms;
};
mock.method(Date, "now", () => now);
test.beforeEach(() => rmSync(SETTINGS, { force: true }));

test("a running plan shows every step with the current one timed", async () => {
	const s = setup();
	s.prompt();
	await s.plan({ steps: ["A", "B", "C"] });
	wait(5_000);
	assert.equal(s.show(), "● A · 5s\n○ B\n○ C");
	wait(82_000);
	assert.equal(s.show().split("\n")[0], "● A · 1m 27s");
});

test("the timer restarts when the step changes, not on a repeated tick", async () => {
	const s = setup();
	s.prompt();
	await s.plan({ steps: ["A", "B"] });
	wait(10_000);
	await s.plan({ done: 1 });
	assert.equal(s.show(), "✓ A\n● B · 0s");
	wait(3_000);
	await s.plan({ done: 1 });
	assert.equal(s.show(), "✓ A\n● B · 3s");
});

test("without a plan in this prompt nothing shows", () => {
	const s = setup();
	s.prompt();
	assert.equal(s.show(), "(hidden)");
	s.end();
	assert.equal(s.show(), "(hidden)");
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
	assert.equal(s.show(), "(hidden)");
	s.end();
	assert.equal(s.show(), "◐ 2/5 · next: C");
	s.prompt();
	await s.plan({ done: 4 });
	assert.equal(s.show(), "✓ A\n✓ B\n✓ C\n✓ D\n● E · 0s");
});

test("a normal end completes the plan only when the last step is left", async () => {
	const s = setup();
	s.prompt();
	await s.plan({ steps: ["A", "B", "C"] });
	await s.plan({ done: 2 });
	s.end();
	assert.equal(s.show(), "✓ 3/3 steps");
	s.prompt();
	assert.equal(s.show(), "(hidden)");
});

test("an aborted run keeps the real count", async () => {
	const s = setup();
	s.prompt();
	await s.plan({ steps: ["X", "Y", "Z"] });
	await s.plan({ done: 2 });
	s.end("aborted");
	assert.equal(s.show(), "◐ 2/3 · next: Z");
});

test("/steps off hides the widget and drops the plan tool; /steps on restores both", async () => {
	const s = setup();
	s.prompt();
	await s.plan({ steps: ["A", "B", "C"] });
	await s.command("off");
	assert.equal(s.show(), "(hidden)");
	assert.deepEqual(s.active(), ["read", "bash"]);
	await s.command("on");
	assert.deepEqual(s.active(), ["read", "bash", "plan"]);
	assert.equal(s.show(), "● A · 0s\n○ B\n○ C");
	await s.command("maybe");
	assert.equal(s.notes.at(-1), "warning: usage: /steps [on|off]");
});

test("/steps off applies to every later session until /steps on", async () => {
	await setup().command("off");
	assert.deepEqual(JSON.parse(readFileSync(SETTINGS, "utf8")), { enabled: false });
	const next = setup();
	assert.deepEqual(next.active(), ["read", "bash"]);
	next.prompt();
	assert.equal(next.show(), "(hidden)");
	await next.command("");
	assert.equal(next.notes.at(-1), "info: steps off (open sessions pick it up on /reload)");
	await next.command("on");
	assert.deepEqual(setup().active(), ["read", "bash", "plan"]);
});

test("an unreadable setting is reported and steps stay on", () => {
	writeFileSync(SETTINGS, "{not json");
	const s = setup();
	assert.deepEqual(s.active(), ["read", "bash", "plan"]);
	assert.match(s.notes[0], /^warning: steps: could not read the on\/off setting, so steps stay on \(.*steps\.json/);
});

test("outside the TUI, as in a delegate worker's JSON mode, there is no plan tool and no widget", () => {
	for (const mode of ["json", "print"]) {
		const s = setup({ mode });
		assert.equal(s.tool(), undefined);
		s.prompt();
		assert.equal(s.show(), "(hidden)");
	}
});

test("the step timer stops when the widget goes away or the session ends", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const s = setup();
	s.prompt();
	await s.plan({ steps: ["A", "B"] });
	t.mock.timers.tick(3000);
	assert.equal(s.renders(), 3);
	s.end("aborted");
	t.mock.timers.tick(3000);
	assert.equal(s.renders(), 3, "an idle widget does not tick");
	s.prompt();
	await s.plan({ done: 0 });
	s.fire("session_shutdown");
	t.mock.timers.tick(3000);
	assert.equal(s.renders(), 3, "a shut-down session does not tick");
});

test("a plan completed by a normal end stays complete after resume", async () => {
	const s = setup();
	s.prompt();
	await s.plan({ steps: ["A", "B"] });
	await s.plan({ done: 1 });
	s.end();
	assert.deepEqual(s.entries, [
		{ type: "custom", customType: "steps-completed", data: { steps: ["A", "B"], done: 2 } },
	]);
	const resumed = setup({
		branch: [
			{
				type: "message",
				message: { role: "toolResult", toolName: "plan", details: { steps: ["A", "B"], done: 1 } },
			},
			...s.entries,
		],
	});
	assert.equal(resumed.show(), "(hidden)");
	resumed.fire("session_tree");
	assert.equal(resumed.show(), "✓ 2/2 steps");
});

test("restore ignores entries that are not plans and clamps done", () => {
	const result = (details: any) => ({ type: "message", message: { role: "toolResult", toolName: "plan", details } });
	const s = setup({
		branch: [
			result({ steps: ["A", "B", "C"], done: 1 }),
			result({ steps: "not a list" }),
			{ type: "custom", customType: "steps-completed", data: { done: 9 } },
		],
	});
	s.fire("session_tree");
	assert.equal(s.show(), "◐ 1/3 · next: B");
	const t = setup({ branch: [result({ steps: ["A", "B"], done: 7 }), result({ steps: ["X", "Y"] })] });
	t.fire("session_tree");
	assert.equal(t.show(), "◐ 0/2 · next: X");
});

test("done is a whole number of steps", () => {
	const s = setup();
	assert.deepEqual(s.tool().parameters.properties.done, { type: "integer", minimum: 0 });
});

test("a setting that can't be read for another reason is reported and steps stay on", () => {
	mkdirSync(SETTINGS, { recursive: true });
	try {
		const s = setup();
		assert.deepEqual(s.active(), ["read", "bash", "plan"]);
		assert.match(s.notes[0], /^warning: steps: could not read the on\/off setting, so steps stay on \(EISDIR/);
	} finally {
		rmSync(SETTINGS, { recursive: true, force: true });
	}
});
