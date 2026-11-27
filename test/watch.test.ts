import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

// Watches read and write files and spawn processes: keep HOME, TMPDIR and the agent dir in a temp dir.
const ROOT = mkdtempSync(join(tmpdir(), "watch-test-"));
process.env.HOME = ROOT;
process.env.TMPDIR = ROOT;
process.env.PI_CODING_AGENT_DIR = join(ROOT, "agent");
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));

const { assess, createWatch, duration, readLastTool, runPs, sanitizeLabel, STREAM_MAX_READ } = await import(
	"../extensions/watch.ts"
);
type Ps = Awaited<ReturnType<typeof runPs>>;

const INTERVAL = 1000;
let dirs = 0;
const fresh = () => mkdtempSync(join(ROOT, `case-${dirs++}-`));

// A fake process table: `table.set(pid, lstart | "gone" | { error })`; a pid not in it is gone.
function fakePs() {
	const table = new Map<number, Ps>();
	const calls: number[] = [];
	const ps = async (pid: number): Promise<Ps> => {
		calls.push(pid);
		return table.get(pid) ?? "gone";
	};
	return { table, calls, ps };
}

// Register against a fake Pi. `branch` is the session's entries; `appendEntry` adds to it, as Pi does.
function setup({ mode = "tui", branch = [] as any[], ps = fakePs().ps, cwd = fresh() } = {}) {
	let tool: any;
	const handlers: Record<string, ((event: any, ctx: any) => unknown)[]> = {};
	const sent: { message: any; options: any }[] = [];
	const status: (string | undefined)[] = [];
	const register = createWatch({ ps, interval: INTERVAL });
	register({
		on: (event: string, handler: any) => {
			handlers[event] ??= [];
			handlers[event].push(handler);
		},
		registerTool: (definition: any) => {
			tool = definition;
		},
		appendEntry: (customType: string, data: any) => {
			branch.push({ type: "custom", customType, data: structuredClone(data) });
		},
		sendMessage: async (message: any, options: any) => {
			sent.push({ message, options });
		},
	} as any);
	const ctx = {
		mode,
		cwd,
		ui: { setStatus: (_key: string, text: string | undefined) => status.push(text) },
		sessionManager: { getBranch: () => branch },
	};
	const fire = async (event: string, payload: any = {}) => {
		for (const handler of handlers[event] ?? []) await handler(payload, ctx);
	};
	return {
		start: (reason = "startup") => fire("session_start", { reason }),
		fire,
		watch: (params: any) => tool.execute("w", params),
		tool: () => tool,
		footer: () => status.at(-1),
		sent,
		branch,
		cwd,
	};
}

// Let a tick's pending `ps` and file reads settle.
const settle = async () => {
	for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done));
};
const START = "Thu Nov 26 14:57:15 2026";

test("assess: a live pid with its start time is running and resets the miss count", () => {
	assert.deepEqual(assess({ lstart: START, misses: 1 }, { ps: { lstart: START } }), { state: "running", misses: 0 });
});

test("assess: an exit file read after the pid is gone is a finish, with a non-zero code kept", () => {
	assert.deepEqual(assess({ lstart: START, misses: 0 }, { ps: "gone", exit: 0 }), { state: "finished", exit: 0 });
	assert.deepEqual(assess({ lstart: START, misses: 0 }, { ps: "gone", exit: 3 }), { state: "finished", exit: 3 });
});

test("assess: a reused pid (another start time) has ended", () => {
	const reused = { ps: { lstart: "Fri Nov 27 09:00:00 2026" } };
	assert.deepEqual(assess({ lstart: START, misses: 0 }, reused), { state: "running", misses: 1 });
	assert.deepEqual(assess({ lstart: START, misses: 1 }, reused), { state: "died" });
	assert.deepEqual(assess({ lstart: START, misses: 0 }, { ...reused, exit: 0 }), { state: "finished", exit: 0 });
});

