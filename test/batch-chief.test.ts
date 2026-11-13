import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepare } from "../packages/pi-workers/extensions/delegate-implement.ts";
import registerGuard from "../packages/pi-workers/extensions/guard.ts";
import {
	dialogVisible,
	implementLock,
	main,
	type Result,
	type Runner,
	timerDecision,
	timerPoll,
	watch,
} from "../skills/batch-chief/batch.ts";

test("timer decision stops superseded rows, detects overdue or two definite absences, and bounds refusals", () => {
	const base = {
		running: true,
		deadline: 100,
		expected: 100,
		now: 50,
		absent: false,
		misses: 0,
		tries: 0,
		late: false,
		blocker: false,
	};
	assert.equal(timerDecision({ ...base, running: false }).action, "exit");
	assert.equal(timerDecision({ ...base, deadline: 101 }).action, "exit");
	assert.deepEqual(timerDecision({ ...base, absent: true }), { action: "wait", misses: 1, tries: 0, late: false });
	assert.equal(timerDecision({ ...base, absent: true, misses: 1 }).action, "send");
	assert.equal(timerDecision({ ...base, absent: false, misses: 1 }).misses, 0);
	assert.equal(timerDecision({ ...base, now: 100 }).action, "send");
	assert.deepEqual(timerDecision({ ...base, now: 100, blocker: true }), {
		action: "wait",
		misses: 0,
		tries: 1,
		late: true,
	});
	assert.equal(timerDecision({ ...base, now: 100, blocker: true, tries: 19, late: true }).action, "give-up");
});

test("timer decision starts a fresh budget on crossing the deadline", () => {
	assert.deepEqual(
		timerDecision({
			running: true,
			deadline: 100,
			expected: 100,
			now: 100,
			absent: true,
			misses: 1,
			tries: 19,
			late: false,
			blocker: true,
		}),
		{ action: "wait", misses: 2, tries: 1, late: true },
	);
});

test("timer decision gives up on the twentieth late refusal", () => {
	assert.deepEqual(
		timerDecision({
			running: true,
			deadline: 100,
			expected: 100,
			now: 100,
			absent: true,
			misses: 1,
			tries: 19,
			late: true,
			blocker: true,
		}),
		{ action: "give-up", misses: 2, tries: 20, late: true },
	);
});

test("timer pre-deadline refusal budget resets and preserves deadline budget", () => {
	const base = {
		running: true,
		deadline: 100,
		expected: 100,
		now: 50,
		absent: true,
		misses: 1,
		tries: 19,
		late: false,
		blocker: true,
	};
	assert.deepEqual(timerDecision(base), { action: "wait", misses: 0, tries: 0, late: false });
	assert.equal(timerDecision({ ...base, now: 100, late: true }).action, "give-up");
});

test("timer retries after coordinator returns when dialog closes", () => {
	const base = {
		running: true,
		deadline: 100,
		expected: 100,
		now: 50,
		absent: false,
		misses: 1,
		tries: 1,
		late: false,
		blocker: false,
	};
	assert.deepEqual(timerDecision(base), { action: "send", misses: 0, tries: 1, late: false });
});

// Every effect goes through a fake runner; files live under a temp dir, never the real ~/.pi or this checkout.
const ROOT = mkdtempSync(join(tmpdir(), "batch-chief-test-"));
process.env.HOME = ROOT;
process.env.TMPDIR = ROOT;
process.env.PI_CODING_AGENT_DIR = join(ROOT, "agent");
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));

const SHA = "1111111111111111111111111111111111111111";
const HEAD = "2222222222222222222222222222222222222222";
const MOVED = "3333333333333333333333333333333333333333";
const RULES = JSON.stringify([
	{
		type: "required_status_checks",
		parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "check" }] },
	},
	{ type: "pull_request", parameters: { allowed_merge_methods: ["squash"] } },
]);

let fixtures = 0;

/**
 * A run fixture: a repo directory, a fake runner for git, gh and the clock, and the run's files. `entry` is the
 * helper's `main`, or that of a copy of the skill directory.
 */
function fixture(entry = main) {
	const dir = join(ROOT, `f${fixtures++}`);
	const repo = join(dir, "repo");
	mkdirSync(repo, { recursive: true });
	let now = new Date("2026-11-11T10:00:00.000Z");
	const calls: string[] = [];
	const ok = (stdout = ""): Result => ({ code: 0, stdout, stderr: "" });
	const state = {
		rules: ok(RULES) as Result,
		prs: {} as Record<string, object>,
		/** Per-command-line answers that win over the defaults below. */
		exec: {} as Record<string, Result | (() => Result)>,
		timers: [] as { dir: string; ticket: string; deadline: string }[],
		timerPid: 99999999,
		timerError: "",
	};
	const runner: Runner = {
		startTimer(dir, ticket, deadline) {
			state.timers.push({ dir, ticket, deadline });
			if (state.timerError) throw new Error(state.timerError);
			return state.timerPid;
		},
		now: () => now,
		exec(cmd, args) {
			const line = [cmd, ...args].join(" ");
			calls.push(line);
			const answer = state.exec[line];
			if (answer) return typeof answer === "function" ? answer() : answer;
			if (cmd === "sleep") return ok();
			if (line === "git rev-parse --path-format=absolute --git-common-dir") return ok(`${repo}/.git\n`);
			if (line === "git rev-parse --abbrev-ref HEAD") return ok("main\n");
			if (line === "git rev-parse HEAD") return ok(`${SHA}\n`);
			if (line === "git status --porcelain") return ok("");
			if (args[0] === "--version") return ok(`${cmd} 1.0\n`);
			if (line === "gh api repos/{owner}/{repo}/rules/branches/main") return state.rules;
			// origin's base is where the main checkout is, and no other remote branch is left.
			if (line === "git ls-remote origin refs/heads/main") return ok(`${SHA}\trefs/heads/main\n`);
			if (/^git ls-remote origin refs\/heads\/\S+$/.test(line)) return ok("");
			const view = /^gh pr view (\S+) --json /.exec(line);
			if (view) {
				const pr = state.prs[view[1]];
				return pr
					? ok(JSON.stringify(pr))
					: { code: 1, stdout: "", stderr: `no pull requests found for branch "${view[1]}"` };
			}
			return { code: 1, stdout: "", stderr: `fake runner: unexpected ${line}` };
		},
	};
	const run = (...argv: string[]) => entry(argv, runner, repo);
	const batch = join(`${repo}.worktrees`, ".batch");
	const runDir = () => join(batch, readFileSync(join(batch, "current"), "utf8").trim());
	const events = () =>
		readFileSync(join(runDir(), "events.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	const at = (time: string) => {
		now = new Date(`2026-11-11T${time}:00.000Z`);
	};
	const brief = join(dir, "brief.md");
	writeFileSync(brief, "# Brief\n\n- The test may use a fake clock.\n");
	const report = (n: number | string, status: string, time: string) => {
		const path = join(dir, `report-${n}.md`);
		writeFileSync(path, `# Report ${n}\n\n## Status\n\n${status}\n\n## PR\n\nnone\n`);
		const date = new Date(`2026-11-11T${time}:00.000Z`);
		utimesSync(path, date, date);
		return path;
	};
	const preflight = (tickets = "5,6", ...extra: string[]) =>
		run("preflight", "--repo", repo, "--tickets", tickets, "--check", "npm test", "--chief-pane", "w1:p1", ...extra);
	const launch = (n: number | string) =>
		run(
			"event",
			String(n),
			"launch",
			"--worktree",
			join(dir, `t${n}`),
			"--branch",
			`feat/t${n}`,
			"--pane",
			`w1:p${n}`,
			"--session",
			join(dir, `s${n}.jsonl`),
			"--brief",
			brief,
			"--report",
			join(dir, `report-${n}.md`),
			"--deadline",
			"20",
		);
	/** Appends an event the way `gate` or `merge` would, so rows can start GATED without those commands. */
	const append = (event: object) => appendFileSync(join(runDir(), "events.jsonl"), `${JSON.stringify(event)}\n`);
	return { dir, repo, run, runDir, events, at, brief, report, preflight, launch, append, calls, state, runner };
}

type Fixture = ReturnType<typeof fixture>;

function assertOk(result: { code: number; out: string }) {
	assert.equal(result.code, 0, result.out);
	return result.out;
}

function assertRefused(result: { code: number; out: string }, ...parts: string[]) {
	assert.equal(result.code, 1, `expected a refusal, got: ${result.out}`);
	for (const part of parts) assert.ok(result.out.includes(part), `${JSON.stringify(result.out)} lacks ${part}`);
}

/** The status line of row `n`, e.g. `#5 RUNNING(implement)`. */
function rowLine(f: Fixture, n: number | string) {
	const out = assertOk(f.run("status"));
	const line = out.split("\n").find((l) => l.startsWith(`#${n} `));
	assert.ok(line, `no row #${n} in ${out}`);
	return line;
}

/** Launches #5, reports it DONE at 10:05 and gates it at HEAD via an appended `gate` event. */
function gated(f: Fixture, ...preflightExtra: string[]) {
	assertOk(f.preflight("5,6", ...preflightExtra));
	assertOk(f.launch(5));
	f.at("10:05");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "DONE", "10:04")));
	f.at("10:06");
	f.append({ at: "2026-11-11T10:06:00.000Z", type: "gate", ticket: 5, sha: HEAD });
	f.state.prs["feat/t5"] = { number: 12, state: "OPEN", headRefOid: HEAD, url: "https://example.invalid/pr/12" };
}

test("preflight records base, cleanliness, tools and rules, and starts every row QUEUED", () => {
	const f = fixture();
	assertOk(f.preflight());
	const [first] = f.events();
	assert.equal(first.type, "preflight");
	assert.equal(first.base, "main");
	assert.equal(first.sha, SHA);
	assert.equal(first.clean, true);
	assert.deepEqual(first.tools, { git: true, gh: true, herdr: true });
	assert.deepEqual(first.rules, { requiredChecks: ["check"], upToDate: true, mergeMethods: ["squash"] });
	assert.deepEqual(first.tickets, [5, 6]);
	assert.match(rowLine(f, 5), /^#5 QUEUED next: chief/);
	assert.match(rowLine(f, 6), /^#6 QUEUED next: chief/);
});

test("a failed rules read is recorded as unknown, never as no rules", () => {
	const f = fixture();
	f.state.rules = { code: 1, stdout: "", stderr: "HTTP 403: Resource not accessible" };
	assertOk(f.preflight());
	const [first] = f.events();
	assert.equal(first.rules, "unknown");
	assert.match(first.rulesError, /HTTP 403/);
	assert.match(readLedger(f), /rules: unknown/);
});

function readLedger(f: Fixture) {
	assertOk(f.run("status"));
	return readFileSync(join(f.runDir(), "ledger.md"), "utf8");
}

test("timer starts after each running event, status and cleanup report live and stale timers", () => {
	const f = fixture();
	assertOk(f.preflight());
	f.state.timerPid = process.pid;
	const startTimer = f.runner.startTimer;
	f.runner.startTimer = (...args) => {
		assert.ok(["launch", "answer", "round"].includes(f.events().at(-1).type));
		return startTimer(...args);
	};
	assertOk(f.launch(5));
	assert.deepEqual(f.state.timers, [{ dir: f.runDir(), ticket: "5", deadline: "2026-11-11T10:20:00.000Z" }]);
	assert.match(
		assertOk(f.run("status")),
		new RegExp(`timer: watching until 2026-11-11T10:20:00.000Z \\(pid ${process.pid}\\)`),
	);
	f.at("10:05");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "BLOCKED", "10:04")));
	assertOk(f.run("event", "5", "answer", "--basis", "The test may use a fake clock."));
	assert.equal(f.state.timers.length, 2);
	f.at("10:06");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "DONE", "10:05")));
	assertOk(f.run("event", "5", "round", "fix", "--deadline", "10"));
	assert.equal(f.state.timers.length, 3);
	assertOk(f.run("event", "5", "drop", "--user", "stop"));
	pane(f, 5, false);
	assert.match(
		assertOk(f.run("cleanup", "--dry-run")),
		new RegExp(`Resources left:[\\s\\S]*#5 timer[^\\n]*${process.pid}`),
	);
	const stale = fixture();
	assertOk(stale.preflight());
	stale.state.timerError = "no process";
	assert.match(
		assertOk(stale.launch(5)),
		/timer not started: no process; the deadline is checked only when you run status/,
	);
	assert.match(assertOk(stale.run("status")), /timer: none; the deadline is checked only when you run status/);
	assert.equal(stale.events().at(-1).type, "launch");
});

test("timer cleanup distinguishes row prefixes", () => {
	const f = fixture();
	assertOk(f.preflight("a,a-b"));
	f.state.timerError = "no process";
	assertOk(f.launch("a"));
	f.state.timerError = "";
	f.state.timerPid = process.pid;
	assertOk(f.launch("a-b"));
	assertOk(f.run("event", "a", "drop", "--user", "stop"));
	f.state.exec["herdr pane process-info --pane w1:pa"] = ok('{"result":{"process_info":{"foreground_processes":[]}}}');
	assert.doesNotMatch(assertOk(f.run("cleanup", "--dry-run")), /#a timer still running/);
});

test("timer distinguishes recording failure from start failure and records event first", () => {
	const f = fixture();
	assertOk(f.preflight());
	f.runner.startTimer = () => {
		assert.equal(f.events().at(-1).type, "launch");
		mkdirSync(join(f.runDir(), "timers", "5-2026-11-11T10-20-00.000Z.pid"));
		return 123;
	};
	assert.match(assertOk(f.launch(5)), /timer started \(pid 123\) but not recorded: .*; status will show timer: none/);
	const g = fixture();
	assertOk(g.preflight());
	g.state.timerError = "no process";
	assert.match(
		assertOk(g.launch(5)),
		/timer not started: no process; the deadline is checked only when you run status/,
	);
});

test("timer status reports unknown pane check and dead pid file", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	assert.ok(existsSync(join(f.runDir(), "timers", "5-2026-11-11T10-20-00.000Z.pid")));
	const out = assertOk(f.run("status"));
	assert.match(out, /timer: none; the deadline is checked only when you run status/);
	assert.match(out, /cannot tell whether Pi runs in pane w1:p5: .*fake runner/);
});

