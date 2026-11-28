import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";

// Real git and the real process table, in a temp dir: never the real ~/.pi or this checkout.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "chief-extension-test-")));
process.env.HOME = ROOT;
process.env.TMPDIR = ROOT;
process.env.PI_CODING_AGENT_DIR = join(ROOT, "agent");
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));
// Whatever started these tests, the sessions in them are attended main sessions, started as any is.
for (const name of ["ME_PI_UNATTENDED", "ME_PI_RUN", "ME_PI_GUARD"]) delete process.env[name];

const { createChief, reconcileInChild } = await import("../extensions/chief.ts");
const { main, systemRunner } = await import("../skills/chief/chief.ts");
const { default: registerGuard } = await import("../packages/pi-workers/extensions/guard.ts");

const INTERVAL = 1000;
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });

let repos = 0;

/** A repo with one commit and one worktree under `<repo>.worktrees/`, and the chief's state files beside them. */
function repository() {
	const repo = join(ROOT, `r${repos++}`, "repo");
	mkdirSync(repo, { recursive: true });
	git(repo, "init", "-q", "-b", "main");
	git(repo, "commit", "-q", "--allow-empty", "-m", "first");
	const worktrees = `${repo}.worktrees`;
	const worktree = join(worktrees, "wt");
	git(repo, "worktree", "add", "-q", "-b", "wt", worktree);
	const state = join(worktrees, ".chief");
	const events = () =>
		readFileSync(join(state, "events.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
	/** Appends events to the log as recorded `minutes` ago by the script, a wrapper or another session; returns when. */
	const seedAt = (minutes: number, ...lines: object[]) => {
		const at = ago(minutes);
		mkdirSync(state, { recursive: true });
		for (const line of lines) appendFileSync(join(state, "events.jsonl"), `${JSON.stringify({ at, ...line })}\n`);
		return at;
	};
	const seed = (...lines: object[]) => seedAt(0, ...lines);
	const commit = git(repo, "rev-parse", "HEAD").trim();
	/** A run reserved in `checkout` by a process that is gone: reconcile records it as one that never started. */
	const launch = (task: string, checkout: string, branch: string, launcher: object = GONE) => [
		{ type: "task-added", task, landing: "none" },
		{
			type: "launch",
			task,
			run: 1,
			session: `${task}-1`,
			model: "m",
			checkout,
			as: { branch, commit, tree: "" },
			launcher,
		},
	];
	return { repo, worktrees, worktree, state, notes: join(state, "notes"), events, seed, seedAt, ago, launch };
}

/** A process that is not running, and this one, which is: its start time as the script reads it. */
const GONE = { pid: 2 ** 22 - 3, start: "Thu Jan  1 00:00:00 1970" };
const ps = systemRunner.exec("ps", ["-o", "lstart=", "-p", String(process.pid)], {
	env: { TZ: "UTC", LC_ALL: "C" },
});
const LIVE = { pid: process.pid, start: ps.stdout.trim() };

type Answer = { code: number; out: string };

/**
 * Registers the extension against a fake Pi for one session in `cwd`. `fail` names a script command that fails
 * (code 2) while it is set; `reconcile` runs in this process unless a test gives the real one. With `guard` the
 * session loads the real guard too, as the root package does, on the event bus the two share.
 */
function session(
	id: string,
	cwd: string,
	{
		mode = "tui",
		guard = false,
		reconcile = async (argv: string[], cwd: string): Promise<Answer> => main(argv, systemRunner, cwd),
	} = {},
) {
	const handlers: Record<string, ((event: any, ctx: any) => unknown)[]> = {};
	const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
	const sent: { message: any; options: any }[] = [];
	const notes: { text: string; type: string }[] = [];
	const calls: string[] = [];
	/** The dialogs the session opened, and what the user answers: `confirm`, and each `input` in turn. */
	const dialogs: { kind: string; title: string; message?: string }[] = [];
	const self = {
		idle: true,
		fail: undefined as string | undefined,
		beforeReconcile: () => {},
		confirm: (): boolean => false,
		inputs: [] as (string | undefined)[],
		/** The session's model, as Pi gives it to an extension; a session may have none. */
		model: { provider: "some-provider", id: "model-x" } as { provider: string; id: string } | undefined,
	};
	/** The calls of the script made as the user's own. */
	const asUser: string[][] = [];
	const failing = (argv: string[]) =>
		self.fail && argv.includes(self.fail) ? { code: 2, out: "error: boom" } : undefined;
	const pi = {
		on: (event: string, handler: any) => {
			handlers[event] ??= [];
			handlers[event].push(handler);
		},
		registerCommand: (name: string, options: any) => {
			commands[name] = options;
		},
		sendMessage: (message: any, options: any) => {
			sent.push({ message, options });
		},
		// Pi's own bus, which calls a listener before `emit` returns: the chief asks guard its state that way.
		events: createEventBus(),
	} as any;
	if (guard) registerGuard(pi);
	createChief({
		interval: INTERVAL,
		call: (argv, cwd, caller) => {
			calls.push(argv.at(-1) === String(process.pid) ? "claim" : argv.at(-1)!);
			if (caller === "user") asUser.push(argv);
			return failing(argv) ?? main(argv, systemRunner, cwd, caller);
		},
		reconcile: async (argv, cwd) => {
			calls.push("reconcile (child)");
			self.beforeReconcile();
			return failing(argv) ?? reconcile(argv, cwd);
		},
	})(pi);
	const ctx = {
		mode,
		cwd,
		isIdle: () => self.idle,
		ui: {
			notify: (text: string, type: string) => notes.push({ text, type }),
			confirm: async (title: string, message: string) => {
				dialogs.push({ kind: "confirm", title, message });
				return self.confirm();
			},
			input: async (title: string, message?: string) => {
				dialogs.push({ kind: "input", title, message });
				return self.inputs.shift();
			},
		},
		sessionManager: { getSessionId: () => id },
		get model() {
			return self.model;
		},
	};
	const fire = async (event: string, payload: any = {}) => {
		let result: unknown;
		for (const handler of handlers[event] ?? []) result = (await handler(payload, ctx)) ?? result;
		return result;
	};
	return Object.assign(self, {
		chief: (args = "") => commands.chief.handler(args, ctx),
		/** `/guard <args>`, typed by the user in a session that loads guard. */
		guard: (args = "") => commands.guard.handler(args, ctx),
		start: () => fire("session_start", { reason: "startup" }),
		shutdown: () => fire("session_shutdown", { reason: "quit" }),
		tool: (toolName: string, path: unknown) => fire("tool_call", { toolName, input: { path, content: "" } }) as any,
		sent,
		notes,
		calls,
		dialogs,
		asUser,
		/** The wakes sent: the messages that start a turn. */
		wakes: () => sent.filter(({ options }) => options?.triggerTurn),
	});
}

/** Lets `looks` looks of the chief's timer run to their end, one at a time. */
async function tick(t: { mock: { timers: { tick(ms: number): void } } }, looks = 1) {
	for (let i = 0; i < looks; i++) {
		t.mock.timers.tick(INTERVAL);
		for (let j = 0; j < 10; j++) await new Promise((resolve) => setImmediate(resolve));
	}
}

const script = (cwd: string, ...argv: string[]) => main(argv, systemRunner, cwd);
const leaseOf = (cwd: string) => JSON.parse(script(cwd, "state").out).lease;

test("/chief claims the lease for the session, by Pi's process, and tells it how to call the script", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	const a = session("a", r.repo);
	await a.chief();
	assert.deepEqual(leaseOf(r.repo), { session: "a", generation: 1, pid: process.pid, process: "live" });
	assert.deepEqual(a.notes, [{ text: "chief lease: session a holds generation 1", type: "info" }]);
	// What the session is told does not start a turn, and carries its session and generation for every call.
	assert.equal(a.sent.length, 1);
	assert.equal(a.sent[0].options, undefined);
	assert.match(a.sent[0].message.content, /chief\.ts --session a --generation 1 <command>/);
	// It is told to read its skill, a file that is there, and how the user attaches.
	const skill = /^Read (\S+SKILL\.md) now, before anything else/m.exec(a.sent[0].message.content)![1];
	assert.match(readFileSync(skill, "utf8"), /^name: chief$/m);
	assert.match(a.sent[0].message.content, /`node \S+chief\.ts attach <task>`, in a terminal of their own/);
	// The command it was given is taken by the script.
	assert.deepEqual(script(r.repo, "--session", "a", "--generation", "1", "status"), { code: 0, out: "no tasks" });

	// A second /chief in the session that is the chief claims nothing more.
	await a.chief();
	assert.equal(r.events().length, 1);
	assert.match(a.notes.at(-1)!.text, /^this session is the chief of .*repo \(generation 1\)$/);
	assert.deepEqual(a.sent[1], a.sent[0], "and is told again what it was told");
	// It is told its own model in the form `launch --model` takes, as it is when it is told; never a guessed one.
	const launch = (said: string) => said.split("\n").find((line) => line.startsWith("`launch <task> --model"));
	assert.equal(
		launch(a.sent[0].message.content),
		"`launch <task> --model <provider/id>` names the coordinator's model: this session's is `some-provider/model-x`, which a coordinator uses unless the brief or the user names another.",
	);
	a.model = { provider: "other", id: "model-y" };
	await a.chief();
	assert.match(launch(a.sent[2].message.content)!, /this session's is `other\/model-y`,/);
	a.model = undefined;
	await a.chief();
	assert.equal(
		launch(a.sent[3].message.content),
		"`launch <task> --model <provider/id>` names the coordinator's model, and this session has none to give: ask the user which model to pass.",
	);
	await a.shutdown();
});

test("/chief is refused in a run that is not interactive, and claims nothing", async () => {
	for (const mode of ["print", "json", "rpc"]) {
		const r = repository();
		const a = session("a", r.repo, { mode });
		await assert.rejects(a.chief(), /\/chief is refused: only an interactive session can be the chief/, mode);
		assert.equal(existsSync(r.state), false, `${mode}: no state was created`);
		// Such a session shows no notice either, and its end releases nothing.
		await a.start();
		await a.shutdown();
		assert.deepEqual(a.notes, []);
	}
});

test("/chief is refused while another live session holds the lease, from the repo or a worktree", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	const a = session("a", r.repo);
	await a.chief();
	for (const cwd of [r.repo, r.worktree]) {
		const b = session("b", cwd);
		await b.chief();
		assert.equal(b.notes.length, 1);
		assert.equal(b.notes[0].type, "error");
		assert.match(
			b.notes[0].text,
			/^\/chief: refused: the chief lease is held: session a holds it \(generation 1, pid \d+\), and its process is running; only the user can confirm a takeover$/,
		);
		// The user was asked about a takeover, and said no.
		assert.deepEqual(
			b.dialogs.map((d) => d.kind),
			["confirm"],
		);
		assert.deepEqual(b.asUser, []);
		// The refused session is no chief: nothing is blocked for it, nothing wakes it, and its end releases nothing.
		assert.equal(await b.tool("write", join(r.repo, "x")), undefined);
		await tick(t, 3);
		assert.deepEqual(b.sent, []);
		await b.shutdown();
		assert.equal(leaseOf(r.repo).session, "a");
	}
	assert.equal(r.events().length, 1, "one claim");
	await a.shutdown();
});

test("/chief is refused where the repo's git directory is not in its main checkout, and claims nothing", async () => {
	const dir = join(ROOT, "apart");
	const checkout = join(dir, "checkout");
	mkdirSync(checkout, { recursive: true });
	mkdirSync(join(dir, "elsewhere"));
	git(checkout, "init", "-q", "-b", "main", "--separate-git-dir", join(dir, "elsewhere", "store.git"));
	const a = session("a", checkout);
	await a.chief();
	assert.equal(a.notes.length, 1);
	assert.match(a.notes[0].text, /^\/chief: refused: .*elsewhere is not this repo's main checkout/);
	assert.equal(existsSync(join(dir, "elsewhere.worktrees")), false, "nothing was claimed");
	assert.deepEqual(a.sent, []);
});

test("/chief outside a git checkout is refused by the script", async () => {
	const dir = join(ROOT, "plain");
	mkdirSync(dir);
	const a = session("a", dir);
	await a.chief();
	assert.match(a.notes[0].text, /^\/chief: refused: .* is not in a git checkout/);
	await a.start();
	assert.equal(a.notes.length, 1, "and a session started there shows no notice");
});

test("the chief's lease is released when its session ends, and a lease left by a session that is gone is reclaimed", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	const a = session("a", r.repo);
	await a.chief();
	await a.shutdown();
	assert.equal(leaseOf(r.repo), undefined);
	assert.deepEqual(
		r.events().map((e) => e.type),
		["lease-claimed", "lease-released"],
	);
	// Released once: a second shutdown of the same extension records nothing.
	await a.shutdown();
	assert.equal(r.events().length, 2);

	// A holder whose process is gone, with no release recorded: the next /chief reclaims.
	r.seed({ type: "lease-claimed", session: "dead", generation: 2, holder: GONE });
	const b = session("b", r.repo);
	await b.chief();
	assert.deepEqual(leaseOf(r.repo), { session: "b", generation: 3, pid: process.pid, process: "live" });
	await b.shutdown();
});

test("when a run ends the chief receives one message that says only to read status", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	const a = session("a", r.repo);
	await a.chief();
	await tick(t);
	assert.deepEqual(a.wakes(), [], "no run, no wake");

	// A run whose launch is gone: the look has the script record its end, and wakes the chief for it.
	r.seed(...r.launch("t", r.repo, "main"));
	await tick(t);
	assert.equal(r.events().at(-1).type, "launch-failed");
	const wakes = a.wakes();
	assert.equal(wakes.length, 1);
	assert.deepEqual(wakes[0].options, { triggerTurn: true });
	const { content, customType, display } = wakes[0].message;
	assert.deepEqual([customType, display], ["chief", true]);
	// Only to read status: nothing of the task, its run, or how it ended.
	assert.match(content, /^Read the chief's status: `node \S+chief\.ts --session a --generation 1 status`\.$/);
	assert.doesNotMatch(content, /\bt\b|launch|FAILED|run 1/);
	const said = /`node \S+ (.*)`/.exec(content)![1].split(" ");
	assert.match(script(r.repo, ...said).out, /^t: FAILED\(launch\) \(landing none, run 1\)/);

	// One message per run that ended: later looks find nothing new.
	await tick(t, 5);
	assert.equal(a.wakes().length, 1);

	// A run whose end its own wrapper recorded, and two runs over at one look: one message each time.
	r.seed({ type: "task-added", task: "u", landing: "none" }, { type: "task-added", task: "v", landing: "none" });
	await tick(t);
	assert.equal(a.wakes().length, 1, "a task with no run over wakes nobody");
	r.seed(...r.launch("w", r.worktree, "wt").slice(0, 1));
	r.seed(r.launch("u", r.repo, "main")[1], r.launch("v", r.worktree, "wt")[1]);
	await tick(t);
	assert.equal(a.wakes().length, 2);
	assert.equal(a.wakes()[1].message.content, content);
	await a.shutdown();
	await tick(t, 3);
	assert.equal(a.wakes().length, 2, "a session that ended is not woken");
});

test("a run that ended before /chief wakes nobody, and one past its deadline wakes the chief once", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	// A lease, since released, under which one run failed and another started 91 minutes ago and still runs.
	r.seed({ type: "lease-claimed", session: "old", generation: 1, holder: GONE });
	r.seed(...r.launch("done", r.worktree, "wt"), { type: "launch-failed", task: "done", run: 1, detail: "x" });
	r.seedAt(91, ...r.launch("slow", r.repo, "main", LIVE));
	const a = session("a", r.repo);
	await a.chief();
	await tick(t, 3);
	assert.deepEqual(a.wakes(), [], "what was so at the claim is not news: the new chief is told to read status");
	assert.match(a.sent[0].message.content, /read `status` now/);

	// A run that goes past its deadline while the session is chief.
	const at = r.seedAt(89, ...r.launch("late", r.worktree, "wt", LIVE));
	await tick(t);
	assert.deepEqual(a.wakes(), [], "not past its deadline yet");
	const state = () => JSON.parse(script(r.repo, "state").out).tasks.find((task: any) => task.id === "late");
	assert.equal(state().overdue, false);
	// Its deadline passes: the clock is the system's, so its events are rewritten as two minutes older.
	const log = readFileSync(join(r.state, "events.jsonl"), "utf8").replaceAll(at, r.ago(91));
	writeFileSync(join(r.state, "events.jsonl"), log);
	assert.equal(state().overdue, true);
	await tick(t, 3);
	assert.equal(a.wakes().length, 1, "one wake for the run, however long it stays overdue");
	assert.match(a.wakes()[0].message.content, /^Read the chief's status: /);
	await a.shutdown();
});

test("a session that no longer holds the lease receives no wake, and its end releases nothing", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	const a = session("a", r.repo);
	await a.chief();
	// The user took the lease over for another session; then a run ends.
	r.seed({ type: "lease-claimed", session: "b", generation: 2, holder: LIVE, takeover: true });
	r.seed(...r.launch("t", r.repo, "main"), { type: "launch-failed", task: "t", run: 1, detail: "x" });
	const before = r.events();
	await tick(t);
	assert.deepEqual(a.wakes(), []);
	assert.deepEqual(a.notes.at(-1), {
		text: `chief: this session no longer holds the chief lease of ${r.repo}; it is not woken and may edit again`,
		type: "warning",
	});
	// It is the chief no more: it stops looking, is not blocked, and its shutdown does not release its successor's lease.
	await tick(t, 5);
	assert.equal(a.notes.length, 2, "said once");
	assert.equal(await a.tool("write", join(r.repo, "x")), undefined);
	await a.shutdown();
	assert.deepEqual(r.events(), before, "the displaced session recorded nothing");
	assert.equal(leaseOf(r.repo).session, "b");
});