test("assess: the first missing check waits, the second is death, and a finish read on the second still counts", () => {
	assert.deepEqual(assess({ lstart: START, misses: 0 }, { ps: "gone" }), { state: "running", misses: 1 });
	assert.deepEqual(assess({ lstart: START, misses: 1 }, { ps: "gone" }), { state: "died" });
	assert.deepEqual(assess({ lstart: START, misses: 1 }, { ps: "gone", exit: 0 }), { state: "finished", exit: 0 });
});

test("assess: a ps error is unknown and keeps the miss count", () => {
	assert.deepEqual(assess({ lstart: START, misses: 1 }, { ps: { error: "ps timed out" } }), {
		state: "unknown",
		reason: "ps timed out",
		misses: 1,
	});
});

test("runPs: a live pid has a start time in the C locale, a gone one reads as gone", async () => {
	const live = await runPs(process.pid);
	assert.ok(typeof live === "object" && "lstart" in live);
	assert.match(live.lstart, /^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d+ \d\d:\d\d:\d\d \d{4}$/);
	const child = spawn("true");
	await new Promise((done) => child.on("exit", done));
	assert.equal(await runPs(child.pid as number), "gone");
});

test("duration and label: short forms, and a label loses ANSI codes and newlines and is capped", () => {
	assert.equal(duration(45_000), "45s");
	assert.equal(duration(23 * 60_000), "23m");
	assert.equal(duration((2 * 60 + 41) * 60_000), "2h41m");
	assert.equal(sanitizeLabel("\u001b[31mswe\u0007ep\u001b[0m\nrun\r\t2"), "swe ep run 2");
	assert.equal(sanitizeLabel("x".repeat(40)).length, 24);
	assert.equal(sanitizeLabel("\u001b]8;;https://x.test\u0007link\u001b]8;;\u001b\\ \u009b1mC1"), "link C1");
	assert.equal(sanitizeLabel("a\u001b(Bb\u001b"), "ab", "a charset switch and a lone ESC");
});

// A real wrapper as the design's launcher writes it: its pid file, a progress file, and `$?` into the exit file.
async function wrapper(dir: string, body: string) {
	const child = spawn("sh", ["-c", `echo $$ > pid; ${body}; echo $? > exit`], { cwd: dir, stdio: "ignore" });
	for (let i = 0; i < 100 && !existsSync(join(dir, "pid")); i++) await sleep(10);
	return { child, pid: Number(readFileSync(join(dir, "pid"), "utf8")) };
}
// The real `ps`, counting finished calls: `checked(n)` waits until n calls have returned and the check settled.
function realPs() {
	let finished = 0;
	const ps = async (pid: number) => {
		const result = await runPs(pid);
		finished++;
		return result;
	};
	const checked = async (n: number) => {
		for (let i = 0; i < 500 && finished < n; i++) await sleep(10);
		assert.ok(finished >= n, `${n} ps calls returned`);
		await settle();
	};
	return { ps, checked };
}
const exited = (child: ReturnType<typeof spawn>) =>
	new Promise((done) => (child.exitCode !== null || child.signalCode !== null ? done(null) : child.on("exit", done)));

test("a real wrapper that finishes wakes the model once with its exit code and item count", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const dir = fresh();
	const real = realPs();
	const s = setup({ ps: real.ps, cwd: dir });
	await s.start();
	writeFileSync(join(dir, "go"), "");
	const { child, pid } = await wrapper(dir, "while [ -e go ]; do sleep 0.05; done; printf 'a\\nb\\n' > record");
	const result = await s.watch({ label: "sweep", pid, progress: "record", total: 2, exitFile: "exit" });
	assert.match(result.content[0].text, new RegExp(`^watching sweep \\(pid ${pid}, started \\w{3} \\w{3} `));
	assert.match(s.footer() ?? "", /^⏵ sweep · \d+s$/);
	rmSync(join(dir, "go"));
	await exited(child);
	t.mock.timers.tick(INTERVAL);
	await real.checked(2);
	assert.equal(s.sent.length, 1);
	assert.match(
		s.sent[0].message.content,
		/^\[watch\] sweep finished: exit 0, 2\/2 items, \d+s \(progress: .*record\)$/,
	);
	assert.deepEqual(s.sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
	assert.match(s.footer() ?? "", /^✓ sweep exit 0 · 2\/2 · \d+s$/);
	t.mock.timers.tick(INTERVAL * 3);
	await settle();
	assert.equal(s.sent.length, 1, "an end wakes the model once");
});