test("timer watch retries consecutive poll errors and resets after success", async () => {
	const f = fixture();
	assertOk(f.preflight());
	f.state.timerPid = process.pid;
	assertOk(f.launch(5));
	const pidPath = join(f.runDir(), "timers", "5-2026-11-11T10-20-00.000Z.pid");
	const path = join(f.runDir(), "events.jsonl");
	const original = readFileSync(path, "utf8");
	let polls = 0;
	await watch([f.runDir(), "5", "2026-11-11T10:20:00.000Z"], f.runner, async () => {
		polls++;
		writeFileSync(path, polls === 2 ? original : "broken\n");
	});
	assert.equal(polls, 5);
	const log = readFileSync(join(f.runDir(), "timers.log"), "utf8");
	assert.equal((log.match(/#5 error:/g) ?? []).length, 3);
	assert.equal((log.match(/#5 exit-with-error:/g) ?? []).length, 1);
	assert.ok(!existsSync(pidPath));
});

test("timer watch retries poll errors even if its log cannot be appended", async () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	writeFileSync(join(f.runDir(), "events.jsonl"), "broken\n");
	mkdirSync(join(f.runDir(), "timers.log"));
	let polls = 0;
	await watch([f.runDir(), "5", "2026-11-11T10:20:00.000Z"], f.runner, async () => {
		polls++;
	});
	assert.equal(polls, 3);
});

test("timer watch stops after a failed delivery attempt", async () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	pane(f, 5, true);
	pane(f, 1, true);
	f.at("10:21");
	f.state.exec["herdr agent prompt w1:p1 [timer 5] LOOK: run batch.ts status"] = {
		code: 1,
		stdout: "",
		stderr: "delivery uncertain",
	};
	let polls = 0;
	await watch([f.runDir(), "5", "2026-11-11T10:20:00.000Z"], f.runner, async () => {
		polls++;
	});
	assert.equal(polls, 1);
	assert.equal(f.calls.filter((c) => c.startsWith("herdr agent prompt")).length, 1);
	assert.match(readFileSync(join(f.runDir(), "timers.log"), "utf8"), /#5 send failed: delivery uncertain/);
});

test("timer watch stops after delivery even if its log cannot be appended", async () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	pane(f, 5, true);
	pane(f, 1, true);
	f.at("10:21");
	f.state.exec["herdr agent prompt w1:p1 [timer 5] LOOK: run batch.ts status"] = ok();
	mkdirSync(join(f.runDir(), "timers.log"));
	let polls = 0;
	await watch([f.runDir(), "5", "2026-11-11T10:20:00.000Z"], f.runner, async () => {
		polls++;
	});
	assert.equal(polls, 1);
	assert.equal(f.calls.filter((c) => c.startsWith("herdr agent prompt")).length, 1);
});

test("timer watch gives up after 20 dialog refusals", async () => {
	const f = fixture();
	assertOk(f.preflight());
	f.state.timerPid = process.pid;
	assertOk(f.launch(5));
	pane(f, 5, true);
	pane(f, 1, true, DIALOG);
	f.at("10:21");
	let polls = 0;
	await watch([f.runDir(), "5", "2026-11-11T10:20:00.000Z"], f.runner, async () => {
		polls++;
	});
	assert.equal(polls, 20);
	assert.match(readFileSync(join(f.runDir(), "timers.log"), "utf8"), /give-up after 20 tries/);
	assert.ok(!existsSync(join(f.runDir(), "timers", "5-2026-11-11T10-20-00.000Z.pid")));
	assert.ok(!f.calls.some((c) => c.startsWith("herdr agent prompt")));
});

test("timer deadline has a fresh refusal budget after earlier refusals", async () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	pane(f, 5, false);
	pane(f, 1, true, DIALOG);
	let polls = 0;
	await watch([f.runDir(), "5", "2026-11-11T10:20:00.000Z"], f.runner, async () => {
		polls++;
		if (polls === 21) f.at("10:20");
		if (polls > 50) throw new Error("watch did not stop");
	});
	assert.equal(polls, 40);
	assert.match(readFileSync(join(f.runDir(), "timers.log"), "utf8"), /give-up after 20 tries/);
});

test("timer watch gets twenty late refusals when deadline crosses during pane check", async () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	pane(f, 5, false);
	pane(f, 1, true, DIALOG);
	const paneCheck = f.state.exec["herdr pane process-info --pane w1:p5"] as Result;
	let polls = 0;
	f.state.exec["herdr pane process-info --pane w1:p5"] = () => {
		if (polls === 21) f.at("10:21");
		return paneCheck;
	};
	await watch([f.runDir(), "5", "2026-11-11T10:20:00.000Z"], f.runner, async () => {
		polls++;
		if (polls > 50) throw new Error("watch did not stop");
	});
	const log = readFileSync(join(f.runDir(), "timers.log"), "utf8");
	assert.equal(polls, 40);
	assert.equal((log.match(/refused:/g) ?? []).length, 39);
	assert.equal((log.match(/give-up after 20 tries/g) ?? []).length, 1);
	assert.ok(!f.calls.some((c) => c.startsWith("herdr agent prompt")));
});

test("timer watch removes only its own pid file on exit", async () => {
	const f = fixture();
	assertOk(f.preflight());
	f.state.timerPid = process.pid;
	assertOk(f.launch(5));
	const path = join(f.runDir(), "timers", "5-2026-11-11T10-20-00.000Z.pid");
	assertOk(f.run("event", "5", "drop", "--user", "stop"));
	await watch([f.runDir(), "5", "2026-11-11T10:20:00.000Z"], f.runner, async () => {});
	assert.ok(!existsSync(path));
	writeFileSync(path, "123");
	await watch([f.runDir(), "5", "2026-11-11T10:20:00.000Z"], f.runner, async () => {});
	assert.equal(readFileSync(path, "utf8"), "123");
});

test("timer poll refuses an open dialog and never writes events or ledger", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	pane(f, 5, true);
	pane(f, 1, true, DIALOG);
	const before = readFileSync(join(f.runDir(), "events.jsonl"), "utf8");
	f.at("10:21");
	const result = timerPoll(
		f.runDir(),
		"5",
		"2026-11-11T10:20:00.000Z",
		{ misses: 0, tries: 0, late: false },
		f.runner,
	);
	assert.equal(result.action, "wait");
	assert.equal(result.tries, 1);
	assert.match(readFileSync(join(f.runDir(), "timers.log"), "utf8"), /refused/);
	assert.equal(readFileSync(join(f.runDir(), "events.jsonl"), "utf8"), before);
	assert.ok(!existsSync(join(f.runDir(), "ledger.md")));
	assert.ok(!f.calls.some((call) => call.startsWith("herdr agent prompt")));
});

test("timer poll sends one content-free wake after two absences and exits after report", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	pane(f, 5, false);
	pane(f, 1, true);
	f.state.exec["herdr agent prompt w1:p1 [timer 5] LOOK: run batch.ts status"] = ok();
	const deadline = "2026-11-11T10:20:00.000Z";
	const first = timerPoll(f.runDir(), "5", deadline, { misses: 0, tries: 0, late: false }, f.runner);
	assert.equal(first.action, "wait");
	const second = timerPoll(f.runDir(), "5", deadline, first, f.runner);
	assert.equal(second.action, "send");
	assert.equal(f.calls.filter((c) => c.startsWith("herdr agent prompt")).length, 1);
	assert.match(readFileSync(join(f.runDir(), "timers.log"), "utf8"), /#5 sent/);
	assert.match(assertOk(f.run("status")), /no Pi in pane w1:p5/);
	f.at("10:05");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "DONE", "10:04")));
	assert.equal(timerPoll(f.runDir(), "5", deadline, first, f.runner).action, "exit");
});

test("timer gone pane wakes on second poll", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	f.state.exec["herdr pane process-info --pane w1:p5"] = { code: 1, stdout: "", stderr: "pane_not_found" };
	pane(f, 1, true);
	f.state.exec["herdr agent prompt w1:p1 [timer 5] LOOK: run batch.ts status"] = ok();
	const deadline = "2026-11-11T10:20:00.000Z";
	const first = timerPoll(f.runDir(), "5", deadline, { misses: 0, tries: 0, late: false }, f.runner);
	assert.equal(first.action, "wait");
	assert.equal(timerPoll(f.runDir(), "5", deadline, first, f.runner).action, "send");
});

test("timer status distinguishes gone pane", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	f.state.exec["herdr pane process-info --pane w1:p5"] = { code: 1, stdout: "", stderr: "pane_not_found" };
	assert.match(assertOk(f.run("status")), / {2}pane w1:p5 is gone/);
});

test("timer pre-deadline give-up is logged and continues", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	pane(f, 5, false);
	pane(f, 1, true, DIALOG);
	const result = timerPoll(
		f.runDir(),
		"5",
		"2026-11-11T10:20:00.000Z",
		{ misses: 1, tries: 19, late: false },
		f.runner,
	);
	assert.deepEqual(result, { action: "wait", misses: 0, tries: 0, late: false });
	assert.match(
		readFileSync(join(f.runDir(), "timers.log"), "utf8"),
		/give-up before deadline after 20 tries; still watching the deadline/,
	);
});

test("timer status ignores pid with EPERM", () => {
	const f = fixture();
	assertOk(f.preflight());
	f.state.timerPid = process.pid;
	assertOk(f.launch(5));
	const original = process.kill;
	try {
		process.kill = (() => {
			throw Object.assign(new Error("denied"), { code: "EPERM" });
		}) as typeof process.kill;
		assert.match(assertOk(f.run("status")), /timer: none/);
	} finally {
		process.kill = original;
	}
});

test("timer watcher bounds herdr calls and handles timed out checks and delivery", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	pane(f, 5, true);
	pane(f, 1, true);
	const deadline = "2026-11-11T10:20:00.000Z";
	let timeoutAt = "pane process-info --pane w1:p5";
	const optionsSeen: number[] = [];
	const runner: Runner = {
		...f.runner,
		exec(cmd, args, options) {
			if (cmd === "herdr") {
				optionsSeen.push(options?.timeoutMs ?? 0);
				if (args.join(" ") === timeoutAt) return { code: 1, stdout: "", stderr: "ETIMEDOUT" };
			}
			return f.runner.exec(cmd, args, options);
		},
	};
	let state = timerPoll(f.runDir(), "5", deadline, { misses: 1, tries: 0, late: false }, runner);
	assert.equal(state.misses, 0);
	f.at("10:21");
	timeoutAt = "agent read w1:p1 --source visible";
	state = timerPoll(f.runDir(), "5", deadline, state, runner);
	assert.equal(state.action, "wait");
	assert.equal(state.tries, 1);
	timeoutAt = "agent prompt w1:p1 [timer 5] LOOK: run batch.ts status";
	state = timerPoll(f.runDir(), "5", deadline, state, runner);
	assert.equal(state.action, "send");
	assert.match(readFileSync(join(f.runDir(), "timers.log"), "utf8"), /send failed: ETIMEDOUT/);
	assert.ok(optionsSeen.length >= 6 && optionsSeen.every((ms) => ms > 0));
});

test("timer treats missing process information as unknown, not two absences", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	f.state.exec["herdr pane process-info --pane w1:p5"] = ok('{"result":{"process_info":{}}}');
	pane(f, 1, true);
	const deadline = "2026-11-11T10:20:00.000Z";
	const first = timerPoll(f.runDir(), "5", deadline, { misses: 0, tries: 0, late: false }, f.runner);
	const second = timerPoll(f.runDir(), "5", deadline, first, f.runner);
	assert.equal(second.action, "wait");
	assert.equal(second.misses, 0);
	assert.ok(!f.calls.some((c) => c.startsWith("herdr agent prompt")));
});

test("launch moves QUEUED to RUNNING(implement) with a deadline", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	assert.match(rowLine(f, 5), /^#5 RUNNING\(implement\) next: coordinator, deadline 2026-11-11T10:20:00\.000Z$/);
	f.at("10:21");
	assert.match(rowLine(f, 5), /deadline 2026-11-11T10:20:00\.000Z OVERDUE$/);
});

test("status prints pane, worktree, branch and session file of each launched row, and none for a queued row", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	const out = assertOk(f.run("status"));
	const lines = out.split("\n");
	const at = lines.findIndex((l) => l.startsWith("#5 "));
	assert.ok(
		lines.includes(
			`  launched: pane w1:p5, worktree ${join(f.dir, "t5")}, branch feat/t5, session ${join(f.dir, "s5.jsonl")}`,
		),
		out,
	);
	assert.ok(lines.findIndex((l) => l.startsWith("  launched:")) > at, out);
	assert.equal(lines.filter((l) => l.startsWith("  launched:")).length, 1, out);
});

test("status records nothing for an ATTEMPT FAILED line in the panes, unlike a report", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	f.at("10:05");
	const before = assertOk(f.run("status"));
	const events = f.events().length;
	const line = "[coordinator 5] ATTEMPT FAILED: provider error on the implement job";
	for (const pane of ["w1:p1", "w1:p5"]) f.state.exec[`herdr agent read ${pane} --source visible`] = ok(`${line}\n> `);
	const calls = f.calls.length;
	const after = assertOk(f.run("status"));
	assert.equal(after, before);
	assert.equal(f.events().length, events, "status recorded an event");
	assert.match(rowLine(f, 5), /^#5 RUNNING\(implement\)/);
	assert.ok(!f.calls.slice(calls).some((c) => c.startsWith("herdr agent read")), "status read pane text");
});

test("a DONE report moves RUNNING to REPORTED; a BLOCKED one to ASKED(chief)", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	assertOk(f.launch(6));
	f.at("10:05");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "DONE", "10:04")));
	assertOk(f.run("event", "6", "report", "--path", f.report(6, "BLOCKED", "10:04")));
	assert.match(rowLine(f, 5), /^#5 REPORTED next: chief$/);
	assert.match(rowLine(f, 6), /^#6 ASKED\(chief\) next: chief$/);
});

test("a chief answer quoting the brief, an escalation and a user answer each return the row to RUNNING", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	f.at("10:05");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "BLOCKED", "10:04")));
	assertRefused(f.run("event", "5", "answer", "--basis", "a line the brief lacks"), "not in the brief");
	assertOk(f.run("event", "5", "answer", "--basis", "The test may use a fake clock."));
	assert.match(rowLine(f, 5), /^#5 RUNNING\(implement\) next: coordinator, deadline 2026-11-11T10:25:00\.000Z$/);
	f.at("10:10");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "BLOCKED", "10:09")));
	assertOk(f.run("event", "5", "escalate"));
	assert.match(rowLine(f, 5), /^#5 ASKED\(user\) next: user$/);
	assertOk(f.run("event", "5", "answer", "--user", "use option B"));
	assert.match(rowLine(f, 5), /^#5 RUNNING\(implement\) next: coordinator/);
});

test("a second chief answer on one ticket is refused: the question goes to the user", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	f.at("10:05");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "BLOCKED", "10:04")));
	assertOk(f.run("event", "5", "answer", "--basis", "The test may use a fake clock."));
	f.at("10:10");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "BLOCKED", "10:09")));
	assertRefused(
		f.run("event", "5", "answer", "--basis", "The test may use a fake clock."),
		"already had a chief answer",
		"event 5 escalate",
	);
	assert.match(rowLine(f, 5), /^#5 ASKED\(chief\)/);
	assert.ok(!assertOk(f.run("status")).includes("answer --basis"), "status still offers a chief answer");
});

