import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

const { assess, createWatch, duration, runPs, sanitizeLabel } = await import("../extensions/watch.ts");
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
});

// A real wrapper as the design's launcher writes it: its pid file, a progress file, and `$?` into the exit file.
async function wrapper(dir: string, body: string) {
	const child = spawn("sh", ["-c", `echo $$ > pid; ${body}; echo $? > exit`], { cwd: dir, stdio: "ignore" });
	for (let i = 0; i < 100 && !existsSync(join(dir, "pid")); i++) await sleep(10);
	return { child, pid: Number(readFileSync(join(dir, "pid"), "utf8")) };
}
const exited = (child: ReturnType<typeof spawn>) =>
	new Promise((done) => (child.exitCode !== null || child.signalCode !== null ? done(null) : child.on("exit", done)));

test("a real wrapper that finishes wakes the model once with its exit code and item count", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const dir = fresh();
	const s = setup({ ps: runPs, cwd: dir });
	await s.start();
	writeFileSync(join(dir, "go"), "");
	const { child, pid } = await wrapper(dir, "while [ -e go ]; do sleep 0.05; done; printf 'a\\nb\\n' > record");
	const result = await s.watch({ label: "sweep", pid, progress: "record", total: 2, exitFile: "exit" });
	assert.match(result.content[0].text, new RegExp(`^watching sweep \\(pid ${pid}, started \\w{3} \\w{3} `));
	assert.match(s.footer() ?? "", /^⏵ sweep · \d+s$/);
	rmSync(join(dir, "go"));
	await exited(child);
	t.mock.timers.tick(INTERVAL);
	await settle();
	await sleep(100);
	await settle();
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
	const s = setup({ ps: runPs, cwd: dir });
	await s.start();
	const { child, pid } = await wrapper(dir, "sleep 30");
	await s.watch({ label: "sweep", pid, exitFile: "exit" });
	child.kill("SIGKILL");
	await exited(child);
	const checkOnce = async () => {
		t.mock.timers.tick(INTERVAL);
		for (let i = 0; i < 50 && !s.footer()?.startsWith("✗"); i++) await sleep(10);
	};
	await checkOnce();
	assert.equal(s.sent.length, 0, "one miss is the window before the wrapper writes its exit file");
	assert.match(s.footer() ?? "", /^⏵ sweep/);
	await checkOnce();
	assert.equal(s.sent.length, 1);
	assert.equal(s.sent[0].message.content.split(" (")[0].replace(/, \d+s$/, ""), "[watch] sweep died: no exit status");
	assert.equal(s.footer(), "✗ sweep died, no exit status");
	assert.equal(existsSync(join(dir, "exit")), false);
});

test("a running real wrapper shows its progress count and the age of the last item", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const dir = fresh();
	const s = setup({ ps: runPs, cwd: dir });
	await s.start();
	const { child, pid } = await wrapper(dir, "sleep 30");
	t.after(() => child.kill("SIGKILL"));
	await s.watch({ label: "sweep", pid, progress: "record", total: 3 });
	assert.match(s.footer() ?? "", /^⏵ sweep · \d+s$/, "no progress file yet");
	for (const item of ["a", "b"]) {
		appendFileSync(join(dir, "record"), `${item}\n`);
		t.mock.timers.tick(INTERVAL);
		for (let i = 0; i < 50 && !s.footer()?.includes(item === "a" ? "1/3" : "2/3"); i++) await sleep(10);
	}
	assert.match(s.footer() ?? "", /^⏵ sweep · 2\/3 · last \+1 \d+s · \d+s$/);
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

test("a ps failure shows the watch as unchecked, and a throwing check fails only its own watch", async (t) => {
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
	assert.match(s.footer() ?? "", /^\? a unchecked \(EISDIR.*\) {2}\? b unchecked \(ps: operation not permitted\)$/);
	assert.equal(s.sent.length, 0);
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
	await s.watch({ label: "d", pid: 1 });
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