test("a session displaced between two looks is not woken by a run that ended in between", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	const a = session("a", r.repo);
	await a.chief();
	// A run whose end is there to record, and a takeover before the look.
	r.seed(...r.launch("t", r.repo, "main"));
	r.seed({ type: "lease-claimed", session: "b", generation: 2, holder: LIVE, takeover: true });
	const before = r.events();
	await tick(t);
	assert.deepEqual(a.wakes(), []);
	assert.deepEqual(r.events(), before, "the run's end is the new chief's to record");

	// A displaced session whose shutdown comes before any look: the script refuses the release.
	const r2 = repository();
	const c = session("c", r2.repo);
	await c.chief();
	r2.seed({ type: "lease-claimed", session: "d", generation: 2, holder: LIVE, takeover: true });
	await c.shutdown();
	assert.deepEqual(leaseOf(r2.repo), { session: "d", generation: 2, pid: process.pid, process: "live" });
	assert.equal(r2.events().length, 2);
});

test("a look that fails is shown once and tried again", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	const a = session("a", r.repo);
	await a.chief();
	appendFileSync(join(r.state, "events.jsonl"), '{"type":"nonsense","task":"zz"}\n');
	await tick(t, 3);
	assert.equal(a.notes.length, 2);
	assert.equal(a.notes[1].type, "error");
	assert.match(a.notes[1].text, /^chief: the look for ended runs failed: error: .*events\.jsonl:2 holds an event/);
	assert.deepEqual(a.wakes(), []);
	// The log is as it was again: the next look goes on.
	const [claim] = readFileSync(join(r.state, "events.jsonl"), "utf8").split("\n");
	writeFileSync(join(r.state, "events.jsonl"), `${claim}\n`);
	r.seed(...r.launch("t", r.repo, "main"));
	await tick(t);
	assert.equal(a.wakes().length, 1);
	await a.shutdown();
});