test("a real wrapper killed with -9 reads as died after two checks, not one", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const dir = fresh();
	const real = realPs();
	const s = setup({ ps: real.ps, cwd: dir });
	await s.start();
	const { child, pid } = await wrapper(dir, "sleep 30");
	await s.watch({ label: "sweep", pid, exitFile: "exit" });
	child.kill("SIGKILL");
	await exited(child);
	t.mock.timers.tick(INTERVAL);
	await real.checked(2);
	assert.equal(s.sent.length, 0, "one miss is the window before the wrapper writes its exit file");
	assert.match(s.footer() ?? "", /^⏵ sweep/);
	t.mock.timers.tick(INTERVAL);
	await real.checked(3);
	assert.equal(s.sent.length, 1);
	assert.equal(s.sent[0].message.content.split(" (")[0].replace(/, \d+s$/, ""), "[watch] sweep died: no exit status");
	assert.equal(s.footer(), "✗ sweep died, no exit status");
	assert.equal(existsSync(join(dir, "exit")), false);
});

test("a running real wrapper shows its progress count and the age of the last item", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const dir = fresh();
	const real = realPs();
	const s = setup({ ps: real.ps, cwd: dir });
	await s.start();
	const { child, pid } = await wrapper(dir, "sleep 30");
	t.after(() => child.kill("SIGKILL"));
	await s.watch({ label: "sweep", pid, progress: "record", total: 3 });
	assert.match(s.footer() ?? "", /^⏵ sweep · \d+s$/, "no progress file yet");
	appendFileSync(join(dir, "record"), "a\n");
	t.mock.timers.tick(INTERVAL);
	await real.checked(2);
	assert.match(s.footer() ?? "", /^⏵ sweep 1\/3 · /);
	appendFileSync(join(dir, "record"), "b\n");
	t.mock.timers.tick(INTERVAL);
	await real.checked(3);
	assert.match(s.footer() ?? "", /^⏵ sweep 2\/3 · last \+1 \d+s · \d+s$/);
	assert.equal(s.sent.length, 0, "running states never wake the model");
});

test("an end the timer finds wakes once; a restore from the notified entry wakes nothing", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { table, ps } = fakePs();
	const dir = fresh();
	const s = setup({ ps, cwd: dir });
	await s.start();
	table.set(42, { lstart: START });
	await s.watch({ label: "sweep", pid: 42, exitFile: "exit" });
	table.set(42, "gone");
	writeFileSync(join(dir, "exit"), "1\n");
	t.mock.timers.tick(INTERVAL);
	await settle();
	assert.equal(s.sent.length, 1);
	assert.match(s.sent[0].message.content, /^\[watch\] sweep finished: exit 1, \d+s$/);
	assert.match(s.footer() ?? "", /^✗ sweep exit 1 · \d+s$/);
	const last = s.branch.at(-1).data;
	assert.equal(last.state, "finished");
	assert.equal(last.notified, true, "the entry is marked notified before the wake");

	await s.fire("session_shutdown");
	const again = setup({ ps, branch: s.branch, cwd: dir });
	await again.start("reload");
	t.mock.timers.tick(INTERVAL * 3);
	await settle();
	assert.equal(again.sent.length, 0);
	assert.match(again.footer() ?? "", /^✗ sweep exit 1/, "the ended watch stays until the next prompt");
	await again.fire("message_start", { message: { role: "user" } });
	assert.equal(again.footer(), undefined);
});