test("a round from REPORTED or GATED moves the row to RUNNING(round)", () => {
	const f = fixture();
	gated(f);
	assertOk(f.run("event", "5", "round", "fix", "--deadline", "30"));
	assert.match(rowLine(f, 5), /^#5 RUNNING\(fix\) next: coordinator, deadline 2026-11-11T10:36:00\.000Z$/);
	f.at("10:40");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "DONE", "10:39")));
	assertOk(f.run("event", "5", "round", "review", "--deadline", "15"));
	assert.match(rowLine(f, 5), /^#5 RUNNING\(review\)/);
});

test("a gated row whose PR head moved returns to REPORTED", () => {
	const f = fixture();
	gated(f);
	assert.match(rowLine(f, 5), new RegExp(`^#5 GATED\\(${HEAD}\\) next: user, then chief$`));
	f.state.prs["feat/t5"] = { number: 12, state: "OPEN", headRefOid: MOVED };
	assert.match(rowLine(f, 5), /^#5 REPORTED next: chief$/);
	assert.equal(f.events().at(-1).type, "head-moved");
	assert.equal(f.events().at(-1).head, MOVED);
});

test("a gated row whose PR GitHub reports merged becomes MERGED", () => {
	const f = fixture();
	gated(f);
	f.state.prs["feat/t5"] = { number: 12, state: "MERGED", headRefOid: HEAD, mergeCommit: { oid: MOVED } };
	assert.match(rowLine(f, 5), /^#5 MERGED next: nobody$/);
	assert.equal(f.events().at(-1).commit, MOVED);
});

test("leave-open and drop end a row", () => {
	const f = fixture();
	gated(f);
	assertOk(f.run("event", "5", "leave-open"));
	assert.match(rowLine(f, 5), /^#5 LEFT_OPEN next: nobody$/);
	assertRefused(f.run("event", "6", "drop"), "--user");
	assertOk(f.run("event", "6", "drop", "--user", "drop 6, not needed"));
	assert.match(rowLine(f, 6), /^#6 DROPPED next: nobody$/);
});

test("illegal transitions are refused, naming the row's state and the events it accepts", () => {
	const f = fixture();
	gated(f);
	assertRefused(
		f.run("event", "6", "report", "--path", f.report(6, "DONE", "10:06")),
		"#6 is QUEUED",
		"accepts: launch, drop",
	);
	assertOk(f.run("event", "5", "round", "update", "--deadline", "10"));
	assertRefused(f.run("event", "5", "leave-open"), "#5 is RUNNING(update)", "accepts: report, drop");
	assertOk(f.run("event", "6", "drop", "--user", "not now"));
	assertRefused(f.run("event", "6", "launch", ...launchOptions(f, 6)), "#6 is DROPPED", "accepts: nothing");
	assert.equal(f.events().filter((e) => e.ticket === 6).length, 1, "a refused event was recorded");
});

function launchOptions(f: Fixture, n: number) {
	return [
		...["--worktree", join(f.dir, `t${n}`), "--branch", `feat/t${n}`, "--pane", `w1:p${n}`],
		...["--session", join(f.dir, `s${n}.jsonl`), "--brief", f.brief, "--report", join(f.dir, `r${n}.md`)],
		...["--deadline", "20"],
	];
}

test("events recorded by their own commands are refused through event", () => {
	const f = fixture();
	gated(f);
	assertRefused(
		f.run("event", "5", "merged"),
		"not recorded through event",
		`#5 is GATED(${HEAD})`,
		"it accepts: round, head-moved, merge-intent, merged, leave-open, drop",
	);
	assertRefused(
		f.run("event", "5", "frobnicate"),
		"unknown event frobnicate",
		`#5 is GATED(${HEAD})`,
		"it accepts: round, head-moved, merge-intent, merged, leave-open, drop",
	);
});

test("status records a report file newer than the row's last event, and ignores an older one", () => {
	const f = fixture();
	assertOk(f.preflight());
	f.report(5, "DONE", "09:59");
	assertOk(f.launch(5));
	f.at("10:03");
	assert.match(rowLine(f, 5), /^#5 RUNNING/);
	f.report(5, "BLOCKED", "10:02");
	f.at("10:04");
	assert.match(rowLine(f, 5), /^#5 ASKED\(chief\)/);
	assert.equal(f.events().at(-1).type, "report");
	assert.equal(f.events().at(-1).status, "BLOCKED");
});

test("a crash between merge intent and observation is reconciled by status without a second merge", () => {
	const f = fixture();
	gated(f);
	f.append({ at: "2026-11-11T10:07:00.000Z", type: "merge-intent", ticket: 5, sha: HEAD });
	f.state.prs["feat/t5"] = { number: 12, state: "MERGED", headRefOid: HEAD, mergeCommit: { oid: MOVED } };
	f.at("10:08");
	assert.match(rowLine(f, 5), /^#5 MERGED next: nobody$/);
	assertOk(f.run("status"));
	assert.equal(f.events().filter((e) => e.type === "merged").length, 1);
	assert.deepEqual(
		f.calls.filter((c) => c.startsWith("gh pr merge")),
		[],
	);
});

test("a pending merge intent on an unmerged PR is listed, not repeated", () => {
	const f = fixture();
	gated(f);
	f.append({ at: "2026-11-11T10:07:00.000Z", type: "merge-intent", ticket: 5, sha: HEAD });
	const out = assertOk(f.run("status"));
	assert.match(out, new RegExp(`merge intent at ${HEAD} pending`));
	assert.match(rowLine(f, 5), /^#5 GATED/);
});

test("approve and note are recorded; unknown kinds and tickets are refused", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.run("approve", "--quote", "merge 5 and 6", "--action", "merge", "--tickets", "5,6"));
	assertOk(f.run("approve", "--quote", "ship it", "--action", "merge", "--tickets", "5", "--inferred"));
	assertRefused(f.run("approve", "--quote", "merge 7", "--action", "merge", "--tickets", "7"), "#7 is not a row");
	assertOk(f.run("note", "--kind", "gate-miss", "--ticket", "5", "CI ran on the old head"));
	assertRefused(f.run("note", "--kind", "gripe", "--ticket", "5", "x"), "manual-fix");
	const approvals = f.events().filter((e) => e.type === "approve");
	assert.deepEqual(
		approvals.map((e) => [e.quote, e.action, e.tickets, e.inferred]),
		[
			["merge 5 and 6", "merge", [5, 6], false],
			["ship it", "merge", [5], true],
		],
	);
	const ledger = readLedger(f);
	assert.match(ledger, /"merge 5 and 6"/);
	assert.match(ledger, /gate-miss #5: CI ran on the old head/);
});

test("approve --question is stored in the event and shown in the ledger", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(
		f.run("approve", "--quote", "yes, push", "--question", "push 5 and 6?", "--action", "push", "--tickets", "5,6"),
	);
	const [e] = f.events().filter((x) => x.type === "approve");
	assert.equal(e.question, "push 5 and 6?");
	assert.match(readLedger(f), /push #5, #6: "yes, push" answering "push 5 and 6\?"/);
});

test("approve --prs resolves each PR through a row's branch and refuses a PR no row owns", () => {
	const f = fixture();
	assertOk(f.preflight("5,6,7"));
	assertOk(f.launch(5));
	assertOk(f.launch(6));
	f.state.prs["feat/t5"] = { number: 12 };
	f.state.prs["feat/t6"] = { number: 13 };
	assertOk(f.run("approve", "--quote", "merge 13 and 12", "--action", "merge", "--prs", "13,12"));
	const [e] = f.events().filter((x) => x.type === "approve");
	assert.deepEqual(e.tickets, [6, 5]);
	assertRefused(
		f.run("approve", "--quote", "merge 14", "--action", "merge", "--prs", "12,14"),
		"PR #14 is not the PR of any row",
		"#12 (#5)",
	);
	assertRefused(
		f.run("approve", "--quote", "x", "--action", "merge", "--prs", "12", "--tickets", "5"),
		"--tickets or --prs",
	);
	assert.equal(f.events().filter((x) => x.type === "approve").length, 1);
});

test("launch is refused while only an inferred push approval covers the row", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.run("approve", "--quote", "ship them all", "--action", "push", "--tickets", "5,6", "--inferred"));
	assertRefused(
		f.launch(5),
		"only an inferred push approval covers #5; confirm it with the user and record their words with approve (without --inferred)",
	);
	assert.match(rowLine(f, 5), /^#5 QUEUED/);
	assertOk(f.run("approve", "--quote", "yes, push 5", "--action", "push", "--tickets", "5"));
	assertOk(f.launch(5));
});

test("ledger.md is regenerated by status, not appended", () => {
	const f = fixture();
	assertOk(f.preflight());
	const first = readLedger(f);
	assert.match(first.split("\n")[0], /generated/i);
	appendFileSync(join(f.runDir(), "ledger.md"), "hand edit\n");
	const second = readLedger(f);
	assert.equal(second, first);
	assertOk(f.launch(5));
	const third = readLedger(f);
	assert.equal(third.split("\n").filter((l) => /generated/i.test(l)).length, 1);
	assert.match(third, /\| #5 \| RUNNING\(implement\) \|/);
	assert.ok(!third.includes("| #5 | QUEUED |"), third);
});

test("note regenerates ledger.md without status, not appended", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.run("note", "--kind", "manual-fix", "--ticket", "5", "fixed the lockfile"));
	const ledger = join(f.runDir(), "ledger.md");
	const calls = f.calls.length;
	assert.ok(existsSync(ledger), "note wrote no ledger.md");
	const first = readFileSync(ledger, "utf8");
	assert.match(first, /manual-fix #5: fixed the lockfile/);
	appendFileSync(ledger, "hand edit\n");
	assertOk(f.run("note", "--kind", "gate-miss", "--ticket", "6", "CI ran on the old head"));
	const second = readFileSync(ledger, "utf8");
	assert.ok(!second.includes("hand edit"), second);
	assert.equal(second.split("\n").filter((l) => /generated/i.test(l)).length, 1);
	assert.match(second, /manual-fix #5: fixed the lockfile\n- gate-miss #6: CI ran on the old head/);
	assert.ok(!f.calls.slice(calls).some((c) => c.startsWith("gh ")), "note reached GitHub");
	assert.ok(!f.calls.slice(calls).some((c) => c.startsWith("herdr ")), "note reached herdr");
});

test("a ledger written by note shows a pending merge intent from the event log", () => {
	const f = fixture();
	gated(f);
	f.append({ at: "2026-11-11T10:07:00.000Z", type: "merge-intent", ticket: 5, sha: HEAD });
	assertOk(f.run("note", "--kind", "manual-fix", "--ticket", "6", "fixed the lockfile"));
	const ledger = readFileSync(join(f.runDir(), "ledger.md"), "utf8");
	assert.match(ledger, new RegExp(`\\| #5 \\|.*merge intent at ${HEAD} pending since 2026-11-11T10:07:00.000Z`));
});

test("a ledger written by note says the outside was not checked and names note", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.run("note", "--kind", "manual-fix", "--ticket", "5", "fixed the lockfile"));
	const byNote = readFileSync(join(f.runDir(), "ledger.md"), "utf8");
	assert.match(byNote.split("\n")[0], /Generated by batch\.ts note from events\.jsonl /);
	assert.match(byNote, /\| #5 \|.*outside not checked \(written by note\); run status \|/);
});

test("a ledger written by status names status and does not say the outside was not checked", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.run("note", "--kind", "manual-fix", "--ticket", "5", "fixed the lockfile"));
	const byStatus = readLedger(f);
	assert.match(byStatus.split("\n")[0], /Generated by batch\.ts status from events\.jsonl /);
	assert.ok(!byStatus.includes("not checked"), byStatus);
});

test("a row is a ticket number or a label, and every row command takes a label", () => {
	const f = fixture();
	assertOk(f.preflight("5,release,skill-pr-2"));
	assert.deepEqual(f.events()[0].tickets, [5, "release", "skill-pr-2"]);
	assert.match(rowLine(f, "release"), /^#release QUEUED next: chief/);
	assertOk(f.launch("release"));
	assertOk(f.run("approve", "--quote", "merge 5 and the release", "--action", "merge", "--tickets", "5,release"));
	assertOk(f.run("note", "--kind", "user-friction", "--ticket", "release", "typed in the pane"));
	assertRefused(f.run("event", "nope", "drop", "--user", "x"), "nope is not a row");
	assertOk(f.run("event", "skill-pr-2", "drop", "--user", "not now"));
	assert.match(rowLine(f, "release"), /^#release RUNNING\(implement\)/);
	const ledger = readLedger(f);
	assert.match(ledger, /\| #release \| RUNNING\(implement\) \|/);
	assert.match(ledger, /merge #5, #release/);
	assert.match(ledger, /user-friction #release: typed in the pane/);
});

test("an invalid or repeated row id is refused", () => {
	for (const tickets of ["Release", "-x", "rel_ease", "a b", "1abc", "05", "a-", "x".repeat(33), "release,release"]) {
		const f = fixture();
		assertRefused(f.preflight(tickets), "--tickets");
		assert.ok(!existsSync(join(`${f.repo}.worktrees`, ".batch", "current")), `${tickets} created a run`);
	}
});

// ---------------------------------------------------------------------------------------------------------------
// Effect commands: gate, merge, prompt, cleanup.

const PASSED = [{ __typename: "CheckRun", name: "check", status: "COMPLETED", conclusion: "SUCCESS" }];
const ok = (stdout = ""): Result => ({ code: 0, stdout, stderr: "" });

/** A PR for #5 that passes every fetched fact of the gate at HEAD. */
function goodPr(over: object = {}) {
	return {
		number: 12,
		state: "OPEN",
		headRefOid: HEAD,
		baseRefName: "main",
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		statusCheckRollup: PASSED,
		body: "Adds the thing.\n\nCloses #5\n",
		files: [{ path: "src/a.ts", additions: 3, deletions: 1 }],
		url: "https://example.invalid/pr/12",
		...over,
	};
}

/** Launches #5 and reports it DONE; its worktree is clean and its tip is HEAD. */
function reported(f: Fixture) {
	assertOk(f.preflight());
	assertOk(f.launch(5));
	f.at("10:05");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "DONE", "10:04")));
	const wt = join(f.dir, "t5");
	mkdirSync(wt, { recursive: true });
	f.state.exec[`git -C ${wt} status --porcelain`] = ok();
	f.state.exec[`git -C ${wt} rev-parse HEAD`] = ok(`${HEAD}\n`);
	f.state.prs["feat/t5"] = goodPr();
	return wt;
}

test("gate passes: GATED at the PR head, with fetched, read and taken-on-report parts", () => {
	const f = fixture();
	reported(f);
	const out = assertOk(f.run("gate", "5", "--judged", "diff matches the brief"));
	assert.match(out, /Fetched by this command/);
	assert.match(out, /Read by the chief:\n\s*diff matches the brief/);
	assert.match(out, /Taken on report \(not verified\)/);
	assert.match(out, /src\/a\.ts \+3 -1/);
	assert.ok(!/FAIL/.test(out), out);
	assert.deepEqual([f.events().at(-1).type, f.events().at(-1).sha], ["gate", HEAD]);
	assert.match(rowLine(f, 5), new RegExp(`^#5 GATED\\(${HEAD}\\)`));
});

test("gate with a dirty worktree prints what failed and leaves the row REPORTED", () => {
	const f = fixture();
	const wt = reported(f);
	f.state.exec[`git -C ${wt} status --porcelain`] = ok(" M src/a.ts\n");
	const result = f.run("gate", "5", "--judged", "looks fine");
	assertRefused(result);
	assert.match(result.out, /FAIL: worktree [^\n]* is not clean[\s\S]*src\/a\.ts/);
	assert.notEqual(f.events().at(-1).type, "gate");
	assert.match(rowLine(f, 5), /^#5 REPORTED/);
});

test("gate fails when required checks have not passed on the head or the body does not close the ticket", () => {
	const f = fixture();
	reported(f);
	f.state.prs["feat/t5"] = goodPr({
		statusCheckRollup: [{ __typename: "CheckRun", name: "check", status: "IN_PROGRESS", conclusion: "" }],
		body: "no trailer",
	});
	const result = f.run("gate", "5", "--judged", "ok");
	assertRefused(result);
	assert.match(result.out, /FAIL: required check check has not passed/);
	assert.match(result.out, /FAIL: body does not close #5/);
	assert.match(rowLine(f, 5), /^#5 REPORTED/);
});

test("gate fails a ticket row whose PR body does not close it", () => {
	const f = fixture();
	reported(f);
	f.state.prs["feat/t5"] = goodPr({ body: "no trailer" });
	const result = f.run("gate", "5", "--judged", "ok");
	assertRefused(result, "FAIL: body does not close #5");
	assert.ok(!/SKIP/.test(result.out), result.out);
	assert.match(rowLine(f, 5), /^#5 REPORTED/);
});

test("gate on a label row skips the closing-keyword check and says so", () => {
	const f = fixture();
	assertOk(f.preflight("5,release"));
	assertOk(f.launch("release"));
	f.at("10:05");
	assertOk(f.run("event", "release", "report", "--path", f.report("release", "DONE", "10:04")));
	const wt = join(f.dir, "trelease");
	f.state.exec[`git -C ${wt} status --porcelain`] = ok();
	f.state.exec[`git -C ${wt} rev-parse HEAD`] = ok(`${HEAD}\n`);
	f.state.prs["feat/trelease"] = goodPr({ body: "Release 1.2.0." });
	const out = assertOk(f.run("gate", "release", "--judged", "changelog matches"));
	const fetched = out.slice(out.indexOf("Fetched by this command"), out.indexOf("Read by the chief"));
	assert.match(fetched, /SKIP: body closing keyword not checked: release is a label row, not a ticket/);
	assert.ok(!/(FAIL|PASS)[^\n]*close/.test(out), out);
	assert.match(rowLine(f, "release"), new RegExp(`^#release GATED\\(${HEAD}\\)`));
});

/** A gated #5 with a merge approval in the user's words. */
function approvedGated(f: Fixture, ...preflightExtra: string[]) {
	gated(f, ...preflightExtra);
	f.state.prs["feat/t5"] = goodPr();
	assertOk(f.run("approve", "--quote", "merge 5", "--action", "merge", "--tickets", "5"));
}

const MERGE_CALL = `gh pr merge 12 --squash --match-head-commit ${HEAD}`;

function mergeCalls(f: Fixture) {
	return f.calls.filter((c) => c.startsWith("gh pr merge"));
}

test("merge is refused without an approval", () => {
	const f = fixture();
	gated(f);
	f.state.prs["feat/t5"] = goodPr();
	assertRefused(f.run("merge", "5"), "no merge approval");
	assert.deepEqual(mergeCalls(f), []);
});

test("merge is refused with only an inferred approval", () => {
	const f = fixture();
	gated(f);
	f.state.prs["feat/t5"] = goodPr();
	assertOk(f.run("approve", "--quote", "ship them", "--action", "merge", "--tickets", "5", "--inferred"));
	assertRefused(f.run("merge", "5"), "only an inferred merge approval");
	assert.deepEqual(mergeCalls(f), []);
});

test("merge is refused on a head that moved since the gate", () => {
	const f = fixture();
	approvedGated(f);
	f.state.prs["feat/t5"] = goodPr({ headRefOid: MOVED });
	assertRefused(f.run("merge", "5"), `gated at ${HEAD}`, `head is ${MOVED}`);
	assert.deepEqual(mergeCalls(f), []);
});

test("merge is refused when checks have not passed on the head", () => {
	const f = fixture();
	approvedGated(f);
	f.state.prs["feat/t5"] = goodPr({
		statusCheckRollup: [{ __typename: "CheckRun", name: "check", status: "COMPLETED", conclusion: "FAILURE" }],
	});
	assertRefused(f.run("merge", "5"), "required check check has not passed");
	assert.deepEqual(mergeCalls(f), []);
});

test("merge on a behind PR updates the branch and returns the row to REPORTED", () => {
	const f = fixture();
	approvedGated(f);
	f.state.prs["feat/t5"] = goodPr({ mergeStateStatus: "BEHIND" });
	f.state.exec["gh pr update-branch 12"] = ok();
	const out = assertOk(f.run("merge", "5"));
	assert.match(out, /gate again when CI finishes on the new head/);
	assert.ok(f.calls.includes("gh pr update-branch 12"));
	assert.deepEqual(mergeCalls(f), []);
	assert.equal(f.events().at(-1).type, "head-moved");
	f.state.prs["feat/t5"] = goodPr({ headRefOid: MOVED });
	assert.match(rowLine(f, 5), /^#5 REPORTED/);
});

test("merge records an intent, merges pinned to the head, and records MERGED with the merge commit", () => {
	const f = fixture();
	approvedGated(f);
	f.state.exec[MERGE_CALL] = () => {
		f.state.prs["feat/t5"] = goodPr({ state: "MERGED", mergeCommit: { oid: MOVED } });
		return ok();
	};
	assertOk(f.run("merge", "5"));
	assert.deepEqual(mergeCalls(f), [MERGE_CALL]);
	assert.deepEqual(
		f
			.events()
			.slice(-2)
			.map((e) => [e.type, e.sha ?? e.commit]),
		[
			["merge-intent", HEAD],
			["merged", MOVED],
		],
	);
	assert.match(rowLine(f, 5), /^#5 MERGED/);
});

test("a passing gate ends with the recommendation and note reminders; a failed gate does not; merge prints the note reminder", () => {
	const RECOMMEND = "Put one recommended action beside each decision you put to the user.";
	const NOTE = 'Record any friction now: batch.ts note --kind <kind> --ticket <n> "<what>".';
	const failed = fixture();
	const wt = reported(failed);
	failed.state.exec[`git -C ${wt} status --porcelain`] = ok(" M src/a.ts\n");
	const refused = failed.run("gate", "5", "--judged", "looks fine");
	assertRefused(refused);
	assert.ok(!refused.out.includes(RECOMMEND) && !refused.out.includes(NOTE), refused.out);
	const f = fixture();
	reported(f);
	assertOk(f.run("approve", "--quote", "merge 5", "--action", "merge", "--tickets", "5"));
	const gated = f.run("gate", "5", "--judged", "diff matches the brief");
	assert.deepEqual(assertOk(gated).split("\n").slice(-2), [RECOMMEND, NOTE]);
	f.state.exec[MERGE_CALL] = () => {
		f.state.prs["feat/t5"] = goodPr({ state: "MERGED", mergeCommit: { oid: MOVED } });
		return ok();
	};
	assert.ok(assertOk(f.run("merge", "5")).includes(NOTE));
});

test("merge records no MERGED when GitHub does not say merged, and refuses to repeat a pending intent", () => {
	const f = fixture();
	approvedGated(f);
	f.state.exec[MERGE_CALL] = ok();
	assertRefused(f.run("merge", "5"), "not merged");
	assert.equal(f.events().at(-1).type, "merge-intent");
	assert.equal(f.events().filter((e) => e.type === "merged").length, 0);
	assertRefused(f.run("merge", "5"), "pending", "status");
	assert.deepEqual(mergeCalls(f), [MERGE_CALL]);
});

/** Pane `w1:p<n>` runs Pi (or only a shell when not live) and shows `screen`. */
function pane(f: Fixture, n: number, live: boolean, screen = "> ") {
	const id = `w1:p${n}`;
	const procs = live ? [{ argv0: "pi", name: "node", pid: 4242 }] : [{ argv0: "-zsh", name: "zsh", pid: 41 }];
	f.state.exec[`herdr pane process-info --pane ${id}`] = ok(
		JSON.stringify({ result: { process_info: { pane_id: id, foreground_processes: procs } } }),
	);
	f.state.exec[`herdr agent read ${id} --source visible`] = ok(screen);
	return id;
}

const DIALOG =
	"Allow git reset --hard?\n\n  git reset --hard HEAD~1\n\n→ Yes\n  No\n\n↑↓ navigate • enter select • esc cancel\n";

test("prompt sends to a live Pi with no dialog", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	const id = pane(f, 5, true);
	f.state.exec[`herdr agent prompt ${id} please rebase`] = ok();
	writeFileSync(join(f.runDir(), "contract-5.md"), "contract");
	f.calls.length = 0;
	assertOk(f.run("prompt", "5", "please rebase"));
	assert.deepEqual(
		f.calls.filter((c) => c.startsWith("herdr")),
		[
			`herdr pane process-info --pane ${id}`,
			`herdr agent read ${id} --source visible`,
			`herdr agent prompt ${id} please rebase`,
		],
	);
});

test("prompt is refused when a dialog is visible in the pane", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	pane(f, 5, true, DIALOG);
	writeFileSync(join(f.runDir(), "contract-5.md"), "contract");
	assertRefused(f.run("prompt", "5", "please rebase"), "dialog is visible", "esc");
	assert.ok(!f.calls.some((c) => c.startsWith("herdr agent prompt")));
});

test("prompt is refused on a dead pane", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	pane(f, 5, false);
	writeFileSync(join(f.runDir(), "contract-5.md"), "contract");
	assertRefused(f.run("prompt", "5", "please rebase"), "no live Pi");
	assert.ok(!f.calls.some((c) => c.startsWith("herdr agent prompt")));
});

// ---------------------------------------------------------------------------------------------------------------
// The coordinator contract, written by `contract` from CONTRACT.md.

const SKILL_DIR = join(import.meta.dirname, "../skills/batch-chief");
const CONTRACT_SOURCE = readFileSync(join(SKILL_DIR, "CONTRACT.md"), "utf8");

/** The backticked `<...>` tokens in the first column of CONTRACT.md's table headed `| <first> |`. */
function tablePlaceholders(source: string, first = "Placeholder"): string[] {
	const lines = source.split("\n");
	const start = lines.findIndex((l) => l.startsWith(`| ${first} |`));
	assert.ok(start >= 0, `CONTRACT.md has no ${first} table`);
	const rows = lines.slice(start + 2);
	const end = rows.findIndex((l) => !l.startsWith("|"));
	return rows.slice(0, end).flatMap((l) => [...l.split("|")[1].matchAll(/`(<[^`>]+>)`/g)].map((m) => m[1]));
}

const CONTRACT_ARGS = ["--lenses", "code-review Standards and Spec", "--skill", "implement-me-pi", "--setup", "npm ci"];

/** Records a push approval for #5 in the user's words, launches #5, and answers its worktree's merge-base. */
function contractable(f: Fixture) {
	assertOk(f.preflight());
	f.at("10:01");
	assertOk(
		f.run(
			"approve",
			"--quote",
			"push 5 and open the PR",
			"--question",
			"may 5 push?",
			"--action",
			"push",
			"--tickets",
			"5",
		),
	);
	assertOk(f.run("approve", "--quote", "merge 5", "--action", "merge", "--tickets", "5"));
	f.at("10:02");
	assertOk(f.launch(5));
	f.state.exec[`git -C ${join(f.dir, "t5")} merge-base HEAD origin/main`] = ok(`${MOVED}\n`);
	return join(f.runDir(), "contract-5.md");
}

test("contract fills every table placeholder of CONTRACT.md from the run, keeping <pr> and the report template's fields", () => {
	const f = fixture();
	const path = contractable(f);
	const out = assertOk(f.run("contract", "5", ...CONTRACT_ARGS));
	assert.ok(out.includes(path), out);
	const written = readFileSync(path, "utf8");
	const placeholders = tablePlaceholders(CONTRACT_SOURCE);
	assert.ok(placeholders.includes("<scratch>") && placeholders.includes("<authorised actions>"), placeholders.join());
	for (const p of placeholders) assert.ok(!written.includes(p), `${p} left in:\n${written}`);
	for (const kept of ["<pr>", "<one clause>", "git checkout -- <path>", "<DONE or BLOCKED>", "<URL>", "<criterion>"])
		assert.ok(written.includes(kept), `${kept} missing from:\n${written}`);
	const declared = tablePlaceholders(CONTRACT_SOURCE, "Kept as written");
	assert.deepEqual([...declared].sort(), ["<one clause>", "<path>", "<pr>"]);
	const left = new Set(written.slice(0, written.indexOf("\n## Report template\n")).match(/<[^<>\n]+>/g));
	assert.deepEqual([...left].sort(), [...declared].sort(), "the contract keeps a token CONTRACT.md does not declare");
	assert.match(written, /^# Coordinator contract: 5\n/);
	assert.match(written, /\n## Report template\n[\s\S]*\n# Report: #5\n/);
	for (const fact of [
		"herdr pane `w1:p1`",
		`Implementer contract: \`${f.brief}\``,
		`Checkout: \`${join(f.dir, "t5")}\` (your cwd), branch \`feat/t5\`, created clean from \`main\` at \`${MOVED}\`. \`npm ci\` has been run.`,
		`Fixed review point: \`${MOVED}\``,
		"Check: `npm test`",
		"with every lens: code-review Standards and Spec.",
		`\`${join(f.runDir(), "scratch", "5")}/\``,
		`Write \`${join(f.dir, "report-5.md")}\``,
		'- push, 2026-11-11T10:01:00.000Z: "push 5 and open the PR", answering "may 5 push?"',
	])
		assert.ok(written.includes(fact), `${fact} missing from:\n${written}`);
	assert.ok(!written.includes('"merge 5"'), "a merge approval is the chief's, not the coordinator's");
	assert.ok(!written.includes("| Placeholder |"), "the chief's table was copied into the contract");
});

test("contract takes its text only from CONTRACT.md: batch.ts holds no copy of it", () => {
	const helper = readFileSync(join(SKILL_DIR, "batch.ts"), "utf8");
	for (const sentence of [
		"You are the Pi coordinator for one ticket",
		"Everything else stays the user's",
		"Cost and wall time",
	])
		assert.ok(CONTRACT_SOURCE.includes(sentence) && !helper.includes(sentence), sentence);
});

test("contract without --lenses takes the default stated in CONTRACT.md's table, filled", () => {
	const f = fixture();
	const path = contractable(f);
	assertOk(f.run("contract", "5", "--skill", "implement-me-pi", "--setup", "npm ci"));
	assert.ok(
		readFileSync(path, "utf8").includes(
			`with every lens: the \`code-review\` skill's Standards and Spec lenses, run against \`${MOVED}\`.`,
		),
	);
});

test("contract refuses, naming the placeholder, when a value is missing, and writes nothing", () => {
	const f = fixture();
	const path = contractable(f);
	assertRefused(f.run("contract", "5", "--lenses", "x", "--skill", "implement-me-pi"), "<setup>", "--setup");
	assertRefused(f.run("contract", "5", "--lenses", "x", "--setup", "npm ci"), "<implementation skill>", "--skill");
	f.state.exec[`git -C ${join(f.dir, "t5")} merge-base HEAD origin/main`] = { code: 1, stdout: "", stderr: "bad" };
	assertRefused(f.run("contract", "5", ...CONTRACT_ARGS), "<base sha>", "merge-base");
	assert.ok(!existsSync(path));
});

test("contract refuses a row covered by no approval, or only by inferred ones, naming approve", () => {
	const none = fixture();
	assertOk(none.preflight());
	assertOk(none.launch(5));
	none.state.exec[`git -C ${join(none.dir, "t5")} merge-base HEAD origin/main`] = ok(`${SHA}\n`);
	assertRefused(none.run("contract", "5", ...CONTRACT_ARGS), "<authorised actions>", "no approval", "approve");
	assertOk(none.run("approve", "--quote", "merge it", "--action", "merge", "--tickets", "5"));
	assertRefused(none.run("contract", "5", ...CONTRACT_ARGS), "<authorised actions>", "no approval");
	assertOk(none.run("approve", "--quote", "ship all", "--action", "release", "--tickets", "5", "--inferred"));
	assertRefused(
		none.run("contract", "5", ...CONTRACT_ARGS),
		"only an inferred approval covers #5",
		"approve (without --inferred)",
	);
	assert.ok(!existsSync(join(none.runDir(), "contract-5.md")));
});

test("contract is written only between launch and the row's next event, and rewrites its own file there", () => {
	const f = fixture();
	const path = contractable(f);
	assertRefused(f.run("contract", "6", ...CONTRACT_ARGS), "#6 is QUEUED", "event 6 launch");
	assertOk(f.run("contract", "5", ...CONTRACT_ARGS));
	assertOk(f.run("contract", "5", "--lenses", "evolvability", "--skill", "implement-me-pi", "--setup", "npm ci"));
	assert.ok(readFileSync(path, "utf8").includes("with every lens: evolvability."));
	f.at("10:05");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "DONE", "10:04")));
	assertRefused(f.run("contract", "5", ...CONTRACT_ARGS), "#5 is REPORTED");
	assert.ok(readFileSync(path, "utf8").includes("with every lens: evolvability."));
});

/** A fixture whose helper is a copy of batch.ts beside `source` as its CONTRACT.md. */
async function withContract(source: string) {
	assert.notEqual(source, CONTRACT_SOURCE, "the copy changes nothing");
	const copy = mkdtempSync(join(ROOT, "skill-copy-"));
	writeFileSync(join(copy, "batch.ts"), readFileSync(join(SKILL_DIR, "batch.ts")));
	writeFileSync(join(copy, "CONTRACT.md"), source);
	const copied = await import(join(copy, "batch.ts"));
	return fixture(copied.main);
}

test("contract refuses, naming each, a placeholder in the contract text that neither table declares", async () => {
	const f = await withContract(
		CONTRACT_SOURCE.replace(
			"# Coordinator contract: <n>",
			"# Coordinator contract: <n>, <ticket title> (<ticket url>)",
		),
	);
	const path = contractable(f);
	assertRefused(f.run("contract", "5", ...CONTRACT_ARGS), "<ticket title>", "<ticket url>");
	assert.ok(!existsSync(path));
	const dropped = await withContract(CONTRACT_SOURCE.replace(/\n\| `<check>` \|.*/, ""));
	const droppedPath = contractable(dropped);
	assertRefused(dropped.run("contract", "5", ...CONTRACT_ARGS), "<check>");
	assert.ok(!existsSync(droppedPath));
});

test("contract keeps a fenced example inside the contract text whole", async () => {
	const f = await withContract(
		CONTRACT_SOURCE.replace("## Sequence\n", "## Sequence\n\n```bash\ngit log --oneline -1\n```\n"),
	);
	const path = contractable(f);
	assertOk(f.run("contract", "5", ...CONTRACT_ARGS));
	const written = readFileSync(path, "utf8");
	assert.ok(written.includes("## Sequence\n\n```bash\ngit log --oneline -1\n```\n"), written);
	assert.ok(written.includes("[coordinator 5] BLOCKED: "), `the contract was cut short:\n${written}`);
});

test("contract takes the default lenses from their own cell: text added beside it stays out", async () => {
	const f = await withContract(
		CONTRACT_SOURCE.replace(
			"without it, the default |",
			"without it, the default. Ask the user when intake named none \\| or one |",
		),
	);
	const path = contractable(f);
	assertOk(f.run("contract", "5", "--skill", "implement-me-pi", "--setup", "npm ci"));
	const written = readFileSync(path, "utf8");
	assert.ok(written.includes(`Standards and Spec lenses, run against \`${MOVED}\`.`), written);
	assert.ok(!written.includes("Ask the user when intake"), written);
});

test("contract refuses, naming it, a placeholder CONTRACT.md's table gains that it has no source for", async () => {
	const grown = CONTRACT_SOURCE.replace(
		"| `<check>` |",
		"| `<ticket title>` | the issue's title |\n| `<check>` |",
	).replace("# Coordinator contract: <n>", "# Coordinator contract: <n>, <ticket title>");
	const f = await withContract(grown);
	const path = contractable(f);
	assertRefused(f.run("contract", "5", ...CONTRACT_ARGS), "<ticket title>");
	assert.ok(!existsSync(path));
});

test("prompt refuses a RUNNING(implement) row whose contract is not written, naming the contract command", () => {
	const f = fixture();
	const path = contractable(f);
	const id = pane(f, 5, true);
	f.state.exec[`herdr agent prompt ${id} start`] = ok();
	f.calls.length = 0;
	assertRefused(f.run("prompt", "5", "start"), path, "batch.ts contract 5");
	assert.ok(!f.calls.some((c) => c.startsWith("herdr")), f.calls.join("\n"));
	assertOk(f.run("contract", "5", ...CONTRACT_ARGS));
	assertOk(f.run("prompt", "5", "start"));
});

test("SKILL.md step 3 launches, then writes the contract with the command, then prompts, and re-checks a brief on a moved base", () => {
	const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
	const step = skill.slice(skill.indexOf("## 3. Launch"), skill.indexOf("## 4."));
	const at = (text: string) => {
		const i = step.indexOf(text);
		assert.ok(i >= 0, `step 3 lacks ${text}`);
		return i;
	};
	assert.ok(at("batch.ts event <n> launch") < at("batch.ts contract <n>"));
	assert.ok(at("batch.ts contract <n>") < at("batch.ts prompt <n>"));
	assert.ok(!step.includes("with the `write` tool"), "step 3 still writes the contract by hand");
	at("git log --oneline <brief's base>..origin/<base> -- <the brief's files>");
	assert.ok(skill.split("\n").length < 130, "SKILL.md has 130 lines or more");
	const branch = at("worktree add -b <branch>");
	assert.ok(at("`<type>/<n>-<slug>`") - branch < 300, "step 3 item 1 does not name the branch rule");
	at('--setup "<what item 2 ran>"');
	assert.ok(CONTRACT_SOURCE.includes("what step 3, item 2 ran"), "CONTRACT.md's <setup> names another step");
});

test("SKILL.md step 4 writes a live check's result into the PR body before or after the merge, by its row", () => {
	const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
	const bullet = skill.split("\n").find((l) => l.startsWith("- **Live check.**"));
	assert.ok(bullet, "step 4 has no Live check bullet");
	assert.match(bullet, /PR body before merging for `before-merge`, after the merge for `after-merge`/);
	assert.ok(
		bullet.split(/\. (?=[A-Z`])/).length <= 4,
		`the Live check bullet has more than four sentences: ${bullet}`,
	);
});

/**
 * A MERGED #5 and a launched, then DROPPED #6, each with a worktree and git dir on disk and a pane that runs Pi
 * until `/quit` is sent. Clears the recorded calls.
 */
function cleanable(f: Fixture, ...preflightExtra: string[]) {
	approvedGated(f, ...preflightExtra);
	assertOk(f.launch(6));
	assertOk(f.run("event", "6", "drop", "--user", "not now"));
	f.state.prs["feat/t5"] = goodPr({ state: "MERGED", mergeCommit: { oid: MOVED } });
	assert.match(rowLine(f, 5), /^#5 MERGED/);
	const rows = [5, 6].map((n) => {
		const wt = join(f.dir, `t${n}`);
		const gitDir = join(f.repo, ".git", "worktrees", `t${n}`);
		mkdirSync(wt, { recursive: true });
		mkdirSync(gitDir, { recursive: true });
		const id = pane(f, n, true);
		f.state.exec[`herdr agent prompt ${id} /quit`] = () => {
			pane(f, n, false);
			return ok();
		};
		f.state.exec[`git -C ${wt} rev-parse --path-format=absolute --git-dir`] = ok(`${gitDir}\n`);
		f.state.exec[`git -C ${wt} status --porcelain`] = ok();
		f.state.exec[`git worktree remove ${wt}`] = () => {
			rmSync(wt, { recursive: true });
			return ok();
		};
		f.state.exec[`git rev-parse --verify --quiet refs/heads/feat/t${n}`] = ok(`${HEAD}\n`);
		f.state.exec[`git branch -D feat/t${n}`] = ok();
		f.state.exec[`herdr pane close ${id}`] = ok();
		return { wt, gitDir, id };
	});
	f.calls.length = 0;
	return rows;
}

const EFFECT = /^(herdr agent prompt|herdr pane close|git worktree|git branch)/;

test("cleanup quits each coordinator, then removes the worktree, deletes a merged branch, and closes the pane", () => {
	const f = fixture();
	const [r5, r6] = cleanable(f);
	assertOk(f.run("note", "--kind", "manual-fix", "--ticket", "5", "fixed a typo by hand"));
	const out = assertOk(f.run("cleanup"));
	assert.deepEqual(
		f.calls.filter((c) => EFFECT.test(c)),
		[
			`herdr agent prompt ${r5.id} /quit`,
			`git worktree remove ${r5.wt}`,
			"git branch -D feat/t5",
			`herdr pane close ${r5.id}`,
			`herdr agent prompt ${r6.id} /quit`,
			`git worktree remove ${r6.wt}`,
			`herdr pane close ${r6.id}`,
		],
	);
	assert.ok(!f.calls.some((c) => c.includes("kill")));
	assert.match(out, /manual-fix #5: fixed a typo by hand/);
	assert.match(out, /Resources left:\n- #6 branch feat\/t6: kept, the PR is not merged$/);
});

test("cleanup --dry-run changes nothing and prints what it would do", () => {
	const f = fixture();
	const [r5] = cleanable(f);
	const out = assertOk(f.run("cleanup", "--dry-run"));
	assert.deepEqual(
		f.calls.filter((c) => EFFECT.test(c)),
		[],
	);
	assert.ok(existsSync(r5.wt));
	assert.ok(out.includes(`would run: git worktree remove ${r5.wt}`), out);
	assert.ok(out.includes(`would run: herdr agent prompt ${r5.id} /quit`), out);
});

test("cleanup leaves a dirty worktree and a row with a present lock, and lists them", () => {
	const f = fixture();
	const [r5, r6] = cleanable(f);
	f.state.exec[`git -C ${r5.wt} status --porcelain`] = ok("?? scratch.txt\n");
	writeFileSync(join(r6.gitDir, "me-pi-implement.lock"), "");
	const out = assertOk(f.run("cleanup"));
	assert.deepEqual(
		f.calls.filter((c) => /^(git worktree remove|git branch -D|herdr pane close)/.test(c)),
		[],
	);
	assert.ok(existsSync(r5.wt) && existsSync(r6.wt));
	assert.match(out, /Resources left:[\s\S]*#5 [^\n]*not clean[^\n]*scratch\.txt/);
	assert.match(out, /Resources left:[\s\S]*#6 [^\n]*me-pi-implement\.lock/);
});

// ---------------------------------------------------------------------------------------------------------------
// Review fixes.

test("status lists gate on a REPORTED row and merge on a GATED row, and neither elsewhere", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	const gateLine = 'allowed: gate 5 --judged "<your note on the diff>"';
	const mergeLine = "allowed: merge 5";
	let out = assertOk(f.run("status"));
	assert.ok(!out.includes("gate 5") && !out.includes(mergeLine), out);
	f.at("10:05");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "DONE", "10:04")));
	out = assertOk(f.run("status"));
	assert.ok(out.includes(gateLine), out);
	assert.ok(!out.includes(mergeLine), out);
	f.append({ at: "2026-11-11T10:06:00.000Z", type: "gate", ticket: 5, sha: HEAD });
	f.state.prs["feat/t5"] = goodPr();
	out = assertOk(f.run("status"));
	assert.ok(out.includes(mergeLine), out);
	assert.ok(!out.includes("gate 5"), out);
	assert.ok(!/allowed: (gate|merge) 6/.test(out), out);
});

test("a chief answer's basis must be one whole line of the brief, not a fragment", () => {
	const f = fixture();
	writeFileSync(f.brief, "# Brief\n\n- The test may use a fake clock.\n1. Keep   the old name.\n");
	assertOk(f.preflight());
	assertOk(f.launch(5));
	assertOk(f.launch(6));
	f.at("10:05");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "BLOCKED", "10:04")));
	assertOk(f.run("event", "6", "report", "--path", f.report(6, "BLOCKED", "10:04")));
	assertRefused(f.run("event", "5", "answer", "--basis", "the"), "as a whole line");
	assertRefused(f.run("event", "5", "answer", "--basis", "may use a fake clock."), "as a whole line");
	assertOk(f.run("event", "5", "answer", "--basis", "The test may use a fake clock."));
	assertOk(f.run("event", "6", "answer", "--basis", "Keep the old name."));
});

test("cleanup leaves and lists a row whose Pi still runs after /quit, removing nothing", () => {
	const f = fixture();
	const [r5, r6] = cleanable(f);
	f.state.exec[`herdr agent prompt ${r5.id} /quit`] = ok();
	const out = assertOk(f.run("cleanup"));
	assert.deepEqual(
		f.calls.filter((c) => EFFECT.test(c)),
		[
			`herdr agent prompt ${r5.id} /quit`,
			`herdr agent prompt ${r6.id} /quit`,
			`git worktree remove ${r6.wt}`,
			`herdr pane close ${r6.id}`,
		],
	);
	assert.ok(existsSync(r5.wt));
	assert.ok(!f.calls.some((c) => c.includes("kill")));
	assert.match(out, new RegExp(`Resources left:\\n- #5 [^\\n]*Pi still runs in pane ${r5.id} after /quit`));
});

test("cleanup of a row whose pane is already gone removes the worktree and closes no pane", () => {
	const f = fixture();
	const [r5] = cleanable(f);
	f.state.exec[`herdr pane process-info --pane ${r5.id}`] = {
		code: 1,
		stdout: '{"error":{"code":"pane_not_found"}}',
		stderr: "",
	};
	const out = assertOk(f.run("cleanup"));
	const effects = f.calls.filter((c) => EFFECT.test(c));
	assert.deepEqual(
		effects.filter((c) => c.includes(r5.id) || c.includes("t5")),
		[`git worktree remove ${r5.wt}`, "git branch -D feat/t5"],
	);
	assert.match(out, /Resources left:\n- #6 branch feat\/t6: kept, the PR is not merged$/);
});

test("merge on a behind PR whose update-branch fails records nothing and names the failure", () => {
	const f = fixture();
	approvedGated(f);
	f.state.prs["feat/t5"] = goodPr({ mergeStateStatus: "BEHIND" });
	f.state.exec["gh pr update-branch 12"] = { code: 1, stdout: "", stderr: "HTTP 422: merge conflict" };
	const before = f.events().length;
	assertRefused(f.run("merge", "5"), "gh pr update-branch failed", "HTTP 422: merge conflict");
	assert.equal(f.events().length, before);
	assert.deepEqual(mergeCalls(f), []);
	assert.match(rowLine(f, 5), new RegExp(`^#5 GATED\\(${HEAD}\\)`));
});

test("merge is refused when the base rules' merge methods exclude squash", () => {
	const f = fixture();
	f.state.rules = ok(
		JSON.stringify([{ type: "pull_request", parameters: { allowed_merge_methods: ["merge", "rebase"] } }]),
	);
	approvedGated(f);
	assertRefused(f.run("merge", "5"), "allow merge, rebase, not squash");
	assert.deepEqual(mergeCalls(f), []);
	assert.notEqual(f.events().at(-1).type, "merge-intent");
});

test("contract: the guard's confirm title is a dialog to prompt", async () => {
	let handler: any;
	registerGuard({
		on: (_event: string, h: any) => {
			handler = h;
		},
		registerCommand: () => {},
		events: { emit: () => {} },
	} as any);
	const titles: string[] = [];
	const command = "git push origin main";
	const cwd = mkdtempSync(join(ROOT, "guard-"));
	await handler(
		{ type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command } },
		{
			cwd,
			hasUI: true,
			ui: {
				confirm: async (title: string) => {
					titles.push(title);
					return false;
				},
			},
		},
	);
	assert.equal(titles.length, 1, "guard did not open a confirm");
	const screen = `${titles[0]}\n\n  ${command}\n\n→ Yes\n  No\n`;
	assert.ok(!screen.includes("enter select"));
	assert.equal(dialogVisible(screen), true, `batch does not see the guard confirm ${JSON.stringify(titles[0])}`);
	assert.equal(dialogVisible("> please rebase\n"), false);
});

test("contract: batch's lock path is where the implement job takes its lock", async () => {
	const repo = mkdtempSync(join(ROOT, "lock-repo-"));
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
	git("init", "-q", "--template=", "-b", "main");
	git("config", "core.hooksPath", "/dev/null");
	git("config", "commit.gpgsign", "false");
	git("config", "user.email", "batch-test@example.invalid");
	git("config", "user.name", "Batch Test");
	writeFileSync(join(repo, "a.txt"), "a\n");
	git("add", "-A");
	git("commit", "-q", "-m", "initial");
	git("switch", "-q", "-c", "goal/x");
	const job = await prepare(repo, "im70", "npm test");
	try {
		const lock = implementLock(git("rev-parse", "--path-format=absolute", "--git-dir"));
		assert.ok(existsSync(lock), `no implement lock at ${lock}`);
		assert.equal(lock, job.lockPath);
	} finally {
		rmSync(job.lockPath, { force: true });
		rmSync(job.ghConfigDir, { recursive: true, force: true });
	}
});

test("a run written by another version of the helper is refused", () => {
	const f = fixture();
	assertOk(f.preflight());
	assert.equal(typeof f.events()[0].version, "number");
	const path = join(f.runDir(), "events.jsonl");
	const [first, ...rest] = readFileSync(path, "utf8").split("\n");
	const old = { ...JSON.parse(first) };
	delete old.version;
	writeFileSync(path, [JSON.stringify(old), ...rest].join("\n"));
	for (const argv of [["status"], ["event", "5", "drop", "--user", "x"], ["cleanup"]])
		assertRefused(
			f.run(...argv),
			"written by another version of the helper",
			"version none",
			"this helper writes version",
		);
});

test("a report whose Status line is still the template placeholder is not a report", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	f.at("10:05");
	for (const status of ["DONE | BLOCKED", "<DONE or BLOCKED>", "DONE, mostly"])
		assertRefused(f.run("event", "5", "report", "--path", f.report(5, status, "10:04")), "exactly DONE or BLOCKED");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "**BLOCKED**", "10:04")));
	assert.match(rowLine(f, 5), /^#5 ASKED\(chief\)/);
	const template = readFileSync(join(import.meta.dirname, "../skills/batch-chief/CONTRACT.md"), "utf8");
	assert.match(template, /\n## Report template\n[\s\S]*\n## Status\n<DONE or BLOCKED>\n/);
});

test("SKILL.md marks a coordinator's pane unattended before it starts Pi there, and CONTRACT.md quotes guard's refusal", async () => {
	const skill = readFileSync(join(import.meta.dirname, "../skills/batch-chief/SKILL.md"), "utf8");
	const exported = skill.indexOf('herdr pane run <pane> "export ME_PI_UNATTENDED=1"');
	assert.ok(exported >= 0, "step 3 does not export ME_PI_UNATTENDED=1 into the pane");
	assert.ok(exported < skill.indexOf("herdr agent start coordinator-<n>"), "the export comes after herdr agent start");
	const contract = readFileSync(join(import.meta.dirname, "../skills/batch-chief/CONTRACT.md"), "utf8");
	let handler: any;
	registerGuard({
		on: (_event: string, h: any) => {
			handler = h;
		},
		registerCommand: () => {},
		events: { emit: () => {} },
	} as any);
	const before = process.env.ME_PI_UNATTENDED;
	process.env.ME_PI_UNATTENDED = "1";
	let result: { block?: boolean; reason?: string } | undefined;
	try {
		result = await handler(
			{ type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "git push origin main" } },
			{ cwd: mkdtempSync(join(ROOT, "guard-")), hasUI: true, ui: { confirm: async () => assert.fail("confirm") } },
		);
	} finally {
		if (before === undefined) delete process.env.ME_PI_UNATTENDED;
		else process.env.ME_PI_UNATTENDED = before;
	}
	assert.equal(result?.block, true, "guard did not refuse in an unattended session");
	// CONTRACT.md quotes the refusal up to its first sentence's end, with the risk elided.
	const refusal = result!.reason!.replace(/^Blocked \([^)]*\)/, "Blocked (...)");
	const quoted = refusal.slice(0, refusal.indexOf(". "));
	assert.ok(quoted.startsWith("Blocked (...): "), refusal);
	assert.ok(
		contract.includes(`\`${quoted}\`: such a refusal is reported`),
		`CONTRACT.md does not quote guard's refusal ${JSON.stringify(quoted)}`,
	);
	assert.match(
		contract,
		/such a refusal is reported .*never retried or rerouted through another tool, worker or path/,
	);
});

// ---------------------------------------------------------------------------------------------------------------
// The current run pointer and format versions.

const currentPointer = (f: Fixture) => join(`${f.repo}.worktrees`, ".batch", "current");

test("a cleanup that leaves nothing removes current, keeps the run directory, and the next preflight starts", () => {
	const f = fixture();
	cleanable(f);
	f.state.exec["git rev-parse --verify --quiet refs/heads/feat/t6"] = { code: 1, stdout: "", stderr: "" };
	const dir = f.runDir();
	const out = assertOk(f.run("cleanup"));
	assert.match(out, /Resources left:\n- none/);
	assert.ok(!existsSync(currentPointer(f)), `current is still there after:\n${out}`);
	assert.match(out.split("\n").at(-1)!, /current run cleared/);
	assert.ok(existsSync(join(dir, "events.jsonl")), "the run's events.jsonl was removed");
	for (const argv of [
		["status"],
		["event", "5", "drop", "--user", "x"],
		["cleanup"],
		["note", "--kind", "manual-fix", "--ticket", "5", "x"],
	])
		assertRefused(f.run(...argv), "no current run", "run preflight first");
	f.at("11:00");
	assertOk(f.preflight());
	assert.notEqual(f.runDir(), dir);
});

test("a cleanup that leaves a resource or a row that is not terminal keeps current", () => {
	const dirty = fixture();
	const [r5] = cleanable(dirty);
	dirty.state.exec[`git -C ${r5.wt} status --porcelain`] = ok("?? scratch.txt\n");
	assert.match(assertOk(dirty.run("cleanup")), /Resources left:\n- #5 /);
	assert.ok(existsSync(currentPointer(dirty)), "current removed while a worktree is left");
	const running = fixture();
	assertOk(running.preflight());
	assertOk(running.launch(5));
	assertOk(running.run("cleanup"));
	assert.ok(existsSync(currentPointer(running)), "current removed while #5 runs");
	const queued = fixture();
	assertOk(queued.preflight());
	assert.match(assertOk(queued.run("cleanup")), /Resources left:\n- none/);
	assert.ok(existsSync(currentPointer(queued)), "current removed while rows are QUEUED");
});

test("cleanup --dry-run never removes current", () => {
	const f = fixture();
	cleanable(f);
	f.state.exec["git rev-parse --verify --quiet refs/heads/feat/t6"] = { code: 1, stdout: "", stderr: "" };
	const out = assertOk(f.run("cleanup", "--dry-run"));
	assert.match(out, /Resources left:\n- none/);
	assert.ok(existsSync(currentPointer(f)), "dry run removed current");
});

/** Rewrites the current run's preflight to `version` and replaces its later events with `rest`. */
function otherVersion(f: Fixture, version: number, rest: object[]) {
	const path = join(f.runDir(), "events.jsonl");
	const [first] = f.events();
	writeFileSync(path, [{ ...first, version }, ...rest].map((e) => `${JSON.stringify(e)}\n`).join(""));
	return readFileSync(path, "utf8");
}

test("preflight refuses a current run of another version, finished or not, and names the flag that sets it aside", () => {
	for (const rest of [
		[{ at: "2026-11-11T10:01:00.000Z", type: "finished-v2", ticket: 5 }],
		[{ at: "2026-11-11T10:01:00.000Z", type: "launch", ticket: 5 }],
	]) {
		const f = fixture();
		assertOk(f.preflight());
		const old = f.runDir();
		otherVersion(f, 3, rest);
		f.at("11:00");
		assertRefused(
			f.preflight(),
			"written by another version of the helper",
			"version 3",
			"preflight again with --set-aside-old-run",
		);
		assert.equal(f.runDir(), old, "a refused preflight moved current");
	}
});

test("preflight --set-aside-old-run starts a new run and leaves the other version's run on disk unread", () => {
	for (const rest of [[], [{ at: "2026-11-11T10:01:00.000Z", type: "launch", ticket: 5 }]]) {
		const f = fixture();
		assertOk(f.preflight());
		const old = f.runDir();
		const before = otherVersion(f, 3, rest);
		f.at("11:00");
		const out = assertOk(
			f.run(
				"preflight",
				...["--repo", f.repo, "--tickets", "5,6", "--check", "npm test", "--chief-pane", "w1:p1"],
				"--set-aside-old-run",
				"the old run is finished and cleaned up",
			),
		);
		assert.ok(
			out.includes(`set aside run ${old.split("/").at(-1)} (version 3), not checked; it stays in ${old}`),
			out,
		);
		assert.notEqual(f.runDir(), old);
		assert.equal(readFileSync(join(old, "events.jsonl"), "utf8"), before);
	}
});

test("preflight --set-aside-old-run still refuses an unfinished run of this version", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	f.at("11:00");
	assertRefused(
		f.run(
			"preflight",
			...["--repo", f.repo, "--tickets", "7", "--check", "npm test", "--chief-pane", "w1:p1"],
			"--set-aside-old-run",
			"the old run is finished and cleaned up",
		),
		"still has rows that are not terminal: #5, #6",
	);
});

const preflightArgs = (f: Fixture) => [
	"--repo",
	f.repo,
	"--tickets",
	"5,6",
	"--check",
	"npm test",
	"--chief-pane",
	"w1:p1",
];

test("preflight --set-aside-old-run takes the user's words and records them with the run set aside", () => {
	const f = fixture();
	assertOk(f.preflight());
	const old = f.runDir();
	otherVersion(f, 3, []);
	f.at("11:00");
	for (const words of ["", "   "])
		assertRefused(f.run("preflight", ...preflightArgs(f), "--set-aside-old-run", words), "--set-aside-old-run");
	assert.equal(f.runDir(), old, "a refused preflight moved current");
	assert.equal(f.run("preflight", ...preflightArgs(f), "--set-aside-old-run").code, 1);
	const words = "the old batch is merged and cleaned up";
	assertOk(f.run("preflight", ...preflightArgs(f), "--set-aside-old-run", words));
	const id = old.split("/").at(-1);
	assert.deepEqual(f.events()[0].setAside, { run: id, version: 3, user: words });
	assert.ok(
		readLedger(f).includes(`- Set aside: run ${id} (version 3), not checked: ${JSON.stringify(words)}`),
		readLedger(f),
	);
});

test("only preflight's refusal of another version names --set-aside-old-run, after the user confirms", () => {
	const f = fixture();
	assertOk(f.preflight());
	otherVersion(f, 3, []);
	f.at("11:00");
	assertRefused(
		f.preflight(),
		"Finish that run with the helper that wrote it",
		"only after the user confirms it is finished and cleaned up",
		`--set-aside-old-run "<user's words>"`,
	);
	for (const argv of [["status"], ["event", "5", "drop", "--user", "x"], ["cleanup"]]) {
		const result = f.run(...argv);
		assertRefused(result, "Finish that run with the helper that wrote it");
		assert.ok(!result.out.includes("--set-aside-old-run"), result.out);
	}
});

test("a cleanup that keeps a local branch lists it under Resources left and keeps current", () => {
	const f = fixture();
	cleanable(f);
	const out = assertOk(f.run("cleanup"));
	assert.match(out, /kept branch feat\/t6/);
	assert.match(out, /Resources left:\n- #6 branch feat\/t6: kept, the PR is not merged$/);
	assert.ok(existsSync(currentPointer(f)), `current removed while branch feat/t6 is kept:\n${out}`);
});

test("a cleanup whose branch check fails lists it under Resources left and keeps current", () => {
	const f = fixture();
	cleanable(f);
	f.state.exec["git rev-parse --verify --quiet refs/heads/feat/t6"] = {
		code: 128,
		stdout: "",
		stderr: "fatal: not a git repository\n",
	};
	const out = assertOk(f.run("cleanup"));
	assert.ok(out.includes("  left: cannot check branch feat/t6: fatal: not a git repository"), out);
	assert.match(out, /Resources left:\n- #6 .*: cannot check branch feat\/t6: fatal: not a git repository$/);
	assert.ok(existsSync(currentPointer(f)), `current removed while branch feat/t6 is unchecked:\n${out}`);
});

test("a cleanup whose current pointer cannot be removed still returns its output and names the failure", () => {
	const f = fixture();
	const [, r6] = cleanable(f);
	f.state.exec["git rev-parse --verify --quiet refs/heads/feat/t6"] = { code: 1, stdout: "", stderr: "" };
	// The last effect turns current into a directory, which unlink refuses whoever runs the test.
	f.state.exec[`herdr pane close ${r6.id}`] = () => {
		rmSync(currentPointer(f));
		mkdirSync(currentPointer(f));
		return ok();
	};
	const out = assertOk(f.run("cleanup"));
	assert.match(out, /Resources left:\n- none/);
	assert.ok(out.includes(`ran: git worktree remove ${r6.wt}`), out);
	const last = out.split("\n").at(-1)!;
	assert.ok(last.startsWith(`current run not cleared: removing ${currentPointer(f)} failed: `), out);
	assert.match(last, /E(PERM|ISDIR)/);
	assert.ok(existsSync(currentPointer(f)));
});

/** Makes the frozen `fixtures/batch-chief/<name>.jsonl` the current run `golden-<name>`; returns its text and batch dir. */
function goldenRun(f: Fixture, name: string) {
	const golden = readFileSync(join(import.meta.dirname, `fixtures/batch-chief/${name}.jsonl`), "utf8");
	const batch = join(`${f.repo}.worktrees`, ".batch");
	mkdirSync(join(batch, `golden-${name}`), { recursive: true });
	writeFileSync(join(batch, `golden-${name}`, "events.jsonl"), golden);
	writeFileSync(join(batch, "current"), `golden-${name}\n`);
	return { golden, batch };
}

test("golden: a frozen version-1 events.jsonl rebuilds to the same rows", () => {
	const f = fixture();
	const { golden, batch } = goldenRun(f, "v1-events");
	f.at("10:55");
	const out = assertOk(f.run("status"));
	const rows = out.split("\n").filter((l) => /^(#| {2}allowed:)/.test(l));
	assert.deepEqual(rows, [
		"#5 MERGED next: nobody",
		"#release LEFT_OPEN next: nobody",
		"#7 DROPPED next: nobody",
		"#8 RUNNING(review) next: coordinator, deadline 2026-11-11T11:19:00.000Z",
		"  allowed: event 8 report --path /golden/report-8.md",
		'  allowed: event 8 drop --user "<user\'s words>"',
	]);
	assert.equal(
		readFileSync(join(batch, "golden-v1-events", "events.jsonl"), "utf8"),
		golden,
		"status recorded an event",
	);
	const ledger = readFileSync(join(batch, "golden-v1-events", "ledger.md"), "utf8");
	for (const line of [
		"| #5 | MERGED | nobody |  | feat/t5 | 2026-11-11T10:23:00.000Z |  |",
		"| #release | LEFT_OPEN | nobody |  | feat/trelease | 2026-11-11T10:45:00.000Z |  |",
		"| #7 | DROPPED | nobody |  | feat/t7 | 2026-11-11T10:46:00.000Z |  |",
		"| #8 | RUNNING(review) | coordinator | 2026-11-11T11:19:00.000Z | feat/t8 | 2026-11-11T10:49:00.000Z |  |",
		'- 2026-11-11T10:22:00.000Z merge #5: "merge 5"',
		'- 2026-11-11T10:44:00.000Z merge #release: "ship them all" (inferred)',
		"- chief-answer #release: answered from the brief's clock line",
		"- gate-miss #8: CI ran on the old head",
	])
		assert.ok(ledger.includes(line), `ledger lacks ${line}:\n${ledger}`);
	assert.ok(ledger.includes("`/golden/repo`, base `main` at `1111111111111111111111111111111111111111`"), ledger);
});

// Generated once by running preflight --live, launch, report, an appended gate, approve --question, live --result and
// merge through this file's fake runner, with the fixture dir replaced by /golden; frozen since.
test("golden: a frozen version-2 events.jsonl with live checks rebuilds to the same rows", () => {
	const f = fixture();
	const { golden, batch } = goldenRun(f, "v2-events");
	f.at("10:55");
	const out = assertOk(f.run("status"));
	const rows = out.split("\n").filter((l) => /^(#| {2}(allowed|live check):)/.test(l));
	const result = `pass at ${HEAD}: curl showed the new header`;
	const owed = `OWED: run it, then batch.ts live 6 --result <pass|fail> --evidence "<text or path>"`;
	assert.deepEqual(rows, [
		"#5 MERGED next: nobody",
		`  live check: before-merge, ${result}`,
		"#6 MERGED next: nobody",
		'  allowed: live 6 --result <pass|fail> --evidence "<text or path>"',
		`  live check: after-merge, ${owed}`,
	]);
	assert.equal(
		readFileSync(join(batch, "golden-v2-events", "events.jsonl"), "utf8"),
		golden,
		"status recorded an event",
	);
	const ledger = readFileSync(join(batch, "golden-v2-events", "ledger.md"), "utf8");
	for (const line of [
		`| #5 | MERGED | nobody |  | feat/t5 | 2026-11-11T10:16:00.000Z | live check: before-merge, ${result} |`,
		`| #6 | MERGED | nobody |  | feat/t6 | 2026-11-11T10:17:00.000Z | live check: after-merge, ${owed.replace("|", "\\|")} |`,
		'- 2026-11-11T10:14:00.000Z merge #5, #6: "yes, merge both" answering "Merge #5 and #6?"',
	])
		assert.ok(ledger.includes(line), `ledger lacks ${line}:\n${ledger}`);
	assert.ok(ledger.includes("`/golden/repo`, base `main` at `1111111111111111111111111111111111111111`"), ledger);
	assertRefused(f.preflight(), "still owes a live check: #6");
});

test("a version-1 run has no live check: live commands refuse and record nothing", () => {
	const f = fixture();
	const { golden, batch } = goldenRun(f, "v1-events");
	assertRefused(f.run("live", "8", "--result", "pass", "--evidence", "x"), "#8 has no live check");
	assertRefused(f.run("live", "5", "start"), "#5 has no live check");
	assert.equal(readFileSync(join(batch, "golden-v1-events", "events.jsonl"), "utf8"), golden);
});

// ---------------------------------------------------------------------------------------------------------------
// Cleanup of the run's scratch and live clones, and what it lists for the user.

/** A `cleanable` fixture whose #6 branch is already gone, so cleanup leaves no resource and the run can end. */
function finishable(...preflightExtra: string[]) {
	const f = fixture();
	const rows = cleanable(f, ...preflightExtra);
	f.state.exec["git rev-parse --verify --quiet refs/heads/feat/t6"] = { code: 1, stdout: "", stderr: "" };
	return Object.assign(f, { rows });
}

/** Writes `text` at `path`, creating its directories. */
function put(path: string, text = "x") {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
	return path;
}

const gone = (path: string) => {
	try {
		lstatSync(path);
		return false;
	} catch {
		return true;
	}
};

test("cleanup removes the run's scratch and live directories after the coordinators quit, and keeps the run's records", () => {
	const f = finishable();
	const dir = f.runDir();
	put(join(dir, "scratch", "5", "notes.txt"));
	put(join(dir, "scratch", "6", "deep", "repro.ts"));
	put(join(dir, "live", "5", ".git", "HEAD"));
	const kept = ["contract-5.md", "report-5.md"].map((name) => put(join(dir, name)));
	assertOk(f.run("status"));
	const out = assertOk(f.run("cleanup"));
	assert.ok(gone(join(dir, "scratch")) && gone(join(dir, "live")), out);
	for (const path of [...kept, join(dir, "events.jsonl"), join(dir, "ledger.md")])
		assert.ok(existsSync(path), `${path} was removed`);
	assert.ok(out.includes(`removed: ${join(dir, "scratch")}`), out);
	assert.ok(out.includes(`removed: ${join(dir, "live")}`), out);
	assert.match(out.split("\n").at(-1)!, /current run cleared/);
});

test("cleanup unlinks a symlink inside scratch or live and never touches its target outside the run", () => {
	const f = finishable();
	const dir = f.runDir();
	const outsideDir = join(f.dir, "outside");
	const outsideFile = put(join(outsideDir, "keep.txt"), "keep");
	const loneFile = put(join(f.dir, "lone.txt"), "lone");
	mkdirSync(join(dir, "scratch", "5"), { recursive: true });
	mkdirSync(join(dir, "live"), { recursive: true });
	symlinkSync(outsideDir, join(dir, "scratch", "5", "to-dir"));
	symlinkSync(loneFile, join(dir, "scratch", "5", "to-file"));
	symlinkSync(outsideDir, join(dir, "live", "5"));
	symlinkSync(join(f.dir, "missing"), join(dir, "scratch", "dangling"));
	const out = assertOk(f.run("cleanup"));
	assert.ok(gone(join(dir, "scratch")) && gone(join(dir, "live")), out);
	assert.equal(readFileSync(outsideFile, "utf8"), "keep");
	assert.equal(readFileSync(loneFile, "utf8"), "lone");
	assert.ok(lstatSync(outsideDir).isDirectory());
});

test("cleanup unlinks a scratch directory that is itself a symlink out of the run, leaving the target and its files", () => {
	const f = finishable();
	const dir = f.runDir();
	const victim = join(f.dir, "victim");
	const file = put(join(victim, "sub", "data.txt"), "data");
	symlinkSync(victim, join(dir, "scratch"));
	const out = assertOk(f.run("cleanup"));
	assert.ok(gone(join(dir, "scratch")), out);
	assert.equal(readFileSync(file, "utf8"), "data");
	assert.ok(out.includes(`unlinked symlink: ${join(dir, "scratch")}`), out);
});

test("cleanup lists a report's Scratch paths left, including .. and absolute paths, and removes none of them", () => {
	const f = finishable();
	const dir = f.runDir();
	const relative = put(join(dir, "..", "..", "victim", "file.txt"), "rel");
	const absolute = put(join(f.dir, "abs-victim", "file.txt"), "abs");
	writeFileSync(
		join(f.dir, "report-5.md"),
		`# Report: #5\n\n## Status\nDONE\n\n## Scratch paths left\n- ../../victim\n- ${join(f.dir, "abs-victim")}\n\n## Not verified\n- none\n`,
	);
	writeFileSync(join(f.dir, "report-6.md"), "# Report: #6\n\n## Scratch paths left\n- none\n");
	for (const argv of [["cleanup", "--dry-run"], ["cleanup"]]) {
		const out = assertOk(f.run(...argv));
		assert.ok(out.includes(`- #5 scratch path left (from ${join(f.dir, "report-5.md")}): ../../victim`), out);
		assert.ok(
			out.includes(`- #5 scratch path left (from ${join(f.dir, "report-5.md")}): ${join(f.dir, "abs-victim")}`),
			out,
		);
		assert.ok(!out.includes("#6 scratch path left"), out);
	}
	assert.equal(readFileSync(relative, "utf8"), "rel");
	assert.equal(readFileSync(absolute, "utf8"), "abs");
});

test("cleanup --dry-run lists the scratch and live directories it would remove and removes nothing", () => {
	const f = finishable();
	const dir = f.runDir();
	const file = put(join(dir, "scratch", "5", "notes.txt"));
	const clone = put(join(dir, "live", "5", "README.md"));
	const out = assertOk(f.run("cleanup", "--dry-run"));
	assert.ok(existsSync(file) && existsSync(clone), out);
	assert.ok(out.includes(`would remove: ${join(dir, "scratch")}`), out);
	assert.ok(out.includes(`would remove: ${join(dir, "live")}`), out);
});

test("cleanup keeps scratch and live while a coordinator still runs or a row is not terminal", () => {
	const f = finishable();
	const [r5] = f.rows;
	f.state.exec[`herdr agent prompt ${r5.id} /quit`] = ok();
	const file = put(join(f.runDir(), "scratch", "5", "notes.txt"));
	const out = assertOk(f.run("cleanup"));
	assert.ok(existsSync(file), out);
	assert.ok(out.includes(`kept: ${join(f.runDir(), "scratch")}`), out);
	const running = fixture();
	assertOk(running.preflight());
	assertOk(running.launch(5));
	const kept = put(join(running.runDir(), "live", "5", "x"));
	assertOk(running.run("cleanup"));
	assert.ok(existsSync(kept));
});

test("cleanup of a run the version-1 helper started keeps scratch and live, lists them, and still ends the run", () => {
	const f = finishable();
	const dir = f.runDir();
	const [first, ...rest] = f.events();
	writeFileSync(
		join(dir, "events.jsonl"),
		[{ ...first, version: 1 }, ...rest].map((e) => `${JSON.stringify(e)}\n`).join(""),
	);
	const files = [put(join(dir, "scratch", "5", "notes.txt")), put(join(dir, "live", "5", "README.md"))];
	for (const argv of [["cleanup", "--dry-run"], ["cleanup"]]) {
		const out = assertOk(f.run(...argv));
		for (const file of files) assert.ok(existsSync(file), `${file} was removed:\n${out}`);
		const left = out.slice(out.indexOf("Resources left:"));
		for (const name of ["scratch", "live"]) assert.ok(left.includes(`- ${join(dir, name)}: not removed: run`), out);
		assert.ok(!out.includes("would remove"), out);
		if (argv.length === 1) assert.match(out.split("\n").at(-1)!, /current run cleared/);
	}
});

test("cleanup that cannot read scratch after the coordinators quit reports the partial outcome under Resources left", () => {
	const f = finishable();
	const [, r6] = f.rows;
	const dir = f.runDir();
	put(join(dir, "scratch", "5", "notes.txt"));
	// The last effect of the last row: from here on the run directory cannot be searched.
	f.state.exec[`herdr pane close ${r6.id}`] = () => {
		chmodSync(dir, 0o600);
		return ok();
	};
	try {
		const out = assertOk(f.run("cleanup"));
		assert.ok(out.includes(`ran: herdr pane close ${r6.id}`), out);
		const left = out.slice(out.indexOf("Resources left:"));
		assert.match(left, new RegExp(`- ${join(dir, "scratch")}: [^\\n]*EACCES`), out);
		assert.ok(!out.includes("current run cleared"), out);
	} finally {
		chmodSync(dir, 0o755);
	}
	assert.ok(existsSync(currentPointer(f)));
});

test("cleanup whose removal fails partway lists the root as partly removed or kept and keeps current", () => {
	const f = finishable();
	const dir = f.runDir();
	const locked = join(dir, "scratch", "5", "locked");
	const stuck = put(join(locked, "file.txt"));
	put(join(dir, "live", "5", "README.md"));
	chmodSync(locked, 0o500);
	try {
		const out = assertOk(f.run("cleanup"));
		assert.ok(existsSync(stuck), out);
		assert.ok(gone(join(dir, "live")), out);
		assert.match(out, new RegExp(`- ${join(dir, "scratch")}: partly removed or kept: [^\\n]*EACCES`));
		assert.ok(!out.includes("current run cleared"), out);
	} finally {
		chmodSync(locked, 0o755);
	}
	assert.ok(existsSync(currentPointer(f)));
});

test("cleanup refuses to remove anything when the run directory is a symlink, and lists why", () => {
	const f = finishable();
	const dir = f.runDir();
	const file = put(join(dir, "scratch", "5", "notes.txt"));
	const real = join(f.dir, "elsewhere");
	renameSync(dir, real);
	symlinkSync(real, dir);
	const out = assertOk(f.run("cleanup"));
	assert.ok(existsSync(join(real, "scratch", "5", "notes.txt")) && existsSync(file), out);
	assert.match(out, /- scratch and live not removed: run directory [^\n]* is not a real directory inside/);
	assert.ok(!out.includes("current run cleared"), out);
});

test("cleanup lists a merged row's remote branch that still exists and a main checkout behind origin, removing neither", () => {
	const f = finishable();
	f.state.exec["git ls-remote origin refs/heads/feat/t5"] = ok(`${HEAD}\trefs/heads/feat/t5\n`);
	f.state.exec["git ls-remote origin refs/heads/main"] = ok(`${MOVED}\trefs/heads/main\n`);
	f.state.exec[`git merge-base --is-ancestor ${MOVED} HEAD`] = { code: 1, stdout: "", stderr: "" };
	const out = assertOk(f.run("cleanup"));
	assert.ok(out.includes("- #5 remote branch feat/t5 still exists on origin"), out);
	assert.ok(out.includes(`- main checkout ${f.repo} is behind origin/main (${MOVED})`), out);
	assert.ok(!f.calls.some((c) => /push|ls-remote origin refs\/heads\/feat\/t6/.test(c)), f.calls.join("\n"));
	assert.match(out.split("\n").at(-1)!, /current run cleared/);
});

test("CONTRACT.md puts all scratch in <scratch>, a placeholder of the table, and lists only paths outside it", () => {
	const contract = readFileSync(join(import.meta.dirname, "../skills/batch-chief/CONTRACT.md"), "utf8");
	assert.match(contract, /\n\| `<scratch>` \| `<run dir>\/scratch\/<n>\/`/);
	assert.match(contract, /all scratch goes in `<scratch>` and stays there/);
	assert.match(contract, /## Scratch paths left\n- <path outside `<scratch>`>, or none/);
});

// ---------------------------------------------------------------------------------------------------------------
// Live checks: declared at preflight, run by the chief from a clone, recorded against the gated SHA.

const LIVE_PASS = ["live", "5", "--result", "pass", "--evidence", "curl showed the new header"];

/** The status lines under row `n`, up to the next row. */
function rowDetails(f: Fixture, n: number | string) {
	const lines = assertOk(f.run("status")).split("\n");
	const at = lines.findIndex((l) => l.startsWith(`#${n} `));
	const end = lines.findIndex((l, i) => i > at && !l.startsWith("  "));
	return lines.slice(at + 1, end);
}

test("preflight --live records each named row's live check, and status and the ledger show it per row", () => {
	const f = fixture();
	assertOk(f.preflight("5,6,release", "--live", "5:before-merge,release:after-merge"));
	assert.equal(f.events()[0].version, 2);
	assert.deepEqual(f.events()[0].live, [
		{ ticket: 5, mode: "before-merge" },
		{ ticket: "release", mode: "after-merge" },
	]);
	assert.ok(rowDetails(f, 5).includes("  live check: before-merge, no result recorded"), rowDetails(f, 5).join("\n"));
	assert.ok(rowDetails(f, "release").includes("  live check: after-merge, no result recorded"));
	assert.ok(!rowDetails(f, 6).some((l) => l.includes("live check")), rowDetails(f, 6).join("\n"));
	const ledger = readLedger(f);
	assert.match(ledger, /\| #5 \| QUEUED \|.*live check: before-merge, no result recorded \|/);
	assert.match(ledger, /\| #6 \| QUEUED \|[^\n]*\| {2}\|\n/);
});

test("preflight --live refuses an unknown row, an unknown mode, a duplicate row and a malformed entry", () => {
	for (const [live, part] of [
		["7:before-merge", "#7, which is not a row"],
		["5:during-merge", "before-merge or after-merge"],
		["5:before-merge,5:after-merge", "names #5 twice"],
		["5", "<n>:<before-merge|after-merge>"],
	]) {
		const f = fixture();
		assertRefused(f.preflight("5,6", "--live", live), "--live", part);
		assert.ok(!existsSync(currentPointer(f)), `a refused preflight --live ${live} created a run`);
	}
});

const DETACH = (path: string, sha: string) => `git -C ${path} checkout --detach ${sha}`;

test("live <n> start clones the main checkout into the run's live/<n>/ and detaches it at the gated SHA", () => {
	const f = fixture();
	gated(f, "--live", "5:before-merge");
	const path = join(f.runDir(), "live", "5");
	f.state.exec[`git clone ${f.repo} ${path}`] = ok();
	f.state.exec[DETACH(path, HEAD)] = ok();
	f.calls.length = 0;
	const out = assertOk(f.run("live", "5", "start"));
	assert.deepEqual(
		f.calls.filter((c) => c.startsWith("git ") && !c.startsWith("git rev-parse --path-format")),
		[`git clone ${f.repo} ${path}`, DETACH(path, HEAD)],
	);
	assert.ok(out.includes(path), out);
	assert.ok(out.includes(`batch.ts live 5 --result <pass|fail> --evidence "<text or path>"`), out);
});

test("live <n> start is refused outside GATED, on a row without a live check, and when a step fails", () => {
	const f = fixture();
	assertOk(f.preflight("5,6", "--live", "5:before-merge"));
	assertOk(f.launch(5));
	assertRefused(f.run("live", "5", "start"), "live start needs a GATED row", "#5 is RUNNING(implement)");
	f.at("10:05");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "DONE", "10:04")));
	assertRefused(f.run("live", "5", "start"), "#5 is REPORTED");
	assert.ok(!f.calls.some((c) => c.startsWith("git clone")), f.calls.join("\n"));
	const plain = fixture();
	gated(plain);
	assertRefused(plain.run("live", "5", "start"), "#5 has no live check", "preflight --live");
	const failing = fixture();
	gated(failing, "--live", "5:before-merge");
	const path = join(failing.runDir(), "live", "5");
	failing.state.exec[`git clone ${failing.repo} ${path}`] = { code: 128, stdout: "", stderr: "fatal: no space" };
	assertRefused(failing.run("live", "5", "start"), "git clone", "fatal: no space");
	assert.ok(!failing.calls.some((c) => c.includes("--detach")));
});

test("live <n> start on an existing clone fetches and detaches it at the gated SHA, deleting nothing; a dirty one is refused", () => {
	const f = fixture();
	gated(f, "--live", "5:before-merge");
	const path = join(f.runDir(), "live", "5");
	const file = put(join(path, "result.log"), "earlier run");
	f.state.exec[`git -C ${path} status --porcelain`] = ok();
	f.state.exec[`git -C ${path} fetch origin`] = ok();
	f.state.exec[DETACH(path, HEAD)] = ok();
	f.calls.length = 0;
	const out = assertOk(f.run("live", "5", "start"));
	assert.deepEqual(
		f.calls.filter((c) => c.startsWith(`git -C ${path}`) || c.startsWith("git clone")),
		[`git -C ${path} status --porcelain`, `git -C ${path} fetch origin`, DETACH(path, HEAD)],
	);
	assert.ok(out.includes(`reused the clone at ${path}`), out);
	assert.equal(readFileSync(file, "utf8"), "earlier run");
	f.state.exec[`git -C ${path} status --porcelain`] = ok(" M src/a.ts\n");
	f.calls.length = 0;
	assertRefused(f.run("live", "5", "start"), `${path} exists and is not clean`, "M src/a.ts");
	assert.ok(!f.calls.some((c) => c.includes("--detach")), f.calls.join("\n"));
});

test("live <n> --result records pass or fail against the gated SHA and is refused where it does not apply", () => {
	const f = fixture();
	gated(f, "--live", "5:before-merge");
	assertRefused(f.run("live", "5", "--result", "maybe", "--evidence", "x"), "--result must be pass or fail");
	assertRefused(f.run("live", "5", "--result", "pass"), "--evidence is required");
	assertRefused(f.run("event", "5", "live-result"), "not recorded through event", "live command");
	assertOk(f.run(...LIVE_PASS));
	const last = f.events().at(-1);
	assert.deepEqual([last.type, last.sha, last.result, last.evidence], ["live-result", HEAD, "pass", LIVE_PASS[5]]);
	assert.ok(rowDetails(f, 5).includes(`  live check: before-merge, pass at ${HEAD}: ${LIVE_PASS[5]}`));
	assertRefused(f.run("live", "6", "--result", "pass", "--evidence", "x"), "#6 has no live check");
	const queued = fixture();
	assertOk(queued.preflight("5,6", "--live", "5:before-merge"));
	assertRefused(queued.run(...LIVE_PASS), "#5 is QUEUED");
});

test("merge refuses a before-merge row without a recorded pass at the SHA it merges, naming the command", () => {
	const f = fixture();
	approvedGated(f, "--live", "5:before-merge");
	f.state.exec[MERGE_CALL] = () => {
		f.state.prs["feat/t5"] = goodPr({ state: "MERGED", mergeCommit: { oid: MOVED } });
		return ok();
	};
	assertRefused(
		f.run("merge", "5"),
		`#5 has a before-merge live check and no recorded pass at ${HEAD}`,
		`batch.ts live 5 --result pass --evidence "<text or path>"`,
	);
	assertOk(f.run("live", "5", "--result", "fail", "--evidence", "still 500"));
	assertRefused(f.run("merge", "5"), "no recorded pass", "the last result at it is fail");
	assert.deepEqual(mergeCalls(f), []);
	assertOk(f.run(...LIVE_PASS));
	assertOk(f.run("merge", "5"));
	assert.deepEqual(mergeCalls(f), [MERGE_CALL]);
});

test("a head move makes a live pass stale: after a re-gate at the new SHA merge refuses until a pass is recorded for it", () => {
	const f = fixture();
	approvedGated(f, "--live", "5:before-merge");
	assertOk(f.run(...LIVE_PASS));
	f.state.prs["feat/t5"] = goodPr({ headRefOid: MOVED });
	assert.match(rowLine(f, 5), /^#5 REPORTED/);
	assert.ok(rowDetails(f, 5).includes("  live check: before-merge, no result recorded"));
	f.append({ at: "2026-11-11T10:07:00.000Z", type: "gate", ticket: 5, sha: MOVED, judged: "re-read" });
	const moved = `gh pr merge 12 --squash --match-head-commit ${MOVED}`;
	f.state.exec[moved] = () => {
		f.state.prs["feat/t5"] = goodPr({ headRefOid: MOVED, state: "MERGED", mergeCommit: { oid: SHA } });
		return ok();
	};
	assertRefused(f.run("merge", "5"), `no recorded pass at ${MOVED}`);
	assert.deepEqual(mergeCalls(f), []);
	assertOk(f.run(...LIVE_PASS));
	assert.equal(f.events().at(-1).sha, MOVED);
	assertOk(f.run("merge", "5"));
	assert.deepEqual(mergeCalls(f), [moved]);
});

test("an after-merge row merges, then status lists its live check as owed until a result is recorded at the merged head", () => {
	const f = fixture();
	approvedGated(f, "--live", "5:after-merge");
	f.state.exec[MERGE_CALL] = () => {
		f.state.prs["feat/t5"] = goodPr({ state: "MERGED", mergeCommit: { oid: MOVED } });
		return ok();
	};
	assertOk(f.run("merge", "5"));
	const owed = `  live check: after-merge, OWED: run it, then batch.ts live 5 --result <pass|fail> --evidence "<text or path>"`;
	assert.ok(rowDetails(f, 5).includes(owed), rowDetails(f, 5).join("\n"));
	assert.match(readLedger(f), /\| #5 \| MERGED \|.*after-merge, OWED/);
	assertRefused(f.run("live", "5", "start"), "live start needs a GATED row", "#5 is MERGED");
	assertOk(f.run(...LIVE_PASS));
	assert.equal(f.events().at(-1).sha, HEAD);
	assert.ok(rowDetails(f, 5).includes(`  live check: after-merge, pass at ${HEAD}: ${LIVE_PASS[5]}`));
	assert.ok(!assertOk(f.run("status")).includes("OWED"));
});

test("cleanup lists an owed live check under Resources left, keeps live/ and the run, and a recorded result clears it", () => {
	const f = finishable("--live", "5:after-merge");
	const clone = put(join(f.runDir(), "live", "5", "README.md"));
	const scratch = put(join(f.runDir(), "scratch", "5", "notes.txt"));
	const out = assertOk(f.run("cleanup"));
	assert.ok(
		out.includes(
			`- #5 live check (after-merge) owed: run it, then batch.ts live 5 --result <pass|fail> --evidence "<text or path>"`,
		),
		out,
	);
	assert.ok(out.includes(`kept: ${join(f.runDir(), "live")}: a live check is owed`), out);
	assert.ok(existsSync(clone) && !existsSync(scratch), out);
	assert.ok(existsSync(currentPointer(f)), `current removed while a live check is owed:\n${out}`);
	assertOk(f.run("live", "5", "--result", "fail", "--evidence", "header missing in production"));
	const again = assertOk(f.run("cleanup"));
	assert.ok(!again.includes("owed"), again);
	assert.ok(!existsSync(clone), again);
	assert.match(again.split("\n").at(-1)!, /current run cleared/);
});

test("preflight writes version 2, reads a finished version-1 run, and refuses a run that still owes a live check", () => {
	const f = fixture();
	assertOk(f.preflight());
	const old = f.runDir();
	otherVersion(f, 1, [
		{ at: "2026-11-11T10:01:00.000Z", type: "drop", ticket: 5, user: "no" },
		{ at: "2026-11-11T10:01:00.000Z", type: "drop", ticket: 6, user: "no" },
	]);
	assert.match(rowLine(f, 5), /^#5 DROPPED/);
	f.at("11:00");
	assertOk(f.preflight());
	assert.notEqual(f.runDir(), old);
	assert.equal(f.events()[0].version, 2);
	const owing = finishable("--live", "5:after-merge");
	owing.state.exec["git rev-parse --verify --quiet refs/heads/feat/t6"] = { code: 1, stdout: "", stderr: "" };
	owing.at("11:00");
	assertRefused(owing.preflight(), "still owes a live check: #5", "batch.ts live 5 --result");
});