test("while chief, edit and write are blocked under the repo and its worktrees directory, except the notes area", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	const outside = join(ROOT, "outside");
	mkdirSync(outside, { recursive: true });
	symlinkSync(r.repo, join(outside, "to-repo"));
	symlinkSync(r.notes, join(outside, "to-notes"));
	const home = join(ROOT, "home-file");

	const a = session("a", r.repo);
	for (const tool of ["edit", "write"])
		assert.equal(await a.tool(tool, join(r.repo, "x")), undefined, "a session that is not the chief is not blocked");
	await a.chief();
	// The notes area need not be there yet: `write` makes it.
	assert.equal(existsSync(r.notes), false);
	assert.equal(await a.tool("write", join(r.notes, "memory.md")), undefined);
	mkdirSync(r.notes);

	const allowed = [
		join(r.notes, "memory.md"),
		join(r.notes, "deep", "er", "memory.md"),
		r.notes,
		join(outside, "x"),
		join(outside, "to-notes", "x"),
		home,
		`${r.repo}-other/x`,
		`${r.worktrees}-other/x`,
		`../${"repo.worktrees"}/.chief/notes/x`,
	];
	const refused: [path: string, under: string][] = [
		[join(r.repo, "x"), r.repo],
		[r.repo, r.repo],
		["x", r.repo],
		["./deep/x", r.repo],
		["@x", r.repo],
		[join(r.repo, ".git", "config"), r.repo],
		[join(outside, "to-repo", "x"), r.repo],
		[join(r.worktree, "x"), r.worktrees],
		[join(r.worktrees, "new-worktree", "x"), r.worktrees],
		["../repo.worktrees/wt/x", r.worktrees],
		// The rest of the chief's state is not the notes area: the log, a brief, a run's report.
		[join(r.state, "events.jsonl"), r.worktrees],
		[join(r.state, "tasks", "t", "brief.md"), r.worktrees],
		[`${r.notes}-other/x`, r.worktrees],
		[join(r.notes, "..", "events.jsonl"), r.worktrees],
		[join(r.notes, "..", "..", "..", "repo", "x"), r.repo],
	];
	for (const tool of ["edit", "write"]) {
		for (const path of allowed) assert.equal(await a.tool(tool, path), undefined, `${tool} ${path}`);
		for (const [path, under] of refused)
			assert.deepEqual(
				await a.tool(tool, path),
				{
					block: true,
					reason: `the chief does not edit the repo: ${path} is under ${under}. Write only under ${r.notes}; a change to the repo is a task's.`,
				},
				`${tool} ${path}`,
			);
	}
	// A link out of the notes area into the repo is the repo.
	symlinkSync(r.repo, join(r.notes, "link"));
	assert.equal((await a.tool("write", join(r.notes, "link", "x"))).block, true);
	// `~` and `file:` are not expanded, so that no path is read differently here than by Pi.
	for (const path of ["~/home-file", "~", `file://${join(r.repo, "x")}`, `file://${join(outside, "x")}`])
		assert.match(
			(await a.tool("edit", path)).reason,
			/^the chief does not edit the repo: give \S+ as an absolute path: `~` and `file:` are not expanded here\. /,
			path,
		);
	// A file system that ignores case names the repo by any case of its path.
	const shouted = join(r.repo.slice(0, -4), "REPO");
	if (existsSync(shouted)) assert.equal((await a.tool("write", join(shouted, "x"))).block, true);
	// A link that leads nowhere cannot be told to be outside the repo.
	symlinkSync(join(ROOT, "nowhere", "at", "all"), join(outside, "dangling"));
	assert.match(
		(await a.tool("write", join(outside, "dangling"))).reason,
		/dangling cannot be resolved, so it cannot be told to be outside/,
	);
	// Other tools are not this block's, and a call with no path is Pi's to refuse.
	assert.equal(await a.tool("read", join(r.repo, "x")), undefined);
	assert.equal(await a.tool("bash", join(r.repo, "x")), undefined);
	assert.equal(await a.tool("write", undefined), undefined);

	// From a worktree the same places are the repo's.
	const r2 = repository();
	const b = session("b", r2.worktree);
	await b.chief();
	assert.equal((await b.tool("edit", "x")).reason.includes(`x is under ${r2.worktrees}`), true);
	assert.equal((await b.tool("edit", join(r2.repo, "x"))).block, true);
	assert.equal(await b.tool("edit", join(r2.notes, "x")), undefined);

	// Once the session is no longer the chief, nothing is blocked.
	await a.shutdown();
	await b.shutdown();
	assert.equal(await a.tool("write", join(r.repo, "x")), undefined);

	// The notes area is the directory of that name: one that is a link into the repo opens nothing.
	const r3 = repository();
	mkdirSync(r3.state, { recursive: true });
	symlinkSync(r3.repo, r3.notes);
	const c = session("c", r3.repo);
	await c.chief();
	for (const path of [join(r3.repo, "x"), join(r3.notes, "x"), "x"])
		assert.match((await c.tool("write", path)).reason, / is under .*repo\. /, path);
	await c.shutdown();
});