test("a running watch is restored on reload and checked at once, with nothing to wake", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { table, calls, ps } = fakePs();
	const s = setup({ ps });
	await s.start();
	table.set(42, { lstart: START });
	await s.watch({ label: "sweep", pid: 42 });
	await s.fire("session_shutdown");
	calls.length = 0;
	const again = setup({ ps, branch: s.branch });
	await again.start("reload");
	assert.deepEqual(calls, [42], "checked at once on start");
	assert.match(again.footer() ?? "", /^⏵ sweep · /);
	t.mock.timers.tick(INTERVAL);
	await settle();
	assert.deepEqual(calls, [42, 42]);
	assert.equal(again.sent.length, 0);
});

test("an end found on session_start is added to the session without starting a turn", async () => {
	const { table, ps } = fakePs();
	const dir = fresh();
	const s = setup({ ps, cwd: dir });
	await s.start();
	table.set(42, { lstart: START });
	await s.watch({ label: "sweep", pid: 42, exitFile: "exit" });
	await s.fire("session_shutdown");
	table.delete(42);
	writeFileSync(join(dir, "exit"), "0\n");
	const again = setup({ ps, branch: s.branch, cwd: dir });
	await again.start("resume");
	assert.equal(again.sent.length, 1);
	assert.equal(again.sent[0].options, undefined, "no triggerTurn: the model reads it on the next prompt");
	assert.match(again.sent[0].message.content, /^\[watch\] sweep finished: exit 0/);
});

test("a ps failure shows the watch as unchecked, and an unreadable progress file does not hide the end", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { table, ps } = fakePs();
	const dir = fresh();
	const s = setup({ ps, cwd: dir });
	await s.start();
	table.set(1, { lstart: START });
	table.set(2, { lstart: START });
	await s.watch({ label: "a", pid: 1, progress: "dir-not-file" });
	await s.watch({ label: "b", pid: 2 });
	// Reading a directory as the progress file throws EISDIR.
	mkdirSync(join(dir, "dir-not-file"));
	table.set(2, { error: "ps: operation not permitted" });
	t.mock.timers.tick(INTERVAL);
	await settle();
	assert.match(
		s.footer() ?? "",
		/^\? a unchecked \(progress: EISDIR.*\) {2}\? b unchecked \(ps: operation not permitted\)$/,
	);
	assert.equal(s.sent.length, 0);
	table.delete(1);
	t.mock.timers.tick(INTERVAL);
	await settle();
	t.mock.timers.tick(INTERVAL);
	await settle();
	assert.equal(s.sent.length, 1, "the progress error does not keep the death from being seen");
	assert.match(s.sent[0].message.content, /^\[watch\] a died: no exit status/);
});

test("a death whose first miss was on session_start adds its message without starting a turn", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { table, ps } = fakePs();
	const s = setup({ ps });
	await s.start();
	table.set(42, { lstart: START });
	await s.watch({ label: "sweep", pid: 42 });
	await s.fire("session_shutdown");
	// The machine rebooted and the pid was reused: another start time.
	table.set(42, { lstart: "Fri Nov 27 09:00:00 2026" });
	const again = setup({ ps, branch: s.branch });
	await again.start("resume");
	assert.equal(again.sent.length, 0, "one miss waits for a second check");
	t.mock.timers.tick(INTERVAL);
	await settle();
	assert.equal(again.sent.length, 1);
	assert.equal(again.sent[0].options, undefined, "it ended while no Pi watched");
	assert.match(again.sent[0].message.content, /^\[watch\] sweep died/);
});

test("a shutdown during a pending check appends and sends nothing afterwards", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let release: () => void = () => {};
	let hang = false;
	const ps = async (): Promise<Ps> => {
		if (!hang) return { lstart: START };
		await new Promise<void>((done) => {
			release = done;
		});
		return "gone";
	};
	const dir = fresh();
	const s = setup({ ps, cwd: dir });
	await s.start();
	await s.watch({ label: "sweep", pid: 42, exitFile: "exit" });
	hang = true;
	writeFileSync(join(dir, "exit"), "0\n");
	t.mock.timers.tick(INTERVAL);
	await settle();
	const entries = s.branch.length;
	await s.fire("session_shutdown");
	release();
	await settle();
	assert.equal(s.branch.length, entries);
	assert.equal(s.sent.length, 0);
});

test("a watch dropped during a pending check is not ended, and the other watches are still checked", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { table } = fakePs();
	let release: () => void = () => {};
	let hang = false;
	const ps = async (pid: number): Promise<Ps> => {
		if (hang && pid === 1)
			await new Promise<void>((done) => {
				release = done;
			});
		return table.get(pid) ?? "gone";
	};
	const dir = fresh();
	const s = setup({ ps, cwd: dir });
	await s.start();
	table.set(1, { lstart: START });
	table.set(2, { lstart: START });
	await s.watch({ label: "a", pid: 1 });
	await s.watch({ label: "b", pid: 2, exitFile: "exit" });
	hang = true;
	table.delete(1);
	table.delete(2);
	writeFileSync(join(dir, "exit"), "0\n");
	t.mock.timers.tick(INTERVAL);
	await settle();
	await s.watch({ label: "a", drop: true });
	release();
	await settle();
	assert.deepEqual(
		s.sent.map(({ message }) => message.content.split(":")[0]),
		["[watch] b finished"],
	);
	assert.match(s.footer() ?? "", /^✓ b exit 0/);
});

test("restore skips dropped watches, /tree restores the branch, and the timer stops once all have ended", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { table, calls, ps } = fakePs();
	const dir = fresh();
	const s = setup({ ps, cwd: dir });
	await s.start();
	table.set(1, { lstart: START });
	table.set(2, { lstart: START });
	await s.watch({ label: "a", pid: 1 });
	await s.watch({ label: "b", pid: 2, exitFile: "exit" });
	await s.watch({ label: "a", drop: true });
	await s.fire("session_shutdown");
	const again = setup({ ps, branch: s.branch, cwd: dir });
	await again.start("reload");
	assert.match(again.footer() ?? "", /^⏵ b · \d+s$/);
	const before = again.branch.slice(0, 2);
	again.branch.length = 0;
	again.branch.push(...before);
	await again.fire("session_tree");
	assert.match(again.footer() ?? "", /^⏵ a · \d+s {2}⏵ b · \d+s$/, "the earlier branch still had a");
	await again.watch({ label: "a", drop: true });
	table.delete(2);
	writeFileSync(join(dir, "exit"), "0\n");
	t.mock.timers.tick(INTERVAL);
	await settle();
	assert.match(again.footer() ?? "", /^✓ b exit 0/);
	calls.length = 0;
	t.mock.timers.tick(INTERVAL * 3);
	await settle();
	assert.deepEqual(calls, [], "no running watch, no timer");
	await again.fire("message_start", { message: { role: "custom" } });
	assert.match(again.footer() ?? "", /^✓ b exit 0/, "only the user's prompt clears an ended watch");
});

test("a tick is skipped while the previous one is still pending", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let release: () => void = () => {};
	let calls = 0;
	let hang = false;
	const ps = async (): Promise<Ps> => {
		calls++;
		if (hang)
			await new Promise<void>((done) => {
				release = done;
			});
		return { lstart: START };
	};
	const s = setup({ ps });
	await s.start();
	await s.watch({ label: "sweep", pid: 42 });
	calls = 0;
	hang = true;
	t.mock.timers.tick(INTERVAL);
	t.mock.timers.tick(INTERVAL);
	t.mock.timers.tick(INTERVAL);
	await settle();
	assert.equal(calls, 1);
	release();
	await settle();
});