test("another interactive session in the repo or a worktree shows one line naming the chief, and the task writing there", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	const before = session("early", r.repo);
	await before.start();
	assert.deepEqual(before.notes, [], "no chief, no run: no line");
	assert.equal(existsSync(r.state), false, "and reading made no state");

	const a = session("a", r.repo);
	await a.chief();
	const chief = `chief: session a (pid ${process.pid}) is the chief of ${r.repo}`;
	for (const cwd of [r.repo, r.worktree]) {
		const b = session("b", cwd);
		await b.start();
		assert.deepEqual(b.notes, [{ text: chief, type: "info" }], cwd);
		assert.deepEqual(b.sent, [], "a line for the user, nothing for the model");
	}
	// The chief's own session is not told of itself, nor is a session that is not interactive.
	await a.start();
	assert.equal(a.notes.length, 1);
	for (const mode of ["print", "json", "rpc"]) {
		const c = session("c", r.repo, { mode });
		await c.start();
		assert.deepEqual(c.notes, [], mode);
	}

	// A run live in the worktree: named there, and not in the main checkout.
	r.seed(...r.launch("fix-it", r.worktree, "wt", LIVE));
	const inWorktree = session("b", r.worktree);
	await inWorktree.start();
	assert.deepEqual(inWorktree.notes, [{ text: `${chief}; task fix-it is writing in this checkout`, type: "info" }]);
	const sub = join(r.worktree, "sub");
	mkdirSync(sub);
	const inSub = session("b", sub);
	await inSub.start();
	assert.equal(inSub.notes[0].text, `${chief}; task fix-it is writing in this checkout`, "from a directory of it too");
	const inRepo = session("b", r.repo);
	await inRepo.start();
	assert.deepEqual(inRepo.notes, [{ text: chief, type: "info" }]);

	// A run goes on when the chief is gone: the task is still named, and no chief is.
	const events = r.events().length;
	await a.shutdown();
	const later = session("b", r.worktree);
	await later.start();
	assert.deepEqual(later.notes, [
		{ text: `chief: ${r.repo} has no chief; task fix-it is writing in this checkout`, type: "info" },
	]);
	assert.equal(r.events().length, events + 1, "the notice recorded nothing: only the release is new");
	// A run that is over is no longer writing.
	r.seed({ type: "launch-failed", task: "fix-it", run: 1, detail: "x" });
	const after = session("b", r.worktree);
	await after.start();
	assert.deepEqual(after.notes, []);

	// A lease left held by a session whose process is gone names no chief.
	r.seed({ type: "lease-claimed", session: "dead", generation: 2, holder: GONE });
	const last = session("b", r.repo);
	await last.start();
	assert.deepEqual(last.notes, []);
});

test("state reads the log for a session that is not the chief, and records nothing", () => {
	const r = repository();
	assert.deepEqual(JSON.parse(script(r.worktree, "state").out), {
		repo: r.repo,
		worktrees: r.worktrees,
		notes: r.notes,
		tasks: [],
	});
	assert.equal(existsSync(r.state), false);
	assert.deepEqual(script(r.repo, "state", "x"), {
		code: 1,
		out: "refused: state takes nothing; usage: chief.ts state",
	});
	assert.equal(script(r.repo, "--session", "a", "claim", "--pid", String(process.pid)).code, 0);
	r.seed(...r.launch("t", r.worktree, "wt", LIVE), { type: "task-added", task: "q", landing: "none" });
	const before = r.events();
	const tasks = [
		{ id: "t", state: "LAUNCHING", run: 1, ended: 0, live: true, overdue: false, writing: true },
		{ id: "q", state: "QUEUED", run: 0, ended: 0, live: false, overdue: false, writing: false },
	];
	const lease = { session: "a", generation: 1, pid: process.pid, process: "live" };
	// With the caller's session and generation or without, from the chief or anyone.
	for (const caller of [[], ["--session", "zz", "--generation", "9"]])
		assert.deepEqual(JSON.parse(script(r.worktree, ...caller, "state").out).tasks, tasks);
	assert.deepEqual(JSON.parse(script(r.repo, "state").out), {
		repo: r.repo,
		worktrees: r.worktrees,
		notes: r.notes,
		lease,
		tasks: tasks.map((task) => ({ ...task, writing: false })),
	});
	assert.deepEqual(r.events(), before);
	// An append that is not finished is not an event yet, and a reader leaves it for its writer.
	appendFileSync(join(r.state, "events.jsonl"), '{"type":"task-added","task":"half"');
	const log = readFileSync(join(r.state, "events.jsonl"), "utf8");
	assert.deepEqual(JSON.parse(script(r.worktree, "state").out).tasks, tasks);
	assert.equal(readFileSync(join(r.state, "events.jsonl"), "utf8"), log);
	writeFileSync(join(r.state, "events.jsonl"), log.slice(0, log.lastIndexOf("\n") + 1));
	// A log that cannot be replayed is an error, not an empty state.
	appendFileSync(join(r.state, "events.jsonl"), '{"type":"nonsense","task":"zz"}\n');
	assert.equal(script(r.repo, "state").code, 2);
});