test("refusals: an existing exit file, no pid, a pid not running, a fourth watch, a duplicate", async () => {
	const { table, ps } = fakePs();
	const dir = fresh();
	const s = setup({ ps, cwd: dir });
	await s.start();
	writeFileSync(join(dir, "exit"), "0\n");
	table.set(1, { lstart: START });
	await assert.rejects(s.watch({ label: "a", pid: 1, exitFile: "exit" }), /exit file exit already exists/);
	await assert.rejects(s.watch({ label: "a" }), /pid is required/);
	await assert.rejects(s.watch({ label: "a", pid: 9 }), /pid 9 is not running/);
	for (const label of ["a", "b", "c"]) await s.watch({ label, pid: 1 });
	await assert.rejects(s.watch({ label: "b", pid: 1 }), /b is already watched/);
	await assert.rejects(s.watch({ label: "d", pid: 1 }), /at most 3 watches/);
	await s.watch({ label: "b", drop: true });
	const parallel = await Promise.allSettled([s.watch({ label: "d", pid: 1 }), s.watch({ label: "e", pid: 1 })]);
	assert.deepEqual(
		parallel.map(({ status }) => status),
		["fulfilled", "rejected"],
		"two calls in one message cannot both take the last slot",
	);
	assert.match(s.footer() ?? "", /^⏵ a · .* {2}⏵ c · .* {2}⏵ d · /);
});

test("outside the TUI there is no tool, no status and no timer", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { table, calls, ps } = fakePs();
	table.set(42, { lstart: START });
	const branch = [
		{ type: "custom", customType: "watch", data: { label: "x", pid: 42, lstart: START, since: 0, state: "running" } },
	];
	const s = setup({ mode: "json", ps, branch });
	await s.start();
	t.mock.timers.tick(INTERVAL * 3);
	await settle();
	assert.equal(s.tool(), undefined);
	assert.equal(s.footer(), undefined);
	assert.deepEqual(calls, []);
});

test("session_shutdown clears the interval", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { table, calls, ps } = fakePs();
	const s = setup({ ps });
	await s.start();
	table.set(42, { lstart: START });
	await s.watch({ label: "sweep", pid: 42 });
	calls.length = 0;
	await s.fire("session_shutdown");
	t.mock.timers.tick(INTERVAL * 3);
	await settle();
	assert.deepEqual(calls, []);
});

test("the footer sanitises labels and puts ended watches first", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { table, ps } = fakePs();
	const dir = fresh();
	const s = setup({ ps, cwd: dir });
	await s.start();
	table.set(1, { lstart: START });
	table.set(2, { lstart: START });
	await s.watch({ label: "\u001b[1mbuild\u001b[0m\nnow", pid: 1 });
	await s.watch({ label: "sweep", pid: 2, exitFile: "exit" });
	table.delete(2);
	writeFileSync(join(dir, "exit"), "0\n");
	t.mock.timers.tick(INTERVAL);
	await settle();
	assert.match(s.footer() ?? "", /^✓ sweep exit 0 · \d+s {2}⏵ build now · \d+s$/);
});

// A Pi JSON event stream as `pi -p --mode json` writes it: one event per line.
const toolStart = (id: string, toolName: string, args: Record<string, unknown>) =>
	`${JSON.stringify({ type: "tool_execution_start", toolCallId: id, toolName, args })}\n`;
const delta = (text: string) =>
	`${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } })}\n`;
const MiB = 1024 * 1024;

test("readLastTool: the last tool call's name and one short argument, collapsed, sanitised and capped", () => {
	const dir = fresh();
	const path = join(dir, "stream.jsonl");
	writeFileSync(path, toolStart("1", "read", { path: "a.ts" }) + delta("x"));
	assert.deepEqual(readLastTool(path).tool, { name: "read", arg: "a.ts" });
	appendFileSync(path, toolStart("2", "bash", { command: "npm  run\n\tcheck \u001b[31m--prefix\u001b[0m x" }));
	assert.deepEqual(readLastTool(path).tool, { name: "bash", arg: "npm run check --prefix x" });
	appendFileSync(path, toolStart("3", "delegate", { task: "y".repeat(100) }));
	assert.equal(readLastTool(path).tool?.arg, `${"y".repeat(39)}…`);
	appendFileSync(path, toolStart("4", "Skill", { name: "tdd", other: 1 }) + toolStart("5", "plan", { steps: [] }));
	assert.deepEqual(readLastTool(path).tool, { name: "plan", arg: undefined });
	assert.deepEqual(readLastTool(join(dir, "missing")), { next: 0 });
});

test("readLastTool: skips a half-written last line, a line that is not JSON and the marker inside a message", () => {
	const dir = fresh();
	const path = join(dir, "stream.jsonl");
	writeFileSync(path, delta("no tool yet"));
	assert.equal(readLastTool(path).tool, undefined, "no tool call");
	const good = toolStart("1", "read", { path: "a.ts" });
	appendFileSync(path, good);
	appendFileSync(path, '{"type":"tool_execution_start" not json\n');
	appendFileSync(path, delta('quoting {"type":"tool_execution_start","toolName":"fake"}'));
	const complete = readFileSync(path).length;
	appendFileSync(path, toolStart("2", "bash", { command: "ls" }).slice(0, 40));
	const read = readLastTool(path);
	assert.deepEqual(read.tool, { name: "read", arg: "a.ts" });
	assert.equal(read.next, complete, "the next read starts at the half-written line");
	appendFileSync(path, toolStart("2", "bash", { command: "ls" }).slice(40));
	assert.deepEqual(readLastTool(path, read.next).tool, { name: "bash", arg: "ls" }, "and finds it once complete");
});

test("readLastTool: reads only from `from`, at most `maxBytes` of the end, so a tool call before it is not found", () => {
	const dir = fresh();
	const path = join(dir, "stream.jsonl");
	const call = toolStart("1", "read", { path: "a.ts" });
	writeFileSync(path, call + delta("z".repeat(2000)));
	const size = readFileSync(path).length;
	assert.deepEqual(readLastTool(path, 0, 1000), { next: size, skipped: true }, "the cap starts after the call");
	assert.deepEqual(readLastTool(path, call.length), { next: size, skipped: false }, "`from` starts after it");
	assert.deepEqual(readLastTool(path, call.length - 1).tool, undefined, "a line cut by `from`");
	assert.deepEqual(readLastTool(path, 0).tool, { name: "read", arg: "a.ts" });
	const cut = toolStart("2", "bash", { command: "ls" });
	writeFileSync(path, delta("z".repeat(2000)) + cut + delta("w"));
	const exact = cut.length + delta("w").length;
	assert.equal(readLastTool(path, 0, exact - 1).tool, undefined, "a line cut by the cap");
	assert.deepEqual(readLastTool(path, 0, exact).tool, { name: "bash", arg: "ls" }, "a line starting at the cap");
	assert.deepEqual(readLastTool(path, 1e9).tool, { name: "bash", arg: "ls" }, "a shrunk file is read again");
	assert.deepEqual(readLastTool(path, 0, 10), { next: readFileSync(path).length, skipped: true }, "inside a line");
});

test("readLastTool: a FIFO or a directory is refused at once, without blocking", () => {
	const dir = fresh();
	const fifo = join(dir, "fifo");
	spawnSync("mkfifo", [fifo]);
	assert.throws(() => readLastTool(fifo), /not a regular file/);
	mkdirSync(join(dir, "d"));
	assert.throws(() => readLastTool(join(dir, "d")), /not a regular file|EISDIR/);
});