test("state waits for no lock: it answers while another process holds the repo lock", async () => {
	const r = repository();
	assert.equal(script(r.repo, "--session", "a", "claim", "--pid", String(process.pid)).code, 0);
	const holder = spawn(
		process.execPath,
		[
			"-e",
			'const lock = new (require("node:sqlite").DatabaseSync)(process.argv[1]); lock.exec("BEGIN IMMEDIATE"); console.log("held"); setInterval(() => {}, 1000);',
			join(r.state, "lock"),
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	try {
		const ended = once(holder, "close").then(() => Promise.reject(new Error("the lock holder ended early")));
		await Promise.race([once(holder.stdout, "data"), ended]);
		const began = Date.now();
		// What Pi's own process calls: the notice at a session's start, and the reading of every look.
		const b = session("b", r.repo);
		await b.start();
		assert.match(b.notes[0].text, /^chief: session a /);
		assert.equal(JSON.parse(script(r.repo, "state").out).lease.session, "a");
		assert.ok(Date.now() - began < 5000, "nothing waited for the lock");
	} finally {
		holder.kill("SIGKILL");
	}
});

test("a wake is sent only between turns, so none waits in a queue past a takeover", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	const a = session("a", r.repo);
	await a.chief();
	a.idle = false;
	r.seed(...r.launch("t", r.repo, "main"));
	await tick(t, 3);
	assert.equal(r.events().at(-1).type, "launch-failed", "the run's end is recorded meanwhile");
	assert.deepEqual(a.wakes(), [], "in the middle of a turn nothing is sent");
	// The turn is over: the first look after it wakes the session, once.
	a.idle = true;
	await tick(t, 3);
	assert.equal(a.wakes().length, 1);

	// A session displaced during its turn is never sent the wake for a run that ended in that turn.
	a.idle = false;
	r.seed(...r.launch("u", r.worktree, "wt"));
	await tick(t);
	r.seed({ type: "lease-claimed", session: "b", generation: 2, holder: LIVE, takeover: true });
	a.idle = true;
	await tick(t, 3);
	assert.equal(a.wakes().length, 1);
	assert.match(a.notes.at(-1)!.text, /no longer holds the chief lease/);
});

test("a session displaced while a look reconciles is not woken", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	const a = session("a", r.repo);
	await a.chief();
	r.seed(...r.launch("t", r.repo, "main"));
	// The takeover lands after the look read the lease and before its reconcile: the script refuses that.
	a.beforeReconcile = () =>
		r.seed({ type: "lease-claimed", session: "b", generation: 2, holder: LIVE, takeover: true });
	const before = r.events().length;
	await tick(t);
	assert.deepEqual(a.calls.slice(-3), ["state", "reconcile (child)", "state"]);
	assert.deepEqual(a.wakes(), []);
	assert.equal(r.events().length, before + 1, "only the takeover: the displaced session's reconcile recorded nothing");
	assert.match(a.notes.at(-1)!.text, /no longer holds the chief lease/);
});

test("a look reconciles in a process of its own, and only while a run is live", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	const a = session("a", r.repo, { reconcile: reconcileInChild });
	await a.chief();
	await tick(t, 2);
	assert.deepEqual(a.calls, ["state", "state", "claim", "state", "state"], "with no run live a look is one reading");
	r.seed(...r.launch("t", r.repo, "main"));
	t.mock.timers.tick(INTERVAL);
	for (let i = 0; i < 400 && a.wakes().length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(r.events().at(-1).type, "launch-failed", "recorded by the script run as a process");
	assert.equal(a.wakes().length, 1);
	// What the child answers is what the script answers: a refusal is code 1, with its words.
	assert.deepEqual(await reconcileInChild(["--session", "zz", "--generation", "9", "reconcile"], r.repo), {
		code: 1,
		out:
			"refused: session zz (generation 9) does not hold the chief lease: session a holds it (generation 1, pid " +
			`${process.pid})`,
	});
	await a.shutdown();
});

test("a session that ends while its look reconciles is not woken, and releases its lease", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	const pending = Promise.withResolvers<Answer>();
	const a = session("a", r.worktree, { reconcile: () => pending.promise });
	await a.chief();
	r.seed(...r.launch("t", r.repo, "main"), { type: "launch-failed", task: "t", run: 1, detail: "x" });
	r.seed(...r.launch("u", r.repo, "main", LIVE));
	await tick(t, 3);
	assert.equal(a.calls.filter((call) => call === "reconcile (child)").length, 1, "one look at a time");
	// The session's own worktree is removed under it; its end still releases the lease, in the repo.
	git(r.repo, "worktree", "remove", r.worktree);
	await a.shutdown();
	assert.equal(leaseOf(r.repo), undefined);
	pending.resolve({ code: 0, out: "nothing to reconcile" });
	await tick(t, 2);
	assert.deepEqual(a.wakes(), [], "the look that was under way sends nothing");
});

test("the look's reconcile tells the script's refusal from a process that failed or hung", async () => {
	const r = repository();
	const lease = ["--session", "zz", "--generation", "9"];
	assert.match((await reconcileInChild([...lease, "reconcile"], r.repo)).out, /^refused: session zz /);
	// Exit code 1 without the script's refusal (here its usage) is not one, and neither is a process that never ran.
	const usage = await reconcileInChild(["no-such-command"], r.repo);
	assert.equal(usage.code, 2);
	assert.match(usage.out, /^usage: chief\.ts /);
	assert.equal((await reconcileInChild([...lease, "reconcile"], join(ROOT, "no-such-directory"))).code, 2);
	// Outside a checkout the script refuses, and says so.
	assert.equal((await reconcileInChild([...lease, "reconcile"], ROOT)).code, 1);
	// One that does not end is killed, and is a failure.
	assert.equal(script(r.repo, "--session", "a", "claim", "--pid", String(process.pid)).code, 0);
	const holder = spawn(
		process.execPath,
		[
			"-e",
			'const lock = new (require("node:sqlite").DatabaseSync)(process.argv[1]); lock.exec("BEGIN IMMEDIATE"); console.log("held"); setInterval(() => {}, 1000);',
			join(r.state, "lock"),
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	try {
		const ended = once(holder, "close").then(() => Promise.reject(new Error("the lock holder ended early")));
		await Promise.race([once(holder.stdout, "data"), ended]);
		const hung = await reconcileInChild(["--session", "a", "--generation", "1", "reconcile"], r.repo, 1500);
		assert.equal(hung.code, 2);
	} finally {
		holder.kill("SIGKILL");
	}
});

test("a reconcile that fails is shown, wakes nobody, and is tried again", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	const a = session("a", r.repo);
	await a.chief();
	r.seed(...r.launch("t", r.repo, "main"));
	a.fail = "reconcile";
	await tick(t, 3);
	assert.deepEqual(a.notes.slice(1), [{ text: "chief: the look for ended runs failed: error: boom", type: "error" }]);
	assert.deepEqual(a.wakes(), []);
	a.fail = undefined;
	await tick(t);
	assert.equal(a.wakes().length, 1);
	await a.shutdown();
});

test("/chief that cannot read the state claims nothing, and a session start that cannot says so", async () => {
	const r = repository();
	const a = session("a", r.repo);
	a.fail = "state";
	await assert.rejects(a.chief(), /error: boom/);
	assert.equal(existsSync(r.state), false, "nothing was claimed");
	assert.deepEqual(a.sent, []);
	assert.equal(await a.tool("write", join(r.repo, "x")), undefined);
	await assert.rejects(a.start(), /error: boom/);
	// Pi shows the error of a handler that throws; the session is no chief and its end releases nothing.
	await a.shutdown();
	assert.equal(existsSync(r.state), false);
});

test("a release that fails leaves the lease with the session, which /chief takes up again", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	const a = session("a", r.repo);
	await a.chief();
	a.fail = "release";
	await assert.rejects(
		a.shutdown(),
		/^Error: chief: the lease of .*repo was not released \(error: boom\); \/chief in this session takes it up again$/,
	);
	a.fail = undefined;
	assert.equal(leaseOf(r.repo).session, "a", "still held, by a process that is running");
	// The same session and process, as after /reload: no claim is needed, and none is recorded.
	await a.chief();
	assert.equal(r.events().length, 1);
	assert.equal(a.notes.at(-1)!.text, "chief lease: session a holds generation 1 still");
	assert.equal((await a.tool("write", join(r.repo, "x"))).block, true);
	assert.deepEqual(script(r.repo, "--session", "a", "--generation", "1", "status"), { code: 0, out: "no tasks" });
	// Another session is refused as ever.
	const b = session("b", r.repo);
	await b.chief();
	assert.match(b.notes[0].text, /^\/chief: refused: the chief lease is held/);
	await a.shutdown();
	assert.equal(leaseOf(r.repo), undefined);
});

test("/chief over a live holder asks the user, and takes the lease over only when they confirm", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	const a = session("a", r.repo);
	await a.chief();
	const b = session("b", r.worktree);
	b.confirm = () => true;
	await b.chief();
	// The user was shown the holder as it was, and the takeover names that holder's generation.
	assert.equal(b.dialogs.length, 1);
	assert.equal(b.dialogs[0].title, `Take over as the chief of ${r.repo}?`);
	assert.match(
		b.dialogs[0].message!,
		/^Session a \(generation 1, pid \d+\) holds the chief lease, and its process is running\./,
	);
	assert.deepEqual(b.asUser, [["--session", "b", "claim", "--pid", String(process.pid), "--takeover", "1"]]);
	assert.deepEqual(b.notes.at(-1), {
		text: "chief lease: session b holds generation 2, taken over from session a (generation 1)",
		type: "info",
	});
	assert.equal(r.events().at(-1).takeover, true);
	assert.equal((await b.tool("write", join(r.repo, "x"))).block, true, "the new chief is the chief");
	// The displaced session finds out at its next look, and its end releases nothing.
	await tick(t);
	assert.match(a.notes.at(-1)!.text, /no longer holds the chief lease/);
	await a.shutdown();
	assert.equal(leaseOf(r.repo).session, "b");
	await b.shutdown();
});

test("a takeover confirmed for a holder that another session has replaced since is refused", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	const a = session("a", r.repo);
	await a.chief();
	const b = session("b", r.repo);
	// While the dialog is open, a third session takes the lease.
	b.confirm = () => {
		r.seed({ type: "lease-claimed", session: "c", generation: 2, holder: LIVE, takeover: true });
		return true;
	};
	await b.chief();
	assert.deepEqual(b.notes.at(-1), {
		text: `/chief: refused: the takeover was confirmed for generation 1 of the chief lease, which is no longer held: session c holds it (generation 2, pid ${process.pid})`,
		type: "error",
	});
	assert.equal(leaseOf(r.repo).session, "c");
	assert.equal(await b.tool("write", join(r.repo, "x")), undefined, "b is no chief");
	await a.shutdown();
});

test("what only the user may do succeeds when the user types it after /chief, and is refused when the script is called any other way", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	const failed = (run: number) => ({ type: "launch-failed", task: "t", run, detail: "x" });
	r.seed(...r.launch("t", r.repo, "main"), failed(1));
	r.seed({ type: "round", task: "t", session: "t-2", launcher: GONE }, failed(2));
	r.seed({ type: "task-added", task: "q", landing: "none" });
	const a = session("a", r.repo);
	// Typed by a session that is not the chief: nothing is called.
	await a.chief("drop q");
	assert.match(a.notes.at(-1)!.text, /^this session is not the chief: type \/chief first; usage: /);
	assert.deepEqual(a.calls, []);
	await a.chief();
	const as = ["--session", "a", "--generation", "1"];
	const types = () => r.events().map((e) => e.type);
	const before = types();

	// The model's way to the script, a process or a call that does not say it is the user's, is refused.
	const approve = ["approve", "t", "--action=git branch -D", "--target=branch old-spike", "--words=yes, delete it"];
	for (const argv of [approve, ["drop", "q"], ["lift", "t"]])
		assert.match(
			script(r.repo, ...as, ...argv).out,
			/^refused: .* is taken only from the user's own command or dialog; the user types `\/chief /,
		);
	assert.deepEqual(types(), before);

	// An approval: the user types its action, its target and their words, each into a dialog.
	a.inputs = ["git branch -D", " branch old-spike ", "yes, delete it"];
	await a.chief("approve t");
	assert.deepEqual(
		a.dialogs.map((d) => [d.kind, d.title]),
		["action", "target", "words"].map((part) => ["input", `Approve for task t: the ${part}`]),
	);
	assert.deepEqual(a.asUser, [[...as, ...approve]]);
	const { at: _at, ...approval } = r.events().at(-1);
	assert.deepEqual(approval, {
		type: "approval",
		task: "t",
		action: "git branch -D",
		target: "branch old-spike",
		words: "yes, delete it",
	});
	assert.equal(a.notes.at(-1)!.type, "info");
	// The session is told what the user did, by a message that starts no turn.
	assert.match(
		a.sent.at(-1)!.message.content,
		/^The user typed `\/chief approve t`: task t: the user approved action/,
	);
	assert.equal(a.sent.at(-1)!.options, undefined);

	// A dialog left unanswered approves nothing.
	a.inputs = ["git clean", undefined];
	await a.chief("approve t");
	assert.deepEqual(a.notes.at(-1), {
		text: "/chief approve: no target was given, and nothing was approved",
		type: "warning",
	});
	assert.equal(a.asUser.length, 1);

	// Lifting the retry cap, and a drop.
	await a.chief("lift t");
	assert.deepEqual(a.notes.at(-1), { text: "task t: the retry cap is lifted; a round may start", type: "info" });
	await a.chief("drop q");
	assert.deepEqual(a.notes.at(-1), { text: "task q: DROPPED", type: "info" });
	assert.deepEqual(types().slice(before.length), ["approval", "cap-lifted", "drop"]);
	// The script's refusal is shown: a task that is dropped is not dropped again.
	await a.chief("drop q");
	assert.deepEqual(a.notes.at(-1), {
		text: "/chief drop: refused: task q is DROPPED: drop is not allowed; allowed commands: none",
		type: "error",
	});

	// A failure of the script is told from its refusal: what it recorded is not known.
	a.fail = "lift";
	await a.chief("lift t");
	a.fail = undefined;
	assert.deepEqual(a.notes.at(-1), {
		text: "/chief lift: the script failed, and may or may not have recorded it; read `status` before typing it again: error: boom",
		type: "error",
	});

	// The user's answer is given as the user's, in the words typed: the script refuses it here for the task's
	// state, not for who asks.
	await a.chief("answer t  use the --old flag,  please");
	assert.deepEqual(a.asUser.at(-1), [...as, "answer", "t", "--words=use the --old flag,  please"]);
	assert.match(a.notes.at(-1)!.text, /^\/chief answer: refused: task t is FAILED\(launch\): answer is not allowed/);

	// What is not one of these commands calls nothing.
	const calls = a.asUser.length;
	for (const args of ["approve", "drop q now", "answer t", "claim --takeover 1", "accept t", "status"]) {
		await a.chief(args);
		assert.match(a.notes.at(-1)!.text, /^usage: \/chief, or as the chief: /, args);
	}
	assert.equal(a.asUser.length, calls);
	await a.shutdown();
});