test("a stream shows the last tool and its age in the footer, and changes at the next check", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { table, ps } = fakePs();
	const dir = fresh();
	const stream = join(dir, "stream.jsonl");
	const s = setup({ ps, cwd: dir });
	await s.start();
	table.set(42, { lstart: START });
	await s.watch({ label: "t181", pid: 42, stream: "stream.jsonl" });
	assert.match(s.footer() ?? "", /^⏵ t181 · \d+s$/, "a missing stream shows nothing yet");
	writeFileSync(stream, toolStart("1", "read", { path: "docs/watch/design.md" }));
	t.mock.timers.tick(INTERVAL);
	await settle();
	assert.match(s.footer() ?? "", /^⏵ t181 · read docs\/watch\/design\.md \d+s ago · \d+s$/);
	// A new call followed by more than a megabyte of deltas within one check is still found.
	appendFileSync(stream, toolStart("2", "bash", { command: "npm run check" }) + delta("d".repeat(3 * MiB)));
	t.mock.timers.tick(INTERVAL);
	await settle();
	assert.match(s.footer() ?? "", /^⏵ t181 · bash npm run check \d+s ago · \d+s$/);
	// Deltas with no tool call and a half-written line keep the last call seen.
	appendFileSync(stream, `${delta("e".repeat(1000))}{"type":"message_upd`);
	t.mock.timers.tick(INTERVAL);
	await settle();
	assert.match(s.footer() ?? "", /^⏵ t181 · bash npm run check \d+s ago · \d+s$/);
	// More was appended than one read takes, with no call in it: a newer call may be unread, so no age.
	appendFileSync(stream, `ate"}\n${delta("f".repeat(STREAM_MAX_READ + 10))}`);
	t.mock.timers.tick(INTERVAL);
	await settle();
	assert.match(s.footer() ?? "", /^⏵ t181 · \? bash npm run check · \d+s$/);
	assert.equal(s.sent.length, 0);
});

test("stream text never enters the wake message, the tool result or a watch entry", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { table, ps } = fakePs();
	const dir = fresh();
	const s = setup({ ps, cwd: dir });
	await s.start();
	const MARKER = "MARKER-7f3a";
	writeFileSync(join(dir, "stream.jsonl"), toolStart(MARKER, `${MARKER}tool`, { command: `echo ${MARKER}` }));
	table.set(42, { lstart: START });
	const result = await s.watch({ label: "t181", pid: 42, stream: "stream.jsonl", exitFile: "exit" });
	assert.ok(!JSON.stringify(result).includes(MARKER));
	assert.match(s.footer() ?? "", new RegExp(`${MARKER}tool echo ${MARKER}`), "the footer shows it");
	table.delete(42);
	writeFileSync(join(dir, "exit"), "0\n");
	t.mock.timers.tick(INTERVAL);
	await settle();
	assert.equal(s.sent.length, 1);
	assert.ok(!JSON.stringify(s.sent).includes(MARKER), "the wake message");
	assert.ok(!JSON.stringify(s.branch).includes(MARKER), "the session entries");
});

test("an unreadable stream is shown as unchecked and does not hide the end", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { table, ps } = fakePs();
	const dir = fresh();
	const s = setup({ ps, cwd: dir });
	await s.start();
	spawnSync("mkfifo", [join(dir, "stream.jsonl")]);
	table.set(42, { lstart: START });
	await s.watch({ label: "t181", pid: 42, stream: "stream.jsonl", exitFile: "exit" });
	assert.match(s.footer() ?? "", /^\? t181 unchecked \(stream: not a regular file\)$/);
	table.delete(42);
	writeFileSync(join(dir, "exit"), "0\n");
	t.mock.timers.tick(INTERVAL);
	await settle();
	assert.equal(s.sent.length, 1);
	assert.match(s.sent[0].message.content, /^\[watch\] t181 finished: exit 0/);
});

test("after /reload and /tree a watch with a stream shows the last tool again, with no age", async () => {
	const { table, ps } = fakePs();
	const dir = fresh();
	const s = setup({ ps, cwd: dir });
	await s.start();
	table.set(42, { lstart: START });
	writeFileSync(join(dir, "stream.jsonl"), toolStart("1", "edit", { path: "x.ts" }));
	await s.watch({ label: "t181", pid: 42, stream: "stream.jsonl" });
	assert.match(s.footer() ?? "", /^⏵ t181 · edit x\.ts · \d+s$/, "a call found at registration has no age");
	appendFileSync(join(dir, "stream.jsonl"), delta("d".repeat(3 * MiB)));
	await s.fire("session_shutdown");
	const again = setup({ ps, branch: s.branch, cwd: dir });
	await again.start("reload");
	assert.match(again.footer() ?? "", /^⏵ t181 · edit x\.ts · \d+s$/);
	await again.fire("session_tree");
	assert.match(again.footer() ?? "", /^⏵ t181 · edit x\.ts · \d+s$/);
});