test("/chief cleanup, typed by the user, removes a task's worktree with real git: refused with untracked or ignored files, never forced, the branch kept", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	const commit = git(r.repo, "rev-parse", "HEAD").trim();
	// A `branch` task whose launch made the worktree and then died: reconcile records it as FAILED(launch).
	r.seed(
		{ type: "task-added", task: "t", landing: "branch" },
		{
			type: "launch",
			task: "t",
			run: 1,
			session: "t-1",
			model: "m",
			checkout: r.worktree,
			as: { branch: "wt", commit, tree: "" },
			launcher: GONE,
		},
		{ type: "worktree-created", task: "t", run: 1 },
	);
	const a = session("a", r.repo);
	await a.chief();
	const as = ["--session", "a", "--generation", "1"];
	assert.match(script(r.repo, ...as, "status").out, /^t: FAILED\(launch\) \(landing branch, run 1\)/);
	const types = () => r.events().map((e) => e.type);
	const before = types();

	// The model's way to the script is refused.
	assert.equal(
		script(r.repo, ...as, "cleanup", "t").out,
		"refused: removing a worktree is taken only from the user's own command or dialog; the user types `/chief cleanup <task>`",
	);

	// Committed work, an ignored file and an untracked one.
	writeFileSync(join(r.worktree, ".gitignore"), "cache/\n");
	git(r.worktree, "add", ".gitignore");
	git(r.worktree, "commit", "-q", "-m", "work");
	const head = git(r.repo, "rev-parse", "wt").trim();
	mkdirSync(join(r.worktree, "cache"));
	writeFileSync(join(r.worktree, "cache/big"), "x");
	// Ignored files are found whatever the user's git configuration says of untracked ones.
	git(r.repo, "config", "status.showUntrackedFiles", "no");
	writeFileSync(join(r.worktree, "notes.txt"), "x");
	await a.chief("cleanup t");
	assert.equal(a.notes.at(-1)!.type, "error");
	assert.match(
		a.notes.at(-1)!.text,
		/^\/chief cleanup: refused: worktree .* which a removal would lose; nothing was removed\. `git status --ignored` lists:\n\?\? notes\.txt\n!! cache\/$/,
	);
	rmSync(join(r.worktree, "notes.txt"));
	await a.chief("cleanup t");
	assert.match(a.notes.at(-1)!.text, /lists:\n!! cache\/$/);
	assert.equal(readFileSync(join(r.worktree, "cache/big"), "utf8"), "x", "nothing was removed");
	assert.deepEqual(types(), before);

	// Clean: removed, as the user's, and the task has no checkout left.
	rmSync(join(r.worktree, "cache"), { recursive: true });
	await a.chief("cleanup t");
	assert.deepEqual(a.asUser.at(-1), [...as, "cleanup", "t"]);
	assert.deepEqual(a.notes.at(-1), {
		text: `task t: worktree ${r.worktree} is removed, and branch wt is kept; the task is now ASKED(user)`,
		type: "info",
	});
	assert.equal(existsSync(r.worktree), false);
	assert.equal(git(r.repo, "rev-parse", "wt").trim(), head, "the branch and its commit are kept");
	assert.doesNotMatch(git(r.repo, "worktree", "list"), /\/wt /);
	assert.deepEqual(types().slice(before.length), ["cleanup"]);
	assert.match(
		script(r.repo, ...as, "status").out,
		/^t: ASKED\(user\) \(landing branch, run 1\)\n {2}worktree .* was removed by the user's cleanup, and branch wt was kept/,
	);
	await a.shutdown();
});

test("/chief is refused while a batch-chief run is unfinished, and taken once it is finished", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	const batch = join(r.worktrees, ".batch");
	mkdirSync(join(batch, "run-1"), { recursive: true });
	const preflight = { at: r.ago(5), type: "preflight", version: 2, repo: r.repo, base: "main", tickets: [7] };
	writeFileSync(join(batch, "run-1", "events.jsonl"), `${JSON.stringify(preflight)}\n`);
	writeFileSync(join(batch, "current"), "run-1\n");
	const a = session("a", r.repo);
	await a.chief();
	assert.deepEqual(a.notes, [
		{
			text: `/chief: refused: no session becomes the chief of ${r.repo} now: a batch-chief run is unfinished there (run run-1 still has rows that are not terminal: #7), and the chief and batch-chief do not supervise one repo together; finish that run first, to its \`batch.ts cleanup\``,
			type: "error",
		},
	]);
	assert.equal(existsSync(r.state), false, "nothing was claimed");
	assert.deepEqual(a.dialogs, [], "and no takeover is offered: there is no holder");
	assert.deepEqual(a.sent, []);
	assert.equal(await a.tool("write", join(r.repo, "x")), undefined, "the session is not the chief");

	// The run's last row is dropped: it is finished.
	const drop = { at: r.ago(1), ticket: 7, type: "drop", user: "drop it" };
	appendFileSync(join(batch, "run-1", "events.jsonl"), `${JSON.stringify(drop)}\n`);
	await a.chief();
	assert.deepEqual(a.notes.at(-1), { text: "chief lease: session a holds generation 1", type: "info" });

	// A batch started under the idle chief: /chief says so, the session keeps its lease, and no run is started.
	const later = { ...preflight, tickets: [8] };
	mkdirSync(join(batch, "run-2"));
	writeFileSync(join(batch, "run-2", "events.jsonl"), `${JSON.stringify(later)}\n`);
	writeFileSync(join(batch, "current"), "run-2\n");
	await a.chief();
	assert.equal(a.notes.at(-1)!.type, "warning");
	assert.match(
		a.notes.at(-1)!.text,
		/^this session is the chief of .*repo \(generation 1\); no run is started: a batch-chief run is unfinished there \(run run-2 still has rows that are not terminal: #8\)/,
	);
	assert.equal(leaseOf(r.repo).session, "a");

	// A lease this session was left holding by a release that failed is not taken up again beside a batch.
	a.fail = "release";
	await assert.rejects(a.shutdown(), /was not released/);
	a.fail = undefined;
	const notes = a.notes.length;
	await a.chief();
	assert.equal(a.notes.length, notes + 1);
	assert.match(a.notes.at(-1)!.text, /^\/chief: refused: no session becomes the chief of .*run-2 still has rows/);
	assert.equal(await a.tool("write", join(r.repo, "x")), undefined, "the session is not the chief");
	assert.deepEqual(a.dialogs, [], "and no takeover is offered beside a batch");
});

test("the chief's lease records the guard state of its session: as it is at /chief, and after every /guard the user types", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	const guards = () =>
		r
			.events()
			.filter((e) => e.type === "lease-guard")
			.map(({ at: _at, type: _type, ...e }) => e);
	const told = (s: ReturnType<typeof session>) =>
		s.sent[0].message.content.split("\n").find((line: string) => /guard/i.test(line));

	// Guard on, the default: a lease starts so, and nothing is recorded. It is asked as the user's, of guard itself.
	const a = session("a", r.repo, { guard: true });
	await a.chief();
	const as = ["--session", "a", "--generation", "1"];
	assert.deepEqual(a.asUser, [[...as, "guard", "on"]]);
	assert.deepEqual(guards(), []);
	assert.equal(leaseOf(r.repo).unguarded, undefined);
	assert.match(told(a), /^Guard is on in this session, and a run starts with the guard state this session has then: /);
	assert.match(told(a), /an approval does not reach guard, and a run that is live keeps the state it started with\.$/);

	// The model's way to the script is refused: only what guard says in this session is recorded.
	assert.match(script(r.repo, ...as, "guard", "off").out, /^refused: the guard state of the chief's session is taken/);

	// The user types `/guard off`: recorded on the lease, and the session is told by a message that starts no turn.
	await a.guard("off");
	assert.deepEqual(a.asUser.at(-1), [...as, "guard", "off"]);
	assert.deepEqual(guards(), [{ session: "a", generation: 1, guard: "off" }]);
	assert.equal(leaseOf(r.repo).unguarded, true);
	assert.equal(
		a.sent.at(-1)!.message.content,
		"The user typed `/guard off`: chief lease: guard off; a run started from now is unguarded, and a run that is live stays guarded if it started so",
	);
	assert.equal(a.sent.at(-1)!.options, undefined);
	// Said again, the session is told the state as it is now.
	await a.chief();
	assert.match(
		a.sent.at(-1)!.message.content,
		/^Guard is off in this session, .*the runs you start now are unguarded/m,
	);
	// A question to guard, and a mistake, record nothing.
	const calls = a.asUser.length;
	await a.guard("");
	await a.guard("maybe");
	assert.equal(a.asUser.length, calls);
	await a.guard("on");
	assert.deepEqual(guards().at(-1), { session: "a", generation: 1, guard: "on" });
	assert.equal(leaseOf(r.repo).unguarded, undefined);

	// A session that is not the chief records nothing, whatever its guard does.
	const other = session("other", r.worktree, { guard: true });
	await other.guard("off");
	assert.deepEqual(other.calls, []);
	assert.equal(guards().length, 2);
	await a.shutdown();

	// A session whose guard is off already when it becomes the chief: recorded at the claim, before any run.
	await other.chief();
	assert.deepEqual(other.asUser, [["--session", "other", "--generation", "2", "guard", "off"]]);
	assert.deepEqual(guards().at(-1), { session: "other", generation: 2, guard: "off" });
	assert.equal(leaseOf(r.repo).unguarded, true);
	assert.match(told(other), /^Guard is off in this session, /);
	await other.shutdown();

	// A session started with guard off by whoever launched it is recorded the same way.
	process.env.ME_PI_GUARD = "off";
	t.after(() => delete process.env.ME_PI_GUARD);
	const started = session("started", r.repo, { guard: true });
	delete process.env.ME_PI_GUARD;
	await started.chief();
	assert.deepEqual(guards().at(-1), { session: "started", generation: 3, guard: "off" });
	await started.shutdown();
});

test("a chief session that loads no guard records no guard state, and is told so; one displaced is told its /guard was not recorded", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	const a = session("a", r.repo);
	await a.chief();
	assert.deepEqual(a.asUser, []);
	assert.equal(r.events().length, 1, "only the claim");
	assert.equal(leaseOf(r.repo).unguarded, undefined);
	assert.match(
		a.sent[0].message.content,
		/^No guard is loaded in this session, so none is recorded for a run: a coordinator has guard when its own settings load it\.$/m,
	);
	await a.shutdown();

	// A chief that was taken over since: the script refuses its guard state, which is shown, and nothing is recorded.
	const b = session("b", r.repo, { guard: true });
	await b.chief();
	const c = session("c", r.worktree, { guard: true });
	c.confirm = () => true;
	await c.chief();
	const before = r.events().length;
	const sent = b.sent.length;
	await b.guard("off");
	assert.equal(r.events().length, before);
	assert.equal(b.sent.length, sent);
	assert.deepEqual(b.notes.at(-2), {
		text:
			"chief: guard off was not recorded for the runs this session starts, and is tried again: refused: session b (generation 2) does not hold the chief lease: session c holds it (generation 3, pid " +
			`${process.pid})`,
		type: "error",
	});
	assert.equal(leaseOf(r.repo).unguarded, undefined);
	await c.shutdown();
	await b.shutdown();
});

test("a /guard on the lease could not record is tried again at every look, and until it is recorded the chief runs no bash, takes no /chief answer and is not woken", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const r = repository();
	const a = session("a", r.repo, { guard: true });
	await a.chief();
	await a.guard("off");
	assert.equal(leaseOf(r.repo).unguarded, true);
	assert.equal(await a.tool("bash", undefined), undefined, "with the lease as the session is, bash runs");

	// The script fails while the user turns guard on: the lease still says off, so a run started now would be unguarded.
	a.fail = "guard";
	const sent = a.sent.length;
	await a.guard("on");
	assert.equal(leaseOf(r.repo).unguarded, true);
	assert.equal(a.sent.length, sent, "the session is not told of a state that was not recorded");
	assert.deepEqual(a.notes.at(-2), {
		text: "chief: guard on was not recorded for the runs this session starts, and is tried again; until it is, this session runs no bash and takes no /chief answer, so it starts no run unguarded: error: boom",
		type: "error",
	});
	const blocked = await a.tool("bash", undefined);
	assert.equal(blocked.block, true);
	assert.match(
		blocked.reason,
		/^the chief runs no bash until the lease of .* records that guard is on in this session/,
	);
	// The user's own answer would start a run too: the recording is tried again first, and the answer is refused
	// before the script is asked.
	const as = ["--session", "a", "--generation", "1"];
	const tries = () => a.asUser.filter((argv) => argv.at(-2) === "guard" && argv.at(-1) === "on").length;
	const first = tries();
	await a.chief("answer t go on");
	assert.equal(tries(), first + 1);
	assert.deepEqual(a.notes.at(-1), {
		text: "/chief answer: refused: the lease does not yet record that guard is on in this session, so the run this answer starts would be unguarded; nothing was recorded. Type it again once /guard on is recorded.",
		type: "error",
	});
	assert.equal(
		a.asUser.some((argv) => argv.includes("answer")),
		false,
	);
	// Tried again at the next look, and shown once. A run that ended meanwhile wakes nobody yet: the session,
	// with no bash, could not read status.
	r.seed(...r.launch("t", r.repo, "main"));
	const notes = a.notes.length;
	await tick(t);
	assert.equal(tries(), first + 2, "the look asked the script again");
	assert.equal(leaseOf(r.repo).unguarded, true);
	assert.equal((await a.tool("bash", undefined)).block, true);
	assert.equal(a.notes.length, notes);
	assert.equal(r.events().at(-1).type, "launch-failed", "the look still recorded what became of the run");
	assert.deepEqual(a.wakes(), []);

	// The script answers again: the next look records it, bash runs, the wake that waited is sent, and the
	// user's answer reaches the script, which refuses it here for the task's state.
	a.fail = undefined;
	await tick(t);
	assert.equal(leaseOf(r.repo).unguarded, undefined);
	assert.equal(r.events().at(-1).guard, "on");
	assert.equal(await a.tool("bash", undefined), undefined);
	assert.equal(a.wakes().length, 1);
	await a.chief("answer t go on");
	assert.deepEqual(a.asUser.at(-1), [...as, "answer", "t", "--words=go on"]);
	assert.match(a.notes.at(-1)!.text, /^\/chief answer: refused: task t is FAILED\(launch\): answer is not allowed/);

	// A `/guard off` that could not be recorded leaves runs guarded, which blocks nothing of the chief's.
	a.fail = "guard";
	await a.guard("off");
	assert.equal(leaseOf(r.repo).unguarded, undefined);
	assert.equal(await a.tool("bash", undefined), undefined);
	a.fail = undefined;
	await tick(t);
	assert.equal(leaseOf(r.repo).unguarded, true);
	await a.shutdown();
});
